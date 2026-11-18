// "Your account" (profile, password, two-factor, sessions, API tokens) and the organisation's
// security policy. Same page, panel, table and field components as the rest of the dashboard.
import { mountMfaEnrollment, recoveryCodesHtml, session, wireRecoveryCodes } from "./auth.ts";
import { confirmDialog, openDialog } from "./dialog.ts";
import { api, post } from "./net.ts";
import { agoLong, esc, icon } from "./ui.ts";

export interface Me {
  user: { id: string; name: string; email: string; mfa: boolean; created_at?: string };
  mfa: { enabled: boolean; recoveryLeft: number; required: boolean };
  sessions: {
    id: string;
    created_at: string;
    last_seen_at: string;
    ip: string | null;
    user_agent: string | null;
    current: boolean;
  }[];
  tokens: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    created_at: string;
    expires_at: string;
    last_used_at: string | null;
  }[];
  permissions: { id: string; group: string; label: string }[];
}
export interface OrgSecurity {
  mfa: "off" | "admins" | "all";
  idleMinutes: number;
  absoluteHours: number;
}

export const state = { me: null as Me | null, security: null as OrgSecurity | null };
let ctx = { render: () => {}, toast: (_m: string, _bad?: boolean) => {} };
export const setup = (c: typeof ctx) => {
  ctx = c;
};

export async function loadMe() {
  state.me = await api<Me>("/api/me");
}
export async function loadSecurity() {
  state.security = await api<OrgSecurity>("/api/org/security");
}

