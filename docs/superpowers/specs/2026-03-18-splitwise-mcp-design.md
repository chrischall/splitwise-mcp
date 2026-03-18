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
- `dotenv` for config
- `vitest` for tests

### Auth

Splitwise supports API key auth: `Authorization: Bearer $SPLITWISE_API_KEY`. No login flow or token rotation needed. The client reads the key from the `SPLITWISE_API_KEY` env var and attaches it to every request. On 401 it throws a clear error. On 429 it retries once after a 2s delay.

**Base URL:** `https://secure.splitwise.com/api/v3.0`

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
│   ├── tools/
│   │   ├── user.test.ts
│   │   ├── groups.test.ts
│   │   ├── friends.test.ts
│   │   ├── expenses.test.ts
│   │   └── utilities.test.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Tools

### Implemented (15 tools)

#### `user.ts`
- **`sw_get_current_user`** — Returns the authenticated user's profile including user ID. Useful for Claude to know who "I" is when constructing expense splits.

#### `groups.ts`
- **`sw_list_groups`** — List all of the current user's groups. Claude uses this to resolve group names like "vacation group" to a group ID.
- **`sw_get_group`** — Get a single group's details including member list and balances.
- **`sw_create_group`** — Create a new group. Body: `name`, optional `group_type`, optional `simplify_by_default`.
- **`sw_add_user_to_group`** — Add a user to a group. Supports two modes: by `user_id` (preferred, use `sw_list_friends` first), or by `first_name` + `last_name` + `email` (invites a new user).
- **`sw_remove_user_from_group`** — Remove a user from a group by `group_id` + `user_id`.

#### `friends.ts`
- **`sw_list_friends`** — List all friends with their user IDs. Claude uses this to resolve names like "Meredith" to a user ID before calling `sw_add_user_to_group`.

#### `expenses.ts`
- **`sw_list_expenses`** — List/search expenses. Filters: `group_id`, `friend_id`, `dated_after`, `dated_before`, `updated_after`, `updated_before`, `limit` (default 20), `offset`.
- **`sw_get_expense`** — Get full details of a single expense by ID.
- **`sw_create_expense`** — Create an expense. Two split modes:
  - *Equal split:* `group_id`, `description`, `cost`, `split_equally: true`, optional `currency_code`, `date`, `category_id`, `details`.
  - *Custom split:* `group_id`, `description`, `cost`, plus `users` array of `{user_id, paid_share, owed_share}`. The tool flattens this to Splitwise's `users__N__user_id` / `users__N__paid_share` / `users__N__owed_share` flat-param format before sending.
- **`sw_update_expense`** — Edit an existing expense. Accepts the same fields as `sw_create_expense` plus `expense_id`. Only provided fields are updated.
- **`sw_delete_expense`** — Soft-delete an expense by ID (restorable via API).

#### `utilities.ts`
- **`sw_get_notifications`** — Recent activity feed for the current user.
- **`sw_get_categories`** — List all expense categories (hierarchical). Useful for tagging expenses.
- **`sw_get_currencies`** — List all supported currency codes.

### Not Implemented (stubs with TODO comments)

The following endpoints are defined in the OpenAPI spec but not implemented. Each tool file will contain a `// TODO` comment block so they can be added later:

- **`sw_get_user`** — Get another user's profile by ID (`GET /get_user/{id}`)
- **`sw_update_user`** — Update the current user's profile (`POST /update_user/{id}`)
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
2. Claude calls `sw_get_current_user` → gets own user ID
3. Claude calls `sw_create_expense` with `group_id`, `description`, `cost`, `split_equally: true`

Typical "make sure Meredith is in that group" flow:
1. Claude calls `sw_list_friends` → finds Meredith's user ID
2. Claude calls `sw_get_group` → checks if Meredith is already a member
3. If not: Claude calls `sw_add_user_to_group` with `group_id` + `user_id`

## Error Handling

- 401: throw `Error('SPLITWISE_API_KEY is invalid or missing')` — surfaces cleanly in MCP
- 429: retry once after 2s, then throw `Error('Rate limited by Splitwise API')`
- Other non-2xx: throw `Error(\`Splitwise API error: \${status} \${statusText} for \${method} \${path}\`)`
- Unknown tool name: return `{ isError: true, content: [{ type: 'text', text: 'Unknown tool: ...' }] }`

## Testing

Tests use `vitest` with `fetch` mocked via `vi.stubGlobal`. No live API calls in tests.

Each tool file gets a test file covering:
- Happy path for each tool
- 401 error handling
- 429 retry logic (for client.test.ts)
- Input validation (required fields)

## Configuration

`.env` / env vars:
```
SPLITWISE_API_KEY=<your api key>
```

`.env.example` committed to repo (no secrets).

## Package

```json
{
  "name": "splitwise-mcp",
  "bin": { "splitwise-mcp": "dist/index.js" },
  "type": "module"
}
```

Same `build` / `dev` / `test` scripts as `ofw-mcp`.
