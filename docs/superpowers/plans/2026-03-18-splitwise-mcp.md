# Splitwise MCP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server that exposes 15 Splitwise API tools to Claude for natural-language expense and group management.

**Architecture:** A thin `SplitwiseClient` class wraps fetch with Bearer-token auth and 429 retry. Tool logic is split across 5 domain files (`user`, `groups`, `friends`, `expenses`, `utilities`), each exporting `toolDefinitions` and `handleTool`. `index.ts` wires them into an MCP server over stdio.

**Tech Stack:** TypeScript 5.9, `@modelcontextprotocol/sdk` 1.27, `dotenv` 17, `vitest` 4, Node 20+

**Spec:** `docs/superpowers/specs/2026-03-18-splitwise-mcp-design.md`

---

## Chunk 1: Project Scaffold + Client

### Task 1: Initialize project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "splitwise-mcp",
  "version": "1.0.0",
  "description": "Splitwise MCP server for Claude — developed and maintained by AI (Claude Sonnet 4.6)",
  "author": "Claude Sonnet 4.6 (AI) <https://www.anthropic.com/claude>",
  "type": "module",
  "bin": {
    "splitwise-mcp": "dist/index.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "dotenv": "^17.3.1"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "@vitest/coverage-v8": "^4.1.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```
SPLITWISE_API_KEY=your_api_key_here
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
.env
coverage/
```

- [ ] **Step 6: Create `src/` and `tests/tools/` directories, install deps**

```bash
mkdir -p src/tools tests/tools
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "chore: initialize splitwise-mcp project"
```

---

### Task 2: SplitwiseClient

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

- [ ] **Step 1: Write failing tests for SplitwiseClient**

Create `tests/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the client by controlling what fetch returns.
// The client module reads env at construction time, so set the env var before importing.
process.env.SPLITWISE_API_KEY = 'test-key';

const { SplitwiseClient } = await import('../src/client.js');

describe('SplitwiseClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws at construction if SPLITWISE_API_KEY is not set', async () => {
    const { SplitwiseClient: Client } = await import('../src/client.js?no-key');
    // We can't easily re-import without the key in vitest ESM. Instead test the guard directly.
    // This is covered by the guard check in the constructor.
    expect(() => {
      const orig = process.env.SPLITWISE_API_KEY;
      process.env.SPLITWISE_API_KEY = '';
      try {
        new Client();
      } finally {
        process.env.SPLITWISE_API_KEY = orig;
      }
    }).toThrow('SPLITWISE_API_KEY environment variable is required');
  });

  it('sends Authorization header with Bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('GET', '/get_current_user');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://secure.splitwise.com/api/v3.0/get_current_user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );
  });

  it('throws on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'SPLITWISE_API_KEY is invalid or missing'
    );
  });

  it('retries once on 429 then succeeds', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.request('GET', '/get_current_user');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('throws after two 429 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }));
    vi.useFakeTimers();

    const client = new SplitwiseClient();
    const promise = client.request('GET', '/get_current_user');
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toThrow('Rate limited by Splitwise API');
    vi.useRealTimers();
  });

  it('throws on other non-2xx errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    const client = new SplitwiseClient();
    await expect(client.request('GET', '/get_current_user')).rejects.toThrow(
      'Splitwise API error: 500 Internal Server Error for GET /get_current_user'
    );
  });

  it('sends POST body as JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ expense: {} }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new SplitwiseClient();
    await client.request('POST', '/create_expense', { description: 'Dinner', cost: '50.00' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ description: 'Dinner', cost: '50.00' }),
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/client.test.ts
```

Expected: FAIL — `src/client.ts` does not exist.

- [ ] **Step 3: Implement `src/client.ts`**

```typescript
import { config as loadDotenv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(__dirname, '..', '.env'), override: false, quiet: true });

const BASE_URL = 'https://secure.splitwise.com/api/v3.0';

export class SplitwiseClient {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.SPLITWISE_API_KEY;
    if (!key) throw new Error('SPLITWISE_API_KEY environment variable is required');
    this.apiKey = key;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.doRequest<T>(method, path, body, false);
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401) {
      throw new Error('SPLITWISE_API_KEY is invalid or missing');
    }

    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.doRequest<T>(method, path, body, true);
      }
      throw new Error('Rate limited by Splitwise API');
    }

    if (!response.ok) {
      throw new Error(
        `Splitwise API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    return response.json() as Promise<T>;
  }
}

