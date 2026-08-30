import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '../helpers.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import type { SplitwiseClient } from '../../src/client.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean };
  error?: { kind: string; message: string };
  hint: string;
}

function clientWith(source: string | null, probe: () => Promise<unknown>): SplitwiseClient {
  return {
    describeCredential: () => ({ source }),
    request: probe,
  } as unknown as SplitwiseClient;
}

async function call(client: SplitwiseClient) {
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
  const res = await h.client.callTool({ name: 'sw_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('sw_healthcheck', () => {
  it('reports ok when the key resolves and Splitwise accepts it', async () => {
    const r = await call(clientWith('env', async () => ({ user: { id: 1 } })));
    expect(r.ok).toBe(true);
    expect(r.credential).toMatchObject({ source: 'env', resolved: true });
  });

  it('reports no_credential without probing when no key resolved', async () => {
    let probed = false;
    const r = await call(
      clientWith(null, async () => {
        probed = true;
        return {};
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_credential');
    expect(probed).toBe(false);
    expect(r.hint).toMatch(/SPLITWISE_API_KEY/);
  });

  it('distinguishes a rejected key from a Splitwise-side error', async () => {
    const rejected = await call(
      clientWith('env', async () => {
        throw Object.assign(new Error('Invalid API request'), { status: 401 });
      }),
    );
    expect(rejected.error?.kind).toBe('credential_rejected');
    expect(rejected.hint).toMatch(/secure\.splitwise\.com\/apps/);

    const upstream = await call(
      clientWith('env', async () => {
        throw Object.assign(new Error('Bad gateway'), { status: 502 });
      }),
    );
    expect(upstream.error?.kind).toBe('http');
  });

  // The result is what people paste into a chat when something is broken.
  it('never reports the key itself', async () => {
    const r = await call(clientWith('env', async () => ({})));
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{32}/i);
  });
});
