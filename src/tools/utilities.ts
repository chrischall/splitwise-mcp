import { z } from 'zod';
import { SW_VIEWS, viewGeneric } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildQueryString, minifiedResult, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';

export function registerUtilityTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_get_notifications',
    {
      description: 'Get recent Splitwise activity notifications for the current user.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact drops the avatar URLs; "full" returns Splitwise\'s whole record.',
        }),
      }),
    },
    async ({ view }) => {
      const data = await client.request('GET', '/get_notifications');
      return minifiedResult(viewGeneric(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_get_categories',
    {
      description:
        'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request('GET', '/get_categories');
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_get_currencies',
    {
      description:
        'Get all Splitwise-supported currency codes and units. Use the currency_code value when creating expenses in non-default currencies.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await client.request('GET', '/get_currencies');
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_get_comments',
    {
      description: 'Get all comments on a Splitwise expense.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact drops the avatar URLs; "full" returns Splitwise\'s whole record.',
        }),
        expense_id: z.number().describe('Expense ID to get comments for'),
      }),
    },
    async ({ expense_id, view }) => {
      // buildQueryString percent-encodes the value — defense-in-depth against
      // query-param injection (already constrained to a number by the schema).
      const data = await client.request('GET', `/get_comments${buildQueryString({ expense_id })}`);
      return minifiedResult(viewGeneric(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_create_comment',
    {
      description:
        `Add a comment to a Splitwise expense (visible to other participants). ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        expense_id: z.number().describe('Expense ID to comment on'),
        content: z.string().describe('Comment text'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ expense_id, content, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'sw_create_comment',
        action: 'comment.create',
        summary: `Comment on Splitwise expense ${expense_id} (visible to participants)`,
        method: 'POST',
        path: '/create_comment',
        body: { expense_id, content },
        target: expense_id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', '/create_comment', { expense_id, content });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_delete_comment',
    {
      description:
        `Delete a comment by id. ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        id: z.number().describe('Comment ID to delete'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ id, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'sw_delete_comment',
        action: 'comment.delete',
        summary: `Delete Splitwise comment ${id}`,
        method: 'POST',
        path: `/delete_comment/${id}`,
        target: id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/delete_comment/${id}`);
      return minifiedResult(data);
    },
  );
}
