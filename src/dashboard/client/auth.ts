// Sign-in, first-run owner setup and session handling for the dashboard. The server holds
// the session (an HttpOnly cookie the page cannot read); the page only keeps the CSRF token
// it must send with every change.
import { openDialog } from "./dialog.ts";
import { BRAND_WORDMARK, esc, icon } from "./ui.ts";

export interface SessionInfo {
  user: { id: string; name: string; email: string; mfa: boolean };
  org: { id: string; name: string } | null;
  role: { id: string; name: string };
  permissions: string[];
  csrf: string;
  /** The organisation requires MFA and this user has not set it up yet. */
  mustEnrollMfa?: boolean;
  /** How this session signed in: "password" or "sso". */
  method?: string;
}

interface SsoOptions {
  oidc: { label: string } | null;
  saml: { label: string } | null;
  enforce: boolean;
}
async function ssoOptions(): Promise<SsoOptions> {
  try {
    return (await (await fetch("/auth/sso")).json()) as SsoOptions;
  } catch {
    return { oidc: null, saml: null, enforce: false };
  }
}
const ssoButtons = (o: SsoOptions) =>
  [
    o.oidc
      ? `<a class="btn block sso" href="/auth/oidc/start">${icon("key")}Continue with ${esc(o.oidc.label)}</a>`
      : "",
    o.saml
      ? `<a class="btn block sso" href="/auth/saml/start">${icon("key")}Continue with ${esc(o.saml.label)}</a>`
      : "",
  ].join("");

