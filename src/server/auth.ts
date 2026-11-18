// Accounts and sessions: first-run owner setup guarded by a one-time token, password login
// with lockout, and server-side sessions with idle and absolute timeouts and a CSRF token.
// Follows NIST SP 800-63B (passwords 12–128, breached-list check, no forced rotation) and
// OWASP ASVS V2/V3.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.ts";
import {
  decrypt,
  encrypt,
  hashPassword,
  newId,
  newRecoveryCodes,
  newToken,
  newTotpSecret,
  otpauthUrl,
  safeEqual,
  sha256,
  verifyPassword,
  verifyTotp,
} from "./crypto.ts";
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
  /** Organisation policy requires MFA and this user has not enrolled yet. */
  mustEnrollMfa: boolean;
  /** Set when the request authenticated with a personal API token instead of a session. */
  apiToken?: string;
}

export interface OrgSettings {
  mfa: "off" | "admins" | "all";
  idleMinutes: number;
  absoluteHours: number;
}
export const DEFAULT_SETTINGS: OrgSettings = { mfa: "admins", idleMinutes: 30, absoluteHours: 12 };
/** Permissions that make someone an administrator for the "admins must use MFA" policy. */
const ADMIN_PERMS = [
  "members.manage",
  "roles.manage",
  "access.manage",
  "security.manage",
  "integrations.manage",
  "org.manage",
];
/** What a personal API token may do: reading and automation, never account or access changes. */
export const TOKEN_SCOPES = [
  "runs.view",
  "runs.start",
  "runs.delete",
  "workspaces.view",
  "members.view",
  "audit.view",
];
/** Re-authentication stays fresh this long for sensitive actions. */
export const STEP_UP_MS = 10 * 60_000;

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
    private key: Buffer = Buffer.alloc(32),
  ) {}

  settings(orgId: string): OrgSettings {
    const row = this.db.prepare("SELECT settings FROM orgs WHERE id = ?").get(orgId) as
      | { settings: string }
      | undefined;
    const raw = row ? (JSON.parse(row.settings) as Partial<OrgSettings>) : {};
    return {
      ...DEFAULT_SETTINGS,
      idleMinutes: this.policy.idleMinutes,
      absoluteHours: this.policy.absoluteHours,
      ...raw,
    };
  }

  saveSettings(orgId: string, next: Partial<OrgSettings>) {
    const cur = this.settings(orgId);
    const merged: OrgSettings = {
      mfa: next.mfa && ["off", "admins", "all"].includes(next.mfa) ? next.mfa : cur.mfa,
      idleMinutes: Math.min(
        480,
        Math.max(5, Math.round(Number(next.idleMinutes ?? cur.idleMinutes))),
      ),
      absoluteHours: Math.min(
        72,
        Math.max(1, Math.round(Number(next.absoluteHours ?? cur.absoluteHours))),
      ),
    };
    this.db.prepare("UPDATE orgs SET settings = ? WHERE id = ?").run(JSON.stringify(merged), orgId);
    return merged;
  }

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
    const expires = new Date(
      Date.now() + this.settings(user.org_id).absoluteHours * 3600_000,
    ).toISOString();
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

  /**
   * Resolve a session token; enforces idle and absolute expiry from the organisation's policy.
   * Sessions waiting for their MFA code resolve only when `pending` is allowed.
   */
  principal(token: string | undefined, pending = false): Principal | null {
    if (!token || token.length > 100) return null;
    const s = this.db
      .prepare("SELECT * FROM sessions WHERE id_hash = ?")
      .get(sha256(token)) as unknown as Session | undefined;
    if (!s) return null;
    const t = Date.now();
    const pol = this.settings(s.org_id);
    const idle = s.mfa_pending ? 5 : pol.idleMinutes;
    if (
      Date.parse(s.expires_at) < t ||
      t - Date.parse(s.created_at) > pol.absoluteHours * 3600_000 ||
      t - Date.parse(s.last_seen_at) > idle * 60_000
    ) {
      this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(s.id_hash);
      return null;
    }
    if (s.mfa_pending && !pending) return null;
    const u = this.db.prepare("SELECT * FROM users WHERE id = ?").get(s.user_id) as unknown as
      | User
      | undefined;
    if (!u || u.status !== "active") return null;
    if (t - Date.parse(s.last_seen_at) > 60_000)
      this.db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?")
        .run(now(), s.id_hash);
    return this.build(s, u);
  }

  private build(s: Session, u: User): Principal {
    const role = this.db
      .prepare("SELECT id, name, permissions FROM roles WHERE id = ?")
      .get(u.role_id) as { id: string; name: string; permissions: string };
    const permissions = JSON.parse(role.permissions) as string[];
    const pol = this.settings(u.org_id);
    const needs =
      pol.mfa === "all" ||
      (pol.mfa === "admins" && permissions.some((p) => ADMIN_PERMS.includes(p)));
    const {
      password_hash: _p,
      mfa_secret: _m,
      recovery: _r,
      ...user
    } = u as User & { mfa_secret?: string; recovery?: string };
    return {
      session: s,
      user,
      role: { id: role.id, name: role.name },
      permissions,
      mustEnrollMfa: needs && !u.mfa_enabled,
    };
  }

  /** True when the session re-authenticated recently enough for a sensitive action. */
  fresh(p: Principal): boolean {
    return !p.apiToken && Date.now() - Date.parse(p.session.auth_at) < STEP_UP_MS;
  }

  // ── MFA ──

  private mfaRow(userId: string) {
    return this.db
      .prepare(
        "SELECT id, org_id, email, mfa_secret, mfa_enabled, mfa_last_step, recovery FROM users WHERE id = ?",
      )
      .get(userId) as
      | {
          id: string;
          org_id: string;
          email: string;
          mfa_secret: string | null;
          mfa_enabled: number;
          mfa_last_step: number;
          recovery: string;
        }
      | undefined;
  }

  /** Check a TOTP code (or a recovery code, used once) for a user. */
  checkSecondFactor(userId: string, code: string): "totp" | "recovery" | null {
    const r = this.mfaRow(userId);
    if (!r?.mfa_enabled || !r.mfa_secret) return null;
    const clean = code.trim().toLowerCase();
    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(
        decrypt(this.key, r.mfa_secret, `mfa:${r.id}`),
        clean,
        Date.now(),
        r.mfa_last_step,
      );
      if (step === null) return null;
      this.db.prepare("UPDATE users SET mfa_last_step = ? WHERE id = ?").run(step, r.id);
      return "totp";
    }
    const hashes = JSON.parse(r.recovery) as string[];
    const h = sha256(clean.replace(/[\s-]/g, ""));
    const i = hashes.findIndex((x) => safeEqual(x, h));
    if (i < 0) return null;
    hashes.splice(i, 1);
    this.db.prepare("UPDATE users SET recovery = ? WHERE id = ?").run(JSON.stringify(hashes), r.id);
    return "recovery";
  }

  /** Start enrolment: a new secret, stored encrypted but not active until confirmed. */
  startMfa(userId: string, email: string, issuer: string) {
    const secret = newTotpSecret();
    this.db
      .prepare("UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ? AND mfa_enabled = 0")
      .run(encrypt(this.key, secret, `mfa:${userId}`), userId);
    return { secret, url: otpauthUrl(secret, email, issuer) };
  }

  /** Confirm enrolment with a first code; returns ten one-time recovery codes. */
  confirmMfa(userId: string, code: string): string[] | null {
    const r = this.mfaRow(userId);
    if (!r?.mfa_secret || r.mfa_enabled) return null;
    const step = verifyTotp(decrypt(this.key, r.mfa_secret, `mfa:${r.id}`), code.trim());
    if (step === null) return null;
    const codes = newRecoveryCodes();
    this.db
      .prepare("UPDATE users SET mfa_enabled = 1, mfa_last_step = ?, recovery = ? WHERE id = ?")
      .run(step, JSON.stringify(codes.map(recoveryHash)), r.id);
    return codes;
  }

  newRecoveryCodes(userId: string): string[] {
    const codes = newRecoveryCodes();
    this.db
      .prepare("UPDATE users SET recovery = ? WHERE id = ?")
      .run(JSON.stringify(codes.map(recoveryHash)), userId);
    return codes;
  }

  disableMfa(userId: string) {
    this.db
      .prepare(
        "UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, recovery = '[]', mfa_last_step = -1 WHERE id = ?",
      )
      .run(userId);
  }

  remainingRecoveryCodes(userId: string): number {
    return (JSON.parse(this.mfaRow(userId)?.recovery ?? "[]") as string[]).length;
  }

  /** After the second factor: rotate the session token and mark it fully signed in. */
  completeMfa(token: string, p: Principal, ip: string, userAgent: string) {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
    return this.createSession(this.user(p.user.id) as User, ip, userAgent, false);
  }

  markFresh(p: Principal) {
    this.db
      .prepare("UPDATE sessions SET auth_at = ? WHERE id_hash = ?")
      .run(now(), p.session.id_hash);
  }

  // ── password and sessions ──

  async changePassword(p: Principal, current: string, next: string, ip: string) {
    const u = this.user(p.user.id) as User;
    if (!(await verifyPassword(current, u.password_hash)))
      throw new AuthError(400, "Your current password is not correct.");
    const org = this.org(u.org_id);
    const problem = passwordProblem(next, [u.name, u.email.split("@")[0] ?? "", org?.name ?? ""]);
    if (problem) throw new AuthError(400, problem);
    if (await verifyPassword(next, u.password_hash))
      throw new AuthError(400, "Choose a password you have not used here before.");
    this.db
      .prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?")
      .run(await hashPassword(next), now(), u.id);
    // Every other session ends: a changed password must lock out whoever had the old one.
    this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?")
      .run(u.id, p.session.id_hash);
    audit(this.db, {
      orgId: u.org_id,
      actorId: u.id,
      actor: u.email,
      action: "auth.password_changed",
      ip,
    });
  }

  sessions(userId: string, currentHash: string) {
    return (
      this.db
        .prepare(
          "SELECT id_hash, created_at, last_seen_at, ip, user_agent, mfa_pending FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
        )
        .all(userId) as unknown as (Session & { ip: string; user_agent: string })[]
    )
      .filter((s) => !s.mfa_pending)
      .map((s) => ({
        id: s.id_hash.slice(0, 16),
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        ip: s.ip,
        user_agent: s.user_agent,
        current: s.id_hash === currentHash,
      }));
  }

  revokeSession(userId: string, handle: string): boolean {
    if (!/^[a-f0-9]{16}$/.test(handle)) return false;
    return (
      Number(
        this.db
          .prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?")
          .run(userId, handle).changes,
      ) > 0
    );
  }

  revokeOtherSessions(userId: string, keepHash: string) {
    return Number(
      this.db
        .prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?")
        .run(userId, keepHash).changes,
    );
  }

  // ── personal API tokens ──

  createApiToken(p: Principal, name: string, days: number, scopes: string[]) {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new AuthError(400, "Give the token a name.");
    const allowed = scopes.filter((s) => p.permissions.includes(s) && TOKEN_SCOPES.includes(s));
    if (!allowed.length || allowed.length !== scopes.length)
      throw new AuthError(400, "Pick permissions your role has and tokens can use.");
    const d = [7, 30, 90, 365].includes(days) ? days : 30;
    const raw = `bs_pat_${newToken(24)}`;
    const id = newId("tok");
    this.db
      .prepare(
        "INSERT INTO api_tokens (id, org_id, user_id, name, hash, prefix, scopes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        p.user.org_id,
        p.user.id,
        clean,
        sha256(raw),
        raw.slice(0, 12),
        JSON.stringify(allowed),
        now(),
        new Date(Date.now() + d * 86_400_000).toISOString(),
      );
    return { id, token: raw };
  }

  apiTokens(userId: string) {
    return this.db
      .prepare(
        "SELECT id, name, prefix, scopes, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(userId) as unknown as {
      id: string;
      name: string;
      prefix: string;
      scopes: string;
      created_at: string;
      expires_at: string;
      last_used_at: string | null;
    }[];
  }

  revokeApiToken(userId: string, id: string): boolean {
    return (
      Number(
        this.db.prepare("DELETE FROM api_tokens WHERE user_id = ? AND id = ?").run(userId, id)
          .changes,
      ) > 0
    );
  }

  /** Resolve `Authorization: Bearer bs_pat_…`: the user's role, narrowed to the token's scopes. */
  principalFromToken(raw: string): Principal | null {
    if (!/^bs_pat_[\w-]{20,60}$/.test(raw)) return null;
    const t = this.db.prepare("SELECT * FROM api_tokens WHERE hash = ?").get(sha256(raw)) as
      | {
          id: string;
          user_id: string;
          scopes: string;
          expires_at: string;
          last_used_at: string | null;
        }
      | undefined;
    if (!t || Date.parse(t.expires_at) < Date.now()) return null;
    const u = this.user(t.user_id);
    if (!u || u.status !== "active") return null;
    const fake: Session = {
      id_hash: `token:${t.id}`,
      user_id: u.id,
      org_id: u.org_id,
      csrf: "",
      created_at: now(),
      last_seen_at: now(),
      expires_at: t.expires_at,
      auth_at: "1970-01-01T00:00:00.000Z",
      mfa_pending: 0,
    };
    const p = this.build(fake, u);
    const scopes = JSON.parse(t.scopes) as string[];
    p.permissions = p.permissions.filter((x) => scopes.includes(x));
    p.apiToken = t.id;
    p.mustEnrollMfa = false;
    if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > 60_000)
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), t.id);
    return p;
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

/** Recovery codes are compared without their dashes or spaces, so either form works. */
const recoveryHash = (code: string) => sha256(code.toLowerCase().replace(/[\s-]/g, ""));

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
