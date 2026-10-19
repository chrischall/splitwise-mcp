/** One participant's line in a custom split, as Splitwise takes it. */
export interface UserShare {
  user_id: number;
  paid_share: string;
  owed_share: string;
}

/** A group member as `GET /get_group/{id}` returns one. */
export interface Member {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

/**
 * The shares for "`payer` paid it all, everyone in `participants` owes an
 * equal part". Built here rather than with Splitwise's `split_equally`, which
 * always makes the CALLER the payer — the 50/50 case where the other parent
 * paid had to be hand-built as a users[] array.
 *
 * Arithmetic is in minor units at the precision the cost string was written
 * with ("25.01" → cents, "1001" → whole units), so the shares always sum to
 * the cost exactly. Leftover units go one each to the first participants in
 * order — deterministic, and shown in the preview before anything is sent.
 */
export function equalSplit(cost: string, payer: number, participants: number[]): UserShare[] {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cost);
  if (!match) throw new Error(`cost must be a plain decimal string like "25.00" for an equal split (got "${cost}")`);
  const ids = [...new Set(participants)];
  if (ids.length === 0) throw new Error('split_among must name at least one participant');

  const decimals = match[2]?.length ?? 0;
  const total = BigInt(match[1] + (match[2] ?? ''));
  const count = BigInt(ids.length);
  const base = total / count;
  const leftover = Number(total % count);
  const fmt = (units: bigint) => formatUnits(units, decimals);

  const shares = ids.map((id, i) => ({
    user_id: id,
    paid_share: fmt(id === payer ? total : 0n),
    owed_share: fmt(base + (i < leftover ? 1n : 0n)),
  }));
  if (!ids.includes(payer)) {
    shares.push({ user_id: payer, paid_share: fmt(total), owed_share: fmt(0n) });
  }
  return shares;
}

function formatUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

const fullName = (m: Member) => [m.first_name, m.last_name].filter(Boolean).join(' ');

/**
 * A member named by id, full name, email or a first name only they have.
 * `field` names the argument in the error, so the caller knows which to fix.
 */
export function resolveMember(who: number | string, members: Member[], field: string): number {
  if (typeof who === 'number') {
    if (members.some((m) => m.id === who)) return who;
    throw new Error(`${field}: user ${who} is not a member of this group`);
  }
  const want = who.trim().toLowerCase();
  const exact = members.filter(
    (m) => fullName(m).toLowerCase() === want || (m.email ?? '').toLowerCase() === want,
  );
  const candidates = exact.length > 0 ? exact : members.filter((m) => (m.first_name ?? '').toLowerCase() === want);
  if (candidates.length === 1) return candidates[0]!.id;
  if (candidates.length > 1) {
    throw new Error(
      `${field}: "${who}" is ambiguous — ${candidates.map((m) => `${fullName(m)} (${m.id})`).join(', ')}. Pass the user id.`,
    );
  }
  throw new Error(
    `${field}: "${who}" is not a member of this group (members: ${members.map((m) => `${fullName(m)} (${m.id})`).join(', ')})`,
  );
}
