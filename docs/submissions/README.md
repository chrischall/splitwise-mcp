# Registry submissions — splitwise-mcp

Ready-to-paste copy for registries that need a manual browser-form submission. Automated pipelines fire on every `v*` tag via `.github/workflows/release.yml`.

## Coverage matrix

| Registry                          | Automated?                               | Where |
| --- | --- | --- |
| npm                               | ✅ `release.yml`                          | `npm publish --provenance` |
| GitHub Releases                   | ✅ `release.yml`                          | `.skill` + `.mcpb` attached |
| modelcontextprotocol/registry     | ✅ `release.yml` (OIDC)                   | `mcp-publisher publish` using `server.json` |
| PulseMCP                          | ✅ transitive (auto-ingests weekly)       | — |
| ClawHub (OpenClaw)                | ✅ conditional on `CLAWHUB_TOKEN`         | `clawhub skill publish` |
| mcpservers.org                    | ❌ manual — [mcpservers.org/submit](https://mcpservers.org/submit) | |
| Anthropic community plugins       | ❌ manual — [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission) | |

## mcpservers.org

- **Server Name:** `splitwise-mcp`
- **Short Description:** `Splitwise expense and group management for Claude — track shared expenses, settle up, add and manage friends/groups, and create custom splits via natural language. Uses the official Splitwise API key auth.`
- **Link:** `https://github.com/chrischall/splitwise-mcp`
- **Category:** `Productivity`
- **Contact Email:** `chris.c.hall@gmail.com`

## Anthropic community plugins

- **Repo URL:** `https://github.com/chrischall/splitwise-mcp`
- **Plugin name:** `splitwise-mcp`
- **Short description:** `Splitwise expense and group management for Claude — track shared expenses, settle up, and manage friends via natural language`
- **Category:** Finance
- **Tags:** splitwise, expenses, finance, groups, friends, mcp
