import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, buildQueryString } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerUtilityTools(server: McpServer): void {
  server.registerTool('sw_get_notifications', {
    description: 'Get recent Splitwise activity notifications for the current user.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_notifications');
    return textResult(data);
  });

  server.registerTool('sw_get_categories', {
    description: 'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_categories');
    return textResult(data);
  });

  server.registerTool('sw_get_currencies', {
    description: 'Get all Splitwise-supported currency codes and units. Use the currency_code value when creating expenses in non-default currencies.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_currencies');
    return textResult(data);
  });

  server.registerTool('sw_get_comments', {
    description: 'Get all comments on a Splitwise expense.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      expense_id: z.number().describe('Expense ID to get comments for'),
    },
  }, async ({ expense_id }) => {
    // buildQueryString percent-encodes the value — defense-in-depth against
    // query-param injection (already constrained to a number by the schema).
    const data = await client.request('GET', `/get_comments${buildQueryString({ expense_id })}`);
    return textResult(data);
  });

  server.registerTool('sw_create_comment', {
    description: 'Add a comment to a Splitwise expense (visible to other participants). Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it posts.',
    annotations: { destructiveHint: true },
    inputSchema: {
      expense_id: z.number().describe('Expense ID to comment on'),
      content: z.string().describe('Comment text'),
      confirm: schemaConfirm,
    },
  }, async ({ expense_id, content, confirm }) => {
    const gate = previewUnlessConfirmed(confirm, `Comment on Splitwise expense ${expense_id} (visible to participants)`, 'POST', '/create_comment', { expense_id, content });
    if (gate) return gate;
    const data = await client.request('POST', '/create_comment', { expense_id, content });
    return textResult(data);
  });

  server.registerTool('sw_delete_comment', {
    description: 'Delete a comment by id. Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it deletes.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('Comment ID to delete'),
      confirm: schemaConfirm,
    },
  }, async ({ id, confirm }) => {
    const gate = previewUnlessConfirmed(confirm, `Delete Splitwise comment ${id}`, 'POST', `/delete_comment/${id}`);
    if (gate) return gate;
    const data = await client.request('POST', `/delete_comment/${id}`);
    return textResult(data);
  });
}
