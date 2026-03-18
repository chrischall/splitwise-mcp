import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_groups',
    description: 'List all Splitwise groups the current user belongs to. Returns id, name, and members for each group. Use this to resolve a group name to its id.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_group',
    description: 'Get details of a single Splitwise group including all members and balances.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Group ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sw_create_group',
    description: 'Create a new Splitwise group.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        group_type: {
          type: 'string',
          enum: ['apartment', 'house', 'trip', 'other'],
          description: 'Type of group',
        },
        simplify_by_default: { type: 'boolean', description: 'Whether to simplify debts by default' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sw_add_user_to_group',
    description: 'Add a user to a Splitwise group. Provide user_id (preferred, use sw_list_friends to resolve a name) or first_name + last_name + email to invite by email.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group ID' },
        user_id: { type: 'integer', description: 'User ID (preferred)' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'sw_remove_user_from_group',
    description: 'Remove a user from a Splitwise group.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group ID' },
        user_id: { type: 'integer', description: 'User ID to remove' },
      },
      required: ['group_id', 'user_id'],
    },
  },
  {
    name: 'sw_delete_group',
    description: 'Soft-delete a Splitwise group.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Group ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sw_undelete_group',
    description: 'Restore a soft-deleted Splitwise group.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Group ID to restore' },
      },
      required: ['id'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_groups': {
      const data = await client.request('GET', '/get_groups');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_group': {
      const { id } = args as { id: number };
      const data = await client.request('GET', `/get_group/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_create_group': {
      const { name, group_type, simplify_by_default } = args as {
        name: string;
        group_type?: string;
        simplify_by_default?: boolean;
      };
      const body: Record<string, unknown> = { name };
      if (group_type !== undefined) body.group_type = group_type;
      if (simplify_by_default !== undefined) body.simplify_by_default = simplify_by_default;
      const data = await client.request('POST', '/create_group', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_add_user_to_group': {
      const { group_id, user_id, first_name, last_name, email } = args as {
        group_id: number;
        user_id?: number;
        first_name?: string;
        last_name?: string;
        email?: string;
      };
      let body: Record<string, unknown>;
      if (user_id !== undefined) {
        body = { group_id, user_id };
      } else {
        if (!first_name || !last_name || !email) {
          throw new Error('first_name, last_name, and email are required when user_id is not provided');
        }
        body = { group_id, first_name, last_name, email };
      }
      const data = await client.request('POST', '/add_user_to_group', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_remove_user_from_group': {
      const { group_id, user_id } = args as { group_id: number; user_id: number };
      const data = await client.request('POST', '/remove_user_from_group', { group_id, user_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_delete_group': {
      const { id } = args as { id: number };
      const data = await client.request('POST', `/delete_group/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_undelete_group': {
      const { id } = args as { id: number };
      const data = await client.request('POST', `/undelete_group/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
