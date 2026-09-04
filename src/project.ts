import { projectOrRaw, pruneUndefined, stripMediaUrls, type View } from '@chrischall/mcp-utils';

/**
 * The compact projection (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * `sw_list_groups` did not merely return a large response — it returned one
 * that DOES NOT FIT. A live call on a 51-group account came back as 192,123
 * characters and was refused by the host before the model saw a byte of it:
 * the tool was unusable, not merely expensive.
 *
 * Where the weight was, measured on that payload:
 *
 * - `avatar` + `tall_avatar` + `cover_photo` — 51.7 KB, 27%
 * - a `picture` object per member, across 51 groups — 37.7 KB, 20%
 *
 * 60% of the whole response was image URLs a model cannot see, cannot fetch,
 * and would not benefit from if it could. `stripMediaUrls` alone takes the
 * payload to 51.4 KB (−73%); the field projections below take it to 29.3 KB.
 *
 * `full` returns Splitwise's records untouched. There is no `raw` rung: `full`
 * already is the upstream payload.
 */
export const SW_VIEWS = ['compact', 'full'] as const;

const LABEL = 'splitwise-mcp';

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : undefined;
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** "Alison Hall" from the first/last pair Splitwise returns on every user shape. */
function nameOf(user: Dict | undefined): string | undefined {
  if (!user) return undefined;
  const parts = [user.first_name, user.last_name].filter((p): p is string => typeof p === 'string' && p !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * One member or friend. `balance` survives — it is the whole reason to look a
 * person up — and so does `registration_status`, which is how a caller knows
 * an invite has not been accepted.
 */
function compactPerson(raw: unknown): Dict {
  const u = asDict(raw) ?? {};
  // `pruneUndefined`, so an optional field is ABSENT rather than
  // present-and-undefined: "not reported" and "none" have to stay different
  // facts at every layer, not only after serialisation.
  return pruneUndefined({
    id: u.id,
    name: nameOf(u),
    email: u.email,
    registration_status: u.registration_status,
    balance: asList(u.balance).length > 0 ? u.balance : undefined,
  });
}

/**
 * One group.
 *
 * `whiteboard`, `whiteboard_lock_version`, `whiteboard_updated_at` and
 * `whiteboard_updated_by` go: the whiteboard is a UI feature with no tool that
 * reads it. `simplify_by_default`, `custom_avatar` and `group_reminders` go as
 * settings nothing here acts on. `original_debts` goes because
 * `simplified_debts` answers "who owes whom" and the pair differ only when
 * simplification is on — `full` has both.
 */
export function compactGroup(raw: unknown): Dict {
  const g = asDict(raw) ?? {};
  return pruneUndefined({
    id: g.id,
    name: g.name,
    group_type: g.group_type,
    updated_at: g.updated_at,
    members: asList(g.members).map(compactPerson),
    simplified_debts: asList(g.simplified_debts).length > 0 ? g.simplified_debts : undefined,
    invite_link: g.invite_link,
  });
}

/**
 * One expense.
 *
 * The share breakdown is the point of an expense, so `users` keeps every
 * share — but as `{id, name, paid_share, owed_share, net_balance}` rather than
 * Splitwise's nested `user` object, which repeats the name and an avatar the
 * record already carried under `created_by`.
 *
 * `receipt` survives when there IS one: a receipt is evidence, and
 * `sw_get_receipt` needs the id. The repeat/reminder/transaction block goes —
 * eleven near-constant fields (`repeats`, `repeat_interval`, `email_reminder`,
 * `email_reminder_in_advance`, `next_repeat`, `transaction_method`,
 * `transaction_confirmed`, `transaction_id`, `transaction_status`,
 * `expense_bundle_id`, `creation_method`) that were `false`/`null`/`"offline"`
 * on every expense in a live account.
 */
export function compactExpense(raw: unknown): Dict {
  const e = asDict(raw) ?? {};
  const receipt = asDict(e.receipt);
  const original = receipt?.original;
  return pruneUndefined({
    id: e.id,
    group_id: e.group_id,
    description: e.description,
    details: e.details,
    cost: e.cost,
    currency_code: e.currency_code,
    date: e.date,
    category: asDict(e.category)?.name,
    payment: e.payment === true ? true : undefined,
    created_by: nameOf(asDict(e.created_by)),
    updated_at: e.updated_at,
    // Kept only when set. A deleted expense still comes back from the list
    // endpoint, and a caller that cannot see `deleted_at` will count it.
    deleted_at: e.deleted_at ?? undefined,
    comments_count: e.comments_count,
    repayments: e.repayments,
    users: asList(e.users).map((entry) => {
      const u = asDict(entry) ?? {};
      return {
        id: u.user_id ?? asDict(u.user)?.id,
        name: nameOf(asDict(u.user)),
        paid_share: u.paid_share,
        owed_share: u.owed_share,
        net_balance: u.net_balance,
      };
    }),
    // A receipt is evidence; `sw_get_receipt` is how a caller fetches it.
    has_receipt: typeof original === 'string' ? true : undefined,
  });
}

/**
 * Project a payload's `<key>` array, or hand the whole thing back.
 *
 * Whole-array, never per record: one odd record projected to nothing among
 * fifty good ones is a hole in the middle of an answer, and indistinguishable
 * from an expense with no content.
 */
function projectList(view: View, payload: unknown, key: string, map: (item: unknown) => Dict, context: string): unknown {
  if (view !== 'compact') return payload;
  return projectOrRaw(
    payload,
    (p) => {
      const box = asDict(p);
      const items = box?.[key];
      if (!box || !Array.isArray(items)) throw new Error(`expected a ${key}[] array`);
      return { ...box, [key]: items.map(map) };
    },
    { label: LABEL, context },
  );
}

export const viewGroups = (view: View, p: unknown): unknown => projectList(view, p, 'groups', compactGroup, 'GET /get_groups');
export const viewFriends = (view: View, p: unknown): unknown => projectList(view, p, 'friends', compactPerson, 'GET /get_friends');
export const viewExpenses = (view: View, p: unknown): unknown => projectList(view, p, 'expenses', compactExpense, 'GET /get_expenses');

/** One record under `<key>` rather than an array of them. */
function projectOne(view: View, payload: unknown, key: string, map: (item: unknown) => Dict, context: string): unknown {
  if (view !== 'compact') return payload;
  return projectOrRaw(
    payload,
    (p) => {
      const box = asDict(p);
      if (!box || box[key] === undefined) throw new Error(`expected a ${key} object`);
      return { ...box, [key]: map(box[key]) };
    },
    { label: LABEL, context },
  );
}

export const viewGroup = (view: View, p: unknown): unknown => projectOne(view, p, 'group', compactGroup, 'GET /get_group/{id}');
export const viewExpense = (view: View, p: unknown): unknown => projectOne(view, p, 'expense', compactExpense, 'GET /get_expense/{id}');
export const viewUser = (view: View, p: unknown): unknown => projectOne(view, p, 'user', compactPerson, 'GET /get_user/{id}');

/**
 * The rung for a payload with no hand-written projection: `compact` still
 * strips the avatars, which is where most of the weight is anyway.
 *
 * NEVER used by `sw_get_receipt`, whose product IS the image URL.
 */
export function viewGeneric(view: View, payload: unknown): unknown {
  return view === 'compact' ? stripMediaUrls(payload) : payload;
}
