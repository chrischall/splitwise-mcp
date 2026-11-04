import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import { registerGroupTools } from '../../src/tools/groups.js';
import { registerFriendTools } from '../../src/tools/friends.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { registerReceiptTools } from '../../src/tools/receipts.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { registerUploadTools } from '../../src/tools/uploads.js';
import { registerBatchTools } from '../../src/tools/batch.js';
import { createTestHarness } from '../helpers.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees. Splitwise is in the `money` group.
 */

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  sw_get_current_user: 'lookup',
  sw_get_user: 'lookup',
  sw_update_user: 'change',
  sw_list_groups: 'lookup',
  sw_get_group: 'lookup',
  sw_create_group: 'change',
  sw_add_user_to_group: 'change',
  sw_remove_user_from_group: 'change',
  sw_delete_group: 'change',
  sw_undelete_group: 'change',
  sw_list_friends: 'whats-due',
  sw_create_friend: 'change',
  sw_delete_friend: 'change',
  sw_list_expenses: 'lookup',
  sw_get_expense: 'lookup',
  sw_create_expense: 'change',
  sw_update_expense: 'change',
  sw_attach_receipt: 'change',
  sw_delete_expense: 'change',
  sw_undelete_expense: 'change',
  sw_get_receipt: 'other',
  sw_get_upload_url: 'other',
  sw_get_notifications: 'whats-new',
  sw_get_categories: 'lookup',
  sw_get_currencies: 'lookup',
  sw_get_comments: 'lookup',
  sw_create_comment: 'send',
  sw_delete_comment: 'change',
  sw_confirm: 'other',
  sw_batch: 'change',
};

const mockRequest = vi.spyOn(client, 'request').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let tools: Listed[];

beforeAll(async () => {
  harness = await createTestHarness((server) => {
    registerUserTools(server, client);
    registerHealthcheckTools(server, client);
    registerGroupTools(server, client);
    registerFriendTools(server, client);
    registerExpenseTools(server, client);
    registerReceiptTools(server, client);
    registerUploadTools(server, client);
    registerUtilityTools(server, client);
    registerBatchTools(server, client);
  });
  tools = (await harness.client.listTools()).tools as Listed[];
});

beforeEach(() => mockRequest.mockClear());
afterAll(async () => { if (harness) await harness.close(); });

