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

Fixes from an audit against each provider's current documentation:

- **Security:**
  - the breached-password list now ships in the npm package and Docker image (it was missing, so that check was off), and the server refuses to run without it;
  - sign-in lockout no longer reveals which emails have accounts;
  - the malicious-release check only counts OSV `MAL-` advisories (ordinary CVEs were blocking upgrades), follows OSV paging, and fails closed when OSV can't be read;
  - the release-age floor of 3 days can't be bypassed.
- **Single sign-on:**
  - the sign-in is bound to the browser that started it (login CSRF);
  - only verified emails link existing accounts;
  - asymmetric ID-token algorithms only;
  - Entra ID multi-tenant and domain-name issuers, Google's issuer forms, `azp` and the Entra groups overage;
  - scopes and client authentication (Basic or Post) can be set;
  - the guide now covers Okta's `groups` scope, Entra group IDs, Auth0 and Keycloak correctly.
- **Models:**
  - DeepSeek tool runs keep `reasoning_content` (turn 2 failed);
  - OpenRouter and Gemini key checks report bad keys correctly;
  - Together and DeepSeek get `max_tokens` and their documented URLs;
  - reasoning effort is capped per provider;
  - the Anthropic spend cap counts every billed fallback attempt and stops on an unknown price;
  - the Claude Code and Codex runs clear every variable that would bill an API instead of your subscription.
- **GitHub:**
  - API version `2026-03-10` everywhere;
  - the app JWT uses the client ID;
  - installations and repositories are paginated;
  - `rescue` works with fine-grained tokens;
  - rate-limit backoff follows GitHub's guidance;
  - the example workflow uses `client-id` and create-github-app-token v3.4.0.
- **MCP:** `/mcp` serves the 2026-07-28 protocol (and the 2025 handshake) and answers 405 to GET. The install guide is fixed for VS Code, Codex timeouts, Zed and Devin Desktop.

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
