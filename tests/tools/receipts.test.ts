import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Build a minimal single-page PDF whose content stream shows `lines` of text.
 * Pass no lines for a PDF with no text layer — what a scanned or photographed
 * receipt looks like to an extractor. Hand-rolled so the fixture stays
 * readable in-tree instead of being an opaque committed binary.
 */
function makePdf(lines: string[]): Uint8Array {
  const show = lines.map((l, i) => `${i === 0 ? '' : '0 -20 Td '}(${l}) Tj `).join('');
  const stream = Buffer.from(lines.length ? `BT /F1 12 Tf 72 720 Td ${show}ET` : 'q Q', 'latin1');
  const objects = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>', 'latin1'),
    Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', 'latin1'),
    Buffer.concat([
      Buffer.from(`<</Length ${stream.length}>>stream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', 'latin1'),
  ];

  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const chunks: Buffer[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj`, 'latin1'),
      body,
      Buffer.from('endobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    at += obj.length;
  });

  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`,
  ].join('');
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

const TEXT_PDF = makePdf(['MPHSBANDS Band Shirts', 'Total 129.00 USD']);
const SCANNED_PDF = makePdf([]);

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

  it('returns a PDF inline as an embedded resource', async () => {
    // The whole point of the fix: a caller with no access to this server's
    // filesystem still gets the bytes.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      inline: true,
      output_dir: outputDir,
    });

    expect(parseToolResult<{ inline: boolean }>(result).inline).toBe(true);
    expect(result.content?.[1]).toMatchObject({
      type: 'resource',
      resource: {
        uri: 'splitwise://expenses/4644814211/receipt',
        mimeType: 'application/pdf',
        blob: Buffer.from(PDF).toString('base64'),
      },
    });

    await harness.close();
  });

  it('extracts the text layer of a PDF receipt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(TEXT_PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ text: string; path: string; bytes: number }>(
      await harness.callTool('sw_get_receipt', {
        id: 4644814211,
        extract_text: true,
        output_dir: outputDir,
      }),
    );

    expect(body.text).toContain('MPHSBANDS Band Shirts');
    expect(body.text).toContain('Total 129.00 USD');
    // pdf.js detaches the buffer it is handed, so extractPdfText copies first.
    // `bytes` is read AFTER extraction — a detached buffer reports 0 here.
    // (The written file is not a guard: the write already ran by then.)
    expect(body.bytes).toBe(TEXT_PDF.length);
    expect(readFileSync(body.path).length).toBe(TEXT_PDF.length);

    await harness.close();
  });

  it('says so when a PDF has no text layer to extract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(SCANNED_PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ text?: string; text_note: string }>(
      await harness.callTool('sw_get_receipt', {
        id: 4644814211,
        extract_text: true,
        output_dir: outputDir,
      }),
    );

    expect(body.text).toBeUndefined();
    expect(body.text_note).toContain('no text layer');

    await harness.close();
  });

  it('declines to extract text from an image receipt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(JPEG, 'image/jpeg'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ text?: string; text_note: string }>(
      await harness.callTool('sw_get_receipt', {
        id: 4644814211,
        extract_text: true,
        output_dir: outputDir,
      }),
    );

    expect(body.text).toBeUndefined();
    expect(body.text_note).toContain('PDFs only');

    await harness.close();
  });

  it('skips the write entirely when write:false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ path?: string; inline: boolean }>(
      await harness.callTool('sw_get_receipt', {
        id: 4644814211,
        inline: true,
        write: false,
        output_dir: outputDir,
      }),
    );

    expect(body.path).toBeUndefined();
    expect(body.inline).toBe(true);
    expect(readdirSync(outputDir)).toEqual([]);

    await harness.close();
  });

  it('still returns the content when the filesystem is not writable', async () => {
    // A hosted server runs read-only: the write must not sink the whole call.
    // An output_dir nested under a regular file makes mkdir fail as ENOTDIR
    // for any uid, root included.
    writeFileSync(join(outputDir, 'blocker'), 'not a directory');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      inline: true,
      output_dir: join(outputDir, 'blocker', 'sub'),
    });
    const body = parseToolResult<{ path?: string; write_error: string; inline: boolean }>(result);

    expect(result.isError).toBeFalsy();
    expect(body.path).toBeUndefined();
    expect(body.write_error).toMatch(/ENOTDIR|EACCES|ENOENT/);
    expect(body.inline).toBe(true);
    expect(result.content?.[1]?.type).toBe('resource');

    await harness.close();
  });

  it('fails loudly when the write fails and nothing was asked for in its place', async () => {
    writeFileSync(join(outputDir, 'blocker'), 'not a directory');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      output_dir: join(outputDir, 'blocker', 'sub'),
    });

    expect(result.isError).toBe(true);
    // The error has to name the way out, not just the failure.
    expect(errorText(result)).toContain('inline:true');
    expect(errorText(result)).toContain('extract_text:true');

    await harness.close();
  });

  it('trusts the magic bytes over a mis-declared Content-Type', async () => {
    // Object stores hand out application/force-download, application/x-pdf and
    // friends. Believing the header would misname the file AND refuse text.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(TEXT_PDF, 'application/force-download'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ content_type: string; path: string; text: string }>(
      await harness.callTool('sw_get_receipt', {
        id: 4644814211,
        extract_text: true,
        output_dir: outputDir,
      }),
    );

    expect(body.content_type).toBe('application/pdf');
    expect(basename(body.path)).toBe('splitwise-receipt-4644814211.pdf');
    expect(body.text).toContain('Total 129.00 USD');

    await harness.close();
  });

  it('keeps a declared type the magic bytes cannot identify', async () => {
    // Sniffing only knows a few formats; anything else keeps what was declared.
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(heic, 'image/heic'));
    const harness = await harnessWith(fetchMock);

    const body = parseToolResult<{ content_type: string; path: string }>(
      await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir }),
    );

    expect(body.content_type).toBe('image/heic');
    expect(basename(body.path)).toBe('splitwise-receipt-4644814211.heic');

    await harness.close();
  });

  it('blames the missing text layer, not the flag the caller already passed', async () => {
    // Read-only server + extract_text on a scan: advising extract_text:true
    // here would be advice to repeat the call that just failed.
    writeFileSync(join(outputDir, 'blocker'), 'not a directory');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(SCANNED_PDF, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      extract_text: true,
      output_dir: join(outputDir, 'blocker', 'sub'),
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('no text layer');
    expect(errorText(result)).toContain('inline:true');
    // Not the generic "re-run with extract_text:true" advice.
    expect(errorText(result)).not.toContain('extract_text:true');

    await harness.close();
  });

  it('does not advise a flag that is already set and already blocked', async () => {
    // extract_text + inline, scanned PDF, over the cap, read-only output_dir:
    // both requested routes are closed, so neither may be offered as the fix.
    const bigScan = new Uint8Array(4 * 1024 * 1024 + 1);
    bigScan.set(SCANNED_PDF.subarray(0, Math.min(SCANNED_PDF.length, bigScan.length)));
    writeFileSync(join(outputDir, 'blocker'), 'not a directory');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(bigScan, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      extract_text: true,
      inline: true,
      output_dir: join(outputDir, 'blocker', 'sub'),
    });
    const message = errorText(result);

    expect(result.isError).toBe(true);
    // Both blockers are named...
    expect(message).toContain('no text layer');
    expect(message).toContain('inline limit');
    // ...and neither closed route is offered as the way out.
    expect(message).not.toContain('inline:true');
    expect(message).not.toContain('extract_text:true');
    expect(message).toContain('output_dir');

    await harness.close();
  });

  it('does not suggest inline on the success path when inline was already rejected', async () => {
    // inline + extract_text on an oversized scan, write SUCCEEDS -> success path.
    // text_note must not advise a flag inline_skipped already reports as refused.
    const bigScan = new Uint8Array(4 * 1024 * 1024 + 1);
    bigScan.set(SCANNED_PDF.subarray(0, Math.min(SCANNED_PDF.length, bigScan.length)));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: API_RECEIPT_URL }))
      .mockResolvedValueOnce(binaryResponse(bigScan, 'application/pdf'));
    const harness = await harnessWith(fetchMock);

    const result = await harness.callTool('sw_get_receipt', {
      id: 4644814211,
      extract_text: true,
      inline: true,
      output_dir: outputDir,
    });
    const body = parseToolResult<{ path: string; text_note: string; inline_skipped: string }>(result);

    expect(result.isError).toBeFalsy();
    expect(body.path).toBeTruthy();
    // The diagnosis stays; the stale suggestion must not.
    expect(body.text_note).toContain('no text layer');
    expect(body.text_note).not.toContain('inline:true');
    expect(body.inline_skipped).toContain('inline limit');

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
    // The write succeeded, so it must point at the file, not at write:true.
    expect(body.inline_skipped).toContain('path above');
    expect(body.inline_skipped).not.toContain('write:true');
    // The file is still written — only the base64 copy is dropped.
    expect(result.content).toHaveLength(1);
    expect(readdirSync(outputDir)).toEqual(['splitwise-receipt-4644814211.jpg']);

    await harness.close();
  });

  it('redacts the signature even when the upstream echoes the whole URL back', async () => {
    // S3's SignatureDoesNotMatch body echoes the signed URL. Redaction keys off
    // the exact query we sent, so it scrubs the echo too — not just the request
    // path the error formatter happens to name.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expenseResponse({ original: S3_RECEIPT_URL }))
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => `<Error><Code>SignatureDoesNotMatch</Code><StringToSign>${S3_RECEIPT_URL}</StringToSign></Error>`,
      });
    const harness = await harnessWith(fetchMock);

    const message = errorText(await harness.callTool('sw_get_receipt', { id: 4644814211, output_dir: outputDir }));

    expect(message).not.toContain('SECRETSIG');
    expect(message).toContain('SignatureDoesNotMatch');

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
