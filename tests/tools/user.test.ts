import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/user.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = {
  request: vi.fn(),
} as unknown as SplitwiseClient;

describe('user tools', () => {
  afterEach(() => vi.clearAllMocks());

  describe('toolDefinitions', () => {
    it('exports sw_get_current_user', () => {
      expect(toolDefinitions.some((t) => t.name === 'sw_get_current_user')).toBe(true);
    });
  });

  describe('sw_get_current_user', () => {
    it('calls GET /get_current_user and returns JSON', async () => {
      const userData = { user: { id: 123, first_name: 'Chris' } };
      mockClient.request = vi.fn().mockResolvedValue(userData);

      const result = await handleTool('sw_get_current_user', {}, mockClient);

      expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_current_user');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('"id": 123');
    });

    it('throws on unknown tool name', async () => {
      await expect(handleTool('sw_unknown', {}, mockClient)).rejects.toThrow('Unknown tool: sw_unknown');
    });
  });

  describe('sw_get_user', () => {
    it('is in toolDefinitions with readOnlyHint', () => {
      const tool = toolDefinitions.find((t) => t.name === 'sw_get_user');
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    });

    it('calls GET /get_user/42 and returns JSON', async () => {
      const userData = { user: { id: 42, first_name: 'Alex' } };
      mockClient.request = vi.fn().mockResolvedValue(userData);
      const result = await handleTool('sw_get_user', { id: 42 }, mockClient);
      expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_user/42');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('"id": 42');
    });
  });

  describe('sw_update_user', () => {
    it('is in toolDefinitions without readOnlyHint', () => {
      const tool = toolDefinitions.find((t) => t.name === 'sw_update_user');
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBeFalsy();
    });

    it('calls POST /update_user/99 with only provided fields', async () => {
      mockClient.request = vi.fn().mockResolvedValue({ user: { id: 99 } });
      await handleTool('sw_update_user', { id: 99, first_name: 'Chris' }, mockClient);
      expect(mockClient.request).toHaveBeenCalledWith('POST', '/update_user/99', { first_name: 'Chris' });
    });

    it('sends all provided optional fields', async () => {
      mockClient.request = vi.fn().mockResolvedValue({ user: {} });
      await handleTool('sw_update_user', {
        id: 99,
        first_name: 'Chris',
        last_name: 'Smith',
        email: 'chris@example.com',
        locale: 'en',
        default_currency: 'USD',
      }, mockClient);
      expect(mockClient.request).toHaveBeenCalledWith('POST', '/update_user/99', {
        first_name: 'Chris',
        last_name: 'Smith',
        email: 'chris@example.com',
        locale: 'en',
        default_currency: 'USD',
      });
    });

    it('does not send undefined optional fields', async () => {
      mockClient.request = vi.fn().mockResolvedValue({ user: {} });
      await handleTool('sw_update_user', { id: 99 }, mockClient);
      const [, , body] = (mockClient.request as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body).toEqual({});
    });
  });
});
