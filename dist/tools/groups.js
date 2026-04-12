import { z } from 'zod';
export function registerGroupTools(server, client) {
    server.registerTool('sw_list_groups', {
        description: 'List all Splitwise groups the current user belongs to. Returns id, name, and members for each group. Use this to resolve a group name to its id.',
        annotations: { readOnlyHint: true },
    }, async () => {
        const data = await client.request('GET', '/get_groups');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_get_group', {
        description: 'Get details of a single Splitwise group including all members and balances.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            id: z.number().describe('Group ID'),
        },
    }, async ({ id }) => {
        const data = await client.request('GET', `/get_group/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_create_group', {
        description: 'Create a new Splitwise group.',
        inputSchema: {
            name: z.string().describe('Group name'),
            group_type: z.enum(['apartment', 'house', 'trip', 'other']).describe('Type of group').optional(),
            simplify_by_default: z.boolean().describe('Whether to simplify debts by default').optional(),
        },
    }, async ({ name, group_type, simplify_by_default }) => {
        const body = { name };
        if (group_type !== undefined)
            body.group_type = group_type;
        if (simplify_by_default !== undefined)
            body.simplify_by_default = simplify_by_default;
        const data = await client.request('POST', '/create_group', body);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_add_user_to_group', {
        description: "Add a user to a Splitwise group. Provide user_id (preferred, use sw_list_friends to resolve a name) or first_name + last_name + email to invite by email.",
        inputSchema: {
            group_id: z.number().describe('Group ID'),
            user_id: z.number().describe('User ID (preferred)').optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            email: z.string().optional(),
        },
    }, async ({ group_id, user_id, first_name, last_name, email }) => {
        let body;
        if (user_id !== undefined) {
            body = { group_id, user_id };
        }
        else {
            if (!first_name || !last_name || !email) {
                throw new Error('first_name, last_name, and email are required when user_id is not provided');
            }
            body = { group_id, first_name, last_name, email };
        }
        const data = await client.request('POST', '/add_user_to_group', body);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_remove_user_from_group', {
        description: 'Remove a user from a Splitwise group.',
        inputSchema: {
            group_id: z.number().describe('Group ID'),
            user_id: z.number().describe('User ID to remove'),
        },
    }, async ({ group_id, user_id }) => {
        const data = await client.request('POST', '/remove_user_from_group', { group_id, user_id });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_delete_group', {
        description: 'Soft-delete a Splitwise group.',
        annotations: { destructiveHint: true },
        inputSchema: {
            id: z.number().describe('Group ID to delete'),
        },
    }, async ({ id }) => {
        const data = await client.request('POST', `/delete_group/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_undelete_group', {
        description: 'Restore a soft-deleted Splitwise group.',
        inputSchema: {
            id: z.number().describe('Group ID to restore'),
        },
    }, async ({ id }) => {
        const data = await client.request('POST', `/undelete_group/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
}
