import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_get_current_user',
    description: 'Get the authenticated Splitwise user\'s profile (id, first_name, last_name, email). Use the returned id when building custom expense splits.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // TODO: sw_get_user — GET /get_user/{id} — get another user's profile by id
  // TODO: sw_update_user — POST /update_user/{id} — update current user's profile (first_name, last_name, email, password, locale, default_currency)
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_get_current_user': {
      const data = await client.request('GET', '/get_current_user');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
