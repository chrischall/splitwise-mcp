export const toolDefinitions = [
    {
        name: 'sw_list_friends',
        description: 'List all Splitwise friends with their id, first_name, last_name, and email. Use this to resolve a friend\'s name to a user_id before adding them to a group or building a custom expense split.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'sw_create_friend',
        description: 'Add a Splitwise friend by email.',
        inputSchema: {
            type: 'object',
            properties: {
                user_email: { type: 'string', description: 'Email of the user to add as a friend' },
                user_first_name: { type: 'string', description: 'First name of the user' },
                user_last_name: { type: 'string', description: 'Last name of the user' },
            },
            required: ['user_email'],
        },
    },
    {
        name: 'sw_delete_friend',
        description: 'Remove a Splitwise friendship by user id.',
        annotations: { destructiveHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'User ID of the friend to remove' },
            },
            required: ['id'],
        },
    },
];
export async function handleTool(name, args, client) {
    switch (name) {
        case 'sw_list_friends': {
            const data = await client.request('GET', '/get_friends');
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'sw_create_friend': {
            const { user_email, user_first_name, user_last_name } = args;
            const body = { user_email };
            if (user_first_name !== undefined)
                body.user_first_name = user_first_name;
            if (user_last_name !== undefined)
                body.user_last_name = user_last_name;
            const data = await client.request('POST', '/create_friend', body);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'sw_delete_friend': {
            const { id } = args;
            const data = await client.request('POST', `/delete_friend/${id}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
