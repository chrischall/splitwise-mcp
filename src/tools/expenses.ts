import { z } from 'zod';
import { EXPENSE_LIST_VIEWS, SW_VIEWS, viewExpense, viewExpenses } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildQueryString, minifiedResult, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';
import { UNTRUSTED_DESCRIPTION_SUFFIX, swUntrustedResult } from './_untrusted.js';
import {
  buildReceiptForm,
  loadReceipt,
  receiptParam,
  receiptSchema,
  verifyReceiptStored,
  type LoadedReceipt,
} from './_receipt.js';
import {
  attachComments,
  decodeCursor,
  encodeCursor,
  hasLocalFilters,
  projectForList,
  scanExpenses,
  MAX_COMMENT_ROWS,
  SCAN_BUDGET,
  type ListView,
  type LocalFilters,
  type UpstreamQuery,
} from './_list.js';
import { findDuplicates, inferCategory, resolveCategory, resolveEqualSplit } from './_create.js';
import { assertNotDeleted, explainForbidden, verifyRestored, withPostState } from './_expense-state.js';

import type { UserShare } from './_split.js';

/** Flattens a users array into Splitwise's flat-param JSON format. */
export function flattenUsers(users: UserShare[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  users.forEach((u, i) => {
    flat[`users__${i}__user_id`] = u.user_id;
    flat[`users__${i}__paid_share`] = u.paid_share;
    flat[`users__${i}__owed_share`] = u.owed_share;
  });
  return flat;
}

/** A full unfiltered page may have more behind it: hand back a cursor to it. */
function withCursor(
  out: unknown,
  page: unknown,
  offset: number,
  want: number,
  q: UpstreamQuery,
  filters: LocalFilters,
): unknown {
  if (!Array.isArray(page) || page.length < want || out === null || typeof out !== 'object') return out;
  return { ...(out as object), next_cursor: encodeCursor(offset + page.length, q, filters) };
}

function commentNote(note: { truncated: boolean } | undefined) {
  return note?.truncated
    ? { comments_note: `Comments were inlined for the first ${MAX_COMMENT_ROWS} expenses that have any; narrow the filters or page with a smaller limit for the rest.` }
    : {};
}

function buildExpenseBody(args: Record<string, unknown>): Record<string, unknown> {
  // `confirmToken` is a tool-gate input and `receipt` is sent as a file part,
  // so neither belongs in the expense fields.
  const {
    split_equally,
    users,
    expense_id: _id,
    confirmToken: _confirmToken,
    receipt: _receipt,
    // Resolved by the create handler into category_id / users[].
    category: _category,
    split: _split,
    paid_by: _paidBy,
    split_among: _splitAmong,
    ...rest
  } = args as {
    split_equally?: boolean;
    users?: UserShare[];
    expense_id?: number;
    confirmToken?: string;
    receipt?: unknown;
    [key: string]: unknown;
  };

  if (split_equally && users) {
    throw new Error('Provide either split_equally or users, not both');
  }

  const body: Record<string, unknown> = { ...rest };

  if (split_equally) {
    body.split_equally = true;
  } else if (users) {
    Object.assign(body, flattenUsers(users));
  }

  return body;
}

/**
 * Send a create/update. With a receipt the whole expense goes as multipart
 * (Splitwise only takes a file that way) and the response must show the file
 * stored; without one it stays JSON and the response passes through, exactly
 * as before.
 */
async function sendExpenseWrite(
  client: SplitwiseClient,
  path: string,
  body: Record<string, unknown>,
  receipt: LoadedReceipt | undefined,
  expenseId?: number,
): Promise<unknown> {
  if (!receipt) return client.request('POST', path, body);
  const data = await client.requestMultipart('POST', path, buildReceiptForm(body, receipt));
  return verifyReceiptStored(data, expenseId);
}

/** The body the confirmation preview shows: the fields, plus the file's identity in place of its bytes. */
function previewBody(body: Record<string, unknown>, receipt: LoadedReceipt | undefined) {
  return receipt ? { ...body, receipt: receipt.summary } : body;
}

const userShareSchema = z.object({
  user_id: z.number(),
  paid_share: z.string().describe('Amount this user paid, e.g. "25.00"'),
  owed_share: z.string().describe('Amount this user owes, e.g. "12.50"'),
});

export function registerExpenseTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_list_expenses',
    {
      description:
        `List or search Splitwise expenses. All filters are optional. group_id / friend_id / dated_after / dated_before / updated_after / updated_before are applied by Splitwise; description_contains, include_deleted, created_by, min_cost / max_cost and category are applied here while paging through the history (up to ${SCAN_BUDGET} records per call), returning up to \`limit\` matches and a next_cursor to continue. For reconciliation use view:"rows" (one flat line per expense: id, date, description, cost, created_by, deleted_at, deleted_by, comments_count, has_receipt) and include_comments:true to see why entries were deleted. Deleted expenses are included unless include_deleted is false. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        view: z
          .enum(EXPENSE_LIST_VIEWS)
          .describe(
            'Response shape. "compact" (default) keeps the share breakdown, repayments and receipt presence and drops the avatars and the repeat/reminder/transaction block; "rows" is one flat line per expense for reconciling long histories; "full" returns Splitwise\'s whole records.',
          )
          .optional(),
        group_id: z.number().describe('Only expenses in this group').optional(),
        friend_id: z.number().describe('Only expenses with this friend').optional(),
        dated_after: z
          .string()
          .describe('ISO 8601 date — only expenses on or after this date')
          .optional(),
        dated_before: z
          .string()
          .describe('ISO 8601 date — only expenses on or before this date')
          .optional(),
        updated_after: z.string().describe('ISO 8601 datetime').optional(),
        updated_before: z.string().describe('ISO 8601 datetime').optional(),
        description_contains: z
          .string()
          .min(1)
          .describe('Only expenses whose description contains this text (case-insensitive)')
          .optional(),
        include_deleted: z
          .union([z.boolean(), z.literal('only')])
          .describe('true (default): live and deleted; false: live only; "only": deleted only')
          .optional(),
        created_by: z
          .union([z.number(), z.string().min(1)])
          .describe('Only expenses created by this user: a user id, or part of their name / their email')
          .optional(),
        min_cost: z.number().describe('Only expenses costing at least this much').optional(),
        max_cost: z.number().describe('Only expenses costing at most this much').optional(),
        category: z
          .union([z.number(), z.string().min(1)])
          .describe('Only expenses in this category: a category id, or its name (any case)')
          .optional(),
        include_comments: z
          .boolean()
          .describe(`Inline each matched expense's comments (only those that have any; at most ${MAX_COMMENT_ROWS} expenses per call)`)
          .optional(),
        cursor: z
          .string()
          .describe('next_cursor from a previous call with the same filters, to continue where it stopped')
          .optional(),
        // Bounded: Splitwise reads limit=0 as "return everything", an
        // unbounded result the host refuses.
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .describe('Max results, 1-200 (default 20). With the local filters, the max number of MATCHES returned.')
          .optional(),
        offset: z.number().int().min(0).describe('Pagination offset (prefer cursor)').optional(),
      }),
    },
    async (args) => {
      const view: ListView = args.view ?? 'compact';
      const q: UpstreamQuery = {
        group_id: args.group_id,
        friend_id: args.friend_id,
        dated_after: args.dated_after,
        dated_before: args.dated_before,
        updated_after: args.updated_after,
        updated_before: args.updated_before,
      };
      const filters: LocalFilters = {
        description_contains: args.description_contains,
        include_deleted: args.include_deleted,
        created_by: args.created_by,
        min_cost: args.min_cost,
        max_cost: args.max_cost,
        category: args.category,
      };
      const want = args.limit ?? 20;

      if (!hasLocalFilters(filters) && args.cursor === undefined) {
        // No local filtering: one request, exactly as before.
        const qs = buildQueryString({ ...q, limit: args.limit, offset: args.offset });
        const data = await client.request('GET', `/get_expenses${qs}`);
        const page = (data as { expenses?: unknown } | null)?.expenses;
        if (view === 'compact' && !args.include_comments) {
          const out = viewExpenses('compact', data);
          return swUntrustedResult(withCursor(out, page, (args.offset ?? 0), want, q, filters));
        }
        if (!Array.isArray(page)) return swUntrustedResult(data);
        const rows = page.map((e) => projectForList(view, e));
        const note = args.include_comments ? await attachComments(client, page, rows) : undefined;
        return swUntrustedResult(
          withCursor({ expenses: rows, ...commentNote(note) }, page, args.offset ?? 0, want, q, filters),
        );
      }

      const start = args.cursor !== undefined ? decodeCursor(args.cursor, q, filters) : (args.offset ?? 0);
      const scan = await scanExpenses(client, q, filters, start, want);
      const rows = scan.expenses.map((e) => projectForList(view, e));
      const note = args.include_comments ? await attachComments(client, scan.expenses, rows) : undefined;
      return swUntrustedResult({
        expenses: rows,
        scanned: scan.scanned,
        ...(scan.nextOffset !== undefined ? { next_cursor: encodeCursor(scan.nextOffset, q, filters) } : {}),
        ...(scan.nextOffset !== undefined && scan.expenses.length < want
          ? { note: `Stopped after reading ${scan.scanned} records; pass next_cursor to keep searching older expenses.` }
          : {}),
        ...commentNote(note),
      });
    },
  );

  server.registerTool(
    'sw_get_expense',
    {
      description: `Get full details of a single Splitwise expense by id. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact keeps the share breakdown, repayments and receipt presence and drops the avatars and the repeat/reminder/transaction block; "full" returns Splitwise\'s whole records.',
        }),
        id: z.number().describe('Expense ID'),
      }),
    },
    async ({ id, view }) => {
      const data = await client.request('GET', `/get_expense/${id}`);
      return swUntrustedResult(viewExpense(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_create_expense',
    {
      description:
        `Create a Splitwise expense. Splits: split_equally:true (you paid, everyone in the group owes an equal part); split:"equal" with paid_by (someone — e.g. the other parent — paid, split equally among split_among or the whole group); or a users array for custom per-person splits (paid_share and owed_share as decimal strings like "25.00"). cost must be a decimal string. Pass category by name (or category_id); with neither, the most common category of similar expenses in the group is used and shown in the preview as inferred_category. The preview also lists possible_duplicates — expenses in the group, live or deleted, with the same cost, a similar description and a date within a day; check them before confirming. Pass receipt to attach an image or PDF in the same call. This puts charges on every participant's balance and notifies them. ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        group_id: z.number().describe('Group to add expense to (use 0 for no group)'),
        description: z.string().describe('Short description of the expense'),
        cost: z.string().describe('Total cost as decimal string, e.g. "25.00"'),
        split_equally: z
          .boolean()
          .describe('Split equally among group members (mutually exclusive with users)')
          .optional(),
        users: z
          .array(userShareSchema)
          .describe(
            'Custom split (mutually exclusive with split_equally). Full list of participants required.',
          )
          .optional(),
        split: z
          .literal('equal')
          .describe('"equal": paid_by paid the whole cost and everyone in split_among owes an equal part (odd cents go to the first participants). Use instead of split_equally (which always makes YOU the payer) or users.')
          .optional(),
        paid_by: z
          .union([z.number(), z.string().min(1)])
          .describe('With split:"equal" — who paid: a user id, or a group member\'s name or email')
          .optional(),
        split_among: z
          .array(z.union([z.number(), z.string().min(1)]))
          .min(1)
          .describe('With split:"equal" — who shares the cost (ids, names or emails). Default: every group member.')
          .optional(),
        currency_code: z
          .string()
          .describe('Currency code, e.g. "USD". Defaults to group/user default.')
          .optional(),
        date: z.string().describe('ISO 8601 datetime').optional(),
        category_id: z.number().describe('Category id from sw_get_categories').optional(),
        category: z
          .string()
          .min(1)
          .describe('Category by name, e.g. "Education" or "Medical expenses" (any case). Mutually exclusive with category_id. Omit both and the most common category of similar expenses in the group is used.')
          .optional(),
        details: z.string().describe('Notes').optional(),
        receipt: receiptParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      if (args.category !== undefined && args.category_id !== undefined) {
        throw new Error('Provide either category or category_id, not both');
      }
      if (args.split === 'equal') {
        if (args.paid_by === undefined) throw new Error('split:"equal" needs paid_by (who paid the whole cost)');
        if (args.split_equally) throw new Error('split:"equal" replaces split_equally — pass one or the other');
        if (args.users) throw new Error('split:"equal" builds users for you — pass split or users, not both');
      } else if (args.paid_by !== undefined || args.split_among !== undefined) {
        throw new Error('paid_by and split_among only apply with split:"equal"');
      }

      const body = buildExpenseBody(args as Record<string, unknown>);
      if (args.split === 'equal') {
        Object.assign(body, flattenUsers(await resolveEqualSplit(client, {
          group_id: args.group_id,
          cost: args.cost,
          paid_by: args.paid_by!,
          split_among: args.split_among,
        })));
      }
      const extra: Record<string, unknown> = {};
      if (args.category !== undefined) {
        body.category_id = (await resolveCategory(client, args.category)).id;
      } else if (args.category_id === undefined && args.group_id > 0) {
        const inferred = await inferCategory(client, args.group_id, args.description);
        if (inferred) {
          body.category_id = inferred.id;
          extra.inferred_category = inferred;
        }
      }
      const receipt = args.receipt ? await loadReceipt(args.receipt, client) : undefined;
      const duplicates =
        args.group_id > 0
          ? await findDuplicates(client, { group_id: args.group_id, cost: args.cost, description: args.description, date: args.date })
          : [];
      if (duplicates.length > 0) extra.possible_duplicates = duplicates;

      const gate = await confirmWrite(ctx, {
        tool: 'sw_create_expense',
        action: 'expense.create',
        summary:
          `Create a Splitwise expense "${args.description}" (${args.cost})${receipt ? ` with receipt ${receipt.filename}` : ''} — notifies group members` +
          (duplicates.length > 0
            ? ` — WARNING: ${duplicates.length} possible duplicate${duplicates.length > 1 ? 's' : ''} already in the group (see possible_duplicates)`
            : ''),
        method: 'POST',
        path: '/create_expense',
        body: previewBody(body, receipt),
        target: args.group_id,
        confirmToken: args.confirmToken,
        args,
        extra,
      });
      if (gate) return gate;
      const data = await sendExpenseWrite(client, '/create_expense', body, receipt);
      return minifiedResult(withPostState(data));
    },
  );

  server.registerTool(
    'sw_update_expense',
    {
      description:
        `Edit an existing Splitwise expense. Provide expense_id and any fields to change. For custom split updates, the full users array must be provided (the API replaces the entire split). To attach or replace the receipt on an existing expense, pass expense_id and receipt alone. ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        expense_id: z.number().describe('ID of the expense to update'),
        description: z.string().optional(),
        cost: z.string().describe('Decimal string, e.g. "25.00"').optional(),
        split_equally: z.boolean().describe('Mutually exclusive with users').optional(),
        users: z
          .array(userShareSchema)
          .describe(
            'Full replacement split — all users must be included. Mutually exclusive with split_equally.',
          )
          .optional(),
        currency_code: z.string().optional(),
        date: z.string().optional(),
        category_id: z.number().optional(),
        details: z.string().optional(),
        receipt: receiptParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { expense_id } = args;
      const body = buildExpenseBody(args as Record<string, unknown>);
      const receipt = args.receipt ? await loadReceipt(args.receipt, client) : undefined;
      await assertNotDeleted(client, expense_id);
      const gate = await confirmWrite(ctx, {
        tool: 'sw_update_expense',
        action: 'expense.update',
        summary: `Update Splitwise expense ${expense_id}${receipt ? ` (attach receipt ${receipt.filename})` : ''} — notifies group members`,
        method: 'POST',
        path: `/update_expense/${expense_id}`,
        body: previewBody(body, receipt),
        target: expense_id,
        confirmToken: args.confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await explainForbidden(client, expense_id, () =>
        sendExpenseWrite(client, `/update_expense/${expense_id}`, body, receipt, expense_id),
      );
      return minifiedResult(withPostState(data));
    },
  );

  server.registerTool(
    'sw_attach_receipt',
    {
      description:
        `Attach (or replace) the receipt image or PDF on an existing Splitwise expense. Changes nothing else on the expense — cost, split and description are not sent. Pass the file as receipt.upload_id (hosted: upload it first via sw_get_upload_url — no bytes in the tool call), receipt.path (local) or receipt.base64. Fails if Splitwise does not store the file. ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        expense_id: z.number().describe('ID of the expense to attach the receipt to'),
        receipt: receiptSchema,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { expense_id } = args;
      const receipt = await loadReceipt(args.receipt, client);
      const path = `/update_expense/${expense_id}`;
      await assertNotDeleted(client, expense_id);
      const gate = await confirmWrite(ctx, {
        tool: 'sw_attach_receipt',
        action: 'expense.attach_receipt',
        summary: `Attach receipt ${receipt.filename} to Splitwise expense ${expense_id} (replaces any existing receipt)`,
        method: 'POST',
        path,
        body: previewBody({}, receipt),
        target: expense_id,
        confirmToken: args.confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await explainForbidden(client, expense_id, () => sendExpenseWrite(client, path, {}, receipt, expense_id));
      return minifiedResult(withPostState(data));
    },
  );

  server.registerTool(
    'sw_delete_expense',
    {
      description:
        `Soft-delete a Splitwise expense by id. Returns {success: true} on success. Use sw_undelete_expense to restore. ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        id: z.number().describe('Expense ID to delete'),
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { id, confirmToken } = args;
      const gate = await confirmWrite(ctx, {
        tool: 'sw_delete_expense',
        action: 'expense.delete',
        summary: `Soft-delete Splitwise expense ${id}`,
        method: 'POST',
        path: `/delete_expense/${id}`,
        target: id,
        confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/delete_expense/${id}`);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_undelete_expense',
    {
      description:
        `Restore a soft-deleted Splitwise expense, then re-read it and return post_state {deleted_at, deleted_by, updated_at, updated_by}; if it is still (or again) deleted, the call fails naming who deleted it and when. This puts its charges back on every participant's balance and notifies them, so it is gated like the other writes. ${CONFIRM_NOTE}`,
      // Destructive despite the delete tool being its record-level inverse:
      // the restore notifies every participant, and no later call un-sends that.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        id: z.number().describe('Expense ID to restore'),
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { id, confirmToken } = args;
      const gate = await confirmWrite(ctx, {
        tool: 'sw_undelete_expense',
        action: 'expense.undelete',
        summary: `Restore soft-deleted Splitwise expense ${id} — puts it back on balances and notifies its participants`,
        method: 'POST',
        path: `/undelete_expense/${id}`,
        target: id,
        confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/undelete_expense/${id}`);
      return minifiedResult(await verifyRestored(client, id, data));
    },
  );
}