/** "Chrome on macOS" from a user-agent string; good enough to recognise your own devices. */
export function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const b = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl|node|python|Go-http/i.test(ua)
            ? "Script"
            : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${b} on ${os}` : b;
}

export const TOKEN_SCOPES = [
  "runs.view",
  "runs.start",
  "runs.delete",
  "workspaces.view",
  "members.view",
  "audit.view",
];

const skeleton = `<div class="page"><div class="skel" style="height:28px;width:240px;margin-bottom:24px"></div><div class="skel" style="height:320px"></div></div>`;

export function accountPage(): string {
  const me = state.me;
  if (!me) return skeleton;
  const u = me.user;
  const role = session.info?.role.name ?? "";
  const sessions = me.sessions
    .map(
      (
        s,
      ) => `<tr style="cursor:default"><td><b>${esc(device(s.user_agent))}</b>${s.current ? ` <span class="badge accent">this device</span>` : ""}</td>
        <td class="mono muted">${esc(s.ip ?? "")}</td><td class="muted">${esc(agoLong(s.last_seen_at))}</td><td class="muted">${esc(agoLong(s.created_at))}</td>
        <td class="r">${s.current ? "" : `<button class="btn sm" data-act="sess-revoke" data-id="${esc(s.id)}">Sign out</button>`}</td></tr>`,
    )
    .join("");
  const tokens = me.tokens.length
    ? `<div class="tw"><table class="t"><thead><tr><th>Name</th><th>Scopes</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${me.tokens
        .map(
          (
            t,
          ) => `<tr style="cursor:default"><td><b>${esc(t.name)}</b><div class="mono faint" style="font-size:12px">${esc(t.prefix)}…</div></td>
          <td title="${esc(t.scopes.join(", "))}">${t.scopes.length} permission${t.scopes.length === 1 ? "" : "s"}</td>
          <td class="${Date.parse(t.expires_at) < Date.now() ? "bad-t" : "muted"}">${esc(new Date(t.expires_at).toLocaleDateString())}</td>
          <td class="muted">${t.last_used_at ? esc(agoLong(t.last_used_at)) : "never"}</td>
          <td class="r"><button class="btn sm" data-act="token-revoke" data-id="${esc(t.id)}">Revoke</button></td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<div class="panel-b"><p class="empty-line">${icon("key")}No tokens. Create one to use the API from the CLI or CI.</p></div>`;
  return `<div class="page">
    <div class="ph"><div><h1>Your account</h1><p>${esc(u.email)} · ${esc(role)} · ${esc(session.info?.org?.name ?? "")}</p></div></div>
    <div class="grid g-1-1">
      <div class="grid" style="align-content:start">
        <div class="panel"><div class="panel-h"><h2>Profile</h2></div>
          <div class="panel-b form">
            <div class="field"><label for="p-name">Name</label><input class="input" id="p-name" maxlength="80" value="${esc(u.name)}" /></div>
            <div class="field"><label>Email</label><div class="ro mono">${esc(u.email)}</div><div class="hint">Ask an admin to change your email.</div></div>
            <div><button class="btn" data-act="profile-save">Save</button></div>
          </div></div>
        <div class="panel"><div class="panel-h"><h2>Password</h2></div>
          <div class="panel-b form">
            <div class="field"><label for="pw-cur">Current password</label><input class="input" id="pw-cur" type="password" autocomplete="current-password" maxlength="128" /></div>
            <div class="field"><label for="pw-new">New password</label><input class="input" id="pw-new" type="password" autocomplete="new-password" maxlength="128" /><div class="hint">At least 12 characters. Not a breached password, and not your name or email. Changing it signs you out everywhere else.</div></div>
            <div><button class="btn" data-act="pw-change">Change password</button></div>
          </div></div>
      </div>
      <div class="panel" style="align-self:start"><div class="panel-h"><h2>Two-factor authentication</h2><div class="r">${me.mfa.enabled ? `<span class="badge ok"><span class="dot ok"></span>on</span>` : `<span class="badge ${me.mfa.required ? "bad" : ""}">off</span>`}</div></div>
        <div class="panel-b">
          ${
            me.mfa.enabled
              ? `<dl class="kv"><dt>Method</dt><dd>Authenticator app (TOTP)</dd><dt>Recovery codes</dt><dd class="${me.mfa.recoveryLeft <= 3 ? "warn-t" : ""}">${me.mfa.recoveryLeft} of 10 left</dd></dl>
                 <div class="row-a"><button class="btn" data-act="mfa-recovery">${icon("refresh")}New recovery codes</button><button class="btn" data-act="mfa-disable">Turn off</button></div>`
              : `<p class="muted" style="margin:0 0 16px">Add a second step at sign-in with an authenticator app. ${me.mfa.required ? "Your organisation requires it for your role." : "Strongly recommended."}</p>
                 <button class="btn primary" data-act="mfa-setup">${icon("shield")}Set up two-factor authentication</button>`
          }
        </div></div>
    </div>
    <div class="panel mt"><div class="panel-h"><h2>Sessions</h2><span class="sub">where you are signed in</span>${me.sessions.length > 1 ? `<div class="r"><button class="btn sm" data-act="sess-revoke-others">Sign out other sessions</button></div>` : ""}</div>
      <div class="tw"><table class="t"><thead><tr><th>Device</th><th>IP address</th><th>Last active</th><th>Signed in</th><th></th></tr></thead><tbody>${sessions}</tbody></table></div></div>
    <div class="panel mt"><div class="panel-h"><h2>API tokens</h2><span class="sub">for the CLI, scripts and CI</span><div class="r"><button class="btn sm" data-act="token-new">${icon("plus")}New token</button></div></div>${tokens}</div>
  </div>`;
}

const SEG = (name: string, value: string, opts: [string, string][]) =>
  `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? "on" : ""}" data-act="sec-set" data-k="${name}" data-v="${v}">${esc(l)}</button>`).join("")}</div>`;

export function securityPage(): string {
  const s = state.security;
  if (!s) return skeleton;
  const opt = (vals: [number, string][], cur: number) =>
    vals
      .map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`)
      .join("");
  return `<div class="page">
    <div class="ph"><div><h1>Security</h1><p>Sign-in and session rules for everyone in ${esc(session.info?.org?.name ?? "your organisation")}</p></div></div>
    <div class="grid g-1-1">
      <div class="grid" style="align-content:start">
        <div class="panel"><div class="panel-h"><h2>Two-factor authentication</h2></div>
          <div class="panel-b form">
            ${SEG("mfa", s.mfa, [
              ["off", "Optional"],
              ["admins", "Required for admins"],
              ["all", "Required for everyone"],
            ])}
            <p class="hint-p">${s.mfa === "all" ? "Everyone must set up an authenticator app before they can use Bumpsmith." : s.mfa === "admins" ? "People who manage members, roles, access, security or integrations must use an authenticator app. Others may." : "People can turn on two-factor authentication from their account page."}</p>
          </div></div>
        <div class="panel"><div class="panel-h"><h2>Sessions</h2></div>
          <div class="panel-b form">
            <div class="field"><label for="sec-idle">Sign out after inactivity</label><select class="input" id="sec-idle">${opt(
              [
                [15, "15 minutes"],
                [30, "30 minutes"],
                [60, "1 hour"],
                [120, "2 hours"],
                [240, "4 hours"],
                [480, "8 hours"],
              ],
              s.idleMinutes,
            )}</select></div>
            <div class="field"><label for="sec-abs">Sign out after, at the latest</label><select class="input" id="sec-abs">${opt(
              [
                [4, "4 hours"],
                [8, "8 hours"],
                [12, "12 hours"],
                [24, "24 hours"],
                [72, "3 days"],
              ],
              s.absoluteHours,
            )}</select><div class="hint">Sessions that are already open follow the new rules on their next request.</div></div>
          </div></div>
        <div><button class="btn primary" data-act="sec-save">Save security settings</button></div>
      </div>
      <div class="panel" style="align-self:start"><div class="panel-h"><h2>Always on</h2><span class="sub">not configurable</span></div>
        <div class="panel-b"><dl class="kv wrap">
          <dt>Passwords</dt><dd>12–128 characters, checked against a breached-password list (NIST SP 800-63B)</dd>
          <dt>Storage</dt><dd>scrypt, per-password salt</dd>
          <dt>Lockout</dt><dd>after 5 failed sign-ins, growing delay</dd>
          <dt>Cookies</dt><dd>HttpOnly, SameSite=Strict, Secure over HTTPS</dd>
          <dt>Changes</dt><dd>CSRF token and same-origin check on every request</dd>
          <dt>Sensitive actions</dt><dd>confirm with password or MFA code (step-up)</dd>
          <dt>Secrets</dt><dd>AES-256-GCM at rest, never sent to the browser</dd>
          <dt>Audit</dt><dd>hash-chained, tamper-evident log of sign-ins and changes</dd>
        </dl></div></div>
    </div>
  </div>`;
}

