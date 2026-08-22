import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

process.env.SPLITWISE_API_KEY = 'test-key';

const { SplitwiseClient, isSplitwiseHost } = await import('../../src/client.js');
const { registerReceiptTools } = await import('../../src/tools/receipts.js');

// The receipt URL shapes Splitwise actually serves: its own API (needs the key)
// and a presigned S3 URL (must NOT be sent the key).
const API_RECEIPT_URL =
  'https://www.splitwise.com/api/v4.0/expenses/4644814211/receipt?cachebust=abc123&size=large';
const S3_RECEIPT_URL =
  'https://splitwise.s3.amazonaws.com/uploads/expense/receipt/4644814211/receipt.pdf?X-Amz-Signature=SECRETSIG';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PDF = new Uint8Array([...Buffer.from('%PDF-1.4\n', 'latin1'), 0x0a]);

/** A JSON response as `createApiClient` consumes it (it calls `.text()`). */
function jsonResponse(data: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(data) };
}

/** A binary response as `fetchRaw` consumes it (headers + `.arrayBuffer()`). */
function binaryResponse(bytes: Uint8Array, contentType?: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(contentType ? { 'content-type': contentType } : {}),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** `GET /get_expense/:id` shaped like the real API, with the given receipt. */
function expenseResponse(receipt: { original?: string | null; large?: string | null } | null) {
  return jsonResponse({ expense: { id: 4644814211, description: 'Dinner', receipt } });
}

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'sw-receipts-'));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/**
 * Stub `fetch`, then build the client and harness. Order matters:
 * `createApiClient` captures the global `fetch` when it is constructed, so a
 * client built before the stub would keep calling the real one.
 */
async function harnessWith(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new SplitwiseClient({ apiKey: 'test-key' });
  return createTestHarness((server) => registerReceiptTools(server, client));
}

