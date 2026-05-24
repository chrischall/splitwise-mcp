# splitwise-mcp

MCP server for Splitwise. Wraps the Splitwise REST API (`https://secure.splitwise.com/api/v3.0`) and exposes 24 tools to Claude over stdio.

## Commands

```bash
npm run build          # tsc + esbuild bundle → dist/index.js + dist/bundle.js
npm test               # vitest run
npm run test:watch     # vitest watch
npm run test:coverage  # vitest run --coverage (v8 reporter, no thresholds)
```

Run locally (requires built `dist/`):
```bash
SPLITWISE_API_KEY=xxx node dist/index.js
```

## Tool naming

All tools are prefixed `sw_` (e.g. `sw_list_expenses`, `sw_create_expense`).

## Architecture

```
src/
  index.ts        # MCP server entry — constructs McpServer + SplitwiseClient,
                  #   calls each register*Tools(), connects StdioServerTransport
  client.ts       # SplitwiseClient — reads SPLITWISE_API_KEY, bearer-auth fetch,
                  #   one 2s retry on 429, throws on 401
  tools/
    user.ts       # sw_get_current_user, sw_get_user, sw_update_user
    groups.ts     # sw_list_groups, sw_get_group, sw_create_group,
                  #   sw_delete_group, sw_undelete_group,
                  #   sw_add_user_to_group, sw_remove_user_from_group
    friends.ts    # sw_list_friends, sw_create_friend, sw_delete_friend
    expenses.ts   # sw_list_expenses, sw_get_expense, sw_create_expense,
                  #   sw_update_expense, sw_delete_expense, sw_undelete_expense
    utilities.ts  # sw_get_notifications, sw_get_categories, sw_get_currencies,
                  #   sw_get_comments, sw_create_comment, sw_delete_comment
```

Each tool file exports a `register<Domain>Tools(server, client)` function that calls `server.registerTool(name, { description, annotations, inputSchema }, handler)` (high-level `McpServer` API with zod schemas). `index.ts` just wires them all up.

## Environment

```
SPLITWISE_API_KEY=<your key>   # Required. From https://secure.splitwise.com/apps/register
```

Loaded via `dotenv` from `.env` next to `dist/`. `dotenv` is imported dynamically and failure is swallowed (mcpb bundles omit it; env is provided by the host). `readVar()` in `client.ts` treats blank, `"undefined"`, `"null"`, and unsubstituted `${FOO}` placeholders as unset.

## Testing

Tests live in `tests/` (vitest). No real API calls — `fetch` is mocked. `tests/helpers.ts` builds the fake transport / client. Coverage is collected (v8) but no thresholds are enforced.

## Plugin / Marketplace

```
.claude-plugin/
  plugin.json       # Claude Code plugin manifest (skill + .mcp.json reference)
  marketplace.json  # Marketplace catalog entry (category: finance)
.mcp.json           # MCP server config referenced by plugin.json
manifest.json       # mcpb manifest (display name, user_config, tool list)
server.json         # MCP registry submission (modelcontextprotocol/registry)
SKILL.md            # Claude Code skill — teaches Claude when/how to use the tools
```

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → bumped automatically by `npm version patch`
3. `src/index.ts` → `McpServer({ name, version: 'x.y.z' })`
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version` (two entries)
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → outer `metadata.version` and `plugins[].version`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Tag & Bump** GitHub Action (`.github/workflows/tag-and-bump.yml`).

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Tag & Bump** Action which:

1. Runs CI (`build` + `test`)
2. Tags the current commit with the current `package.json` version
3. Bumps patch via `npm version patch` and a node script that walks every JSON version field (plus a `sed` for `src/index.ts`)
4. Rebuilds, commits, and pushes `main` + tag

The tag push triggers `.github/workflows/release.yml` which: rebuilds, syncs version files, packages a `.skill` zip, runs `npx @anthropic-ai/mcpb pack` for a `.mcpb` bundle, `npm publish --provenance`, and publishes to the MCP Registry via `mcp-publisher` (OIDC).

<!-- pr-workflow:v1 -->
## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* skip auto-generated release notes — GitHub's `generate_release_notes` (configured in `.github/release.yml`) only picks up merged PRs. Push directly to `main` only when the user explicitly asks for it (e.g. emergency hotfix).

For every PR, apply exactly one label so it lands in the right release-notes section:

| Label                | Section in release notes |
|----------------------|--------------------------|
| `enhancement`        | Features                 |
| `bug`                | Bug Fixes                |
| `security`           | Security                 |
| `refactor`           | Refactor                 |
| `documentation`      | Documentation            |
| `test`               | Tests                    |
| `dependencies`       | Dependencies             |
| `ci` / `github_actions` | CI & Build            |
| *(none / unmatched)* | Other Changes            |
| `ignore-for-release` | Hidden from notes        |

The **PR title** becomes the bullet — write it like a user-facing changelog entry (`sw_create_expense: reject conflicting split args`), not internal shorthand (`expense tweaks`). Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { SplitwiseClient } from './client.js'`).
- **Rate limiting**: 429 retries once after 2s, then throws `Rate limited by Splitwise API`. Splitwise rate limits are undocumented.
- **Startup validation**: `SplitwiseClient` throws immediately if `SPLITWISE_API_KEY` is missing, blank, `"undefined"`, `"null"`, or an unsubstituted `${...}` placeholder.
- **Build before run**: `dist/` must exist. `npm run build` runs `tsc` (→ `dist/index.js` + per-file output) and then `esbuild` bundling to `dist/bundle.js` (the mcpb manifest entry point).
- **`cost` as strings**: Splitwise wants decimal strings (`"25.00"`), not numbers — `paid_share`/`owed_share` likewise.
- **`split_equally` vs `users[]`**: mutually exclusive in `sw_create_expense` / `sw_update_expense`. `buildExpenseBody` throws if both are passed. Custom splits are flattened into `users__N__user_id` / `..._paid_share` / `..._owed_share` keys.
- **Update replaces the split**: `sw_update_expense` users array must be the FULL participant list — the API replaces, not merges.
- **Soft delete / restore**: delete tools soft-delete; pair each with the matching `*_undelete_*` tool (or the Splitwise web UI).
- **stdio transport**: server logs to **stderr** only — stdout is reserved for JSON-RPC. Same applies to anything added later.
- **Comments live in `utilities.ts`**: `sw_get_comments` / `sw_create_comment` / `sw_delete_comment` are registered by `registerUtilityTools`, not by the expense tools file.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
