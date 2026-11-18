// Accounts and sessions: first-run owner setup guarded by a one-time token, password login
// with lockout, and server-side sessions with idle and absolute timeouts and a CSRF token.
// Follows NIST SP 800-63B (passwords 12–128, breached-list check, no forced rotation) and
// OWASP ASVS V2/V3.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.ts";
import { hashPassword, newId, newToken, safeEqual, sha256, verifyPassword } from "./crypto.ts";
import { type Db, now, tx } from "./db.ts";
import { BUILTIN_ROLES } from "./rbac.ts";

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}
export const DEFAULT_POLICY: SessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

export interface User {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role_id: string;
  status: string;
  mfa_enabled: number;
  password_hash: string | null;
  failed_logins: number;
  locked_until: string | null;
}
export interface Session {
  id_hash: string;
  user_id: string;
  org_id: string;
  csrf: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  auth_at: string;
  mfa_pending: number;
}
export interface Principal {
  session: Session;
  user: Omit<User, "password_hash">;
  role: { id: string; name: string };
  permissions: string[];
}

// ── password policy ──

let COMMON: Set<string> | null = null;
function common(): Set<string> {
  if (!COMMON) {
    // UK NCSC top-100k list via SecLists (MIT), filtered to 12+ characters.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "data", "common-passwords.txt"),
      join(here, "..", "src", "server", "data", "common-passwords.txt"),
      join(here, "..", "..", "src", "server", "data", "common-passwords.txt"),
    ];
    let text = "";
    for (const c of candidates) {
      try {
        text = readFileSync(c, "utf8");
        break;
      } catch {}
    }
    COMMON = new Set(text.split("\n").filter(Boolean));
  }
  return COMMON;
}

/** Returns a reason the password is not acceptable, or null. */
export function passwordProblem(pw: string, context: string[] = []): string | null {
  const len = [...pw].length;
  if (len < 12) return "Use at least 12 characters.";
  if (len > 128) return "Use at most 128 characters.";
  const lower = pw.toLowerCase();
  if (common().has(lower)) return "This password appears in lists of breached passwords.";
  if (/^(.)\1+$/.test(pw)) return "Avoid repeating one character.";
  if (
    "abcdefghijklmnopqrstuvwxyz0123456789".includes(lower) ||
    "0123456789876543210".includes(lower)
  )
    return "Avoid sequences like abcdef or 123456.";
  for (const c of context.map((x) => x.toLowerCase().trim()).filter((x) => x.length >= 4))
    if (lower.includes(c)) return "Avoid using your name, email or the organisation name.";
  return null;
}

// ── the store ──

export class Auth {
  private setupHash: string | null = null;
  private setupExpires = 0;
  /** Per-IP attempts on authentication endpoints (sliding 10-minute window). */
  private attempts = new Map<string, number[]>();

  constructor(
    private db: Db,
    private policy: SessionPolicy = DEFAULT_POLICY,
  ) {}

  needsSetup(): boolean {
    return !this.db.prepare("SELECT 1 FROM users LIMIT 1").get();
  }

  /** A one-time token, valid for one hour, that lets its holder create the owner account. */
  issueSetupToken(): string {
    const t = newToken();
    this.setupHash = sha256(t);
    this.setupExpires = Date.now() + 60 * 60 * 1000;
    return t;
  }

  checkSetupToken(t: string): boolean {
    return (
      !!this.setupHash && Date.now() < this.setupExpires && safeEqual(sha256(t), this.setupHash)
    );
  }

  /** True when this IP has made too many authentication attempts recently. */
  rateLimited(ip: string, max = 20): boolean {
    const t = Date.now();
    const list = (this.attempts.get(ip) ?? []).filter((x) => t - x < 10 * 60 * 1000);
    list.push(t);
    this.attempts.set(ip, list);
    if (this.attempts.size > 10_000) this.attempts.clear();
    return list.length > max;
  }

