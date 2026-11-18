// Integrations (GitHub and model keys), the onboarding guide, and adding repositories from
// GitHub. Same panels, tables, badges, fields and dialogs as the rest of the dashboard.
import { can, session } from "./auth.ts";
import { confirmDialog, openDialog } from "./dialog.ts";
import { api, post } from "./net.ts";
import { agoLong, esc, icon } from "./ui.ts";

export interface IntegrationState {
  github: {
    app: { name: string; slug: string; owner: string; html_url: string } | null;
    installations: { id: number; account: string; type: string; selection: string }[];
    installUrl: string | null;
    token: { last4: string; updated_at: string; login: string | null } | null;
    error: string | null;
  };
  models: {
    id: string;
    label: string;
    hint: string;
    last4: string | null;
    updated_at: string | null;
  }[];
  detected: { id: string; label: string; ok: boolean; detail: string }[];
  defaultProvider: string;
  docker: string | null;
}
interface Onboarding {
  done: boolean;
  steps: Record<
    "account" | "mfa" | "github" | "model" | "sandbox" | "repository" | "team",
    boolean
  >;
}

export const integ = {
  state: null as IntegrationState | null,
  onboarding: null as Onboarding | null,
  step: "",
};
let ctx = {
  render: () => {},
  toast: (_m: string, _bad?: boolean) => {},
  /** Reload the repository list and open one. */
  openWorkspace: async (_slug: string) => {},
  workspaces: () => [] as { slug: string; name: string; kind: string }[],
};
export const setupIntegrations = (c: typeof ctx) => {
  ctx = c;
};

export async function loadIntegrations() {
  const [s, o] = await Promise.all([
    can("integrations.manage") ? api<IntegrationState>("/api/integrations") : Promise.resolve(null),
    api<Onboarding>("/api/onboarding"),
  ]);
  integ.state = s;
  integ.onboarding = o;
}

const skeleton = `<div class="page"><div class="skel" style="height:28px;width:240px;margin-bottom:24px"></div><div class="skel" style="height:360px"></div></div>`;

// ── building blocks shared by the Integrations page and the onboarding guide ──

function githubCard(s: IntegrationState): string {
  const g = s.github;
  const status = g.app
    ? `<span class="badge ok"><span class="dot ok"></span>GitHub App</span>`
    : g.token
      ? `<span class="badge ok"><span class="dot ok"></span>token</span>`
      : `<span class="badge">not connected</span>`;
  let bodyHtml: string;
  if (g.app) {
    bodyHtml = `<dl class="kv wrap"><dt>App</dt><dd><a class="lnk" href="${esc(g.app.html_url)}" target="_blank" rel="noopener noreferrer">${esc(g.app.name)} ${icon("arrowR")}</a></dd>
        <dt>Owner</dt><dd class="mono">${esc(g.app.owner)}</dd>
        <dt>Installed on</dt><dd>${g.installations.length ? g.installations.map((i) => `<span class="perm-chip">${esc(i.account)} · ${i.selection === "all" ? "all repositories" : "selected"}</span>`).join("") : `<span class="warn-t">not installed yet</span>`}</dd>
        <dt>Permissions</dt><dd>contents and pull requests (write), checks, statuses and metadata (read). No workflows, secrets or admin.</dd></dl>
      ${g.error ? `<p class="hint-p bad-t">${esc(g.error)}</p>` : ""}
      <div class="row-a">${g.installUrl ? `<a class="btn ${g.installations.length ? "" : "primary"}" href="${esc(g.installUrl)}">${icon("plus")}${g.installations.length ? "Install on more repositories" : "Install on your repositories"}</a>` : ""}<button class="btn" data-act="gh-app-remove">Disconnect</button></div>`;
  } else if (g.token) {
    bodyHtml = `<dl class="kv"><dt>Connected as</dt><dd class="mono">${esc(g.token.login ?? "unknown")}</dd><dt>Token</dt><dd class="mono">…${esc(g.token.last4)} · saved ${esc(agoLong(g.token.updated_at))}</dd></dl>
      <p class="hint-p">A personal token works, but it belongs to one person and does not expire on its own. A GitHub App is safer for a team: short-lived tokens per job, scoped to each repository.</p>
      <div class="row-a"><button class="btn primary" data-act="gh-app">${icon("shield")}Switch to a GitHub App</button><button class="btn" data-act="gh-token-remove">Remove token</button></div>`;
  } else {
    bodyHtml = `<div class="choice">
        <button class="choice-i rec" data-act="gh-app"><span class="choice-h">${icon("shield")}<b>Create a GitHub App</b><span class="badge accent">recommended</span></span>
          <span class="muted">One click creates your organisation's own app with the narrow permissions Bumpsmith needs. Each job gets a token that lasts an hour and covers one repository.</span></button>
        <button class="choice-i" data-act="gh-token"><span class="choice-h">${icon("key")}<b>Use a personal access token</b></span>
          <span class="muted">Paste a fine-grained token with Contents and Pull requests (read and write). Quickest for trying Bumpsmith alone.</span></button>
      </div>`;
  }
  return `<div class="panel"><div class="panel-h"><h2>GitHub</h2><span class="sub">read repositories and open pull requests</span><div class="r">${status}</div></div><div class="panel-b">${bodyHtml}</div></div>`;
}

