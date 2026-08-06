import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMembers, loadOrg } from '../src/bench-loader.js';
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