  async setupOwner(input: {
    token: string;
    orgName: string;
    name: string;
    email: string;
    password: string;
    ip: string;
  }) {
    if (!this.needsSetup()) throw new AuthError(409, "This server is already set up.");
    if (!this.checkSetupToken(input.token))
      throw new AuthError(
        403,
        "The setup link is invalid or has expired. Restart the server for a new one.",
      );
    const orgName = input.orgName.trim();
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (!orgName || orgName.length > 80)
      throw new AuthError(400, "Enter an organisation name (up to 80 characters).");
    if (!name || name.length > 80)
      throw new AuthError(400, "Enter your name (up to 80 characters).");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new AuthError(400, "Enter a valid email address.");
    const problem = passwordProblem(input.password, [name, email.split("@")[0] ?? "", orgName]);
    if (problem) throw new AuthError(400, problem);
    const hash = await hashPassword(input.password);
    const orgId = newId("org");
    const userId = newId("usr");
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO orgs (id, name, created_at) VALUES (?,?,?)")
        .run(orgId, orgName, now());
      let ownerRole = "";
      for (const r of BUILTIN_ROLES) {
        const id = `${orgId}:${r.key}`;
        if (r.key === "owner") ownerRole = id;
        this.db
          .prepare(
            "INSERT INTO roles (id, org_id, name, description, permissions, builtin) VALUES (?,?,?,?,?,1)",
          )
          .run(id, orgId, r.name, r.description, JSON.stringify(r.permissions));
      }
      this.db
        .prepare(
          "INSERT INTO users (id, org_id, email, name, password_hash, role_id, created_at, password_changed_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(userId, orgId, email, name, hash, ownerRole, now(), now());
    });
    this.setupHash = null;
    audit(this.db, {
      orgId,
      actorId: userId,
      actor: email,
      action: "org.created",
      target: orgName,
      ip: input.ip,
    });
    return this.user(userId) as User;
  }

  user(id: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as
      | User
      | undefined;
  }

  /** Password login. Same error for an unknown email and a wrong password. */
  async login(emailRaw: string, password: string, ip: string): Promise<User> {
    const email = emailRaw.trim().toLowerCase();
    const user = this.db
      .prepare("SELECT * FROM users WHERE email = ? AND status = 'active'")
      .get(email) as unknown as User | undefined;
    const fail = new AuthError(401, "That email and password do not match.");
    if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
      await verifyPassword(password, null); // same timing as a real check
      audit(this.db, {
        orgId: user.org_id,
        actorId: user.id,
        actor: user.email,
        action: "auth.login_locked",
        ip,
      });
      throw new AuthError(429, "Too many attempts. Try again in a few minutes.");
    }
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok) {
      if (user) {
        const n = user.failed_logins + 1;
        // Five free attempts, then 1, 2, 4 … minutes, capped at an hour.
        const lock =
          n >= 5 ? new Date(Date.now() + Math.min(60, 2 ** (n - 5)) * 60_000).toISOString() : null;
        this.db
          .prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
          .run(n, lock, user.id);
        audit(this.db, {
          orgId: user.org_id,
          actorId: user.id,
          actor: user.email,
          action: "auth.login_failed",
          ip,
          detail: { attempt: n },
        });
      } else {
        audit(this.db, {
          orgId: null,
          actorId: null,
          actor: email.slice(0, 254),
          action: "auth.login_failed",
          ip,
          detail: { unknown: true },
        });
      }
      throw fail;
    }
    this.db
      .prepare(
        "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
      )
      .run(now(), user.id);
    return user;
  }

  /** A new session (rotated on every sign-in). Returns the raw token for the cookie. */
  createSession(user: User, ip: string, userAgent: string, mfaPending = false) {
    const token = newToken();
    const csrf = newToken();
    const t = now();
    const expires = new Date(Date.now() + this.policy.absoluteHours * 3600_000).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id_hash, user_id, org_id, csrf, created_at, last_seen_at, expires_at, auth_at, mfa_pending, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        sha256(token),
        user.id,
        user.org_id,
        csrf,
        t,
        t,
        expires,
        t,
        mfaPending ? 1 : 0,
        ip,
        userAgent.slice(0, 300),
      );
    if (!mfaPending)
      audit(this.db, {
        orgId: user.org_id,
        actorId: user.id,
        actor: user.email,
        action: "auth.login",
        ip,
      });
    return { token, csrf };
  }

  /** Resolve a session token; enforces idle and absolute expiry. */
  principal(token: string | undefined): Principal | null {
    if (!token || token.length > 100) return null;
    const s = this.db
      .prepare("SELECT * FROM sessions WHERE id_hash = ?")
      .get(sha256(token)) as unknown as Session | undefined;
    if (!s) return null;
    const t = Date.now();
    if (
      Date.parse(s.expires_at) < t ||
      t - Date.parse(s.last_seen_at) > this.policy.idleMinutes * 60_000
    ) {
      this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(s.id_hash);
      return null;
    }
    const u = this.db.prepare("SELECT * FROM users WHERE id = ?").get(s.user_id) as unknown as
      | User
      | undefined;
    if (!u || u.status !== "active") return null;
    if (t - Date.parse(s.last_seen_at) > 60_000)
      this.db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?")
        .run(now(), s.id_hash);
    const role = this.db
      .prepare("SELECT id, name, permissions FROM roles WHERE id = ?")
      .get(u.role_id) as { id: string; name: string; permissions: string };
    const { password_hash: _p, ...user } = u;
    return {
      session: s,
      user,
      role: { id: role.id, name: role.name },
      permissions: JSON.parse(role.permissions) as string[],
    };
  }

  endSession(token: string, p: Principal | null, ip: string) {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
    if (p)
      audit(this.db, {
        orgId: p.user.org_id,
        actorId: p.user.id,
        actor: p.user.email,
        action: "auth.logout",
        ip,
      });
  }

  org(id: string) {
    return this.db.prepare("SELECT id, name, created_at FROM orgs WHERE id = ?").get(id) as
      | { id: string; name: string; created_at: string }
      | undefined;
  }
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── cookies ──

export const cookieName = (secure: boolean) => (secure ? "__Host-bs_session" : "bs_session");

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const clearCookie = (secure: boolean) =>
  `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
