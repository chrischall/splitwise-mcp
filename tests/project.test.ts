import { describe, it, expect, vi, afterEach } from 'vitest';
import { compactGroup, compactExpense, compactPerson, viewFriends, viewUser, viewGroups, viewExpenses, viewGeneric, PERSON_VIEW_NOTE, SW_VIEWS } from '../src/project.js';

afterEach(() => vi.restoreAllMocks());

/** The shape a live `GET /get_groups` actually returns (captured 2026-09-04). */
const LIVE_GROUP = {
  id: 64856400,
  name: 'Household',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2026-09-04T11:48:09Z',
  members: [{
    id: 88065463, first_name: 'Chris', last_name: 'Hall',
    picture: { small: 'https://s3/a.png', medium: 'https://s3/b.png', large: 'https://s3/c.png' },
    custom_picture: true, email: 'c@example.com', registration_status: 'confirmed',
    balance: [{ currency_code: 'USD', amount: '-6.25' }],
  }],
  simplify_by_default: false,
  original_debts: [{ from: 1, to: 2, amount: '6.25', currency_code: 'USD' }],
  simplified_debts: [{ from: 1, to: 2, amount: '6.25', currency_code: 'USD' }],
  whiteboard: null, whiteboard_lock_version: 0, whiteboard_updated_at: null, whiteboard_updated_by: null,
  group_type: 'home',
  invite_link: 'https://www.splitwise.com/join/abc',
  group_reminders: { enabled: false },
  avatar: { small: 'https://s3/g1.png', medium: 'https://s3/g2.png', xxlarge: 'https://s3/g3.png' },
  tall_avatar: { xlarge: 'https://s3/g4.png' },
  custom_avatar: false,
  cover_photo: { xxlarge: 'https://s3/g5.png' },
};

/** The shape a live `GET /get_friends` entry actually returns. */
const LIVE_FRIEND = {
  id: 88065463,
  first_name: 'Alison',
  last_name: 'Hall',
  email: 'a@example.com',
  registration_status: 'confirmed',
  picture: { small: 'https://s3/a.png', medium: 'https://s3/b.png', large: 'https://s3/c.png' },
  custom_picture: false,
  balance: [{ currency_code: 'USD', amount: '-6.25' }],
  groups: [{ group_id: 64856400, balance: [] }],
  updated_at: '2026-09-04T11:48:09Z',
};

// This projection had no direct test, and that is how the two tool
// descriptions came to promise `first_name` / `last_name` that compact does
// not return. The key set is the contract now.
describe('compactPerson', () => {
  it('returns exactly {id, name, email, registration_status, balance}', () => {
    expect(Object.keys(compactPerson(LIVE_FRIEND)).sort())
      .toEqual(['balance', 'email', 'id', 'name', 'registration_status']);
  });

  it('MERGES first_name + last_name into name, and does not keep either', () => {
    const out = compactPerson(LIVE_FRIEND);
    expect(out.name).toBe('Alison Hall');
    expect(out).not.toHaveProperty('first_name');
    expect(out).not.toHaveProperty('last_name');
  });

  it('omits name entirely rather than emitting an empty string when neither name is set', () => {
    // "not reported" and "" are different facts; `pruneUndefined` keeps them so.
    expect(compactPerson({ id: 1, email: 'x@example.com' })).not.toHaveProperty('name');
    expect(compactPerson({ id: 1, first_name: '', last_name: '' })).not.toHaveProperty('name');
  });

  it('keeps just one of the pair when that is all Splitwise sent', () => {
    expect(compactPerson({ id: 1, first_name: 'Alison' }).name).toBe('Alison');
    expect(compactPerson({ id: 1, last_name: 'Hall' }).name).toBe('Hall');
  });

  it('drops the picture URLs a model cannot see', () => {
    const text = JSON.stringify(compactPerson(LIVE_FRIEND));
    expect(text).not.toContain('picture');
    expect(text).not.toContain('s3');
  });

  it('omits an empty balance rather than reporting []', () => {
    // A settled friend and a friend whose balance was not reported are not the
    // same fact, and `[]` reads as the first.
    expect(compactPerson({ ...LIVE_FRIEND, balance: [] })).not.toHaveProperty('balance');
    expect(compactPerson(LIVE_FRIEND).balance).toEqual(LIVE_FRIEND.balance);
  });

  it('survives a non-object without throwing', () => {
    expect(compactPerson(null)).toEqual({});
  });

  it('backs viewFriends and viewUser, so both tools answer in the same shape', () => {
    const fromList = (viewFriends('compact', { friends: [LIVE_FRIEND] }) as { friends: Record<string, unknown>[] }).friends[0];
    const fromOne = (viewUser('compact', { user: LIVE_FRIEND }) as { user: Record<string, unknown> }).user;
    expect(fromList).toEqual(fromOne);
    expect(fromOne).toEqual(compactPerson(LIVE_FRIEND));
  });
});

