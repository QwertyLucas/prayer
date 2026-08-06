import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GROUP_FIXTURES, makeRng } from '../src/bench-fixtures.js';
import { loadGroups, loadMembers, loadOrg, loadPrayers, loadTags } from '../src/bench-loader.js';
import { createBenchDb, type BenchDb } from '../src/bench-schema.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;

beforeAll(() => {
  db = createBenchDb(url);
});

afterAll(async () => {
  await db.destroy();
});

describe('loadOrg + loadMembers', () => {
  it('creates one org and the requested number of members', async () => {
    const orgId = await loadOrg(db, 'bench-a');
    const ids = await loadMembers(db, orgId, 25);

    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);

    const rows = await db
      .selectFrom('user_orgs')
      .select('user_id')
      .where('org_id', '=', orgId)
      .execute();
    expect(rows).toHaveLength(25);
  });

  it('gives every member a unique email so two runs never collide', async () => {
    const orgId = await loadOrg(db, 'bench-b');
    await loadMembers(db, orgId, 10);
    const rows = await db
      .selectFrom('users')
      .innerJoin('user_orgs', 'user_orgs.user_id', 'users.id')
      .select('users.email')
      .where('user_orgs.org_id', '=', orgId)
      .execute();
    expect(new Set(rows.map((r) => r.email)).size).toBe(10);
  });

  it('returns ids in ascending order so UUIDv7 ordering is preserved', async () => {
    const orgId = await loadOrg(db, 'bench-c');
    const ids = await loadMembers(db, orgId, 20);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('loadGroups', () => {
  it('creates all 58 groups and returns per-member membership', async () => {
    const orgId = await loadOrg(db, 'bench-groups');
    const members = await loadMembers(db, orgId, 1000);
    const byMember = await loadGroups(db, orgId, members, makeRng(1));

    const groups = await db
      .selectFrom('groups')
      .select('id')
      .where('church_id', '=', orgId)
      .execute();
    expect(groups).toHaveLength(GROUP_FIXTURES.length);
    expect(byMember.size).toBe(1000);
  });

  it('leaves exactly 100 members in no group at all', async () => {
    const orgId = await loadOrg(db, 'bench-isolated');
    const members = await loadMembers(db, orgId, 1000);
    const byMember = await loadGroups(db, orgId, members, makeRng(2));
    const isolated = [...byMember.values()].filter((g) => g.length === 0);
    expect(isolated).toHaveLength(100);
  });

  it('writes 2,300 membership rows', async () => {
    const orgId = await loadOrg(db, 'bench-count');
    const members = await loadMembers(db, orgId, 1000);
    await loadGroups(db, orgId, members, makeRng(3));

    const rows = await db
      .selectFrom('group_members')
      .innerJoin('groups', 'groups.id', 'group_members.group_id')
      .select('group_members.user_id')
      .where('groups.church_id', '=', orgId)
      .execute();
    expect(rows).toHaveLength(2300);
  });

  it('is deterministic for a given seed', async () => {
    const a = await loadOrg(db, 'bench-det-1');
    const b = await loadOrg(db, 'bench-det-2');
    const ma = await loadMembers(db, a, 200);
    const mb = await loadMembers(db, b, 200);
    const ga = await loadGroups(db, a, ma, makeRng(99));
    const gb = await loadGroups(db, b, mb, makeRng(99));

    const shape = (m: Map<string, string[]>) => [...m.values()].map((v) => v.length);
    expect(shape(ga)).toEqual(shape(gb));
  });
});

describe('loadTags', () => {
  it('gives every member between 1 and 3 tags', async () => {
    const orgId = await loadOrg(db, 'bench-tags');
    const members = await loadMembers(db, orgId, 300);
    const byOwner = await loadTags(db, orgId, members, makeRng(5));

    expect(byOwner.size).toBe(300);
    for (const tags of byOwner.values()) {
      expect(tags.length).toBeGreaterThanOrEqual(1);
      expect(tags.length).toBeLessThanOrEqual(3);
    }
  });

  it('never puts the owner inside their own tag — the author clause covers them', async () => {
    const orgId = await loadOrg(db, 'bench-tag-owner');
    const members = await loadMembers(db, orgId, 100);
    await loadTags(db, orgId, members, makeRng(6));

    const selfMembers = await db
      .selectFrom('tag_members')
      .innerJoin('tags', 'tags.id', 'tag_members.tag_id')
      .select('tags.id')
      .where('tags.church_id', '=', orgId)
      .whereRef('tags.owner_id', '=', 'tag_members.user_id')
      .execute();
    expect(selfMembers).toHaveLength(0);
  });

  it('puts between 3 and 12 members in each tag', async () => {
    const orgId = await loadOrg(db, 'bench-tag-size');
    const members = await loadMembers(db, orgId, 200);
    await loadTags(db, orgId, members, makeRng(7));

    const sizes = await db
      .selectFrom('tag_members')
      .innerJoin('tags', 'tags.id', 'tag_members.tag_id')
      .select(({ fn }) => ['tag_members.tag_id', fn.count<string>('tag_members.user_id').as('n')])
      .where('tags.church_id', '=', orgId)
      .groupBy('tag_members.tag_id')
      .execute();

    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) {
      expect(Number(s.n)).toBeGreaterThanOrEqual(3);
      expect(Number(s.n)).toBeLessThanOrEqual(12);
    }
  });

  it('gives one owner distinct tag names', async () => {
    const orgId = await loadOrg(db, 'bench-tag-names');
    const members = await loadMembers(db, orgId, 50);
    await loadTags(db, orgId, members, makeRng(8));

    const rows = await db
      .selectFrom('tags')
      .select(['owner_id', 'name'])
      .where('church_id', '=', orgId)
      .execute();
    const perOwner = new Map<string, string[]>();
    for (const r of rows) perOwner.set(r.owner_id, [...(perOwner.get(r.owner_id) ?? []), r.name]);
    for (const names of perOwner.values()) {
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('loadPrayers', () => {
  it('writes 10 prayers per member with a coherent audience mix', async () => {
    const orgId = await loadOrg(db, 'bench-prayers');
    const members = await loadMembers(db, orgId, 1000);
    const rng = makeRng(11);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    const written = await loadPrayers(db, orgId, members, groups, tags, rng);

    expect(written).toBe(10000);

    const posts = await db
      .selectFrom('posts')
      .select(({ fn }) => fn.count<string>('id').as('n'))
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(Number(posts.n)).toBe(10000);
  });

  it('never targets a tag the author does not own', async () => {
    const orgId = await loadOrg(db, 'bench-tag-ownership');
    const members = await loadMembers(db, orgId, 200);
    const rng = makeRng(12);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const wrong = await db
      .selectFrom('post_audiences')
      .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
      .innerJoin('tags', 'tags.id', 'post_audiences.tag_id')
      .select('posts.id')
      .where('posts.org_id', '=', orgId)
      .whereRef('tags.owner_id', '!=', 'posts.author_id')
      .execute();
    expect(wrong).toHaveLength(0);
  });

  it('never targets a group the author does not belong to', async () => {
    const orgId = await loadOrg(db, 'bench-group-membership');
    const members = await loadMembers(db, orgId, 200);
    const rng = makeRng(13);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const wrong = await db
      .selectFrom('post_audiences')
      .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
      .leftJoin('group_members', (join) =>
        join
          .onRef('group_members.group_id', '=', 'post_audiences.group_id')
          .onRef('group_members.user_id', '=', 'posts.author_id'),
      )
      .select('posts.id')
      .where('posts.org_id', '=', orgId)
      .where('post_audiences.group_id', 'is not', null)
      .where('group_members.user_id', 'is', null)
      .execute();
    expect(wrong).toHaveLength(0);
  });

  it('leaves author-only prayers with zero audience rows', async () => {
    const orgId = await loadOrg(db, 'bench-author-only');
    const members = await loadMembers(db, orgId, 1000);
    const rng = makeRng(14);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const orphans = await db
      .selectFrom('posts')
      .leftJoin('post_audiences', 'post_audiences.post_id', 'posts.id')
      .select(({ fn }) => fn.count<string>('posts.id').as('n'))
      .where('posts.org_id', '=', orgId)
      .where('post_audiences.post_id', 'is', null)
      .executeTakeFirstOrThrow();
    expect(Number(orphans.n)).toBeGreaterThan(0);
  });

  it('gives every prayer a non-null edit_deadline', async () => {
    const orgId = await loadOrg(db, 'bench-deadline');
    const members = await loadMembers(db, orgId, 20);
    const rng = makeRng(15);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const rows = await db
      .selectFrom('posts')
      .select('edit_deadline')
      .where('org_id', '=', orgId)
      .limit(5)
      .execute();
    for (const r of rows) expect(r.edit_deadline).not.toBeNull();
  });

  it('decorrelates audience kind from post insertion order', async () => {
    // Regression test: AUDIENCE_MIX's fixed bucket order plus newId() being
    // called in the same author-major loop used to make audience kind
    // perfectly correlated with posts.id order. Since the feed orders by
    // posts.id DESC, that alone (not visibility) explained why isolated
    // members looked slow — the benchmark measured insert order, not
    // visibility. Under the old code, the first 1,000 posts by id (the
    // oldest) were 100% 'church' and the last 1,000 (the newest) were 0%
    // 'church'. Shuffled, both halves should land close to the overall
    // church share.
    const orgId = await loadOrg(db, 'bench-decorrelation');
    const members = await loadMembers(db, orgId, 1000);
    const rng = makeRng(16);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const rows = await db
      .selectFrom('posts')
      .select('body')
      .where('org_id', '=', orgId)
      .orderBy('id', 'asc')
      .execute();
    expect(rows).toHaveLength(10000);

    const kindOf = (body: string) => body.match(/\(([a-z_]+)\)$/)?.[1] ?? 'unknown';
    const churchShare = (bodies: string[]) =>
      bodies.filter((b) => kindOf(b) === 'church').length / bodies.length;

    const oldestThousand = rows.slice(0, 1000).map((r) => r.body);
    const newestThousand = rows.slice(-1000).map((r) => r.body);

    expect(Math.abs(churchShare(oldestThousand) - churchShare(newestThousand))).toBeLessThan(0.15);
  });

  it('keeps the exact AUDIENCE_MIX per-kind counts at N=1000 despite fallback repairs', async () => {
    // The shuffle-then-repair fallback (loadPrayers) only ever swaps pool
    // entries to satisfy a given author's group/tag constraints — it never
    // adds or removes one. So the per-kind totals below must match
    // AUDIENCE_MIX exactly, the same as before the shuffle was introduced.
    const orgId = await loadOrg(db, 'bench-mix-exact');
    const members = await loadMembers(db, orgId, 1000);
    const rng = makeRng(17);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const rows = await db.selectFrom('posts').select('body').where('org_id', '=', orgId).execute();

    const counts: Record<string, number> = {};
    for (const r of rows) {
      const kind = r.body.match(/\(([a-z_]+)\)$/)?.[1] ?? 'unknown';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }

    expect(counts).toEqual({
      church: 4000,
      one_group: 2200,
      multi_group: 900,
      one_tag: 1500,
      multi_tag: 400,
      group_and_tag: 800,
      author_only: 200,
    });
  });

  it('never leaves a multi_group or multi_tag post with a single audience row', async () => {
    // Regression test for the labeling bug: pickDistinct silently caps at
    // pool size, so a 'multi_*' post authored by someone with only one
    // candidate used to produce a single audience row while the body still
    // said "multi". isCompatible now requires >=2 candidates before a multi
    // kind is assigned at all.
    const orgId = await loadOrg(db, 'bench-multi-integrity');
    const members = await loadMembers(db, orgId, 1000);
    const rng = makeRng(18);
    const groups = await loadGroups(db, orgId, members, rng);
    const tags = await loadTags(db, orgId, members, rng);
    await loadPrayers(db, orgId, members, groups, tags, rng);

    const rows = await db
      .selectFrom('posts')
      .leftJoin('post_audiences', 'post_audiences.post_id', 'posts.id')
      .select(({ fn }) => ['posts.id', fn.count<string>('post_audiences.post_id').as('n')])
      .where('posts.org_id', '=', orgId)
      .where('posts.body', 'like', '%(multi_group)')
      .groupBy('posts.id')
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.n)).toBeGreaterThanOrEqual(2);

    const tagRows = await db
      .selectFrom('posts')
      .leftJoin('post_audiences', 'post_audiences.post_id', 'posts.id')
      .select(({ fn }) => ['posts.id', fn.count<string>('post_audiences.post_id').as('n')])
      .where('posts.org_id', '=', orgId)
      .where('posts.body', 'like', '%(multi_tag)')
      .groupBy('posts.id')
      .execute();
    expect(tagRows.length).toBeGreaterThan(0);
    for (const r of tagRows) expect(Number(r.n)).toBeGreaterThanOrEqual(2);
  });
});
