import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_get_notifications',
    description: 'Get recent Splitwise activity notifications for the current user.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_categories',
    description: 'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_currencies',
    description: 'Get all Splitwise-supported currency codes and units. Use the currency_code value when creating expenses in non-default currencies.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_comments',
    description: 'Get all comments on a Splitwise expense.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        expense_id: { type: 'integer', description: 'Expense ID to get comments for' },
      },
      required: ['expense_id'],
    },
  },
  {
    name: 'sw_create_comment',
    description: 'Add a comment to a Splitwise expense.',
    inputSchema: {
      type: 'object',
      properties: {
        expense_id: { type: 'integer', description: 'Expense ID to comment on' },
        content: { type: 'string', description: 'Comment text' },
      },
      required: ['expense_id', 'content'],
    },
  },
  {
    name: 'sw_delete_comment',
    description: 'Delete a comment by id.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Comment ID to delete' },
      },
      required: ['id'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_get_notifications': {
      const data = await client.request('GET', '/get_notifications');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_categories': {
      const data = await client.request('GET', '/get_categories');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_currencies': {
      const data = await client.request('GET', '/get_currencies');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_comments': {
      const { expense_id } = args as { expense_id: number };
      const data = await client.request('GET', `/get_comments?expense_id=${expense_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_create_comment': {
      const { expense_id, content } = args as { expense_id: number; content: string };
      const data = await client.request('POST', '/create_comment', { expense_id, content });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_delete_comment': {
      const { id } = args as { id: number };
      const data = await client.request('POST', `/delete_comment/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
