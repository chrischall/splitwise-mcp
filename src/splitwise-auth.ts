import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { SplitwiseClient } from './client.js';

/**
 * OAuth props stored per user by the Cloudflare connector's OAuth provider.
 *
 * Splitwise issues a long-lived personal API key (no OAuth refresh cycle), so —
 * unlike the OFW connector, which stores a username/password to re-login when a
 * short-lived bearer token expires — we only need to store the key itself. It is
 * encrypted at rest in OAUTH_KV by the OAuth provider and turned back into a
 * per-user `SplitwiseClient` by `worker.ts`'s `buildClient`.
 *
 * The index signature satisfies `createConnector`'s
 * `Props extends Record<string, unknown>` constraint.
 */
export interface SplitwiseProps {
  apiKey: string;
  [key: string]: unknown;
}

/**
 * `ConnectorAuth` for the Splitwise remote connector: the login page collects
 * the user's own Splitwise API key (from https://secure.splitwise.com/apps/register),
 * verifies it by constructing a `SplitwiseClient` with the key and calling the
 * current-user endpoint (a bad key throws, which the connector surfaces back on
 * the login page), and stores `{ apiKey }` as the OAuth props that `worker.ts`'s
 * `buildClient` turns into a per-user client.
 */
export const splitwiseAuth: ConnectorAuth<SplitwiseProps> = {
  service: 'Splitwise',
  accent: '#1CC29F',
  privacyNote:
    'Your Splitwise API key is stored encrypted and used only to call Splitwise on your behalf.',
  fields: [{ name: 'apiKey', label: 'Splitwise API key', type: 'password' }],
  async login(fields) {
    // Verify the key up front — an invalid key makes /get_current_user throw
    // here, which the connector surfaces back on the login page. We discard the
    // response: the per-user client is built fresh from the stored key.
    const client = new SplitwiseClient({ apiKey: fields.apiKey });
    await client.request('GET', '/get_current_user');
    return { apiKey: fields.apiKey };
  },
};