/** Request headers of the nth fetch call. */
function headersOf(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, string> {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

function errorText(result: CallToolResult): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

// `isSplitwiseHost` is the single decision point for whether the API key
// leaves the process, so pin its boundaries rather than covering it only
// transitively through the download tests.
describe('isSplitwiseHost', () => {
  it.each([
    ['splitwise.com', true],
    ['www.splitwise.com', true],
    ['secure.splitwise.com', true],
    ['WWW.SPLITWISE.COM', true],
    ['evil-splitwise.com', false],
    ['splitwise.com.attacker.net', false],
    ['notsplitwise.com', false],
    ['splitwise.s3.amazonaws.com', false],
  ])('%s -> %s', (hostname, expected) => {
    expect(isSplitwiseHost(hostname)).toBe(expected);
  });
});

describe('sw_get_receipt', () => {
  // The tool writes a file into a caller-supplied directory, so it must not
  // claim readOnlyHint — hosts use that to skip the approval prompt.
  it('does not advertise itself as read-only', async () => {
    const harness = await harnessWith(vi.fn());

    const { tools } = await harness.client.listTools();
    const receipt = tools.find((t) => t.name === 'sw_get_receipt');

    expect(receipt?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    await harness.close();
  });

  it('downloads the receipt bytes and writes them to a file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL, large: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(JPEG, 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });
    const body = parseToolResult<{ path: string; bytes: number; content_type: string; size: string; source_host: string }>(result);

    expect(result.isError).toBeFalsy();
    expect(body.size).toBe('original');
    expect(body.bytes).toBe(JPEG.length);
    expect(body.content_type).toBe('image/jpeg');
    expect(body.source_host).toBe('www.splitwise.com');
    expect(basename(body.path)).toBe('splitwise-receipt-4644814211.jpg');
    // The real bytes landed on disk — the whole point of the tool.
    expect(new Uint8Array(readFileSync(body.path))).toEqual(JPEG);

    await harness.close();
  });

  it('sends the API key when the receipt is served by Splitwise itself', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(JPEG, 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });

    // The exact URL from the expense, query intact — this is the request that
    // used to 401 when made without credentials.
    expect(fetchMock.mock.calls[1]![0]).toBe(API_RECEIPT_URL);
    expect(headersOf(fetchMock, 1).Authorization).toBe('Bearer test-key');

    await harness.close();
  });

  it('never sends the API key to a presigned third-party host', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: S3_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });

    expect(fetchMock.mock.calls[1]![0]).toBe(S3_RECEIPT_URL);
    expect(headersOf(fetchMock, 1)).not.toHaveProperty('Authorization');

    await harness.close();
  });

  it('falls back to the other rendition and says so', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL, large: null }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      size: 'large',
      output_dir: outputDir,
    });
    const body = parseToolResult<{ size: string; requested_size: string; path: string }>(result);

    expect(body.size).toBe('original');
    expect(body.requested_size).toBe('large');
    expect(basename(body.path)).toBe('splitwise-receipt-4644814211.pdf');

    await harness.close();
  });

  it('sniffs a PDF served as application/octet-stream', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/octet-stream'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ content_type: string; path: string }>(
      await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir }),
    );

    expect(body.content_type).toBe('application/pdf');
    expect(basename(body.path)).toBe('splitwise-receipt-4644814211.pdf');

    await harness.close();
  });

  it('returns an image inline when asked, alongside the written path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(JPEG, 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      inline: true,
      output_dir: outputDir,
    });

    expect(parseToolResult<{ inline: boolean }>(result).inline).toBe(true);
    const image = result.content?.[1];
    expect(image?.type).toBe('image');
    expect(image).toMatchObject({ mimeType: 'image/jpeg', data: Buffer.from(JPEG).toString('base64') });

    await harness.close();
  });

  it('explains why a PDF cannot come back inline', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ inline: boolean; inline_skipped: string }>(
      await harness.callTool('sw_get_receipt', { id: 4644814211, inline: true, output_dir: outputDir }),
    );

    expect(body.inline).toBe(false);
    expect(body.inline_skipped).toContain('Only image receipts');
    await harness.close();
  });

  it('reports a clear error when the expense has no receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(expenseResponse({ original: null, large: null }));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('has no receipt attached');
    // No second request was attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await harness.close();
  });

  it('never leaks a signed receipt URL into an error message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: S3_RECEIPT_URL }))
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => '<Error><Code>AccessDenied</Code></Error>',
      });
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });
    const message = errorText(result);

    expect(result.isError).toBe(true);
    expect(message).not.toContain('SECRETSIG');
    expect(message).toContain('<redacted>');
    expect(message).toContain('AccessDenied');
    // Errors from a third-party asset host name that host, not Splitwise.
    expect(message).toContain('splitwise.s3.amazonaws.com error 403');

    await harness.close();
  });

  it('reports an empty receipt body rather than writing a zero-byte file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(new Uint8Array(0), 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('empty receipt body');
    expect(readdirSync(outputDir)).toEqual([]);

    await harness.close();
  });

  it('skips the inline image when the receipt is over the size limit', async () => {
    // 4 MB + 1 byte, with JPEG magic bytes so it is unambiguously an image.
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(JPEG.subarray(0, 3));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(big, 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      inline: true,
      output_dir: outputDir,
    });
    const body = parseToolResult<{ inline: boolean; inline_skipped: string }>(result);

    expect(body.inline).toBe(false);
    expect(body.inline_skipped).toContain('inline limit');
    // The file is still written — only the base64 copy is dropped.
    expect(result.content).toHaveLength(1);
    expect(readdirSync(outputDir)).toEqual(['splitwise-receipt-4644814211.jpg']);

    await harness.close();
  });

  it('rejects a non-https receipt URL rather than fetching it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      expenseResponse({ original: 'http://evil.example.com/receipt.jpg' }),
    );
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('https only');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await harness.close();
  });
});
