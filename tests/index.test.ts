import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client } from '../src/client.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerGroupTools } from '../src/tools/groups.js';
import { registerFriendTools } from '../src/tools/friends.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerReceiptTools } from '../src/tools/receipts.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { createTestHarness } from './helpers.js';

// Verify the tool registry covers all expected tools.
// We register all tools on a McpServer and list them via a connected client.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const expected = [
  'sw_get_current_user', 'sw_get_user', 'sw_update_user',
  'sw_list_groups', 'sw_get_group', 'sw_create_group', 'sw_add_user_to_group', 'sw_remove_user_from_group',
  'sw_delete_group', 'sw_undelete_group',
  'sw_list_friends', 'sw_create_friend', 'sw_delete_friend',
  'sw_list_expenses', 'sw_get_expense', 'sw_create_expense', 'sw_update_expense', 'sw_delete_expense',
  'sw_undelete_expense', 'sw_get_receipt',
  'sw_get_notifications', 'sw_get_categories', 'sw_get_currencies',
  'sw_get_comments', 'sw_create_comment', 'sw_delete_comment',
];

describe('tool registry', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  let registered: string[];

  beforeAll(async () => {
    harness = await createTestHarness((server) => {
      registerUserTools(server, client);
      registerGroupTools(server, client);
      registerFriendTools(server, client);
      registerExpenseTools(server, client);
      registerReceiptTools(server, client);
      registerUtilityTools(server, client);
    });
    registered = (await harness.listTools()).map((t) => t.name);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('registers exactly the expected tools', () => {
    expect([...registered].sort()).toEqual([...expected].sort());
  });

  // The mcpb manifest advertises the tool list to the host at install time, and
  // nothing regenerates it — so it silently drifts whenever a tool is added or
  // renamed. Catch that here rather than in a published bundle.
  it('matches the tool list advertised in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
      tools: { name: string }[];
    };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([...registered].sort());
  });
});
