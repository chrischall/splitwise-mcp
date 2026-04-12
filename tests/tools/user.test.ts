import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { SplitwiseClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { createTestHarness } from '../helpers.js';

const mockRequest = vi.fn();
const mockClient = { request: mockRequest } as unknown as SplitwiseClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (harness) await harness.close(); });

describe('user tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerUserTools(server, mockClient));
  });

  describe('sw_get_current_user', () => {
    it('calls GET /get_current_user and returns JSON', async () => {
      const userData = { user: { id: 123, first_name: 'Chris' } };
      mockRequest.mockResolvedValue(userData);

      const result = await harness.callTool('sw_get_current_user');

      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_current_user');
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain('"id": 123');
    });
  });

  describe('sw_get_user', () => {
    it('calls GET /get_user/42 and returns JSON', async () => {
      const userData = { user: { id: 42, first_name: 'Alex' } };
      mockRequest.mockResolvedValue(userData);
      const result = await harness.callTool('sw_get_user', { id: 42 });
      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_user/42');
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain('"id": 42');
    });
  });

  describe('sw_update_user', () => {
    it('calls POST /update_user/99 with only provided fields', async () => {
      mockRequest.mockResolvedValue({ user: { id: 99 } });
      await harness.callTool('sw_update_user', { id: 99, first_name: 'Chris' });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/update_user/99', { first_name: 'Chris' });
    });

    it('sends all provided optional fields', async () => {
      mockRequest.mockResolvedValue({ user: {} });
      await harness.callTool('sw_update_user', {
        id: 99,
        first_name: 'Chris',
        last_name: 'Smith',
        email: 'chris@example.com',
        locale: 'en',
        default_currency: 'USD',
      });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/update_user/99', {
        first_name: 'Chris',
        last_name: 'Smith',
        email: 'chris@example.com',
        locale: 'en',
        default_currency: 'USD',
      });
    });

    it('does not send undefined optional fields', async () => {
      mockRequest.mockResolvedValue({ user: {} });
      await harness.callTool('sw_update_user', { id: 99 });
      const [, , body] = mockRequest.mock.calls[0];
      expect(body).toEqual({});
    });
  });
});
