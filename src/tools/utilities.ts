import { z } from 'zod';
import { SW_VIEWS, viewGeneric } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildQueryString,
  defineWrite,
  minifiedResult,
  registerWrite,
  resolveView,
  viewParam,
} from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { UNTRUSTED_DESCRIPTION_SUFFIX, swUntrustedResult } from './_untrusted.js';
import { assertNotDeleted, explainForbidden } from './_expense-state.js';
import { moneyMeta, withToolMeta } from './hints.js';
import { BRIEF_NOTIFICATION_CAP, notificationsBrief } from './_brief.js';

export function registerUtilityTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_get_notifications',
    {
      description: `Get recent Splitwise activity notifications for the current user. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: moneyMeta('whats-new', {
        canonical: true,
        aliases: ['splitwise', 'anything new', 'recent activity', 'activity', 'new expenses'],
      }),
      inputSchema: z.object({
        view: z
          .enum([...SW_VIEWS, 'brief'])
          .describe(`Response shape. compact (default) drops the avatar URLs; "full" returns Splitwise's whole record; "brief" is one line per notification (text — ISO date — kind, e.g. "expense added"), at most ${BRIEF_NOTIFICATION_CAP} with a "-- N of M shown" note past that, "-- none" when there is no activity.`)
          .optional(),
      }),
    },
    async ({ view }) => {
      const data = await client.request('GET', '/get_notifications');
      if (view === 'brief') return notificationsBrief(data);
      return swUntrustedResult(viewGeneric(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_get_categories',
    {
      description:
        'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: moneyMeta('lookup'),
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: moneyMeta('lookup'),
    },
    async () => {
      const data = await client.request('GET', '/get_currencies');
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_get_comments',
    {
      description: `Get all comments on a Splitwise expense. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: moneyMeta('lookup'),
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
      return swUntrustedResult(viewGeneric(resolveView(view, SW_VIEWS), data));
    },
  );

  withToolMeta(server, moneyMeta('send', { aliases: ['comment on an expense'] }), () => registerWrite(server, defineWrite({
    name: 'sw_create_comment',
    description:
      'Add a comment to a Splitwise expense (visible to other participants). Refused up front, naming who deleted it, if the expense is deleted — restore it with sw_undelete_expense first.',
    inputSchema: z.object({
      expense_id: z.number().describe('Expense ID to comment on'),
      content: z.string().describe('Comment text'),
    }),
    plan: async ({ expense_id, content }) => {
      await assertNotDeleted(client, expense_id);
      return {
        gate: {
          action: 'comment.create',
          summary: `Comment on Splitwise expense ${expense_id} (visible to participants)`,
          // One API key per client: no account switch inside a server to bind.
          account: undefined,
          target: expense_id,
          request: { method: 'POST', path: '/create_comment', body: { expense_id, content } },
        },
        state: { expense_id, content },
      };
    },
    execute: ({ expense_id, content }) =>
      explainForbidden(client, expense_id, () => client.request('POST', '/create_comment', { expense_id, content })),
    render: minifiedResult,
  })));

  withToolMeta(server, moneyMeta('change'), () => registerWrite(server, defineWrite({
    name: 'sw_delete_comment',
    description: 'Delete a comment by id.',
    inputSchema: z.object({
      id: z.number().describe('Comment ID to delete'),
    }),
    plan: ({ id }) => ({
      gate: {
        action: 'comment.delete',
        summary: `Delete Splitwise comment ${id}`,
        account: undefined,
        target: id,
        request: { method: 'POST', path: `/delete_comment/${id}` },
      },
      state: id,
    }),
    execute: (id) => client.request('POST', `/delete_comment/${id}`),
    render: minifiedResult,
  })));
}
