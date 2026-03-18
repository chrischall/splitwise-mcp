import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool, flattenUsers } from '../../src/tools/expenses.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 5 expense tools', () => {
    expect(names).toContain('sw_list_expenses');
    expect(names).toContain('sw_get_expense');
    expect(names).toContain('sw_create_expense');
    expect(names).toContain('sw_update_expense');
    expect(names).toContain('sw_delete_expense');
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
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [] });
    await handleTool('sw_list_expenses', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expenses');
  });

  it('appends query params when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [] });
    await handleTool('sw_list_expenses', { group_id: 5, limit: 10 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=10');
  });
});

describe('sw_get_expense', () => {
  it('calls GET /get_expense/{id}', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expense: { id: 99 } });
    await handleTool('sw_get_expense', { id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expense/99');
  });
});

describe('sw_create_expense', () => {
  it('sends equal-split body with split_equally:true', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
  });

  it('flattens users array for custom split', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      users: [
        { user_id: 10, paid_share: '50.00', owed_share: '25.00' },
        { user_id: 20, paid_share: '0.00', owed_share: '25.00' },
      ],
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      'users__0__user_id': 10,
      'users__1__user_id': 20,
    }));
  });

  it('throws if both split_equally and users are provided', async () => {
    await expect(
      handleTool('sw_create_expense', {
        group_id: 1, description: 'Dinner', cost: '50.00',
        split_equally: true,
        users: [{ user_id: 10, paid_share: '50.00', owed_share: '50.00' }],
      }, mockClient)
    ).rejects.toThrow('Provide either split_equally or users, not both');
  });

  it('includes optional fields when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
      currency_code: 'EUR',
      date: '2026-03-18T00:00:00Z',
      category_id: 15,
      details: 'Team dinner',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      currency_code: 'EUR',
      category_id: 15,
      details: 'Team dinner',
    }));
  });
});

describe('sw_update_expense', () => {
  it('calls POST /update_expense/{id} with provided fields only', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expense: {} });
    await handleTool('sw_update_expense', {
      expense_id: 42,
      description: 'Updated dinner',
      cost: '60.00',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/update_expense/42', {
      description: 'Updated dinner',
      cost: '60.00',
    });
  });

  it('throws if both split_equally and users provided in update', async () => {
    await expect(
      handleTool('sw_update_expense', {
        expense_id: 42,
        split_equally: true,
        users: [{ user_id: 1, paid_share: '50.00', owed_share: '50.00' }],
      }, mockClient)
    ).rejects.toThrow('Provide either split_equally or users, not both');
  });
});

describe('sw_delete_expense', () => {
  it('calls POST /delete_expense/{id}', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    const result = await handleTool('sw_delete_expense', { id: 42 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/delete_expense/42');
    expect(result.content[0].text).toContain('true');
  });
});
