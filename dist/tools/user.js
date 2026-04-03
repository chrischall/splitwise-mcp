export const toolDefinitions = [
    {
        name: 'sw_get_current_user',
        description: 'Get the authenticated Splitwise user\'s profile (id, first_name, last_name, email). Use the returned id when building custom expense splits.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'sw_get_user',
        description: 'Get another Splitwise user\'s profile by id.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'User ID' },
            },
            required: ['id'],
        },
    },
    {
        name: 'sw_update_user',
        description: 'Update the current user\'s profile fields. id must be the current user\'s id.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'User ID (must be the current user\'s id)' },
                first_name: { type: 'string' },
                last_name: { type: 'string' },
                email: { type: 'string' },
                password: { type: 'string' },
                locale: { type: 'string' },
                default_currency: { type: 'string' },
            },
            required: ['id'],
        },
    },
];
export async function handleTool(name, args, client) {
    switch (name) {
        case 'sw_get_current_user': {
            const data = await client.request('GET', '/get_current_user');
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'sw_get_user': {
            const { id } = args;
            const data = await client.request('GET', `/get_user/${id}`);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'sw_update_user': {
            const { id, first_name, last_name, email, password, locale, default_currency } = args;
            const body = {};
            if (first_name !== undefined)
                body.first_name = first_name;
            if (last_name !== undefined)
                body.last_name = last_name;
            if (email !== undefined)
                body.email = email;
            if (password !== undefined)
                body.password = password;
            if (locale !== undefined)
                body.locale = locale;
            if (default_currency !== undefined)
                body.default_currency = default_currency;
            const data = await client.request('POST', `/update_user/${id}`, body);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
