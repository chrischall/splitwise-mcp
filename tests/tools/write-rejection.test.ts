import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { SplitwiseClient } from '../../src/client.js';
import { confirmedCall, createTestHarness } from '../helpers.js';

// End-to-end: drive real tools through a real SplitwiseClient with only
// `fetch` stubbed, so a Splitwise write that returns HTTP 200 with an
// `errors` body must surface to the caller as an MCP tool error
// (`isError: true`), not as a successful result.
//
// The client's underlying API client binds `fetch` when it is built, so the
// stub goes in FIRST and a fresh client + harness is built per test.

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
const savedKey = process.env.SPLITWISE_API_KEY;

async function stubBody(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new SplitwiseClient();
  harness = await createTestHarness((server) => registerExpenseTools(server, client));
  return { fetchMock, harness };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

beforeAll(() => {
  process.env.SPLITWISE_API_KEY = 'test-key';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (harness) await harness.close();
  harness = undefined;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.SPLITWISE_API_KEY;
  else process.env.SPLITWISE_API_KEY = savedKey;
});

describe('write rejections surface as tool errors (HTTP 200 with errors)', () => {
  it('sw_create_expense returns isError when Splitwise rejects the expense', async () => {
    const { fetchMock, harness } = await stubBody({
      expenses: [],
      errors: { base: ['An expense must have a cost'] },
    });
    const { result } = await confirmedCall(harness, fetchMock, 'sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Splitwise rejected the request');
    expect(textOf(result)).toContain('An expense must have a cost');
  });

  it('sw_delete_expense returns isError on {success: false, errors}', async () => {
    const { fetchMock, harness } = await stubBody({ success: false, errors: { base: ['Expense not found'] } });
    const { result } = await confirmedCall(harness, fetchMock, 'sw_delete_expense', { id: 42 });
    expect(fetchMock).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Expense not found');
  });

  it('sw_create_expense succeeds when the errors object is empty', async () => {
    const { fetchMock, harness } = await stubBody({ expenses: [{ id: 5 }], errors: {} });
    const { result } = await confirmedCall(harness, fetchMock, 'sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });
});
