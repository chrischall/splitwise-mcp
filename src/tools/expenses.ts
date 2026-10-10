import { z } from 'zod';
import { SW_VIEWS, viewExpense, viewExpenses } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildQueryString, minifiedResult, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';
import { UNTRUSTED_DESCRIPTION_SUFFIX, swUntrustedResult } from './_untrusted.js';
import { buildReceiptForm, loadReceipt, receiptParam, type LoadedReceipt } from './_receipt.js';

interface UserShare {
  user_id: number;
  paid_share: string;
  owed_share: string;
}

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

function buildExpenseBody(args: Record<string, unknown>): Record<string, unknown> {
  // `confirmToken` is a tool-gate input and `receipt` is sent as a file part,
  // so neither belongs in the expense fields.
  const {
    split_equally,
    users,
    expense_id: _id,
    confirmToken: _confirmToken,
    receipt: _receipt,
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
 * (Splitwise only takes a file that way); without one it stays JSON, exactly
 * as before.
 */
function sendExpenseWrite(
  client: SplitwiseClient,
  path: string,
  body: Record<string, unknown>,
  receipt: LoadedReceipt | undefined,
): Promise<unknown> {
  return receipt
    ? client.requestMultipart('POST', path, buildReceiptForm(body, receipt))
    : client.request('POST', path, body);
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
        `List or search Splitwise expenses. All filters are optional. Use group_id to filter by group, dated_after/dated_before for date ranges. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact keeps the share breakdown, repayments and receipt presence and drops the avatars and the repeat/reminder/transaction block; "full" returns Splitwise\'s whole records.',
        }),
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
        // Bounded: Splitwise reads limit=0 as "return everything", an
        // unbounded result the host refuses.
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .describe('Max results, 1-200 (API default: 20). Page with offset for more.')
          .optional(),
        offset: z.number().int().min(0).describe('Pagination offset').optional(),
      }),
    },
    async (args) => {
      const qs = buildQueryString({
        group_id: args.group_id,
        friend_id: args.friend_id,
        dated_after: args.dated_after,
        dated_before: args.dated_before,
        updated_after: args.updated_after,
        updated_before: args.updated_before,
        limit: args.limit,
        offset: args.offset,
      });
      const data = await client.request('GET', `/get_expenses${qs}`);
      return swUntrustedResult(viewExpenses(resolveView(args.view, SW_VIEWS), data));
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
        `Create a Splitwise expense. Use split_equally:true to split evenly among group members, or provide a users array for custom per-person splits (paid_share and owed_share as decimal strings like "25.00"). cost must be a decimal string. Pass receipt to attach an image or PDF in the same call. This puts charges on every participant's balance and notifies them. ${CONFIRM_NOTE}`,
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
        currency_code: z
          .string()
          .describe('Currency code, e.g. "USD". Defaults to group/user default.')
          .optional(),
        date: z.string().describe('ISO 8601 datetime').optional(),
        category_id: z.number().describe('Category id from sw_get_categories').optional(),
        details: z.string().describe('Notes').optional(),
        receipt: receiptParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const body = buildExpenseBody(args as Record<string, unknown>);
      const receipt = args.receipt ? await loadReceipt(args.receipt) : undefined;
      const gate = await confirmWrite(ctx, {
        tool: 'sw_create_expense',
        action: 'expense.create',
        summary: `Create a Splitwise expense "${args.description}" (${args.cost})${receipt ? ` with receipt ${receipt.filename}` : ''} — notifies group members`,
        method: 'POST',
        path: '/create_expense',
        body: previewBody(body, receipt),
        target: args.group_id,
        confirmToken: args.confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await sendExpenseWrite(client, '/create_expense', body, receipt);
      return minifiedResult(data);
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
      const receipt = args.receipt ? await loadReceipt(args.receipt) : undefined;
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
      const data = await sendExpenseWrite(client, `/update_expense/${expense_id}`, body, receipt);
      return minifiedResult(data);
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
        `Restore a soft-deleted Splitwise expense. This puts its charges back on every participant's balance and notifies them, so it is gated like the other writes. ${CONFIRM_NOTE}`,
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
      return minifiedResult(data);
    },
  );
}
