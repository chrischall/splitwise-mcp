import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { SplitwiseClient } from '../src/client.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerGroupTools } from '../src/tools/groups.js';
import { registerFriendTools } from '../src/tools/friends.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerUtilityTools } from '../src/tools/utilities.js';

// Handshake + tool-surface test for the Splitwise Cloudflare remote connector,
// run inside the real Workers runtime (Miniflare) via
// `@cloudflare/vitest-pool-workers` against `wrangler.jsonc`. It proves three
// things that don't require a live Splitwise session:
//   1. the OAuth default handler serves discovery + the login page, and
//   2. an unauthenticated `/mcp` request is rejected before any tool code runs;
//   3. the exact registrar wiring `src/worker.ts` uses registers the full
//      25-tool Splitwise surface.
//
// The full authenticated `initialize` + `tools/list` handshake over `/mcp`
// requires a real OAuth access token minted via `workers-oauth-provider`'s
// KV-backed grant flow (POST /authorize with a real Splitwise key → auth code →
// POST /token), which would mean a live Splitwise login or extensive KV mocking
// — out of scope for a hermetic in-process test. So #3 asserts tool registration
// through the same in-memory MCP harness the stdio suite uses, wired exactly as
// `worker.ts` wires it, rather than through the token-gated `/mcp` route.

describe('Splitwise Cloudflare connector — OAuth surface', () => {
  it('serves the OAuth authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
  });

  it('rejects an unauthenticated /mcp request', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /authorize renders the Splitwise login page with the API-key field', async () => {
    // No `client_id` query param: the login page renders without needing a
    // registered OAuth client, which is all we verify here.
    const res = await SELF.fetch('https://example.com/authorize?response_type=code&state=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Splitwise');
    expect(html).toContain('Splitwise API key');
    expect(html).toContain('type="password"');
  });
});

describe('Splitwise Cloudflare connector — tool surface', () => {
  it('registers the full Splitwise tool set via the same wiring as worker.ts', async () => {
    const client = new SplitwiseClient({ apiKey: 'test-key' });

    // Mirror src/worker.ts's `tools` array exactly (same order, same wiring).
    const harness = await createTestHarness((server) => {
      registerUserTools(server, client);
      registerGroupTools(server, client);
      registerFriendTools(server, client);
      registerExpenseTools(server, client);
      registerUtilityTools(server, client);
    });

    try {
      const names = (await harness.listTools()).map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'sw_add_user_to_group',
          'sw_create_comment',
          'sw_create_expense',
          'sw_create_friend',
          'sw_create_group',
          'sw_delete_comment',
          'sw_delete_expense',
          'sw_delete_friend',
          'sw_delete_group',
          'sw_get_categories',
          'sw_get_comments',
          'sw_get_currencies',
          'sw_get_current_user',
          'sw_get_expense',
          'sw_get_group',
          'sw_get_notifications',
          'sw_get_user',
          'sw_list_expenses',
          'sw_list_friends',
          'sw_list_groups',
          'sw_remove_user_from_group',
          'sw_undelete_expense',
          'sw_undelete_group',
          'sw_update_expense',
          'sw_update_user',
        ].sort(),
      );
      expect(names.length).toBe(25);
    } finally {
      await harness.close();
    }
  });
});
