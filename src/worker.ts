import { createConnector } from '@chrischall/mcp-connector';
import { SplitwiseClient } from './client.js';
import { splitwiseAuth, type SplitwiseProps } from './splitwise-auth.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerFriendTools } from './tools/friends.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerUtilityTools } from './tools/utilities.js';

// The Cloudflare remote-connector entrypoint: wires the same transport-neutral
// tool registrars the stdio server uses (`src/index.ts`) into
// `@chrischall/mcp-connector`'s generic OAuth + McpAgent harness. Each user logs
// in on the connector's own OAuth page with their personal Splitwise API key
// (`src/splitwise-auth.ts`), and `buildClient` mints a per-user `SplitwiseClient`
// from it so concurrent sessions never share a key.
//
// Splitwise is STATELESS — there is no local message cache, so unlike the OFW
// connector this Worker declares only the `MCP_OBJECT` per-session agent Durable
// Object (no cache DO, no cache provider).
//
// Full-write, confirm-gated: ALL 25 tools are registered. The write tools rely
// on their existing per-call `confirm: true` dry-run gate (`tools/_confirm.ts`),
// not a structural write-mode gate.
const { Agent, handler } = createConnector<SplitwiseProps, SplitwiseClient>({
  name: 'splitwise-mcp',
  version: '2.1.2', // x-release-please-version
  auth: splitwiseAuth,
  buildClient: (props) => new SplitwiseClient({ apiKey: props.apiKey }),
  // Keep the SAME order as src/index.ts.
  tools: [
    registerUserTools,
    registerGroupTools,
    registerFriendTools,
    registerExpenseTools,
    registerUtilityTools,
  ],
});

// The connector's per-session MCP agent Durable Object
// (`wrangler.jsonc`'s `MCP_OBJECT` → `SplitwiseMcpAgent`) resolves this export.
export { Agent as SplitwiseMcpAgent };

export default handler;
