# splitwise-mcp

MCP server for Splitwise. Wraps the Splitwise REST API (`https://secure.splitwise.com/api/v3.0`) and exposes 25 tools to Claude over stdio. Built on `@chrischall/mcp-utils` (`runMcp`, `createApiClient`, `readEnvVar`, `textResult`).

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
  index.ts        # MCP server entry — calls runMcp() from @chrischall/mcp-utils
                  #   with name/version/banner + the register*Tools array
  client.ts       # SplitwiseClient (createApiClient wrapper) + exported `client`
                  #   singleton; reads SPLITWISE_API_KEY, 1× 2s retry, 30s timeout
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

Each tool file exports a `register<Domain>Tools(server)` function that calls `server.registerTool(name, { description, annotations, inputSchema }, handler)` (high-level `McpServer` API with zod schemas) and imports the shared `client` singleton from `./client.js`. `index.ts` passes the register functions to `runMcp`, which builds the `McpServer`, calls each, and connects the stdio transport.

## Environment

```
SPLITWISE_API_KEY=<your key>   # Required. From https://secure.splitwise.com/apps/register
```

Loaded via `loadDotenvSafely` (from `@chrischall/mcp-utils`) from `.env` next to `dist/`, with `override: false` so a host-provided value always wins; a missing `dotenv` module is swallowed (mcpb bundles externalize it — see `bundle` script's `--external:dotenv` — and the host provides env). `readEnvVar` (also from `@chrischall/mcp-utils`) treats blank, `"undefined"`, `"null"`, and unsubstituted `${FOO}` placeholders as unset.

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

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by **release-please** (`.github/workflows/release-please.yml`). `release-please-config.json` registers all of the files above as `extra-files`, so a single release PR bumps them in lockstep.

### Release workflow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a `chore(main): release X.Y.Z` PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR (arm `ready-to-merge`) creates the tag and a GitHub Release; the `publish` job then packs a `.mcpb` bundle (`npx @anthropic-ai/mcpb pack`) and `.skill` zip, runs `npm publish --provenance`, and publishes to the MCP Registry via `mcp-publisher` (OIDC).

<!-- pr-workflow:v2 -->
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

The **PR title MUST be a Conventional Commit**, written user-facing (`fix(scope): …`, `feat(scope): …`), not internal shorthand. Because the repo squash-merges, the PR title *becomes the squash commit's subject line* — the only thing release-please parses to pick the version bump and changelog section. Only `feat` (minor), `fix` (patch), and `!`/`BREAKING CHANGE` (major) cut a release; `perf`/`refactor`/`docs` show in the changelog without bumping; `ci`/`test`/`build`/`chore` are recognised but hidden (see `release-please-config.json` → `changelog-sections`). A title without a conventional type is invisible to release-please — no bump, no changelog line. Prefixes in *individual commits* don't help; squash keeps only the title.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` (a thin stub calling `chrischall/workflows`) runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). A `pass` **or** `warn` verdict adds the `ready-to-merge` label; a `warn` or `fail` also opens/updates an `auto-review-followup` issue (see below). Only a `fail` blocks the merge.
2. `auto-merge.yml` (also a stub calling `chrischall/workflows`), on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { SplitwiseClient } from './client.js'`).
- **Rate limiting**: 429 retries once after 2s (via `createApiClient`'s `retry`), then throws `Rate limited by Splitwise API`. Splitwise rate limits are undocumented.
- **Deferred config error**: `SplitwiseClient` does **not** throw at startup when `SPLITWISE_API_KEY` is missing/blank/`"undefined"`/`"null"`/unsubstituted `${...}` — it stores the error and re-raises it on the first tool request. This lets the server boot and answer the host's install-time `tools/list` smoke test without a key. A 401 from the API surfaces as `SPLITWISE_API_KEY is invalid or missing`.
- **Build before run**: `dist/` must exist. `npm run build` runs `tsc` (→ `dist/index.js` + per-file output) and then `esbuild` bundling to `dist/bundle.js` (the mcpb manifest entry point).
- **`cost` as strings**: Splitwise wants decimal strings (`"25.00"`), not numbers — `paid_share`/`owed_share` likewise.
- **`split_equally` vs `users[]`**: mutually exclusive in `sw_create_expense` / `sw_update_expense`. `buildExpenseBody` throws if both are passed. Custom splits are flattened into `users__N__user_id` / `..._paid_share` / `..._owed_share` keys.
- **Update replaces the split**: `sw_update_expense` users array must be the FULL participant list — the API replaces, not merges.
- **Soft delete / restore**: delete tools soft-delete; pair each with the matching `*_undelete_*` tool (or the Splitwise web UI).
- **stdio transport**: server logs to **stderr** only — stdout is reserved for JSON-RPC. Same applies to anything added later.
- **Comments live in `utilities.ts`**: `sw_get_comments` / `sw_create_comment` / `sw_delete_comment` are registered by `registerUtilityTools`, not by the expense tools file.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
