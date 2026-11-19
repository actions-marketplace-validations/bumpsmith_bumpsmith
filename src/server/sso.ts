// Single sign-on with the organisation's identity provider: OIDC (Okta, Entra ID, Google
// Workspace, Auth0, Keycloak…) and SAML 2.0. Accounts are linked or created on first sign-in
// ("just in time"), and identity-provider groups map to Bumpsmith roles.
import { createHash, timingSafeEqual } from "node:crypto";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { audit } from "./audit.ts";
import { AuthError, type User } from "./auth.ts";
import { newId, newToken, sha256 } from "./crypto.ts";
import { type Db, now } from "./db.ts";

export interface SsoConfig {
  oidc: {
    enabled: boolean;
    label: string;
    issuer: string;
    clientId: string;
    scopes: string;
    groupsClaim: string;
    /** How the client secret is sent to the token endpoint: "auto" picks HTTP Basic when the
     *  provider supports it. Some apps are set to one method only (Auth0 defaults to Post). */
    tokenAuth: "auto" | "basic" | "post";
  };
  saml: {
    enabled: boolean;
    label: string;
    entryPoint: string;
    idpIssuer: string;
    idpCert: string;
    emailAttribute: string;
    nameAttribute: string;
    groupsAttribute: string;
  };
  /** Identity-provider group → Bumpsmith role, first match wins. */
  mapping: { group: string; roleId: string }[];
  /** Role for people created on first sign-in when no group matches. */
  defaultRoleId: string;
  /** Only emails at these domains may sign in with SSO (empty: any). */
  domains: string[];
  /** Create accounts on first SSO sign-in (otherwise they must be invited first). */
  jit: boolean;
  /** Password sign-in only for Owners (break-glass); everyone else uses SSO. */
  enforce: boolean;
  /** Treat the identity provider's MFA as enough (no separate authenticator app). */
  trustIdpMfa: boolean;
}

export const defaultSso = (orgId: string): SsoConfig => ({
  oidc: {
    enabled: false,
    label: "SSO",
    issuer: "",
    clientId: "",
    scopes: "openid email profile",
    groupsClaim: "groups",
    tokenAuth: "auto",
  },
  saml: {
    enabled: false,
    label: "SSO",
    entryPoint: "",
    idpIssuer: "",
    idpCert: "",
    emailAttribute: "email",
    nameAttribute: "name",
    groupsAttribute: "groups",
  },
  mapping: [],
  defaultRoleId: `${orgId}:viewer`,
  domains: [],
  jit: true,
  enforce: false,
  trustIdpMfa: true,
});

export interface Identity {
  kind: "oidc" | "saml";
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** null: the provider left the groups out (Entra ID sends a link instead when someone is in
   *  more than 200 groups), so roles are not changed. */
  groups: string[] | null;
}

/** Scopes always include openid; duplicates and odd characters are dropped. */
const normScopes = (v: string) => {
  const list = (v || "").split(/\s+/).filter((x) => /^[\w.:/-]{1,60}$/.test(x));
  if (!list.length) return "openid email profile";
  return [...new Set(["openid", ...list])].join(" ");
};
/** Entra ID's multi-tenant endpoints publish an issuer template, not a real issuer. */
const TENANT_TEMPLATE = "{tenantid}";
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const httpsOrLocal = (u: string) =>
  /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);

export class Sso {
  private pending = new Map<
    string,
    { orgId: string; verifier: string; nonce: string; bind: string; expires: number }
  >();
  private discovery = new Map<
    string,
    {
      doc: {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        jwks_uri: string;
        token_endpoint_auth_methods_supported?: string[];
        id_token_signing_alg_values_supported?: string[];
      };
      at: number;
    }
  >();
  private jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private samlCache = new Map<string, { key: string; saml: SAML }>();

  constructor(
    private db: Db,
    private getExtra: (orgId: string) => Record<string, unknown>,
    private setExtra: (orgId: string, patch: Record<string, unknown>) => void,
    private secret: (orgId: string, name: string) => string | null,
  ) {}

  config(orgId: string): SsoConfig {
    const saved = (this.getExtra(orgId).sso ?? {}) as Partial<SsoConfig>;
    const d = defaultSso(orgId);
    return {
      ...d,
      ...saved,
      oidc: { ...d.oidc, ...(saved.oidc ?? {}) },
      saml: { ...d.saml, ...(saved.saml ?? {}) },
    };
  }