// The description mismatch this issue is about was a claim in prose drifting
// from a projection in code. Pin the two together.
describe('PERSON_VIEW_NOTE', () => {
  it('names every field compact actually returns, and no field it does not', () => {
    for (const key of Object.keys(compactPerson(LIVE_FRIEND))) {
      expect(PERSON_VIEW_NOTE).toContain(key);
    }
    expect(PERSON_VIEW_NOTE).toContain('first_name + last_name joined');
  });
});

describe('compactGroup', () => {
  it('drops every image URL — 60% of a live 51-group response was exactly these', () => {
    const out = compactGroup(LIVE_GROUP);
    const text = JSON.stringify(out);
    for (const key of ['avatar', 'tall_avatar', 'cover_photo', 'picture', 'custom_picture', 'custom_avatar']) {
      expect(text).not.toContain(key);
    }
  });

  it('keeps what a caller acts on: who is in it, what they owe, and how to invite', () => {
    expect(compactGroup(LIVE_GROUP)).toMatchObject({
      id: 64856400,
      name: 'Household',
      group_type: 'home',
      invite_link: 'https://www.splitwise.com/join/abc',
      members: [{
        id: 88065463, name: 'Chris Hall', email: 'c@example.com',
        registration_status: 'confirmed',
        balance: [{ currency_code: 'USD', amount: '-6.25' }],
      }],
      simplified_debts: [{ from: 1, to: 2, amount: '6.25', currency_code: 'USD' }],
    });
  });

  it('drops the whiteboard block, which no tool here reads', () => {
    const text = JSON.stringify(compactGroup(LIVE_GROUP));
    expect(text).not.toContain('whiteboard');
  });
});

/** The shape a live `GET /get_expenses` actually returns (captured 2026-09-04). */
const LIVE_EXPENSE = {
  id: 4666326570, group_id: 64856400, expense_bundle_id: null,
  description: 'Eriks new shoes',
  repeats: false, repeat_interval: null, email_reminder: false, email_reminder_in_advance: -1,
  next_repeat: null, details: null, comments_count: 0, payment: false,
  creation_method: 'equal', transaction_method: 'offline', transaction_confirmed: false,
  transaction_id: null, transaction_status: null,
  cost: '61.14', currency_code: 'USD',
  repayments: [{ from: 88065463, to: 88065693, amount: '30.57' }],
  date: '2026-09-02T22:37:44Z', created_at: '2026-09-02T22:38:05Z',
  created_by: { id: 88065693, first_name: 'Alison', last_name: 'Hall', picture: { medium: 'https://s3/a.png' }, custom_picture: false },
  updated_at: '2026-09-02T22:38:06Z', updated_by: { id: 88065693, first_name: 'Alison', last_name: 'Hall', picture: { medium: 'https://s3/a.png' } },
  deleted_at: null, deleted_by: null,
  category: { id: 41, name: 'Clothing' },
  receipt: { large: 'https://www.splitwise.com/api/v4.0/expenses/4666326570/receipt?x=1.jpeg&size=large', original: 'https://www.splitwise.com/api/v4.0/expenses/4666326570/receipt?x=1.jpeg' },
  users: [
    { user: { id: 88065693, first_name: 'Alison', last_name: 'Hall', picture: { medium: 'https://s3/a.png' } }, user_id: 88065693, paid_share: '61.14', owed_share: '30.57', net_balance: '30.57' },
    { user: { id: 88065463, first_name: 'Chris', last_name: 'Hall', picture: { medium: 'https://s3/b.jpg' } }, user_id: 88065463, paid_share: '0.0', owed_share: '30.57', net_balance: '-30.57' },
  ],
};

