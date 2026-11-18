// People, roles, repositories (workspaces) and who may do what in each. Every change checks
// the actor's own permissions (nobody grants what they do not hold, nobody edits their own
// role, the last Owner stays) and is written to the audit log.
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { audit } from "./audit.ts";
import { AuthError, type Principal } from "./auth.ts";
import { newId, newToken, sha256 } from "./crypto.ts";
import { type Db, now, tx } from "./db.ts";
import { canGrant, isPermission } from "./rbac.ts";

/** Permissions that apply inside a repository; the rest are organisation-wide. */
export const WS_PERMS = ["runs.view", "runs.start", "runs.apply", "runs.delete", "workspaces.view"];
/** Holders of this see and act on every repository, whatever its grants. */
const ALL_REPOS = "access.manage";

export interface Workspace {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  kind: "local" | "github";
  path: string;
  runs_dir: string;
  repo: string | null;
  visibility: "org" | "restricted";
  created_at: string;
}
export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  builtin: boolean;
}
interface Actor {
  p: Principal;
  ip: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "repo";

export class Org {
  constructor(private db: Db) {}

  private log(a: Actor, action: string, target?: string, detail?: Record<string, unknown>) {
    audit(this.db, {
      orgId: a.p.user.org_id,
      actorId: a.p.user.id,
      actor: a.p.user.email,
      action,
      target,
      ip: a.ip,
      detail,
    });
  }

  // ── roles ──

