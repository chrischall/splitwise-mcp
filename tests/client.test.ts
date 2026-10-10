import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the client by controlling what fetch returns.
// The client module reads env at construction time, so set the env var before importing.
process.env.SPLITWISE_API_KEY = 'test-key';

const { SplitwiseClient, MAX_RESPONSE_BYTES } = await import('../src/client.js');
const { WriteOutcomeUnknownError } = await import('@chrischall/mcp-utils');

/** A real fetch Response: mcp-utils 3 streams `res.body` under a size cap. */
function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, ...init });
}

describe('SplitwiseClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defers the missing-key error until request time (constructor must not throw)', async () => {
    const { SplitwiseClient: Client } = await import('../src/client.js?no-key');
    // Constructor stays silent so the server can boot and respond to the
    // host's install-time smoke test before the user has filled in env vars.
    const orig = process.env.SPLITWISE_API_KEY;
    process.env.SPLITWISE_API_KEY = '';
    try {
      const client = new Client();
      await expect(client.request('GET', '/anything')).rejects.toThrow(
        'SPLITWISE_API_KEY environment variable is required',
      );
    } finally {
      process.env.SPLITWISE_API_KEY = orig;
    }
  });

  it('uses an injected apiKey over the environment (hosted per-user seam)', async () => {
    // The constructor seam a hosted per-user deployment uses: build one client
    // per request with that user's key injected, bypassing the process env.
    const mockFetch = vi.fn().mockImplementation(async () => jsonResponse({ user: { id: 1 } }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient({ apiKey: 'injected-user-key' });
    await client.request('GET', '/get_current_user');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://secure.splitwise.com/api/v3.0/get_current_user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer injected-user-key',
        }),
      })
    );
  });

  it('sends Authorization header with Bearer token', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => jsonResponse({ user: { id: 1 } }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('GET', '/get_current_user');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://secure.splitwise.com/api/v3.0/get_current_user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );
  });

  it('bounds every request with a timeout (passes an AbortSignal to fetch)', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => jsonResponse({}));
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('GET', '/get_current_user');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // createApiClient only sets a signal when its `timeout` option is configured.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it('throws on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response(null, { status: 401, statusText: 'Unauthorized' }),
    ));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'SPLITWISE_API_KEY is invalid or missing'
    );
  });

  it('retries once on 429 then succeeds', async () => {
    const mockFetch = vi.fn()
      .mockImplementationOnce(async () => new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockImplementationOnce(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.request('GET', '/get_current_user');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('throws after two 429 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response(null, { status: 429, statusText: 'Too Many Requests' }),
    ));
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.request('GET', '/get_current_user');
    const assertion = expect(promise).rejects.toThrow('Rate limited by Splitwise API');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    vi.useRealTimers();
  });

  it('throws on other non-2xx errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response('', { status: 500, statusText: 'Internal Server Error' }),
    ));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'Splitwise error 500 for GET /get_current_user'
    );
  });

  it('surfaces (redacted, truncated) upstream error body on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ errors: { base: ['Invalid expense'] } }), {
          status: 400,
          statusText: 'Bad Request',
        }),
    ));

    const client = new SplitwiseClient();
    await expect(client.request('POST', '/create_expense', {})).rejects.toThrow(
      'Splitwise error 400 for POST /create_expense: {"errors":{"base":["Invalid expense"]}}'
    );
  });

  it('blames the asset host, not Splitwise, for a 429 on the anonymous path', async () => {
    const mockFetch = vi.fn().mockImplementation(
      async () => new Response(null, { status: 429, statusText: 'Too Many Requests' }),
    );
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.fetchAsset('https://splitwise.s3.amazonaws.com/uploads/receipt.pdf?sig=x');
    const assertion = expect(promise).rejects.toThrow('Rate limited by splitwise.s3.amazonaws.com');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    vi.useRealTimers();
  });

  it('sends no Authorization header to a non-Splitwise asset host', async () => {
    const mockFetch = vi.fn().mockImplementation(
      async () => new Response(new Uint8Array(4), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.fetchAsset('https://splitwise.s3.amazonaws.com/uploads/receipt.pdf?sig=x');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('reports a timed-out write as outcome-unknown, not a plain timeout (mcp-utils 3)', async () => {
    // A hung fetch that honours its abort signal, as a real one does.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ));
    vi.useFakeTimers();
    try {
      const client = new SplitwiseClient();
      const promise = client.request('POST', '/create_expense', { cost: '1.00' });
      const assertion = expect(promise).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a multipart write with auth, leaving Content-Type for fetch to set', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => jsonResponse({ expenses: [{ id: 9 }] }));
    vi.stubGlobal('fetch', mockFetch);
    const client = new SplitwiseClient();
    const form = new FormData();
    form.append('description', 'Jug');
    form.append('receipt', new Blob([Uint8Array.from([1, 2])], { type: 'image/png' }), 'r.png');

    await client.requestMultipart('POST', '/create_expense', form);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/create_expense');
    expect(init.body).toBe(form);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  });

  it('treats a 200 with errors on a multipart write as a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse({ expenses: [], errors: { receipt: ['is too big'] } })),
    );
    const client = new SplitwiseClient();
    await expect(client.requestMultipart('POST', '/update_expense/1', new FormData())).rejects.toThrow(
      'Splitwise rejected the request: receipt: is too big',
    );
  });

  it('sends POST body as JSON', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => jsonResponse({ expense: {} }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('POST', '/create_expense', { description: 'Dinner', cost: '50.00' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ description: 'Dinner', cost: '50.00' }),
      })
    );
  });
});

