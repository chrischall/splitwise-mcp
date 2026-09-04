import { z } from 'zod';
import { SW_VIEWS, viewFriends } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerFriendTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_list_friends', {
    description: "List all Splitwise friends with their id, first_name, last_name, and email. Use this to resolve a friend's name to a user_id before adding them to a group or building a custom expense split.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      view: viewParam(SW_VIEWS, { note: 'compact drops the avatar URLs; "full" returns Splitwise\'s whole record.' }),
    },
  }, async ({ view }) => {
    const data = await client.request('GET', '/get_friends');
    return minifiedResult(viewFriends(resolveView(view, SW_VIEWS), data));
  });

  server.registerTool('sw_create_friend', {
    description: 'Add a Splitwise friend by email (sends them an invite). Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it adds the friend.',
    annotations: { destructiveHint: true },
    inputSchema: {
      user_email: z.string().describe('Email of the user to add as a friend'),
      user_first_name: z.string().describe('First name of the user').optional(),
      user_last_name: z.string().describe('Last name of the user').optional(),
      confirm: schemaConfirm,
    },
  }, async ({ user_email, user_first_name, user_last_name, confirm }) => {
    const body = pruneUndefined({ user_email, user_first_name, user_last_name });
    const gate = previewUnlessConfirmed(confirm, `Add ${user_email} as a Splitwise friend`, 'POST', '/create_friend', body);
    if (gate) return gate;
    const data = await client.request('POST', '/create_friend', body);
    return minifiedResult(data);
  });

  server.registerTool('sw_delete_friend', {
    description: 'Remove a Splitwise friendship by user id. Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it removes the friendship.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('User ID of the friend to remove'),
      confirm: schemaConfirm,
    },
  }, async ({ id, confirm }) => {
    const gate = previewUnlessConfirmed(confirm, `Remove Splitwise friendship with user ${id}`, 'POST', `/delete_friend/${id}`);
    if (gate) return gate;
    const data = await client.request('POST', `/delete_friend/${id}`);
    return minifiedResult(data);
  });
}