function modelsCard(s: IntegrationState): string {
  const usable = [
    ...s.detected.filter((d) => d.ok).map((d) => ({ id: d.id, label: d.label })),
    ...s.models.filter((m) => m.last4).map((m) => ({ id: m.id, label: m.label })),
  ];
  const rows = [
    ...s.detected.map(
      (
        d,
      ) => `<tr style="cursor:default"><td><b>${esc(d.label)}</b><div class="faint" style="font-size:12px">${esc(d.detail)} on this machine</div></td>
      <td>${d.ok ? `<span class="st ok">${icon("checkCircle")}detected</span>` : `<span class="muted">not installed</span>`}</td><td class="r"></td></tr>`,
    ),
    ...s.models.map(
      (
        m,
      ) => `<tr style="cursor:default"><td><b>${esc(m.label)}</b><div class="faint" style="font-size:12px">API key</div></td>
      <td>${m.last4 ? `<span class="st ok">${icon("checkCircle")}<span class="mono">…${esc(m.last4)}</span></span>` : `<span class="muted">no key</span>`}</td>
      <td class="r"><div class="acts">${m.last4 ? `<button class="btn sm" data-act="key-set" data-id="${esc(m.id)}">Replace</button><button class="btn sm" data-act="key-remove" data-id="${esc(m.id)}">Remove</button>` : `<button class="btn sm" data-act="key-set" data-id="${esc(m.id)}">${icon("plus")}Add key</button>`}</div></td></tr>`,
    ),
  ].join("");
  return `<div class="panel"><div class="panel-h"><h2>AI models</h2><span class="sub">what fixes the code; keys are encrypted and only given to upgrade runs</span>
      ${usable.length ? `<div class="r"><label class="inline-l" for="def-model">Default</label><select class="input sm" id="def-model" data-act-change="default-model">${usable.map((u) => `<option value="${esc(u.id)}" ${u.id === s.defaultProvider ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></div>` : ""}</div>
    <div class="tw"><table class="t"><tbody>${rows}</tbody></table></div></div>`;
}

function sandboxCard(s: IntegrationState): string {
  return `<div class="panel"><div class="panel-h"><h2>Sandbox</h2><span class="sub">where installs, builds and tests run</span><div class="r">${s.docker ? `<span class="badge ok"><span class="dot ok"></span>Docker ${esc(s.docker)}</span>` : `<span class="badge bad">Docker not running</span>`}</div></div>
    <div class="panel-b">${s.docker ? `<p class="hint-p">Each upgrade runs in a fresh container with no credentials and no network except a read-only registry mirror.</p>` : `<p class="hint-p">Start Docker Desktop, OrbStack or the Docker service on this server, then check again. Bumpsmith builds its sandbox images the first time an upgrade runs.</p><div class="row-a"><button class="btn" data-act="integ-reload">${icon("refresh")}Check again</button></div>`}</div></div>`;
}

export function integrationsPage(): string {
  const s = integ.state;
  if (!s) return skeleton;
  return `<div class="page">
    <div class="ph"><div><h1>Integrations</h1><p>GitHub, AI models and the sandbox for ${esc(session.info?.org?.name ?? "your organisation")}</p></div>
      <div class="act"><a class="btn" href="#/onboarding">${icon("list")}Setup guide</a></div></div>
    <div class="grid" style="gap:16px">${githubCard(s)}${modelsCard(s)}${sandboxCard(s)}</div>
  </div>`;
}

// ── onboarding ──

const STEPS: { id: keyof Onboarding["steps"]; title: string; sub: string }[] = [
  { id: "account", title: "Owner account", sub: "Created" },
  { id: "mfa", title: "Two-factor authentication", sub: "Protect the owner account" },
  { id: "github", title: "Connect GitHub", sub: "Repositories and pull requests" },
  { id: "model", title: "Choose an AI model", sub: "Your subscription or an API key" },
  { id: "sandbox", title: "Check the sandbox", sub: "Docker on this machine" },
  { id: "repository", title: "Add repositories", sub: "Where Bumpsmith works" },
  { id: "team", title: "Invite your team", sub: "Optional" },
];

export function onboardingPage(): string {
  const o = integ.onboarding;
  const s = integ.state;
  if (!o || (can("integrations.manage") && !s)) return skeleton;
  const first = STEPS.find((x) => !o.steps[x.id])?.id ?? "team";
  const cur = (
    STEPS.some((x) => x.id === integ.step) ? integ.step : first
  ) as keyof Onboarding["steps"];
  const done = STEPS.filter((x) => o.steps[x.id]).length;
  const rail = STEPS.map(
    (
      x,
      i,
    ) => `<button class="ob-s ${x.id === cur ? "on" : ""} ${o.steps[x.id] ? "done" : ""}" data-act="ob-step" data-v="${x.id}">
      <span class="ob-n">${o.steps[x.id] ? icon("check") : i + 1}</span><span class="ob-t"><b>${esc(x.title)}</b><span>${esc(o.steps[x.id] && x.id !== "account" ? "Done" : x.sub)}</span></span></button>`,
  ).join("");
  const wsList = ctx.workspaces();
  const content: Record<string, string> = {
    account: `<h2>Your owner account is ready</h2><p class="hint-p">You signed in as ${esc(session.info?.user.email ?? "")}. Owners can do everything, so keep this account for administration.</p>`,
    mfa: `<h2>Turn on two-factor authentication</h2><p class="hint-p">An authenticator app adds a second step at sign-in. Your organisation requires it for admins.</p>
      ${o.steps.mfa ? `<p class="ok-line">${icon("checkCircle")}Two-factor authentication is on.</p>` : `<div class="row-a"><button class="btn primary" data-act="mfa-setup">${icon("shield")}Set up two-factor authentication</button></div>`}`,
    github: s ? githubCard(s) : "",
    model: s ? modelsCard(s) : "",
    sandbox: s ? sandboxCard(s) : "",
    repository: `<h2>Repositories</h2><p class="hint-p">Bumpsmith upgrades dependencies in these repositories. Add more from GitHub or from this machine.</p>
      <div class="ob-repos">${wsList.map((w) => `<div class="ob-repo">${icon("folder")}<b>${esc(w.name)}</b><span class="badge">${esc(w.kind === "github" ? "GitHub" : "local")}</span></div>`).join("")}</div>
      <div class="row-a"><button class="btn primary" data-act="ws-add">${icon("plus")}Add repository</button></div>`,
    team: `<h2>Invite your team</h2><p class="hint-p">Invite people with a role. They get a one-time link to set their own password. You can also grant access per repository later.</p>
      <div class="row-a"><a class="btn primary" href="#/org/members">${icon("users")}Go to Members</a></div>`,
  };
  const idx = STEPS.findIndex((x) => x.id === cur);
  const next = STEPS[idx + 1];
  return `<div class="page">
    <div class="ph"><div><h1>Set up Bumpsmith</h1><p>${done} of ${STEPS.length} done · you can change any of this later in Integrations</p></div>
      <div class="act">${o.done ? "" : `<button class="btn" data-act="ob-finish">Skip for now</button>`}</div></div>
    <div class="ob">
      <nav class="panel ob-rail">${rail}</nav>
      <div class="ob-body">${content[cur] ?? ""}
        <div class="ob-f">${idx > 0 ? `<button class="btn" data-act="ob-step" data-v="${STEPS[idx - 1]?.id}">${icon("arrowL")}Back</button>` : ""}<div class="grow"></div>
          ${next ? `<button class="btn ${o.steps[cur] ? "primary" : ""}" data-act="ob-step" data-v="${next.id}">${o.steps[cur] ? "Continue" : "Skip this step"}${icon("arrowR")}</button>` : `<button class="btn primary" data-act="ob-finish">${icon("check")}Finish setup</button>`}</div>
      </div>
    </div>
  </div>`;
}

// ── actions ──

export async function integrationsAction(act: string, t: HTMLElement): Promise<boolean> {
  const reload = async (msg?: string) => {
    try {
      await loadIntegrations();
      if (msg) ctx.toast(msg);
    } catch (e) {
      ctx.toast((e as Error).message, true);
    }
    ctx.render();
  };
  switch (act) {
    case "integ-reload":
      await reload();
      return true;
    case "ob-step":
      integ.step = t.dataset.v ?? "";
      ctx.render();
      window.scrollTo({ top: 0 });
      return true;
    case "ob-finish":
      try {
        await post("/api/onboarding/done");
      } catch {}
      location.hash = "#/";
      return true;
    case "key-set": {
      const m = integ.state?.models.find((x) => x.id === t.dataset.id);
      if (!m) return true;
      const ok = await openDialog({
        title: `${m.last4 ? "Replace" : "Add"} ${m.label} key`,
        body: `<p class="dialog-p">The key is checked with ${esc(m.label)}, then stored encrypted. Only upgrade runs receive it; it is never shown again.</p>
          <div class="field"><label for="key-v">API key</label><input class="input mono" id="key-v" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(m.hint)}" /></div>`,
        primary: "Check and save",
        onSubmit: async (el) => {
          await post("/api/integrations/keys", {
            provider: m.id,
            key: (el.querySelector("#key-v") as HTMLInputElement).value,
          });
        },
      });
      if (ok) await reload(`${m.label} key saved`);
      return true;
    }
    case "key-remove": {
      const m = integ.state?.models.find((x) => x.id === t.dataset.id);
      if (
        !m ||
        !(await confirmDialog(
          `Remove the ${m.label} key?`,
          "Upgrades that use this provider will stop working until a key is added again.",
          "Remove key",
          true,
        ))
      )
        return true;
      try {
        await post(`/api/integrations/keys/${encodeURIComponent(m.id)}/remove`);
      } catch (e) {
        ctx.toast((e as Error).message, true);
      }
      await reload("Key removed");
      return true;
    }
    case "gh-token": {
      const ok = await openDialog({
        title: "Connect with a personal access token",
        body: `<p class="dialog-p">Create a <a class="lnk" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> with access to the repositories Bumpsmith should work on, and these permissions: <b>Contents</b> and <b>Pull requests</b> read and write.</p>
          <div class="field"><label for="gh-tok">Token</label><input class="input mono" id="gh-tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" /></div>`,
        primary: "Check and save",
        onSubmit: async (el) => {
          await post("/api/integrations/github/token", {
            token: (el.querySelector("#gh-tok") as HTMLInputElement).value,
          });
        },
      });
      if (ok) await reload("GitHub connected");
      return true;
    }
    case "gh-app": {
      let target: { action: string; manifest: unknown } | null = null;
      await openDialog({
        title: "Create your GitHub App",
        body: `<p class="dialog-p">GitHub will ask you to confirm the new app, then to choose the repositories it can access. You come back here afterwards.</p>
          <div class="field"><label for="app-name">App name</label><input class="input" id="app-name" maxlength="34" value="${esc(`Bumpsmith ${session.info?.org?.name ?? ""}`.trim().slice(0, 34))}" /><div class="hint">Must be unique on GitHub.</div></div>
          <div class="field"><label for="app-owner">GitHub organisation (optional)</label><input class="input mono" id="app-owner" maxlength="39" placeholder="acme" spellcheck="false" /><div class="hint">Leave empty to create it under your personal account.</div></div>`,
        primary: "Continue to GitHub",
        onSubmit: async (el) => {
          target = await post("/api/integrations/github/app", {
            name: (el.querySelector("#app-name") as HTMLInputElement).value,
            owner: (el.querySelector("#app-owner") as HTMLInputElement).value,
          });
        },
      });
      const tg = target as { action: string; manifest: unknown } | null;
      if (tg) {
        // GitHub's manifest flow takes a form POST; the page's CSP allows exactly github.com.
        const form = document.createElement("form");
        form.method = "post";
        form.action = tg.action;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "manifest";
        input.value = JSON.stringify(tg.manifest);
        form.append(input);
        document.body.append(form);
        form.submit();
      }
      return true;
    }
    case "gh-app-remove":
    case "gh-token-remove": {
      const app = act === "gh-app-remove";
      if (
        !(await confirmDialog(
          app ? "Disconnect the GitHub App?" : "Remove the GitHub token?",
          app
            ? "Bumpsmith forgets the app's credentials. Delete or uninstall the app on GitHub too."
            : "Bumpsmith can no longer reach private repositories or open pull requests.",
          app ? "Disconnect" : "Remove",
          true,
        ))
      )
        return true;
      try {
        await post(`/api/integrations/github/${app ? "app" : "token"}/remove`);
      } catch (e) {
        ctx.toast((e as Error).message, true);
      }
      await reload(app ? "GitHub App disconnected" : "Token removed");
      return true;
    }
  }
  return false;
}