/** POST with the CSRF token (used here so this module does not depend on net.ts). */
async function call<T>(path: string, data: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": session.info?.csrf ?? "" },
    body: JSON.stringify(data),
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export const session = { info: null as SessionInfo | null };
export const can = (p: string) => !!session.info?.permissions.includes(p);

export async function fetchSession(): Promise<{
  info: SessionInfo | null;
  setupRequired: boolean;
}> {
  const r = await fetch("/auth/session");
  const body = (await r.json().catch(() => ({}))) as SessionInfo & { setupRequired?: boolean };
  if (r.ok) {
    session.info = body;
    return { info: body, setupRequired: false };
  }
  session.info = null;
  return { info: null, setupRequired: !!body.setupRequired };
}

export async function signOut() {
  await fetch("/auth/logout", {
    method: "POST",
    headers: { "x-csrf-token": session.info?.csrf ?? "" },
  }).catch(() => {});
  session.info = null;
}

type Mode =
  | "signin"
  | "expired"
  | "setup"
  | "need-setup-link"
  | "mfa"
  | "invite"
  | "invite-invalid";

const pwField = (id: string, autocomplete: string) => `
  <div class="pw">
    <input class="input" id="${id}" name="password" type="password" autocomplete="${autocomplete}" required maxlength="128" spellcheck="false" />
    <button type="button" class="pw-eye" data-eye="${id}" aria-label="Show password" title="Show password">${icon("eye")}</button>
  </div>`;

function card(inner: string, foot = true) {
  return `<main class="auth"><div class="auth-card">
    <div class="auth-brand">${BRAND_WORDMARK}</div>
    ${inner}
  </div>${foot ? `<p class="auth-foot">${icon("lock")}<span>Sessions end after 30 minutes without activity. Every sign-in is recorded in the audit log.</span></p>` : ""}</main>`;
}

function page(
  mode: Mode,
  invite?: { email: string; org: string; sso?: boolean },
  sso?: SsoOptions,
  ssoError?: string,
): string {
  if (mode === "invite-invalid")
    return card(
      `<h1>This invitation no longer works</h1>
      <p class="auth-sub">Invitation links work once and expire after 72 hours. Ask the person who invited you for a new link.</p>
      <a class="btn block" href="#/">Go to sign in</a>`,
      false,
    );
  if (mode === "invite" && invite?.sso && sso)
    return card(`<h1>Join ${esc(invite.org)}</h1>
      <p class="auth-sub">You were invited as ${esc(invite.email)}. ${esc(invite.org)} signs in with single sign-on: continue with your company account.</p>
      <div class="sso-g">${ssoButtons(sso)}</div>`);
  if (mode === "invite" && invite)
    return card(`<h1>Join ${esc(invite.org)}</h1>
      <p class="auth-sub">You were invited to ${esc(invite.org)} on Bumpsmith. Choose your name and a password to finish.</p>
      <form class="auth-form" data-form="invite" novalidate>
        <div class="field"><label>Work email</label><div class="ro mono">${esc(invite.email)}</div><input type="hidden" name="email" value="${esc(invite.email)}" /></div>
        <div class="field"><label for="a-name">Your name</label><input class="input" id="a-name" name="name" autocomplete="name" required maxlength="80" /></div>
        <div class="field"><label for="a-pw">Password</label>${pwField("a-pw", "new-password")}
          <ul class="pw-rules" id="pw-rules">
            <li data-rule="len">${icon("check")}At least 12 characters</li>
            <li data-rule="own">${icon("check")}Not your name, email or organisation</li>
            <li data-rule="seq">${icon("check")}No repeats or sequences like 123456</li>
          </ul>
        </div>
        <div class="auth-err" role="alert" hidden></div>
        <button class="btn primary block" type="submit">Join ${esc(invite.org)}</button>
      </form>`);
  if (mode === "need-setup-link")
    return card(
      `<h1>Finish setting up Bumpsmith</h1>
      <p class="auth-sub">This server has no accounts yet. To create the owner account, open the one-time setup link printed in the terminal where Bumpsmith is running.</p>
      <pre class="auth-code">bumpsmith dashboard</pre>
      <p class="auth-sub small">The link works once and expires after an hour. Restart the server to get a new one.</p>`,
      false,
    );
  if (mode === "setup")
    return card(`<h1>Create the owner account</h1>
      <p class="auth-sub">You are setting up Bumpsmith for your organisation. The owner can invite people, create roles and connect GitHub.</p>
      <form class="auth-form" data-form="setup" novalidate>
        <div class="field"><label for="a-org">Organisation</label><input class="input" id="a-org" name="orgName" autocomplete="organization" required maxlength="80" placeholder="Acme Inc." /></div>
        <div class="field"><label for="a-name">Your name</label><input class="input" id="a-name" name="name" autocomplete="name" required maxlength="80" /></div>
        <div class="field"><label for="a-email">Work email</label><input class="input" id="a-email" name="email" type="email" autocomplete="username" required maxlength="254" /></div>
        <div class="field"><label for="a-pw">Password</label>${pwField("a-pw", "new-password")}
          <ul class="pw-rules" id="pw-rules">
            <li data-rule="len">${icon("check")}At least 12 characters</li>
            <li data-rule="own">${icon("check")}Not your name, email or organisation</li>
            <li data-rule="seq">${icon("check")}No repeats or sequences like 123456</li>
          </ul>
        </div>
        <div class="auth-err" role="alert" hidden></div>
        <button class="btn primary block" type="submit">Create account</button>
      </form>`);
  if (mode === "mfa")
    return card(`<h1>Two-factor authentication</h1>
      <p class="auth-sub" id="mfa-sub">Enter the 6-digit code from your authenticator app.</p>
      <form class="auth-form" data-form="mfa" novalidate>
        <div class="field"><label for="a-code" id="code-label">Authentication code</label><input class="input mono otp" id="a-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required spellcheck="false" placeholder="000000" /></div>
        <div class="auth-err" role="alert" hidden></div>
        <button class="btn primary block" type="submit">Verify</button>
        <button class="linkish" type="button" data-recovery>Use a recovery code instead</button>
      </form>`);
  const hasSso = !!(sso?.oidc || sso?.saml);
  const enforce = hasSso && sso?.enforce;
  return card(`<h1>${mode === "expired" ? "Your session ended" : "Sign in"}</h1>
    <p class="auth-sub">${mode === "expired" ? "For your security, sessions end after a period without activity. Sign in again to continue." : enforce ? "Your organisation signs in with single sign-on." : "Sign in to your Bumpsmith workspace."}</p>
    ${ssoError ? `<div class="auth-err" role="alert">${icon("alertCircle")}<span>${esc(ssoError)}</span></div>` : ""}
    ${hasSso && sso ? `<div class="sso-g">${ssoButtons(sso)}</div>${enforce ? `<details class="owner-pw"><summary>Owner? Sign in with a password</summary>` : `<div class="or"><span>or</span></div>`}` : ""}
    <form class="auth-form" data-form="login" novalidate>
      <div class="field"><label for="a-email">Work email</label><input class="input" id="a-email" name="email" type="email" autocomplete="username" required maxlength="254" /></div>
      <div class="field"><label for="a-pw">Password</label>${pwField("a-pw", "current-password")}</div>
      <div class="auth-err" role="alert" hidden></div>
      <button class="btn ${enforce ? "" : "primary"} block" type="submit">Sign in</button>
    </form>${enforce ? "</details>" : ""}`);
}

function rules(form: HTMLFormElement) {
  const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
  const pw = v("password");
  const lower = pw.toLowerCase();
  const own = [v("name"), v("email").split("@")[0] ?? "", v("orgName")]
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 4);
  const ok: Record<string, boolean> = {
    len: [...pw].length >= 12,
    own: pw.length > 0 && !own.some((x) => lower.includes(x)),
    seq:
      pw.length > 0 &&
      !/^(.)\1+$/.test(pw) &&
      !"abcdefghijklmnopqrstuvwxyz0123456789".includes(lower) &&
      !"0123456789876543210".includes(lower),
  };
  for (const li of form.querySelectorAll<HTMLElement>("[data-rule]"))
    li.classList.toggle("ok", !!ok[li.dataset.rule ?? ""]);
}

