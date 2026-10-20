import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { registerUploadTools } from '../../src/tools/uploads.js';
import { loadReceipt } from '../../src/tools/_receipt.js';
import { client } from '../../src/client.js';
import { confirmedCall, createTestHarness, parseToolResult } from '../helpers.js';

// Receipts on the hosted server: receipt.path is off there, so a phone
// screenshot had to be inlined as base64 — 200KB+ through the model's context,
// twice. sw_get_upload_url hands out a signed PUT on mcp-host's blob store; the
// caller curls the original file up and passes receipt.upload_id instead.

const BASE = 'https://mcp.test/b/reg_abc123';
const KEY = 'derived-signing-key';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

const hmac = (payload: string) => createHmac('sha256', KEY).update(payload).digest('base64url');

const mockRequest = vi.spyOn(client, 'request');
const mockMultipart = vi.spyOn(client, 'requestMultipart');
const mockAsset = vi.spyOn(client, 'fetchAsset');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({} as never);
  mockMultipart.mockReset();
  mockAsset.mockReset();
  vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', KEY);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (harness) await harness.close();
  mockRequest.mockRestore();
  mockMultipart.mockRestore();
  mockAsset.mockRestore();
});

type Minted = { upload_id: string; upload_url: string; method: string; headers: Record<string, string>; expires_at: string; curl: string };

describe('sw_get_upload_url', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerExpenseTools(server, client);
      registerUploadTools(server, client);
    });
  });

  it('mints a signed PUT bound to the key and content type, in this registration\'s up/ space', async () => {
    const result = await harness.callTool('sw_get_upload_url', { filename: 'Receipt 1.PNG', content_type: 'image/png' });
    expect(result.isError).toBeFalsy();
    const minted = parseToolResult<Minted>(result);
    expect(minted.upload_id).toMatch(/^up\/[0-9a-f-]{36}\/Receipt_1.PNG$/);
    const url = new URL(minted.upload_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/${minted.upload_id}`);
    const exp = Number(url.searchParams.get('exp'));
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
    expect(url.searchParams.get('sig')).toBe(hmac(`put\0reg_abc123/${minted.upload_id}\0image/png\0${exp}`));
    expect(minted.method).toBe('PUT');
    expect(minted.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(minted.curl).toContain('-H "Content-Type: image/png"');
    expect(minted.curl).toContain('--data-binary @');
    expect(minted.curl).toContain(minted.upload_url);
  });

  it('normalises image/jpg and refuses types Splitwise does not take', async () => {
    const jpg = parseToolResult<Minted>(await harness.callTool('sw_get_upload_url', { filename: 'a.jpg', content_type: 'image/JPG' }));
    expect(jpg.headers['Content-Type']).toBe('image/jpeg');
    const html = await harness.callTool('sw_get_upload_url', { filename: 'a.html', content_type: 'text/html' });
    expect(html.isError).toBe(true);
  });

  it.each(['https://mcp.test/', 'https://mcp.test/b/', 'https://mcp.test/b/reg_abc123?x=1'])(
    'refuses to sign against a base URL with no registration path, or a query: %s',
    async (base) => {
      vi.stubEnv('MCP_BLOB_BASE_URL', base);
      const result = await harness.callTool('sw_get_upload_url', { filename: 'a.png', content_type: 'image/png' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/MCP_BLOB_BASE_URL/);
    },
  );

  it('explains the alternatives when this server has no blob store (stdio)', async () => {
    vi.stubEnv('MCP_BLOB_BASE_URL', '');
    const result = await harness.callTool('sw_get_upload_url', { filename: 'a.png', content_type: 'image/png' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/receipt\.path.*receipt\.base64|base64.*path/);
  });
});

describe('receipt.upload_id', () => {
  it('fetches the upload through a signed GET and validates it like any other receipt', async () => {
    mockAsset.mockResolvedValue({ status: 200, contentType: 'image/png', headers: new Headers(), bytes: PNG });
    const receipt = await loadReceipt({ upload_id: 'up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png', filename: 'r.png' }, client);
    expect(receipt.mimeType).toBe('image/png');
    expect(receipt.summary.bytes).toBe(PNG.length);
    const [url, opts] = mockAsset.mock.calls[0]!;
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${BASE}/up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png`);
    const exp = parsed.searchParams.get('exp');
    expect(parsed.searchParams.get('sig')).toBe(hmac(`reg_abc123/up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png\n${exp}`));
    expect(opts).toEqual({ maxBytes: 10 * 1024 * 1024 });
  });

  it('signs the read link byte for byte as the pre-library signer did (pinned vector)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    try {
      mockAsset.mockResolvedValue({ status: 200, contentType: 'image/png', headers: new Headers(), bytes: PNG });
      await loadReceipt({ upload_id: 'up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png', filename: 'r.png' }, client);
      expect(mockAsset.mock.calls[0]![0]).toBe(
        'https://mcp.test/b/reg_abc123/up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png?exp=1790000300000&sig=XdgCAVdCcA9BCIGoManaD5J9G4UdEvfF8WYjh0yoER8',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['lib/x/secret.png', 'up/../lib/a.png', 'up/abc/r.png', '/up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png'])(
    'refuses an upload_id outside the uploads this tool mints: %s',
    async (upload_id) => {
      await expect(loadReceipt({ upload_id, filename: 'r.png' }, client)).rejects.toThrow(/upload_id/);
      expect(mockAsset).not.toHaveBeenCalled();
    },
  );

  it('needs exactly one source', async () => {
    await expect(
      loadReceipt({ upload_id: 'up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png', base64: 'iVBORw0K', filename: 'r.png' }, client),
    ).rejects.toThrow(/exactly one of/);
  });

  it('says what happened when the upload is missing or expired', async () => {
    const { ApiError } = await import('@chrischall/mcp-utils');
    mockAsset.mockRejectedValue(new ApiError(404, 'not found'));
    await expect(loadReceipt({ upload_id: 'up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png', filename: 'r.png' }, client)).rejects.toThrow(
      /No upload found.*sw_get_upload_url/,
    );
  });

  it('works end to end on sw_attach_receipt, and the preview binds the file\'s sha256', async () => {
    mockAsset.mockResolvedValue({ status: 200, contentType: 'image/png', headers: new Headers(), bytes: PNG });
    mockMultipart.mockResolvedValue({ expenses: [{ id: 42, receipt: { original: 'https://s3/o.png' } }] } as never);
    const { phase1, result } = await confirmedCall(harness, mockMultipart, 'sw_attach_receipt', {
      expense_id: 42,
      receipt: { upload_id: 'up/1b4e28ba-2fa1-11d2-883f-0016d3cca427/r.png', filename: 'r.png' },
    });
    expect((phase1.preview.willSend as { receipt: { sha256: string } }).receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.isError).toBeFalsy();
    const form = mockMultipart.mock.calls[0]![2] as FormData;
    expect(new Uint8Array(await (form.get('receipt') as File).arrayBuffer())).toEqual(PNG);
  });
});
