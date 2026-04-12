import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SplitwiseClient } from '../client.js';

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
  const { split_equally, users, expense_id: _id, ...rest } = args as {
    split_equally?: boolean;
    users?: UserShare[];
    expense_id?: number;
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

const userShareSchema = z.object({
  user_id: z.number(),
  paid_share: z.string().describe('Amount this user paid, e.g. "25.00"'),
  owed_share: z.string().describe('Amount this user owes, e.g. "12.50"'),
});

export function registerExpenseTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_list_expenses', {
    description: 'List or search Splitwise expenses. All filters are optional. Use group_id to filter by group, dated_after/dated_before for date ranges.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      group_id: z.number().describe('Only expenses in this group').optional(),
      friend_id: z.number().describe('Only expenses with this friend').optional(),
      dated_after: z.string().describe('ISO 8601 date — only expenses on or after this date').optional(),
      dated_before: z.string().describe('ISO 8601 date — only expenses on or before this date').optional(),
      updated_after: z.string().describe('ISO 8601 datetime').optional(),
      updated_before: z.string().describe('ISO 8601 datetime').optional(),
      limit: z.number().describe('Max results (API default: 20)').optional(),
      offset: z.number().describe('Pagination offset').optional(),
    },
  }, async (args) => {
    const params = new URLSearchParams();
    const filters = ['group_id', 'friend_id', 'dated_after', 'dated_before', 'updated_after', 'updated_before', 'limit', 'offset'] as const;
    for (const key of filters) {
      const val = args[key];
      if (val !== undefined) params.append(key, String(val));
    }
    const qs = params.toString();
    const data = await client.request('GET', qs ? `/get_expenses?${qs}` : '/get_expenses');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_get_expense', {
    description: 'Get full details of a single Splitwise expense by id.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.number().describe('Expense ID'),
    },
  }, async ({ id }) => {
    const data = await client.request('GET', `/get_expense/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_create_expense', {
    description: 'Create a Splitwise expense. Use split_equally:true to split evenly among group members, or provide a users array for custom per-person splits (paid_share and owed_share as decimal strings like "25.00"). cost must be a decimal string.',
    inputSchema: {
      group_id: z.number().describe('Group to add expense to (use 0 for no group)'),
      description: z.string().describe('Short description of the expense'),
      cost: z.string().describe('Total cost as decimal string, e.g. "25.00"'),
      split_equally: z.boolean().describe('Split equally among group members (mutually exclusive with users)').optional(),
      users: z.array(userShareSchema).describe('Custom split (mutually exclusive with split_equally). Full list of participants required.').optional(),
      currency_code: z.string().describe('Currency code, e.g. "USD". Defaults to group/user default.').optional(),
      date: z.string().describe('ISO 8601 datetime').optional(),
      category_id: z.number().describe('Category id from sw_get_categories').optional(),
      details: z.string().describe('Notes').optional(),
    },
  }, async (args) => {
    const body = buildExpenseBody(args as Record<string, unknown>);
    const data = await client.request('POST', '/create_expense', body);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_update_expense', {
    description: 'Edit an existing Splitwise expense. Provide expense_id and any fields to change. For custom split updates, the full users array must be provided (the API replaces the entire split).',
    inputSchema: {
      expense_id: z.number().describe('ID of the expense to update'),
      description: z.string().optional(),
      cost: z.string().describe('Decimal string, e.g. "25.00"').optional(),
      split_equally: z.boolean().describe('Mutually exclusive with users').optional(),
      users: z.array(userShareSchema).describe('Full replacement split — all users must be included. Mutually exclusive with split_equally.').optional(),
      currency_code: z.string().optional(),
      date: z.string().optional(),
      category_id: z.number().optional(),
      details: z.string().optional(),
    },
  }, async (args) => {
    const { expense_id } = args;
    const body = buildExpenseBody(args as Record<string, unknown>);
    const data = await client.request('POST', `/update_expense/${expense_id}`, body);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_delete_expense', {
    description: 'Soft-delete a Splitwise expense by id. Returns {success: true} on success. Use sw_undelete_expense to restore.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('Expense ID to delete'),
    },
  }, async ({ id }) => {
    const data = await client.request('POST', `/delete_expense/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_undelete_expense', {
    description: 'Restore a soft-deleted Splitwise expense.',
    inputSchema: {
      id: z.number().describe('Expense ID to restore'),
    },
  }, async ({ id }) => {
    const data = await client.request('POST', `/undelete_expense/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
