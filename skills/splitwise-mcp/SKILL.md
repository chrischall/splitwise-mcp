---
name: splitwise-mcp
description: Access Splitwise expense and group data via MCP. Use when the user asks about Splitwise expenses, groups, friends, or balances, or wants to add, edit, or delete expenses. Triggers on phrases like "add that expense to Splitwise", "split this with the vacation group", "make sure Meredith is in that group", "what do I owe", or any request involving shared expenses or group management in Splitwise. Requires splitwise-mcp installed and the splitwise server registered (see Setup below).
---

# splitwise-mcp

MCP server for Splitwise — natural-language expense and group management via the Splitwise API.

- **npm:** [npmjs.com/package/splitwise-mcp](https://www.npmjs.com/package/splitwise-mcp)
- **Source:** [github.com/chrischall/splitwise-mcp](https://github.com/chrischall/splitwise-mcp)

## Setup

### Option A — npx (recommended)

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "npx",
      "args": ["-y", "splitwise-mcp"],
      "env": {
        "SPLITWISE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Option B — from source

```bash
git clone https://github.com/chrischall/splitwise-mcp
cd splitwise-mcp
npm install && npm run build
```

Then add to `.mcp.json`:

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "node",
      "args": ["/path/to/splitwise-mcp/dist/index.js"],
      "env": {
        "SPLITWISE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or use a `.env` file in the project directory with `SPLITWISE_API_KEY=<value>`.

### Getting your API key

1. Go to [splitwise.com/apps/register](https://secure.splitwise.com/apps/register)
2. Register an app (name and description can be anything)
3. Copy the **API key** from the app detail page

## Authentication

API key auth — no login flow or token rotation. The key is attached to every request as `Authorization: Bearer <key>`.

## Tools

### User
| Tool | Description |
|------|-------------|
| `sw_get_current_user(view?)` | Get the authenticated user's profile. On the default `compact` rung that is `id`, `name` (first + last joined), `email`, `registration_status`, `balance`; `first_name` / `last_name` separately are on `view: "full"` |

### Groups
| Tool | Description |
|------|-------------|
| `sw_list_groups(view?)` | List all groups with `id`, `name`, `group_type`, `members[]`, `simplified_debts` and `invite_link`. See [Response shape](#response-shape-view) — this is the response that does not fit at all on `full` |
| `sw_get_group(id, view?)` | Get a single group's details including members and balances |
| `sw_create_group(name, group_type?, simplify_by_default?)` | Create a new group (`group_type`: `apartment`, `house`, `trip`, `other`) |
| `sw_add_user_to_group(group_id, user_id?)` | Add a user by `user_id` (preferred) or `first_name` + `last_name` + `email` |
| `sw_remove_user_from_group(group_id, user_id)` | Remove a user from a group |

### Friends
| Tool | Description |
|------|-------------|
| `sw_list_friends(view?)` | List all friends. On the default `compact` rung each is `id`, `name` (first + last joined), `email`, `registration_status`, `balance`; the separate name fields are on `view: "full"` |

### Expenses
| Tool | Description |
|------|-------------|
| `sw_list_expenses(group_id?, friend_id?, dated_after?, dated_before?, limit?, offset?, view?)` | List or search expenses |
| `sw_get_expense(id, view?)` | Get full details of a single expense |
| `sw_create_expense(group_id, description, cost, split_equally? \| users?)` | Create an expense — equal split or custom per-person split |
| `sw_update_expense(expense_id, ...)` | Edit an existing expense (custom split requires full `users` array) |
| `sw_delete_expense(id)` | Soft-delete an expense |
| `sw_undelete_expense(id)` | Restore a soft-deleted expense |

### Receipts
| Tool | Description |
|------|-------------|
| `sw_get_receipt(id, size?, inline?, extract_text?, output_dir?, write?)` | Download the receipt attached to an expense. `inline: true` returns the bytes in the result (images **and** PDFs); `extract_text: true` returns a PDF's text layer; by default it also writes the file and returns the path |

### Utilities
| Tool | Description |
|------|-------------|
| `sw_get_notifications(view?)` | Recent activity feed for the current user |
| `sw_get_categories` | Hierarchical list of expense categories (use `id` as `category_id`) |
| `sw_get_currencies` | List of supported currency codes |

## Response shape (`view`)

Nine read tools take `view: "compact" | "full"`, and **`compact` is the
default** — you get the slim rung without asking. Two of them are not in the
table above: `sw_get_user(id, view?)` and `sw_get_comments(expense_id, view?)`.

This is not a nicety. A live `sw_list_groups` on a 51-group account came back
as **192,123 characters and was REFUSED by the host before the model saw a byte
of it** — the tool was not expensive, it was unusable. 60% of that response was
image URLs: `avatar` + `tall_avatar` + `cover_photo` (51.7 KB) and a `picture`
object per member across 51 groups (37.7 KB). Stripping media alone takes it to
51.4 KB (−73%); the field projections below take it to 29.3 KB.

**Compact means two different things here, depending on the tool.**

**A hand-written field projection** — `sw_list_groups`, `sw_get_group`,
`sw_list_friends`, `sw_get_current_user`, `sw_get_user`, `sw_list_expenses`,
`sw_get_expense`:

- **A person becomes `{id, name, email, registration_status, balance}`, and
  `name` is `first_name` + `last_name` JOINED.** This is the one that will trip
  you: reach for `last_name` on the default rung and it is not there. `balance`
  survives because it is the whole reason to look a person up, and
  `registration_status` because it is how you know an invite was never
  accepted.
- **A group keeps** `{id, name, group_type, updated_at, members[],
  simplified_debts, invite_link}`. The whiteboard fields and the
  `simplify_by_default` / `custom_avatar` / `group_reminders` settings go —
  nothing here reads them. `original_debts` goes because `simplified_debts`
  answers "who owes whom", and the two differ only when simplification is on;
  `full` has both.
- **An expense keeps the share breakdown**, as `{id, name, paid_share,
  owed_share, net_balance}` per person rather than Splitwise's nested `user`
  object, plus `repayments`, `comments_count` and `category` as a name. Two
  details matter: `deleted_at` is kept **only when set**, because a deleted
  expense still comes back from the list endpoint and a caller who cannot see
  it will count it; and the receipt becomes `has_receipt: true` — the bytes
  come from `sw_get_receipt`. The eleven-field repeat/reminder/transaction
  block goes (`repeats`, `next_repeat`, `transaction_status`, …) — it was
  `false` / `null` / `"offline"` on every expense in a live account.

**Media stripping, with no field projection claimed** — `sw_get_notifications`
and `sw_get_comments`. Compact drops the avatar URLs and touches nothing else.
Do not expect a named field set from these two; expect the same records minus
the pictures.

`view: "full"` returns Splitwise's records untouched, everywhere. There is **no
`raw` rung**: `full` already IS the upstream payload, so a third value could
only alias it.

**A projection that trips returns the rows WHOLE**, and for the entire array
rather than per record — one odd record projected to nothing among fifty good
ones is a hole in the middle of an answer, and indistinguishable from an
expense with no content. So a fat response is a possible outcome; a quietly
gappy one is not.

The other eighteen tools take no `view`, each for its own reason:

- **`sw_get_receipt`** is the one tool the media rung is documented never to
  touch: its PRODUCT is the image. Stripping there would not shrink the answer,
  it would delete it.
- **`sw_get_categories` and `sw_get_currencies`** are static reference lists —
  already narrow, no media, and every field on them is the answer.
- **`sw_healthcheck`** answers reachability and auth.
- **The fourteen writes** (`sw_create_expense`, `sw_update_expense`,
  `sw_delete_expense`, `sw_undelete_expense`, `sw_create_group`,
  `sw_delete_group`, `sw_undelete_group`, `sw_add_user_to_group`,
  `sw_remove_user_from_group`, `sw_create_friend`, `sw_delete_friend`,
  `sw_create_comment`, `sw_delete_comment`, `sw_update_user`) return receipts —
  an id, a status — with nothing to strip and everything to keep.

## Workflows

**Add an expense to a group:**
```
sw_list_groups → find group ID for "vacation"
sw_create_expense(group_id, "Dinner", "80.00", split_equally: true)
```

**Add someone to a group:**
```
sw_list_friends → find Meredith's user_id
sw_get_group(id) → check if Meredith is already in members[]
sw_add_user_to_group(group_id, user_id) → if not
```

**Custom split (you paid, split 60/40):**
```
sw_get_current_user → your user_id
sw_list_friends → other person's user_id
sw_create_expense(group_id, "Hotel", "200.00", users: [
  { user_id: yours, paid_share: "200.00", owed_share: "120.00" },
  { user_id: theirs, paid_share: "0.00", owed_share: "80.00" }
])
```

**Get the receipt for an expense:**
```
sw_list_expenses(...) → find expense ID
sw_get_receipt(id, extract_text: true) → line items and totals as text
sw_get_receipt(id, inline: true)       → the actual bytes, when you need to see it
sw_get_receipt(id)                     → writes e.g. ./splitwise-receipt-4644814211.pdf
```

**Search and edit an expense:**
```
sw_list_expenses(group_id, dated_after: "2026-01-01") → find expense ID
sw_update_expense(expense_id, description: "Corrected description", cost: "95.00")
```

## Notes

- `cost` is always a decimal string (e.g. `"25.00"`)
- `split_equally: true` and `users` array are mutually exclusive
- For custom split updates, the **full `users` array is required** — the API replaces the entire split
- `sw_delete_expense` is a soft delete — restore with `sw_undelete_expense`
- The `receipt.original` / `receipt.large` URLs on an expense are **not public** — fetching them without the API key returns 401. Always use `sw_get_receipt`, which fetches them with the server's own credentials
- `sw_get_receipt` writes into `output_dir`, else `$SPLITWISE_OUTPUT_DIR`, else the working directory, and never overwrites an existing file
- That path is on the **server's** filesystem. If you can't read it — a hosted or containerised server — use `inline: true` (bytes) or `extract_text: true` (PDF text) instead of the path
- `extract_text` only works on PDFs, and only when the PDF has a text layer; a scanned or photographed receipt returns `text_note` instead, and needs `inline: true` to read
- API default for `sw_list_expenses` is 20 results when `limit` is omitted