export async function integrationsChange(act: string, el: HTMLSelectElement): Promise<boolean> {
  if (act !== "default-model") return false;
  try {
    await post("/api/integrations/default", { provider: el.value });
    await loadIntegrations();
    ctx.toast("Default model changed");
  } catch (e) {
    ctx.toast((e as Error).message, true);
  }
  ctx.render();
  return true;
}

/** "Add repository": from GitHub (cloned) or, on this machine, a local folder. */
export async function addRepositoryDialog(localAllowed: boolean): Promise<string | null> {
  let slug = "";
  type Repo = { full_name: string; private: boolean; description: string | null; added: boolean };
  let repos: Repo[] | null = null;
  let error = "";
  try {
    repos = (await api<{ repos: Repo[] }>("/api/integrations/github/repos")).repos;
  } catch (e) {
    error = (e as Error).message;
  }
  const ghBody = repos?.length
    ? `<label class="ws-q">${icon("search")}<input id="gh-q" placeholder="Find a repository" autocomplete="off" spellcheck="false" /></label>
       <div class="gh-list">${repos
         .map(
           (
             r,
           ) => `<label class="gh-r ${r.added ? "added" : ""}" data-name="${esc(r.full_name.toLowerCase())}"><input type="radio" name="gh-repo" value="${esc(r.full_name)}" ${r.added ? "disabled" : ""} />
            <span class="ws-t"><b>${esc(r.full_name)}</b><span>${r.added ? "already added" : esc(r.description ?? (r.private ? "private" : "public"))}</span></span>${r.private ? `<span class="badge">private</span>` : ""}</label>`,
         )
         .join("")}</div>`
    : `<p class="dialog-p">${error ? esc(error) : "No GitHub repositories yet."} <a class="lnk" href="#/org/integrations">Connect GitHub</a> or install the app on more repositories.</p>`;
  await openDialog({
    title: "Add a repository",
    wide: true,
    body: `${localAllowed ? `<div class="seg" role="tablist"><button type="button" class="on" data-tab="gh">From GitHub</button><button type="button" data-tab="local">Folder on this machine</button></div>` : ""}
      <div data-pane="gh" class="pane">${ghBody}</div>
      ${localAllowed ? `<div data-pane="local" class="pane" hidden><div class="field"><label for="ws-path">Folder</label><input class="input mono" id="ws-path" placeholder="/Users/you/code/my-app" spellcheck="false" autocomplete="off" /><div class="hint">A git repository on the machine running Bumpsmith.</div></div></div>` : ""}`,
    primary: "Add repository",
    onOpen: (el) => {
      for (const b of el.querySelectorAll<HTMLButtonElement>("[data-tab]"))
        b.addEventListener("click", () => {
          for (const x of el.querySelectorAll("[data-tab]")) x.classList.toggle("on", x === b);
          for (const p of el.querySelectorAll<HTMLElement>("[data-pane]"))
            p.hidden = p.dataset.pane !== b.dataset.tab;
        });
      el.querySelector<HTMLInputElement>("#gh-q")?.addEventListener("input", (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        for (const r of el.querySelectorAll<HTMLElement>(".gh-r"))
          r.hidden = !(r.dataset.name ?? "").includes(q);
      });
    },
    onSubmit: async (el) => {
      const local = !(el.querySelector<HTMLElement>('[data-pane="local"]')?.hidden ?? true);
      if (local) {
        slug = (
          await post<{ slug: string }>("/api/workspaces", {
            path: (el.querySelector("#ws-path") as HTMLInputElement).value,
          })
        ).slug;
        return;
      }
      const pick = el.querySelector<HTMLInputElement>('input[name="gh-repo"]:checked')?.value;
      if (!pick) return "Pick a repository.";
      const btn = el.querySelector<HTMLButtonElement>("button[type=submit]");
      if (btn) btn.textContent = "Cloning…";
      slug = (await post<{ slug: string }>("/api/workspaces/github", { repo: pick })).slug;
    },
  });
  return slug || null;
}
