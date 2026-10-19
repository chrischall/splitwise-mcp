import { createHash } from 'crypto';
import { buildQueryString } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { compactExpense, nameOf, rowExpense } from '../project.js';

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : undefined;

/** Splitwise's own page cap; the scan reads this many per request. */
export const UPSTREAM_PAGE = 200;
/** Records one call may read before it hands back a cursor instead. */
export const SCAN_BUDGET = 1000;
/** Matched rows that may have their comments inlined in one call. */
export const MAX_COMMENT_ROWS = 25;

/** What Splitwise filters itself — passed through on every upstream request. */
export interface UpstreamQuery {
  group_id?: number;
  friend_id?: number;
  dated_after?: string;
  dated_before?: string;
  updated_after?: string;
  updated_before?: string;
}

/** What Splitwise cannot filter, applied here as the pages stream past. */
export interface LocalFilters {
  description_contains?: string;
  include_deleted?: boolean | 'only';
  created_by?: number | string;
  min_cost?: number;
  max_cost?: number;
  category?: number | string;
}

export function hasLocalFilters(f: LocalFilters): boolean {
  return (
    f.description_contains !== undefined ||
    (f.include_deleted !== undefined && f.include_deleted !== true) ||
    f.created_by !== undefined ||
    f.min_cost !== undefined ||
    f.max_cost !== undefined ||
    f.category !== undefined
  );
}

export function matches(raw: unknown, f: LocalFilters): boolean {
  const e = asDict(raw) ?? {};
  const deleted = Boolean(e.deleted_at);
  if (f.include_deleted === false && deleted) return false;
  if (f.include_deleted === 'only' && !deleted) return false;
  if (f.description_contains !== undefined) {
    const description = typeof e.description === 'string' ? e.description.toLowerCase() : '';
    if (!description.includes(f.description_contains.toLowerCase())) return false;
  }
  if (f.created_by !== undefined) {
    const creator = asDict(e.created_by);
    if (typeof f.created_by === 'number') {
      if (creator?.id !== f.created_by) return false;
    } else {
      const want = f.created_by.trim().toLowerCase();
      const name = (nameOf(creator) ?? '').toLowerCase();
      const email = typeof creator?.email === 'string' ? creator.email.toLowerCase() : '';
      if (!name.includes(want) && email !== want) return false;
    }
  }
  const cost = Number(e.cost);
  if (f.min_cost !== undefined && !(cost >= f.min_cost)) return false;
  if (f.max_cost !== undefined && !(cost <= f.max_cost)) return false;
  if (f.category !== undefined) {
    const category = asDict(e.category);
    if (typeof f.category === 'number') {
      if (category?.id !== f.category) return false;
    } else if (String(category?.name ?? '').toLowerCase() !== f.category.trim().toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * An opaque resume point: the upstream offset to continue from, plus a hash
 * of the query it belongs to, so a cursor from one query is refused by
 * another instead of silently skipping rows of it.
 */
function queryHash(q: UpstreamQuery, f: LocalFilters): string {
  return createHash('sha256').update(JSON.stringify([q, f])).digest('base64url').slice(0, 16);
}

export function encodeCursor(offset: number, q: UpstreamQuery, f: LocalFilters): string {
  return Buffer.from(JSON.stringify({ o: offset, q: queryHash(q, f) })).toString('base64url');
}

export function decodeCursor(cursor: string, q: UpstreamQuery, f: LocalFilters): number {
  let parsed: { o?: unknown; q?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new Error('cursor is not one this tool issued');
  }
  if (typeof parsed.o !== 'number' || !Number.isInteger(parsed.o) || parsed.o < 0) {
    throw new Error('cursor is not one this tool issued');
  }
  if (parsed.q !== queryHash(q, f)) {
    throw new Error('cursor belongs to a different query — pass the same filters it was issued with, or drop it to start over');
  }
  return parsed.o;
}

export interface ScanResult {
  expenses: unknown[];
  /** Where the next call resumes, when there may be more. */
  nextOffset?: number;
  scanned: number;
}

/**
 * Page through Splitwise 200 at a time from `start`, keeping the records that
 * pass `filters`, until `want` have matched, the history ends, or
 * {@link SCAN_BUDGET} records have been read. Resumes exactly after the last
 * record examined, so paging never skips or repeats a match.
 */
export async function scanExpenses(
  client: SplitwiseClient,
  q: UpstreamQuery,
  filters: LocalFilters,
  start: number,
  want: number,
): Promise<ScanResult> {
  const found: unknown[] = [];
  let offset = start;
  let scanned = 0;
  while (scanned < SCAN_BUDGET) {
    const path = `/get_expenses${buildQueryString({ ...q, limit: UPSTREAM_PAGE, offset })}`;
    const data = await client.request<unknown>('GET', path);
    const page = asDict(data)?.expenses;
    if (!Array.isArray(page)) throw new Error('Splitwise returned no expenses[] array');
    for (let i = 0; i < page.length; i++) {
      scanned++;
      if (matches(page[i], filters)) found.push(page[i]);
      if (found.length === want) {
        // More may follow even when this was the page's last record — unless
        // the page was short, which means the history ended here.
        const exhausted = i === page.length - 1 && page.length < UPSTREAM_PAGE;
        return { expenses: found, scanned, ...(exhausted ? {} : { nextOffset: offset + i + 1 }) };
      }
    }
    offset += page.length;
    if (page.length < UPSTREAM_PAGE) return { expenses: found, scanned };
  }
  return { expenses: found, scanned, nextOffset: offset };
}

/** One comment, as a reconciliation reads it: who said what, and when. */
function compactComment(raw: unknown): Dict {
  const c = asDict(raw) ?? {};
  const out: Dict = {
    id: c.id,
    author: nameOf(asDict(c.user)),
    content: c.content,
    comment_type: c.comment_type,
    created_at: c.created_at,
  };
  if (c.deleted_at) out.deleted_at = c.deleted_at;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/**
 * Inline each matched row's comments — the reason an entry was deleted is
 * usually written there. Only rows that HAVE comments are fetched, and only the
 * first {@link MAX_COMMENT_ROWS} of them, one request each.
 */
export async function attachComments(client: SplitwiseClient, raws: unknown[], rows: Dict[]): Promise<{ truncated: boolean }> {
  let fetched = 0;
  let truncated = false;
  for (let i = 0; i < raws.length; i++) {
    const e = asDict(raws[i]);
    if (!e || !(Number(e.comments_count) > 0)) continue;
    if (fetched === MAX_COMMENT_ROWS) {
      truncated = true;
      break;
    }
    fetched++;
    const data = await client.request<unknown>('GET', `/get_comments${buildQueryString({ expense_id: e.id as number })}`);
    const comments = asDict(data)?.comments;
    rows[i]!.comments = Array.isArray(comments) ? comments.map(compactComment) : [];
  }
  return { truncated };
}

export type ListView = 'compact' | 'full' | 'rows';

/** One record on the requested rung; `full` is Splitwise's record untouched. */
export function projectForList(view: ListView, raw: unknown): Dict {
  if (view === 'rows') return rowExpense(raw);
  if (view === 'compact') return compactExpense(raw);
  return (asDict(raw) ?? {}) as Dict;
}

