import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientIp, startDashboard } from "../../src/dashboard/server.ts";
import { serverConfig } from "../../src/server/config.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";

const PASSWORD = "correct horse battery staple";

describe("server configuration", () => {
  it("requires https unless the public URL is loopback", () => {
    expect(() => serverConfig({})).toThrow(/public-url is required/);
    expect(() => serverConfig({ publicUrl: "http://bumpsmith.acme.dev" })).toThrow(/https/);
    expect(() => serverConfig({ publicUrl: "https://bumpsmith.acme.dev/app" })).toThrow(/origin/);
    expect(() => serverConfig({ publicUrl: "https://bumpsmith.acme.dev" })).toThrow(
      /tls-cert.*behind-proxy/,
    );
    expect(serverConfig({ publicUrl: "http://localhost:4477" })).toMatchObject({
      host: "127.0.0.1",
      tls: null,
    });
  });

  it("serves TLS itself or trusts named proxies, never both", () => {
    const u = "https://bumpsmith.acme.dev";
    expect(() => serverConfig({ publicUrl: u, tlsCert: "c" })).toThrow(/go together/);
    expect(() =>
      serverConfig({ publicUrl: u, tlsCert: "c", tlsKey: "k", behindProxy: true }),
    ).toThrow(/choose one/);
    expect(serverConfig({ publicUrl: u, tlsCert: "c", tlsKey: "k" })).toMatchObject({
      host: "0.0.0.0",
      port: 4443,
      trustedProxies: [],
    });
    expect(serverConfig({ publicUrl: u, behindProxy: true })).toMatchObject({
      host: "127.0.0.1",
      port: 4477,
      trustedProxies: ["127.0.0.1", "::1"],
    });
    expect(() =>
      serverConfig({ publicUrl: u, behindProxy: true, trustedProxies: "10.0.0.0/8" }),
    ).toThrow(/IP addresses/);
  });

  it("believes X-Forwarded-For only from trusted proxies", () => {
    const req = (peer: string, xff?: string) =>
      ({
        socket: { remoteAddress: peer },
        headers: xff ? { "x-forwarded-for": xff } : {},
      }) as unknown as http.IncomingMessage;
    const proxies = new Set(["172.28.0.2"]);
    // Not from the proxy: the header is ignored.
    expect(clientIp(req("203.0.113.9", "1.2.3.4"), proxies)).toBe("203.0.113.9");
    // From the proxy: the rightmost address the proxy did not add itself.
    expect(clientIp(req("::ffff:172.28.0.2", "6.6.6.6, 198.51.100.7"), proxies)).toBe(
      "198.51.100.7",
    );
    expect(clientIp(req("172.28.0.2"), proxies)).toBe("172.28.0.2");
  });
});

