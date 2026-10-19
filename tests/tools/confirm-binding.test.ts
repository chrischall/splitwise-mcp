import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// mcp-utils 3.0 requires every confirmation to name the account it acts as
// and bind the tool's arguments. Splitwise is single-account per client (one
// API key), so the account is explicitly `undefined`; the args are the
// handler's validated input.

const seen: Array<Record<string, unknown>> = [];
vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return {
    ...actual,
    confirmationFromEnv: (opts: Parameters<typeof actual.confirmationFromEnv>[0]) => {
      seen.push(opts as unknown as Record<string, unknown>);
      return actual.confirmationFromEnv(opts);
    },
  };
});

const { client } = await import('../../src/client.js');
const { registerExpenseTools } = await import('../../src/tools/expenses.js');
const { registerFriendTools } = await import('../../src/tools/friends.js');
const { createTestHarness } = await import('../helpers.js');

const mockRequest = vi.spyOn(client, 'request').mockResolvedValue({ ok: true } as never);
afterAll(() => mockRequest.mockRestore());

beforeEach(() => {
  seen.length = 0;
  mockRequest.mockClear();
});

describe('confirmWrite bindings', () => {
  it('passes account: undefined and the tool arguments to confirmationFromEnv', async () => {
    const harness = await createTestHarness((server) => registerFriendTools(server, client));
    await harness.callTool('sw_create_friend', { user_email: 'a@example.com', user_first_name: 'A' });
    await harness.close();

    expect(seen).toHaveLength(1);
    expect('account' in seen[0]).toBe(true);
    expect(seen[0].account).toBeUndefined();
    expect(seen[0].args).toMatchObject({ user_email: 'a@example.com', user_first_name: 'A' });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // The expense writes go through mcp-utils' registerWrite → confirmWrite,
  // which binds the arguments inside the library (no confirmationFromEnv call
  // to intercept here), so the binding is checked by its effect.
  it('binds the full argument object on a registerWrite tool: a token for one call never acts on another', async () => {
    const { parseToolResult } = await import('../helpers.js');
    const harness = await createTestHarness((server) => registerExpenseTools(server, client));
    const first = parseToolResult<{ confirmToken: string }>(await harness.callTool('sw_delete_expense', { id: 42 }));
    const other = await harness.callTool('sw_delete_expense', { id: 43, confirmToken: first.confirmToken });
    expect(other.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    const same = await harness.callTool('sw_delete_expense', { id: 42, confirmToken: first.confirmToken });
    expect(same.isError).toBeFalsy();
    expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_expense/42');
    await harness.close();
  });
});
