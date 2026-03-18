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

  it('throws at construction if SPLITWISE_API_KEY is not set', async () => {
    const { SplitwiseClient: Client } = await import('../src/client.js?no-key');
    // We can't easily re-import without the key in vitest ESM. Instead test the guard directly.
    // This is covered by the guard check in the constructor.
    expect(() => {
      const orig = process.env.SPLITWISE_API_KEY;
      process.env.SPLITWISE_API_KEY = '';
      try {
        new Client();
      } finally {
        process.env.SPLITWISE_API_KEY = orig;
      }
    }).toThrow('SPLITWISE_API_KEY environment variable is required');
  });

  it('sends Authorization header with Bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 1 } }),
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
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
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
    }));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'Splitwise API error: 500 Internal Server Error for GET /get_current_user'
    );
  });

  it('sends POST body as JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ expense: {} }),
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