```

Note: The `SplitwiseClient` class is exported but no singleton is created here. The singleton `client` lives in `src/index.ts` only, so tool files under test can import the class directly and construct it with a mock — no accidental construction on import.

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/client.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: add SplitwiseClient with auth and retry"
```

---

## Chunk 2: User, Groups, Friends Tools

### Task 3: User tool

**Files:**
- Create: `src/tools/user.ts`
- Create: `tests/tools/user.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/tools/user.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/user.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = {
  request: vi.fn(),
} as unknown as SplitwiseClient;

describe('user tools', () => {
  afterEach(() => vi.clearAllMocks());

  describe('toolDefinitions', () => {
    it('exports sw_get_current_user', () => {
      expect(toolDefinitions.some((t) => t.name === 'sw_get_current_user')).toBe(true);
    });
  });

  describe('sw_get_current_user', () => {
    it('calls GET /get_current_user and returns JSON', async () => {
      const userData = { user: { id: 123, first_name: 'Chris' } };
      mockClient.request = vi.fn().mockResolvedValue(userData);

      const result = await handleTool('sw_get_current_user', {}, mockClient);

      expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_current_user');
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('"id": 123');
    });

    it('throws on unknown tool name', async () => {
      await expect(handleTool('sw_unknown', {}, mockClient)).rejects.toThrow('Unknown tool: sw_unknown');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/tools/user.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/user.ts`**

```typescript
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_get_current_user',
    description: 'Get the authenticated Splitwise user\'s profile (id, first_name, last_name, email). Use the returned id when building custom expense splits.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // TODO: sw_get_user — GET /get_user/{id} — get another user's profile by id
  // TODO: sw_update_user — POST /update_user/{id} — update current user's profile (first_name, last_name, email, password, locale, default_currency)
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_get_current_user': {
      const data = await client.request('GET', '/get_current_user');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/tools/user.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/user.ts tests/tools/user.test.ts
git commit -m "feat: add sw_get_current_user tool"
```

---

### Task 4: Groups tools

**Files:**
- Create: `src/tools/groups.ts`
- Create: `tests/tools/groups.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/groups.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/groups.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('groups toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 5 group tools', () => {
    expect(names).toContain('sw_list_groups');
    expect(names).toContain('sw_get_group');
    expect(names).toContain('sw_create_group');
    expect(names).toContain('sw_add_user_to_group');
    expect(names).toContain('sw_remove_user_from_group');
  });
});

describe('sw_list_groups', () => {
  it('calls GET /get_groups', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ groups: [] });
    const result = await handleTool('sw_list_groups', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_groups');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_get_group', () => {
  it('calls GET /get_group/42', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: { id: 42 } });
    const result = await handleTool('sw_get_group', { id: 42 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_group/42');
    expect(result.content[0].text).toContain('"id": 42');
  });
});

describe('sw_create_group', () => {
  it('calls POST /create_group with name', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: { id: 1, name: 'Vacation' } });
    await handleTool('sw_create_group', { name: 'Vacation' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_group', { name: 'Vacation' });
  });

  it('includes optional group_type when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ group: {} });
    await handleTool('sw_create_group', { name: 'Trip', group_type: 'trip' }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_group', {
      name: 'Trip',
      group_type: 'trip',
    });
  });
});

describe('sw_add_user_to_group', () => {
  it('sends {group_id, user_id} when user_id is provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_add_user_to_group', { group_id: 10, user_id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/add_user_to_group', {
      group_id: 10,
      user_id: 99,
    });
  });

  it('sends {group_id, first_name, last_name, email} when user_id is absent', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_add_user_to_group', {
      group_id: 10,
      first_name: 'Meredith',
      last_name: 'Grey',
      email: 'meredith@example.com',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/add_user_to_group', {
      group_id: 10,
      first_name: 'Meredith',
      last_name: 'Grey',
      email: 'meredith@example.com',
    });
  });

  it('throws if user_id absent and name/email fields missing', async () => {
    await expect(
      handleTool('sw_add_user_to_group', { group_id: 10, first_name: 'Meredith' }, mockClient)
    ).rejects.toThrow('first_name, last_name, and email are required when user_id is not provided');
  });
});

describe('sw_remove_user_from_group', () => {
  it('calls POST /remove_user_from_group with group_id and user_id', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    await handleTool('sw_remove_user_from_group', { group_id: 10, user_id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/remove_user_from_group', {
      group_id: 10,
      user_id: 99,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/tools/groups.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/groups.ts`**

