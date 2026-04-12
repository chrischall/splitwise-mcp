import { describe, it, expect, vi, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SplitwiseClient } from '../src/client.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerGroupTools } from '../src/tools/groups.js';
import { registerFriendTools } from '../src/tools/friends.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { createTestHarness } from './helpers.js';

// Verify the tool registry covers all expected tools.
// We register all tools on a McpServer and list them via a connected client.

describe('tool registry', () => {
  const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('includes all 25 expected tools', async () => {
    harness = await createTestHarness((server) => {
      registerUserTools(server, mockClient);
      registerGroupTools(server, mockClient);
      registerFriendTools(server, mockClient);
      registerExpenseTools(server, mockClient);
      registerUtilityTools(server, mockClient);
    });

    const tools = await harness.listTools();
    const allNames = tools.map((t) => t.name);

    const expected = [
      'sw_get_current_user', 'sw_get_user', 'sw_update_user',
      'sw_list_groups', 'sw_get_group', 'sw_create_group', 'sw_add_user_to_group', 'sw_remove_user_from_group',
      'sw_delete_group', 'sw_undelete_group',
      'sw_list_friends', 'sw_create_friend', 'sw_delete_friend',
      'sw_list_expenses', 'sw_get_expense', 'sw_create_expense', 'sw_update_expense', 'sw_delete_expense',
      'sw_undelete_expense',
      'sw_get_notifications', 'sw_get_categories', 'sw_get_currencies',
      'sw_get_comments', 'sw_create_comment', 'sw_delete_comment',
    ];

    for (const name of expected) {
      expect(allNames).toContain(name);
    }

    expect(tools).toHaveLength(25);
  });
});
