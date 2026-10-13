// End-to-end over a real socket: the tools, a real SplitwiseClient and its
// createApiClient transport, against a local HTTP server standing in for
// Splitwise. Unlike the unit tests (which spy on client methods), this proves
// what actually goes over the wire — the multipart framing, the field names,
// the file part, the auth header — and that a receipt-less write is unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { SplitwiseClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  raw: Buffer;
}

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

let server: Server;
let captured: Captured[] = [];
/** What the fake Splitwise answers next; defaults to "receipt stored". */
let respond: (req: Captured) => unknown;
let harness: Awaited<ReturnType<typeof createTestHarness>>;

const stored = (id: number) => ({
  expenses: [{ id, cost: '54.11', receipt: { large: `https://s3.test/${id}/l.pdf`, original: `https://s3.test/${id}/o.pdf` } }],
  errors: {},
});

async function formOf(req: Captured): Promise<FormData> {
  return new Request('http://parse.local', {
    method: 'POST',
    headers: { 'content-type': String(req.headers['content-type']) },
    body: new Uint8Array(req.raw),
  }).formData();
}

/** Run the two-step token flow (the harness has no elicitation handler). */
async function confirmed(name: string, args: Record<string, unknown>) {
  const first = parseToolResult<{ status: string; confirmToken: string }>(await harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(captured).toHaveLength(0); // phase 1 never reaches Splitwise
  return harness.callTool(name, { ...args, confirmToken: first.confirmToken });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, raw: Buffer.concat(chunks) };
      captured.push(entry);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond(entry)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const client = new SplitwiseClient({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}/api/v3.0` });
  harness = await createTestHarness((s) => registerExpenseTools(s, client));
});

afterAll(async () => {
  await harness.close();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  captured = [];
  respond = () => stored(1);
});

describe('receipt upload over HTTP (mocked Splitwise endpoint)', () => {
  it('create: multipart with flattened split fields and the file part', async () => {
    respond = () => stored(11);
    const result = await confirmed('sw_create_expense', {
      group_id: 7,
      description: 'Water jug',
      cost: '54.11',
      users: [
        { user_id: 1, paid_share: '54.11', owed_share: '27.06' },
        { user_id: 2, paid_share: '0.00', owed_share: '27.05' },
      ],
      receipt: { base64: b64(PDF), filename: 'jug.pdf' },
    });
    expect(result.isError).toBeFalsy();

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v3.0/create_expense');
    expect(req.headers.authorization).toBe('Bearer test-key');
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);

    const form = await formOf(req);
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== 'receipt'))).toEqual({
      group_id: '7',
      description: 'Water jug',
      cost: '54.11',
      users__0__user_id: '1',
      users__0__paid_share: '54.11',
      users__0__owed_share: '27.06',
      users__1__user_id: '2',
      users__1__paid_share: '0.00',
      users__1__owed_share: '27.05',
    });
    const file = form.get('receipt') as File;
    expect(file.name).toBe('jug.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);

    const out = parseToolResult<{ receipt_attached: boolean; receipt: unknown }>(result);
    expect(out.receipt_attached).toBe(true);
    expect(out.receipt).toEqual(stored(11).expenses[0].receipt);
  });

  it('update: receipt alongside a changed field', async () => {
    respond = () => stored(12);
    const result = await confirmed('sw_update_expense', {
      expense_id: 12,
      description: 'Renamed',
      receipt: { base64: b64(PNG), filename: 'r.png' },
    });
    expect(result.isError).toBeFalsy();
    const req = captured[0];
    expect(req.url).toBe('/api/v3.0/update_expense/12');
    const form = await formOf(req);
    expect([...form.keys()]).toEqual(['description', 'receipt']);
    expect((form.get('receipt') as File).type).toBe('image/png');
  });

  it('attach: only the file goes over the wire — no cost, split or other field', async () => {
    respond = () => stored(4644807844);
    const result = await confirmed('sw_attach_receipt', {
      expense_id: 4644807844,
      receipt: { base64: b64(PDF), filename: 'AA_SJDIWS_receipt_2026-08-13.pdf' },
    });
    expect(result.isError).toBeFalsy();
    const req = captured[0];
    expect(req.url).toBe('/api/v3.0/update_expense/4644807844');
    const form = await formOf(req);
    expect([...form.keys()]).toEqual(['receipt']);
    expect((form.get('receipt') as File).name).toBe('AA_SJDIWS_receipt_2026-08-13.pdf');
  });

  it('attach: a 200 with receipt still null is an error, not a success', async () => {
    respond = () => ({ expenses: [{ id: 13, receipt: { large: null, original: null } }], errors: {} });
    const result = await confirmed('sw_attach_receipt', {
      expense_id: 13,
      receipt: { base64: b64(PNG), filename: 'r.png' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('did not attach the receipt');
  });

  it('no receipt: the request is the same JSON body as before, not multipart', async () => {
    respond = () => ({ expenses: [{ id: 14 }], errors: {} });
    await confirmed('sw_update_expense', { expense_id: 14, cost: '20.00', split_equally: true });
    const req = captured[0];
    expect(req.headers['content-type']).toMatch(/^application\/json/);
    expect(req.raw.toString('utf8')).toBe(JSON.stringify({ cost: '20.00', split_equally: true }));
  });
});
