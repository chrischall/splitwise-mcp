import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/friends.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('sw_list_friends', () => {
  it('is exported in toolDefinitions', () => {
    expect(toolDefinitions.some((t) => t.name === 'sw_list_friends')).toBe(true);
  });

  it('calls GET /get_friends and returns JSON', async () => {
    const friendsData = { friends: [{ id: 7, first_name: 'Meredith' }] };
    mockClient.request = vi.fn().mockResolvedValue(friendsData);

    const result = await handleTool('sw_list_friends', {}, mockClient);

    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_friends');
    expect(result.content[0].text).toContain('"first_name": "Meredith"');
  });
});

describe('sw_create_friend', () => {
  it('is in toolDefinitions', () => {
    expect(toolDefinitions.some((t) => t.name === 'sw_create_friend')).toBe(true);
  });

  it('calls POST /create_friend with required user_email', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ friends: [] });
    const result = await handleTool('sw_create_friend', { user_email: 'new@example.com' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_friend', { user_email: 'new@example.com' });
    expect(result.isError).toBeFalsy();
  });

  it('includes optional name fields when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ friends: [] });
    await handleTool('sw_create_friend', {
      user_email: 'new@example.com',
      user_first_name: 'Jane',
      user_last_name: 'Doe',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_friend', {
      user_email: 'new@example.com',
      user_first_name: 'Jane',
      user_last_name: 'Doe',
    });
  });

  it('does not send undefined optional fields', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ friends: [] });
    await handleTool('sw_create_friend', { user_email: 'new@example.com' }, mockClient);
    const [, , body] = (mockClient.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).not.toHaveProperty('user_first_name');
    expect(body).not.toHaveProperty('user_last_name');
  });
});

describe('sw_delete_friend', () => {
  it('is in toolDefinitions with destructiveHint', () => {
    const tool = toolDefinitions.find((t) => t.name === 'sw_delete_friend');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it('calls POST /delete_friend/7', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    const result = await handleTool('sw_delete_friend', { id: 7 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/delete_friend/7');
    expect(result.isError).toBeFalsy();
  });
});
