// Re-export the shared in-memory test harness from `@chrischall/mcp-utils/test`.
// Every MCP in the fleet defined a byte-identical `createTestHarness`; this now
// lives in one place. Kept as a local re-export so existing test imports
// (`../helpers.js`) continue to resolve unchanged.
export { createTestHarness } from '@chrischall/mcp-utils/test';
