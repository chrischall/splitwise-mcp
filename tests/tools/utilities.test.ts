import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { SplitwiseClient } from '../../src/client.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as SplitwiseClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('utility tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerUtilityTools(server, mockClient));
  });

  it('has all 6 utility tools', async () => {
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('sw_get_notifications');
    expect(names).toContain('sw_get_categories');
    expect(names).toContain('sw_get_currencies');
    expect(names).toContain('sw_get_comments');
    expect(names).toContain('sw_create_comment');
    expect(names).toContain('sw_delete_comment');
  });
});

describe('sw_get_notifications', () => {
  it('calls GET /get_notifications', async () => {
    mockRequest.mockResolvedValue({ notifications: [] });
    const result = await harness.callTool('sw_get_notifications');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_notifications');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_get_categories', () => {
  it('calls GET /get_categories', async () => {
    mockRequest.mockResolvedValue({ categories: [] });
    await harness.callTool('sw_get_categories');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_categories');
  });
});

describe('sw_get_currencies', () => {
  it('calls GET /get_currencies', async () => {
    mockRequest.mockResolvedValue({ currencies: [] });
    await harness.callTool('sw_get_currencies');
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_currencies');
  });
});

describe('sw_get_comments', () => {
  it('calls GET /get_comments?expense_id=55', async () => {
    mockRequest.mockResolvedValue({ comments: [] });
    const result = await harness.callTool('sw_get_comments', { expense_id: 55 });
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_comments?expense_id=55');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_create_comment', () => {
  it('calls POST /create_comment with expense_id and content', async () => {
    mockRequest.mockResolvedValue({ comment: {} });
    const result = await harness.callTool('sw_create_comment', { expense_id: 55, content: 'Nice expense!' });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/create_comment', {
      expense_id: 55,
      content: 'Nice expense!',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_delete_comment', () => {
  it('calls POST /delete_comment/12', async () => {
    mockRequest.mockResolvedValue({ success: true });
    const result = await harness.callTool('sw_delete_comment', { id: 12 });
    expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_comment/12');
    expect(result.isError).toBeFalsy();
  });
});
