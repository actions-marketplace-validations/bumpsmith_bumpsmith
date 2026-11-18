// Sign-in, first-run owner setup and session handling for the dashboard. The server holds
// the session (an HttpOnly cookie the page cannot read); the page only keeps the CSRF token
// it must send with every change.
import { BRAND_WORDMARK, esc, icon } from "./ui.ts";

export interface SessionInfo {
  user: { id: string; name: string; email: string; mfa: boolean };
  org: { id: string; name: string } | null;
  role: { id: string; name: string };
  permissions: string[];
  csrf: string;
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

type Mode = "signin" | "expired" | "setup" | "need-setup-link";

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

function page(mode: Mode): string {
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
  return card(`<h1>${mode === "expired" ? "Your session ended" : "Sign in"}</h1>
    <p class="auth-sub">${mode === "expired" ? "For your security, sessions end after a period without activity. Sign in again to continue." : "Sign in to your Bumpsmith workspace."}</p>
    <form class="auth-form" data-form="login" novalidate>
      <div class="field"><label for="a-email">Work email</label><input class="input" id="a-email" name="email" type="email" autocomplete="username" required maxlength="254" /></div>
      <div class="field"><label for="a-pw">Password</label>${pwField("a-pw", "current-password")}</div>
      <div class="auth-err" role="alert" hidden></div>
      <button class="btn primary block" type="submit">Sign in</button>
    </form>`);
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
export function showAuth(root: HTMLElement, mode: Mode, setupToken = ""): Promise<SessionInfo> {
  root.className = "shell auth-shell";
  root.innerHTML = page(mode);
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
  if (form?.dataset.form === "setup") form.addEventListener("input", () => rules(form));
  return new Promise((done) => {
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = form.querySelector<HTMLElement>(".auth-err");
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (form.dataset.form === "setup") data.token = setupToken;
      if (btn) {
        btn.disabled = true;
        btn.dataset.label = btn.textContent ?? "";
        btn.textContent = form.dataset.form === "setup" ? "Creating account…" : "Signing in…";
      }
      try {
        const r = await fetch(form.dataset.form === "setup" ? "/auth/setup" : "/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        const body = (await r.json().catch(() => ({}))) as SessionInfo & { error?: string };
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
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
