# splitwise-mcp

MCP server for Splitwise. Wraps the Splitwise REST API (`https://secure.splitwise.com/api/v3.0`) and exposes 27 tools to Claude over stdio. Built on `@chrischall/mcp-utils` (`runMcp`, `createApiClient`, `readEnvVar`, `textResult`).

## Commands

```bash
npm run build          # tsc + esbuild bundle → dist/index.js + dist/bundle.js
npm test               # tsc typecheck + vitest run
npm run test:watch     # vitest watch
npm run test:coverage  # tsc typecheck + vitest run --coverage (v8 reporter, no thresholds)
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
    receipts.ts   # sw_get_receipt — authenticated receipt download,
                  #   inline bytes, and PDF text extraction
    utilities.ts  # sw_get_notifications, sw_get_categories, sw_get_currencies,
                  #   sw_get_comments, sw_create_comment, sw_delete_comment
```

Each tool file exports a `register<Domain>Tools(server, client)` function that calls `server.registerTool(name, { description, annotations, inputSchema }, handler)` (high-level `McpServer` API with zod schemas). The `SplitwiseClient` is INJECTED as the second argument rather than imported as a module singleton — a hosted per-user deployment builds one client per authenticated user, which a singleton cannot express. `index.ts` passes the register functions to `runMcp`, which builds the `McpServer`, calls each, and connects the stdio transport.

## Environment

```
SPLITWISE_API_KEY=<your key>   # Required. From https://secure.splitwise.com/apps/register
SPLITWISE_OUTPUT_DIR=<path>    # Optional. Where sw_get_receipt writes files (default: cwd)
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
skills/splitwise-mcp/
  SKILL.md          # Claude Code skill — teaches Claude when/how to use the tools
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

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

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
- **Receipts need auth**: the `receipt.original` / `receipt.large` URLs on an expense 401 without the API key. `sw_get_receipt` re-fetches them through `SplitwiseClient.fetchAsset`, which builds a per-origin `createApiClient` and attaches the key **only** for `*.splitwise.com` hosts — a receipt can also be served from a presigned S3 URL, which must never see the key. Errors from that path run through `redactAssetQuery`, which scrubs the exact query bytes that were sent, so a signed query string can't land in a tool result — including when an upstream echoes the whole URL back in its error body.
- **Receipts must not depend on the filesystem**: `sw_get_receipt`'s file write is *best effort*. A hosted deployment runs from a read-only npm cache, so an unconditional write fails the whole call (`EACCES` on `<cache>/node_modules/splitwise-mcp/...`) and the caller — whose sandbox is a different filesystem anyway — can never read the path. The write is wrapped: on failure the tool reports `write_error` and still returns whatever content was asked for, and it only throws when nothing at all reached the caller (no file, no `inline`, no `text`) — with an error naming `inline:true` / `extract_text:true` as the way out. `inline` covers every type: an image block for images, an MCP embedded resource (`{type:'resource', resource:{uri, mimeType, blob}}`) for PDFs and anything else.
- **`unpdf` is lazily imported**: `extract_text` pulls a full pdf.js build (~2.4 MB in `dist/bundle.js`). It's behind `await import('unpdf')` inside the handler so no other receipt path — and no server startup — pays for it. `getDocumentProxy` detaches the buffer it's handed, so `extractPdfText` copies via `Uint8Array.from` first; without that copy the base64 and the file write would see an empty buffer.
- **`manifest.json` tool list**: nothing generates it. `tests/index.test.ts` asserts it matches the registered tools — add new tools in both places.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