describe('compactExpense', () => {
  it('keeps the share breakdown, which is the point of an expense', () => {
    expect(compactExpense(LIVE_EXPENSE).users).toEqual([
      { id: 88065693, name: 'Alison Hall', paid_share: '61.14', owed_share: '30.57', net_balance: '30.57' },
      { id: 88065463, name: 'Chris Hall', paid_share: '0.0', owed_share: '30.57', net_balance: '-30.57' },
    ]);
  });

  it('keeps cost, currency, date, category and repayments', () => {
    expect(compactExpense(LIVE_EXPENSE)).toMatchObject({
      id: 4666326570, group_id: 64856400, description: 'Eriks new shoes',
      cost: '61.14', currency_code: 'USD', date: '2026-09-02T22:37:44Z',
      category: 'Clothing', created_by: 'Alison Hall',
      repayments: [{ from: 88065463, to: 88065693, amount: '30.57' }],
    });
  });

  it('drops the eleven near-constant repeat/reminder/transaction fields', () => {
    const text = JSON.stringify(compactExpense(LIVE_EXPENSE));
    for (const key of ['repeats', 'repeat_interval', 'email_reminder', 'next_repeat', 'transaction_method',
      'transaction_confirmed', 'transaction_id', 'transaction_status', 'expense_bundle_id', 'creation_method']) {
      expect(text).not.toContain(key);
    }
  });

  it('reports that a receipt EXISTS rather than shipping two URLs for it', () => {
    // A receipt is evidence; sw_get_receipt is how a caller fetches it.
    expect(compactExpense(LIVE_EXPENSE).has_receipt).toBe(true);
    expect(JSON.stringify(compactExpense(LIVE_EXPENSE))).not.toContain('cachebust');
    expect(compactExpense({ ...LIVE_EXPENSE, receipt: { large: null, original: null } })).not.toHaveProperty('has_receipt');
  });

  it('surfaces deleted_at when set, so a deleted expense is not silently counted', () => {
    expect(compactExpense(LIVE_EXPENSE)).not.toHaveProperty('deleted_at');
    expect(compactExpense({ ...LIVE_EXPENSE, deleted_at: '2026-09-03T00:00:00Z' }).deleted_at).toBe('2026-09-03T00:00:00Z');
  });
});

describe('the rungs', () => {
  it('offers compact and full, and not raw', () => {
    expect(SW_VIEWS).toEqual(['compact', 'full']);
  });

  it('passes the payload through untouched on full', () => {
    const payload = { groups: [LIVE_GROUP] };
    expect(viewGroups('full', payload)).toBe(payload);
  });

  it('returns the payload WHOLE and warns when the array is not where expected', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drifted = { data: { groups: [] } };
    expect(viewGroups('compact', drifted)).toBe(drifted);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('splitwise-mcp'));
  });

  it('projects the whole array or none of it', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = { expenses: 'not an array' };
    expect(viewExpenses('compact', payload)).toBe(payload);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('viewGeneric strips avatars from a payload with no hand-written projection', () => {
    const out = viewGeneric('compact', { notifications: [{ id: 1, content: 'x', image_url: 'https://s3/n.png' }] }) as never;
    expect(JSON.stringify(out)).not.toContain('image_url');
    expect(JSON.stringify(out)).toContain('"content":"x"');
  });

  it('never touches whitespace inside a value', () => {
    const details = 'Line one.\n\n  Line two.   ';
    expect(compactExpense({ ...LIVE_EXPENSE, details }).details).toBe(details);
  });
});
