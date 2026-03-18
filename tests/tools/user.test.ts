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
});
