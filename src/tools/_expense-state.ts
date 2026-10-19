import { ApiError } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { nameOf } from '../project.js';

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : undefined;

/** The expense from a `GET /get_expense/{id}` response, or undefined when it has none. */
export async function readExpense(client: SplitwiseClient, id: number): Promise<Dict | undefined> {
  const data = await client.request<unknown>('GET', `/get_expense/${id}`);
  return asDict(asDict(data)?.expense);
}

/**
 * The few fields that say what a write actually left behind. A shared group
 * has another writer: a restore can be undone by the other member within
 * seconds, so "the request succeeded" and "the expense is live" are different
 * facts, and only this one answers the second.
 */
export function postState(expense: Dict): Dict {
  return {
    id: expense.id,
    deleted_at: expense.deleted_at ?? null,
    deleted_by: expense.deleted_at ? (nameOf(asDict(expense.deleted_by)) ?? null) : null,
    updated_at: expense.updated_at ?? null,
    updated_by: nameOf(asDict(expense.updated_by)) ?? null,
  };
}

/** "by Alison Hall at 2026-10-02T09:15:00Z", from whatever of the two Splitwise reported. */
function deletedBy(expense: Dict): string {
  const who = nameOf(asDict(expense.deleted_by)) ?? 'unknown';
  return `by ${who} at ${String(expense.deleted_at)}`;
}

export function deletedError(id: number, expense: Dict): Error {
  return new Error(
    `Splitwise expense ${id} is deleted (${deletedBy(expense)}); restore it with sw_undelete_expense first. ` +
      'Splitwise answers a write to a deleted expense with a bare 403 "you do not have permission".',
  );
}

/**
 * Refuse a write to a deleted expense up front, with who deleted it, instead
 * of letting Splitwise answer a bare 403. Runs before the confirm gate, so the
 * caller hears it on the first call. The read is advisory: when it fails or
 * finds nothing, the write goes ahead and reports its own error, so the check
 * can never block a write that would have worked.
 */
export async function assertNotDeleted(client: SplitwiseClient, id: number): Promise<void> {
  const expense = await readExpense(client, id).catch(() => undefined);
  if (expense?.deleted_at) throw deletedError(id, expense);
}

/**
 * Run a write to an existing expense; if Splitwise answers 403, re-read the
 * expense, and when it turns out deleted (between the pre-check and the write)
 * say so rather than "you do not have permission". Any other failure, or a 403
 * on a live expense, is passed through unchanged.
 */
export async function explainForbidden<T>(client: SplitwiseClient, id: number, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
    const expense = await readExpense(client, id).catch(() => undefined);
    if (expense?.deleted_at) throw deletedError(id, expense);
    throw err;
  }
}

/** The response of a create/update with `post_state` lifted to the top, from the expense it returned. */
export function withPostState(data: unknown): unknown {
  const box = asDict(data);
  const expense = asDict((box?.expenses as unknown[] | undefined)?.[0]);
  if (!box || !expense) return data;
  return { post_state: postState(expense), ...box };
}

/**
 * After a restore, read the expense back. Still deleted is an error that names
 * who deleted it and when — never `{success: true}`.
 */
export async function verifyRestored(client: SplitwiseClient, id: number, data: unknown): Promise<Dict> {
  const expense = await readExpense(client, id);
  if (!expense) {
    return { ...(asDict(data) ?? {}), post_state: null, note: `Could not re-read expense ${id} to confirm the restore` };
  }
  if (expense.deleted_at) {
    throw new Error(
      `Splitwise accepted the restore of expense ${id}, but it is still deleted (${deletedBy(expense)}). ` +
        'Another group member may have deleted it again — read its comments (sw_get_comments) before restoring it a second time.',
    );
  }
  return { ...(asDict(data) ?? {}), post_state: postState(expense) };
}
