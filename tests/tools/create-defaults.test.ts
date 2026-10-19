import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { client } from '../../src/client.js';
import { clearCategoryCache } from '../../src/tools/_create.js';
import { confirmedCall, createTestHarness, parseToolResult, writes } from '../helpers.js';

// "Create defaults" and "duplicate detection", from a real session: a new
// expense landed in "General", the 50/50-where-the-other-parent-paid case had
// to be hand-built as users[], and identical pairs (same date, cost,
// description) were found after the fact.

const mockRequest = vi.spyOn(client, 'request');

const CHRIS = { id: 1, first_name: 'Chris', last_name: 'Hall', email: 'c@example.com' };
const ALISON = { id: 2, first_name: 'Alison', last_name: 'Hall', email: 'a@example.com' };

const CATEGORIES = {
  categories: [
    { id: 1, name: 'Utilities', subcategories: [{ id: 5, name: 'Electricity' }, { id: 8, name: 'Water' }] },
    { id: 2, name: 'Uncategorized', subcategories: [{ id: 18, name: 'General' }] },
    { id: 19, name: 'Life', subcategories: [{ id: 41, name: 'Clothing' }, { id: 50, name: 'Education' }, { id: 51, name: 'Medical expenses' }] },
  ],
};

function exp(id: number, over: Record<string, unknown> = {}) {
  return { id, group_id: 5, description: 'Groceries', cost: '20.00', date: '2026-10-10T12:00:00Z', deleted_at: null, category: { id: 18, name: 'General' }, ...over };
}

/** Fake Splitwise: categories, group members, and two expense queries (recent history vs the ±1-day window). */
function fake(opts: { recent?: unknown[]; window?: unknown[] } = {}) {
  mockRequest.mockImplementation(async (method: string, path: string) => {
    if (method !== 'GET') return { expenses: [{ id: 999, deleted_at: null }] } as never;
    if (path === '/get_categories') return CATEGORIES as never;
    if (path.startsWith('/get_group/')) return { group: { id: 5, members: [CHRIS, ALISON] } } as never;
    if (path.startsWith('/get_expenses') && path.includes('dated_after')) return { expenses: opts.window ?? [] } as never;
    if (path.startsWith('/get_expenses')) return { expenses: opts.recent ?? [] } as never;
    return {} as never;
  });
}

const posted = () => mockRequest.mock.calls.find((c) => c[0] === 'POST')?.[2] as Record<string, unknown>;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({} as never);
  clearCategoryCache();
});
afterAll(async () => {
  if (harness) await harness.close();
  mockRequest.mockRestore();
});

