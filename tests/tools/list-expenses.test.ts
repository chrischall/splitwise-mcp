import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { client } from '../../src/client.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// "sw_list_expenses is too heavy for reconciliation": a year of one group came
// back as ~110K characters and was truncated, when all that was wanted was
// every "egan" entry, deleted ones included.

const mockRequest = vi.spyOn(client, 'request');

const ALISON = { id: 2, first_name: 'Alison', last_name: 'Hall' };
const CHRIS = { id: 1, first_name: 'Chris', last_name: 'Hall' };

function expense(id: number, over: Record<string, unknown> = {}) {
  return {
    id, group_id: 5, description: `Item ${id}`, cost: '10.00', currency_code: 'USD',
    date: `2026-01-${String((id % 28) + 1).padStart(2, '0')}T12:00:00Z`,
    created_by: CHRIS, updated_by: CHRIS, deleted_at: null, deleted_by: null,
    category: { id: 18, name: 'General' }, comments_count: 0, receipt: { large: null, original: null },
    users: [{ user: CHRIS, user_id: 1, paid_share: '10.00', owed_share: '5.00', net_balance: '5.00' }],
    repayments: [],
    ...over,
  };
}

/** A fake upstream holding `all`, answering get_expenses with Splitwise's limit/offset paging. */
function upstream(all: unknown[], comments: Record<number, unknown[]> = {}) {
  mockRequest.mockImplementation(async (_method: string, path: string) => {
    const url = new URL(path, 'https://x.test');
    if (url.pathname === '/get_comments') {
      return { comments: comments[Number(url.searchParams.get('expense_id'))] ?? [] } as never;
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return { expenses: all.slice(offset, offset + limit) } as never;
  });
}

type ListResult = { expenses: Array<Record<string, unknown>>; next_cursor?: string; scanned?: number };
let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ expenses: [] } as never);
});
afterAll(async () => {
  if (harness) await harness.close();
  mockRequest.mockRestore();
});

async function list(args: Record<string, unknown>): Promise<ListResult> {
  const result = await harness.callTool('sw_list_expenses', args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return parseToolResult<{ data: ListResult }>(result).data ?? parseToolResult<ListResult>(result);
}

describe('sw_list_expenses filters', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerExpenseTools(server, client));
  });

  it('description_contains matches case-insensitively, and scans past the first upstream page', async () => {
    const all = Array.from({ length: 450 }, (_, i) => expense(i + 1));
    all[10] = expense(11, { description: 'EGAN camp' });
    all[300] = expense(301, { description: 'egan tuition' });
    upstream(all);
    const out = await list({ group_id: 5, description_contains: 'Egan', view: 'rows' });
    expect(out.expenses.map((e) => e.id)).toEqual([11, 301]);
    // Upstream is read 200 at a time, keeping the group filter.
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=200&offset=0');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=200&offset=200');
    expect(out.next_cursor).toBeUndefined();
  });

  it.each([
    [true, [1, 2, 3]],
    [false, [1, 3]],
    ['only', [2]],
  ] as const)('include_deleted: %s', async (include_deleted, ids) => {
    upstream([expense(1), expense(2, { deleted_at: '2026-02-01T00:00:00Z', deleted_by: ALISON }), expense(3)]);
    const out = await list({ include_deleted, view: 'rows' });
    expect(out.expenses.map((e) => e.id)).toEqual(ids);
  });

  it('created_by takes an id or a name', async () => {
    upstream([expense(1), expense(2, { created_by: ALISON })]);
    expect((await list({ created_by: 2 })).expenses.map((e) => e.id)).toEqual([2]);
    expect((await list({ created_by: 'chris hall' })).expenses.map((e) => e.id)).toEqual([1]);
  });

  it('min_cost / max_cost bound the cost, inclusive', async () => {
    upstream([expense(1, { cost: '5.00' }), expense(2, { cost: '25.00' }), expense(3, { cost: '50.00' })]);
    expect((await list({ min_cost: 25, max_cost: 50 })).expenses.map((e) => e.id)).toEqual([2, 3]);
  });

  it('category takes a name (any case) or an id', async () => {
    upstream([expense(1), expense(2, { category: { id: 41, name: 'Clothing' } })]);
    expect((await list({ category: 'clothing' })).expenses.map((e) => e.id)).toEqual([2]);
    expect((await list({ category: 18 })).expenses.map((e) => e.id)).toEqual([1]);
  });

  it('view "rows" returns the minimal projection only', async () => {
    upstream([expense(1, { deleted_at: '2026-02-01T00:00:00Z', deleted_by: ALISON, comments_count: 2 })]);
    const [row] = (await list({ view: 'rows' })).expenses;
    expect(Object.keys(row!).sort()).toEqual(
      ['category', 'comments_count', 'cost', 'created_by', 'currency_code', 'date', 'deleted_at', 'deleted_by', 'description', 'has_receipt', 'id'].sort(),
    );
    expect(row).toMatchObject({ deleted_by: 'Alison Hall', has_receipt: false });
  });

  it('pages with a cursor: limit matches per call, next_cursor resumes exactly after the last', async () => {
    upstream(Array.from({ length: 30 }, (_, i) => expense(i + 1, { description: i % 2 ? 'egan' : 'other' })));
    const first = await list({ description_contains: 'egan', limit: 4, view: 'rows' });
    expect(first.expenses.map((e) => e.id)).toEqual([2, 4, 6, 8]);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await list({ description_contains: 'egan', limit: 4, view: 'rows', cursor: first.next_cursor });
    expect(second.expenses.map((e) => e.id)).toEqual([10, 12, 14, 16]);
  });

  it('refuses a cursor from a different query', async () => {
    upstream(Array.from({ length: 30 }, (_, i) => expense(i + 1)));
    const first = await list({ description_contains: 'item', limit: 2 });
    const result = await harness.callTool('sw_list_expenses', { description_contains: 'other', limit: 2, cursor: first.next_cursor });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cursor/);
  });

  it('stops at the scan budget and hands back a cursor rather than reading the whole history', async () => {
    upstream(Array.from({ length: 2000 }, (_, i) => expense(i + 1)));
    const out = await list({ description_contains: 'never matches' });
    expect(out.expenses).toEqual([]);
    expect(out.scanned).toBe(1000);
    expect(out.next_cursor).toEqual(expect.any(String));
  });

  it('include_comments inlines comments for matched rows that have any', async () => {
    upstream(
      [expense(1, { comments_count: 1, description: 'egan' }), expense(2, { description: 'egan' })],
      { 1: [{ id: 9, content: 'deleted: duplicate of 3', comment_type: 'User', created_at: '2026-02-01T00:00:00Z', user: ALISON }] },
    );
    const out = await list({ description_contains: 'egan', include_comments: true, view: 'rows' });
    expect(out.expenses[0]!.comments).toEqual([
      { id: 9, author: 'Alison Hall', content: 'deleted: duplicate of 3', comment_type: 'User', created_at: '2026-02-01T00:00:00Z' },
    ]);
    expect(out.expenses[1]).not.toHaveProperty('comments');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_comments?expense_id=1');
    expect(mockRequest).not.toHaveBeenCalledWith('GET', '/get_comments?expense_id=2');
  });

  it('still fences the result as untrusted content', async () => {
    upstream([expense(1)]);
    const result = await harness.callTool('sw_list_expenses', { description_contains: 'item' });
    expect(JSON.stringify(result.content)).toMatch(/untrusted/i);
  });

  it('without the new filters, makes exactly the request it made before', async () => {
    upstream([expense(1)]);
    await list({ group_id: 5, limit: 10 });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=10');
  });
});
