import { z } from 'zod';
import { PERSON_VIEW_NOTE, SW_VIEWS, viewFriends } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';

export function registerFriendTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_list_friends',
    {
      description:
        "List all Splitwise friends. Use this to resolve a friend's name to a user_id before adding them to a group or building a custom expense split. The compact default returns id, name (first_name + last_name joined), email, registration_status and any non-empty balance per friend; pass view:'full' for Splitwise's raw records, which keep first_name and last_name separate.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, { note: PERSON_VIEW_NOTE }),
      }),
    },
    async ({ view }) => {
      const data = await client.request('GET', '/get_friends');
      return minifiedResult(viewFriends(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_create_friend',
    {
      description:
        `Add a Splitwise friend by email (sends them an invite). ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        user_email: z.string().describe('Email of the user to add as a friend'),
        user_first_name: z.string().describe('First name of the user').optional(),
        user_last_name: z.string().describe('Last name of the user').optional(),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ user_email, user_first_name, user_last_name, confirmToken }, ctx) => {
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
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        id: z.number().describe('User ID of the friend to remove'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ id, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'sw_delete_friend',
        action: 'friend.delete',
        summary: `Remove Splitwise friendship with user ${id}`,
        method: 'POST',
        path: `/delete_friend/${id}`,
        target: id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/delete_friend/${id}`);
      return minifiedResult(data);
    },
  );
}
