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
