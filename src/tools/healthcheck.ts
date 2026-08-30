import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { SplitwiseClient } from '../client.js';

/**
 * Register `sw_healthcheck` — resolves the API key the way real tools do, then
 * makes one authenticated call to `/get_current_user`.
 *
 * Splitwise has no browser bridge, so "health" here is entirely about the
 * credential: whether one resolved at all, and whether Splitwise still accepts
 * it. Those are different problems with different fixes and, without this,
 * both surface as the same opaque tool error.
 *
 * `/get_current_user` is the probe because it is the cheapest endpoint that
 * REQUIRES auth — an unauthenticated endpoint would pass while the key was
 * expired, which is the failure most worth catching.
 */
export function registerHealthcheckTools(server: McpServer, client: SplitwiseClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'sw',
    hostLabel: 'secure.splitwise.com',
    probePath: '/api/v3.0/get_current_user',
    resolveCredential: async () => client.describeCredential(),
    probeFn: () => client.request('GET', '/get_current_user'),
    hints: {
      no_credential:
        'No Splitwise API key resolved. Set SPLITWISE_API_KEY, or reconnect the connector so it supplies one.',
      credential_rejected:
        'Splitwise rejected the API key. Generate a new one at https://secure.splitwise.com/apps and update SPLITWISE_API_KEY (or reconnect the connector).',
    },
  });
}
