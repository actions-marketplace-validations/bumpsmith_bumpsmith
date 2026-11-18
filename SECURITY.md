# Security policy

Bumpsmith runs untrusted code (your dependencies' install and test steps) and asks an AI
model to edit your code, so we take its security model seriously. See
[How Bumpsmith stays safe](README.md#how-bumpsmith-stays-safe).

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
**Security → Report a vulnerability** on this repository
(https://github.com/bumpsmith/bumpsmith/security/advisories/new).

We acknowledge within 2 business days, send a first assessment within 7 days, and aim to
release a fix for critical issues within 7 days. We credit reporters who want credit.
Good-faith research that avoids privacy violations, data destruction and service
disruption is welcome; we will not pursue legal action against it.

Also in scope: the dashboard and `bumpsmith server`. That covers authentication, MFA and SSO (OIDC and SAML), sessions,
CSRF, role-based access and per-repository isolation, encrypted secrets, and the audit log's tamper evidence.

Especially interesting: ways for a dependency, changelog or repository content to make
Bumpsmith write outside the upgrade (prompt injection), escape the sandbox, reach the
network beyond the read-only registry mirror, read secrets from the CI runner, or push to
a branch or file it should not.

## Security controls

- [docs/security/controls.md](docs/security/controls.md): every control, mapped to SOC 2, ISO 27001:2022,
  NIST 800-63B (AAL2) and OWASP ASVS L2. It also covers what the operator of a self-hosted install is responsible for,
  and the known gaps.
- [docs/self-hosting.md](docs/self-hosting.md): deployment, backups, key handling and a hardening checklist.

## Supported versions

The latest minor release of v1 receives security fixes.
