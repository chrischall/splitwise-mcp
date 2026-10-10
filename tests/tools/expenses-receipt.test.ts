import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { buildReceiptForm, loadReceipt, MAX_RECEIPT_BYTES } from '../../src/tools/_receipt.js';
import { client } from '../../src/client.js';
import { confirmedCall, createTestHarness } from '../helpers.js';

const mockRequest = vi.spyOn(client, 'request').mockResolvedValue(undefined as never);
const mockMultipart = vi.spyOn(client, 'requestMultipart').mockResolvedValue(undefined as never);

// Smallest bytes each sniffer accepts, plus a little payload.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%fake\n');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  mockRequest.mockClear();
  mockMultipart.mockClear();
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('receipt on sw_create_expense', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerExpenseTools(server, client));
  });

  it('sends multipart with the expense fields and the file, and previews the file identity, not its bytes', async () => {
    mockMultipart.mockResolvedValue({ expenses: [{ id: 1 }] });
    const { phase1 } = await confirmedCall(harness, mockMultipart, 'sw_create_expense', {
      group_id: 7,
      description: 'Water jug',
      cost: '54.11',
      split_equally: true,
      receipt: { base64: b64(PNG), filename: 'order.png' },
    });

    const willSend = phase1.preview.willSend as Record<string, unknown>;
    expect(willSend.receipt).toEqual({
      filename: 'order.png',
      mime_type: 'image/png',
      bytes: PNG.length,
      sha256: sha(PNG),
    });
    expect(JSON.stringify(phase1)).not.toContain(b64(PNG));
    expect(phase1.preview.action).toContain('with receipt order.png');

    expect(mockRequest).not.toHaveBeenCalled();
    const [method, path, form] = mockMultipart.mock.calls[0] as [string, string, FormData];
    expect(method).toBe('POST');
    expect(path).toBe('/create_expense');
    expect(form.get('group_id')).toBe('7');
    expect(form.get('description')).toBe('Water jug');
    expect(form.get('cost')).toBe('54.11');
    expect(form.get('split_equally')).toBe('true');
    expect(form.get('confirmToken')).toBeNull();
    const file = form.get('receipt') as File;
    expect(file.name).toBe('order.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it('flattens a custom split into the multipart fields', async () => {
    mockMultipart.mockResolvedValue({ expenses: [{ id: 1 }] });
    await confirmedCall(harness, mockMultipart, 'sw_create_expense', {
      group_id: 7,
      description: 'Gloves',
      cost: '16.23',
      users: [
        { user_id: 1, paid_share: '16.23', owed_share: '8.12' },
        { user_id: 2, paid_share: '0.00', owed_share: '8.11' },
      ],
      receipt: { base64: b64(PDF) },
    });
    const form = mockMultipart.mock.calls[0][2] as FormData;
    expect(form.get('users__0__user_id')).toBe('1');
    expect(form.get('users__1__owed_share')).toBe('8.11');
    expect((form.get('receipt') as File).name).toBe('receipt.pdf');
  });

  it('stays JSON when no receipt is given', async () => {
    mockRequest.mockResolvedValue({ expenses: [{}] });
    await confirmedCall(harness, mockRequest, 'sw_create_expense', {
      group_id: 7,
      description: 'Dinner',
      cost: '10.00',
      split_equally: true,
    });
    expect(mockMultipart).not.toHaveBeenCalled();
  });

  it('refuses a non-image, non-PDF file on the first call, before the gate', async () => {
    const result = await harness.callTool('sw_create_expense', {
      group_id: 7,
      description: 'X',
      cost: '1.00',
      split_equally: true,
      receipt: { base64: b64(new TextEncoder().encode('just some text')) },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('PNG, JPEG, GIF or PDF');
    expect(mockMultipart).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('receipt on sw_update_expense', () => {
  it('attaches a file from a local path to an existing expense', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-receipt-'));
    const path = join(dir, 'amazon-order.pdf');
    writeFileSync(path, PDF);
    mockMultipart.mockResolvedValue({ expenses: [{ id: 42 }] });

    const { phase1 } = await confirmedCall(harness, mockMultipart, 'sw_update_expense', {
      expense_id: 42,
      receipt: { path },
    });
    expect(phase1.preview.action).toContain('attach receipt amazon-order.pdf');

    const [, apiPath, form] = mockMultipart.mock.calls[0] as [string, string, FormData];
    expect(apiPath).toBe('/update_expense/42');
    // Only the file: no expense fields were changed, and the id is in the path.
    expect([...form.keys()]).toEqual(['receipt']);
    const file = form.get('receipt') as File;
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
  });

  it('reports an unreadable path without calling Splitwise', async () => {
    const result = await harness.callTool('sw_update_expense', {
      expense_id: 42,
      receipt: { path: '/definitely/not/here.png' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Cannot read receipt file');
    expect(mockMultipart).not.toHaveBeenCalled();
  });
});

describe('loadReceipt', () => {
  it('needs exactly one of path or base64', async () => {
    await expect(loadReceipt({})).rejects.toThrow('exactly one of path or base64');
    await expect(loadReceipt({ path: '/x.png', base64: b64(PNG) })).rejects.toThrow(
      'exactly one of path or base64',
    );
  });

  it('accepts a data: URL and detects JPEG and GIF', async () => {
    const jpg = await loadReceipt({ base64: `data:image/jpeg;base64,${b64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]))}` });
    expect(jpg.mimeType).toBe('image/jpeg');
    expect(jpg.filename).toBe('receipt.jpg');
    const gif = await loadReceipt({ base64: b64(new TextEncoder().encode('GIF89a....')) });
    expect(gif.mimeType).toBe('image/gif');
  });

  it('trusts the contents, not the name, for the type', async () => {
    const r = await loadReceipt({ base64: b64(PDF), filename: 'looks-like.png' });
    expect(r.mimeType).toBe('application/pdf');
  });

  it('keeps only a plain basename', async () => {
    const r = await loadReceipt({ base64: b64(PNG), filename: '../../etc/"evil"\n.png' });
    expect(r.filename).toBe('evil.png');
  });

  it('rejects invalid base64, empty files and oversized files', async () => {
    await expect(loadReceipt({ base64: '***' })).rejects.toThrow('not valid base64');
    await expect(loadReceipt({ base64: '' })).rejects.toThrow();
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(PNG);
    await expect(loadReceipt({ base64: b64(big) })).rejects.toThrow('the limit is');
  });
});

describe('buildReceiptForm', () => {
  it('skips undefined fields and stringifies the rest', async () => {
    const r = await loadReceipt({ base64: b64(PNG) });
    const form = buildReceiptForm({ a: 1, b: undefined, c: false, d: 'x' }, r);
    expect(form.get('a')).toBe('1');
    expect(form.has('b')).toBe(false);
    expect(form.get('c')).toBe('false');
    expect(form.get('d')).toBe('x');
  });
});