```typescript
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_groups',
    description: 'List all Splitwise groups the current user belongs to. Returns id, name, and members for each group. Use this to resolve a group name to its id.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_group',
    description: 'Get details of a single Splitwise group including all members and balances.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Group ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sw_create_group',
    description: 'Create a new Splitwise group.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        group_type: {
          type: 'string',
          enum: ['apartment', 'house', 'trip', 'other'],
          description: 'Type of group',
        },
        simplify_by_default: { type: 'boolean', description: 'Whether to simplify debts by default' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sw_add_user_to_group',
    description: 'Add a user to a Splitwise group. Provide user_id (preferred, use sw_list_friends to resolve a name) or first_name + last_name + email to invite by email.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group ID' },
        user_id: { type: 'integer', description: 'User ID (preferred)' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'sw_remove_user_from_group',
    description: 'Remove a user from a Splitwise group.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group ID' },
        user_id: { type: 'integer', description: 'User ID to remove' },
      },
      required: ['group_id', 'user_id'],
    },
  },
  // TODO: sw_delete_group — POST /delete_group/{id} — soft-delete a group
  // TODO: sw_undelete_group — POST /undelete_group/{id} — restore a soft-deleted group
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_groups': {
      const data = await client.request('GET', '/get_groups');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_group': {
      const { id } = args as { id: number };
      const data = await client.request('GET', `/get_group/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_create_group': {
      const { name, group_type, simplify_by_default } = args as {
        name: string;
        group_type?: string;
        simplify_by_default?: boolean;
      };
      const body: Record<string, unknown> = { name };
      if (group_type !== undefined) body.group_type = group_type;
      if (simplify_by_default !== undefined) body.simplify_by_default = simplify_by_default;
      const data = await client.request('POST', '/create_group', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_add_user_to_group': {
      const { group_id, user_id, first_name, last_name, email } = args as {
        group_id: number;
        user_id?: number;
        first_name?: string;
        last_name?: string;
        email?: string;
      };
      let body: Record<string, unknown>;
      if (user_id !== undefined) {
        body = { group_id, user_id };
      } else {
        if (!first_name || !last_name || !email) {
          throw new Error('first_name, last_name, and email are required when user_id is not provided');
        }
        body = { group_id, first_name, last_name, email };
      }
      const data = await client.request('POST', '/add_user_to_group', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_remove_user_from_group': {
      const { group_id, user_id } = args as { group_id: number; user_id: number };
      const data = await client.request('POST', '/remove_user_from_group', { group_id, user_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/tools/groups.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/groups.ts tests/tools/groups.test.ts
git commit -m "feat: add groups tools (list, get, create, add/remove user)"
```

---

### Task 5: Friends tool

**Files:**
- Create: `src/tools/friends.ts`
- Create: `tests/tools/friends.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/tools/friends.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/friends.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('sw_list_friends', () => {
  it('is exported in toolDefinitions', () => {
    expect(toolDefinitions.some((t) => t.name === 'sw_list_friends')).toBe(true);
  });

  it('calls GET /get_friends and returns JSON', async () => {
    const friendsData = { friends: [{ id: 7, first_name: 'Meredith' }] };
    mockClient.request = vi.fn().mockResolvedValue(friendsData);

    const result = await handleTool('sw_list_friends', {}, mockClient);

    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_friends');
    expect(result.content[0].text).toContain('"first_name": "Meredith"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/tools/friends.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/friends.ts`**

```typescript
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_friends',
    description: 'List all Splitwise friends with their id, first_name, last_name, and email. Use this to resolve a friend\'s name to a user_id before adding them to a group or building a custom expense split.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // TODO: sw_create_friend — POST /create_friend — add a friend by email (user_email, user_first_name, user_last_name)
  // TODO: sw_delete_friend — POST /delete_friend/{id} — remove a friendship
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_friends': {
      const data = await client.request('GET', '/get_friends');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/tools/friends.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/friends.ts tests/tools/friends.test.ts
git commit -m "feat: add sw_list_friends tool"
```

---

## Chunk 3: Expenses, Utilities, and Server Wiring

### Task 6: Expenses tools

**Files:**
- Create: `src/tools/expenses.ts`
- Create: `tests/tools/expenses.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/expenses.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool, flattenUsers } from '../../src/tools/expenses.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 5 expense tools', () => {
    expect(names).toContain('sw_list_expenses');
    expect(names).toContain('sw_get_expense');
    expect(names).toContain('sw_create_expense');
    expect(names).toContain('sw_update_expense');
    expect(names).toContain('sw_delete_expense');
  });
});

describe('flattenUsers', () => {
  it('flattens users array to Splitwise flat-param format', () => {
    const result = flattenUsers([
      { user_id: 10, paid_share: '50.00', owed_share: '25.00' },
      { user_id: 20, paid_share: '0.00', owed_share: '25.00' },
    ]);
    expect(result).toEqual({
      'users__0__user_id': 10,
      'users__0__paid_share': '50.00',
      'users__0__owed_share': '25.00',
      'users__1__user_id': 20,
      'users__1__paid_share': '0.00',
      'users__1__owed_share': '25.00',
    });
  });
});

describe('sw_list_expenses', () => {
  it('calls GET /get_expenses with no params when none provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [] });
    await handleTool('sw_list_expenses', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expenses');
  });

  it('appends query params when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [] });
    await handleTool('sw_list_expenses', { group_id: 5, limit: 10 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expenses?group_id=5&limit=10');
  });
});

describe('sw_get_expense', () => {
  it('calls GET /get_expense/{id}', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expense: { id: 99 } });
    await handleTool('sw_get_expense', { id: 99 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_expense/99');
  });
});

describe('sw_create_expense', () => {
  it('sends equal-split body with split_equally:true', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
    });
  });

  it('flattens users array for custom split', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      users: [
        { user_id: 10, paid_share: '50.00', owed_share: '25.00' },
        { user_id: 20, paid_share: '0.00', owed_share: '25.00' },
      ],
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      'users__0__user_id': 10,
      'users__1__user_id': 20,
    }));
  });

  it('throws if both split_equally and users are provided', async () => {
    await expect(
      handleTool('sw_create_expense', {
        group_id: 1, description: 'Dinner', cost: '50.00',
        split_equally: true,
        users: [{ user_id: 10, paid_share: '50.00', owed_share: '50.00' }],
      }, mockClient)
    ).rejects.toThrow('Provide either split_equally or users, not both');
  });

  it('includes optional fields when provided', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expenses: [{}] });
    await handleTool('sw_create_expense', {
      group_id: 1,
      description: 'Dinner',
      cost: '50.00',
      split_equally: true,
      currency_code: 'EUR',
      date: '2026-03-18T00:00:00Z',
      category_id: 15,
      details: 'Team dinner',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/create_expense', expect.objectContaining({
      currency_code: 'EUR',
      category_id: 15,
      details: 'Team dinner',
    }));
  });
});

describe('sw_update_expense', () => {
  it('calls POST /update_expense/{id} with provided fields only', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ expense: {} });
    await handleTool('sw_update_expense', {
      expense_id: 42,
      description: 'Updated dinner',
      cost: '60.00',
    }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/update_expense/42', {
      description: 'Updated dinner',
      cost: '60.00',
    });
  });

  it('throws if both split_equally and users provided in update', async () => {
    await expect(
      handleTool('sw_update_expense', {
        expense_id: 42,
        split_equally: true,
        users: [{ user_id: 1, paid_share: '50.00', owed_share: '50.00' }],
      }, mockClient)
    ).rejects.toThrow('Provide either split_equally or users, not both');
  });
});

describe('sw_delete_expense', () => {
  it('calls POST /delete_expense/{id}', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ success: true });
    const result = await handleTool('sw_delete_expense', { id: 42 }, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('POST', '/delete_expense/42');
    expect(result.content[0].text).toContain('true');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/tools/expenses.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/expenses.ts`**

```typescript
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

interface UserShare {
  user_id: number;
  paid_share: string;
  owed_share: string;
}

/** Flattens a users array into Splitwise's flat-param JSON format. */
export function flattenUsers(users: UserShare[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  users.forEach((u, i) => {
    flat[`users__${i}__user_id`] = u.user_id;
    flat[`users__${i}__paid_share`] = u.paid_share;
    flat[`users__${i}__owed_share`] = u.owed_share;
  });
  return flat;
}

function buildExpenseBody(args: Record<string, unknown>): Record<string, unknown> {
  const { split_equally, users, expense_id: _id, ...rest } = args as {
    split_equally?: boolean;
    users?: UserShare[];
    expense_id?: number;
    [key: string]: unknown;
  };

  if (split_equally && users) {
    throw new Error('Provide either split_equally or users, not both');
  }

  const body: Record<string, unknown> = { ...rest };

  if (split_equally) {
    body.split_equally = true;
  } else if (users) {
    Object.assign(body, flattenUsers(users));
  }

  return body;
}

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_list_expenses',
    description: 'List or search Splitwise expenses. All filters are optional. Use group_id to filter by group, dated_after/dated_before for date ranges.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Only expenses in this group' },
        friend_id: { type: 'integer', description: 'Only expenses with this friend' },
        dated_after: { type: 'string', description: 'ISO 8601 date — only expenses on or after this date' },
        dated_before: { type: 'string', description: 'ISO 8601 date — only expenses on or before this date' },
        updated_after: { type: 'string', description: 'ISO 8601 datetime' },
        updated_before: { type: 'string', description: 'ISO 8601 datetime' },
        limit: { type: 'integer', description: 'Max results (API default: 20)' },
        offset: { type: 'integer', description: 'Pagination offset' },
      },
      required: [],
    },
  },
  {
    name: 'sw_get_expense',
    description: 'Get full details of a single Splitwise expense by id.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Expense ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sw_create_expense',
    description: 'Create a Splitwise expense. Use split_equally:true to split evenly among group members, or provide a users array for custom per-person splits (paid_share and owed_share as decimal strings like "25.00"). cost must be a decimal string.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Group to add expense to (use 0 for no group)' },
        description: { type: 'string', description: 'Short description of the expense' },
        cost: { type: 'string', description: 'Total cost as decimal string, e.g. "25.00"' },
        split_equally: { type: 'boolean', description: 'Split equally among group members (mutually exclusive with users)' },
        users: {
          type: 'array',
          description: 'Custom split (mutually exclusive with split_equally). Full list of participants required.',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'integer' },
              paid_share: { type: 'string', description: 'Amount this user paid, e.g. "25.00"' },
              owed_share: { type: 'string', description: 'Amount this user owes, e.g. "12.50"' },
            },
            required: ['user_id', 'paid_share', 'owed_share'],
          },
        },
        currency_code: { type: 'string', description: 'Currency code, e.g. "USD". Defaults to group/user default.' },
        date: { type: 'string', description: 'ISO 8601 datetime' },
        category_id: { type: 'integer', description: 'Category id from sw_get_categories' },
        details: { type: 'string', description: 'Notes' },
      },
      required: ['group_id', 'description', 'cost'],
    },
  },
  {
    name: 'sw_update_expense',
    description: 'Edit an existing Splitwise expense. Provide expense_id and any fields to change. For custom split updates, the full users array must be provided (the API replaces the entire split).',
    inputSchema: {
      type: 'object',
      properties: {
        expense_id: { type: 'integer', description: 'ID of the expense to update' },
        description: { type: 'string' },
        cost: { type: 'string', description: 'Decimal string, e.g. "25.00"' },
        split_equally: { type: 'boolean', description: 'Mutually exclusive with users' },
        users: {
          type: 'array',
          description: 'Full replacement split — all users must be included. Mutually exclusive with split_equally.',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'integer' },
              paid_share: { type: 'string' },
              owed_share: { type: 'string' },
            },
            required: ['user_id', 'paid_share', 'owed_share'],
          },
        },
        currency_code: { type: 'string' },
        date: { type: 'string' },
        category_id: { type: 'integer' },
        details: { type: 'string' },
      },
      required: ['expense_id'],
    },
  },
  {
    name: 'sw_delete_expense',
    description: 'Soft-delete a Splitwise expense by id. Returns {success: true} on success. Note: restoring deleted expenses requires sw_undelete_expense (not yet implemented).',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Expense ID to delete' },
      },
      required: ['id'],
    },
  },
  // TODO: sw_undelete_expense — POST /undelete_expense/{id} — restore a soft-deleted expense
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_list_expenses': {
      const params = new URLSearchParams();
      const filters = ['group_id', 'friend_id', 'dated_after', 'dated_before', 'updated_after', 'updated_before', 'limit', 'offset'];
      for (const key of filters) {
        if (args[key] !== undefined) params.append(key, String(args[key]));
      }
      const qs = params.toString();
      const data = await client.request('GET', qs ? `/get_expenses?${qs}` : '/get_expenses');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_expense': {
      const { id } = args as { id: number };
      const data = await client.request('GET', `/get_expense/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_create_expense': {
      const body = buildExpenseBody(args);
      const data = await client.request('POST', '/create_expense', body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_update_expense': {
      const { expense_id } = args as { expense_id: number };
      const body = buildExpenseBody(args);
      const data = await client.request('POST', `/update_expense/${expense_id}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_delete_expense': {
      const { id } = args as { id: number };
      const data = await client.request('POST', `/delete_expense/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/tools/expenses.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/expenses.ts tests/tools/expenses.test.ts
git commit -m "feat: add expense tools (list, get, create, update, delete)"
```

---

### Task 7: Utilities tools

**Files:**
- Create: `src/tools/utilities.ts`
- Create: `tests/tools/utilities.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/utilities.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolDefinitions, handleTool } from '../../src/tools/utilities.js';
import type { SplitwiseClient } from '../../src/client.js';

const mockClient = { request: vi.fn() } as unknown as SplitwiseClient;

afterEach(() => vi.clearAllMocks());

describe('utilities toolDefinitions', () => {
  const names = toolDefinitions.map((t) => t.name);
  it('has all 3 utility tools', () => {
    expect(names).toContain('sw_get_notifications');
    expect(names).toContain('sw_get_categories');
    expect(names).toContain('sw_get_currencies');
  });
});

describe('sw_get_notifications', () => {
  it('calls GET /get_notifications', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ notifications: [] });
    const result = await handleTool('sw_get_notifications', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_notifications');
    expect(result.isError).toBeFalsy();
  });
});

describe('sw_get_categories', () => {
  it('calls GET /get_categories', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ categories: [] });
    await handleTool('sw_get_categories', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_categories');
  });
});

describe('sw_get_currencies', () => {
  it('calls GET /get_currencies', async () => {
    mockClient.request = vi.fn().mockResolvedValue({ currencies: [] });
    await handleTool('sw_get_currencies', {}, mockClient);
    expect(mockClient.request).toHaveBeenCalledWith('GET', '/get_currencies');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/tools/utilities.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/utilities.ts`**

```typescript
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SplitwiseClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'sw_get_notifications',
    description: 'Get recent Splitwise activity notifications for the current user.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_categories',
    description: 'Get the hierarchical list of Splitwise expense categories. Use the returned id as category_id when creating expenses.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sw_get_currencies',
    description: 'Get all Splitwise-supported currency codes and units. Use the currency_code value when creating expenses in non-default currencies.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // TODO: sw_get_comments — GET /get_comments?expense_id= — get comments on an expense
  // TODO: sw_create_comment — POST /create_comment — add a comment to an expense (expense_id, content)
  // TODO: sw_delete_comment — POST /delete_comment/{id} — delete a comment
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: SplitwiseClient
): Promise<CallToolResult> {
  switch (name) {
    case 'sw_get_notifications': {
      const data = await client.request('GET', '/get_notifications');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_categories': {
      const data = await client.request('GET', '/get_categories');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'sw_get_currencies': {
      const data = await client.request('GET', '/get_currencies');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && npm test -- tests/tools/utilities.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/utilities.ts tests/tools/utilities.test.ts
git commit -m "feat: add utilities tools (notifications, categories, currencies)"
```

---

### Task 8: MCP server wiring (index.ts)

**Files:**
- Create: `src/index.ts`
- Create: `tests/index.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Verify the tool registry covers all expected tools.
// We import tool definitions directly — no need to spin up the MCP server.
import { toolDefinitions as userTools } from '../src/tools/user.js';
import { toolDefinitions as groupTools } from '../src/tools/groups.js';
import { toolDefinitions as friendTools } from '../src/tools/friends.js';
import { toolDefinitions as expenseTools } from '../src/tools/expenses.js';
import { toolDefinitions as utilityTools } from '../src/tools/utilities.js';

const allTools = [...userTools, ...groupTools, ...friendTools, ...expenseTools, ...utilityTools];
const allNames = allTools.map((t) => t.name);

describe('tool registry', () => {
  const expected = [
    'sw_get_current_user',
    'sw_list_groups', 'sw_get_group', 'sw_create_group', 'sw_add_user_to_group', 'sw_remove_user_from_group',
    'sw_list_friends',
    'sw_list_expenses', 'sw_get_expense', 'sw_create_expense', 'sw_update_expense', 'sw_delete_expense',
    'sw_get_notifications', 'sw_get_categories', 'sw_get_currencies',
  ];

  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(allNames).toContain(name);
    });
  }

  it('has exactly 15 tools', () => {
    expect(allTools).toHaveLength(15);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (all tool files exist)**

```bash
npm test -- tests/index.test.ts
```

Expected: All 16 assertions pass (15 tool name checks + 1 count check).

- [ ] **Step 3: Implement `src/index.ts`**

```typescript
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
  { name: 'splitwise-mcp', version: '1.0.0' },
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
```

- [ ] **Step 4: Build and run full test suite**

```bash
npm run build && npm test
```

Expected: All tests pass. No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: wire MCP server with all 15 tools"
```

---

### Task 9: Configure .env and verify end-to-end

**Files:**
- Create: `.env` (not committed)

- [ ] **Step 1: Create `.env` from example**

```bash
cp .env.example .env
```

Edit `.env` and set `SPLITWISE_API_KEY` to your actual API key.

- [ ] **Step 2: Build and do a smoke-test against the live API**

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

Expected: JSON response listing all 15 tools.

- [ ] **Step 3: Test a real tool call**

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sw_get_current_user","arguments":{}}}' | node dist/index.js
```

Expected: JSON response with your Splitwise user profile.

- [ ] **Step 4: Final commit and tag**

```bash
git add .env.example
git commit -m "chore: finalize project setup" --allow-empty
git tag v1.0.0
```

---

## Summary

| Task | Tools |
|------|-------|
| 1 | Project scaffold (package.json, tsconfig, vitest) |
| 2 | SplitwiseClient (auth, retry) |
| 3 | sw_get_current_user |
| 4 | sw_list_groups, sw_get_group, sw_create_group, sw_add_user_to_group, sw_remove_user_from_group |
| 5 | sw_list_friends |
| 6 | sw_list_expenses, sw_get_expense, sw_create_expense, sw_update_expense, sw_delete_expense |
| 7 | sw_get_notifications, sw_get_categories, sw_get_currencies |
| 8 | index.ts + tool registry test |
| 9 | .env setup + end-to-end smoke test |
