// Single sign-on against real protocol counterparts started in the test: an OIDC provider
// (discovery, JWKS, token endpoint with PKCE) and SAML responses signed with a real X.509
// certificate. Covers account linking, group → role mapping and the attacks that matter.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { startDashboard } from "../../src/dashboard/server.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";
import { runOk } from "../../src/util/proc.ts";

const PASSWORD = "Tidal-Lantern-Quartz-42";

describe("single sign-on", { timeout: 60_000 }, () => {
  let base = "";
  let close: () => Promise<void> = async () => {};
  let idpClose: () => void = () => {};
  let issuer = "";
  let owner: Record<string, string> = {};
  let mfaSecret = "";
  let roles: Record<string, string> = {};
  // The fake identity provider: what it signs into the next ID token.
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let lastAuth = "";
  const codes = new Map<string, { claims: Record<string, unknown>; challenge: string }>();
  let samlKey = "";
  let samlCert = "";

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = async (r: Response) => {
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { csrf } = (await r.json()) as { csrf: string };
    return { cookie, "x-csrf-token": csrf };
  };
  const code = (offset = 0) =>
    hotp(base32Decode(mfaSecret), Math.floor(Date.now() / 30_000) + offset);

  beforeAll(async () => {
    // ── the OIDC provider ──
    keys = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const idp = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", issuer);
      const json = (o: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === "/.well-known/openid-configuration")
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      if (u.pathname === "/jwks") return json({ keys: [jwk] });
      if (u.pathname === "/token") {
        const basicAuth = `Basic ${Buffer.from("bumpsmith:s3cret-value").toString("base64")}`;
        let body = "";
        for await (const c of req) body += c;
        const f = new URLSearchParams(body);
        const entry = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        // PKCE: the verifier must hash to the challenge sent with the authorization request.
        const ok =
          entry &&
          createHash("sha256")
            .update(f.get("code_verifier") ?? "")
            .digest("base64url") === entry.challenge &&
          // client authentication: HTTP Basic by default, or the secret in the body
          ((req.headers.authorization ?? "") === basicAuth ||
            (!req.headers.authorization &&
              f.get("client_id") === "bumpsmith" &&
              f.get("client_secret") === "s3cret-value"));
        lastAuth = req.headers.authorization ? "basic" : "post";
        if (!ok) {
          res.writeHead(400);
          return res.end("{}");
        }
        const idToken = await new SignJWT(entry.claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
        return json({ id_token: idToken, token_type: "Bearer" });
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
    idpClose = () => idp.close();

    // ── a SAML signing certificate ──
    const dir = await mkdtemp(join(tmpdir(), "bs-saml-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=idp.test",
        "-days",
        "2",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
      ],
      { stdio: "ignore" },
    );
    samlKey = await readFile(join(dir, "k.pem"), "utf8");
    samlCert = await readFile(join(dir, "c.pem"), "utf8");

    // ── Bumpsmith with an owner ──
    const repo = await mkdtemp(join(tmpdir(), "bs-sso-repo-"));
    await writeFile(join(repo, "package.json"), "{}\n");
    await runOk("git", ["-C", repo, "init", "-q"]);
    const d = await startDashboard({
      repoDir: repo,
      dataDir: join(repo, ".data"),
      port: 4900 + Math.floor(Math.random() * 90),
      cliEntry: "",
    });
    base = d.url.replace(/\/$/, "");
    close = d.close;
    const token = /#\/setup\/(.+)$/.exec(d.setupUrl ?? "")?.[1] ?? "";
    owner = await session(
      await post("/auth/setup", {
        token,
        orgName: "Acme",
        name: "Dana Reyes",
        email: "dana@acme.dev",
        password: PASSWORD,
      }),
    );
    const st = (await (await post("/api/me/mfa/start", {}, owner)).json()) as { secret: string };
    mfaSecret = st.secret;
    await post("/api/me/mfa/confirm", { code: code() }, owner);
    const list = (await (await fetch(`${base}/api/sso`, { headers: owner })).json()) as {
      roles: { id: string; name: string }[];
    };
    roles = Object.fromEntries(list.roles.map((r) => [r.name, r.id]));
  });
  afterAll(async () => {
    await close();
    idpClose();
  });

  const config = (over: Record<string, unknown> = {}) => ({
    oidc: {
      enabled: true,
      label: "Okta",
      issuer,
      clientId: "bumpsmith",
      scopes: "openid email profile",
      groupsClaim: "groups",
    },
    saml: {
      enabled: true,
      label: "SAML",
      entryPoint: "https://idp.test/sso",
      idpIssuer: "https://idp.test",
      idpCert: samlCert,
      emailAttribute: "email",
      nameAttribute: "name",
      groupsAttribute: "groups",
    },
    mapping: [{ group: "eng", roleId: roles.Maintainer }],
    defaultRoleId: roles.Viewer,
    domains: ["acme.dev"],
    jit: true,
    enforce: false,
    trustIdpMfa: true,
    ...over,
  });

  /** Run the OIDC flow; the IdP puts `claims` (plus the request's nonce) in the ID token. */
  async function oidcSignIn(
    claims: Record<string, unknown>,
    tweak: (nonce: string) => Record<string, unknown> = (n) => ({ nonce: n }),
    opts: { otherBrowser?: boolean } = {},
  ) {
    const start = await fetch(`${base}/auth/oidc/start`, { redirect: "manual" });
    const bind = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(bind).toMatch(/^bs_sso_oidc=.+/);
    expect(start.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get("location") ?? "");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("redirect_uri")).toBe(`${base}/auth/oidc/callback`);
    const c = randomUUID();
    codes.set(c, {
      claims: {
        iss: issuer,
        aud: "bumpsmith",
        sub: claims.sub ?? "u1",
        ...claims,
        ...tweak(auth.searchParams.get("nonce") ?? ""),
      },
      challenge: auth.searchParams.get("code_challenge") ?? "",
    });
    const state = auth.searchParams.get("state") ?? "";
    const cb = await fetch(
      `${base}/auth/oidc/callback?code=${c}&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: opts.otherBrowser ? {} : { cookie: bind } },
    );
    return { cb, state, code: c };
  }

  it("saves SSO settings only after re-authentication, and never maps to Owner", async () => {
    expect(
      (
        await post(
          "/api/sso",
          {
            config: config({ mapping: [{ group: "x", roleId: roles.Owner }] }),
            clientSecret: "s3cret-value",
          },
          owner,
        )
      ).status,
    ).toBe(400);
    const r = await post("/api/sso", { config: config(), clientSecret: "s3cret-value" }, owner);
    expect(r.status).toBe(200);
    expect(await (await fetch(`${base}/auth/sso`)).json()).toEqual({
      oidc: { label: "Okta" },
      saml: { label: "SAML" },
      enforce: false,
    });
    const saved = (await (await fetch(`${base}/api/sso`, { headers: owner })).json()) as {
      clientSecret: { last4: string };
    };
    expect(saved.clientSecret).toEqual({ last4: "alue" });
    expect(JSON.stringify(saved)).not.toContain("s3cret");
  });

  it("signs a new person in with OIDC, creating the account with their group's role", async () => {
    const { cb } = await oidcSignIn({
      sub: "okta-1",
      email: "sam@acme.dev",
      email_verified: true,
      name: "Sam Patel",
      groups: ["eng"],
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/#/");
    const cookie = (cb.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const s = (await (await fetch(`${base}/auth/session`, { headers: { cookie } })).json()) as {
      user: { email: string };
      role: { name: string };
      method: string;
      mustEnrollMfa: boolean;
    };
    expect(s).toMatchObject({
      user: { email: "sam@acme.dev" },
      role: { name: "Maintainer" },
      method: "sso",
      mustEnrollMfa: false,
    });
  });

  it("refuses a replayed state, a wrong nonce, the wrong audience and other domains", async () => {
    const { state, cb } = await oidcSignIn({
      sub: "okta-1",
      email: "sam@acme.dev",
      groups: ["eng"],
    });
    expect(cb.headers.get("location")).toBe("/#/");
    const replay = await fetch(
      `${base}/auth/oidc/callback?code=x&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toMatch(/sso_error=.*expired/);
    const nonce = await oidcSignIn({ sub: "okta-2", email: "a@acme.dev" }, () => ({
      nonce: "forged",
    }));
    expect(nonce.cb.headers.get("location")).toMatch(/sso_error=.*does%20not%20match/);
    const aud = await oidcSignIn({ sub: "okta-3", email: "b@acme.dev" }, (n) => ({
      nonce: n,
      aud: "someone-else",
    }));
    expect(aud.cb.headers.get("location")).toMatch(/sso_error=.*did%20not%20verify/);
    const domain = await oidcSignIn({ sub: "okta-4", email: "eve@evil.dev" });
    expect(domain.cb.headers.get("location")).toMatch(/sso_error=.*evil\.dev/);
    expect(domain.cb.headers.get("set-cookie")).toBeNull();
  });

  /** A SAML Response for the latest AuthnRequest, with the assertion signed by the IdP. */
  async function samlResponse(email: string, opts: { sign?: boolean; tamper?: boolean } = {}) {
    const start = await fetch(`${base}/auth/saml/start`, { redirect: "manual" });
    const loc = new URL(start.headers.get("location") ?? "");
    const req = loc.searchParams.get("SAMLRequest") ?? "";
    const relay = loc.searchParams.get("RelayState") ?? "";
    const bind = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(start.headers.get("set-cookie")).toMatch(/SameSite=None; Secure/);
    const reqId =
      /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(req, "base64")).toString())?.[1] ?? "";
    const now = new Date();
    const later = new Date(now.getTime() + 5 * 60_000).toISOString();
    const aid = `_a${randomUUID().replace(/-/g, "")}`;
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${reqId}" NotOnOrAfter="${later}" Recipient="${base}/auth/saml/acs"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${base}/auth/saml/metadata</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>Lee Kim</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
    let signed = assertion;
    if (opts.sign !== false) {
      const sig = new SignedXml({
        privateKey: samlKey,
        publicCert: samlCert,
        signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
        canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
      });
      sig.addReference({
        xpath: `//*[@ID='${aid}']`,
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
        transforms: [
          "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
          "http://www.w3.org/2001/10/xml-exc-c14n#",
        ],
      });
      sig.computeSignature(assertion, {
        location: { reference: "//*[local-name()='Issuer']", action: "after" },
      });
      signed = sig.getSignedXml();
    }
    if (opts.tamper) signed = signed.replaceAll(email, "boss@acme.dev");
    const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomUUID().replace(/-/g, "")}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${base}/auth/saml/acs" InResponseTo="${reqId}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
    return { response: Buffer.from(response).toString("base64"), relay, bind };
  }
  const acs = (r: { response: string; relay: string; bind: string }) =>
    fetch(`${base}/auth/saml/acs`, {
      method: "POST",
      redirect: "manual",
      // The identity provider posts from its own site: this must not be refused as cross-origin.
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://idp.test",
        ...(r.bind ? { cookie: r.bind } : {}),
      },
      body: new URLSearchParams({ SAMLResponse: r.response, RelayState: r.relay }).toString(),
    });

  it("publishes service-provider metadata", async () => {
    const xml = await (await fetch(`${base}/auth/saml/metadata`)).text();
    expect(xml).toContain(`entityID="${base}/auth/saml/metadata"`);
    expect(xml).toContain(`Location="${base}/auth/saml/acs"`);
  });

  it("signs in with a signed SAML assertion, and refuses tampered, unsigned or replayed ones", async () => {
    const good = await samlResponse("lee@acme.dev");
    const ok = await acs(good);
    expect(ok.headers.get("location")).toBe("/#/");
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const s = (await (await fetch(`${base}/auth/session`, { headers: { cookie } })).json()) as {
      user: { email: string; name: string };
      role: { name: string };
    };
    expect(s).toMatchObject({
      user: { email: "lee@acme.dev", name: "Lee Kim" },
      role: { name: "Viewer" },
    });
    expect((await acs(good)).headers.get("location")).toMatch(/sso_error/); // replay: InResponseTo already used
    const tampered = await acs(await samlResponse("lee@acme.dev", { tamper: true }));
    expect(tampered.headers.get("location")).toMatch(/sso_error/);
    expect(tampered.headers.get("set-cookie")).toBeNull();
    const unsigned = await acs(await samlResponse("lee@acme.dev", { sign: false }));
    expect(unsigned.headers.get("location")).toMatch(/sso_error/);
    expect(unsigned.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a sign-in finished in another browser, and an unsolicited SAML response", async () => {
    const other = await oidcSignIn(
      { sub: "okta-1", email: "sam@acme.dev", email_verified: true },
      undefined,
      { otherBrowser: true },
    );
    expect(other.cb.headers.get("location")).toMatch(/sso_error=.*another%20browser/);
    const r = await samlResponse("lee@acme.dev");
    const idpInitiated = await acs({ ...r, relay: "", bind: "" });
    expect(idpInitiated.headers.get("location")).toMatch(/sso_error=.*Bumpsmith%20sign-in%20page/);
  });

  it("never links an existing account to an unverified email", async () => {
    // dana@acme.dev is the password Owner; a token without email_verified must not take it over
    const { cb } = await oidcSignIn({ sub: "evil-1", email: "dana@acme.dev" });
    expect(cb.headers.get("location")).toMatch(/sso_error=.*not%20verified/);
    const str = await oidcSignIn({
      sub: "evil-2",
      email: "dana@acme.dev",
      email_verified: "false",
    });
    expect(str.cb.headers.get("location")).toMatch(/sso_error=.*not%20verified/);
  });

  it("keeps the role when the provider leaves the groups out (Entra ID overage)", async () => {
    const first = await oidcSignIn({
      sub: "entra-1",
      email: "ola@acme.dev",
      email_verified: true,
      groups: ["eng"],
    });
    expect(first.cb.headers.get("location")).toBe("/#/");
    const again = await oidcSignIn({
      sub: "entra-1",
      email: "ola@acme.dev",
      email_verified: true,
      _claim_names: { groups: "src1" },
    });
    const cookie = (again.cb.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const s = (await (await fetch(`${base}/auth/session`, { headers: { cookie } })).json()) as {
      role: { name: string };
    };
    expect(s.role.name).toBe("Maintainer");
  });

  it("sends the client secret the way the app is set up (Basic by default, or Post)", async () => {
    await oidcSignIn({ sub: "okta-1", email: "sam@acme.dev", email_verified: true });
    expect(lastAuth).toBe("basic");
    expect(
      (
        await post(
          "/api/sso",
          { config: config({ oidc: { ...config().oidc, tokenAuth: "post" } }) },
          owner,
        )
      ).status,
    ).toBe(200);
    const { cb } = await oidcSignIn({ sub: "okta-1", email: "sam@acme.dev", email_verified: true });
    expect(cb.headers.get("location")).toBe("/#/");
    expect(lastAuth).toBe("post");
    await post("/api/sso", { config: config() }, owner);
  });

  it("when SSO is required, only Owners may still use a password", async () => {
    const inv = (await (
      await post("/api/members/invite", { email: "pat@acme.dev", roleId: roles.Reviewer }, owner)
    ).json()) as { link: string };
    const token = inv.link.split("#/invite/")[1] ?? "";
    expect(
      (await post("/auth/invite", { token, name: "Pat Lee", password: "Copper-Harbour-Lantern-7" }))
        .status,
    ).toBe(200);
    expect((await post("/api/sso", { config: config({ enforce: true }) }, owner)).status).toBe(200);
    const pat = await post("/auth/login", {
      email: "pat@acme.dev",
      password: "Copper-Harbour-Lantern-7",
    });
    expect(pat.status).toBe(403);
    expect(await pat.json()).toMatchObject({ sso: true });
    const dana = await post("/auth/login", { email: "dana@acme.dev", password: PASSWORD });
    expect(await dana.json()).toEqual({ mfaRequired: true }); // break-glass still works, with MFA
  });
});