/** Handle an account or security action; returns false for actions it does not own. */
export async function accountAction(act: string, t: HTMLElement): Promise<boolean> {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
  const run = async (fn: () => Promise<void>, ok?: string) => {
    try {
      await fn();
      if (ok) ctx.toast(ok);
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
    ctx.render();
  };
  switch (act) {
    case "profile-save":
      await run(async () => {
        await post("/api/me/profile", { name: val("p-name") });
        if (session.info) session.info.user.name = val("p-name").trim();
        await loadMe();
      }, "Profile saved");
      return true;
    case "pw-change":
      await run(async () => {
        await post("/api/me/password", { current: val("pw-cur"), next: val("pw-new") });
        await loadMe();
      }, "Password changed. Other sessions were signed out.");
      return true;
    case "mfa-setup": {
      await openDialog({
        title: "Set up two-factor authentication",
        body: `<div id="dlg-enroll"></div>`,
        wide: true,
        onOpen: async (el, close) => {
          const ok = await mountMfaEnrollment(el.querySelector("#dlg-enroll") as HTMLElement);
          close(ok);
        },
      });
      await run(loadMe);
      return true;
    }
    case "mfa-recovery": {
      const go = await confirmDialog(
        "New recovery codes",
        "Your current recovery codes will stop working.",
        "Create new codes",
      );
      if (!go) return true;
      try {
        const r = await post<{ recoveryCodes: string[] }>("/api/me/mfa/recovery");
        await openDialog({
          title: "Your new recovery codes",
          body: recoveryCodesHtml(r.recoveryCodes),
          primary: "Done",
          onOpen: (el) => {
            const btn = el.querySelector<HTMLButtonElement>(
              "button[type=submit]",
            ) as HTMLButtonElement;
            btn.disabled = true;
            wireRecoveryCodes(el, r.recoveryCodes, (ok) => {
              btn.disabled = !ok;
            });
          },
        });
      } catch (e) {
        ctx.toast((e as Error).message, true);
      }
      await run(loadMe);
      return true;
    }
    case "mfa-disable":
      if (
        !(await confirmDialog(
          "Turn off two-factor authentication?",
          "Your account will be protected by your password only.",
          "Turn off",
          true,
        ))
      )
        return true;
      await run(async () => {
        await post("/api/me/mfa/disable");
        if (session.info) session.info.user.mfa = false;
        await loadMe();
      }, "Two-factor authentication is off");
      return true;
    case "sess-revoke":
      await run(async () => {
        await post(`/api/me/sessions/${encodeURIComponent(t.dataset.id ?? "")}/revoke`);
        await loadMe();
      }, "Session signed out");
      return true;
    case "sess-revoke-others":
      await run(async () => {
        const r = await post<{ revoked: number }>("/api/me/sessions/revoke-others");
        await loadMe();
        ctx.toast(`Signed out ${r.revoked} other session${r.revoked === 1 ? "" : "s"}`);
      });
      return true;
    case "token-new": {
      // Tokens are for reading and automation; account, access and patch actions stay interactive.
      const perms = (state.me?.permissions ?? []).filter((p) => TOKEN_SCOPES.includes(p.id));
      const groups = [...new Set(perms.map((p) => p.group))];
      let created: string | null = null;
      await openDialog({
        title: "New API token",
        wide: true,
        body: `<div class="field"><label for="tk-name">Name</label><input class="input" id="tk-name" maxlength="60" placeholder="CI on main" /></div>
          <div class="field"><label for="tk-days">Expires after</label><select class="input" id="tk-days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></div>
          <div class="field"><label>Permissions</label><div class="hint" style="margin:0 0 8px">A token can only do what your role allows and what you tick here. Applying patches and changing accounts always need you, signed in.</div>
            ${groups
              .map(
                (g) =>
                  `<fieldset class="perm-g"><legend>${esc(g)}</legend>${perms
                    .filter((p) => p.group === g)
                    .map(
                      (p) =>
                        `<label class="check"><input type="checkbox" value="${esc(p.id)}" ${p.id === "runs.view" ? "checked" : ""} />${esc(p.label)}</label>`,
                    )
                    .join("")}</fieldset>`,
              )
              .join("")}</div>`,
        primary: "Create token",
        onSubmit: async (el) => {
          const scopes = [...el.querySelectorAll<HTMLInputElement>(".perm-g input:checked")].map(
            (x) => x.value,
          );
          const r = await post<{ token: string }>("/api/me/tokens", {
            name: (el.querySelector("#tk-name") as HTMLInputElement).value,
            days: Number((el.querySelector("#tk-days") as HTMLSelectElement).value),
            scopes,
          });
          created = r.token;
        },
      });
      if (created) {
        const tok: string = created;
        await openDialog({
          title: "Copy your token now",
          body: `<p class="dialog-p">This is the only time it is shown. Use it as <code class="ic">Authorization: Bearer …</code>.</p><div class="mfa-key"><code>${esc(tok)}</code><button type="button" class="btn icon ghost" data-copy-tok aria-label="Copy token">${icon("copy")}</button></div>`,
          primary: "Done",
          onOpen: (el) =>
            el
              .querySelector("[data-copy-tok]")
              ?.addEventListener("click", () => navigator.clipboard.writeText(tok).catch(() => {})),
        });
      }
      await run(loadMe);
      return true;
    }
    case "token-revoke":
      if (
        !(await confirmDialog(
          "Revoke this token?",
          "Anything using it will stop working at once.",
          "Revoke",
          true,
        ))
      )
        return true;
      await run(async () => {
        await post(`/api/me/tokens/${encodeURIComponent(t.dataset.id ?? "")}/revoke`);
        await loadMe();
      }, "Token revoked");
      return true;
    case "sec-set":
      if (state.security)
        (state.security as unknown as Record<string, string>)[t.dataset.k ?? ""] =
          t.dataset.v ?? "";
      ctx.render();
      return true;
    case "sec-save":
      await run(async () => {
        if (!state.security) return;
        state.security = await post<OrgSecurity>("/api/org/security", {
          mfa: state.security.mfa,
          idleMinutes: Number(val("sec-idle")),
          absoluteHours: Number(val("sec-abs")),
        });
      }, "Security settings saved");
      return true;
  }
  return false;
}
