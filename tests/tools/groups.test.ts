import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/groups.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('groups toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 5 group tools', () => {
    expect(names).toContain('sw_list_groups');
    expect(names).toContain('sw_get_group');
    expect(names).toContain('sw_create_group');
    expect(names).toContain('sw_add_user_to_group');
    expect(names).toContain('sw_remove_user_from_group');
  });
});

describe('sw_list_groups', () => {
  it('calls GET /get_groups', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ groups: [] });
    const result = await handleTool('sw_list_groups', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_groups');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_get_group', () => {
  it('calls GET /get_group/42', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: { id: 42 } });
    const result = await handleTool('sw_get_group', { id: 42 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_group/42');
    expect(result.content[0].text).toContain('"id": 42');
  });
});

describe('sw_create_group', () => {
  it('calls POST /create_group with name', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: { id: 1, name: 'Vacation' } });
    await handleTool('sw_create_group', { name: 'Vacation' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_group', { name: 'Vacation' });
  });

  it('includes optional group_type when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: {} });
    await handleTool('sw_create_group', { name: 'Trip', group_type: 'trip' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_group', {
      name: 'Trip',
      group_type: 'trip',
    });
  });
});

describe('sw_add_user_to_group', () => {
  it('sends {group_id, user_id} when user_id is provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_add_user_to_group', { group_id: 10, user_id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/add_user_to_group', {
      group_id: 10,
      user_id: 99,
    });
  });

  it('sends {group_id, first_name, last_name, email} when user_id is absent', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_add_user_to_group', {
      group_id: 10,
      first_name: 'Meredith',
      last_name: 'Grey',
      email: 'meredith@example.com',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/add_user_to_group', {
      group_id: 10,
      first_name: 'Meredith',
      last_name: 'Grey',
      email: 'meredith@example.com',
    });
  });

  it('throws if user_id absent and name/email fields missing', async () => {
    await expect(
      handleTool('sw_add_user_to_group', { group_id: 10, first_name: 'Meredith' }, mockClient)
    ).rejects.toThrow('first_name, last_name, and email are required when user_id is not provided');
  });
});

describe('sw_remove_user_from_group', () => {
  it('calls POST /remove_user_from_group with group_id and user_id', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_remove_user_from_group', { group_id: 10, user_id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/remove_user_from_group', {
      group_id: 10,
      user_id: 99,
    });
  });
});
