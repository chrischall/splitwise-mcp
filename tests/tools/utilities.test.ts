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
