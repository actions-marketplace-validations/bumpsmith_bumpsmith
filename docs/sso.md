# Single sign-on (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak)

Bumpsmith supports single sign-on with **OIDC** (recommended) and **SAML 2.0**. Everything is
set up in the dashboard, under **Organisation → Security → Single sign-on**; no environment
variables or restarts. You need the **Owner** or **Admin** role, and Bumpsmith must be running
as a server with an `https://` public address (see the [self-hosting guide](self-hosting.md)).

What you get:

- a **Continue with Okta** button on the sign-in page (the label is yours to choose);
- accounts created on first sign-in, or invited people only;
- identity-provider groups mapped to Bumpsmith roles, updated at every sign-in;
- optional: SSO required for everyone (Owners keep a password as a break-glass account), and the
  identity provider's MFA trusted so people don't also need an authenticator app.

Bumpsmith only talks to your identity provider from the server (discovery, token and key
endpoints), so the server needs outbound HTTPS to it. Your identity provider never needs to
reach Bumpsmith: the sign-in goes through the person's browser.

## Okta with OIDC (recommended)

### 1. Create the app in Okta

1. In the Okta Admin Console, open **Applications → Applications → Create App Integration**.
2. Choose **OIDC - OpenID Connect**, then **Web Application**, then **Next**.
3. Fill in:

   | Okta field             | Value                                                                               |
   | ---------------------- | ----------------------------------------------------------------------------------- |
   | App integration name   | `Bumpsmith`                                                                         |
   | Grant type             | **Authorization Code** (the default; nothing else)                                  |
   | Sign-in redirect URIs  | `https://<your-bumpsmith>/auth/oidc/callback`. Copy it from Bumpsmith's OIDC panel. |
   | Sign-out redirect URIs | leave empty                                                                         |
   | Assignments            | **Limit access to selected groups**, and pick who may use Bumpsmith                 |

4. **Save**. On the **General** tab, copy the **Client ID** and the **Client secret**. Leave
   client authentication on **Client secret**. Bumpsmith always uses PKCE, so you can also turn
   on **Require PKCE**.

### 2. Send groups in the ID token (for role mapping)

On the app's **Sign On** tab, under **OpenID Connect ID Token**, click **Edit** and set:

| Okta field        | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Groups claim type | **Filter**                                                                   |
| Groups claim name | `groups`                                                                     |
| Filter            | **Starts with** `bumpsmith-` (or **Matches regex** `.*` to send every group) |

Sending only the groups you map keeps the token small. Okta's org authorization server adds the
claim only when the sign-in asks for the `groups` scope, so add it in Bumpsmith (next step).

> Using a **custom authorization server** (an issuer like `https://acme.okta.com/oauth2/default`)?
> Add the `groups` claim on that server instead (**Security → API → Authorization Servers →
> Claims**, include in the ID token), and use that issuer URL in the next step.

### 3. Turn it on in Bumpsmith

Open **Organisation → Security**, scroll to **Single sign-on**, and fill in the **OIDC** panel:

| Bumpsmith field       | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| Allow OIDC sign-in    | on                                                            |
| Issuer URL            | `https://acme.okta.com` (your Okta domain, no trailing slash) |
| Client ID             | from step 1                                                   |
| Client secret         | from step 1 (stored encrypted; it is never shown again)       |
| Button label          | `Okta`                                                        |
| Groups claim          | `groups`                                                      |
| Scopes                | `openid email profile groups`                                 |
| Client authentication | **Automatic** (Okta apps use Client secret Basic)             |

Then, under **Accounts and roles**:

- **Create accounts on first sign-in**: on, unless you want to invite every person first.
- **Role for new accounts**: the role people get when none of their groups is mapped (Viewer is a
  safe default). SSO never gives the Owner role.
- **Allowed email domains**: for example `acme.dev`. Empty allows any domain Okta sends.
- **Group to role**: for example `bumpsmith-admins → Admin`, `bumpsmith-maintainers →
  Maintainer`, `bumpsmith-reviewers → Reviewer`. The first match wins, and roles follow the
  groups at every sign-in.
- **Trust the identity provider's MFA**: on if Okta already enforces MFA for this app.
- **Require SSO**: turn on once a test sign-in works. Owners keep their password as a
  break-glass account.

Click **Save single sign-on**. Bumpsmith asks you to confirm it's you (your password or MFA code)
before saving, and records the change in the audit log.

### 4. Test it

Open Bumpsmith in a private window. The sign-in page shows **Continue with Okta**. Sign in as a
test user who is assigned to the app, then check **Organisation → Members** for their account and
role, and the **Audit log** for the sign-in.

## Okta with SAML 2.0

Use this if your company standardises on SAML.

