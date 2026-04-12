import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { flattenUsers, registerExpenseTools } from '../../src/tools/expenses.js';
import type { SplitwiseClient } from '../../src/client.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as SplitwiseClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('expense tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerExpenseTools(server, mockClient));
  });

  it('has all 6 expense tools', async () => {
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('sw_list_expenses');
    expect(names).toContain('sw_get_expense');
    expect(names).toContain('sw_create_expense');
    expect(names).toContain('sw_update_expense');
    expect(names).toContain('sw_delete_expense');
    expect(names).toContain('sw_undelete_expense');
  });
});

describe('flattenUsers', () => {
  it('flattens users array to Splitwise flat-param format', () => {
    const result = flattenUsers([
      { user_id: 10, paid_share: '50.00', owed_share: '25.00' },
      { user_id: 20, paid_share: '0.00', owed_share: '25.00' },
    ]);
    expect(result).toEqual({
      'users__0__user_id': 10,
      'users__0__paid_share': '50.00',
      'users__0__owed_share': '25.00',
      'users__1__user_id': 20,
      'users__1__paid_share': '0.00',
      'users__1__owed_share': '25.00',
    });
  });
});

describe('sw_list_expenses', () => {
  it('calls GET /get_expenses with no params when none provided', async () => {
    mockRequest.mockResolvedValue({ expenses: [] });
    await harness.callTool('sw_list_expenses');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses');
  });

  it('appends query params when provided', async () => {
    mockRequest.mockResolvedValue({ expenses: [] });
    await harness.callTool('sw_list_expenses', { group_id: 5, limit: 10 });
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=10');
  });
});

describe('sw_get_expense', () => {
  it('calls GET /get_expense/{id}', async () => {
    mockRequest.mockResolvedValue({ expense: { id: 99 } });
    await harness.callTool('sw_get_expense', { id: 99 });
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_expense/99');
  });
});

describe('sw_create_expense', () => {
  it('sends equal-split body with split_equally:true', async () => {
    mockRequest.mockResolvedValue({ expenses: [{}] });
    await harness.callTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
  });

  it('flattens users array for custom split', async () => {
    mockRequest.mockResolvedValue({ expenses: [{}] });
    await harness.callTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      users: [
        { user_id: 10, paid_share: '50.00', owed_share: '25.00' },
        { user_id: 20, paid_share: '0.00', owed_share: '25.00' },
      ],
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      'users__0__user_id': 10,
      'users__1__user_id': 20,
    }));
  });

  it('throws if both split_equally and users are provided', async () => {
    const result = await harness.callTool('sw_create_expense', {
      group_id: 1, description: 'Dinner', cost: '50.00',
      split_equally: true,
      users: [{ user_id: 10, paid_share: '50.00', owed_share: '50.00' }],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Provide either split_equally or users, not both');
  });

  it('includes optional fields when provided', async () => {
    mockRequest.mockResolvedValue({ expenses: [{}] });
    await harness.callTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
      currency_code: 'EUR',
      date: '2026-03-18T00:00:00Z',
      category_id: 15,
      details: 'Team dinner',
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      currency_code: 'EUR',
      category_id: 15,
      details: 'Team dinner',
    }));
  });
});

describe('sw_update_expense', () => {
  it('calls POST /update_expense/{id} with provided fields only', async () => {
    mockRequest.mockResolvedValue({ expense: {} });
    await harness.callTool('sw_update_expense', {
      expense_id: 42,
      description: 'Updated dinner',
      cost: '60.00',
    });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/update_expense/42', {
      description: 'Updated dinner',
      cost: '60.00',
    });
  });

  it('throws if both split_equally and users provided in update', async () => {
    const result = await harness.callTool('sw_update_expense', {
      expense_id: 42,
      split_equally: true,
      users: [{ user_id: 1, paid_share: '50.00', owed_share: '50.00' }],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Provide either split_equally or users, not both');
  });
});

describe('sw_delete_expense', () => {
  it('calls POST /delete_expense/{id}', async () => {
    mockRequest.mockResolvedValue({ success: true });
    const result = await harness.callTool('sw_delete_expense', { id: 42 });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_expense/42');
    expect((result.content[0] as { text: string }).text).toContain('true');
  });
});

describe('sw_undelete_expense', () => {
  it('calls POST /undelete_expense/42', async () => {
    mockRequest.mockResolvedValue({ success: true });
    const result = await harness.callTool('sw_undelete_expense', { id: 42 });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/undelete_expense/42');
    expect(result.isError).toBeFalsy();
  });
});
