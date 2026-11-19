# Changelog

## 0.1.1 — 2026-11-19

- Dashboard: the landing page's buttons, one corner radius and one control height everywhere;
  the selected page and the search field use the 3D button build; sign-out turns red on hover.
- New sign-in, setup, two-factor, invite and reset screens with the animated anvil drawing.
- Account page: API tokens next to two-factor, with pagination.
- Single sign-on: the OIDC token request uses HTTP Basic client authentication when the
  provider supports it (the default for Okta, Entra ID, Google, Auth0 and Keycloak apps).
- Docs: [single sign-on guide](docs/sso.md) (Okta OIDC and SAML step by step) and
  [`.env.example`](.env.example) with every environment variable.
- `pnpm demo:workspace`: a ready-made demo organisation for trying the dashboard.

## 0.1.0 — 2026-11-19

First public release.

- CLI: `bumpsmith fix`, `explain`, `scan`.
- MCP server:
  - `bumpsmith mcp` (stdio) for local agents and editors;
  - `/mcp` on a Bumpsmith server, over HTTP with personal API tokens;
  - tools to scan, check a release, diff an API, explain, and start, poll and apply an upgrade;
  - listed in the official MCP Registry as `io.github.bumpsmith/bumpsmith`.
- Agent skill in `skills/bumpsmith`, also installable as a plugin from this repository.
- GitHub Action: rescues red Dependabot/Renovate pull requests with a verified companion PR.
- Sandbox with a read-only registry mirror (GET/HEAD only); install scripts off; 3-day release-age gate.
- Publishing path re-checks the reviewed patch hash and diff rules, applies the patch strictly, never overwrites human commits or reopens closed PRs.
- Dashboard and `bumpsmith server` (self-hosted, multi-user):
  - **Sign-in:**
    - NIST 800-63B passwords with a breached-password check and lockout;
    - TOTP two-factor with recovery codes;
    - OIDC and SAML single sign-on with JIT accounts, group-to-role mapping and enforcement.
  - **Sessions and recovery:**
    - server-side sessions with CSRF protection;
    - step-up re-authentication;
    - admin-issued password reset links.
  - **Access:**
    - built-in and custom roles;
    - a per-repository access control center;
    - scoped personal API tokens;
    - a hash-chained audit log with CSV export.
  - **Integrations:** encrypted GitHub App and token credentials, plus model keys, all set up in the browser.
  - **Deployment:**
    - TLS or a trusted reverse proxy;
    - a Docker image and a Compose file with Caddy;
    - a systemd unit.
  - **Docs:** [self-hosting](docs/self-hosting.md) and [security controls](docs/security/controls.md).
