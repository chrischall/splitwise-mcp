import { describe, it, expect } from 'vitest';
import { equalSplit, resolveMember } from '../../src/tools/_split.js';

const sum = (xs: string[]) => xs.reduce((a, x) => a + Math.round(Number(x) * 100), 0);

describe('equalSplit', () => {
  it('splits 50/50 with the payer covering the whole cost', () => {
    expect(equalSplit('50.00', 1, [1, 2])).toEqual([
      { user_id: 1, paid_share: '50.00', owed_share: '25.00' },
      { user_id: 2, paid_share: '0.00', owed_share: '25.00' },
    ]);
  });

  it('gives the odd cent to the first participant, so the shares sum to the cost', () => {
    const shares = equalSplit('25.01', 1, [1, 2]);
    expect(shares.map((s) => s.owed_share)).toEqual(['12.51', '12.50']);
    expect(sum(shares.map((s) => s.owed_share))).toBe(2501);
  });

  it('spreads several leftover cents one each, in order', () => {
    const shares = equalSplit('10.01', 1, [1, 2, 3]);
    expect(shares.map((s) => s.owed_share)).toEqual(['3.34', '3.34', '3.33']);
  });

  it('follows the precision of the cost string (a zero-decimal currency)', () => {
    const shares = equalSplit('1001', 7, [7, 8]);
    expect(shares).toEqual([
      { user_id: 7, paid_share: '1001', owed_share: '501' },
      { user_id: 8, paid_share: '0', owed_share: '500' },
    ]);
  });

  it('adds a payer who is not splitting with an owed share of zero', () => {
    expect(equalSplit('20.00', 9, [1, 2])).toEqual([
      { user_id: 1, paid_share: '0.00', owed_share: '10.00' },
      { user_id: 2, paid_share: '0.00', owed_share: '10.00' },
      { user_id: 9, paid_share: '20.00', owed_share: '0.00' },
    ]);
  });

  it('ignores a repeated participant', () => {
    expect(equalSplit('9.00', 1, [1, 2, 2]).map((s) => s.user_id)).toEqual([1, 2]);
  });

  it.each(['abc', '-5.00', '5.', '', '1e3'])('refuses a cost that is not a plain decimal: %s', (cost) => {
    expect(() => equalSplit(cost, 1, [1, 2])).toThrow(/cost/);
  });

  it('refuses an empty participant list', () => {
    expect(() => equalSplit('5.00', 1, [])).toThrow(/split_among/);
  });
});

describe('resolveMember', () => {
  const members = [
    { id: 1, first_name: 'Chris', last_name: 'Hall', email: 'c@example.com' },
    { id: 2, first_name: 'Alison', last_name: 'Hall', email: 'a@example.com' },
    { id: 3, first_name: 'Chris', last_name: 'Egan', email: 'e@example.com' },
  ];

  it('accepts an id that is a member', () => {
    expect(resolveMember(2, members, 'paid_by')).toBe(2);
  });

  it('matches a full name or email case-insensitively', () => {
    expect(resolveMember('alison hall', members, 'paid_by')).toBe(2);
    expect(resolveMember('E@EXAMPLE.COM', members, 'paid_by')).toBe(3);
  });

  it('matches a unique first name', () => {
    expect(resolveMember('alison', members, 'paid_by')).toBe(2);
  });

  it('refuses an ambiguous name and lists the candidates', () => {
    expect(() => resolveMember('chris', members, 'paid_by')).toThrow(/ambiguous.*Chris Hall.*Chris Egan/);
  });

  it('refuses an id or name that is not in the group', () => {
    expect(() => resolveMember(99, members, 'paid_by')).toThrow(/not a member/);
    expect(() => resolveMember('bob', members, 'split_among')).toThrow(/split_among.*bob/);
  });
});
