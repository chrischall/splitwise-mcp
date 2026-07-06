import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerGroupTools(server: McpServer): void {
  server.registerTool('sw_list_groups', {
    description: 'List all Splitwise groups the current user belongs to. Returns id, name, and members for each group. Use this to resolve a group name to its id.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/get_groups');
    return textResult(data);
  });

  server.registerTool('sw_get_group', {
    description: 'Get details of a single Splitwise group including all members and balances.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.number().describe('Group ID'),
    },
  }, async ({ id }) => {
    const data = await client.request('GET', `/get_group/${id}`);
    return textResult(data);
  });

  server.registerTool('sw_create_group', {
    description: 'Create a new Splitwise group.',
    inputSchema: {
      name: z.string().describe('Group name'),
      group_type: z.enum(['apartment', 'house', 'trip', 'other']).describe('Type of group').optional(),
      simplify_by_default: z.boolean().describe('Whether to simplify debts by default').optional(),
      confirm: schemaConfirm,
    },
  }, async ({ name, group_type, simplify_by_default, confirm }) => {
    const body: Record<string, unknown> = { name };
    if (group_type !== undefined) body.group_type = group_type;
    if (simplify_by_default !== undefined) body.simplify_by_default = simplify_by_default;
    const gate = previewUnlessConfirmed(confirm, `Create Splitwise group "${name}"`, 'POST', '/create_group', body);
    if (gate) return gate;
    const data = await client.request('POST', '/create_group', body);
    return textResult(data);
  });

  server.registerTool('sw_add_user_to_group', {
    description: "Add a user to a Splitwise group. Provide user_id (preferred, use sw_list_friends to resolve a name) or first_name + last_name + email to invite by email.",
    inputSchema: {
      group_id: z.number().describe('Group ID'),
      user_id: z.number().describe('User ID (preferred)').optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      confirm: schemaConfirm,
    },
  }, async ({ group_id, user_id, first_name, last_name, email, confirm }) => {
    let body: Record<string, unknown>;
    if (user_id !== undefined) {
      body = { group_id, user_id };
    } else {
      if (!first_name || !last_name || !email) {
        throw new Error('first_name, last_name, and email are required when user_id is not provided');
      }
      body = { group_id, first_name, last_name, email };
    }
    const gate = previewUnlessConfirmed(confirm, `Add a user to Splitwise group ${group_id} (may send an invite email)`, 'POST', '/add_user_to_group', body);
    if (gate) return gate;
    const data = await client.request('POST', '/add_user_to_group', body);
    return textResult(data);
  });

  server.registerTool('sw_remove_user_from_group', {
    description: 'Remove a user from a Splitwise group. Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it removes the user.',
    annotations: { destructiveHint: true },
    inputSchema: {
      group_id: z.number().describe('Group ID'),
      user_id: z.number().describe('User ID to remove'),
      confirm: schemaConfirm,
    },
  }, async ({ group_id, user_id, confirm }) => {
    const gate = previewUnlessConfirmed(confirm, `Remove user ${user_id} from Splitwise group ${group_id}`, 'POST', '/remove_user_from_group', { group_id, user_id });
    if (gate) return gate;
    const data = await client.request('POST', '/remove_user_from_group', { group_id, user_id });
    return textResult(data);
  });

  server.registerTool('sw_delete_group', {
    description: 'Soft-delete a Splitwise group. Without confirm:true this returns a dry-run preview and makes NO network call; with confirm:true it deletes.',
    annotations: { destructiveHint: true },
    inputSchema: {
      id: z.number().describe('Group ID to delete'),
      confirm: schemaConfirm,
    },
  }, async ({ id, confirm }) => {
    const gate = previewUnlessConfirmed(confirm, `Soft-delete Splitwise group ${id}`, 'POST', `/delete_group/${id}`);
    if (gate) return gate;
    const data = await client.request('POST', `/delete_group/${id}`);
    return textResult(data);
  });

  server.registerTool('sw_undelete_group', {
    description: 'Restore a soft-deleted Splitwise group.',
    inputSchema: {
      id: z.number().describe('Group ID to restore'),
    },
  }, async ({ id }) => {
    const data = await client.request('POST', `/undelete_group/${id}`);
    return textResult(data);
  });
}
