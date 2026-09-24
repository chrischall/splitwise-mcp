import { z } from 'zod';
import { SW_VIEWS, viewGroup, viewGroups } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';

export function registerGroupTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool(
    'sw_list_groups',
    {
      description:
        'List all Splitwise groups the current user belongs to. Returns id, name, and members for each group. Use this to resolve a group name to its id.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact drops the avatar/cover-photo URLs (60% of a live 51-group response, which does not fit in a tool result at all) and the whiteboard/reminder settings; "full" returns Splitwise\'s whole records.',
        }),
      }),
    },
    async ({ view }) => {
      const data = await client.request('GET', '/get_groups');
      return minifiedResult(viewGroups(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_get_group',
    {
      description: 'Get details of a single Splitwise group including all members and balances.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        view: viewParam(SW_VIEWS, {
          note: 'compact drops the avatar/cover-photo URLs (60% of a live 51-group response, which does not fit in a tool result at all) and the whiteboard/reminder settings; "full" returns Splitwise\'s whole records.',
        }),
        id: z.number().describe('Group ID'),
      }),
    },
    async ({ id, view }) => {
      const data = await client.request('GET', `/get_group/${id}`);
      return minifiedResult(viewGroup(resolveView(view, SW_VIEWS), data));
    },
  );

  server.registerTool(
    'sw_create_group',
    {
      description: `Create a new Splitwise group. ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        name: z.string().describe('Group name'),
        group_type: z
          .enum(['apartment', 'house', 'trip', 'other'])
          .describe('Type of group')
          .optional(),
        simplify_by_default: z
          .boolean()
          .describe('Whether to simplify debts by default')
          .optional(),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ name, group_type, simplify_by_default, confirmToken }, ctx) => {
      const body = pruneUndefined({ name, group_type, simplify_by_default });
      const gate = await confirmWrite(ctx, {
        tool: 'sw_create_group',
        action: 'group.create',
        summary: `Create Splitwise group "${name}"`,
        method: 'POST',
        path: '/create_group',
        body,
        target: '',
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', '/create_group', body);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_add_user_to_group',
    {
      description:
        `Add a user to a Splitwise group. Provide user_id (preferred, use sw_list_friends to resolve a name) or first_name + last_name + email to invite by email. ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        group_id: z.number().describe('Group ID'),
        user_id: z.number().describe('User ID (preferred)').optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ group_id, user_id, first_name, last_name, email, confirmToken }, ctx) => {
      let body: Record<string, unknown>;
      if (user_id !== undefined) {
        body = { group_id, user_id };
      } else {
        if (!first_name || !last_name || !email) {
          throw new Error(
            'first_name, last_name, and email are required when user_id is not provided',
          );
        }
        body = { group_id, first_name, last_name, email };
      }
      const gate = await confirmWrite(ctx, {
        tool: 'sw_add_user_to_group',
        action: 'group.add_user',
        summary: `Add a user to Splitwise group ${group_id} (may send an invite email)`,
        method: 'POST',
        path: '/add_user_to_group',
        body,
        target: group_id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', '/add_user_to_group', body);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_remove_user_from_group',
    {
      description:
        `Remove a user from a Splitwise group. ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        group_id: z.number().describe('Group ID'),
        user_id: z.number().describe('User ID to remove'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ group_id, user_id, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'sw_remove_user_from_group',
        action: 'group.remove_user',
        summary: `Remove user ${user_id} from Splitwise group ${group_id}`,
        method: 'POST',
        path: '/remove_user_from_group',
        body: { group_id, user_id },
        target: group_id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', '/remove_user_from_group', { group_id, user_id });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_delete_group',
    {
      description:
        `Soft-delete a Splitwise group. ${CONFIRM_NOTE}`,
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        id: z.number().describe('Group ID to delete'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ id, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'sw_delete_group',
        action: 'group.delete',
        summary: `Soft-delete Splitwise group ${id}`,
        method: 'POST',
        path: `/delete_group/${id}`,
        target: id,
        confirmToken,
      });
      if (gate) return gate;
      const data = await client.request('POST', `/delete_group/${id}`);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'sw_undelete_group',
    {
      description: 'Restore a soft-deleted Splitwise group.',
      inputSchema: z.object({
        id: z.number().describe('Group ID to restore'),
      }),
    },
    async ({ id }) => {
      const data = await client.request('POST', `/undelete_group/${id}`);
      return minifiedResult(data);
    },
  );
}
