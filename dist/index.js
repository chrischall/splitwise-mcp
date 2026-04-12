#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SplitwiseClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerFriendTools } from './tools/friends.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerUtilityTools } from './tools/utilities.js';
const client = new SplitwiseClient();
const server = new McpServer({ name: 'splitwise-mcp', version: '2.0.2' });
registerUserTools(server, client);
registerGroupTools(server, client);
registerFriendTools(server, client);
registerExpenseTools(server, client);
registerUtilityTools(server, client);
console.error('[splitwise-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.');
const transport = new StdioServerTransport();
await server.connect(transport);
