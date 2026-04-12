import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { SplitwiseClient } from '../../src/client.js';
import { registerFriendTools } from '../../src/tools/friends.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as SplitwiseClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('friend tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerFriendTools(server, mockClient));
  });

  describe('sw_list_friends', () => {
    it('calls GET /get_friends and returns JSON', async () => {
      const friendsData = { friends: [{ id: 7, first_name: 'Meredith' }] };
      mockRequest.mockResolvedValue(friendsData);

      const result = await harness.callTool('sw_list_friends');

      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_friends');
      expect((result.content[0] as { text: string }).text).toContain('"first_name": "Meredith"');
    });
  });

  describe('sw_create_friend', () => {
    it('calls POST /create_friend with required user_email', async () => {
      mockRequest.mockResolvedValue({ friends: [] });
      const result = await harness.callTool('sw_create_friend', { user_email: 'new@example.com' });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/create_friend', { user_email: 'new@example.com' });
      expect(result.isError).toBeFalsy();
    });

    it('includes optional name fields when provided', async () => {
      mockRequest.mockResolvedValue({ friends: [] });
      await harness.callTool('sw_create_friend', {
        user_email: 'new@example.com',
        user_first_name: 'Jane',
        user_last_name: 'Doe',
      });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/create_friend', {
        user_email: 'new@example.com',
        user_first_name: 'Jane',
        user_last_name: 'Doe',
      });
    });

    it('does not send undefined optional fields', async () => {
      mockRequest.mockResolvedValue({ friends: [] });
      await harness.callTool('sw_create_friend', { user_email: 'new@example.com' });
      const [, , body] = mockRequest.mock.calls[0];
      expect(body).not.toHaveProperty('user_first_name');
      expect(body).not.toHaveProperty('user_last_name');
    });
  });

  describe('sw_delete_friend', () => {
    it('calls POST /delete_friend/7', async () => {
      mockRequest.mockResolvedValue({ success: true });
      const result = await harness.callTool('sw_delete_friend', { id: 7 });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_friend/7');
      expect(result.isError).toBeFalsy();
    });
  });
});
