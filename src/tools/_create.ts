import { buildQueryString } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { equalSplit, resolveMember, type Member, type UserShare } from './_split.js';

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : undefined;
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------- categories

interface Category {
  id: number;
  name: string;
  parent: string;
}

/** Categories barely change; one fetch per client per hour. Keyed by client: a hosted server has one per user. */
const CATEGORY_TTL_MS = 60 * 60 * 1000;
let categoryCache = new WeakMap<SplitwiseClient, { at: number; list: Promise<{ subs: Category[]; parents: Map<string, Category[]> }> }>();

/** Forget every cached category list (tests). */
export function clearCategoryCache(): void {
  categoryCache = new WeakMap();
}

async function loadCategories(client: SplitwiseClient) {
  const cached = categoryCache.get(client);
  if (cached && Date.now() - cached.at < CATEGORY_TTL_MS) {
    return cached.list;
  }
  const list = client.request<unknown>('GET', '/get_categories').then((data) => {
    const subs: Category[] = [];
    const parents = new Map<string, Category[]>();
    for (const raw of asList(asDict(data)?.categories)) {
      const parent = asDict(raw);
      if (!parent || typeof parent.name !== 'string') continue;
      const children = asList(parent.subcategories)
        .map(asDict)
        .filter((c): c is Dict => typeof c?.id === 'number' && typeof c.name === 'string')
        .map((c) => ({ id: c.id as number, name: c.name as string, parent: parent.name as string }));
      subs.push(...children);
      parents.set(parent.name.toLowerCase(), children);
    }
    return { subs, parents };
  });
  // A failed fetch must not be cached as the answer for the next hour.
  list.catch(() => categoryCache.delete(client));
  categoryCache.set(client, { at: Date.now(), list });
  return list;
}

/**
 * A category name → its id. Matches subcategory names case-insensitively
 * (an expense always takes a subcategory id; "General" is the one under
 * "Uncategorized"). A parent name is refused with its subcategories listed,
 * and an unknown name with the closest names.
 */
export async function resolveCategory(client: SplitwiseClient, name: string): Promise<Category> {
  const { subs, parents } = await loadCategories(client);
  const want = name.trim().toLowerCase();
  const exact = subs.filter((c) => c.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`category "${name}" is ambiguous: ${exact.map((c) => `${c.parent} › ${c.name} (${c.id})`).join(', ')}. Pass category_id.`);
  }
  const children = parents.get(want);
  if (children) {
    throw new Error(`category "${name}" is a parent category; pick one of its subcategories: ${children.map((c) => c.name).join(', ')}`);
  }
  const words = want.split(/\W+/).filter(Boolean);
  const close = subs
    .filter((c) => {
      const n = c.name.toLowerCase();
      return n.includes(want) || want.includes(n) || words.some((w) => w.length > 2 && n.includes(w));
    })
    .slice(0, 8)
    .map((c) => c.name);
  throw new Error(
    `No Splitwise category named "${name}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} sw_get_categories lists them all.`,
  );
}

// ---------------------------------------------------------------- similarity

const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Same thing, written slightly differently: one contains the other, or at least half the words overlap. */
export function similarDescriptions(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const tx = tokens(x);
  const ty = tokens(y);
  const shared = [...tx].filter((t) => ty.has(t)).length;
  const union = new Set([...tx, ...ty]).size;
  return union > 0 && shared / union >= 0.5;
}

// ---------------------------------------------------------------- inference

/**
 * The most common category among the group's recent expenses with a similar
 * description — "General" excluded, since it is what an unset category
 * becomes. Advisory: no match, or a failed read, infers nothing.
 */
