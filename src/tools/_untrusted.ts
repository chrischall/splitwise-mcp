import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  untrustedEnvelope,
  untrustedResult,
} from '@chrischall/mcp-utils';

/**
 * Comments, notifications, expense descriptions/details and receipt text are
 * written by OTHER Splitwise users — a roommate, a co-parent, anyone in a
 * shared group — and this server also exposes writes (fleet-audit #737).
 */
export const SW_UNTRUSTED_NOTE = `Expense descriptions and notes, comments, notifications and receipt text below are written by other Splitwise users (friends and group members), not the user. ${UNTRUSTED_CONTENT_RULE}`;

export { UNTRUSTED_DESCRIPTION_SUFFIX };

/** A tool result fencing third-party text: markers first, then the payload. */
export function swUntrustedResult(payload: unknown): CallToolResult {
  return untrustedResult(payload, { note: SW_UNTRUSTED_NOTE });
}

/** The same envelope as a plain object, for a result built by hand. */
export function swUntrustedEnvelope(payload: unknown): Record<string, unknown> {
  return untrustedEnvelope(payload, { note: SW_UNTRUSTED_NOTE });
}