describe('sw_create_expense defaults', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerExpenseTools(server, client));
  });

  describe('category by name', () => {
    it('resolves a subcategory name (any case) to its id', async () => {
      fake();
      await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Shoes', cost: '30.00', split_equally: true, category: 'clothing' });
      expect(posted()).toMatchObject({ category_id: 41 });
      expect(posted()).not.toHaveProperty('category');
    });

    it('fetches the category list once and caches it', async () => {
      fake();
      await harness.callTool('sw_create_expense', { group_id: 5, description: 'a', cost: '1.00', split_equally: true, category: 'Water' });
      await harness.callTool('sw_create_expense', { group_id: 5, description: 'b', cost: '1.00', split_equally: true, category: 'Water' });
      expect(mockRequest.mock.calls.filter((c) => c[1] === '/get_categories')).toHaveLength(1);
    });

    it('refuses an unknown name and suggests close ones', async () => {
      fake();
      const result = await harness.callTool('sw_create_expense', { group_id: 5, description: 'x', cost: '1.00', split_equally: true, category: 'Medical' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Medical expenses');
      expect(writes(mockRequest)).toBe(0);
    });

    it('refuses a parent category and lists its subcategories', async () => {
      fake();
      const result = await harness.callTool('sw_create_expense', { group_id: 5, description: 'x', cost: '1.00', split_equally: true, category: 'Utilities' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/Electricity.*Water/);
    });

    it('refuses category together with category_id', async () => {
      const result = await harness.callTool('sw_create_expense', { group_id: 5, description: 'x', cost: '1.00', split_equally: true, category: 'Water', category_id: 8 });
      expect(result.isError).toBe(true);
    });
  });

  describe('category inference', () => {
    it('uses the most common category of similar descriptions in the group, and says so in the preview', async () => {
      fake({
        recent: [
          exp(1, { description: 'Egan tuition October', category: { id: 50, name: 'Education' } }),
          exp(2, { description: 'Egan tuition September', category: { id: 50, name: 'Education' } }),
          exp(3, { description: 'Egan tuition August', category: { id: 18, name: 'General' } }),
          exp(4, { description: 'Pizza', category: { id: 41, name: 'Clothing' } }),
        ],
      });
      const { phase1 } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Egan tuition November', cost: '400.00', split_equally: true });
      expect(posted()).toMatchObject({ category_id: 50 });
      expect(phase1.preview.inferred_category).toEqual({ id: 50, name: 'Education', similar_expenses: 2 });
    });

    it('leaves the category alone when nothing similar exists', async () => {
      fake({ recent: [exp(4, { description: 'Pizza', category: { id: 41, name: 'Clothing' } })] });
      await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Egan tuition', cost: '1.00', split_equally: true });
      expect(posted()).not.toHaveProperty('category_id');
    });

    it('never overrides an explicit category_id', async () => {
      fake({ recent: [exp(1, { description: 'Egan tuition', category: { id: 50, name: 'Education' } })] });
      await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Egan tuition', cost: '1.00', split_equally: true, category_id: 18 });
      expect(posted()).toMatchObject({ category_id: 18 });
    });
  });

  describe('split: "equal" with paid_by', () => {
    it('builds the 50/50 shares with the named member as payer, odd cent to the first participant', async () => {
      fake();
      const { phase1 } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Camp', cost: '25.01', split: 'equal', paid_by: 'Alison' });
      expect(posted()).toMatchObject({
        users__0__user_id: 1, users__0__paid_share: '0.00', users__0__owed_share: '12.51',
        users__1__user_id: 2, users__1__paid_share: '25.01', users__1__owed_share: '12.50',
      });
      expect(posted()).not.toHaveProperty('split');
      expect(posted()).not.toHaveProperty('paid_by');
      expect(posted()).not.toHaveProperty('split_equally');
      expect(phase1.preview.willSend).toMatchObject({ users__1__paid_share: '25.01' });
    });

    it('honours split_among', async () => {
      fake();
      await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'x', cost: '9.00', split: 'equal', paid_by: 1, split_among: [2] });
      expect(posted()).toMatchObject({
        users__0__user_id: 2, users__0__paid_share: '0.00', users__0__owed_share: '9.00',
        users__1__user_id: 1, users__1__paid_share: '9.00', users__1__owed_share: '0.00',
      });
    });

    it.each([
      [{ split: 'equal' }, /paid_by/],
      [{ split: 'equal', paid_by: 1, split_equally: true }, /split_equally/],
      [{ split: 'equal', paid_by: 1, users: [{ user_id: 1, paid_share: '1.00', owed_share: '1.00' }] }, /users/],
      [{ paid_by: 1 }, /split/],
    ])('refuses an inconsistent request %o before anything is sent', async (extra, message) => {
      fake();
      const result = await harness.callTool('sw_create_expense', { group_id: 5, description: 'x', cost: '1.00', ...extra });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(message);
      expect(writes(mockRequest)).toBe(0);
    });
  });

  describe('duplicate warning', () => {
    it('lists live or deleted expenses with the same cost, a similar description and a date within a day', async () => {
      fake({
        window: [
          exp(10, { description: 'groceries at Harris Teeter', cost: '20.00', date: '2026-10-11T09:00:00Z' }),
          exp(11, { description: 'Groceries', cost: '20.00', deleted_at: '2026-10-12T00:00:00Z' }),
          exp(12, { description: 'Groceries', cost: '21.00' }),
          exp(13, { description: 'Gas', cost: '20.00' }),
        ],
      });
      const { phase1 } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Groceries', cost: '20.00', date: '2026-10-10T12:00:00Z', split_equally: true });
      expect(phase1.preview.possible_duplicates).toEqual([
        { id: 10, date: '2026-10-11T09:00:00Z', description: 'groceries at Harris Teeter', cost: '20.00', deleted: false },
        { id: 11, date: '2026-10-10T12:00:00Z', description: 'Groceries', cost: '20.00', deleted: true },
      ]);
      expect(String(phase1.preview.action)).toMatch(/possible duplicate/i);
      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&dated_after=2026-10-09T12%3A00%3A00.000Z&dated_before=2026-10-11T12%3A00%3A00.000Z&limit=200');
    });

    it('is a warning, not a refusal: the confirmed call still creates', async () => {
      fake({ window: [exp(10)] });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Groceries', cost: '20.00', date: '2026-10-10T12:00:00Z', split_equally: true });
      expect(result.isError).toBeFalsy();
      expect(posted()).toMatchObject({ description: 'Groceries' });
    });

    it('adds nothing to the preview when there is no match', async () => {
      fake({ window: [exp(13, { description: 'Gas' })] });
      const { phase1 } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Groceries', cost: '20.00', split_equally: true });
      expect(phase1.preview).not.toHaveProperty('possible_duplicates');
    });

    it('does not block the create when the duplicate scan itself fails', async () => {
      mockRequest.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new Error('boom');
        return { expenses: [{ id: 1 }] } as never;
      });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 5, description: 'Groceries', cost: '20.00', split_equally: true });
      expect(result.isError).toBeFalsy();
    });
  });
});
