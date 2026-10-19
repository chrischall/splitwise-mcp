import type { McpServer } from '@modelcontextprotocol/server';
import { registerBatchTool, registerConfirmTool } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';

/**
 * `sw_confirm` and `sw_batch` — the two ways to spend fewer calls on Splitwise
 * writes from a client that cannot show a confirmation prompt (claude.ai).
 *
 * - `sw_confirm({confirmToken})` finishes any gated write's two-step
 *   confirmation with the token alone: the server kept the phase-1 arguments,
 *   so a base64 receipt does not cross the conversation a second time.
 * - `sw_batch({ops})` previews and approves several expense/comment writes at
 *   once — "log the expense, comment on it, attach the receipt" in one
 *   approval, with the new expense's id fed forward through `refs`.
 *
 * Both come from `@chrischall/mcp-utils` (docs/CONFIRM-TOKEN.md §13–14).
 * Registered LAST: the batch tool lists the writes registered before it.
 */
export function registerBatchTools(server: McpServer, _client: SplitwiseClient): void {
  registerConfirmTool(server, { name: 'sw_confirm' });
  registerBatchTool(server, {
    name: 'sw_batch',
    description:
      'Several Splitwise writes in one go, e.g. create an expense, then sw_create_comment / sw_attach_receipt on it with refs {"expense_id": "0.expense_id"}.',
  });
}
