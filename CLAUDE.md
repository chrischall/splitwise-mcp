# splitwise-mcp

MCP server for Splitwise. Exposes Splitwise API operations as Claude tools via stdio transport.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm test               # Run tests (vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

Run locally (requires built dist):
```bash
SPLITWISE_API_KEY=xxx node dist/index.js
```

## Tool naming

All tools are prefixed `sw_` (e.g. `sw_list_expenses`, `sw_create_expense`).

## Architecture

```
src/
  index.ts        # MCP server entry point — registers all tools, starts stdio transport
  client.ts       # SplitwiseClient — wraps Splitwise REST API with auth
  tools/
    user.ts       # sw_get_current_user
    groups.ts     # sw_list_groups, sw_get_group, sw_create_group, sw_add/remove_user_to_group
    friends.ts    # sw_list_friends
    expenses.ts   # sw_list/get/create/update/delete_expense
    utilities.ts  # sw_get_notifications, sw_get_categories, sw_get_currencies
```

Each tool file exports `toolDefinitions` (MCP tool schemas) and `handleTool` (request handler). `index.ts` aggregates all tools and routes by name.

## Environment

```
SPLITWISE_API_KEY=<your key>   # Required. Set in .env or environment.
```

Get a key at: https://secure.splitwise.com/apps/register

## Testing

Tests live in `tests/`. Run with `npm test`. No real API calls — client is mocked.

## Plugin / Marketplace

```
.claude-plugin/
  plugin.json       # Claude Code plugin manifest (MCP server config)
  marketplace.json  # Marketplace catalog entry
SKILL.md            # Claude Code skill — teaches Claude when/how to use the tools
```

## Versioning

Version appears in FOUR places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → run `npm install --package-lock-only` after changing package.json
3. `src/index.ts` → `Server` constructor `version` field
4. `manifest.json` → `"version"`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Cut & Bump** GitHub Action.

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Cut & Bump** GitHub Action (`cut-and-bump.yml`) which:

1. Runs CI (build + test)
2. Tags the current commit with the current version
3. Bumps patch in all four files
4. Rebuilds, commits, and pushes main + tag
5. The tag push triggers the **Release** workflow (CI + npm publish + GitHub release)

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { SplitwiseClient } from './client.js'`).
- **Rate limiting**: 429 responses throw immediately — no retry. Splitwise has undocumented rate limits.
- **API base**: all requests go to `https://secure.splitwise.com/api/v3.0`.
- **Startup validation**: `SplitwiseClient` throws immediately if `SPLITWISE_API_KEY` is missing.
- **Build before run**: `dist/` must exist before running the server manually.
- **`cost` as strings**: cost values are always decimal strings (`"25.00"`), not numbers.
- **`split_equally` vs `users[]`**: mutually exclusive in create/update.
- **Soft delete**: `sw_delete_expense` soft-deletes — restoration requires the Splitwise web UI.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
