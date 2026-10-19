import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { ApiError } from '@chrischall/mcp-utils';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { client } from '../../src/client.js';
import { confirmedCall, createTestHarness, parseToolResult, writes } from '../helpers.js';

// "Undelete lies about success" and "a bare 403 on a deleted expense", from a
// real session: the restore returned {success:true}, a re-read showed the
// expense deleted again by the other group member, and the follow-up comment
// failed with "you do not have permission".

const mockRequest = vi.spyOn(client, 'request');
const mockMultipart = vi.spyOn(client, 'requestMultipart');

const ALISON = { id: 2, first_name: 'Alison', last_name: 'Hall' };
const CHRIS = { id: 1, first_name: 'Chris', last_name: 'Hall' };
const live = (id: number) => ({ id, description: 'Egan tuition', cost: '100.00', deleted_at: null, deleted_by: null, updated_at: '2026-10-01T00:00:00Z', updated_by: CHRIS });
const deleted = (id: number) => ({ ...live(id), deleted_at: '2026-10-02T09:15:00Z', deleted_by: ALISON });

/** Route GETs of /get_expense/{id} to `expense`, and every write to `writeResult`. */
function route(expense: unknown, writeResult: unknown = { success: true }) {
  mockRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/get_expense/')) return { expense } as never;
    if (method === 'GET') return { expenses: [] } as never;
    if (writeResult instanceof Error) throw writeResult;
    return writeResult as never;
  });
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  mockRequest.mockReset();
  mockMultipart.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
  mockRequest.mockRestore();
  mockMultipart.mockRestore();
});

const text = (r: { content: unknown }) => JSON.stringify(r.content);

describe('expense state', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerExpenseTools(server, client);
      registerUtilityTools(server, client);
    });
  });

  describe('sw_undelete_expense verifies the restore', () => {
    it('re-reads the expense and returns its post-state', async () => {
      let restored = false;
      mockRequest.mockImplementation(async (method: string, path: string) => {
        if (method === 'POST') { restored = true; return { success: true } as never; }
        return { expense: restored ? live(42) : deleted(42) } as never;
      });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_undelete_expense', { id: 42 });
      expect(result.isError).toBeFalsy();
      expect(mockRequest).toHaveBeenLastCalledWith('GET', '/get_expense/42');
      expect(parseToolResult(result)).toMatchObject({
        success: true,
        post_state: { id: 42, deleted_at: null, updated_by: 'Chris Hall' },
      });
    });

    it('is an error naming who and when, when the expense is still deleted', async () => {
      route(deleted(42));
      const { result } = await confirmedCall(harness, mockRequest, 'sw_undelete_expense', { id: 42 });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/still deleted/);
      expect(text(result)).toContain('Alison Hall');
      expect(text(result)).toContain('2026-10-02T09:15:00Z');
      expect(text(result)).not.toMatch(/"success":true/);
    });
  });

  describe('writes on a deleted expense are refused before the gate', () => {
    it.each([
      ['sw_update_expense', { expense_id: 42, cost: '5.00' }],
      ['sw_create_comment', { expense_id: 42, content: 'why?' }],
      ['sw_attach_receipt', { expense_id: 42, receipt: { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64'), filename: 'r.png' } }],
    ])('%s says who deleted it and how to restore it', async (tool, args) => {
      route(deleted(42));
      const result = await harness.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/expense 42 is deleted \(by Alison Hall at 2026-10-02T09:15:00Z\)/);
      expect(text(result)).toContain('sw_undelete_expense');
      expect(writes(mockRequest)).toBe(0);
      expect(mockMultipart).not.toHaveBeenCalled();
    });

    it('lets a write on a live expense through', async () => {
      route(live(42), { comment: { id: 9 } });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_comment', { expense_id: 42, content: 'ok' });
      expect(result.isError).toBeFalsy();
      expect(mockRequest).toHaveBeenCalledWith('POST', '/create_comment', { expense_id: 42, content: 'ok' });
    });

    it('explains a 403 when the expense was deleted between the check and the write', async () => {
      let deletedNow = false;
      mockRequest.mockImplementation(async (method: string) => {
        if (method === 'GET') return { expense: deletedNow ? deleted(42) : live(42) } as never;
        deletedNow = true;
        throw new ApiError(403, 'Splitwise API error: 403 Forbidden — You do not have permission');
      });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_comment', { expense_id: 42, content: 'hi' });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/expense 42 is deleted \(by Alison Hall/);
    });

    it('keeps the original 403 when the expense is not deleted', async () => {
      mockRequest.mockImplementation(async (method: string) => {
        if (method === 'GET') return { expense: live(42) } as never;
        throw new ApiError(403, 'Splitwise API error: 403 Forbidden — You do not have permission');
      });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_comment', { expense_id: 42, content: 'hi' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('do not have permission');
    });
  });

  describe('create and update return the post-state', () => {
    it('sw_update_expense lifts deleted_at / updated_by out of the response', async () => {
      route(live(42), { expenses: [{ ...live(42), cost: '5.00', updated_by: ALISON }] });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_update_expense', { expense_id: 42, cost: '5.00' });
      expect(parseToolResult(result)).toMatchObject({ post_state: { id: 42, deleted_at: null, updated_by: 'Alison Hall' } });
    });

    it('sw_create_expense does the same for the new expense', async () => {
      route(undefined, { expenses: [{ ...live(77), created_by: CHRIS }] });
      const { result } = await confirmedCall(harness, mockRequest, 'sw_create_expense', { group_id: 0, description: 'x', cost: '1.00', split_equally: true });
      expect(parseToolResult(result)).toMatchObject({ post_state: { id: 77, deleted_at: null } });
    });
  });
});