export async function inferCategory(
  client: SplitwiseClient,
  groupId: number,
  description: string,
): Promise<{ id: number; name: string; similar_expenses: number } | undefined> {
  let recent: unknown[];
  try {
    const data = await client.request<unknown>('GET', `/get_expenses${buildQueryString({ group_id: groupId, limit: 200 })}`);
    recent = asList(asDict(data)?.expenses);
  } catch {
    return undefined;
  }
  const counts = new Map<number, { name: string; n: number }>();
  for (const raw of recent) {
    const e = asDict(raw);
    const category = asDict(e?.category);
    if (!e || typeof e.description !== 'string' || typeof category?.id !== 'number') continue;
    if (String(category.name).toLowerCase() === 'general') continue;
    if (!similarDescriptions(e.description, description)) continue;
    const entry = counts.get(category.id) ?? { name: String(category.name), n: 0 };
    entry.n++;
    counts.set(category.id, entry);
  }
  let best: { id: number; name: string; similar_expenses: number } | undefined;
  // Map keeps first-seen order and the list is newest first, so a tie goes to the most recent use.
  for (const [id, { name, n }] of counts) {
    if (!best || n > best.similar_expenses) best = { id, name, similar_expenses: n };
  }
  return best;
}

// ---------------------------------------------------------------- duplicates

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PossibleDuplicate {
  id: unknown;
  date: unknown;
  description: unknown;
  cost: unknown;
  deleted: boolean;
}

/**
 * Expenses in the group — live or deleted — with the same cost, a similar
 * description and a date within a day either side. A warning for the preview,
 * never a refusal; a failed read finds nothing rather than blocking the create.
 */
export async function findDuplicates(
  client: SplitwiseClient,
  input: { group_id: number; cost: string; description: string; date?: string },
): Promise<PossibleDuplicate[]> {
  const when = input.date ? new Date(input.date) : new Date();
  if (Number.isNaN(when.getTime())) return [];
  const qs = buildQueryString({
    group_id: input.group_id,
    dated_after: new Date(when.getTime() - DAY_MS).toISOString(),
    dated_before: new Date(when.getTime() + DAY_MS).toISOString(),
    limit: 200,
  });
  let candidates: unknown[];
  try {
    candidates = asList(asDict(await client.request<unknown>('GET', `/get_expenses${qs}`))?.expenses);
  } catch {
    return [];
  }
  const cost = Number(input.cost);
  return candidates
    .map(asDict)
    .filter((e): e is Dict => !!e && Number(e.cost) === cost && typeof e.description === 'string' && similarDescriptions(e.description, input.description))
    .map((e) => ({ id: e.id, date: e.date, description: e.description, cost: e.cost, deleted: Boolean(e.deleted_at) }));
}

// ---------------------------------------------------------------- equal split

/**
 * The users[] for `split: "equal"`: `paid_by` paid the whole cost, everyone in
 * `split_among` (default: every group member) owes an equal part. Names are
 * resolved against the group's members, which are read only when needed.
 */
export async function resolveEqualSplit(
  client: SplitwiseClient,
  input: { group_id: number; cost: string; paid_by: number | string; split_among?: Array<number | string> },
): Promise<UserShare[]> {
  const needMembers =
    input.split_among === undefined || typeof input.paid_by === 'string' || input.split_among.some((m) => typeof m === 'string');
  let members: Member[] | undefined;
  if (needMembers) {
    if (!(input.group_id > 0)) {
      throw new Error('split:"equal" outside a group needs paid_by and split_among as user ids (there are no group members to resolve names against)');
    }
    const data = await client.request<unknown>('GET', `/get_group/${input.group_id}`);
    members = asList(asDict(asDict(data)?.group)?.members)
      .map(asDict)
      .filter((m): m is Dict => typeof m?.id === 'number') as unknown as Member[];
    if (members.length === 0) throw new Error(`Could not read the members of group ${input.group_id}`);
  }
  const resolve = (who: number | string, field: string) =>
    members ? resolveMember(who, members, field) : (who as number);
  const payer = resolve(input.paid_by, 'paid_by');
  const among = input.split_among ? input.split_among.map((m) => resolve(m, 'split_among')) : members!.map((m) => m.id);
  return equalSplit(input.cost, payer, among);
}
