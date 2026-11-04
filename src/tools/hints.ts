// Context-group hints, published on each tool as `_meta.mint` (the mcp-host
// context-groups contract, `mintHintSchema`). Inert data: a host that does not
// read them sees an extra `_meta` key and nothing else. The shape is restated
// here rather than imported — this server takes no dependency on mcp-host.
//
// `subject` and `when` name THIS tool's own argument names (the host fills
// them), never values; `aliases` are the words a person says — lowercase, at
// most 8, each at most 40 chars. Splitwise names no `subject` anywhere: one API
// key is one account, and nothing here is a set of subjects a person would
// name (friends and groups are counterparties, not whose-question-is-this).

import type { McpServer } from '@modelcontextprotocol/server';

export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'money';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Splitwise tool: every tool here is in the `money` group. */
export function moneyMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'money', intent, ...extra } };
}

/**
 * Run `register` with `_meta` added to every tool it registers.
 *
 * For mcp-utils' `registerWrite`, `registerConfirmTool` and `registerBatchTool`,
 * which build the `registerTool` config themselves and take no `_meta`. The SAME
 * server object is patched (not a proxy), so registerWrite's per-server write
 * registry — what `sw_batch` reads — still keys on the real server; the original
 * `registerTool` is restored afterwards, even when `register` throws.
 */
export function withToolMeta(server: McpServer, meta: Record<string, unknown>, register: () => void): void {
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'registerTool');
  const original = target.registerTool;
  target.registerTool = (name: unknown, config: unknown, ...rest: unknown[]) =>
    original.call(server, name, { ...(config as Record<string, unknown>), _meta: meta }, ...rest);
  try {
    register();
  } finally {
    if (hadOwn) target.registerTool = original;
    else delete (target as { registerTool?: unknown }).registerTool;
  }
}

/** The words a person says about a write that puts a charge on someone. */
export const EXPENSE_WRITE_ALIASES = ['split a bill', 'add an expense', 'log an expense', 'split the cost', 'i paid for'];
