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
  // TODO: sw_get_comments — GET /get_comments?expense_id= — get comments on an expense
  // TODO: sw_create_comment — POST /create_comment — add a comment to an expense (expense_id, content)
  // TODO: sw_delete_comment — POST /delete_comment/{id} — delete a comment
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
