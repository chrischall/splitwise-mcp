# Splitwise MCP Design

**Date:** 2026-03-18
**Status:** Approved

## Overview

A TypeScript MCP server that exposes the Splitwise API to Claude. Primary use case: natural-language transaction and group management — "add that expense to the vacation group", "make sure Meredith and I are in that group".

## Architecture

Follows the same pattern as `ofw-mcp` and `creditkarma-mcp`:

- TypeScript + `@modelcontextprotocol/sdk`
- Single `SplitwiseClient` class (fetch wrapper, auth, retry)
- Tools split into domain files, each exporting `toolDefinitions` + `handleTool`
- `dotenv` for config (loaded at startup in `client.ts`, same as `ofw-mcp` — the `dotenv` package is used, not `node --env-file`)
- `vitest` for tests

### Auth

Splitwise API key auth: `Authorization: Bearer $SPLITWISE_API_KEY`. No login flow or token rotation needed. `SplitwiseClient` reads the key from the `SPLITWISE_API_KEY` env var and attaches it to every request.

All requests send `Content-Type: application/json` and `Accept: application/json`.

**Base URL:** `https://secure.splitwise.com/api/v3.0`

### Transport

`index.ts` uses `StdioServerTransport` (same as `ofw-mcp`).

### File Structure

```
splitwise-mcp/
├── src/
│   ├── client.ts          # SplitwiseClient
│   ├── index.ts           # MCP server + tool dispatch
│   └── tools/
│       ├── user.ts        # sw_get_current_user
│       ├── groups.ts      # group tools
│       ├── friends.ts     # sw_list_friends
│       ├── expenses.ts    # expense tools
│       └── utilities.ts   # categories, currencies, notifications
├── tests/
│   ├── client.test.ts
│   └── tools/
│       ├── user.test.ts
│       ├── groups.test.ts
│       ├── friends.test.ts
│       ├── expenses.test.ts
│       └── utilities.test.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## API Endpoint Map

All implemented tools and their corresponding HTTP method + path:

| Tool | Method | Path |
|------|--------|------|
| `sw_get_current_user` | GET | `/get_current_user` |
| `sw_list_groups` | GET | `/get_groups` |
| `sw_get_group` | GET | `/get_group/{id}` |
| `sw_create_group` | POST | `/create_group` |
| `sw_add_user_to_group` | POST | `/add_user_to_group` |
| `sw_remove_user_from_group` | POST | `/remove_user_from_group` |
| `sw_list_friends` | GET | `/get_friends` |
| `sw_list_expenses` | GET | `/get_expenses` |
| `sw_get_expense` | GET | `/get_expense/{id}` |
| `sw_create_expense` | POST | `/create_expense` |
| `sw_update_expense` | POST | `/update_expense/{id}` |
| `sw_delete_expense` | POST | `/delete_expense/{id}` |
| `sw_get_notifications` | GET | `/get_notifications` |
| `sw_get_categories` | GET | `/get_categories` |
| `sw_get_currencies` | GET | `/get_currencies` |

## Tools

All tools return the raw Splitwise API response serialized as JSON text (`JSON.stringify(data, null, 2)`), same as `ofw-mcp`. No field pruning.

### Implemented (15 tools)

#### `user.ts`
- **`sw_get_current_user`** — Returns the authenticated user's profile including `id`, `first_name`, `last_name`, `email`. Claude uses the `id` field when constructing custom expense splits.

#### `groups.ts`
- **`sw_list_groups`** — List all of the current user's groups. Response includes `id`, `name`, `members[]`. Claude uses this to resolve group names like "vacation group" to a group ID.
- **`sw_get_group`** — Get a single group's details including member list and balances. Input: `id` (integer).
- **`sw_create_group`** — Create a new group. Input: required `name` (string), optional `group_type` (one of: `"apartment"`, `"house"`, `"trip"`, `"other"`), optional `simplify_by_default` (boolean).
- **`sw_add_user_to_group`** — Add a user to a group. Input schema has required `group_id` plus optional `user_id`, `first_name`, `last_name`, `email`. Mode selection:
  - If `user_id` is provided: sends `{ group_id, user_id }` (preferred — use `sw_list_friends` to resolve a name to ID first)
  - Otherwise: sends `{ group_id, first_name, last_name, email }` — all three of `first_name`, `last_name`, `email` are required in this mode. Throw `Error('first_name, last_name, and email are required when user_id is not provided')` if any are missing.
- **`sw_remove_user_from_group`** — Remove a user from a group. Input: `group_id` (integer), `user_id` (integer). Returns API response as JSON text.

#### `friends.ts`
- **`sw_list_friends`** — List all friends with their `id`, `first_name`, `last_name`, `email`. Claude uses this to resolve names like "Meredith" to a `user_id` before calling `sw_add_user_to_group` or building a custom split.

#### `expenses.ts`
- **`sw_list_expenses`** — List/search expenses. Query params passed through only when provided by caller (never send defaults): `group_id`, `friend_id`, `dated_after` (ISO 8601), `dated_before` (ISO 8601), `updated_after`, `updated_before`, `limit`, `offset`. API default for `limit` is 20 when omitted.
- **`sw_get_expense`** — Get full details of a single expense by `id`.
- **`sw_create_expense`** — Create an expense. Two mutually exclusive split modes (providing both `split_equally: true` and a `users` array is an error — throw `Error('Provide either split_equally or users, not both')`):
  - *Equal split:* required `group_id`, `description`, `cost` (string, 2 decimal places e.g. `"25.00"`), `split_equally: true`. JSON body: `{ group_id, description, cost, split_equally: true, ...optionals }`. No `users__N__*` fields.
  - *Custom split:* required `group_id`, `description`, `cost` (string), and `users` array of `{ user_id, paid_share, owed_share }` (shares as decimal strings). The tool flattens this to Splitwise's flat-param JSON format: top-level keys `users__0__user_id`, `users__0__paid_share`, `users__0__owed_share`, `users__1__user_id`, etc. No `split_equally` field. Share validation (that paid_shares sum to cost, owed_shares sum to cost) is **delegated to the Splitwise API** — no client-side validation.
  - Optional fields (both modes): `currency_code` (string, e.g. `"USD"`), `date` (ISO 8601), `category_id` (integer), `details` (string notes).
- **`sw_update_expense`** — Edit an existing expense. Input: `expense_id` (integer) plus any subset of the same fields as `sw_create_expense`. Same mutual exclusion applies: `split_equally: true` and `users` array cannot both be present. Uses the same flat-param format for custom splits. Important: when providing a `users` array for a custom split update, the **full set of users must be included** — the Splitwise API replaces the entire split, not individual entries. Only non-split fields (description, cost, date, etc.) can be partially updated without re-sending the full user list.
- **`sw_delete_expense`** — Soft-delete an expense by `id`. Returns `{ success: true }` from the API. Note: restoring a deleted expense requires `sw_undelete_expense` which is not yet implemented (see stubs below).

#### `utilities.ts`
- **`sw_get_notifications`** — Recent activity feed for the current user.
- **`sw_get_categories`** — Hierarchical list of expense categories including `id` and `name`. Useful for tagging expenses via `category_id`.
- **`sw_get_currencies`** — List of supported currencies with `currency_code` and `unit`. Useful for non-USD expenses.

### Not Implemented (stubs with `// TODO` comments)

