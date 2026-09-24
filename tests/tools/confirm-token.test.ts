import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { client } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { registerFriendTools } from '../../src/tools/friends.js';
import { registerGroupTools } from '../../src/tools/groups.js';
import { registerUserTools } from '../../src/tools/user.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { confirmedCall, createTestHarness, parseToolResult } from '../helpers.js';

// Every Splitwise write notifies other people, so every write is gated: a real
// confirmation prompt where the client supports one, otherwise a two-step
// preview + confirmToken flow (MCP_CONFIRM_MODE).

const mockRequest = vi.spyOn(client, 'request').mockResolvedValue({ ok: true } as never);

function registerAll(server: McpServer): void {
  registerExpenseTools(server, client);
  registerFriendTools(server, client);
  registerGroupTools(server, client);
  registerUserTools(server, client);
  registerUtilityTools(server, client);
}

const ENV_KEYS = ['MCP_CONFIRM_MODE', 'MCP_CONFIRM_TTL_SECONDS', 'MCP_CONFIRM_SECRET'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;

beforeEach(() => {
  mockRequest.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(async () => {
  if (harness) await harness.close();
  harness = undefined;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => mockRequest.mockRestore());

/**
 * Each gated tool, the arguments it is called with, and the preview the user
 * must see — at least what the old `confirm`-less dry run returned: the
 * summary, the method, the path and the body that will be sent (`willSend`).
 */
const GATED: Array<{
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  willSend?: unknown;
  write: unknown[];
}> = [
  {
    tool: 'sw_create_expense',
    args: { group_id: 1, description: 'Dinner', cost: '50.00', split_equally: true },
    method: 'POST',
    path: '/create_expense',
    willSend: { group_id: 1, description: 'Dinner', cost: '50.00', split_equally: true },
    write: ['POST', '/create_expense', { group_id: 1, description: 'Dinner', cost: '50.00', split_equally: true }],
  },
  {
    tool: 'sw_update_expense',
    args: { expense_id: 42, cost: '60.00' },
    method: 'POST',
    path: '/update_expense/42',
    willSend: { cost: '60.00' },
    write: ['POST', '/update_expense/42', { cost: '60.00' }],
  },
  {
    tool: 'sw_delete_expense',
    args: { id: 42 },
    method: 'POST',
    path: '/delete_expense/42',
    write: ['POST', '/delete_expense/42'],
  },
  {
    tool: 'sw_create_group',
    args: { name: 'Trip', group_type: 'trip' },
    method: 'POST',
    path: '/create_group',
    willSend: { name: 'Trip', group_type: 'trip' },
    write: ['POST', '/create_group', { name: 'Trip', group_type: 'trip' }],
  },
  {
    tool: 'sw_add_user_to_group',
    args: { group_id: 10, user_id: 99 },
    method: 'POST',
    path: '/add_user_to_group',
    willSend: { group_id: 10, user_id: 99 },
    write: ['POST', '/add_user_to_group', { group_id: 10, user_id: 99 }],
  },
  {
    tool: 'sw_remove_user_from_group',
    args: { group_id: 10, user_id: 99 },
    method: 'POST',
    path: '/remove_user_from_group',
    willSend: { group_id: 10, user_id: 99 },
    write: ['POST', '/remove_user_from_group', { group_id: 10, user_id: 99 }],
  },
  {
    tool: 'sw_delete_group',
    args: { id: 42 },
    method: 'POST',
    path: '/delete_group/42',
    write: ['POST', '/delete_group/42'],
  },
  {
    tool: 'sw_create_friend',
    args: { user_email: 'new@example.com' },
    method: 'POST',
    path: '/create_friend',
    willSend: { user_email: 'new@example.com' },
    write: ['POST', '/create_friend', { user_email: 'new@example.com' }],
  },
  {
    tool: 'sw_delete_friend',
    args: { id: 7 },
    method: 'POST',
    path: '/delete_friend/7',
    write: ['POST', '/delete_friend/7'],
  },
  {
    tool: 'sw_update_user',
    args: { id: 99, first_name: 'Chris' },
    method: 'POST',
    path: '/update_user/99',
    willSend: { first_name: 'Chris' },
    write: ['POST', '/update_user/99', { first_name: 'Chris' }],
  },
  {
    tool: 'sw_create_comment',
    args: { expense_id: 55, content: 'Nice expense!' },
    method: 'POST',
    path: '/create_comment',
    willSend: { expense_id: 55, content: 'Nice expense!' },
    write: ['POST', '/create_comment', { expense_id: 55, content: 'Nice expense!' }],
  },
  {
    tool: 'sw_delete_comment',
    args: { id: 12 },
    method: 'POST',
    path: '/delete_comment/12',
    write: ['POST', '/delete_comment/12'],
  },
];

describe('every write is gated (client without elicitation → token flow)', () => {
  it.each(GATED)('$tool: previews first, writes once with the token', async ({ tool, args, method, path, willSend, write }) => {
    harness = await createTestHarness(registerAll);
    const { phase1, result } = await confirmedCall(harness, mockRequest, tool, args);

    expect(typeof phase1.preview.action).toBe('string');
    expect(phase1.preview).toMatchObject({ method, path });
    if (willSend === undefined) expect(phase1.preview).not.toHaveProperty('willSend');
    else expect(phase1.preview.willSend).toEqual(willSend);

    expect(result.isError).toBeFalsy();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(...write);
  });

  it('no longer advertises a confirm parameter, only confirmToken', async () => {
    harness = await createTestHarness(registerAll);
    const tools = (await harness.client.listTools()).tools;
    for (const { tool } of GATED) {
      const t = tools.find((x) => x.name === tool)!;
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props, tool).toContain('confirmToken');
      expect(props, tool).not.toContain('confirm');
      expect(t.description, tool).toContain('MCP_CONFIRM_MODE');
      expect(t.description, tool).not.toContain('confirm:true');
    }
  });
});

describe('token refusals', () => {
  it('replaying a used token is refused as TOKEN_REUSED and does not write again', async () => {
    harness = await createTestHarness(registerAll);
    const args = { id: 42 };
    const { phase1 } = await confirmedCall(harness, mockRequest, 'sw_delete_expense', args);
    mockRequest.mockClear();

    const replay = await harness.callTool('sw_delete_expense', { ...args, confirmToken: phase1.confirmToken });
    expect(replay.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(replay).error).toBe('TOKEN_REUSED');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('changing an argument between the phases is refused as DRAFT_CHANGED and does not write', async () => {
    harness = await createTestHarness(registerAll);
    const first = await harness.callTool('sw_create_expense', {
      group_id: 1, description: 'Dinner', cost: '50.00', split_equally: true,
    });
    const { confirmToken } = parseToolResult<{ confirmToken: string }>(first);

    const changed = await harness.callTool('sw_create_expense', {
      group_id: 1, description: 'Dinner', cost: '500.00', split_equally: true, confirmToken,
    });
    expect(changed.isError).toBe(true);
    const body = parseToolResult<{ error: string; preview: { willSend: { cost: string } } }>(changed);
    expect(body.error).toBe('DRAFT_CHANGED');
    // The refusal carries the CURRENT preview, so the user can re-approve what will really happen.
    expect(body.preview.willSend.cost).toBe('500.00');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('a token issued for one target does not act on another', async () => {
    harness = await createTestHarness(registerAll);
    const first = await harness.callTool('sw_delete_group', { id: 1 });
    const { confirmToken } = parseToolResult<{ confirmToken: string }>(first);

    const other = await harness.callTool('sw_delete_group', { id: 2, confirmToken });
    expect(other.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('clients that can show a confirmation prompt', () => {
  it('writes when the user accepts the prompt', async () => {
    const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    harness = await createTestHarness(registerAll, { elicitation });
    const result = await harness.callTool('sw_delete_friend', { id: 7 });
    expect(elicitation).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_friend/7');
  });

  it('does not write when the user declines the prompt', async () => {
    harness = await createTestHarness(registerAll, {
      elicitation: async () => ({ action: 'decline' as const }),
    });
    const result = await harness.callTool('sw_delete_friend', { id: 7 });
    expect(parseToolResult<{ confirmed: boolean }>(result).confirmed).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('MCP_CONFIRM_MODE=refuse', () => {
  it('refuses writes on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    harness = await createTestHarness(registerAll);
    const result = await harness.callTool('sw_create_comment', { expense_id: 55, content: 'hi' });
    expect(parseToolResult<{ reason: string }>(result).reason).toBe('confirmation-unsupported');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
