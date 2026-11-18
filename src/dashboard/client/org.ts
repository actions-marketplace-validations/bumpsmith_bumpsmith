// Organisation pages: Members, Roles, the Access control center and the Audit log. Same page,
// panel, table, badge and dialog components as the rest of the dashboard.
import { can, session } from "./auth.ts";
import { confirmDialog, openDialog } from "./dialog.ts";
import { api, post } from "./net.ts";
import { agoLong, esc, icon } from "./ui.ts";

interface RoleLite {
  id: string;
  name: string;
  permissions: string[];
  builtin: boolean;
}
interface Member {
  id: string;
  name: string;
  email: string;
  role_id: string;
  status: string;
  mfa_enabled: number;
  last_login_at: string | null;
  created_at: string;
  invite_expires: string | null;
}
interface PermDef {
  id: string;
  group: string;
  label: string;
}
interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  detail: string;
}

export const org = {
  members: null as null | { members: Member[]; roles: RoleLite[]; me: string },
  roles: null as null | {
    roles: (RoleLite & { description: string; members: number; grants: number })[];
    catalogue: PermDef[];
    workspacePermissions: string[];
    mine: string[];
  },
  roleSel: "" as string,
  roleDraft: null as null | {
    id: string | null;
    name: string;
    description: string;
    permissions: string[];
  },
  access: null as null | {
    workspaces: { slug: string; name: string; visibility: string }[];
    roles: RoleLite[];
    members: { id: string; name: string; email: string; role_id: string; status: string }[];
    grants: { workspace: string; principalType: string; principalId: string; roleId: string }[];
    mine: string[];
  },
  check: null as null | {
    user: { id: string; name: string; email: string; role: string };
    organisation: string[];
    repositories: {
      workspace: string;
      name: string;
      visibility: string;
      permissions: string[];
      why: string[];
    }[];
  },
  checkUser: "",
  audit: null as null | {
    rows: AuditRow[];
    chain: { ok: boolean; rows: number; brokenAt: number | null };
  },
  auditQ: "",
  auditCat: "",
};

let ctx = { render: () => {}, toast: (_m: string, _bad?: boolean) => {} };
export const setupOrg = (c: typeof ctx) => {
  ctx = c;
};

export async function loadOrgPage(page: string) {
  if (page === "members") org.members = await api("/api/members");
  if (page === "roles") {
    org.roles = await api("/api/roles");
    if (!org.roleSel || !org.roles?.roles.some((r) => r.id === org.roleSel))
      org.roleSel = org.roles?.roles[0]?.id ?? "";
  }
  if (page === "access") {
    org.access = await api("/api/access");
    if (!org.checkUser) org.checkUser = org.access?.members[0]?.id ?? "";
    if (org.checkUser)
      org.check = await api(`/api/access/check?user=${encodeURIComponent(org.checkUser)}`);
  }
  if (page === "audit")
    org.audit = await api(
      `/api/audit?q=${encodeURIComponent(org.auditQ)}&cat=${encodeURIComponent(org.auditCat)}`,
    );
}

const skeleton = `<div class="page"><div class="skel" style="height:28px;width:240px;margin-bottom:24px"></div><div class="skel" style="height:360px"></div></div>`;
const initials = (n: string) =>
  n
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
const roleName = (roles: RoleLite[], id: string) =>
  roles.find((r) => r.id === id)?.name ?? "Unknown";
/** Roles the signed-in user may hand out: never more than they hold. */
const grantable = (roles: RoleLite[]) =>
  roles.filter((r) => r.permissions.every((p) => session.info?.permissions.includes(p)));

// ── Members ──