/** Render a sign-in or setup screen into `root`; resolves once the user is signed in. */
export async function showAuth(
  root: HTMLElement,
  mode: Mode,
  setupToken = "",
): Promise<SessionInfo> {
  let invite: { email: string; org: string; sso?: boolean } | undefined;
  if (mode === "invite") {
    const r = await fetch(`/auth/invite?token=${encodeURIComponent(setupToken)}`);
    if (r.ok) invite = (await r.json()) as { email: string; org: string; sso?: boolean };
    else mode = "invite-invalid";
  }
  const sso =
    mode === "signin" || mode === "expired" || mode === "invite" ? await ssoOptions() : undefined;
  // An identity-provider error comes back as ?sso_error=…; show it once, then drop it.
  const ssoError = new URLSearchParams(location.search).get("sso_error") ?? undefined;
  if (ssoError) history.replaceState(null, "", `/${location.hash}`);
  root.className = "shell auth-shell";
  root.innerHTML = page(mode, invite, sso, ssoError);
  document.title = mode === "setup" ? "Set up Bumpsmith" : "Sign in · Bumpsmith";
  const form = root.querySelector<HTMLFormElement>("form");
  (form?.querySelector<HTMLInputElement>("input") ?? null)?.focus();
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-eye]"))
    b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.eye ?? "") as HTMLInputElement | null;
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.innerHTML = icon(show ? "eyeOff" : "eye");
      b.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  if (form?.dataset.form === "setup" || form?.dataset.form === "invite")
    form.addEventListener("input", () => rules(form));
  if (mode === "invite-invalid")
    root.querySelector("a.btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      history.replaceState(null, "", "#/");
      void showAuth(root, "signin").then(() => location.reload());
    });
  root.querySelector("[data-recovery]")?.addEventListener("click", (e) => {
    const input = root.querySelector<HTMLInputElement>("#a-code");
    if (!input) return;
    const recovery = input.inputMode === "numeric";
    input.inputMode = recovery ? "text" : "numeric";
    input.maxLength = recovery ? 20 : 6;
    input.placeholder = recovery ? "xxxx-xxxx-xxxx" : "000000";
    input.value = "";
    input.focus();
    (root.querySelector("#code-label") as HTMLElement).textContent = recovery
      ? "Recovery code"
      : "Authentication code";
    (root.querySelector("#mfa-sub") as HTMLElement).textContent = recovery
      ? "Enter one of the recovery codes you saved when you set up two-factor authentication. Each works once."
      : "Enter the 6-digit code from your authenticator app.";
    (e.currentTarget as HTMLElement).textContent = recovery
      ? "Use your authenticator app instead"
      : "Use a recovery code instead";
  });
  return new Promise((done) => {
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = form.querySelector<HTMLElement>(".auth-err");
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (form.dataset.form === "setup" || form.dataset.form === "invite") data.token = setupToken;
      if (btn) {
        btn.disabled = true;
        btn.dataset.label = btn.textContent ?? "";
        btn.textContent =
          form.dataset.form === "login" || form.dataset.form === "mfa"
            ? "Signing in…"
            : "Creating account…";
      }
      try {
        const endpoint =
          { setup: "/auth/setup", login: "/auth/login", mfa: "/auth/mfa" }[
            form.dataset.form ?? "login"
          ] ?? "/auth/login";
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        const body = (await r.json().catch(() => ({}))) as SessionInfo & {
          error?: string;
          mfaRequired?: boolean;
        };
        if (r.status === 401 && form.dataset.form === "mfa") {
          // Too many wrong codes: the half-signed-in session is gone; start again.
          done(await showAuth(root, "signin"));
          return;
        }
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        if (body.mfaRequired) {
          done(await showAuth(root, "mfa"));
          return;
        }
        session.info = body;
        done(body);
      } catch (x) {
        if (err) {
          err.hidden = false;
          err.innerHTML = `${icon("alertCircle")}<span>${esc((x as Error).message)}</span>`;
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.dataset.label ?? "Continue";
        }
      }
    });
  });
}

