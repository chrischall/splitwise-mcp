// Invariant: the Claude Code plugin manifest declares its MCP config under
// `mcpServers`, the key Claude Code reads. `mcp` is an unknown field that
// Claude Code ignores (`claude plugin validate` warns "Unknown field 'mcp'");
// it only appeared to work because ./.mcp.json is the default location.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

describe('.claude-plugin/plugin.json', () => {
  it('declares the MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points `mcpServers` at a file that exists', () => {
    expect(existsSync(resolve(ROOT, plugin.mcpServers))).toBe(true);
  });
});
