import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { buildReceiptForm, loadReceipt, MAX_RECEIPT_BYTES } from '../../src/tools/_receipt.js';
import { client } from '../../src/client.js';
import { confirmedCall, createTestHarness, parseToolResult, writes } from '../helpers.js';

const mockRequest = vi.spyOn(client, 'request').mockResolvedValue(undefined as never);
const mockMultipart = vi.spyOn(client, 'requestMultipart').mockResolvedValue(undefined as never);

// Smallest bytes each sniffer accepts, plus a little payload.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%fake\n');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What Splitwise returns when the file was stored. */
const attached = (id: number) => ({
  expenses: [{ id, receipt: { large: `https://s3/${id}/large.png`, original: `https://s3/${id}/orig.png` } }],
});

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let inputDir: string;

beforeEach(() => {
  mockRequest.mockReset();
  mockMultipart.mockReset();
  inputDir = realpathSync(mkdtempSync(join(tmpdir(), 'sw-input-')));
  vi.stubEnv('SPLITWISE_INPUT_DIR', inputDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('receipt on sw_create_expense', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerExpenseTools(server, client));
  });

  it('sends multipart with the expense fields and the file, and previews the file identity, not its bytes', async () => {
    mockMultipart.mockResolvedValue(attached(1));
    const { phase1, result } = await confirmedCall(harness, mockMultipart, 'sw_create_expense', {
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
    // The token carries a commitment, not the file.
    expect(phase1.confirmToken.length).toBeLessThan(1024);
    expect(phase1.preview.action).toContain('with receipt order.png');

    expect(writes(mockRequest)).toBe(0);
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

    const out = parseToolResult<Record<string, unknown>>(result);
    expect(out.receipt_attached).toBe(true);
  });

  it('flattens a custom split into the multipart fields', async () => {
    mockMultipart.mockResolvedValue(attached(1));
    await confirmedCall(harness, mockMultipart, 'sw_create_expense', {
      group_id: 7,
      description: 'Gloves',
      cost: '16.23',
      users: [
        { user_id: 1, paid_share: '16.23', owed_share: '8.12' },
        { user_id: 2, paid_share: '0.00', owed_share: '8.11' },
      ],
      receipt: { base64: b64(PDF), filename: 'gloves.pdf' },
    });
    const form = mockMultipart.mock.calls[0][2] as FormData;
    expect([...form.keys()]).toEqual([
      'group_id',
      'description',
      'cost',
      'users__0__user_id',
      'users__0__paid_share',
      'users__0__owed_share',
      'users__1__user_id',
      'users__1__paid_share',
      'users__1__owed_share',
      'receipt',
    ]);
    expect(form.get('users__0__user_id')).toBe('1');
    expect(form.get('users__0__paid_share')).toBe('16.23');
    expect(form.get('users__1__owed_share')).toBe('8.11');
    expect((form.get('receipt') as File).name).toBe('gloves.pdf');
  });

  it('without a receipt, sends exactly the same JSON request as before', async () => {
    mockRequest.mockResolvedValue({ expenses: [{ id: 3 }] });
    const { result } = await confirmedCall(harness, mockRequest, 'sw_create_expense', {
      group_id: 7,
      description: 'Dinner',
      cost: '10.00',
      users: [
        { user_id: 1, paid_share: '10.00', owed_share: '5.00' },
        { user_id: 2, paid_share: '0.00', owed_share: '5.00' },
      ],
    });
    expect(mockMultipart).not.toHaveBeenCalled();
    expect(mockRequest.mock.calls.find((c) => c[0] === 'POST')).toEqual([
      'POST',
      '/create_expense',
      {
        group_id: 7,
        description: 'Dinner',
        cost: '10.00',
        users__0__user_id: 1,
        users__0__paid_share: '10.00',
        users__0__owed_share: '5.00',
        users__1__user_id: 2,
        users__1__paid_share: '0.00',
        users__1__owed_share: '5.00',
      },
    ]);
    // ...and the result is Splitwise's response (no receipt_attached), with the post-state lifted out.
    expect(parseToolResult(result)).toEqual({
      post_state: { id: 3, deleted_at: null, deleted_by: null, updated_at: null, updated_by: null },
      expenses: [{ id: 3 }],
    });
  });

  it('refuses a non-image, non-PDF file on the first call, before the gate', async () => {
    const result = await harness.callTool('sw_create_expense', {
      group_id: 7,
      description: 'X',
      cost: '1.00',
      split_equally: true,
      receipt: { base64: b64(new TextEncoder().encode('just some text')), filename: 'x.png' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('PNG, JPEG, GIF or PDF');
    expect(mockMultipart).not.toHaveBeenCalled();
    expect(writes(mockRequest)).toBe(0);
  });

  it('fails loudly, naming the expense, when Splitwise saves it but drops the file', async () => {
    mockMultipart.mockResolvedValue({ expenses: [{ id: 99, receipt: { large: null, original: null } }] });
    const { result } = await confirmedCall(harness, mockMultipart, 'sw_create_expense', {
      group_id: 7,
      description: 'Dropped',
      cost: '1.00',
      split_equally: true,
      receipt: { base64: b64(PNG), filename: 'd.png' },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('99');
    expect(text).toContain('did not attach the receipt');
    expect(text).toContain('sw_attach_receipt');
  });
});

describe('receipt on sw_update_expense', () => {
  it('attaches a file from inside SPLITWISE_INPUT_DIR without touching any other field', async () => {
    writeFileSync(join(inputDir, 'amazon-order.pdf'), PDF);
    mockMultipart.mockResolvedValue(attached(42));

    const { phase1, result } = await confirmedCall(harness, mockMultipart, 'sw_update_expense', {
      expense_id: 42,
      receipt: { path: 'amazon-order.pdf', filename: 'amazon-order.pdf' },
    });
    expect(phase1.preview.action).toContain('attach receipt amazon-order.pdf');

    const [, apiPath, form] = mockMultipart.mock.calls[0] as [string, string, FormData];
    expect(apiPath).toBe('/update_expense/42');
    // Only the file: no cost, split or other field is sent, and the id is in the path.
    expect([...form.keys()]).toEqual(['receipt']);
    const file = form.get('receipt') as File;
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    expect(parseToolResult<Record<string, unknown>>(result).receipt_attached).toBe(true);
  });

  it('reports a missing file without calling Splitwise', async () => {
    const result = await harness.callTool('sw_update_expense', {
      expense_id: 42,
      receipt: { path: 'not-here.png', filename: 'not-here.png' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Cannot read receipt file');
    expect(mockMultipart).not.toHaveBeenCalled();
  });

  it('refuses the confirmToken once the file at the path changes after the preview', async () => {
    const file = join(inputDir, 'r.png');
    writeFileSync(file, PNG);
    mockMultipart.mockResolvedValue(attached(42));
    const args = { expense_id: 42, receipt: { path: 'r.png', filename: 'r.png' } };

    const first = parseToolResult<{ confirmToken: string }>(await harness.callTool('sw_update_expense', args));
    writeFileSync(file, Uint8Array.from([...PNG, 0xde, 0xad]));
    const second = await harness.callTool('sw_update_expense', { ...args, confirmToken: first.confirmToken });

    expect(mockMultipart).not.toHaveBeenCalled();
    expect(JSON.stringify(second)).not.toContain('receipt_attached');
  });

  it('refuses the confirmToken for different base64 bytes than were previewed', async () => {
    mockMultipart.mockResolvedValue(attached(42));
    const args = { expense_id: 42, receipt: { base64: b64(PNG), filename: 'r.png' } };
    const first = parseToolResult<{ confirmToken: string }>(await harness.callTool('sw_update_expense', args));
    await harness.callTool('sw_update_expense', {
      expense_id: 42,
      receipt: { base64: b64(Uint8Array.from([...PNG, 9])), filename: 'r.png' },
      confirmToken: first.confirmToken,
    });
    expect(mockMultipart).not.toHaveBeenCalled();
  });
});

describe('sw_attach_receipt', () => {
  it('wraps the update path: multipart to /update_expense/<id> with only the file', async () => {
    mockMultipart.mockResolvedValue(attached(4644807844));
    const { phase1, result } = await confirmedCall(harness, mockMultipart, 'sw_attach_receipt', {
      expense_id: 4644807844,
      receipt: { base64: b64(PDF), filename: 'AA_receipt.pdf', mime_type: 'application/pdf' },
    });
    expect(phase1.preview.path).toBe('/update_expense/4644807844');
    expect((phase1.preview.willSend as Record<string, unknown>).receipt).toMatchObject({
      filename: 'AA_receipt.pdf',
      mime_type: 'application/pdf',
      sha256: sha(PDF),
    });
    const [method, path, form] = mockMultipart.mock.calls[0] as [string, string, FormData];
    expect([method, path]).toEqual(['POST', '/update_expense/4644807844']);
    expect([...form.keys()]).toEqual(['receipt']);
    expect(writes(mockRequest)).toBe(0);
    const out = parseToolResult<Record<string, unknown>>(result);
    expect(out.receipt_attached).toBe(true);
    expect(out.receipt).toEqual(attached(4644807844).expenses[0].receipt);
  });

  it('errors when the response has no receipt.original', async () => {
    mockMultipart.mockResolvedValue({ expenses: [{ id: 5, receipt: { original: null } }] });
    const { result } = await confirmedCall(harness, mockMultipart, 'sw_attach_receipt', {
      expense_id: 5,
      receipt: { base64: b64(PNG), filename: 'r.png' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('did not attach the receipt');
  });

  it('a token minted for sw_update_expense does not work on sw_attach_receipt', async () => {
    const receipt = { base64: b64(PNG), filename: 'r.png' };
    const first = parseToolResult<{ confirmToken: string }>(
      await harness.callTool('sw_update_expense', { expense_id: 6, receipt }),
    );
    await harness.callTool('sw_attach_receipt', { expense_id: 6, receipt, confirmToken: first.confirmToken });
    expect(mockMultipart).not.toHaveBeenCalled();
  });
});

describe('loadReceipt: shape and type', () => {
  it('needs exactly one of upload_id, path or base64', async () => {
    await expect(loadReceipt({ filename: 'a.png' })).rejects.toThrow('exactly one of upload_id, path or base64');
    await expect(loadReceipt({ path: 'x.png', base64: b64(PNG), filename: 'a.png' })).rejects.toThrow(
      'exactly one of upload_id, path or base64',
    );
  });

  it('accepts a data: URL and detects JPEG and GIF from magic bytes', async () => {
    const jpg = await loadReceipt({
      base64: `data:image/jpeg;base64,${b64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]))}`,
      filename: 'a.jpg',
    });
    expect(jpg.mimeType).toBe('image/jpeg');
    const gif = await loadReceipt({ base64: b64(new TextEncoder().encode('GIF89a....')), filename: 'a.gif' });
    expect(gif.mimeType).toBe('image/gif');
  });

  it('trusts the contents, not the name, for the type', async () => {
    const r = await loadReceipt({ base64: b64(PDF), filename: 'looks-like.png' });
    expect(r.mimeType).toBe('application/pdf');
  });

  it.each([
    ['webp', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')],
    ['zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])],
    ['html', new TextEncoder().encode('<html><script>')],
    ['truncated png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
  ])('rejects %s', async (_name, bytes) => {
    await expect(loadReceipt({ base64: b64(bytes), filename: 'x.png' })).rejects.toThrow('PNG, JPEG, GIF or PDF');
  });

  it('rejects a mime_type that disagrees with the detected type, and accepts image/jpg as JPEG', async () => {
    await expect(loadReceipt({ base64: b64(PDF), filename: 'a.pdf', mime_type: 'image/png' })).rejects.toThrow(
      'mime_type image/png does not match the file contents (application/pdf)',
    );
    const jpg = await loadReceipt({
      base64: b64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])),
      filename: 'a.jpg',
      mime_type: 'IMAGE/JPG',
    });
    expect(jpg.mimeType).toBe('image/jpeg');
  });

  it('keeps only a plain basename', async () => {
    const r = await loadReceipt({ base64: b64(PNG), filename: '../../etc/"evil"\n.png' });
    expect(r.filename).toBe('evil.png');
  });

  it('falls back to receipt.<ext> when the filename cleans to nothing', async () => {
    const r = await loadReceipt({ base64: b64(PNG), filename: '../' });
    expect(r.filename).toBe('receipt.png');
  });
});

describe('loadReceipt: size limit', () => {
  it('is 10 MiB (Splitwise documents none)', () => {
    expect(MAX_RECEIPT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a file of exactly the limit', async () => {
    const max = new Uint8Array(MAX_RECEIPT_BYTES);
    max.set(PNG);
    const r = await loadReceipt({ base64: b64(max), filename: 'max.png' });
    expect(r.summary.bytes).toBe(MAX_RECEIPT_BYTES);
  });

  it('rejects base64 over the limit with a clear error, without echoing the content', async () => {
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(PNG);
    const err = await loadReceipt({ base64: b64(big), filename: 'big.png' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/over the 10 MiB limit/);
    expect((err as Error).message.length).toBeLessThan(300);
  });

  it('rejects a file over the limit before reading it', async () => {
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(PNG);
    writeFileSync(join(inputDir, 'big.png'), big);
    await expect(loadReceipt({ path: 'big.png', filename: 'big.png' })).rejects.toThrow(/over the 10 MiB limit/);
  });

  it('rejects invalid base64 and empty files without echoing the input', async () => {
    const err = await loadReceipt({ base64: 'not*base64*SECRET', filename: 'a.png' }).catch((e: Error) => e);
    expect((err as Error).message).toContain('not valid base64');
    expect((err as Error).message).not.toContain('SECRET');
    await expect(loadReceipt({ base64: '', filename: 'a.png' })).rejects.toThrow();
  });
});

describe('loadReceipt: path sandboxing', () => {
  it('refuses path entirely when SPLITWISE_INPUT_DIR is unset (the hosted case)', async () => {
    vi.stubEnv('SPLITWISE_INPUT_DIR', '');
    writeFileSync(join(inputDir, 'r.png'), PNG);
    await expect(loadReceipt({ path: join(inputDir, 'r.png'), filename: 'r.png' })).rejects.toThrow(
      /SPLITWISE_INPUT_DIR is not set.*base64/,
    );
  });

  it('accepts a relative name or an absolute path inside the dir, including subdirectories', async () => {
    mkdirSync(join(inputDir, 'sub'));
    writeFileSync(join(inputDir, 'sub', 'r.png'), PNG);
    expect((await loadReceipt({ path: 'sub/r.png', filename: 'r.png' })).summary.sha256).toBe(sha(PNG));
    expect((await loadReceipt({ path: join(inputDir, 'sub', 'r.png'), filename: 'r.png' })).summary.bytes).toBe(
      PNG.length,
    );
  });

  it.each([['../outside.png'], ['sub/../../outside.png']])('rejects traversal %s', async (p) => {
    writeFileSync(join(inputDir, '..', 'outside.png'), PNG);
    mkdirSync(join(inputDir, 'sub'), { recursive: true });
    await expect(loadReceipt({ path: p, filename: 'x.png' })).rejects.toThrow('outside SPLITWISE_INPUT_DIR');
  });

  it('rejects an absolute path outside the dir', async () => {
    const other = mkdtempSync(join(tmpdir(), 'sw-other-'));
    writeFileSync(join(other, 'r.png'), PNG);
    await expect(loadReceipt({ path: join(other, 'r.png'), filename: 'x.png' })).rejects.toThrow(
      'outside SPLITWISE_INPUT_DIR',
    );
  });

  it('rejects a symlink that points out of the dir, and allows one that stays inside', async () => {
    const other = mkdtempSync(join(tmpdir(), 'sw-other-'));
    writeFileSync(join(other, 'secret.pdf'), PDF);
    symlinkSync(join(other, 'secret.pdf'), join(inputDir, 'link.pdf'));
    await expect(loadReceipt({ path: 'link.pdf', filename: 'x.pdf' })).rejects.toThrow('outside SPLITWISE_INPUT_DIR');

    writeFileSync(join(inputDir, 'real.pdf'), PDF);
    symlinkSync(join(inputDir, 'real.pdf'), join(inputDir, 'inner.pdf'));
    expect((await loadReceipt({ path: 'inner.pdf', filename: 'x.pdf' })).mimeType).toBe('application/pdf');
  });

  it('rejects a symlinked directory that leads out of the dir', async () => {
    const other = mkdtempSync(join(tmpdir(), 'sw-other-'));
    writeFileSync(join(other, 'r.png'), PNG);
    symlinkSync(other, join(inputDir, 'escape'));
    await expect(loadReceipt({ path: 'escape/r.png', filename: 'x.png' })).rejects.toThrow(
      'outside SPLITWISE_INPUT_DIR',
    );
  });

  it('rejects a directory', async () => {
    mkdirSync(join(inputDir, 'adir'));
    await expect(loadReceipt({ path: 'adir', filename: 'x.png' })).rejects.toThrow('not a regular file');
  });
});

describe('buildReceiptForm', () => {
  it('skips undefined fields and stringifies the rest, file last', async () => {
    const r = await loadReceipt({ base64: b64(PNG), filename: 'a.png' });
    const form = buildReceiptForm({ a: 1, b: undefined, c: false, d: 'x' }, r);
    expect([...form.keys()]).toEqual(['a', 'c', 'd', 'receipt']);
    expect(form.get('a')).toBe('1');
    expect(form.get('c')).toBe('false');
    expect(form.get('d')).toBe('x');
  });
});
