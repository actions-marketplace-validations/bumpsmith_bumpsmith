# Changelog

## 0.1.0 — unreleased

First public release.

- CLI: `bumpsmith fix`, `explain`, `scan`.
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
