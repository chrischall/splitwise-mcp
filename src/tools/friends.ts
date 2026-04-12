import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SplitwiseClient } from '../client.js';

export function registerFriendTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_list_friends', {
    description: "List all Splitwise friends with their id, first_name, last_name, and email. Use this to resolve a friend's name to a user_id before adding them to a group or building a custom expense split.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_friends');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_create_friend', {
    description: 'Add a Splitwise friend by email.',
    inputSchema: {
      user_email: z.string().describe('Email of the user to add as a friend'),
      user_first_name: z.string().describe('First name of the user').optional(),
      user_last_name: z.string().describe('Last name of the user').optional(),
    },
  }, async ({ user_email, user_first_name, user_last_name }) => {
    const body: Record<string, unknown> = { user_email };
    if (user_first_name !== undefined) body.user_first_name = user_first_name;
    if (user_last_name !== undefined) body.user_last_name = user_last_name;
    const data = await client.request('POST', '/create_friend', body);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sw_delete_friend', {
    description: 'Remove a Splitwise friendship by user id.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('User ID of the friend to remove'),
    },
  }, async ({ id }) => {
    const data = await client.request('POST', `/delete_friend/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
