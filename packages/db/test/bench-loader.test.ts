import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GROUP_FIXTURES, makeRng } from '../src/bench-fixtures.js';
import { loadGroups, loadMembers, loadOrg, loadTags } from '../src/bench-loader.js';
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
