# Bumpsmith for AI agents: MCP server and skill

Bumpsmith is an [MCP](https://modelcontextprotocol.io) server, so any agent or application can ask
it to upgrade a dependency and get back a **verified** result. "Verified" means three things:

- every breaking change is quoted from the release notes;
- the code was fixed in an isolated sandbox;
- the repository's own checks ran before and after, and an independent reviewer checked the diff.

There are two ways to connect:

|              | Local (stdio)                                                                     | Server (HTTP)                                                           |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| For          | Your editor or agent on your machine                                              | Applications and agents connecting to your team's self-hosted Bumpsmith |
| Start        | `npx -y bumpsmith mcp`                                                            | `https://<your-bumpsmith>/mcp`                                          |
| Auth         | None: it runs as you, on your repositories                                        | A personal API token: `Authorization: Bearer bs_pat_…`                  |
| Repositories | The folder it was started in, or any path you pass                                | The workspaces your token can see (the access matrix applies)           |
| Needs        | Node 22.13+, Docker, and a model (an API key, or your Claude Code or Codex login) | Nothing on the client                                                   |

## Install

### Claude Code: plugin with the MCP server and the skill

```text
/plugin marketplace add bumpsmith/bumpsmith
/plugin install bumpsmith@bumpsmith
```

Or only the MCP server:

```sh
claude mcp add bumpsmith -- npx -y bumpsmith@latest mcp
```

### Codex

```sh
codex mcp add bumpsmith -- npx -y bumpsmith@latest mcp
```

### Cursor

[Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=bumpsmith&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJ1bXBzbWl0aEBsYXRlc3QiLCJtY3AiXX0=), or add it to `.cursor/mcp.json`:

```json
{ "mcpServers": { "bumpsmith": { "command": "npx", "args": ["-y", "bumpsmith@latest", "mcp"] } } }
```

### VS Code

[Install in VS Code](https://vscode.dev/redirect/mcp/install?name=bumpsmith&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22bumpsmith%40latest%22%2C%22mcp%22%5D%7D), or run:

```sh
code --add-mcp '{"name":"bumpsmith","command":"npx","args":["-y","bumpsmith@latest","mcp"]}'
```

### Claude Desktop, Windsurf, Zed and anything else

Use command `npx` with args `["-y", "bumpsmith@latest", "mcp"]`. For example, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bumpsmith": {
      "command": "npx",
      "args": ["-y", "bumpsmith@latest", "mcp", "--repo", "/path/to/repo"]
    }
  }
}
```

### A self-hosted Bumpsmith server, over HTTP

1. In Bumpsmith, open **Account → API tokens**.
2. Create a token. Its scopes set what it can do:
   - `runs.view`: read results;
   - `runs.start`: start upgrades;
   - `workspaces.view`: list repositories.
3. Point the client at your server:

```json
{
  "mcpServers": {
    "bumpsmith": {
      "type": "http",
      "url": "https://bumpsmith.acme.dev/mcp",
      "headers": { "Authorization": "Bearer bs_pat_…" }
    }
  }
}
```

Runs started over MCP appear live in the dashboard and in the audit log. They use your organisation's
model keys, so the client never sees them.

## Tools

| Tool                | What it does                                                                                         | AI?                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `list_repositories` | Repositories you can use                                                                             | no                                              |
| `scan_dependencies` | Direct dependencies a major version (or more) behind                                                 | no                                              |
| `check_release`     | Is a version safe to adopt? Checks publish age, yanked, deprecated, and malicious (OSV)              | no                                              |
| `api_diff`          | Exports removed, added or changed between two versions of an npm package, from its type definitions  | no                                              |
| `explain_upgrade`   | The breaking changes, quoted from upstream, and every affected line in the repository                | yes, a few cents                                |
| `start_upgrade`     | Upgrade, fix, verify and review in the sandbox. Runs in the background; returns an id                | yes, typically under $1, capped at `budget_usd` |
| `get_upgrade`       | A run's status, or its result and evidence (and the patch, if asked)                                 | no                                              |
| `list_upgrades`     | Recent runs and their states                                                                         | no                                              |
| `apply_upgrade`     | Stage a `ready` or `safe` patch with `git apply --index`. Local only; unverified results are refused | no                                              |

Results have one of five states:

| State            | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `ready`          | Verified, and the review approved it.                                   |
| `safe`           | A version bump only; the checks pass.                                   |
| `needs_human`    | Bumpsmith could not prove the change.                                   |
| `blocked_policy` | Refused: the release is malicious or too new, or a safety rule tripped. |
| `failed_infra`   | The sandbox could not run the repository.                               |

## The skill

[`skills/bumpsmith/SKILL.md`](../skills/bumpsmith/SKILL.md) teaches an agent when to reach for
Bumpsmith and how to use it:

- the order of calls;
- how to read each state;
- how to report back.

It also sets rules: never present a `needs_human` result as fixed, and never work around the release
gate. It installs with the Claude Code plugin above.

For other agents that read skills, copy the `skills/bumpsmith` folder into the agent's skills
directory, or install it with:

```sh
npx skills add bumpsmith/bumpsmith
```

## Security

- **Local:** the stdio server only reaches folders you point it at, and runs as you.
  - Upgrades run in the same isolated sandbox as the CLI, with no credentials and no network except a
    read-only registry mirror.
  - `apply_upgrade` stages a verified patch. It never commits or pushes.
- **HTTP:** `/mcp` accepts only personal API tokens, which expire and are revocable.
  - Requests from other web origins are refused.
  - The token's scopes and the access matrix limit every tool, and a repository you can't see answers
    as if it didn't exist.
  - API tokens can't apply patches or manage accounts.
- **Output:** secrets found in output are masked before they reach the client.
