import { z } from 'zod';
export function registerUserTools(server, client) {
    server.registerTool('sw_get_current_user', {
        description: "Get the authenticated Splitwise user's profile (id, first_name, last_name, email). Use the returned id when building custom expense splits.",
        annotations: { readOnlyHint: true },
    }, async () => {
        const data = await client.request('GET', '/get_current_user');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_get_user', {
        description: "Get another Splitwise user's profile by id.",
        annotations: { readOnlyHint: true },
        inputSchema: {
            id: z.number().describe('User ID'),
        },
    }, async ({ id }) => {
        const data = await client.request('GET', `/get_user/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('sw_update_user', {
        description: "Update the current user's profile fields. id must be the current user's id.",
        inputSchema: {
            id: z.number().describe("User ID (must be the current user's id)"),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            email: z.string().optional(),
            password: z.string().optional(),
            locale: z.string().optional(),
            default_currency: z.string().optional(),
        },
    }, async ({ id, first_name, last_name, email, password, locale, default_currency }) => {
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
    });
}
