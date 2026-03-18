import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_expenses',
    description: 'List or search Splitwise expenses. All filters are optional. Use group_id to filter by group, dated_after/dated_before for date ranges.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Only expenses in this group' },
        friend_id: { type: 'integer', description: 'Only expenses with this friend' },
        dated_after: { type: 'string', description: 'ISO 8601 date — only expenses on or after this date' },
        dated_before: { type: 'string', description: 'ISO 8601 date — only expenses on or before this date' },
        updated_after: { type: 'string', description: 'ISO 8601 datetime' },
        updated_before: { type: 'string', description: 'ISO 8601 datetime' },
        limit: { type: 'integer', description: 'Max results (API default: 20)' },
        offset: { type: 'integer', description: 'Pagination offset' },
      },
      required: [],
    },
  },
  {
    name: 'sw_get_expense',
    description: 'Get full details of a single Splitwise expense by id.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Expense ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sw_create_expense',
    description: 'Create a Splitwise expense. Use split_equally:true to split evenly among group members, or provide a users array for custom per-person splits (paid_share and owed_share as decimal strings like "25.00"). cost must be a decimal string.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group to add expense to (use 0 for no group)' },
        description: { type: 'string', description: 'Short description of the expense' },
        cost: { type: 'string', description: 'Total cost as decimal string, e.g. "25.00"' },
        split_equally: { type: 'boolean', description: 'Split equally among group members (mutually exclusive with users)' },
        users: {
          type: 'array',
          description: 'Custom split (mutually exclusive with split_equally). Full list of participants required.',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'integer' },
              paid_share: { type: 'string', description: 'Amount this user paid, e.g. "25.00"' },
              owed_share: { type: 'string', description: 'Amount this user owes, e.g. "12.50"' },
            },
            required: ['user_id', 'paid_share', 'owed_share'],
          },
        },
        currency_code: { type: 'string', description: 'Currency code, e.g. "USD". Defaults to group/user default.' },
        date: { type: 'string', description: 'ISO 8601 datetime' },
        category_id: { type: 'integer', description: 'Category id from sw_get_categories' },
        details: { type: 'string', description: 'Notes' },
      },
      required: ['group_id', 'description', 'cost'],
    },
  },
  {
    name: 'sw_update_expense',
    description: 'Edit an existing Splitwise expense. Provide expense_id and any fields to change. For custom split updates, the full users array must be provided (the API replaces the entire split).',
    inputSchema: {
      type: 'object',
      properties: {
        expense_id: { type: 'integer', description: 'ID of the expense to update' },
        description: { type: 'string' },
        cost: { type: 'string', description: 'Decimal string, e.g. "25.00"' },
        split_equally: { type: 'boolean', description: 'Mutually exclusive with users' },
        users: {
          type: 'array',
          description: 'Full replacement split — all users must be included. Mutually exclusive with split_equally.',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'integer' },
              paid_share: { type: 'string' },
              owed_share: { type: 'string' },
            },
            required: ['user_id', 'paid_share', 'owed_share'],
          },
        },
        currency_code: { type: 'string' },
        date: { type: 'string' },
        category_id: { type: 'integer' },
        details: { type: 'string' },
      },
      required: ['expense_id'],
    },
  },
  {
    name: 'sw_delete_expense',
    description: 'Soft-delete a Splitwise expense by id. Returns {success: true} on success. Note: restoring deleted expenses requires sw_undelete_expense (not yet implemented).',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Expense ID to delete' },
      },
      required: ['id'],
    },
  },
  // TODO: sw_undelete_expense — POST /undelete_expense/{id} — restore a soft-deleted expense
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_expenses': {
      const params = new URLSearchParams();
      const filters = ['group_id', 'friend_id', 'dated_after', 'dated_before', 'updated_after', 'updated_before', 'limit', 'offset'];
      for (const key of filters) {
        if (args[key] !== undefined) params.append(key, String(args[key]));
      }
      const qs = params.toString();
      const data = await client.request('GET', qs ? `/get_expenses?${qs}` : '/get_expenses');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_expense': {
      const { id } = args as { id: number };
      const data = await client.request('GET', `/get_expense/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_create_expense': {
      const body = buildExpenseBody(args);
      const data = await client.request('POST', '/create_expense', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_update_expense': {
      const { expense_id } = args as { expense_id: number };
      const body = buildExpenseBody(args);
      const data = await client.request('POST', `/update_expense/${expense_id}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_delete_expense': {
      const { id } = args as { id: number };
      const data = await client.request('POST', `/delete_expense/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
