import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { type Context, Hono } from "hono";

/**
 * A stateful in-process fake of the GitHub REST endpoints Bumpsmith uses. It enforces token
 * scope (repository + permission) like GitHub, keeps real-ish git objects, and refuses
 * changes to .github/workflows from tokens without the workflows permission.
 */

type Perm = "read" | "write";
interface Token {
  installationId: number;
  repositoryIds: number[] | null;
  permissions: Record<string, Perm>;
}
interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}
interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  verified: boolean;
  author: string;
}
interface PR {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged_at: string | null;
  draft: boolean;
  user: string;
  labels: string[];
  requested_reviewers: string[];
  created_at: string;
  head_sha?: string;
  files?: string[];
}
export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  refs: Map<string, string>;
  pulls: PR[];
  comments: { issue: number; body: string; user: string }[];
  checkRuns: {
    head_sha: string;
    name: string;
    conclusion: string | null;
    status: string;
    output?: unknown;
    app?: boolean;
  }[];
  collaborators: Map<string, "admin" | "write" | "read" | "none">;
  rules: Record<string, unknown[]>;
  /** Paths whose content triggers push protection (409). */
  secretPatterns: RegExp[];
}

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, Commit>();
  readonly repos = new Map<number, FakeRepo>();
  readonly tokens = new Map<string, Token>();
  readonly installations = new Map<
    number,
    { permissions: Record<string, Perm>; repositoryIds: number[] }
  >();
  readonly requests: { method: string; path: string; token: string | null }[] = [];
  readonly users = new Map<
    string,
    {
      id: number;
      login: string;
      installations: {
        id: number;
        account: string;
        type: "Organization" | "User";
        orgRole?: "admin" | "member";
      }[];
    }
  >();
  private server: ServerType | null = null;
  url = "";
  private nextId = 1000;
  private nextNumber = 100;

  // ------------------------------------------------------------------ git helpers

  blob(content: string | Buffer): string {
    const b = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));
    this.blobs.set(sha, b);
    return sha;
  }

  /** Build nested trees from a flat path -> {sha, mode} map; returns the root tree sha. */
  buildTree(flat: Map<string, { sha: string; mode: string }>): string {
    const files: TreeEntry[] = [];
    const sub = new Map<string, Map<string, { sha: string; mode: string }>>();
    for (const [path, e] of flat) {
      const i = path.indexOf("/");
      if (i < 0) files.push({ path, mode: e.mode, type: "blob", sha: e.sha });
      else {
        const dir = path.slice(0, i);
        const m = sub.get(dir) ?? new Map();
        m.set(path.slice(i + 1), e);
        sub.set(dir, m);
      }
    }
    const entries = [...files];
    for (const [dir, m] of sub)
      entries.push({ path: dir, mode: "040000", type: "tree", sha: this.buildTree(m) });
    entries.sort((x, y) => x.path.localeCompare(y.path));
    const sha = sha1(`tree:${JSON.stringify(entries)}`);
    this.trees.set(sha, entries);
    return sha;
  }

  flatten(treeSha: string, prefix = ""): Map<string, { sha: string; mode: string }> {
    const out = new Map<string, { sha: string; mode: string }>();
    for (const e of this.trees.get(treeSha) ?? []) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === "tree") for (const [k, v] of this.flatten(e.sha, p)) out.set(k, v);
      else out.set(p, { sha: e.sha, mode: e.mode });
    }
    return out;
  }

  commit(
    tree: string,
    parents: string[],
    message: string,
    author = "human",
    verified = false,
  ): string {
    const sha = sha1(
      `commit:${tree}:${parents.join(",")}:${message}:${randomBytes(4).toString("hex")}`,
    );
    this.commits.set(sha, { sha, tree, parents, message, verified, author });
    return sha;
  }

  fileAt(commitSha: string, path: string): string | null {
    const c = this.commits.get(commitSha);
    if (!c) return null;
    const e = this.flatten(c.tree).get(path);
    return e ? (this.blobs.get(e.sha)?.toString("utf8") ?? null) : null;
  }

  /** Create a repository with files on its default branch; returns the head commit. */
  addRepo(opts: {
    id: number;
    owner: string;
    name: string;
    files: Record<string, string>;
    installationId: number;
  }): { repo: FakeRepo; head: string } {
    const flat = new Map(
      Object.entries(opts.files).map(([p, c]) => [
        p,
        { sha: this.blob(c), mode: p.endsWith(".sh") ? "100755" : "100644" },
      ]),
    );
    const head = this.commit(this.buildTree(flat), [], "initial");
    const repo: FakeRepo = {
      id: opts.id,
      owner: opts.owner,
      name: opts.name,
      defaultBranch: "main",
      private: true,
      refs: new Map([["heads/main", head]]),
      pulls: [],
      comments: [],
      checkRuns: [],
      collaborators: new Map(),
      rules: {},
      secretPatterns: [/AKIA[A-Z0-9]{16}/],
    };
    this.repos.set(opts.id, repo);
    const inst = this.installations.get(opts.installationId) ?? {
      permissions: { contents: "write", pull_requests: "write", metadata: "read", checks: "write" },
      repositoryIds: [],
    };
    inst.repositoryIds.push(opts.id);
    this.installations.set(opts.installationId, inst);
    return { repo, head };
  }

  issueToken(t: Token): string {
    const token = `ghs_fake${randomBytes(24).toString("hex")}`;
    this.tokens.set(token, t);
    return token;
  }

  /** A bot (Dependabot) opens a PR with a bumped package.json and red checks. */
  botPr(
    repo: FakeRepo,
    opts: {
      title: string;
      user: string;
      branch: string;
      files: Record<string, string>;
      red: boolean;
    },
  ): number {
    const head = repo.refs.get(`heads/${repo.defaultBranch}`) as string;
    const flat = this.flatten((this.commits.get(head) as Commit).tree);
    for (const [p, c] of Object.entries(opts.files))
      flat.set(p, { sha: this.blob(c), mode: "100644" });
    const c = this.commit(this.buildTree(flat), [head], opts.title, opts.user);
    repo.refs.set(`heads/${opts.branch}`, c);
    const pr: PR = {
      id: this.nextId++,
      number: this.nextNumber++,
      title: opts.title,
      body: "",
      head: opts.branch,
      base: repo.defaultBranch,
      state: "open",
      merged_at: null,
      draft: false,
      user: opts.user,
      labels: [],
      requested_reviewers: [],
      created_at: new Date().toISOString(),
      files: Object.keys(opts.files),
    };
    repo.pulls.push(pr);
    repo.checkRuns.push({
      head_sha: c,
      name: "ci",
      status: "completed",
      conclusion: opts.red ? "failure" : "success",
    });
    return pr.number;
  }

  /** A human pushes a commit to a branch. */
  humanPush(repo: FakeRepo, branch: string, path: string, content: string): string {
    const head = repo.refs.get(`heads/${branch}`) as string;
    const flat = this.flatten((this.commits.get(head) as Commit).tree);
    flat.set(path, { sha: this.blob(content), mode: "100644" });
    const c = this.commit(this.buildTree(flat), [head], "human edit", "human");
    repo.refs.set(`heads/${branch}`, c);
    return c;
  }

  // ------------------------------------------------------------------ server

  private repoFor(c: Context, need: Record<string, Perm>): FakeRepo | Response {
    const owner = c.req.param("owner");
    const name = c.req.param("repo");
    const repo = [...this.repos.values()].find((r) => r.owner === owner && r.name === name);
    if (!repo) return c.json({ message: "Not Found" }, 404);
    const auth = c.req.header("authorization") ?? "";
    const tok = this.tokens.get(auth.replace(/^(token|bearer)\s+/i, ""));
    if (!tok) return c.json({ message: "Bad credentials" }, 401);
    if (tok.repositoryIds && !tok.repositoryIds.includes(repo.id))
      return c.json({ message: "Not Found" }, 404);
    for (const [perm, level] of Object.entries(need)) {
      const have = tok.permissions[perm];
      if (!have || (level === "write" && have !== "write"))
        return c.json({ message: "Resource not accessible by integration" }, 403);
    }
    return repo;
  }

  app(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      this.requests.push({
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        token: auth ? (auth.split(" ")[1] ?? null) : null,
      });
      await next();
    });
    const R = "/repos/:owner/:repo";

    app.post("/app/installations/:id/access_tokens", async (c) => {
      const id = Number(c.req.param("id"));
      const inst = this.installations.get(id);
      if (!inst) return c.json({ message: "Not Found" }, 404);
      const body = (await c.req.json()) as {
        repository_ids?: number[];
        permissions?: Record<string, Perm>;
      };
      for (const [k, v] of Object.entries(body.permissions ?? {}))
        if (!inst.permissions[k] || (v === "write" && inst.permissions[k] !== "write"))
          return c.json({ message: `permission ${k} not granted` }, 422);
      const token = this.issueToken({
        installationId: id,
        repositoryIds: body.repository_ids ?? null,
        permissions: body.permissions ?? inst.permissions,
      });
      return c.json(
        {
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: body.permissions ?? inst.permissions,
        },
        201,
      );
    });

    app.get(R, (c) => {
      const r = this.repoFor(c, { metadata: "read" });
      if (r instanceof Response) return r;
      return c.json({
        id: r.id,
        full_name: `${r.owner}/${r.name}`,
        default_branch: r.defaultBranch,
        private: r.private,
        archived: false,
      });
    });
    app.get(`${R}/branches/:branch`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const sha = r.refs.get(`heads/${c.req.param("branch")}`);
      return sha
        ? c.json({ name: c.req.param("branch"), commit: { sha } })
        : c.json({ message: "Not Found" }, 404);
    });
    app.get(`${R}/contents/*`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const path = decodeURIComponent(new URL(c.req.url).pathname.split("/contents/")[1] ?? "");
      const ref = c.req.query("ref") ?? (r.refs.get(`heads/${r.defaultBranch}`) as string);
      const commitSha = this.commits.has(ref) ? ref : r.refs.get(`heads/${ref}`);
      const content = commitSha ? this.fileAt(commitSha, path) : null;
      if (content === null) return c.json({ message: "Not Found" }, 404);
      if ((c.req.header("accept") ?? "").includes("raw")) return c.text(content);
      return c.json({
        type: "file",
        path,
        size: content.length,
        sha: this.blob(content),
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      });
    });
    app.get(`${R}/git/commits/:sha`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const cm = this.commits.get(c.req.param("sha"));
      return cm
        ? c.json({
            sha: cm.sha,
            tree: { sha: cm.tree },
            parents: cm.parents.map((sha) => ({ sha })),
            message: cm.message,
            verification: { verified: cm.verified },
          })
        : c.json({ message: "Not Found" }, 404);
    });
    app.get(`${R}/git/trees/:sha`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const t = this.trees.get(c.req.param("sha"));
      return t
        ? c.json({ sha: c.req.param("sha"), tree: t, truncated: false })
        : c.json({ message: "Not Found" }, 404);
    });
    app.post(`${R}/git/blobs`, async (c) => {
      const r = this.repoFor(c, { contents: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as { content: string; encoding: string };
      const buf = Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8");
      if (r.secretPatterns.some((re) => re.test(buf.toString("utf8"))))
        return c.json({ message: "Secret detected", status: "409" }, 409);
      return c.json({ sha: this.blob(buf) }, 201);
    });
    app.post(`${R}/git/trees`, async (c) => {
      const r = this.repoFor(c, { contents: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as {
        base_tree?: string;
        tree: { path: string; mode: string; sha: string | null }[];
      };
      const flat = b.base_tree ? this.flatten(b.base_tree) : new Map();
      for (const e of b.tree) {
        if (e.sha === null) flat.delete(e.path);
        else flat.set(e.path, { sha: e.sha, mode: e.mode });
      }
      return c.json({ sha: this.buildTree(flat) }, 201);
    });
    app.post(`${R}/git/commits`, async (c) => {
      const r = this.repoFor(c, { contents: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as {
        message: string;
        tree: string;
        parents: string[];
        author?: unknown;
        committer?: unknown;
        signature?: unknown;
      };
      // GitHub signs app commits that carry no custom author, committer or signature.
      const verified = !b.author && !b.committer && !b.signature;
      const sha = this.commit(b.tree, b.parents, b.message, "bumpsmith[bot]", verified);
      return c.json(
        {
          sha,
          tree: { sha: b.tree },
          verification: { verified, reason: verified ? "valid" : "unsigned" },
        },
        201,
      );
    });
    const workflowGuard = (c: Context, tok: Token | undefined, commitSha: string) => {
      const cm = this.commits.get(commitSha);
      if (!cm) return c.json({ message: "Object does not exist" }, 422);
      const parent = cm.parents[0] ? this.commits.get(cm.parents[0]) : null;
      const before = parent ? this.flatten(parent.tree) : new Map();
      const after = this.flatten(cm.tree);
      const touched = [...new Set([...before.keys(), ...after.keys()])].filter(
        (p) => p.startsWith(".github/workflows/") && before.get(p)?.sha !== after.get(p)?.sha,
      );
      if (touched.length && tok?.permissions.workflows !== "write")
        return c.json(
          {
            message: `refusing to allow a GitHub App to create or update workflow \`${touched[0]}\` without \`workflows\` permission`,
          },
          403,
        );
      return null;
    };
    const tokenOf = (c: Context) =>
      this.tokens.get((c.req.header("authorization") ?? "").split(" ")[1] ?? "");
    app.get(`${R}/git/ref/*`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const ref = decodeURIComponent(new URL(c.req.url).pathname.split("/git/ref/")[1] ?? "");
      const sha = r.refs.get(ref);
      return sha
        ? c.json({ ref: `refs/${ref}`, object: { sha, type: "commit" } })
        : c.json({ message: "Not Found" }, 404);
    });
    app.post(`${R}/git/refs`, async (c) => {
      const r = this.repoFor(c, { contents: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as { ref: string; sha: string };
      const ref = b.ref.replace(/^refs\//, "");
      if (r.refs.has(ref)) return c.json({ message: "Reference already exists" }, 422);
      const guard = workflowGuard(c, tokenOf(c), b.sha);
      if (guard) return guard;
      r.refs.set(ref, b.sha);
      return c.json({ ref: b.ref, object: { sha: b.sha } }, 201);
    });
    app.patch(`${R}/git/refs/*`, async (c) => {
      const r = this.repoFor(c, { contents: "write" });
      if (r instanceof Response) return r;
      const ref = decodeURIComponent(new URL(c.req.url).pathname.split("/git/refs/")[1] ?? "");
      const b = (await c.req.json()) as { sha: string; force?: boolean };
      if (!r.refs.has(ref)) return c.json({ message: "Reference does not exist" }, 422);
      const guard = workflowGuard(c, tokenOf(c), b.sha);
      if (guard) return guard;
      r.refs.set(ref, b.sha);
      return c.json({ ref: `refs/${ref}`, object: { sha: b.sha } });
    });
    app.get(`${R}/rules/branches/:branch`, (c) => {
      const r = this.repoFor(c, { metadata: "read" });
      if (r instanceof Response) return r;
      return c.json(r.rules[c.req.param("branch")] ?? []);
    });
    app.get(`${R}/pulls`, (c) => {
      const r = this.repoFor(c, { pull_requests: "read" });
      if (r instanceof Response) return r;
      const head = c.req.query("head");
      const state = c.req.query("state") ?? "open";
      const list = r.pulls.filter(
        (p) => (state === "all" || p.state === state) && (!head || `${r.owner}:${p.head}` === head),
      );
      return c.json(list.map((p) => this.prJson(r, p)));
    });
    app.post(`${R}/pulls`, async (c) => {
      const r = this.repoFor(c, { pull_requests: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as {
        title: string;
        body: string;
        head: string;
        base: string;
        draft?: boolean;
      };
      if (!r.refs.has(`heads/${b.head}`)) return c.json({ message: "head not found" }, 422);
      if (r.pulls.some((p) => p.head === b.head && p.state === "open"))
        return c.json({ message: "A pull request already exists" }, 422);
      const pr: PR = {
        id: this.nextId++,
        number: this.nextNumber++,
        title: b.title,
        body: b.body,
        head: b.head,
        base: b.base,
        state: "open",
        merged_at: null,
        draft: !!b.draft,
        user: "bumpsmith[bot]",
        labels: [],
        requested_reviewers: [],
        created_at: new Date().toISOString(),
      };
      r.pulls.push(pr);
      return c.json(this.prJson(r, pr), 201);
    });
    app.get(`${R}/pulls/:n`, (c) => {
      const r = this.repoFor(c, { pull_requests: "read" });
      if (r instanceof Response) return r;
      const pr = r.pulls.find((p) => p.number === Number(c.req.param("n")));
      return pr ? c.json(this.prJson(r, pr)) : c.json({ message: "Not Found" }, 404);
    });
    app.get(`${R}/pulls/:n/files`, (c) => {
      const r = this.repoFor(c, { pull_requests: "read" });
      if (r instanceof Response) return r;
      const pr = r.pulls.find((p) => p.number === Number(c.req.param("n")));
      return c.json((pr?.files ?? ["package.json"]).map((filename) => ({ filename })));
    });
    app.patch(`${R}/pulls/:n`, async (c) => {
      const r = this.repoFor(c, { pull_requests: "write" });
      if (r instanceof Response) return r;
      const pr = r.pulls.find((p) => p.number === Number(c.req.param("n")));
      if (!pr) return c.json({ message: "Not Found" }, 404);
      const b = (await c.req.json()) as Partial<PR>;
      if (b.title) pr.title = b.title;
      if (b.body) pr.body = b.body;
      return c.json(this.prJson(r, pr));
    });
    app.post(`${R}/issues/:n/labels`, async (c) => {
      const r = this.repoFor(c, { pull_requests: "write" });
      if (r instanceof Response) return r;
      const pr = r.pulls.find((p) => p.number === Number(c.req.param("n")));
      const b = (await c.req.json()) as { labels: string[] };
      if (pr) pr.labels.push(...b.labels);
      return c.json(b.labels.map((name) => ({ name })));
    });
    app.post(`${R}/issues/:n/comments`, async (c) => {
      const r = this.repoFor(c, { pull_requests: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as { body: string };
      r.comments.push({ issue: Number(c.req.param("n")), body: b.body, user: "bumpsmith[bot]" });
      return c.json({ id: this.nextId++, body: b.body }, 201);
    });
    app.post(`${R}/pulls/:n/requested_reviewers`, async (c) => {
      const r = this.repoFor(c, { pull_requests: "write" });
      if (r instanceof Response) return r;
      const pr = r.pulls.find((p) => p.number === Number(c.req.param("n")));
      const b = (await c.req.json()) as { reviewers?: string[] };
      if (pr) pr.requested_reviewers.push(...(b.reviewers ?? []));
      return c.json({}, 201);
    });
    app.post(`${R}/check-runs`, async (c) => {
      const r = this.repoFor(c, { checks: "write" });
      if (r instanceof Response) return r;
      const b = (await c.req.json()) as {
        head_sha: string;
        name: string;
        conclusion: string;
        status: string;
        output: unknown;
      };
      r.checkRuns.push({ ...b, app: true });
      return c.json({ id: this.nextId++ }, 201);
    });
    app.get(`${R}/commits/:ref`, (c) => {
      const r = this.repoFor(c, { contents: "read" });
      if (r instanceof Response) return r;
      const ref = c.req.param("ref");
      const cm = this.commits.get(ref) ?? this.commits.get(r.refs.get(`heads/${ref}`) ?? "");
      return cm
        ? c.json({ sha: cm.sha, commit: { message: cm.message }, author: { login: cm.author } })
        : c.json({ message: "Not Found" }, 404);
    });
    app.get(`${R}/commits/:ref/check-runs`, (c) => {
      const r = this.repoFor(c, { checks: "read" });
      if (r instanceof Response) return r;
      const runs = r.checkRuns.filter((x) => x.head_sha === c.req.param("ref"));
      return c.json({ total_count: runs.length, check_runs: runs });
    });
    app.get(`${R}/collaborators/:user/permission`, (c) => {
      const r = this.repoFor(c, { metadata: "read" });
      if (r instanceof Response) return r;
      const p = r.collaborators.get(c.req.param("user")) ?? "none";
      return c.json({ permission: p, role_name: p });
    });
    // User-to-server (sign-in) endpoints.
    const userOf = (c: Context) =>
      this.users.get((c.req.header("authorization") ?? "").split(" ")[1] ?? "");
    app.get("/user", (c) => {
      const u = userOf(c);
      return u ? c.json({ id: u.id, login: u.login }) : c.json({ message: "Bad credentials" }, 401);
    });
    app.get("/user/installations", (c) => {
      const u = userOf(c);
      if (!u) return c.json({ message: "Bad credentials" }, 401);
      return c.json({
        total_count: u.installations.length,
        installations: u.installations.map((i) => ({
          id: i.id,
          account: { login: i.account, type: i.type },
        })),
      });
    });
    app.get("/user/memberships/orgs/:org", (c) => {
      const u = userOf(c);
      const m = u?.installations.find((i) => i.account === c.req.param("org"));
      return m?.orgRole
        ? c.json({ state: "active", role: m.orgRole })
        : c.json({ message: "Not Found" }, 404);
    });
    app.all("*", (c) =>
      c.json(
        { message: `fake: ${c.req.method} ${new URL(c.req.url).pathname} not implemented` },
        501,
      ),
    );
    return app;
  }

  private prJson(r: FakeRepo, p: PR) {
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      draft: p.draft,
      merged_at: p.merged_at,
      html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
      head: { ref: p.head, sha: r.refs.get(`heads/${p.head}`) ?? p.head_sha ?? "" },
      base: { ref: p.base },
      user: { login: p.user },
      created_at: p.created_at,
      labels: p.labels.map((name) => ({ name })),
    };
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: this.app().fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(),
      );
    });
    const { port } = (this.server as unknown as { address(): AddressInfo }).address();
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}
