#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerFriendTools } from './tools/friends.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerUtilityTools } from './tools/utilities.js';

// runMcp builds the McpServer, applies the registrars (threading `client`
// through as deps), prints the banner to stderr, wires graceful shutdown, and
// connects the stdio transport. The Splitwise client is a module-level
// singleton constructed in ./client.js that defers its config error to the
// first request. That preserves the deferred-config-error pattern: the server
// boots and answers the host's install-time tools/list smoke test even when
// SPLITWISE_API_KEY is absent — the configuration error only surfaces on the
// first tool call. A hosted per-user connector (a later task) injects its own
// per-request client into the same registrars instead of this singleton.
await runMcp({
  name: 'splitwise-mcp',
  version: '2.1.0', // x-release-please-version
  deps: client,
  banner:
    '[splitwise-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.',
  tools: [
    registerUserTools,
    registerGroupTools,
    registerFriendTools,
    registerExpenseTools,
    registerUtilityTools,
  ],
});
