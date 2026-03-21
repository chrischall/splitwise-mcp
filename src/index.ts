#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { SplitwiseClient } from './client.js';
import { toolDefinitions as userTools, handleTool as handleUser } from './tools/user.js';
import { toolDefinitions as groupTools, handleTool as handleGroups } from './tools/groups.js';
import { toolDefinitions as friendTools, handleTool as handleFriends } from './tools/friends.js';
import { toolDefinitions as expenseTools, handleTool as handleExpenses } from './tools/expenses.js';
import { toolDefinitions as utilityTools, handleTool as handleUtilities } from './tools/utilities.js';

const client = new SplitwiseClient();

const allTools = [
  ...userTools,
  ...groupTools,
  ...friendTools,
  ...expenseTools,
  ...utilityTools,
];

const handlers: Record<string, (name: string, args: Record<string, unknown>) => Promise<CallToolResult>> = {};

for (const tool of userTools) handlers[tool.name] = (n, a) => handleUser(n, a, client);
for (const tool of groupTools) handlers[tool.name] = (n, a) => handleGroups(n, a, client);
for (const tool of friendTools) handlers[tool.name] = (n, a) => handleFriends(n, a, client);
for (const tool of expenseTools) handlers[tool.name] = (n, a) => handleExpenses(n, a, client);
for (const tool of utilityTools) handlers[tool.name] = (n, a) => handleUtilities(n, a, client);

const server = new Server(
  { name: 'splitwise-mcp', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await handler(name, args as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

console.error('[splitwise-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