describe("bumpsmith server (multi-user mode)", () => {
  let port = 0;
  let close: () => Promise<void>;
  let setupUrl = "";
  let dataDir = "";
  const host = "bumpsmith.acme.test";
  const origin = `https://${host}`;

  beforeAll(async () => {
    const d = await startDashboard({
      mode: "server",
      publicUrl: origin,
      host: "127.0.0.1",
      port: 4900 + Math.floor(Math.random() * 300),
      trustedProxies: ["127.0.0.1"],
      dataDir: join(await mkdtemp(join(tmpdir(), "bumpsmith-srv-")), "data"),
      cliEntry: "",
    });
    port = d.port;
    close = d.close;
    setupUrl = d.setupUrl ?? "";
    dataDir = d.dataDir;
  });
  afterAll(() => close());

  /** Requests as if through the reverse proxy: the public Host, and the client in X-Forwarded-For. */
  const req = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: () => unknown }>(
      (ok, fail) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const r = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: {
              host,
              "x-forwarded-for": "198.51.100.7",
              ...(data ? { "content-type": "application/json", origin } : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              ok({
                status: res.statusCode ?? 0,
                headers: res.headers,
                json: () => JSON.parse(text),
              });
            });
          },
        );
        r.on("error", fail);
        r.end(data);
      },
    );

  it("answers only to its public host name", async () => {
    expect(
      (await req("GET", "/auth/session", undefined, { host: `127.0.0.1:${port}` })).status,
    ).toBe(421);
    expect((await req("GET", "/auth/session", undefined, { host: "evil.example" })).status).toBe(
      421,
    );
    const ok = await req("GET", "/");
    expect(ok.status).toBe(200);
    expect(ok.headers["strict-transport-security"]).toMatch(/max-age=31536000/);
  });

  it("hands out links on the public URL and uses __Host- secure cookies", async () => {
    expect(setupUrl).toMatch(new RegExp(`^${origin}/#/setup/`));
    const token = /#\/setup\/(.+)$/.exec(setupUrl)?.[1] ?? "";
    // A form posted from another site is refused even with the setup token.
    const foreign = await req(
      "POST",
      "/auth/setup",
      { orgName: "Acme", name: "Dana", email: "dana@acme.dev", password: PASSWORD, token },
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
    const ok = await req("POST", "/auth/setup", {
      orgName: "Acme",
      name: "Dana",
      email: "dana@acme.dev",
      password: PASSWORD,
      token,
    });
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers["set-cookie"] ?? "");
    expect(cookie).toMatch(/^__Host-bs_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict/);
    expect(cookie).toMatch(/; Secure/);
    const h = {
      cookie: cookie.split(";")[0] ?? "",
      "x-csrf-token": (ok.json() as { csrf: string }).csrf,
    };

    // Two-factor is required for the owner; enrol, then try to add a folder from the server's disk.
    const start = (await req("POST", "/api/me/mfa/start", {}, h)).json() as { secret: string };
    const code = hotp(base32Decode(start.secret), Math.floor(Date.now() / 30000))
      .toString()
      .padStart(6, "0");
    expect((await req("POST", "/api/me/mfa/confirm", { code }, h)).status).toBe(200);
    const list = (await req("GET", "/api/workspaces", undefined, h)).json();
    expect(list).toMatchObject({ workspaces: [], localFolders: false });
    const folder = await req("POST", "/api/workspaces", { path: "/etc" }, h);
    expect(folder.status).toBe(403);
    expect(folder.json()).toMatchObject({ error: /GitHub/ });
  });

  it("records the real client address from the trusted proxy in the audit log", () => {
    const db = new DatabaseSync(join(dataDir, "bumpsmith.db"));
    const ips = db.prepare("SELECT DISTINCT ip FROM audit WHERE ip IS NOT NULL").all() as {
      ip: string;
    }[];
    db.close();
    expect(ips.map((r) => r.ip)).toEqual(["198.51.100.7"]);
  });
});

describe("bumpsmith server with its own TLS certificate", () => {
  it("serves HTTPS on TLS 1.2 or later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bumpsmith-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(join(dir, "cert.pem"));
    const port = 5300 + Math.floor(Math.random() * 300);
    const d = await startDashboard({
      mode: "server",
      publicUrl: `https://localhost:${port}`,
      port,
      tls: { cert, key: await readFile(join(dir, "key.pem")) },
      dataDir: join(dir, "data"),
      cliEntry: "",
    });
    try {
      expect(d.url).toBe(`https://localhost:${port}/`);
      const status = await new Promise<number>((ok, fail) => {
        https
          .get(
            {
              host: "127.0.0.1",
              port,
              path: "/",
              servername: "localhost",
              ca: cert,
              headers: { host: `localhost:${port}` },
            },
            (res) => {
              res.resume();
              ok(res.statusCode ?? 0);
            },
          )
          .on("error", fail);
      });
      expect(status).toBe(200);
      // Old protocol versions are refused.
      await expect(
        new Promise((ok, fail) =>
          https
            .get(
              {
                host: "127.0.0.1",
                port,
                path: "/",
                ca: cert,
                servername: "localhost",
                maxVersion: "TLSv1.1",
                minVersion: "TLSv1",
              },
              ok,
            )
            .on("error", fail),
        ),
      ).rejects.toThrow();
    } finally {
      await d.close();
    }
  });
});