  /** Validate and store. Roles that control the organisation cannot be handed out by SSO. */
  save(orgId: string, next: SsoConfig, roles: { id: string; permissions: string[] }[]) {
    const roleOk = (id: string) => {
      const r = roles.find((x) => x.id === id);
      if (!r) throw new AuthError(400, "Unknown role in the SSO settings.");
      if (r.permissions.includes("org.manage"))
        throw new AuthError(400, "SSO cannot give the Owner role; promote Owners by hand.");
    };
    const o = next.oidc;
    if (o.enabled) {
      if (!httpsOrLocal(o.issuer))
        throw new AuthError(400, "The OIDC issuer must be an https:// URL.");
      if (!o.clientId.trim()) throw new AuthError(400, "Enter the OIDC client ID.");
      if (!this.secret(orgId, "OIDC_CLIENT_SECRET"))
        throw new AuthError(400, "Enter the OIDC client secret.");
    }
    const s = next.saml;
    if (s.enabled) {
      if (!httpsOrLocal(s.entryPoint))
        throw new AuthError(400, "The SAML sign-in URL must be an https:// URL.");
      if (
        !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(s.idpCert) &&
        !/^[A-Za-z0-9+/=\s]{200,}$/.test(s.idpCert)
      )
        throw new AuthError(400, "Paste the identity provider's signing certificate (PEM).");
    }
    roleOk(next.defaultRoleId);
    for (const m of next.mapping) {
      if (!m.group.trim()) throw new AuthError(400, "Every group mapping needs a group name.");
      roleOk(m.roleId);
    }
    const domains = next.domains
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    if (!domains.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))
      throw new AuthError(400, "Check the allowed email domains.");
    if (next.enforce && !o.enabled && !s.enabled)
      throw new AuthError(400, "Turn on OIDC or SAML before requiring SSO.");
    // Entra ID's shared endpoints accept people from any tenant (or any personal Microsoft
    // account): only safe with an allow-list of your own email domains.
    if (
      o.enabled &&
      /^https:\/\/login\.microsoftonline\.com\/(common|organizations|consumers)\b/i.test(
        o.issuer.trim(),
      ) &&
      !domains.length
    )
      throw new AuthError(
        400,
        "This Entra ID issuer lets any Microsoft account sign in. Use your tenant ID in the issuer, or list your allowed email domains.",
      );
    const clean: SsoConfig = {
      oidc: {
        enabled: !!o.enabled,
        label: (o.label || "SSO").slice(0, 30),
        issuer: o.issuer.trim().replace(/\/$/, ""),
        clientId: o.clientId.trim(),
        scopes: normScopes(o.scopes),
        groupsClaim: o.groupsClaim.trim() || "groups",
        tokenAuth: o.tokenAuth === "basic" || o.tokenAuth === "post" ? o.tokenAuth : "auto",
      },
      saml: {
        enabled: !!s.enabled,
        label: (s.label || "SSO").slice(0, 30),
        entryPoint: s.entryPoint.trim(),
        idpIssuer: s.idpIssuer.trim(),
        idpCert: s.idpCert.trim(),
        emailAttribute: s.emailAttribute.trim() || "email",
        nameAttribute: s.nameAttribute.trim() || "name",
        groupsAttribute: s.groupsAttribute.trim() || "groups",
      },
      mapping: next.mapping.map((m) => ({ group: m.group.trim(), roleId: m.roleId })),
      defaultRoleId: next.defaultRoleId,
      domains,
      jit: !!next.jit,
      enforce: !!next.enforce,
      trustIdpMfa: next.trustIdpMfa !== false,
    };
    this.setExtra(orgId, { sso: clean });
    this.samlCache.delete(orgId);
    return clean;
  }

  // ── OIDC: authorization code + PKCE + state + nonce ──

  private async discover(issuer: string) {
    const hit = this.discovery.get(issuer);
    if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
    const r = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r?.ok)
      throw new AuthError(502, "Could not read the identity provider's OIDC configuration.");
    const doc = (await r.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      token_endpoint_auth_methods_supported?: string[];
      id_token_signing_alg_values_supported?: string[];
    };
    const reported = doc.issuer.replace(/\/$/, "");
    // Entra ID: /common and /organizations publish an issuer template, and a tenant's domain
    // name (contoso.onmicrosoft.com) resolves to its GUID issuer. Both are Microsoft's own answer
    // for the URL that was asked, so they are accepted; tokens are then checked against them.
    const entra =
      /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(issuer) &&
      /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(reported);
    if (reported !== issuer && !entra)
      throw new AuthError(502, "The identity provider reports a different issuer.");
    this.discovery.set(issuer, { doc, at: Date.now() });
    return doc;
  }

  /** Returns the provider URL and a value the browser must hold (in a cookie) at the callback,
   *  so a sign-in started in one browser cannot be finished in another (login CSRF). */
  async oidcStart(orgId: string, origin: string): Promise<{ url: string; bind: string }> {
    const c = this.config(orgId).oidc;
    if (!c.enabled) throw new AuthError(400, "OIDC sign-in is not set up.");
    const d = await this.discover(c.issuer);
    const state = newToken();
    const nonce = newToken();
    const verifier = newToken(48);
    const bind = newToken();
    this.pending.set(sha256(state), {
      orgId,
      verifier,
      nonce,
      bind,
      expires: Date.now() + 10 * 60_000,
    });
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: c.clientId,
      redirect_uri: `${origin}/auth/oidc/callback`,
      scope: c.scopes,
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: u.toString(), bind };
  }

  async oidcCallback(
    code: string,
    state: string,
    origin: string,
    bind: string,
  ): Promise<{ orgId: string; identity: Identity }> {
    const h = sha256(state);
    const p = this.pending.get(h);
    this.pending.delete(h);
    if (!p || p.expires < Date.now())
      throw new AuthError(400, "This sign-in link expired. Start again.");
    if (!safeEqual(bind, p.bind))
      throw new AuthError(400, "This sign-in was started in another browser. Start again here.");
    const c = this.config(p.orgId).oidc;
    const d = await this.discover(c.issuer);
    const secret = this.secret(p.orgId, "OIDC_CLIENT_SECRET") ?? "";
    // Client authentication: HTTP Basic (the OAuth default, and what Okta, Entra ID, Google,
    // Auth0 and Keycloak apps use out of the box), or the secret in the body when the provider
    // only supports that. The code is single-use, so pick once instead of retrying.
    const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    const basic =
      c.tokenAuth === "basic" ||
      (c.tokenAuth !== "post" &&
        (methods.includes("client_secret_basic") || !methods.includes("client_secret_post")));
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/auth/oidc/callback`,
      code_verifier: p.verifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (basic) {
      // RFC 6749 2.3.1: form-encode both parts before joining them.
      const enc = (v: string) =>
        encodeURIComponent(v)
          .replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
          .replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(c.clientId)}:${enc(secret)}`).toString("base64")}`;
    } else {
      form.set("client_id", c.clientId);
      form.set("client_secret", secret);
    }
    const r = await fetch(d.token_endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r?.ok) throw new AuthError(502, "The identity provider did not accept the sign-in.");
    const tokens = (await r.json()) as { id_token?: string };
    if (!tokens.id_token) throw new AuthError(502, "The identity provider returned no ID token.");
    let jwks = this.jwks.get(d.jwks_uri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(d.jwks_uri));
      this.jwks.set(d.jwks_uri, jwks);
    }
    // Asymmetric signatures only, from the provider's own list (never "none" or a shared secret).
    const algorithms = (d.id_token_signing_alg_values_supported ?? ["RS256"]).filter(
      (a) => a !== "none" && !a.startsWith("HS"),
    );
    if (!algorithms.length)
      throw new AuthError(
        400,
        "Set the app to sign ID tokens with RS256 in your identity provider.",
      );
    // The issuer the token must carry: Entra's template is filled with the token's own tenant;
    // Google may send its issuer with or without the scheme.
    const multiTenant = d.issuer.includes(TENANT_TEMPLATE);
    let issuer: string | string[] = d.issuer;
    if (multiTenant) {
      const tid = String(decodeJwt(tokens.id_token).tid ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(tid)) throw new AuthError(400, "The token names no tenant.");
      issuer = d.issuer.replace(TENANT_TEMPLATE, tid);
    } else if (d.issuer === "https://accounts.google.com")
      issuer = [d.issuer, "accounts.google.com"];
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer,
      audience: c.clientId,
      algorithms,
      clockTolerance: 60,
      maxTokenAge: "10 minutes",
    }).catch(() => {
      throw new AuthError(400, "The identity provider's token did not verify.");
    });
    if (payload.nonce !== p.nonce)
      throw new AuthError(400, "The sign-in response does not match this request.");
    // OIDC Core 3.1.3.7: no audiences besides this app, and azp (when present) is this app.
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (auds.some((a) => a !== c.clientId) || (payload.azp != null && payload.azp !== c.clientId))
      throw new AuthError(400, "The token was issued to another application.");
    // Only an email the provider marks verified can link an existing account (OIDC Core 5.1).
    // Entra ID never sends email_verified; its optional xms_edov claim says the domain is
    // verified. preferred_username and upn are a fallback for the address, never verified.
    const verified =
      payload.email_verified === true ||
      payload.email_verified === "true" ||
      payload.xms_edov === true ||
      payload.xms_edov === "true" ||
      payload.xms_edov === "1";
    const email = String(
      payload.email ?? (multiTenant ? "" : (payload.preferred_username ?? payload.upn ?? "")),
    ).toLowerCase();
    // A multi-tenant app accepts anyone with a Microsoft account, so their address must be one
    // Microsoft has verified before it can decide anything here.
    if (multiTenant && !verified)
      throw new AuthError(
        403,
        "Your organisation's email domain is not verified by Microsoft. Ask an admin to add the xms_edov optional claim, or use a single-tenant issuer.",
      );
    const overage =
      !!(payload._claim_names as Record<string, unknown> | undefined)?.[c.groupsClaim] ||
      payload.hasgroups === true ||
      payload.hasgroups === "true";
    const groups = payload[c.groupsClaim];
    return {
      orgId: p.orgId,
      identity: {
        kind: "oidc",
        subject: `oidc:${multiTenant ? issuer : d.issuer}:${payload.sub}`,
        email,
        emailVerified: verified,
        name: String(payload.name ?? email.split("@")[0] ?? ""),
        groups: overage ? null : Array.isArray(groups) ? groups.map(String) : [],
      },
    };
  }

  // ── SAML 2.0 ──

  private saml(orgId: string, origin: string): SAML {
    const c = this.config(orgId).saml;
    if (!c.enabled) throw new AuthError(400, "SAML sign-in is not set up.");
    const key = JSON.stringify([c, origin]);
    const hit = this.samlCache.get(orgId);
    if (hit?.key === key) return hit.saml;
    const saml = new SAML({
      callbackUrl: `${origin}/auth/saml/acs`,
      entryPoint: c.entryPoint,
      issuer: `${origin}/auth/saml/metadata`,
      audience: `${origin}/auth/saml/metadata`,
      idpCert: c.idpCert,
      idpIssuer: c.idpIssuer || undefined,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: 180_000,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      disableRequestedAuthnContext: true,
    });
    this.samlCache.set(orgId, { key, saml });
    return saml;
  }

  /** The bind value travels as RelayState and in a cookie; the response must bring both back. */
  async samlStart(orgId: string, origin: string): Promise<{ url: string; bind: string }> {
    const bind = newToken();
    return { url: await this.saml(orgId, origin).getAuthorizeUrlAsync(bind, undefined, {}), bind };
  }

  samlMetadata(origin: string) {
    return new SAML({
      callbackUrl: `${origin}/auth/saml/acs`,
      issuer: `${origin}/auth/saml/metadata`,
      idpCert: "unused",
      wantAssertionsSigned: true,
    }).generateServiceProviderMetadata(null, null);
  }

  async samlCallback(
    orgId: string,
    origin: string,
    samlResponse: string,
    relayState: string,
    bind: string,
  ): Promise<Identity> {
    const c = this.config(orgId).saml;
    if (!relayState || !safeEqual(relayState, bind))
      throw new AuthError(
        400,
        "Start single sign-on from the Bumpsmith sign-in page (sign-in from the identity provider's dashboard is not accepted).",
      );
    const r = await this.saml(orgId, origin)
      .validatePostResponseAsync({ SAMLResponse: samlResponse })
      .catch((e: Error) => {
        throw new AuthError(400, `The SAML response was rejected: ${e.message.slice(0, 120)}`);
      });
    const prof = r.profile;
    if (!prof) throw new AuthError(400, "The SAML response held no identity.");
    const attr = (k: string) => (prof as Record<string, unknown>)[k];
    const email = String(attr(c.emailAttribute) ?? prof.email ?? prof.nameID ?? "").toLowerCase();
    const groups = attr(c.groupsAttribute);
    return {
      kind: "saml",
      subject: `saml:${prof.issuer ?? c.idpIssuer}:${prof.nameID}`,
      email,
      emailVerified: true,
      name: String(attr(c.nameAttribute) ?? email.split("@")[0] ?? ""),
      groups: Array.isArray(groups) ? groups.map(String) : groups ? [String(groups)] : [],
    };
  }

  // ── accounts ──

  /** Link the identity to an account, or create one, and apply group → role mapping. */
  resolve(orgId: string, id: Identity, ip: string): User {
    const cfg = this.config(orgId);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id.email))
      throw new AuthError(400, "Your identity provider did not send an email address.");
    const domain = id.email.split("@")[1] ?? "";
    if (cfg.domains.length && !cfg.domains.includes(domain))
      throw new AuthError(403, `Accounts at ${domain} cannot sign in here.`);
    const groups = id.groups;
    const mapped = groups ? cfg.mapping.find((m) => groups.includes(m.group))?.roleId : undefined;
    const owner = `${orgId}:owner`;
    const log = (action: string, actorId: string, detail?: Record<string, unknown>) =>
      audit(this.db, {
        orgId,
        actorId,
        actor: id.email,
        action,
        ip,
        detail: { via: id.kind, ...detail },
      });
    let u = this.db
      .prepare("SELECT * FROM users WHERE org_id = ? AND sso_subject = ?")
      .get(orgId, id.subject) as unknown as User | undefined;
    if (!u) {
      const byEmail = this.db
        .prepare("SELECT * FROM users WHERE org_id = ? AND email = ?")
        .get(orgId, id.email) as unknown as User | undefined;
      if (byEmail) {
        // Link an existing or invited account, but only to an address the IdP vouches for.
        if (!id.emailVerified)
          throw new AuthError(403, "Your identity provider has not verified this email address.");
        this.db
          .prepare("UPDATE users SET sso_subject = ? WHERE id = ?")
          .run(id.subject, byEmail.id);
        u = { ...byEmail, sso_subject: id.subject } as User;
        log("sso.linked", byEmail.id);
      } else {
        if (!cfg.jit)
          throw new AuthError(403, "You need an invitation first. Ask an admin to invite you.");
        const userId = newId("usr");
        this.db
          .prepare(
            "INSERT INTO users (id, org_id, email, name, role_id, status, sso_subject, created_at) VALUES (?,?,?,?,?, 'active', ?, ?)",
          )
          .run(
            userId,
            orgId,
            id.email,
            id.name.slice(0, 80) || id.email,
            mapped ?? cfg.defaultRoleId,
            id.subject,
            now(),
          );
        log("member.joined", userId, { role: mapped ?? cfg.defaultRoleId });
        u = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as User;
      }
    }
    if (u.status === "disabled") throw new AuthError(403, "Your account is deactivated.");
    if (u.status === "invited") {
      this.db
        .prepare("UPDATE users SET status = 'active', name = ? WHERE id = ?")
        .run(id.name.slice(0, 80) || u.name, u.id);
      this.db.prepare("DELETE FROM invites WHERE user_id = ?").run(u.id);
      log("member.joined", u.id);
    }
    if (!groups)
      log("sso.groups_missing", u.id, {
        reason: "the identity provider left the groups out (Entra ID: more than 200 groups)",
      });
    // Groups keep roles in sync, except for Owners, who are only ever changed by hand. Someone
    // who left every mapped group falls back to the default role.
    const target = mapped ?? (groups && cfg.mapping.length ? cfg.defaultRoleId : undefined);
    if (target && u.role_id !== target && u.role_id !== owner) {
      this.db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(target, u.id);
      log("member.role_synced", u.id, { to: target });
    }
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as unknown as User;
  }
}