// ── MFA enrolment (forced by policy, or from the account page) ──

const groupKey = (k: string) => k.replace(/(.{4})/g, "$1 ").trim();

export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Recovery codes, shown once, with copy, download and an "I saved them" gate. */
export function recoveryCodesHtml(codes: string[]) {
  return `<p class="dialog-p">Save these one-time recovery codes somewhere safe, like a password manager. Each code signs you in once if you lose your phone. They will not be shown again.</p>
    <div class="codes">${codes.map((c) => `<code>${esc(c)}</code>`).join("")}</div>
    <div class="codes-a"><button type="button" class="btn" data-copy-codes>${icon("copy")}Copy</button><button type="button" class="btn" data-dl-codes>${icon("download")}Download</button></div>
    <label class="check"><input type="checkbox" data-saved /> I saved these codes somewhere safe</label>`;
}

export function wireRecoveryCodes(
  el: HTMLElement,
  codes: string[],
  onSaved: (ok: boolean) => void,
) {
  const text = `Bumpsmith recovery codes for ${session.info?.user.email ?? ""}\n\n${codes.join("\n")}\n`;
  el.querySelector("[data-copy-codes]")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    const b = el.querySelector("[data-copy-codes]");
    if (b) b.innerHTML = `${icon("check")}Copied`;
  });
  el.querySelector("[data-dl-codes]")?.addEventListener("click", () =>
    download("bumpsmith-recovery-codes.txt", text),
  );
  el.querySelector<HTMLInputElement>("[data-saved]")?.addEventListener("change", (e) =>
    onSaved((e.target as HTMLInputElement).checked),
  );
}

/**
 * The two enrolment steps inside `el`: scan and verify, then save recovery codes.
 * Resolves true once MFA is on and the codes are saved.
 */
