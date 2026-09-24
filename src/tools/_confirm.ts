import type { ServerContext } from '@modelcontextprotocol/server';
import {
  confirmationFromEnv,
  confirmTokenParam,
  requireConfirmationWithFallback,
} from '@chrischall/mcp-utils';

export { confirmTokenParam };

/** The sentence every gated tool's description ends with. */
export const CONFIRM_NOTE =
  'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).';

export interface WriteGate {
  /** The tool name the token is bound to. */
  tool: string;
  /** `<service>.<verb>`, e.g. `expense.create`. */
  action: string;
  /** One line in the user's words: what will happen and who it notifies. */
  summary: string;
  method: string;
  path: string;
  /** Exactly the body the write will send, when it sends one. */
  body?: unknown;
  /** The primary id acted on, or '' when there is none. */
  target: string | number;
  /** The phase-2 token from the tool's input. */
  confirmToken?: string;
}

/**
 * Confirm-gate for a mutating tool. Splitwise writes notify other people
 * (friends / group members), so a single hallucinated call shouldn't fire
 * silently.
 *
 * A client that can show a prompt is asked; one that cannot gets the two-step
 * token flow (`MCP_CONFIRM_MODE`): the first call does nothing and returns the
 * preview below plus a confirmToken bound to exactly this request, and only a
 * repeat call with that token proceeds. `undefined` means proceed; anything
 * else is the result to return unchanged.
 */
export function confirmWrite(ctx: ServerContext, gate: WriteGate) {
  const request = {
    method: gate.method,
    path: gate.path,
    ...(gate.body !== undefined ? { willSend: gate.body } : {}),
  };
  const preview = { action: gate.summary, ...request };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: gate.action,
      message: `Review and confirm: ${gate.summary}`,
      details: preview,
      tool: gate.tool,
      confirmToken: gate.confirmToken,
      subject: () => ({ target: String(gate.target), payload: request, preview }),
    }),
  );
}