Each tool file will include `// TODO` comment blocks for these endpoints so they can be added later:

- **`sw_get_user`** — Get another user's profile by ID (`GET /get_user/{id}`)
- **`sw_update_user`** — Update the current user's profile (`POST /update_user/{id}`)
- **`sw_delete_group`** — Delete a group (`POST /delete_group/{id}`)
- **`sw_undelete_group`** — Restore a soft-deleted group (`POST /undelete_group/{id}`)
- **`sw_create_friend`** — Add a friend by email (`POST /create_friend`)
- **`sw_delete_friend`** — Remove a friendship (`POST /delete_friend/{id}`)
- **`sw_undelete_expense`** — Restore a soft-deleted expense (`POST /undelete_expense/{id}`)
- **`sw_get_comments`** — Get comments on an expense (`GET /get_comments?expense_id=`)
- **`sw_create_comment`** — Add a comment to an expense (`POST /create_comment`)
- **`sw_delete_comment`** — Delete a comment (`POST /delete_comment/{id}`)

## Data Flow

Typical "add expense to group" flow:
1. Claude calls `sw_list_groups` → finds group ID for "vacation"
2. Claude calls `sw_create_expense` with `group_id`, `description`, `cost`, `split_equally: true`

Typical "make sure Meredith is in that group" flow:
1. Claude calls `sw_list_friends` → finds Meredith's user ID
2. Claude calls `sw_get_group` → checks if Meredith is already in `members[]`
3. If not: Claude calls `sw_add_user_to_group` with `group_id` + `user_id`

## Error Handling

- 401: throw `Error('SPLITWISE_API_KEY is invalid or missing')`
- 429: retry once after 2s in `SplitwiseClient.request()` (applies to all calls). If still 429, throw `Error('Rate limited by Splitwise API')`.
- Other non-2xx: throw `Error(\`Splitwise API error: \${status} \${statusText} for \${method} \${path}\`)`
- Unknown tool name in dispatcher: return `{ isError: true, content: [{ type: 'text', text: 'Unknown tool: <name>' }] }`
- Tool-level validation errors (missing required fields, mutual exclusion): throw `Error('<message>')`, caught by the dispatcher and returned as `isError: true`

## Testing

Tests use `vitest` with `fetch` mocked via `vi.stubGlobal`. No live API calls in tests.

Each tool file gets a test file covering:
- Happy path for each tool
- 401 and 429 handling (`client.test.ts` covers 429 retry logic)
- Tool-level input validation (mutual exclusion, required field checks)

## Configuration

```
SPLITWISE_API_KEY=<your api key>
```

`.env.example` committed to repo (no secrets). `dotenv` loaded in `client.ts` at module load time.

`SplitwiseClient` throws at construction if `SPLITWISE_API_KEY` is not set: `throw new Error('SPLITWISE_API_KEY environment variable is required')`. This is fail-fast — the MCP server will not start without the key.

## Package

```json
{
  "name": "splitwise-mcp",
  "version": "1.0.0",
  "description": "Splitwise MCP server for Claude",
  "type": "module",
  "bin": { "splitwise-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "dotenv": "^17.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```
