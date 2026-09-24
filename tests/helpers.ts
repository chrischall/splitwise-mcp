// Re-export the shared in-memory test harness from `@chrischall/mcp-utils/test`.
// Every MCP in the fleet defined a byte-identical `createTestHarness`; this now
// lives in one place. Kept as a local re-export so existing test imports
// (`../helpers.js`) continue to resolve unchanged.
import { expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';

export { createTestHarness, parseToolResult };

type Harness = Awaited<ReturnType<typeof createTestHarness>>;

/** The phase-1 body a gated write returns to a client that cannot be prompted. */
export interface ConfirmationRequired {
  status: 'confirmation-required';
  action: string;
  preview: Record<string, unknown>;
  confirmToken: string;
}

/**
 * Drive a gated write through the two-step token flow on a harness with no
 * elicitation handler (a client that cannot be prompted, e.g. claude.ai):
 *
 * 1. the first call must return `confirmation-required` with a preview and a
 *    token, and must NOT reach `write`;
 * 2. the repeat call with that token must reach `write` exactly once.
 *
 * Returns the phase-1 body (for preview assertions) and the phase-2 result.
 */
export async function confirmedCall(
  harness: Harness,
  write: { mock: { calls: unknown[] } },
  name: string,
  args: Record<string, unknown>,
): Promise<{ phase1: ConfirmationRequired; result: CallToolResult }> {
  const before = write.mock.calls.length;
  const first = await harness.callTool(name, args);
  expect(first.isError).toBeFalsy();
  const phase1 = parseToolResult<ConfirmationRequired>(first);
  expect(phase1.status).toBe('confirmation-required');
  expect(typeof phase1.confirmToken).toBe('string');
  expect(write.mock.calls.length).toBe(before);

  const result = await harness.callTool(name, { ...args, confirmToken: phase1.confirmToken });
  expect(write.mock.calls.length).toBe(before + 1);
  return { phase1, result };
}
