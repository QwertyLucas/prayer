import {
  AUDIENCE_MIX,
  type AudienceKind,
  GROUP_COUNT_BUCKETS,
  GROUP_FIXTURES,
  TAG_NAMES,
  expand,
  pick,
  pickDistinct,
} from './bench-fixtures.js';
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

/**
 * Every member owns 1-3 tags, each holding 3-12 other members.
 *
 * The owner is deliberately NOT a member of their own tag — that mirrors the
 * real shape (Alice's "family" tag lists John and Taylor, not Alice) and makes
 * the author clause in the visibility rule load-bearing rather than decorative.
 */
export async function loadTags(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  rng: () => number,
): Promise<Map<string, string[]>> {
  const tagRows: { id: string; owner_id: string; church_id: string; name: string }[] = [];
  const byOwner = new Map<string, string[]>();

  for (const ownerId of memberIds) {
    const howMany = 1 + Math.floor(rng() * 3); // 1, 2, or 3
    const names = pickDistinct(rng, TAG_NAMES, howMany);
    const ids: string[] = [];
    for (const name of names) {
      const id = newId();
      ids.push(id);
      tagRows.push({ id, owner_id: ownerId, church_id: orgId, name });
    }
    byOwner.set(ownerId, ids);
  }

  for (let i = 0; i < tagRows.length; i += 500) {
    await db
      .insertInto('tags')
      .values(tagRows.slice(i, i + 500))
      .execute();
  }

  const memberRows: { tag_id: string; user_id: string }[] = [];
  for (const tag of tagRows) {
    const candidates = memberIds.filter((m) => m !== tag.owner_id);
    const size = 3 + Math.floor(rng() * 10); // 3..12
    for (const userId of pickDistinct(rng, candidates, size)) {
      memberRows.push({ tag_id: tag.id, user_id: userId });
    }
  }

  for (let i = 0; i < memberRows.length; i += 500) {
    await db
      .insertInto('tag_members')
      .values(memberRows.slice(i, i + 500))
      .execute();
  }

  return byOwner;
}

interface AudienceRow {
  post_id: string;
  church_id: string | null;
  group_id: string | null;
  tag_id: string | null;
}

/**
 * Ten prayers per member, with audiences drawn from AUDIENCE_MIX.
 *
 * Two constraints keep the data coherent, and both matter for the correctness
 * oracle later: a prayer may only target a tag its author OWNS, and may only
 * target a group its author BELONGS TO. Members in no groups therefore fall back
 * to church-wide — which is exactly why they end up with thin feeds.
 */
export async function loadPrayers(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  groupsByMember: Map<string, string[]>,
  tagsByOwner: Map<string, string[]>,
  rng: () => number,
): Promise<number> {
  const total = memberIds.length * 10;
  const scale = total / 10000;
  const kinds = expand(
    AUDIENCE_MIX.map((m) => ({ count: Math.max(1, Math.round(m.count * scale)), value: m.kind })),
  );

  const now = Date.now();
  const posts: {
    id: string;
    org_id: string;
    parent_id: null;
    author_id: string;
    body: string;
    status: 'published';
    edit_deadline: Date;
  }[] = [];
  const audiences: AudienceRow[] = [];

  let k = 0;
  for (const authorId of memberIds) {
    for (let n = 0; n < 10; n++) {
      const postId = newId();
      const requested: AudienceKind = kinds[k % kinds.length] ?? 'church';
      k++;

      const myGroups = groupsByMember.get(authorId) ?? [];
      const myTags = tagsByOwner.get(authorId) ?? [];

      // Fall back to church-wide when the author has no group to share into.
      let kind = requested;
      if ((kind === 'one_group' || kind === 'multi_group') && myGroups.length === 0)
        kind = 'church';
      if (kind === 'group_and_tag' && (myGroups.length === 0 || myTags.length === 0))
        kind = 'church';
      if ((kind === 'one_tag' || kind === 'multi_tag') && myTags.length === 0) kind = 'church';

      posts.push({
        id: postId,
        org_id: orgId,
        parent_id: null,
        author_id: authorId,
        body: `Bench prayer ${n + 1} from ${authorId.slice(0, 8)} (${kind})`,
        status: 'published',
        edit_deadline: new Date(now + 24 * 60 * 60 * 1000),
      });

      const row = (over: Partial<AudienceRow>): AudienceRow => ({
        post_id: postId,
        church_id: null,
        group_id: null,
        tag_id: null,
        ...over,
      });

      switch (kind) {
        case 'church':
          audiences.push(row({ church_id: orgId }));
          break;
        case 'one_group':
          audiences.push(row({ group_id: pick(rng, myGroups) }));
          break;
        case 'multi_group':
          for (const g of pickDistinct(rng, myGroups, 2 + Math.floor(rng() * 2))) {
            audiences.push(row({ group_id: g }));
          }
          break;
        case 'one_tag':
          audiences.push(row({ tag_id: pick(rng, myTags) }));
          break;
        case 'multi_tag':
          for (const t of pickDistinct(rng, myTags, 2 + Math.floor(rng() * 2))) {
            audiences.push(row({ tag_id: t }));
          }
          break;
        case 'group_and_tag':
          audiences.push(row({ group_id: pick(rng, myGroups) }));
          audiences.push(row({ tag_id: pick(rng, myTags) }));
          break;
        case 'author_only':
          break;
      }
    }
  }

  for (let i = 0; i < posts.length; i += 500) {
    await db
      .insertInto('posts')
      .values(posts.slice(i, i + 500))
      .execute();
  }
  for (let i = 0; i < audiences.length; i += 500) {
    await db
      .insertInto('post_audiences')
      .values(audiences.slice(i, i + 500))
      .execute();
  }

  return posts.length;
}
