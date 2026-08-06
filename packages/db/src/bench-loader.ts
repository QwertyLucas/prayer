import { GROUP_COUNT_BUCKETS, GROUP_FIXTURES, expand, pickDistinct } from './bench-fixtures.js';
import type { BenchDb } from './bench-schema.js';
import { newId } from './ids.js';

/**
 * Writes fixture rows directly via Kysely. Service-layer functions write to the
 * `events` outbox in the same transaction, which would fire notification builders,
 * count recomputers, and feed-snapshot updates for fixture data. Same rule as
 * bootstrap.ts — do not "fix" this by routing through services.
 */

/** Creates the benchmark church. The slug is arbitrary; nothing resolves it by hostname. */
export async function loadOrg(db: BenchDb, slug: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('orgs')
    .values({ id, slug, display_name: `Bench Church (${slug})` })
    .execute();
  return id;
}

/**
 * Inserts `count` members and joins them to the org. Emails are namespaced by
 * org id so loading twice into one database never trips the UNIQUE constraint.
 * Auth ids are synthetic — the benchmark never authenticates against Supabase.
 */
export async function loadMembers(db: BenchDb, orgId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  const users = [];
  const memberships = [];

  for (let i = 0; i < count; i++) {
    const id = newId();
    ids.push(id);
    users.push({
      id,
      supabase_auth_id: newId(),
      // orgId (not a slice of it) namespaces the email: UUIDv7's leading hex
      // chars encode a millisecond timestamp, so two orgs minted moments
      // apart (as in a single benchmark run) share the same `slice(0, 8)`
      // prefix — that collided across orgs in this exact scenario. The full
      // id is unique by construction and sidesteps the issue entirely.
      email: `m${String(i).padStart(5, '0')}.${orgId.replace(/-/g, '')}@bench.invalid`,
      display_name: `Member ${i + 1}`,
    });
    memberships.push({ user_id: id, org_id: orgId, role: 'member' as const });
  }

  // Chunked to stay well under Postgres's 65,535 bind-parameter ceiling.
  for (let i = 0; i < users.length; i += 500) {
    await db
      .insertInto('users')
      .values(users.slice(i, i + 500))
      .execute();
    await db
      .insertInto('user_orgs')
      .values(memberships.slice(i, i + 500))
      .execute();
  }

  return ids;
}

/**
 * Creates the 58 groups and assigns members according to GROUP_COUNT_BUCKETS.
 * Returns member id -> group ids so callers can pick group audiences the author
 * actually belongs to.
 *
 * Members are assigned a target group count first, then groups are drawn from
 * the pool. A member with a target of 0 is left alone — those are the isolated
 * members the benchmark needs.
 */
export async function loadGroups(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  rng: () => number,
): Promise<Map<string, string[]>> {
  const groupRows = GROUP_FIXTURES.map((g) => ({ id: newId(), church_id: orgId, name: g.name }));
  await db.insertInto('groups').values(groupRows).execute();
  const groupIds = groupRows.map((g) => g.id);

  const targets = expand(
    GROUP_COUNT_BUCKETS.map((b) => ({ count: b.members, value: b.groups })),
  ).slice(0, memberIds.length);

  const byMember = new Map<string, string[]>();
  const membershipRows: { group_id: string; user_id: string; role: 'leader' | 'member' }[] = [];

  memberIds.forEach((userId, i) => {
    const target = targets[i] ?? 0;
    const chosen = target === 0 ? [] : pickDistinct(rng, groupIds, target);
    byMember.set(userId, chosen);
    for (const groupId of chosen) {
      // Roughly one in ten memberships is a leader. Roles govern actions, never visibility.
      membershipRows.push({
        group_id: groupId,
        user_id: userId,
        role: rng() < 0.1 ? 'leader' : 'member',
      });
    }
  });

  for (let i = 0; i < membershipRows.length; i += 500) {
    await db
      .insertInto('group_members')
      .values(membershipRows.slice(i, i + 500))
      .execute();
  }

  return byMember;
}
