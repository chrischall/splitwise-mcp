import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { registerBatchTools } from '../../src/tools/batch.js';
import { client } from '../../src/client.js';
import { createTestHarness, parseToolResult, writes } from '../helpers.js';

// From the session that prompted this: one expense + a comment + a receipt was
// six calls, three approvals and two copies of the image in the conversation.

const mockRequest = vi.spyOn(client, 'request');
const mockMultipart = vi.spyOn(client, 'requestMultipart');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]);
const b64 = Buffer.from(PNG).toString('base64');

type Phase1 = { status: string; confirmToken: string; confirmTool?: string; instruction: string; preview: Record<string, unknown> };
type BatchResult = { status: string; results: Array<Record<string, unknown>>; not_run?: number[]; note?: string };

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let failComment = false;

beforeEach(() => {
  failComment = false;
  mockRequest.mockReset();
  mockMultipart.mockReset();
  mockRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') return {} as never;
    if (path === '/create_expense') return { expenses: [{ id: 555, deleted_at: null }] } as never;
    if (path === '/create_comment') {
      if (failComment) throw new Error('Splitwise rejected the request: comment too long');
      return { comment: { id: 9 } } as never;
    }
    return { success: true } as never;
  });
  mockMultipart.mockResolvedValue({ expenses: [{ id: 555, receipt: { original: 'https://s3/o.png' } }] } as never);
});
afterAll(async () => {
  if (harness) await harness.close();
  mockRequest.mockRestore();
  mockMultipart.mockRestore();
});

describe('sw_confirm and sw_batch', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerExpenseTools(server, client);
      registerUtilityTools(server, client);
      registerBatchTools(server, client);
    });
  });

  it('sw_confirm finishes a receipt write with the token alone — the base64 is sent once', async () => {
    const phase1 = parseToolResult<Phase1>(
      await harness.callTool('sw_attach_receipt', { expense_id: 555, receipt: { base64: b64, filename: 'r.png' } }),
    );
    expect(phase1.confirmTool).toBe('sw_confirm');
    expect(phase1.instruction).toContain('sw_confirm');
    expect(mockMultipart).not.toHaveBeenCalled();

    const result = await harness.callTool('sw_confirm', { confirmToken: phase1.confirmToken });
    expect(result.isError).toBeFalsy();
    expect(mockMultipart).toHaveBeenCalledTimes(1);
    const form = mockMultipart.mock.calls[0]![2] as FormData;
    expect(new Uint8Array(await (form.get('receipt') as File).arrayBuffer())).toEqual(PNG);
    expect(parseToolResult<Record<string, unknown>>(result).receipt_attached).toBe(true);
  });

  it('sw_batch: expense + comment + receipt under one approval, with the new expense id fed forward', async () => {
    const ops = [
      { tool: 'sw_create_expense', args: { group_id: 0, description: 'Egan camp', cost: '250.00', split_equally: true } },
      { tool: 'sw_create_comment', args: { content: 'paid by card' }, refs: { expense_id: '0.expense_id' } },
      { tool: 'sw_attach_receipt', args: { receipt: { base64: b64, filename: 'camp.png' } }, refs: { expense_id: '0.expense_id' } },
    ];
    const phase1 = parseToolResult<Phase1>(await harness.callTool('sw_batch', { ops }));
    expect(phase1.status).toBe('confirmation-required');
    expect(String(phase1.preview.action)).toMatch(/^3 writes/);
    expect(writes(mockRequest)).toBe(0);

    const result = await harness.callTool('sw_confirm', { confirmToken: phase1.confirmToken });
    expect(result.isError).toBeFalsy();
    const body = parseToolResult<BatchResult>(result);
    expect(body.status).toBe('ok');
    expect(body.results.map((r) => r.applied)).toEqual([true, true, true]);
    expect(mockRequest).toHaveBeenCalledWith('POST', '/create_comment', { expense_id: 555, content: 'paid by card' });
    expect(mockMultipart).toHaveBeenCalledWith('POST', '/update_expense/555', expect.any(FormData));
  });

  it('sw_batch stops at a failed op and reports what was applied', async () => {
    failComment = true;
    const ops = [
      { tool: 'sw_create_expense', args: { group_id: 0, description: 'x', cost: '1.00', split_equally: true } },
      { tool: 'sw_create_comment', args: { content: 'y' }, refs: { expense_id: '0.expense_id' } },
      { tool: 'sw_attach_receipt', args: { receipt: { base64: b64, filename: 'r.png' } }, refs: { expense_id: '0.expense_id' } },
    ];
    const { confirmToken } = parseToolResult<Phase1>(await harness.callTool('sw_batch', { ops }));
    const result = await harness.callTool('sw_batch', { ops, confirmToken });
    expect(result.isError).toBe(true);
    const body = parseToolResult<BatchResult>(result);
    expect(body).toMatchObject({ status: 'partial', not_run: [2] });
    expect(body.results[1]).toMatchObject({ applied: false, error: expect.stringContaining('comment too long') });
    expect(mockMultipart).not.toHaveBeenCalled();
  });

  it('sw_batch refuses tools that are not batchable writes', async () => {
    const result = await harness.callTool('sw_batch', { ops: [{ tool: 'sw_list_expenses', args: {} }] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/sw_list_expenses is not a write/);
  });
});
