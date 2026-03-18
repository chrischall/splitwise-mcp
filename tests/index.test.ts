import { describe, it, expect, vi } from 'vitest';

// Verify the tool registry covers all expected tools.
// We import tool definitions directly — no need to spin up the MCP server.
import { toolDefinitions as userTools } from '../src/tools/user.js';
import { toolDefinitions as groupTools } from '../src/tools/groups.js';
import { toolDefinitions as friendTools } from '../src/tools/friends.js';
import { toolDefinitions as expenseTools } from '../src/tools/expenses.js';
import { toolDefinitions as utilityTools } from '../src/tools/utilities.js';

const allTools = [...userTools, ...groupTools, ...friendTools, ...expenseTools, ...utilityTools];
const allNames = allTools.map((t) => t.name);

describe('tool registry', () => {
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
    it(`includes ${name}`, () => {
      expect(allNames).toContain(name);
    });
  }

  it('has exactly 25 tools', () => {
    expect(allTools).toHaveLength(25);
  });
});