const tool = (name: string) => tools.find((t) => t.name === name)!;
const mint = (name: string) => tool(name)._meta?.mint as Record<string, unknown>;
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe('_meta.mint on every served tool', () => {
  it('names every served tool but the healthcheck, so a new tool cannot skip the decision', () => {
    const served = tools.map((t) => t.name).filter((n) => n !== 'sw_healthcheck');
    expect(served.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain money and intent %s', (name, intent) => {
    expect(mint(name), name).toBeDefined();
    expect(mint(name).domain).toBe('money');
    expect(mint(name).intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const t of tools) {
      if (t.name === 'sw_healthcheck') continue; // registered by mcp-utils, which takes no _meta
      const m = t._meta!.mint!;
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) expect(m.canonical, t.name).toBe(true);
      if ('subject' in m) expect(t.inputSchema.properties ?? {}, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as { start: string; end: string };
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(t.inputSchema.properties ?? {}, t.name).toHaveProperty(when.start);
        expect(t.inputSchema.properties ?? {}, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks exactly two reads canonical — balances for whats-due, activity for whats-new — at most one per intent', () => {
    const canonical = tools
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical.sort()).toEqual([
      ['sw_get_notifications', 'whats-new'],
      ['sw_list_friends', 'whats-due'],
    ]);
    for (const [name, intent] of canonical) {
      expect(tool(name as string).annotations?.readOnlyHint, name as string).toBe(true);
      expect(CANONICAL_INTENTS).toContain(intent);
    }
  });

  it('a canonical read offers view: brief, and names no subject (one account per key, nothing to list)', () => {
    for (const name of ['sw_list_friends', 'sw_get_notifications']) {
      expect(tool(name).inputSchema.properties?.view?.enum, name).toContain('brief');
      expect(mint(name), name).not.toHaveProperty('subject');
      expect(mint(name), name).not.toHaveProperty('when');
    }
  });
});

/** The brief view's answer: the untrusted envelope, its lines in `data`. */
function brief(raw: string): { untrusted_content: boolean; note: string; data: string[] } {
  const body = JSON.parse(raw);
  expect(body.untrusted_content).toBe(true);
  expect(typeof body.note).toBe('string');
  expect(Array.isArray(body.data)).toBe(true);
  for (const line of body.data) expect(line.length).toBeLessThanOrEqual(120);
  return body;
}

describe('sw_list_friends view: brief (whats-due)', () => {
  it('answers one line per outstanding balance, inside the untrusted envelope, naming who owes whom', async () => {
    mockRequest.mockResolvedValue({
      friends: [
        { id: 1, first_name: 'Ada', last_name: 'L', balance: [{ currency_code: 'USD', amount: '12.5' }] },
        { id: 2, first_name: 'Bo', last_name: null, balance: [{ currency_code: 'EUR', amount: '-3.00' }, { currency_code: 'USD', amount: '7' }] },
        { id: 3, first_name: 'Cy', balance: [] },
        { id: 4, first_name: 'Di', balance: [{ currency_code: 'USD', amount: '0.0' }] },
      ],
    });
    const body = brief(text(await harness.callTool('sw_list_friends', { view: 'brief' })));
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_friends');
    expect(body.note).toMatch(/Splitwise/);
    expect(body.data).toEqual([
      'Ada L — no date — owes you USD 12.50',
      'Bo — no date — you owe EUR 3.00; owes you USD 7.00',
      '-- 2 settled up',
    ]);
  });

  it('answers "-- none" when nothing is owed either way', async () => {
    mockRequest.mockResolvedValue({ friends: [] });
    expect(brief(text(await harness.callTool('sw_list_friends', { view: 'brief' }))).data).toEqual(['-- none']);
  });

  it('truncates a long name so the line stays within 120 characters', async () => {
    mockRequest.mockResolvedValue({ friends: [{ id: 5, first_name: 'X'.repeat(200), balance: [{ currency_code: 'USD', amount: '1' }] }] });
    const [line] = brief(text(await harness.callTool('sw_list_friends', { view: 'brief' }))).data;
    expect(line.length).toBe(120);
    expect(line.endsWith('— no date — owes you USD 1.00')).toBe(true);
  });

  it('escapes a name that starts with "-- " or "\\" with one leading backslash, so it never reads as a note', async () => {
    mockRequest.mockResolvedValue({
      friends: [
        { id: 8, first_name: '-- none', balance: [{ currency_code: 'USD', amount: '2' }] },
        { id: 9, first_name: '\\Eve', balance: [{ currency_code: 'USD', amount: '-1' }] },
      ],
    });
    expect(brief(text(await harness.callTool('sw_list_friends', { view: 'brief' }))).data).toEqual([
      '\\-- none — no date — owes you USD 2.00',
      '\\\\Eve — no date — you owe USD 1.00',
    ]);
  });

  it('cuts the WHOLE line to 120 chars, title first, when balances in many currencies overflow it', async () => {
    const codes = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK'];
    mockRequest.mockResolvedValue({
      friends: [{ id: 10, first_name: 'Morgan', last_name: 'Longname', balance: codes.map((c) => ({ currency_code: c, amount: '123.45' })) }],
    });
    const [line] = brief(text(await harness.callTool('sw_list_friends', { view: 'brief' }))).data;
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('Morgan Longname — no date — owes you USD 123.45')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('reports an unreadable answer as an -- error note rather than an empty list', async () => {
    mockRequest.mockResolvedValue({ unexpected: true });
    const body = brief(text(await harness.callTool('sw_list_friends', { view: 'brief' })));
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatch(/^-- error: /);
  });

  it('leaves the compact default unchanged', async () => {
    mockRequest.mockResolvedValue({ friends: [{ id: 7, first_name: 'Pat' }] });
    const body = JSON.parse(text(await harness.callTool('sw_list_friends')));
    expect(body.friends[0]).toMatchObject({ id: 7, name: 'Pat' });
  });
});

describe('sw_get_notifications view: brief (whats-new)', () => {
  it('answers one line per notification — text, date, kind — inside the untrusted envelope', async () => {
    mockRequest.mockResolvedValue({
      notifications: [
        { id: 1, type: 0, created_at: '2026-11-01T10:00:00Z', content: '<strong>Ada</strong> added &ldquo;Groceries&rdquo; in <strong>House</strong>.' },
        { id: 2, type: 3, created_at: '2026-10-30T09:00:00Z', content: '<strong>Bo</strong> commented on &quot;Rent&quot; &amp; it&#39;s &#x2014; more' },
        { id: 3, type: 99, created_at: null, content: '' },
      ],
    });
    const body = brief(text(await harness.callTool('sw_get_notifications', { view: 'brief' })));
    expect(mockRequest).toHaveBeenCalledWith('GET', '/get_notifications');
    expect(body.data).toEqual([
      'Ada added “Groceries” in House. — 2026-11-01 — expense added',
      'Bo commented on "Rent" & it\'s — more — 2026-10-30 — comment added',
      '(no text) — no date — activity',
    ]);
  });

  it('answers "-- none" for no activity', async () => {
    mockRequest.mockResolvedValue({ notifications: [] });
    expect(brief(text(await harness.callTool('sw_get_notifications', { view: 'brief' }))).data).toEqual(['-- none']);
  });

  it('caps a long list at 50 lines and says how many were shown', async () => {
    mockRequest.mockResolvedValue({
      notifications: Array.from({ length: 70 }, (_, i) => ({ id: i, type: 1, created_at: '2026-11-01T00:00:00Z', content: `n${i}` })),
    });
    const { data } = brief(text(await harness.callTool('sw_get_notifications', { view: 'brief' })));
    expect(data).toHaveLength(51);
    expect(data[49]).toBe('n49 — 2026-11-01 — expense updated');
    expect(data[50]).toBe('-- 50 of 70 shown');
  });

  it('escapes notification text that starts with "-- " with one leading backslash', async () => {
    mockRequest.mockResolvedValue({ notifications: [{ id: 1, type: 0, created_at: '2026-11-01T00:00:00Z', content: '-- 1 of 1 shown' }] });
    const { data } = brief(text(await harness.callTool('sw_get_notifications', { view: 'brief' })));
    expect(data).toEqual(['\\-- 1 of 1 shown — 2026-11-01 — expense added']);
  });

  it('reports an unreadable answer as an -- error note', async () => {
    mockRequest.mockResolvedValue('nope');
    const { data } = brief(text(await harness.callTool('sw_get_notifications', { view: 'brief' })));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatch(/^-- error: /);
  });
});
