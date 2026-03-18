import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_friends',
    description: 'List all Splitwise friends with their id, first_name, last_name, and email. Use this to resolve a friend\'s name to a user_id before adding them to a group or building a custom expense split.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // TODO: sw_create_friend — POST /create_friend — add a friend by email (user_email, user_first_name, user_last_name)
  // TODO: sw_delete_friend — POST /delete_friend/{id} — remove a friendship
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_friends': {
      const data = await client.request('GET', '/get_friends');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
