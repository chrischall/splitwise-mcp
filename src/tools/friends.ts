import { z } from 'zod';
import { PERSON_VIEW_NOTE, SW_VIEWS, viewFriends } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, pruneUndefined, resolveView } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';
import { moneyMeta } from './hints.js';
import { friendsBrief } from './_brief.js';

export function registerFriendTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_list_friends',
    {
      description:
        "List all Splitwise friends. Use this to resolve a friend's name to a user_id before adding them to a group or building a custom expense split. The compact default returns id, name (first_name + last_name joined), email, registration_status and any non-empty balance per friend; pass view:'full' for Splitwise's raw records, which keep first_name and last_name separate.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: moneyMeta('whats-due', {
        canonical: true,
        aliases: ['what do i owe', 'who owes me', 'balances', 'owe', 'settle up', 'splitwise', 'iou', 'debts'],
      }),
      inputSchema: z.object({
        view: z
          .enum([...SW_VIEWS, 'brief'])
          .describe(`Response shape. ${PERSON_VIEW_NOTE} "brief" answers "what do I owe / who owes me": one line per friend with an outstanding balance (name — no date — "owes you <amount>" or "you owe <amount>"), inside the untrusted-data envelope, then a "-- N settled up" note; "-- none" when nothing is owed either way.`)
          .optional(),
      }),
    },
    async ({ view }) => {
      const data = await client.request('GET', '/get_friends');
      if (view === 'brief') return friendsBrief(data);
      return minifiedResult(viewFriends(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_create_friend',
    {
      description:
        `Add a Splitwise friend by email (sends them an invite). ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: moneyMeta('change'),
      inputSchema: z.object({
        user_email: z.string().describe('Email of the user to add as a friend'),
        user_first_name: z.string().describe('First name of the user').optional(),
        user_last_name: z.string().describe('Last name of the user').optional(),
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { user_email, user_first_name, user_last_name, confirmToken } = args;
      const body = pruneUndefined({ user_email, user_first_name, user_last_name });
      const gate = await confirmWrite(ctx, {
        tool: 'sw_create_friend',
        action: 'friend.create',
        summary: `Add ${user_email} as a Splitwise friend`,
        method: 'POST',
        path: '/create_friend',
        body,
        target: user_email,
        confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await client.request('POST', '/create_friend', body);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_delete_friend',
    {
      description:
        `Remove a Splitwise friendship by user id. ${CONFIRM_NOTE}`,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: moneyMeta('change'),
      inputSchema: z.object({
        id: z.number().describe('User ID of the friend to remove'),
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { id, confirmToken } = args;
      const gate = await confirmWrite(ctx, {
        tool: 'sw_delete_friend',
        action: 'friend.delete',
        summary: `Remove Splitwise friendship with user ${id}`,
        method: 'POST',
        path: `/delete_friend/${id}`,
        target: id,
        confirmToken,
        args,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/delete_friend/${id}`);
      return minifiedResult(data);
    },
  );
}
