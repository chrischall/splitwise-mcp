import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerGroupTools } from '../../src/tools/groups.js';
import { confirmedCall, createTestHarness } from '../helpers.js';

// Tool registrars use the module-level `client` singleton; spy on its `request`.
const mockRequest = vi.spyOn(client, 'request').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => mockRequest.mockClear());
afterAll(async () => { if (harness) await harness.close(); });

describe('group tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerGroupTools(server, client));
  });

  it('lists all 7 group tools', async () => {
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('sw_list_groups');
    expect(names).toContain('sw_get_group');
    expect(names).toContain('sw_create_group');
    expect(names).toContain('sw_add_user_to_group');
    expect(names).toContain('sw_remove_user_from_group');
    expect(names).toContain('sw_delete_group');
    expect(names).toContain('sw_undelete_group');
  });

  describe('sw_list_groups', () => {
    it('calls GET /get_groups', async () => {
      mockRequest.mockResolvedValue({ groups: [] });
      const result = await harness.callTool('sw_list_groups');
      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_groups');
      expect(result.isError).toBeFalsy();
    });
  });

  describe('sw_get_group', () => {
    it('calls GET /get_group/42', async () => {
      mockRequest.mockResolvedValue({ group: { id: 42 } });
      const result = await harness.callTool('sw_get_group', { id: 42 });
      expect(mockRequest).toHaveBeenCalledWith('GET', '/get_group/42');
      expect(JSON.parse((result.content[0] as { text: string }).text).group.id).toBe(42);
    });
  });

  describe('sw_create_group', () => {
    it('calls POST /create_group with name', async () => {
      mockRequest.mockResolvedValue({ group: { id: 1, name: 'Vacation' } });
      await confirmedCall(harness, mockRequest, 'sw_create_group', { name: 'Vacation' });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/create_group', { name: 'Vacation' });
    });

    it('includes optional group_type when provided', async () => {
      mockRequest.mockResolvedValue({ group: {} });
      await confirmedCall(harness, mockRequest, 'sw_create_group', { name: 'Trip', group_type: 'trip' });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/create_group', {
        name: 'Trip',
        group_type: 'trip',
      });
    });
  });

  describe('sw_add_user_to_group', () => {
    it('sends {group_id, user_id} when user_id is provided', async () => {
      mockRequest.mockResolvedValue({ success: true });
      await confirmedCall(harness, mockRequest, 'sw_add_user_to_group', { group_id: 10, user_id: 99 });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/add_user_to_group', {
        group_id: 10,
        user_id: 99,
      });
    });

    it('sends {group_id, first_name, last_name, email} when user_id is absent', async () => {
      mockRequest.mockResolvedValue({ success: true });
      await confirmedCall(harness, mockRequest, 'sw_add_user_to_group', { group_id: 10,
        first_name: 'Meredith',
        last_name: 'Grey',
        email: 'meredith@example.com',
      });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/add_user_to_group', {
        group_id: 10,
        first_name: 'Meredith',
        last_name: 'Grey',
        email: 'meredith@example.com',
      });
    });

    it('throws if user_id absent and name/email fields missing', async () => {
      // The guard runs before the confirmation gate, so it refuses on the first
      // call and still refuses when a confirmToken is supplied.
      const args = { group_id: 10, first_name: 'Meredith' };
      for (const call of [args, { ...args, confirmToken: 'any-token' }]) {
        const result = await harness.callTool('sw_add_user_to_group', call);
        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain('first_name, last_name, and email are required');
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('sw_remove_user_from_group', () => {
    it('calls POST /remove_user_from_group with group_id and user_id', async () => {
      mockRequest.mockResolvedValue({ success: true });
      await confirmedCall(harness, mockRequest, 'sw_remove_user_from_group', { group_id: 10, user_id: 99 });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/remove_user_from_group', {
        group_id: 10,
        user_id: 99,
      });
    });
  });

  describe('sw_delete_group', () => {
    it('calls POST /delete_group/42', async () => {
      mockRequest.mockResolvedValue({ success: true });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_delete_group', { id: 42 });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/delete_group/42');
      expect(result.isError).toBeFalsy();
    });
  });

  describe('sw_undelete_group', () => {
    it('calls POST /undelete_group/42', async () => {
      mockRequest.mockResolvedValue({ success: true });
      const result = await harness.callTool('sw_undelete_group', { id: 42 });
      expect(mockRequest).toHaveBeenCalledWith('POST', '/undelete_group/42');
      expect(result.isError).toBeFalsy();
    });
  });
});