export async function mountMfaEnrollment(el: HTMLElement): Promise<boolean> {
  let start: { secret: string; qr: string };
  try {
    start = await call<{ secret: string; qr: string }>("/api/me/mfa/start");
  } catch (e) {
    el.innerHTML = `<div class="auth-err" role="alert">${icon("alertCircle")}<span>${esc((e as Error).message)}</span></div>`;
    return false;
  }
  return new Promise((resolve) => {
    el.innerHTML = `<div class="mfa">
      <div class="mfa-qr" aria-label="QR code for your authenticator app">${start.qr}</div>
      <div class="mfa-side">
        <p class="dialog-p">Scan the code with an authenticator app such as 1Password, Google Authenticator, Microsoft Authenticator or Authy.</p>
        <p class="dialog-p small">Can't scan it? Enter this key instead:</p>
        <div class="mfa-key"><code>${esc(groupKey(start.secret))}</code><button type="button" class="btn icon ghost" data-copy-key aria-label="Copy key" title="Copy key">${icon("copy")}</button></div>
      </div>
    </div>
    <div class="field"><label for="mfa-code">Enter the 6-digit code it shows</label><input class="input mono otp" id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" /></div>
    <div class="auth-err" role="alert" hidden></div>
    <button type="button" class="btn primary block" data-mfa-verify>Turn on two-factor authentication</button>`;
    el.querySelector("[data-copy-key]")?.addEventListener("click", () =>
      navigator.clipboard.writeText(start.secret).catch(() => {}),
    );
    const input = el.querySelector<HTMLInputElement>("#mfa-code");
    input?.focus();
    const verify = async () => {
      const err = el.querySelector<HTMLElement>(".auth-err") as HTMLElement;
      try {
        const r = await call<{ recoveryCodes: string[] }>("/api/me/mfa/confirm", {
          code: input?.value ?? "",
        });
        if (session.info) {
          session.info.user.mfa = true;
          session.info.mustEnrollMfa = false;
        }
        el.innerHTML = `${recoveryCodesHtml(r.recoveryCodes)}<button type="button" class="btn primary block" data-done disabled>Continue</button>`;
        const doneBtn = el.querySelector<HTMLButtonElement>("[data-done]") as HTMLButtonElement;
        wireRecoveryCodes(el, r.recoveryCodes, (ok) => {
          doneBtn.disabled = !ok;
        });
        doneBtn.addEventListener("click", () => resolve(true));
      } catch (e) {
        err.hidden = false;
        err.innerHTML = `${icon("alertCircle")}<span>${esc((e as Error).message)}</span>`;
      }
    };
    el.querySelector("[data-mfa-verify]")?.addEventListener("click", verify);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void verify();
      }
    });
  });
}

/** Full-page enrolment when the organisation requires MFA before anything else. */
export async function showEnroll(root: HTMLElement): Promise<void> {
  root.className = "shell auth-shell";
  root.innerHTML = card(`<h1>Set up two-factor authentication</h1>
    <p class="auth-sub">${esc(session.info?.org?.name ?? "Your organisation")} requires a second step at sign-in for your role. It takes a minute.</p>
    <div id="enroll"></div>
    <button class="linkish" type="button" data-signout>Sign out</button>`);
  document.title = "Two-factor authentication · Bumpsmith";
  root.querySelector("[data-signout]")?.addEventListener("click", async () => {
    await signOut();
    location.reload();
  });
  await mountMfaEnrollment(root.querySelector("#enroll") as HTMLElement);
}

/** "Confirm it's you" before a sensitive action: MFA code if enrolled, else password. */
export async function reauthDialog(): Promise<boolean> {
  const mfa = !!session.info?.user.mfa;
  if (session.info?.method === "sso" && !mfa) {
    // No Bumpsmith password or authenticator: confirm through the identity provider again.
    const o = await ssoOptions();
    await openDialog({
      title: "Confirm it's you",
      body: `<p class="dialog-p">This action changes something sensitive, so sign in again with your company account. You come back here afterwards; then repeat the action.</p><div class="sso-g">${ssoButtons(o)}</div>`,
    });
    return false;
  }
  return openDialog({
    title: "Confirm it's you",
    body: `<p class="dialog-p">This action changes something sensitive, so we check it's still you. You won't be asked again for 10 minutes.</p>
      ${mfa ? `<div class="field"><label for="re-code">Authentication code</label><input class="input mono otp" id="re-code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" placeholder="000000" /></div>` : `<div class="field"><label for="re-pw">Password</label><input class="input" id="re-pw" type="password" autocomplete="current-password" maxlength="128" /></div>`}`,
    primary: "Confirm",
    onSubmit: async (el) => {
      const v = (sel: string) => el.querySelector<HTMLInputElement>(sel)?.value ?? "";
      await call("/api/me/reauth", mfa ? { code: v("#re-code") } : { password: v("#re-pw") });
    },
  });
}