export function membersPage(): string {
  const m = org.members;
  if (!m) return skeleton;
  const manage = can("members.manage");
  const assignable = grantable(m.roles);
  const rows = m.members
    .map((u) => {
      const self = u.id === m.me;
      const invited = u.status === "invited";
      const off = u.status === "disabled";
      const roleCell =
        manage && !self && !off && assignable.some((r) => r.id === u.role_id)
          ? `<select class="input sm" data-act-change="member-role" data-id="${esc(u.id)}" aria-label="Role for ${esc(u.name)}">${assignable.map((r) => `<option value="${esc(r.id)}" ${r.id === u.role_id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`
          : `<span>${esc(roleName(m.roles, u.role_id))}</span>`;
      const status = invited
        ? `<span class="badge info">invited</span><div class="faint" style="font-size:12px">${u.invite_expires && Date.parse(u.invite_expires) < Date.now() ? "link expired" : `link expires ${esc(agoLong(u.invite_expires).replace(" ago", ""))}`}</div>`
        : off
          ? `<span class="badge">deactivated</span>`
          : `<span class="badge ok"><span class="dot ok"></span>active</span>`;
      const actions =
        !manage || self
          ? self
            ? `<span class="badge accent">you</span>`
            : ""
          : invited
            ? `<button class="btn sm" data-act="member-resend" data-id="${esc(u.id)}">${icon("copy")}New link</button><button class="btn sm" data-act="member-deactivate" data-id="${esc(u.id)}">Revoke</button>`
            : off
              ? `<button class="btn sm" data-act="member-reactivate" data-id="${esc(u.id)}">Reactivate</button>`
              : `${u.mfa_enabled ? `<button class="btn sm" data-act="member-reset-mfa" data-id="${esc(u.id)}" title="They will set up two-factor again at next sign-in">Reset MFA</button>` : ""}<button class="btn sm" data-act="member-reset-password" data-id="${esc(u.id)}" title="A one-time link to choose a new password">Reset password</button><button class="btn sm" data-act="member-signout" data-id="${esc(u.id)}">Sign out</button><button class="btn sm" data-act="member-deactivate" data-id="${esc(u.id)}">Deactivate</button>`;
      return `<tr style="cursor:default" class="${off ? "dim" : ""}"><td><div class="who-c"><span class="me-av">${esc(initials(u.name || u.email))}</span><span><b>${esc(invited ? u.email : u.name)}</b><span class="muted">${esc(invited ? "pending" : u.email)}</span></span></div></td>
        <td>${roleCell}</td><td>${invited ? "" : u.mfa_enabled ? `<span class="st ok">${icon("checkCircle")}on</span>` : `<span class="muted">off</span>`}</td>
        <td>${status}</td><td class="muted">${invited ? "" : u.last_login_at ? esc(agoLong(u.last_login_at)) : "never"}</td><td class="r"><div class="acts">${actions}</div></td></tr>`;
    })
    .join("");
  const active = m.members.filter((u) => u.status === "active").length;
  return `<div class="page wide">
    <div class="ph"><div><h1>Members</h1><p>${active} active · ${m.members.filter((u) => u.status === "invited").length} invited</p></div>
      ${manage ? `<div class="act"><button class="btn primary" data-act="member-invite">${icon("plus")}Invite people</button></div>` : ""}</div>
    <div class="panel"><div class="tw"><table class="t members"><thead><tr><th>Member</th><th>Role</th><th>MFA</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
  </div>`;
}

// ── Roles ──

export function rolesPage(): string {
  const r = org.roles;
  if (!r) return skeleton;
  const manage = can("roles.manage");
  const sel = r.roles.find((x) => x.id === org.roleSel);
  const draft = org.roleDraft;
  const editing = !!draft;
  const groups = [...new Set(r.catalogue.map((p) => p.group))];
  const perms = editing ? draft.permissions : (sel?.permissions ?? []);
  const list = r.roles
    .map(
      (
        x,
      ) => `<button class="role-i ${!editing && x.id === org.roleSel ? "on" : ""}" data-act="role-sel" data-id="${esc(x.id)}">
        <span class="role-n"><b>${esc(x.name)}</b>${x.builtin ? `<span class="badge">built-in</span>` : ""}</span>
        <span class="muted">${x.members} member${x.members === 1 ? "" : "s"} · ${x.permissions.length} permission${x.permissions.length === 1 ? "" : "s"}</span></button>`,
    )
    .join("");
  const checklist = groups
    .map(
      (g) =>
        `<fieldset class="perm-g"><legend>${esc(g)}</legend>${r.catalogue
          .filter((p) => p.group === g)
          .map((p) => {
            const on = perms.includes(p.id);
            const allowed = r.mine.includes(p.id) && p.id !== "org.manage";
            return editing
              ? `<label class="check ${allowed ? "" : "dim"}"><input type="checkbox" data-perm="${esc(p.id)}" ${on ? "checked" : ""} ${allowed ? "" : "disabled"} />${esc(p.label)}${r.workspacePermissions.includes(p.id) ? `<span class="badge">per repository</span>` : ""}</label>`
              : `<div class="perm-row ${on ? "on" : ""}">${icon(on ? "check" : "minus")}<span>${esc(p.label)}</span>${r.workspacePermissions.includes(p.id) ? `<span class="badge">per repository</span>` : ""}</div>`;
          })
          .join("")}</fieldset>`,
    )
    .join("");
  const head = editing
    ? `<div class="panel-b form" style="padding-bottom:0">
        <div class="field"><label for="r-name">Name</label><input class="input" id="r-name" maxlength="40" value="${esc(draft.name)}" placeholder="Release manager" /></div>
        <div class="field"><label for="r-desc">Description</label><input class="input" id="r-desc" maxlength="200" value="${esc(draft.description)}" placeholder="What people with this role do" /></div></div>`
    : `<div class="panel-b" style="padding-bottom:0"><p class="muted" style="margin:0">${esc(sel?.description || "No description.")}</p></div>`;
  const actions = editing
    ? `<button class="btn" data-act="role-cancel">Cancel</button>${draft.id ? `<button class="btn danger-o" data-act="role-delete">Delete role</button>` : ""}<div class="grow"></div><button class="btn primary" data-act="role-save">${draft.id ? "Save role" : "Create role"}</button>`
    : manage && sel
      ? `${sel.builtin ? "" : `<button class="btn" data-act="role-edit">Edit</button>`}<button class="btn" data-act="role-duplicate">${icon("copy")}Duplicate</button>`
      : "";
  return `<div class="page wide">
    <div class="ph"><div><h1>Roles</h1><p>What each role allows. Repository permissions apply wherever the role has access.</p></div>
      ${manage ? `<div class="act"><button class="btn primary" data-act="role-new">${icon("plus")}New role</button></div>` : ""}</div>
    <div class="grid roles-g">
      <div class="panel" style="align-self:start"><div class="role-list">${list}</div></div>
      <div class="panel"><div class="panel-h"><h2>${esc(editing ? (draft.id ? `Edit ${draft.name}` : "New role") : (sel?.name ?? ""))}</h2>${!editing && sel?.builtin ? `<span class="sub">built-in roles cannot be changed</span>` : ""}</div>
        ${head}<div class="panel-b perms">${checklist}</div>
        ${actions ? `<div class="panel-f">${actions}</div>` : ""}</div>
    </div>
  </div>`;
}

// ── Access control center ──

export function accessPage(): string {
  const a = org.access;
  if (!a) return skeleton;
  const roleOpts = (sel: string | undefined, none = "No access") =>
    `<option value="">${esc(none)}</option>${grantable(a.roles)
      .map(
        (r) =>
          `<option value="${esc(r.id)}" ${r.id === sel ? "selected" : ""}>${esc(r.name)}</option>`,
      )
      .join(
        "",
      )}${sel && !grantable(a.roles).some((r) => r.id === sel) ? `<option value="${esc(sel)}" selected disabled>${esc(roleName(a.roles, sel))}</option>` : ""}`;
  const grantOf = (ws: string, type: string, id: string) =>
    a.grants.find((g) => g.workspace === ws && g.principalType === type && g.principalId === id)
      ?.roleId;
  const cell = (
    ws: { slug: string; visibility: string },
    type: "role" | "user",
    id: string,
    base: string,
  ) => {
    const g = grantOf(ws.slug, type, id);
    const open = ws.visibility === "org";
    const tip = g
      ? "Granted"
      : open
        ? "Open repository: their organisation role applies. Pick a role to grant more."
        : "Restricted: no access unless granted";
    return `<td><select class="input sm ${g ? "set" : open ? "open" : ""}" data-act-change="grant" data-ws="${esc(ws.slug)}" data-type="${type}" data-id="${esc(id)}" aria-label="Access" title="${esc(tip)}">${roleOpts(g, open ? `${base} (open)` : "No access")}</select></td>`;
  };
  const admins = (roleId: string) =>
    (a.roles.find((r) => r.id === roleId)?.permissions ?? []).includes("access.manage");
  const head = a.workspaces
    .map(
      (w) => `<th class="ws-h"><div class="ws-hn">${icon("folder")}<b>${esc(w.name)}</b></div>
      <div class="seg xs" role="radiogroup" aria-label="Who can see ${esc(w.name)}">
        <button class="${w.visibility === "org" ? "on" : ""}" data-act="ws-visibility" data-ws="${esc(w.slug)}" data-v="org" role="radio" aria-checked="${w.visibility === "org"}" title="Everyone gets their organisation role here">Open</button>
        <button class="${w.visibility === "restricted" ? "on" : ""}" data-act="ws-visibility" data-ws="${esc(w.slug)}" data-v="restricted" role="radio" aria-checked="${w.visibility === "restricted"}" title="Only the roles and people granted below">Restricted</button>
      </div></th>`,
    )
    .join("");
  const roleRows = a.roles
    .map((r) => {
      const all = admins(r.id);
      return `<tr><th><div class="who-h"><span class="role-dot"></span><b>${esc(r.name)}</b><span class="muted">role</span></div></th>${a.workspaces
        .map((w) =>
          all
            ? `<td><span class="implicit full">${icon("shield")}Full access</span></td>`
            : cell(w, "role", r.id, r.name),
        )
        .join("")}</tr>`;
    })
    .join("");
  const userRows = a.members
    .map((u) => {
      const all = admins(u.role_id);
      return `<tr><th><div class="who-h"><span class="me-av xs">${esc(initials(u.name || u.email))}</span><b>${esc(u.status === "invited" ? u.email : u.name)}</b><span class="muted">${esc(roleName(a.roles, u.role_id))}</span></div></th>${a.workspaces
        .map((w) =>
          all
            ? `<td><span class="implicit full">${icon("shield")}Full access</span></td>`
            : cell(w, "user", u.id, roleName(a.roles, u.role_id)),
        )
        .join("")}</tr>`;
    })
    .join("");
  const c = org.check;
  const checkBody = c
    ? `<div class="tw"><table class="t"><thead><tr><th>Repository</th><th>Can</th><th>Because</th></tr></thead><tbody>${c.repositories
        .map(
          (
            r,
          ) => `<tr style="cursor:default"><td><b>${esc(r.name)}</b>${r.visibility === "restricted" ? ` <span class="badge">restricted</span>` : ""}</td>
          <td>${
            r.permissions.length
              ? r.permissions
                  .filter((p) => p !== "workspaces.view")
                  .map((p) => `<span class="perm-chip">${esc(p.replace("runs.", ""))}</span>`)
                  .join("") || `<span class="perm-chip">view</span>`
              : `<span class="muted">no access</span>`
          }</td>
          <td class="muted">${esc(r.why.join(" · ") || "Not granted, and the repository is restricted")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";
  return `<div class="page wide">
    <div class="ph"><div><h1>Access</h1><p>Who can do what in each repository. Grants only add access; Owners and Admins always have full access.</p></div></div>
    <div class="panel"><div class="panel-h"><h2>Repository access</h2><span class="sub">Open repositories give everyone their organisation role. Restricted ones only allow the grants below.</span></div>
      <div class="tw"><table class="t matrix"><thead><tr><th class="who-col">Roles and members</th>${head}</tr></thead>
        <tbody><tr class="sec-r"><td colspan="${a.workspaces.length + 1}">Roles</td></tr>${roleRows}<tr class="sec-r"><td colspan="${a.workspaces.length + 1}">Members</td></tr>${userRows}</tbody></table></div></div>
    <div class="panel mt"><div class="panel-h"><h2>Check someone's access</h2>
      <div class="r"><select class="input sm" data-act-change="access-check" aria-label="Member">${a.members.map((u) => `<option value="${esc(u.id)}" ${u.id === org.checkUser ? "selected" : ""}>${esc(u.name || u.email)}</option>`).join("")}</select></div></div>
      ${c ? `<div class="panel-b" style="padding-bottom:0"><p class="muted" style="margin:0">${esc(c.user.name)} has the <b>${esc(c.user.role)}</b> role. Across the organisation they can: ${c.organisation.length ? c.organisation.map((p) => `<span class="perm-chip">${esc(p)}</span>`).join("") : "nothing beyond repositories"}.</p></div>` : ""}
      ${checkBody}</div>
  </div>`;
}

// ── Audit log ──

const ACTION_LABEL: Record<string, string> = {
  "org.created": "Created the organisation",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Failed sign-in",
  "auth.login_locked": "Sign-in blocked (locked)",
  "auth.mfa_enabled": "Turned on two-factor",
  "auth.mfa_disabled": "Turned off two-factor",
  "auth.mfa_failed": "Wrong two-factor code",
  "auth.recovery_code_used": "Used a recovery code",
  "auth.recovery_codes_regenerated": "Created new recovery codes",
  "auth.reauth": "Confirmed identity",
  "auth.reauth_failed": "Failed to confirm identity",
  "auth.password_changed": "Changed password",
  "auth.sessions_revoked": "Signed out other sessions",
  "auth.session_revoked": "Signed out a session",
  "token.created": "Created an API token",
  "token.revoked": "Revoked an API token",
  "member.invited": "Invited",
  "member.joined": "Joined",
  "member.role_changed": "Changed role of",
  "member.deactivated": "Deactivated",
  "member.reactivated": "Reactivated",
  "member.mfa_reset": "Reset two-factor of",
  "member.password_reset_issued": "Issued a password reset link for",
  "auth.password_reset": "Reset password with a link",
  "member.sessions_revoked": "Signed out",
  "member.invite_revoked": "Revoked invitation for",
  "member.invite_renewed": "Renewed invitation for",
  "role.created": "Created role",
  "role.updated": "Changed role",
  "role.deleted": "Deleted role",
  "access.granted": "Granted access to",
  "access.revoked": "Removed access to",
  "access.visibility_changed": "Changed visibility of",
  "workspace.added": "Added repository",
  "workspace.removed": "Removed repository",
  "security.policy_changed": "Changed security settings",
  "run.started": "Started upgrade",
  "run.applied": "Applied patch",
  "run.deleted": "Deleted run",
  "deps.scanned": "Scanned dependencies",
  "audit.exported": "Exported the audit log",
};
const tone = (a: string) =>
  /failed|locked|revoked|deactivated|deleted|disabled|reset/.test(a)
    ? "bad"
    : /granted|joined|enabled|created|applied|invited/.test(a)
      ? "ok"
      : "";

function detailText(d: string) {
  try {
    const o = JSON.parse(d) as Record<string, unknown>;
    return Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
      .map(([k, v]) => `${k}: ${v}`)
      .concat(
        Object.entries(o)
          .filter(([, v]) => v && typeof v === "object")
          .map(([k]) => `${k}: …`),
      )
      .join(" · ");
  } catch {
    return "";
  }
}

export function auditPage(): string {
  const a = org.audit;
  if (!a) return skeleton;
  const cats: [string, string][] = [
    ["", "All"],
    ["auth", "Sign-in"],
    ["people", "People"],
    ["roles", "Roles"],
    ["access", "Access"],
    ["security", "Security"],
    ["runs", "Upgrades"],
  ];
  const rows = a.rows
    .map(
      (
        r,
      ) => `<tr style="cursor:default"><td class="mono muted" title="${esc(r.at)}">${esc(new Date(r.at).toLocaleString())}<div class="faint au-a" style="margin:0">#${r.seq}</div></td>
      <td><b>${esc(r.actor)}</b></td>
      <td><span class="au ${tone(r.action)}"><span class="dot ${tone(r.action) || "neutral"}"></span>${esc(ACTION_LABEL[r.action] ?? r.action)}</span>${r.target ? ` <span class="mono">${esc(r.target)}</span>` : ""}<div class="faint mono au-a">${esc(r.action)}</div></td>
      <td class="muted au-d">${esc(detailText(r.detail))}</td><td class="mono muted">${esc(r.ip ?? "")}</td></tr>`,
    )
    .join("");
  return `<div class="page wide">
    <div class="ph"><div><h1>Audit log</h1><p>Every sign-in and change, in order. Each entry is chained to the one before it, so edits or deletions show up.</p></div>
      <div class="act">${a.chain.ok ? `<span class="badge ok big">${icon("shield")}Chain intact · ${a.chain.rows} events</span>` : `<span class="badge bad big">${icon("alertCircle")}Tampering detected at #${a.chain.brokenAt}</span>`}<a class="btn" href="/api/audit/export" download>${icon("download")}Export CSV</a></div></div>
    <div class="panel"><div class="panel-h au-f">
      <label class="ftree-q au-q">${icon("search")}<input id="audit-q" placeholder="Search people, actions, targets or IPs" value="${esc(org.auditQ)}" spellcheck="false" /></label>
      <div class="seg">${cats.map(([v, l]) => `<button class="${org.auditCat === v ? "on" : ""}" data-act="audit-cat" data-v="${v}">${l}</button>`).join("")}</div></div>
      <div class="tw"><table class="t audit"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>IP</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted" style="padding:24px 16px">No events match.</td></tr>`}</tbody></table></div></div>
  </div>`;
}

// ── actions ──

const linkDialog = (title: string, text: string, link: string) =>
  openDialog({
    title,
    body: `<p class="dialog-p">${esc(text)}</p><div class="mfa-key"><code>${esc(link)}</code><button type="button" class="btn icon ghost" data-copy-link aria-label="Copy link">${icon("copy")}</button></div><p class="dialog-p small">The link works once and expires in 72 hours. Anyone with it can join as this person, so send it privately.</p>`,
    primary: "Done",
    onOpen: (el) =>
      el.querySelector("[data-copy-link]")?.addEventListener("click", async (e) => {
        await navigator.clipboard.writeText(link).catch(() => {});
        (e.currentTarget as HTMLElement).innerHTML = icon("check");
      }),
  });

export async function orgAction(act: string, t: HTMLElement): Promise<boolean> {
  const id = t.dataset.id ?? "";
  const run = async (fn: () => Promise<void>, ok?: string, page?: string) => {
    try {
      await fn();
      if (page) await loadOrgPage(page);
      if (ok) ctx.toast(ok);
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
    ctx.render();
  };
  const member = () => org.members?.members.find((m) => m.id === id);
  switch (act) {
    case "member-invite": {
      const roles = grantable(org.members?.roles ?? []);
      let link = "";
      await openDialog({
        title: "Invite people",
        body: `<div class="field"><label for="inv-email">Work email</label><input class="input" id="inv-email" type="email" maxlength="254" placeholder="sam@acme.dev" /></div>
          <div class="field"><label for="inv-role">Role</label><select class="input" id="inv-role">${roles.map((r) => `<option value="${esc(r.id)}" ${r.name === "Maintainer" ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select><div class="hint">You can only give roles whose permissions you have yourself.</div></div>`,
        primary: "Create invitation",
        onSubmit: async (el) => {
          const r = await post<{ link: string }>("/api/members/invite", {
            email: (el.querySelector("#inv-email") as HTMLInputElement).value,
            roleId: (el.querySelector("#inv-role") as HTMLSelectElement).value,
          });
          link = r.link;
        },
      });
      if (link)
        await linkDialog(
          "Send this invitation link",
          "Copy the link and send it to them. They choose their name and password when they open it.",
          link,
        );
      await run(async () => {}, undefined, "members");
      return true;
    }
    case "member-resend":
      try {
        const r = await post<{ link: string }>(
          `/api/members/${encodeURIComponent(id)}/resend-invite`,
        );
        await linkDialog("New invitation link", "The old link no longer works.", r.link);
      } catch (e) {
        ctx.toast((e as Error).message, true);
      }
      await run(async () => {}, undefined, "members");
      return true;
    case "member-deactivate": {
      const m = member();
      const invited = m?.status === "invited";
      if (
        !(await confirmDialog(
          invited ? "Revoke this invitation?" : `Deactivate ${m?.name ?? "this member"}?`,
          invited
            ? "The link stops working."
            : "They are signed out everywhere, their API tokens are revoked, and they cannot sign in. Their history stays in the audit log.",
          invited ? "Revoke" : "Deactivate",
          true,
        ))
      )
        return true;
      await run(
        () => post(`/api/members/${encodeURIComponent(id)}/deactivate`).then(() => {}),
        invited ? "Invitation revoked" : "Member deactivated",
        "members",
      );
      return true;
    }
    case "member-reactivate":
      await run(
        () => post(`/api/members/${encodeURIComponent(id)}/reactivate`).then(() => {}),
        "Member reactivated",
        "members",
      );
      return true;
    case "member-reset-password":
      try {
        const r = await post<{ link: string }>(
          `/api/members/${encodeURIComponent(id)}/reset-password`,
        );
        await linkDialog(
          "Password reset link",
          "Send this to them privately. It works once, for 24 hours, and signs them out everywhere. Two-factor stays on.",
          r.link,
        );
      } catch (e) {
        ctx.toast((e as Error).message, true);
      }
      return true;
    case "member-reset-mfa":
      if (
        !(await confirmDialog(
          "Reset two-factor authentication?",
          "They are signed out and set up two-factor again the next time they sign in.",
          "Reset",
          true,
        ))
      )
        return true;
      await run(
        () => post(`/api/members/${encodeURIComponent(id)}/reset-mfa`).then(() => {}),
        "Two-factor reset",
        "members",
      );
      return true;
    case "member-signout":
      await run(
        () => post(`/api/members/${encodeURIComponent(id)}/sign-out`).then(() => {}),
        "Signed out everywhere",
        "members",
      );
      return true;
    case "role-sel":
      org.roleSel = id;
      org.roleDraft = null;
      ctx.render();
      return true;
    case "role-new":
      org.roleDraft = {
        id: null,
        name: "",
        description: "",
        permissions: ["runs.view", "workspaces.view"],
      };
      ctx.render();
      return true;
    case "role-duplicate": {
      const sel = org.roles?.roles.find((r) => r.id === org.roleSel);
      if (sel)
        org.roleDraft = {
          id: null,
          name: `${sel.name} copy`,
          description: sel.description,
          permissions: sel.permissions.filter(
            (p) => p !== "org.manage" && session.info?.permissions.includes(p),
          ),
        };
      ctx.render();
      return true;
    }
    case "role-edit": {
      const sel = org.roles?.roles.find((r) => r.id === org.roleSel);
      if (sel)
        org.roleDraft = {
          id: sel.id,
          name: sel.name,
          description: sel.description,
          permissions: [...sel.permissions],
        };
      ctx.render();
      return true;
    }
    case "role-cancel":
      org.roleDraft = null;
      ctx.render();
      return true;
    case "role-save": {
      const d = org.roleDraft;
      if (!d) return true;
      const body = {
        name: (document.getElementById("r-name") as HTMLInputElement | null)?.value ?? d.name,
        description:
          (document.getElementById("r-desc") as HTMLInputElement | null)?.value ?? d.description,
        permissions: [...document.querySelectorAll<HTMLInputElement>("[data-perm]:checked")].map(
          (x) => x.dataset.perm ?? "",
        ),
      };
      await run(
        async () => {
          if (d.id) await post(`/api/roles/${encodeURIComponent(d.id)}/update`, body);
          else org.roleSel = (await post<{ id: string }>("/api/roles", body)).id;
          org.roleDraft = null;
        },
        d.id ? "Role saved" : "Role created",
        "roles",
      );
      return true;
    }
    case "role-delete": {
      const d = org.roleDraft;
      if (!d?.id) return true;
      if (
        !(await confirmDialog(
          `Delete ${d.name}?`,
          "Only roles nobody holds and no repository grants can be deleted.",
          "Delete role",
          true,
        ))
      )
        return true;
      await run(
        async () => {
          await post(`/api/roles/${encodeURIComponent(d.id ?? "")}/delete`);
          org.roleDraft = null;
          org.roleSel = "";
        },
        "Role deleted",
        "roles",
      );
      return true;
    }
    case "ws-visibility":
      await run(
        () =>
          post("/api/access/visibility", { workspace: t.dataset.ws, visibility: t.dataset.v }).then(
            () => {},
          ),
        "Visibility changed",
        "access",
      );
      return true;
    case "audit-cat":
      org.auditCat = t.dataset.v ?? "";
      await run(async () => {}, undefined, "audit");
      return true;
  }
  return false;
}

/** <select> changes on the members and access pages. */
export async function orgChange(act: string, el: HTMLSelectElement): Promise<boolean> {
  const run = async (fn: () => Promise<unknown>, ok: string, page: string) => {
    try {
      await fn();
      ctx.toast(ok);
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
    await loadOrgPage(page).catch(() => {});
    ctx.render();
  };
  if (act === "member-role") {
    await run(
      () =>
        post(`/api/members/${encodeURIComponent(el.dataset.id ?? "")}/role`, { roleId: el.value }),
      "Role changed",
      "members",
    );
    return true;
  }
  if (act === "grant") {
    await run(
      () =>
        post("/api/access/grant", {
          workspace: el.dataset.ws,
          principalType: el.dataset.type,
          principalId: el.dataset.id,
          roleId: el.value || null,
        }),
      el.value ? "Access granted" : "Access removed",
      "access",
    );
    return true;
  }
  if (act === "access-check") {
    org.checkUser = el.value;
    await loadOrgPage("access").catch((e) => ctx.toast((e as Error).message, true));
    ctx.render();
    return true;
  }
  return false;
}

let auditTimer: ReturnType<typeof setTimeout> | undefined;
export function orgInput(id: string, value: string) {
  if (id !== "audit-q") return false;
  org.auditQ = value;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => void loadOrgPage("audit").then(ctx.render), 250);
  return true;
}

/** What each organisation page needs, and the page shown without it. */
export const ORG_PAGE_PERM: Record<string, string> = {
  members: "members.view",
  roles: "roles.manage",
  access: "access.manage",
  security: "security.manage",
  audit: "audit.view",
  integrations: "integrations.manage",
};
export const noAccessPage = (what: string) =>
  `<div class="page"><div class="panel"><div class="blank"><div class="blank-i">${icon("lock")}</div><h3>You don't have access to ${esc(what)}</h3><p>Your role (${esc(session.info?.role.name ?? "")}) does not include it. Ask an Owner or Admin if you need it.</p></div></div></div>`;
