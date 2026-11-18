// Accounts, sessions, secrets and the audit log: the building blocks the dashboard's
// security rests on, tested against published vectors and tampering.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, verifyAudit } from "../../src/server/audit.ts";
import { Auth, passwordProblem } from "../../src/server/auth.ts";
import {
  base32Decode,
  base32Encode,
  decrypt,
  encrypt,
  hashPassword,
  hotp,
  newRecoveryCodes,
  verifyPassword,
  verifyTotp,
} from "../../src/server/crypto.ts";
import { openDb } from "../../src/server/db.ts";
import { BUILTIN_ROLES, canGrant } from "../../src/server/rbac.ts";

describe("crypto", () => {
  it("matches the RFC 6238 TOTP test vectors (SHA-1, 8 digits)", () => {
    const key = Buffer.from("12345678901234567890");
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(key, Math.floor(1234567890 / 30), 8)).toBe("89005924");
    expect(hotp(key, Math.floor(2000000000 / 30), 8)).toBe("69279037");
  });

  it("accepts a TOTP code once, within one step of drift", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    const t = 1_700_000_000_000;
    const code = hotp(base32Decode(secret), Math.floor(t / 30_000));
    const step = verifyTotp(secret, code, t);
    expect(step).toBe(Math.floor(t / 30_000));
    expect(verifyTotp(secret, code, t + 30_000)).toBe(step); // one step late is fine
    expect(verifyTotp(secret, code, t, step ?? 0)).toBeNull(); // replay refused
    expect(verifyTotp(secret, code, t + 120_000)).toBeNull(); // too old
    expect(verifyTotp(secret, "12345", t)).toBeNull();
  });

  it("encrypts secrets so that tampering or a different record is detected", () => {
    const key = Buffer.alloc(32, 7);
    const box = encrypt(key, "sk-ant-secret", "secret:org_1:ANTHROPIC_API_KEY");
    expect(box).not.toContain("sk-ant");
    expect(decrypt(key, box, "secret:org_1:ANTHROPIC_API_KEY")).toBe("sk-ant-secret");
    expect(() => decrypt(key, box, "secret:org_2:ANTHROPIC_API_KEY")).toThrow();
    const parts = box.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(key, parts.join("."), "secret:org_1:ANTHROPIC_API_KEY")).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 8), box, "secret:org_1:ANTHROPIC_API_KEY")).toThrow();
  });

  it("hashes passwords with scrypt and a per-password salt", async () => {
    const a = await hashPassword("Tidal-Lantern-Quartz-42");
    const b = await hashPassword("Tidal-Lantern-Quartz-42");
    expect(a).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("Tidal-Lantern-Quartz-42", a)).toBe(true);
    expect(await verifyPassword("tidal-lantern-quartz-42", a)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(new Set(newRecoveryCodes()).size).toBe(10);
  });

  it("applies a NIST 800-63B password policy", () => {
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("password1234")).toMatch(/breached/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/repeat/i);
    expect(passwordProblem("abcdefghijklmn")).toMatch(/sequence/i);
    expect(passwordProblem("dana-reyes-2026!", ["Dana Reyes", "dana-reyes"])).toMatch(/name/);
    expect(passwordProblem("Tidal-Lantern-Quartz-42")).toBeNull();
    expect(passwordProblem("x".repeat(129))).toMatch(/128/);
  });
});

describe("roles", () => {
  it("never lets a role hand out permissions it does not hold", () => {
    const admin = BUILTIN_ROLES.find((r) => r.key === "admin")?.permissions ?? [];
    const owner = BUILTIN_ROLES.find((r) => r.key === "owner")?.permissions ?? [];
    expect(admin).not.toContain("org.manage");
    expect(canGrant(admin, ["runs.view", "members.manage"])).toBe(true);
    expect(canGrant(admin, owner)).toBe(false);
  });
});

describe("audit log", () => {
  it("detects an edited or deleted row", async () => {
    const db = openDb(await mkdtemp(join(tmpdir(), "bs-audit-")));
    for (const action of ["auth.login", "run.started", "run.applied"])
      audit(db, {
        orgId: "org_1",
        actorId: "usr_1",
        actor: "dana@acme.dev",
        action,
        ip: "127.0.0.1",
      });
    expect(verifyAudit(db)).toEqual({ ok: true, rows: 3, brokenAt: null });
    db.prepare("UPDATE audit SET action = 'run.deleted' WHERE seq = 2").run();
    expect(verifyAudit(db)).toMatchObject({ ok: false, brokenAt: 2 });
    db.prepare("UPDATE audit SET action = 'run.started' WHERE seq = 2").run();
    db.prepare("DELETE FROM audit WHERE seq = 2").run();
    expect(verifyAudit(db)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});

describe("sessions", () => {
  it("expire after inactivity and at the absolute limit", async () => {
    const db = openDb(await mkdtemp(join(tmpdir(), "bs-sess-")));
    const auth = new Auth(db, { idleMinutes: 30, absoluteHours: 12 });
    const user = await auth.setupOwner({
      token: auth.issueSetupToken(),
      orgName: "Acme",
      name: "Dana Reyes",
      email: "dana@acme.dev",
      password: "Tidal-Lantern-Quartz-42",
      ip: "127.0.0.1",
    });
    const a = auth.createSession(user, "127.0.0.1", "test");
    expect(auth.principal(a.token)?.permissions).toContain("org.manage");
    db.prepare("UPDATE sessions SET last_seen_at = ?").run(
      new Date(Date.now() - 31 * 60_000).toISOString(),
    );
    expect(auth.principal(a.token)).toBeNull();
    const b = auth.createSession(user, "127.0.0.1", "test");
    db.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect(auth.principal(b.token)).toBeNull();
    expect(auth.principal("not-a-token")).toBeNull();
    // a deactivated user loses access at once
    const c = auth.createSession(user, "127.0.0.1", "test");
    db.prepare("UPDATE users SET status = 'disabled'").run();
    expect(auth.principal(c.token)).toBeNull();
  });
});
