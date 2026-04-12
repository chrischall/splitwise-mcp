import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SplitwiseClient } from '../client.js';

export function registerUtilityTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_get_notifications', {
    description: 'Get recent Splitwise activity notifications for the current user.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_notifications');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_get_categories', {
    description: 'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_categories');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_get_currencies', {
    description: 'Get all Splitwise-supported currency codes and units. Use the currency_code value when creating expenses in non-default currencies.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_currencies');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_get_comments', {
    description: 'Get all comments on a Splitwise expense.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      expense_id: z.number().describe('Expense ID to get comments for'),
    },
  }, async ({ expense_id }) => {
    const data = await client.request('GET', `/get_comments?expense_id=${expense_id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_create_comment', {
    description: 'Add a comment to a Splitwise expense.',
    inputSchema: {
      expense_id: z.number().describe('Expense ID to comment on'),
      content: z.string().describe('Comment text'),
    },
  }, async ({ expense_id, content }) => {
    const data = await client.request('POST', '/create_comment', { expense_id, content });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_delete_comment', {
    description: 'Delete a comment by id.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('Comment ID to delete'),
    },
  }, async ({ id }) => {
    const data = await client.request('POST', `/delete_comment/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
