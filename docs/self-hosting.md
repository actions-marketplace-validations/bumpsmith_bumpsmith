# Self-hosting Bumpsmith

Bumpsmith is one app with two modes:

|              | `bumpsmith dashboard`                   | `bumpsmith server`                                    |
| ------------ | --------------------------------------- | ----------------------------------------------------- |
| Who uses it  | You, on your machine                    | Your team                                             |
| Address      | `http://127.0.0.1:4477`                 | Your HTTPS address, e.g. `https://bumpsmith.acme.dev` |
| Repositories | Folders on this machine, or from GitHub | From GitHub only                                      |
| Data         | `~/.bumpsmith`                          | `--data` / `BUMPSMITH_DATA`                           |

Both modes require you to sign in. Both use the same accounts, roles, access control, SSO and audit log. The hosted
Bumpsmith service runs this same code.

## Quick start with Docker Compose

This needs a Linux host with Docker, and a DNS name pointing at it with ports 80 and 443 open. Caddy gets a
certificate from Let's Encrypt automatically.

```sh
git clone https://github.com/bumpsmith/bumpsmith && cd bumpsmith/deploy
echo "BUMPSMITH_DOMAIN=bumpsmith.acme.dev" > .env
openssl rand -base64 32 > master.key && chmod 600 master.key
docker compose up -d
docker compose logs bumpsmith        # the one-time setup link
```

Open the setup link to create the owner account. It works once and expires after an hour. Restart the container
to get a new one.

Onboarding then walks you through these steps in the browser:

- **Two-factor authentication** for the owner.
- **GitHub:** create a GitHub App in one click, or paste a fine-grained token.
- **A model key:** it is checked live with the provider.
- **The first repository.**
- **Inviting the team.**

You don't edit any environment variables or YAML along the way.

**What the compose file does:**

| Setting          | Effect                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reverse proxy    | Bumpsmith is not published on the host; only Caddy reaches it.                                                                                                                       |
| Trusted proxy    | Bumpsmith trusts `X-Forwarded-For` only from Caddy's fixed address (`172.28.0.2`). Otherwise anyone could forge the IP addresses used for rate limits and recorded in the audit log. |
| Container limits | Read-only root filesystem, no Linux capabilities, `no-new-privileges`, non-root user (uid 10001).                                                                                    |
| Master key       | Passed as a Docker secret (`BUMPSMITH_MASTER_KEY_FILE`). It is not kept in the data volume.                                                                                          |

## Running upgrades on the server

The server runs each upgrade in a Docker sandbox, which needs a Docker engine. It also bind-mounts repository
folders, so the engine must see the same paths as Bumpsmith.

You don't need to do anything here if your upgrades run in CI through the GitHub Action. In that case the server
is where you review, apply and manage them.

There are two ways to let the server run upgrades itself:

1. **Recommended: a VM with Docker, using systemd.**
   - Use [`deploy/bumpsmith.service`](../deploy/bumpsmith.service).
   - It runs `bumpsmith server` as a locked-down system user, with the master key passed through `LoadCredential`.
   - Put Caddy or nginx in front of it.
2. **The compose stack plus the host's Docker engine:** run `docker compose -f compose.yaml -f compose.sandbox.yaml up -d`.
   - The data folder is mounted at the same path inside and outside the container (`/var/lib/bumpsmith`).
   - **Access to the Docker socket is root on that host.** Dedicate the host to Bumpsmith.

## `bumpsmith server` reference

```
bumpsmith server --public-url https://bumpsmith.acme.dev
                 [--host 0.0.0.0] [--port 4477] [--data /var/lib/bumpsmith]
                 [--tls-cert cert.pem --tls-key key.pem | --behind-proxy [--trusted-proxy 10.0.0.5,10.0.0.6]]
```

Every variable, with model keys and optional ones, is listed in [`.env.example`](../.env.example).

| Flag                      | Environment variable                      | Meaning                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--public-url`            | `BUMPSMITH_PUBLIC_URL`                    | **Required.** The address people open. It is the only `Host` and `Origin` the server accepts, and the base of every link it hands out (invitations, SSO callbacks, GitHub App). It must be `https://`, except for `http://localhost`. |
| `--tls-cert`, `--tls-key` | `BUMPSMITH_TLS_CERT`, `BUMPSMITH_TLS_KEY` | Serve HTTPS directly (TLS 1.2 or later). Default port 4443.                                                                                                                                                                           |
| `--behind-proxy`          | `BUMPSMITH_BEHIND_PROXY=1`                | A reverse proxy terminates TLS. Binds 127.0.0.1 unless `--host` says otherwise.                                                                                                                                                       |
| `--trusted-proxy`         | `BUMPSMITH_TRUSTED_PROXIES`               | Exact IP addresses whose `X-Forwarded-For` is believed. Default `127.0.0.1,::1`.                                                                                                                                                      |
| `--host`, `--port`        | `BUMPSMITH_HOST`, `BUMPSMITH_PORT`        | Bind address and port. The server fails if the port is taken; it does not move to another port.                                                                                                                                       |
| `--data`                  | `BUMPSMITH_DATA`                          | Database, encryption key file and cloned repositories. Default `~/.bumpsmith`.                                                                                                                                                        |
|                           | `BUMPSMITH_MASTER_KEY_FILE`               | A file holding the 32-byte, base64 master key, such as a Docker or Kubernetes secret or a file decrypted from your KMS at boot.                                                                                                       |
|                           | `BUMPSMITH_MASTER_KEY`                    | The same key in an environment variable. Prefer the file.                                                                                                                                                                             |