1. In Okta: **Applications → Create App Integration → SAML 2.0 → Next**, name it `Bumpsmith`.
2. **Configure SAML**, with values copied from Bumpsmith's **SAML 2.0** panel:

   | Okta field                         | Value                                                             |
   | ---------------------------------- | ----------------------------------------------------------------- |
   | Single sign-on URL                 | the **ACS URL** (`https://<your-bumpsmith>/auth/saml/acs`)        |
   | Audience URI (SP Entity ID)        | the **Entity ID** (`https://<your-bumpsmith>/auth/saml/metadata`) |
   | Name ID format                     | **EmailAddress**                                                  |
   | Application username               | **Email**                                                         |
   | Attribute statement `email`        | `user.email`                                                      |
   | Attribute statement `name`         | `user.displayName`                                                |
   | Group attribute statement `groups` | Filter **Starts with** `bumpsmith-` (or regex `.*`)               |

   Okta signs assertions by default; Bumpsmith requires signed assertions.
3. **Finish**, assign people or groups, then open **Sign On → View SAML setup instructions**.
4. In Bumpsmith's **SAML 2.0** panel: turn on **Allow SAML sign-in**, and paste **Identity Provider
   Single Sign-On URL** into _Identity provider sign-in URL_, **Identity Provider Issuer** into
   _Identity provider entity ID_, and the **X.509 Certificate** into _Signing certificate_. Keep the
   attributes as `email`, `name` and `groups`, set the button label, and fill in **Accounts and
   roles** as above. Save and test in a private window.

   Sign-in must start from Bumpsmith's **Continue with …** button. Clicking the app's tile on the
   Okta dashboard (IdP-initiated sign-in) is refused, because it can't be tied to the browser that
   started it. Hide the tile (**General → App Settings → Do not display application icon to
   users**), or point a bookmark app at `https://<your-bumpsmith>/auth/saml/start`.

## Other identity providers

The same two panels work with any OIDC or SAML provider:

| Provider           | OIDC issuer URL                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Entra ID | `https://login.microsoftonline.com/<directory-tenant-id>/v2.0`  | Use the **Directory (tenant) ID** for a single-tenant app. Groups: **Token configuration → Add groups claim**; Entra sends group **Object IDs**, so map the GUIDs. Choose **Groups assigned to the application** to stay under the 200-group limit (above it, Bumpsmith keeps people's current role). Entra does not verify email addresses, so an existing account is only linked when you add the `xms_edov` optional claim; otherwise invite people first or let SSO create their accounts. |
| Google Workspace   | `https://accounts.google.com`                                   | Google does not send groups: use the default role, and set **Allowed email domains** to your Workspace domain.                                                                                                                                                                                                                                                                                                                                                                                 |
| Auth0              | `https://<your Auth0 domain>` (for example `acme.us.auth0.com`) | Set **Client authentication** to **Post** (Auth0's default for Regular Web Apps), or change the app to Basic. Keep ID-token signing on **RS256**. `groups` is a restricted claim: add a namespaced one in an Action, for example `https://bumpsmith.dev/groups`, and put that name in **Groups claim**.                                                                                                                                                                                        |
| Keycloak           | `https://<host>/realms/<realm>`                                 | A **Group Membership** mapper: token claim name `groups`, **Full group path off**, **Add to ID token** on.                                                                                                                                                                                                                                                                                                                                                                                     |

The redirect URI is always `https://<your-bumpsmith>/auth/oidc/callback`.

## Troubleshooting

| What you see                                                | What to check                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "Could not read the identity provider's OIDC configuration" | The issuer URL, and that the server can reach `<issuer>/.well-known/openid-configuration`.                                              |
| "The identity provider reports a different issuer"          | The org server versus a custom authorization server (`/oauth2/default`). Entra: use the tenant ID.                                      |
| "The identity provider did not accept the sign-in"          | The client secret, **Client authentication** (Basic or Post, as the app is set), and that the redirect URI matches Bumpsmith's exactly. |
| "This sign-in was started in another browser"               | Start from the Bumpsmith sign-in page in the same browser, and allow cookies for Bumpsmith.                                             |
| "…has not verified this email address"                      | An existing account can only be linked to a verified address. Entra: add the `xms_edov` optional claim.                                 |
| "Your identity provider did not send an email address"      | OIDC: the `email` scope. SAML: the `email` attribute statement and Name ID format.                                                      |
| Everyone gets the default role                              | The groups claim name, the `groups` scope (Okta org server), the filter, and that the person is in a mapped group.                      |
| A person can't sign in at all                               | They are assigned to the Okta app, and their email domain is in **Allowed email domains**.                                              |

Every SSO sign-in (and every account it creates or role it changes) is recorded in the audit
log. A failed sign-in shows its reason on the sign-in page.