  roles(orgId: string): (Role & { members: number; grants: number })[] {
    return (
      this.db
        .prepare("SELECT * FROM roles WHERE org_id = ? ORDER BY builtin DESC, name")
        .all(orgId) as unknown as {
        id: string;
        name: string;
        description: string;
        permissions: string;
        builtin: number;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: JSON.parse(r.permissions) as string[],
      builtin: !!r.builtin,
      members: (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND status != 'disabled'")
          .get(r.id) as { n: number }
      ).n,
      grants: (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM grants WHERE role_id = ? OR (principal_type = 'role' AND principal_id = ?)",
          )
          .get(r.id, r.id) as { n: number }
      ).n,
    }));
  }

  role(orgId: string, id: string): (Role & { members: number; grants: number }) | undefined {
    return this.roles(orgId).find((r) => r.id === id);
  }

  private checkRoleInput(a: Actor, name: string, description: string, permissions: string[]) {
    const n = name.trim();
    if (!n || n.length > 40)
      throw new AuthError(400, "Give the role a name (up to 40 characters).");
    if (description.length > 200)
      throw new AuthError(400, "Keep the description under 200 characters.");
    const perms = [...new Set(permissions)];
    if (!perms.every(isPermission)) throw new AuthError(400, "Unknown permission.");
    if (perms.includes("org.manage"))
      throw new AuthError(400, "Only the Owner role can manage the organisation itself.");
    if (!canGrant(a.p.permissions, perms))
      throw new AuthError(403, "You can only give a role permissions you have yourself.");
    return { n, perms };
  }

  createRole(a: Actor, name: string, description: string, permissions: string[]) {
    const { n, perms } = this.checkRoleInput(a, name, description, permissions);
    const orgId = a.p.user.org_id;
    if (
      this.db
        .prepare("SELECT 1 FROM roles WHERE org_id = ? AND name = ? COLLATE NOCASE")
        .get(orgId, n)
    )
      throw new AuthError(409, "A role with that name exists.");
    const id = newId("role");
    this.db
      .prepare(
        "INSERT INTO roles (id, org_id, name, description, permissions, builtin) VALUES (?,?,?,?,?,0)",
      )
      .run(id, orgId, n, description.trim(), JSON.stringify(perms));
    this.log(a, "role.created", n, { permissions: perms });
    return id;
  }

  updateRole(a: Actor, id: string, name: string, description: string, permissions: string[]) {
    const r = this.role(a.p.user.org_id, id);
    if (!r) throw new AuthError(404, "No such role.");
    if (r.builtin)
      throw new AuthError(400, "Built-in roles cannot be changed. Duplicate it instead.");
    if (a.p.user.role_id === id) throw new AuthError(403, "You cannot change the role you hold.");
    if (!canGrant(a.p.permissions, r.permissions))
      throw new AuthError(403, "This role has permissions you do not have.");
    const { n, perms } = this.checkRoleInput(a, name, description, permissions);
    if (
      this.db
        .prepare("SELECT 1 FROM roles WHERE org_id = ? AND name = ? COLLATE NOCASE AND id != ?")
        .get(a.p.user.org_id, n, id)
    )
      throw new AuthError(409, "A role with that name exists.");
    this.db
      .prepare("UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?")
      .run(n, description.trim(), JSON.stringify(perms), id);
    this.log(a, "role.updated", n, { before: r.permissions, after: perms });
  }

  deleteRole(a: Actor, id: string) {
    const r = this.role(a.p.user.org_id, id);
    if (!r) throw new AuthError(404, "No such role.");
    if (r.builtin) throw new AuthError(400, "Built-in roles cannot be deleted.");
    if (r.members || r.grants)
      throw new AuthError(409, "Move its members and remove its repository grants first.");
    this.db.prepare("DELETE FROM roles WHERE id = ?").run(id);
    this.log(a, "role.deleted", r.name);
  }

  // ── members and invitations ──

  members(orgId: string) {
    return this.db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role_id, u.status, u.mfa_enabled, u.last_login_at, u.created_at, u.sso_subject, i.expires_at AS invite_expires
         FROM users u LEFT JOIN invites i ON i.user_id = u.id WHERE u.org_id = ? ORDER BY u.status = 'disabled', u.name COLLATE NOCASE`,
      )
      .all(orgId) as unknown as {
      id: string;
      name: string;
      email: string;
      role_id: string;
      status: string;
      mfa_enabled: number;
      last_login_at: string | null;
      created_at: string;
      sso_subject: string | null;
      invite_expires: string | null;
    }[];
  }

  private member(orgId: string, id: string) {
    const m = this.members(orgId).find((x) => x.id === id);
    if (!m) throw new AuthError(404, "No such member.");
    return m;
  }

  private owners(orgId: string) {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role_id = ? AND status = 'active'",
        )
        .get(orgId, `${orgId}:owner`) as { n: number }
    ).n;
  }

  private assertCanAssign(a: Actor, roleId: string) {
    const r = this.role(a.p.user.org_id, roleId);
    if (!r) throw new AuthError(400, "No such role.");
    if (!canGrant(a.p.permissions, r.permissions))
      throw new AuthError(
        403,
        `You cannot give the ${r.name} role: it has permissions you do not have.`,
      );
    return r;
  }

  private assertCanManage(a: Actor, target: { id: string; role_id: string }) {
    if (target.id === a.p.user.id)
      throw new AuthError(403, "You cannot do this to your own account here.");
    const r = this.role(a.p.user.org_id, target.role_id);
    if (r && !canGrant(a.p.permissions, r.permissions))
      throw new AuthError(403, "This member has permissions you do not have.");
  }

  invite(a: Actor, emailRaw: string, roleId: string) {
    const email = emailRaw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new AuthError(400, "Enter a valid email address.");
    const role = this.assertCanAssign(a, roleId);
    const orgId = a.p.user.org_id;
    if (this.db.prepare("SELECT 1 FROM users WHERE org_id = ? AND email = ?").get(orgId, email))
      throw new AuthError(409, "That person is already a member or invited.");
    const userId = newId("usr");
    const token = newToken();
    tx(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO users (id, org_id, email, name, role_id, status, created_at) VALUES (?,?,?,?,?, 'invited', ?)",
        )
        .run(userId, orgId, email, email.split("@")[0] ?? email, roleId, now());
      this.db
        .prepare(
          "INSERT INTO invites (id, org_id, user_id, hash, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          newId("inv"),
          orgId,
          userId,
          sha256(token),
          now(),
          new Date(Date.now() + 72 * 3600_000).toISOString(),
          a.p.user.id,
        );
    });
    this.log(a, "member.invited", email, { role: role.name });
    return { userId, token };
  }

  resendInvite(a: Actor, userId: string) {
    const m = this.member(a.p.user.org_id, userId);
    if (m.status !== "invited") throw new AuthError(400, "This member has already joined.");
    this.assertCanManage(a, m);
    const token = newToken();
    this.db.prepare("DELETE FROM invites WHERE user_id = ?").run(userId);
    this.db
      .prepare(
        "INSERT INTO invites (id, org_id, user_id, hash, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        newId("inv"),
        a.p.user.org_id,
        userId,
        sha256(token),
        now(),
        new Date(Date.now() + 72 * 3600_000).toISOString(),
        a.p.user.id,
      );
    this.log(a, "member.invite_renewed", m.email);
    return token;
  }

  /** Public: who an invite link is for (without revealing anything if it is invalid). */
  inviteInfo(token: string) {
    const r = this.db
      .prepare(
        "SELECT u.email, u.id, o.name AS org, i.expires_at FROM invites i JOIN users u ON u.id = i.user_id JOIN orgs o ON o.id = i.org_id WHERE i.hash = ?",
      )
      .get(sha256(token)) as
      | { email: string; id: string; org: string; expires_at: string }
      | undefined;
    if (!r || Date.parse(r.expires_at) < Date.now()) return null;
    return r;
  }

  removeInvite(userId: string) {
    this.db.prepare("DELETE FROM invites WHERE user_id = ?").run(userId);
  }

  setRole(a: Actor, userId: string, roleId: string) {
    const orgId = a.p.user.org_id;
    const m = this.member(orgId, userId);
    this.assertCanManage(a, m);
    const role = this.assertCanAssign(a, roleId);
    if (m.role_id === `${orgId}:owner` && roleId !== m.role_id && this.owners(orgId) <= 1)
      throw new AuthError(409, "Keep at least one Owner.");
    this.db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(roleId, userId);
    this.log(a, "member.role_changed", m.email, {
      from: this.role(orgId, m.role_id)?.name,
      to: role.name,
    });
  }

  setActive(a: Actor, userId: string, active: boolean) {
    const orgId = a.p.user.org_id;
    const m = this.member(orgId, userId);
    this.assertCanManage(a, m);
    if (!active && m.role_id === `${orgId}:owner` && this.owners(orgId) <= 1)
      throw new AuthError(409, "Keep at least one Owner.");
    if (m.status === "invited") {
      if (active) throw new AuthError(400, "They have not accepted the invitation yet.");
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      this.log(a, "member.invite_revoked", m.email);
      return;
    }
    this.db
      .prepare("UPDATE users SET status = ? WHERE id = ?")
      .run(active ? "active" : "disabled", userId);
    if (!active) {
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
    }
    this.log(a, active ? "member.reactivated" : "member.deactivated", m.email);
  }

  resetMfa(a: Actor, userId: string) {
    const m = this.member(a.p.user.org_id, userId);
    this.assertCanManage(a, m);
    this.db
      .prepare(
        "UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, recovery = '[]', mfa_last_step = -1 WHERE id = ?",
      )
      .run(userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.log(a, "member.mfa_reset", m.email);
  }

  signOutEverywhere(a: Actor, userId: string) {
    const m = this.member(a.p.user.org_id, userId);
    this.assertCanManage(a, m);
    const n = Number(this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
    this.log(a, "member.sessions_revoked", m.email, { count: n });
  }

  // ── repositories ──

  workspaces(orgId: string): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE org_id = ? ORDER BY name COLLATE NOCASE")
      .all(orgId) as unknown as Workspace[];
  }

  workspace(orgId: string, slug: string): Workspace | undefined {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE org_id = ? AND slug = ?")
      .get(orgId, slug) as unknown as Workspace | undefined;
  }

  /** Register a local repository (local mode). Returns the existing one for the same path. */
  ensureLocal(orgId: string, path: string, runsDir: string, createdBy: string | null): Workspace {
    const abs = resolve(path);
    const existing = this.db
      .prepare("SELECT * FROM workspaces WHERE org_id = ? AND path = ?")
      .get(orgId, abs) as unknown as Workspace | undefined;
    if (existing) return existing;
    let slug = slugify(basename(abs));
    for (
      let i = 2;
      this.db.prepare("SELECT 1 FROM workspaces WHERE org_id = ? AND slug = ?").get(orgId, slug);
      i++
    )
      slug = `${slugify(basename(abs))}-${i}`;
    const id = newId("ws");
    this.db
      .prepare(
        "INSERT INTO workspaces (id, org_id, slug, name, kind, path, runs_dir, created_at, created_by) VALUES (?,?,?,?, 'local', ?,?,?,?)",
      )
      .run(id, orgId, slug, basename(abs), abs, resolve(runsDir), now(), createdBy);
    return this.workspace(orgId, slug) as Workspace;
  }

  addLocal(a: Actor, pathRaw: string): Workspace {
    const path = pathRaw.trim();
    if (!isAbsolute(path))
      throw new AuthError(400, "Enter the full path to the repository folder, starting with /.");
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new AuthError(400, "That folder does not exist on this machine.");
    if (!existsSync(join(path, ".git")))
      throw new AuthError(400, "That folder is not a git repository.");
    const w = this.ensureLocal(
      a.p.user.org_id,
      path,
      join(path, ".bumpsmith", "runs"),
      a.p.user.id,
    );
    this.log(a, "workspace.added", w.slug, { path: w.path });
    return w;
  }

  removeWorkspace(a: Actor, slug: string) {
    const w = this.workspace(a.p.user.org_id, slug);
    if (!w) throw new AuthError(404, "No such repository.");
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(w.id);
    this.log(a, "workspace.removed", w.slug);
  }

  setVisibility(a: Actor, slug: string, visibility: string) {
    const w = this.workspace(a.p.user.org_id, slug);
    if (!w) throw new AuthError(404, "No such repository.");
    if (visibility !== "org" && visibility !== "restricted")
      throw new AuthError(400, "Unknown visibility.");
    this.db.prepare("UPDATE workspaces SET visibility = ? WHERE id = ?").run(visibility, w.id);
    this.log(a, "access.visibility_changed", w.slug, { from: w.visibility, to: visibility });
  }

  // ── grants and effective access ──

  grants(orgId: string) {
    return this.db
      .prepare(
        "SELECT g.*, w.slug FROM grants g JOIN workspaces w ON w.id = g.workspace_id WHERE g.org_id = ?",
      )
      .all(orgId) as unknown as {
      id: string;
      workspace_id: string;
      slug: string;
      principal_type: "user" | "role";
      principal_id: string;
      role_id: string;
    }[];
  }

  setGrant(
    a: Actor,
    slug: string,
    principalType: string,
    principalId: string,
    roleId: string | null,
  ) {
    const orgId = a.p.user.org_id;
    const w = this.workspace(orgId, slug);
    if (!w) throw new AuthError(404, "No such repository.");
    if (principalType !== "user" && principalType !== "role")
      throw new AuthError(400, "Grant to a member or a role.");
    const principal =
      principalType === "user"
        ? this.members(orgId).find((m) => m.id === principalId)?.email
        : this.role(orgId, principalId)?.name;
    if (!principal) throw new AuthError(404, "No such member or role.");
    const existing = this.db
      .prepare(
        "SELECT role_id FROM grants WHERE workspace_id = ? AND principal_type = ? AND principal_id = ?",
      )
      .get(w.id, principalType, principalId) as { role_id: string } | undefined;
    if (existing) {
      const old = this.role(orgId, existing.role_id);
      if (old && !canGrant(a.p.permissions, old.permissions))
        throw new AuthError(403, "That grant has permissions you do not have.");
    }
    if (roleId === null) {
      this.db
        .prepare(
          "DELETE FROM grants WHERE workspace_id = ? AND principal_type = ? AND principal_id = ?",
        )
        .run(w.id, principalType, principalId);
      this.log(a, "access.revoked", w.slug, { principal, type: principalType });
      return;
    }
    const role = this.assertCanAssign(a, roleId);
    this.db
      .prepare(
        "INSERT INTO grants (id, org_id, workspace_id, principal_type, principal_id, role_id, created_at, created_by) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id, principal_type, principal_id) DO UPDATE SET role_id = excluded.role_id",
      )
      .run(newId("grt"), orgId, w.id, principalType, principalId, roleId, now(), a.p.user.id);
    this.log(a, "access.granted", w.slug, { principal, type: principalType, role: role.name });
  }

  /**
   * What `user` may do in `w`, and why. Organisation-wide permissions are not included.
   */
  effective(user: { id: string; role_id: string }, orgPerms: string[], w: Workspace) {
    const why: string[] = [];
    const perms = new Set<string>();
    const add = (ps: string[], reason: string) => {
      const scoped = ps.filter((p) => WS_PERMS.includes(p));
      if (!scoped.length) return;
      for (const p of scoped) perms.add(p);
      why.push(reason);
    };
    const orgRole = this.role(w.org_id, user.role_id);
    if (orgPerms.includes(ALL_REPOS))
      add(orgPerms, `${orgRole?.name ?? "Your role"}: every repository`);
    else if (w.visibility === "org")
      add(orgPerms, `${orgRole?.name ?? "Your role"} (repository open to the organisation)`);
    for (const g of this.grants(w.org_id).filter((x) => x.workspace_id === w.id)) {
      if (
        (g.principal_type === "user" && g.principal_id === user.id) ||
        (g.principal_type === "role" && g.principal_id === user.role_id)
      ) {
        const r = this.role(w.org_id, g.role_id);
        if (r)
          add(
            r.permissions,
            g.principal_type === "user"
              ? `Granted ${r.name} directly`
              : `Granted ${r.name} to everyone with the ${orgRole?.name ?? ""} role`,
          );
      }
    }
    // Repository permissions need a way in: nothing works without being able to see it.
    if (!perms.has("workspaces.view") && !perms.has("runs.view"))
      return { permissions: [] as string[], why: [] as string[] };
    perms.add("workspaces.view");
    return { permissions: [...perms], why };
  }

  /** Repositories `p` can see, with what they may do in each. */
  visible(p: Principal) {
    return this.workspaces(p.user.org_id)
      .map((w) => ({ w, e: this.effective(p.user, p.permissions, w) }))
      .filter((x) => x.e.permissions.length > 0);
  }
}