**Rules the server enforces:**

- An `https` public URL needs either TLS flags or `--behind-proxy`, never both.
- `/healthz` answers `{"ok":true}` for load balancers and container health checks. It answers any `Host` and returns no data.

**Reverse proxy requirements:**

- Pass the original `Host` header through. Caddy and nginx's `proxy_set_header Host $host` both do.
- Append the client address to `X-Forwarded-For`.
- Don't buffer `text/event-stream` responses: live run logs use them.

## Data, backups and restore

Everything lives in the data folder. Bumpsmith creates it with permissions 0700, and its files with 0600.

| File                              | What it is                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bumpsmith.db` (+ `-wal`, `-shm`) | SQLite in WAL mode. It holds accounts, sessions, roles, access grants, the audit log, settings, and secrets encrypted with AES-256-GCM. |
| `master.key`                      | The encryption key, if you did not supply one.                                                                                          |
| `workspaces/`                     | Clones of connected repositories and their runs. These can be re-cloned.                                                                |

**Back up:**

- **The database:** take a consistent online copy, then encrypt it and send it off the host.

  ```sh
  sqlite3 /var/lib/bumpsmith/bumpsmith.db ".backup '/backups/bumpsmith-$(date +%F).db'"
  ```
- **The master key, separately from the database backups.** Without the key, stored secrets cannot be decrypted:
  GitHub credentials, model keys and the OIDC client secret. Store the key apart from the backups, so a stolen
  backup alone does not reveal them.

**Restore:**

1. Stop the server.
2. Put the database copy in place as `bumpsmith.db` and delete any `-wal` and `-shm` files.
3. Supply the same master key.
4. Start the server.
5. Check **Audit log → Chain intact**, which confirms the log was not edited.

## Upgrades

**Upgrade order:**

1. Take a backup.
2. Pull the new image or package version.
3. Restart.

Database migrations run automatically at start-up. They only add to the schema, so they are safe to run on a
copy first.

Read the [changelog](../CHANGELOG.md) for anything marked **security**.

## Rotating keys and credentials

| What                                                                 | How                                                                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App private key, GitHub token, model keys, OIDC client secret | Replace them in **Organisation → Integrations** or **Security**. The old value is overwritten, and the change is recorded in the audit log.                                |
| Sessions                                                             | **Members → Sign out**, or for your own account **Account → Sign out other sessions**. A password change or reset ends all sessions.                                       |
| Personal API tokens                                                  | They expire on their own. Users revoke them in **Account**; deactivating a member revokes all of theirs.                                                                   |
| Master key                                                           | Not yet automated. **To rotate it:** back up, re-enter the stored secrets after starting with a new key, then destroy the old key. A `bumpsmith rekey` command is planned. |

## Hardening checklist

- [ ] HTTPS only, with HSTS. Bumpsmith sends HSTS whenever its public URL is `https`.
- [ ] Data folder on an encrypted volume; backups encrypted and tested.
- [ ] Master key outside the data volume, through `BUMPSMITH_MASTER_KEY_FILE`. Ideally it comes from your KMS at boot.
- [ ] **Organisation → Security**:
  - [ ] SSO (OIDC or SAML) turned on and enforced;
  - [ ] two-factor required for everyone;
  - [ ] SSO allowed email domains set;
  - [ ] session limits that match your policy.
- [ ] At least two Owners, both with two-factor, kept as break-glass accounts when SSO is enforced.
- [ ] Audit log exported to your SIEM on a schedule. Use **Audit log → Export CSV**, or the `/api/audit/export` endpoint with an `audit.view` API token.
- [ ] Host patched; Docker socket access limited to the Bumpsmith host.
- [ ] Outbound network allowed only to GitHub, your model provider, and npm/PyPI for the registry mirror.

See [security controls](security/controls.md) for how these map to SOC 2, ISO 27001, NIST 800-63B and OWASP ASVS.
