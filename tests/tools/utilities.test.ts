import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/utilities.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('utilities toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 3 utility tools', () => {
    expect(names).toContain('sw_get_notifications');
    expect(names).toContain('sw_get_categories');
    expect(names).toContain('sw_get_currencies');
  });
});

describe('sw_get_notifications', () => {
  it('calls GET /get_notifications', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ notifications: [] });
    const result = await handleTool('sw_get_notifications', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_notifications');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_get_categories', () => {
  it('calls GET /get_categories', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ categories: [] });
    await handleTool('sw_get_categories', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_categories');
  });
});

describe('sw_get_currencies', () => {
  it('calls GET /get_currencies', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ currencies: [] });
    await handleTool('sw_get_currencies', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_currencies');
  });
});

describe('sw_get_comments', () => {
  it('is in toolDefinitions with readOnlyHint', () => {
    const tool = toolDefinitions.find((t) => t.name === 'sw_get_comments');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('calls GET /get_comments?expense_id=55', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ comments: [] });
    const result = await handleTool('sw_get_comments', { expense_id: 55 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_comments?expense_id=55');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_create_comment', () => {
  it('is in toolDefinitions', () => {
    expect(toolDefinitions.some((t) => t.name === 'sw_create_comment')).toBe(true);
  });

  it('calls POST /create_comment with expense_id and content', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ comment: {} });
    const result = await handleTool('sw_create_comment', { expense_id: 55, content: 'Nice expense!' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_comment', {
      expense_id: 55,
      content: 'Nice expense!',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_delete_comment', () => {
  it('is in toolDefinitions with destructiveHint', () => {
    const tool = toolDefinitions.find((t) => t.name === 'sw_delete_comment');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it('calls POST /delete_comment/12', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    const result = await handleTool('sw_delete_comment', { id: 12 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/delete_comment/12');
    expect(result.isError).toBeFalsy();
  });
});
