import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the client by controlling what fetch returns.
// The client module reads env at construction time, so set the env var before importing.
process.env.SPLITWISE_API_KEY = 'test-key';

const { SplitwiseClient } = await import('../src/client.js');

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

  it('sends Authorization header with Bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ user: { id: 1 } }),
    });
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
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('GET', '/get_current_user');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // createApiClient only sets a signal when its `timeout` option is configured.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it('throws on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'SPLITWISE_API_KEY is invalid or missing'
    );
  });

  it('retries once on 429 then succeeds', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }));
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.request('GET', '/get_current_user');
    const assertion = expect(promise).rejects.toThrow('Rate limited by Splitwise API');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    vi.useRealTimers();
  });

  it('throws on other non-2xx errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => '',
    }));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'Splitwise error 500 for GET /get_current_user'
    );
  });

  it('surfaces (redacted, truncated) upstream error body on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ errors: { base: ['Invalid expense'] } }),
    }));

    const client = new SplitwiseClient();
    await expect(client.request('POST', '/create_expense', {})).rejects.toThrow(
      'Splitwise error 400 for POST /create_expense: {"errors":{"base":["Invalid expense"]}}'
    );
  });

  it('sends POST body as JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ expense: {} }),
    });
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
