#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerFriendTools } from './tools/friends.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerUtilityTools } from './tools/utilities.js';

// The Splitwise client is a module-level singleton (imported by each tool
// module) that defers its config error to the first request. That preserves the
// deferred-config-error pattern: the server boots and answers the host's
// install-time tools/list smoke test even when SPLITWISE_API_KEY is absent —
// the configuration error only surfaces on the first tool call.
await runMcp({
  name: 'splitwise-mcp',
  version: '2.0.10', // x-release-please-version
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