describe('SplitwiseClient response size caps (fleet-audit #733)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses an API response whose Content-Length is over the client-wide cap, without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      { pull(c) { pulled++; c.enqueue(new TextEncoder().encode('{}')); c.close(); } },
      { highWaterMark: 0 },
    );
    const res = new Response(body, { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_expenses')).rejects.toMatchObject({
      kind: 'too_large',
      maxBytes: MAX_RESPONSE_BYTES,
    });
    expect(pulled).toBe(0);
  });

  it('refuses a streamed body that grows past the cap', async () => {
    const big = new Uint8Array(MAX_RESPONSE_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(big, { status: 200 })));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_expenses')).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('applies a per-call maxBytes to an asset download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async () => new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    ));

    const client = new SplitwiseClient();
    await expect(
      client.fetchAsset('https://splitwise.s3.amazonaws.com/uploads/receipt.pdf?sig=x', { maxBytes: 1024 }),
    ).rejects.toMatchObject({ kind: 'too_large', maxBytes: 1024 });
    // Under the cap, the same download succeeds.
    await expect(
      client.fetchAsset('https://splitwise.s3.amazonaws.com/uploads/receipt.pdf?sig=x', { maxBytes: 4096 }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('a too-large asset error does not leak the signed query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new Uint8Array(2048), { status: 200 })));

    const client = new SplitwiseClient();
    const err = await client
      .fetchAsset('https://splitwise.s3.amazonaws.com/uploads/receipt.pdf?X-Amz-Signature=SECRETSIG', { maxBytes: 1024 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('SECRETSIG');
  });
});

// describeCredential must agree with the key resolution beside it, including
// the edge the two once disagreed on: `??` passes an injected empty string
// through (it is not nullish), so `key` is falsy and the client is
// unconfigured — while a truthiness test on the same input said "env".
describe('SplitwiseClient.describeCredential', () => {
  const saved = process.env.SPLITWISE_API_KEY;
  beforeEach(() => {
    delete process.env.SPLITWISE_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SPLITWISE_API_KEY;
    else process.env.SPLITWISE_API_KEY = saved;
  });

  it('is null when neither an injected key nor the env var is present', () => {
    expect(new SplitwiseClient().describeCredential()).toEqual({ source: null });
  });

  it('reports env when only the env var is set', () => {
    process.env.SPLITWISE_API_KEY = 'k';
    expect(new SplitwiseClient().describeCredential()).toEqual({ source: 'env' });
  });

  it('reports injected when a key is passed in', () => {
    expect(new SplitwiseClient({ apiKey: 'k' }).describeCredential()).toEqual({ source: 'injected' });
  });

  it('reports null for an injected EMPTY key, matching the client being unconfigured', () => {
    process.env.SPLITWISE_API_KEY = 'from-env';
    // `??` keeps the empty string, so the client has no usable key. The source
    // must say so rather than pointing at the env var it never consulted.
    expect(new SplitwiseClient({ apiKey: '' }).describeCredential()).toEqual({ source: null });
  });

  it('never returns the key', () => {
    process.env.SPLITWISE_API_KEY = 'SUPER_SECRET_KEY_VALUE';
    expect(JSON.stringify(new SplitwiseClient().describeCredential())).not.toContain('SUPER_SECRET_KEY_VALUE');
  });
});

describe('SplitwiseClient write-error bodies (HTTP 200 with errors)', () => {
  beforeEach(() => {
    process.env.SPLITWISE_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBody(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(body)),
    );
  }

  it('throws on create_expense validation errors ({expenses: [], errors: {...}})', async () => {
    stubBody({ expenses: [], errors: { base: ['An expense must have a cost'], cost: ['is invalid'] } });
    await expect(new SplitwiseClient().request('POST', '/create_expense', {})).rejects.toThrow(
      /Splitwise rejected the request: .*An expense must have a cost.*cost: is invalid/,
    );
  });

  it('throws on {success: false, errors: {...}} from delete/undelete', async () => {
    stubBody({ success: false, errors: { base: ['Expense not found'] } });
    await expect(new SplitwiseClient().request('POST', '/delete_expense/1')).rejects.toThrow(
      'Expense not found',
    );
  });

  it('throws on {success: false} with no error detail', async () => {
    stubBody({ success: false });
    await expect(new SplitwiseClient().request('POST', '/delete_friend/1')).rejects.toThrow(
      /Splitwise rejected the request/,
    );
  });

  it('flattens an array-shaped errors value', async () => {
    stubBody({ errors: ['one', 'two'] });
    await expect(new SplitwiseClient().request('POST', '/create_group', {})).rejects.toThrow('one; two');
  });

  it('passes a write through when errors is empty', async () => {
    stubBody({ expenses: [{ id: 5 }], errors: {} });
    await expect(new SplitwiseClient().request('POST', '/create_expense', {})).resolves.toEqual({
      expenses: [{ id: 5 }],
      errors: {},
    });
  });

  it('passes {success: true, errors: []} through', async () => {
    stubBody({ success: true, errors: [] });
    await expect(new SplitwiseClient().request('POST', '/delete_expense/1')).resolves.toEqual({
      success: true,
      errors: [],
    });
  });
});
