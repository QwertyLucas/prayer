# Bench Migrations and Data Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the six bench-only tables and a deterministic loader that fills `prayer_bench` with 1,000 members, 58 groups, 2,000 tags, and 10,000 prayers across seven audience categories.

**Architecture:** The bench tables live in `packages/db/bench-migrations/`, a directory applied only to `prayer_bench` and tracked in its own `pgmigrations_bench` table. They reference `orgs`, `users`, and `posts`, so `prayer_bench` runs the **main** migrations first and the bench migrations second. The loader writes directly via Kysely — never through the service layer, which would fire the `events` outbox for fixture data — and is driven by a seeded PRNG so every run produces byte-identical data.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Kysely 0.29, node-pg-migrate 7, Postgres 16, Vitest 4, tsx.

This is **plan 1 of 3**. It ends with a queryable dataset. Plan 2 adds `apps/bench-api` and the visibility query; plan 3 adds the timing harness.

## Global Constraints

- Node 24 required. Use `nvm exec 24 pnpm <cmd>` — pnpm bound to an older Node skips the rolldown native binding and Vitest fails with `MODULE_NOT_FOUND`.
- Relative imports MUST carry `.js` extensions, even though source is `.ts` (`"module": "NodeNext"`).
- IDs are UUIDv7 via `newId()` from `./ids.js`. They sort lexically in creation order — load-bearing for feed ordering.
- `exactOptionalPropertyTypes: true` — never pass `{ foo: value | undefined }`. Spread conditionally: `...(v !== undefined ? { foo: v } : {})`.
- Timestamps: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
- `posts.edit_deadline` is `NOT NULL` with no default — every insert must supply it.
- The bench tables MUST NOT appear in `packages/db/src/schema.ts`. Production code referencing them would compile and then fail at runtime against `prayer_dev`.
- Never run bench migrations against `prayer_dev` or any Supabase URL.
- Group roles are `leader | helper | member` — deliberately distinct from the `user_role` enum (`member | moderator | super_user`).

---

## File Structure

**Create:**

- `packages/db/bench-migrations/b001_roles.sql` — `roles`, `role_permissions`. No dependencies.
- `packages/db/bench-migrations/b002_groups.sql` — `groups`, `group_members`. Depends on b001, `orgs`, `users`.
- `packages/db/bench-migrations/b003_tags.sql` — `tags`, `tag_members`. Depends on `orgs`, `users`.
- `packages/db/bench-migrations/b004_post_audiences.sql` — `post_audiences`. Depends on b002, b003, `posts`.
- `packages/db/src/bench-schema.ts` — Kysely types for the six tables, plus `BenchDatabase`. Kept out of `schema.ts` on purpose.
- `packages/db/src/bench-fixtures.ts` — group names, tag names, distributions, the seeded PRNG. Pure data and pure functions, no DB access.
- `packages/db/src/bench-loader.ts` — the loader. Consumes fixtures, writes rows.
- `packages/db/test/bench-migrations.test.ts` — schema-level assertions (constraints, cascades).
- `packages/db/test/bench-loader.test.ts` — loader assertions (counts, distributions, referential sanity).

**Modify:**

- `packages/db/src/migrate.ts` — accept `dir` and `migrationsTable`.
- `packages/db/test/global-setup.ts` — apply bench migrations to the test DB too.
- `packages/db/package.json` — add the `bench:load` script.

---

### Task 1: Teach `migrate()` about alternate directories

`migrate()` currently hardcodes `../migrations`. The bench migrations need their own directory and their own tracking table so the two sets can never interleave.

**Files:**

- Modify: `packages/db/src/migrate.ts:11-17` (the `MigrateOptions` interface and `runner` call)
- Test: `packages/db/test/bench-migrations.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `migrate({ direction, databaseUrl, count?, dir?, migrationsTable? })`. `dir` is an absolute path; when omitted it stays `../migrations`. `migrationsTable` defaults to `'pgmigrations'`. Also exports `BENCH_MIGRATIONS_DIR: string` and `BENCH_MIGRATIONS_TABLE: 'pgmigrations_bench'`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-migrations.test.ts`:

```ts
import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from '../src/migrate.js';

const url = process.env.TEST_DATABASE_URL as string;

describe('bench migrations', () => {
  beforeAll(async () => {
    await migrate({
      direction: 'up',
      databaseUrl: url,
      dir: BENCH_MIGRATIONS_DIR,
      migrationsTable: BENCH_MIGRATIONS_TABLE,
    });
  });

  it('tracks bench migrations in their own table, separate from the main ones', async () => {
    const pool = new Pool({ connectionString: url });
    const bench = await pool.query(`SELECT name FROM ${BENCH_MIGRATIONS_TABLE} ORDER BY name`);
    const main = await pool.query('SELECT name FROM pgmigrations ORDER BY name');
    await pool.end();

    expect(bench.rows.map((r) => r.name as string)).toEqual([
      'b001_roles',
      'b002_groups',
      'b003_tags',
      'b004_post_audiences',
    ]);
    // The main table must not have learned about the bench files.
    expect(main.rows.map((r) => r.name as string)).not.toContain('b001_roles');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-migrations`
Expected: FAIL — `BENCH_MIGRATIONS_DIR` is not exported from `../src/migrate.js`.

- [ ] **Step 3: Implement**

Replace the body of `packages/db/src/migrate.ts` below the `__dirname` block:

```ts
const migrationsDir = path.resolve(__dirname, '..', 'migrations');

/** Bench-only tables. Applied solely to prayer_bench and the test DB — never to prayer_dev or Supabase. */
export const BENCH_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'bench-migrations');
export const BENCH_MIGRATIONS_TABLE = 'pgmigrations_bench';

export interface MigrateOptions {
  direction: 'up' | 'down';
  databaseUrl: string;
  count?: number;
  /** Absolute path to a migrations directory. Defaults to packages/db/migrations. */
  dir?: string;
  /** Tracking table. Defaults to 'pgmigrations'. Use a distinct table for a distinct dir. */
  migrationsTable?: string;
}

export async function migrate({
  direction,
  databaseUrl,
  count,
  dir,
  migrationsTable,
}: MigrateOptions): Promise<void> {
  await runner({
    databaseUrl,
    dir: dir ?? migrationsDir,
    migrationsTable: migrationsTable ?? 'pgmigrations',
    direction,
    count: count ?? (direction === 'up' ? Infinity : 1),
    logger: {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
      debug: () => {},
    },
  });
}
```

- [ ] **Step 4: Create the four migration files**

`packages/db/bench-migrations/b001_roles.sql`:

```sql
-- Up Migration
CREATE TABLE roles (
  role TEXT PRIMARY KEY
);

CREATE TABLE role_permissions (
  role        TEXT NOT NULL REFERENCES roles(role) ON DELETE CASCADE,
  access_type TEXT NOT NULL,
  PRIMARY KEY (role, access_type)
);

INSERT INTO roles (role) VALUES ('leader'), ('helper'), ('member');

INSERT INTO role_permissions (role, access_type) VALUES
  ('leader', 'manage_members'),
  ('leader', 'hide_posts'),
  ('leader', 'post'),
  ('helper', 'post'),
  ('member', 'read');

-- Down Migration
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
```

`packages/db/bench-migrations/b002_groups.sql`:

```sql
-- Up Migration
CREATE TABLE groups (
  id        UUID PRIMARY KEY,
  church_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX idx_groups_church_id ON groups (church_id);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' REFERENCES roles(role),
  PRIMARY KEY (group_id, user_id)
);
-- Reverse lookup: "which groups is this member in?" drives the feed direction.
CREATE INDEX idx_group_members_user_id ON group_members (user_id);

-- Down Migration
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
```

`packages/db/bench-migrations/b003_tags.sql`:

```sql
-- Up Migration
CREATE TABLE tags (
  id        UUID PRIMARY KEY,
  owner_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  church_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX idx_tags_owner_id ON tags (owner_id);

CREATE TABLE tag_members (
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, user_id)
);
CREATE INDEX idx_tag_members_user_id ON tag_members (user_id);

-- Down Migration
DROP TABLE IF EXISTS tag_members;
DROP TABLE IF EXISTS tags;
```

`packages/db/bench-migrations/b004_post_audiences.sql`:

```sql
-- Up Migration
-- Points at a SET, never at a person: adding someone to a tag never rewrites post rows.
-- Three nullable FKs + CHECK replaces a polymorphic (kind, id) pair so deletes cascade
-- and a row pointing at a nonexistent audience is impossible.
CREATE TABLE post_audiences (
  post_id   UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  church_id UUID NULL REFERENCES orgs(id) ON DELETE CASCADE,
  group_id  UUID NULL REFERENCES groups(id) ON DELETE CASCADE,
  tag_id    UUID NULL REFERENCES tags(id) ON DELETE CASCADE,
  CHECK (num_nonnulls(church_id, group_id, tag_id) = 1)
);

CREATE UNIQUE INDEX idx_post_audiences_unique
  ON post_audiences (post_id, COALESCE(church_id, group_id, tag_id));
CREATE INDEX idx_post_audiences_post_id ON post_audiences (post_id);
CREATE INDEX idx_post_audiences_group_id ON post_audiences (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_post_audiences_tag_id ON post_audiences (tag_id) WHERE tag_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS post_audiences;
```

- [ ] **Step 5: Wire bench migrations into the test database**

In `packages/db/test/global-setup.ts`, replace the final `migrate` call in `setup()`:

```ts
await migrate({ direction: 'up', databaseUrl: testUrl });
await migrate({
  direction: 'up',
  databaseUrl: testUrl,
  dir: BENCH_MIGRATIONS_DIR,
  migrationsTable: BENCH_MIGRATIONS_TABLE,
});
```

And extend the import at the top:

```ts
import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from '../src/migrate.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-migrations`
Expected: PASS.

- [ ] **Step 7: Add constraint tests**

Append to `packages/db/test/bench-migrations.test.ts`, inside the `describe`:

```ts
it('rejects an audience row naming two audiences at once', async () => {
  const pool = new Pool({ connectionString: url });
  await expect(
    pool.query(
      `INSERT INTO post_audiences (post_id, church_id, group_id)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    ),
  ).rejects.toThrow();
  await pool.end();
});

it('rejects an audience row naming no audience at all', async () => {
  const pool = new Pool({ connectionString: url });
  await expect(
    pool.query(`INSERT INTO post_audiences (post_id) VALUES (gen_random_uuid())`),
  ).rejects.toThrow();
  await pool.end();
});

it('rejects a group member with an unknown role', async () => {
  const pool = new Pool({ connectionString: url });
  await expect(
    pool.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'wizard')`,
    ),
  ).rejects.toThrow();
  await pool.end();
});
```

- [ ] **Step 8: Run the tests**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-migrations`
Expected: PASS — 4 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/db/bench-migrations packages/db/src/migrate.ts \
        packages/db/test/global-setup.ts packages/db/test/bench-migrations.test.ts
git commit -m "feat(db): bench-only migrations for groups, tags, audiences, roles"
```

---

### Task 2: Bench Kysely types

**Files:**

- Create: `packages/db/src/bench-schema.ts`

**Interfaces:**

- Consumes: `Database` from `./schema.js`.
- Produces: `BenchDatabase` (the production `Database` plus the six bench tables), `GroupRole = 'leader' | 'helper' | 'member'`, and `createBenchDb(connectionString: string): Kysely<BenchDatabase>`.

- [ ] **Step 1: Write the file**

```ts
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

/** Group-scoped roles. Deliberately distinct from `UserRole` (church-scoped). */
export type GroupRole = 'leader' | 'helper' | 'member';

export interface RolesTable {
  role: string;
}

export interface RolePermissionsTable {
  role: string;
  access_type: string;
}

export interface GroupsTable {
  id: string;
  church_id: string;
  name: string;
}

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  role: GroupRole;
}

export interface TagsTable {
  id: string;
  owner_id: string;
  church_id: string;
  name: string;
}

export interface TagMembersTable {
  tag_id: string;
  user_id: string;
}

export interface PostAudiencesTable {
  post_id: string;
  church_id: string | null;
  group_id: string | null;
  tag_id: string | null;
}

/**
 * Production tables plus the bench-only ones. Kept out of `schema.ts` on purpose:
 * these tables do not exist in prayer_dev or the deployed database, so production
 * code must not be able to reference them.
 */
export interface BenchDatabase extends Database {
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  tags: TagsTable;
  tag_members: TagMembersTable;
  post_audiences: PostAudiencesTable;
}

export type BenchDb = Kysely<BenchDatabase>;

export function createBenchDb(connectionString: string): BenchDb {
  return new Kysely<BenchDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `nvm exec 24 pnpm --filter @prayer/db build`
Expected: success, no output.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/bench-schema.ts
git commit -m "feat(db): Kysely types for the bench tables"
```

---

### Task 3: Fixtures and deterministic PRNG

Pure data and pure functions. No database access, so it tests fast and in isolation.

**Files:**

- Create: `packages/db/src/bench-fixtures.ts`
- Test: `packages/db/test/bench-fixtures.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `makeRng(seed: number): () => number` — mulberry32, returns `[0, 1)`.
  - `GROUP_FIXTURES: readonly GroupFixture[]` where `GroupFixture = { name: string; tier: 'life_stage' | 'ministry' | 'home' }` — exactly 58 entries.
  - `TAG_NAMES: readonly string[]` — 6 entries.
  - `GROUP_COUNT_BUCKETS: readonly { groups: number; members: number }[]` summing to 1,000 members and 2,300 memberships.
  - `AUDIENCE_MIX: readonly { kind: AudienceKind; count: number }[]` summing to 10,000, where `AudienceKind = 'church' | 'one_group' | 'multi_group' | 'one_tag' | 'multi_tag' | 'group_and_tag' | 'author_only'`.
  - `pick<T>(rng: () => number, xs: readonly T[]): T`
  - `pickDistinct<T>(rng: () => number, xs: readonly T[], n: number): T[]`
  - `expand<T>(buckets: readonly { count: number; value: T }[]): T[]`

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AUDIENCE_MIX,
  GROUP_COUNT_BUCKETS,
  GROUP_FIXTURES,
  TAG_NAMES,
  makeRng,
  pickDistinct,
} from '../src/bench-fixtures.js';

describe('bench fixtures', () => {
  it('defines 58 groups across three tiers', () => {
    expect(GROUP_FIXTURES).toHaveLength(58);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'life_stage')).toHaveLength(6);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'ministry')).toHaveLength(12);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'home')).toHaveLength(40);
  });

  it('has unique group names', () => {
    expect(new Set(GROUP_FIXTURES.map((g) => g.name)).size).toBe(58);
  });

  it('covers exactly 1,000 members and 2,300 memberships', () => {
    const members = GROUP_COUNT_BUCKETS.reduce((a, b) => a + b.members, 0);
    const memberships = GROUP_COUNT_BUCKETS.reduce((a, b) => a + b.groups * b.members, 0);
    expect(members).toBe(1000);
    expect(memberships).toBe(2300);
  });

  it('seeds 100 members into zero groups — the slow-feed case', () => {
    const isolated = GROUP_COUNT_BUCKETS.find((b) => b.groups === 0);
    expect(isolated?.members).toBe(100);
  });

  it('splits 10,000 prayers across seven audience kinds', () => {
    expect(AUDIENCE_MIX.reduce((a, b) => a + b.count, 0)).toBe(10000);
    expect(AUDIENCE_MIX).toHaveLength(7);
  });

  it('offers six tag names', () => {
    expect(TAG_NAMES).toHaveLength(6);
  });

  it('produces identical sequences for identical seeds', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different sequences for different seeds', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it('picks n distinct items', () => {
    const rng = makeRng(7);
    const got = pickDistinct(rng, [1, 2, 3, 4, 5], 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  it('caps pickDistinct at the pool size instead of looping forever', () => {
    expect(pickDistinct(makeRng(7), [1, 2], 10)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-fixtures`
Expected: FAIL — cannot resolve `../src/bench-fixtures.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-fixtures.ts`:

```ts
/**
 * Fixture data and deterministic helpers for the benchmark dataset.
 * Pure — no database access, no clock, no Math.random. Same seed, same dataset,
 * every run, which is what makes two benchmark runs comparable.
 */

export type GroupTier = 'life_stage' | 'ministry' | 'home';

export interface GroupFixture {
  name: string;
  tier: GroupTier;
}

export type AudienceKind =
  | 'church'
  | 'one_group'
  | 'multi_group'
  | 'one_tag'
  | 'multi_tag'
  | 'group_and_tag'
  | 'author_only';

/** mulberry32 — small, fast, and reproducible across platforms. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rng() * xs.length)];
  if (x === undefined) throw new Error('pick called on an empty array');
  return x;
}

/** Returns up to `n` distinct items. Never loops forever when n > xs.length. */
export function pickDistinct<T>(rng: () => number, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  const target = Math.min(n, pool.length);
  while (out.length < target) {
    const i = Math.floor(rng() * pool.length);
    const [taken] = pool.splice(i, 1);
    if (taken !== undefined) out.push(taken);
  }
  return out;
}

/** Turns [{count: 2, value: 'a'}] into ['a', 'a']. */
export function expand<T>(buckets: readonly { count: number; value: T }[]): T[] {
  const out: T[] = [];
  for (const b of buckets) {
    for (let i = 0; i < b.count; i++) out.push(b.value);
  }
  return out;
}

const HOME_GROUPS: GroupFixture[] = Array.from({ length: 40 }, (_, i) => ({
  name: `Home Group ${String(i + 1).padStart(2, '0')}`,
  tier: 'home' as const,
}));

export const GROUP_FIXTURES: readonly GroupFixture[] = [
  { name: 'Youth Group', tier: 'life_stage' },
  { name: 'Young Adults', tier: 'life_stage' },
  { name: "Men's Fellowship", tier: 'life_stage' },
  { name: "Women's Fellowship", tier: 'life_stage' },
  { name: 'Seniors Fellowship', tier: 'life_stage' },
  { name: 'Married Couples', tier: 'life_stage' },
  { name: 'Sunday Worship Team', tier: 'ministry' },
  { name: 'Saturday Worship Team', tier: 'ministry' },
  { name: 'Youth Leadership', tier: 'ministry' },
  { name: 'Toddler & Nursery', tier: 'ministry' },
  { name: "Children's Ministry", tier: 'ministry' },
  { name: 'Media & Tech', tier: 'ministry' },
  { name: 'Ushers & Hospitality', tier: 'ministry' },
  { name: 'Prayer Team', tier: 'ministry' },
  { name: 'Outreach & Missions', tier: 'ministry' },
  { name: 'Care Team', tier: 'ministry' },
  { name: 'Finance & Admin', tier: 'ministry' },
  { name: 'Facilities', tier: 'ministry' },
  ...HOME_GROUPS,
];

export const TAG_NAMES: readonly string[] = [
  'family',
  'close friends',
  'prayer partners',
  'work',
  'college',
  'neighbours',
];

/**
 * How many groups each member belongs to. The 100 zero-group members are
 * deliberate: a well-connected member's feed is fast because Postgres finds 20
 * visible posts and stops, while an isolated member forces a walk back through
 * thousands of invisible posts to fill one page. Without them the benchmark
 * only ever reports the easy case.
 *
 * 0*100 + 1*300 + 2.5*350 + 4.5*250 = 2,300 memberships across 1,000 members.
 */
export const GROUP_COUNT_BUCKETS: readonly { groups: number; members: number }[] = [
  { groups: 0, members: 100 },
  { groups: 1, members: 300 },
  { groups: 2, members: 175 },
  { groups: 3, members: 175 },
  { groups: 4, members: 130 },
  { groups: 5, members: 115 },
  { groups: 6, members: 5 },
];
// members:     100 + 300 + 175 + 175 + 130 + 115 +  5 = 1,000
// memberships:   0 + 300 + 350 + 525 + 520 + 575 + 30 = 2,300

/** 10,000 prayers. Church-wide is a superset, so it never combines with a group or tag. */
export const AUDIENCE_MIX: readonly { kind: AudienceKind; count: number }[] = [
  { kind: 'church', count: 4000 },
  { kind: 'one_group', count: 2200 },
  { kind: 'multi_group', count: 900 },
  { kind: 'one_tag', count: 1500 },
  { kind: 'multi_tag', count: 400 },
  { kind: 'group_and_tag', count: 800 },
  { kind: 'author_only', count: 200 },
];
```

- [ ] **Step 4: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-fixtures`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-fixtures.ts packages/db/test/bench-fixtures.test.ts
git commit -m "feat(db): deterministic fixtures for the benchmark dataset"
```

---

### Task 4: Load the church and its members

**Files:**

- Create: `packages/db/src/bench-loader.ts`
- Test: `packages/db/test/bench-loader.test.ts`

**Interfaces:**

- Consumes: `createBenchDb`, `BenchDb` (Task 2); `makeRng` (Task 3); `newId` from `./ids.js`.
- Produces: `loadMembers(db: BenchDb, orgId: string, count: number): Promise<string[]>` returning member ids in creation order, and `loadOrg(db: BenchDb, slug: string): Promise<string>` returning the org id.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-loader.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import { loadMembers, loadOrg } from '../src/bench-loader.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: FAIL — cannot resolve `../src/bench-loader.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-loader.ts`:

```ts
import { newId } from './ids.js';
import type { BenchDb } from './bench-schema.js';

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
      email: `m${String(i).padStart(5, '0')}.${orgId.slice(0, 8)}@bench.invalid`,
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
```

- [ ] **Step 4: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-loader.ts packages/db/test/bench-loader.test.ts
git commit -m "feat(db): bench loader for org and members"
```

---

### Task 5: Load groups and memberships

**Files:**

- Modify: `packages/db/src/bench-loader.ts` (append)
- Modify: `packages/db/test/bench-loader.test.ts` (append)

**Interfaces:**

- Consumes: `loadMembers` (Task 4); `GROUP_FIXTURES`, `GROUP_COUNT_BUCKETS`, `makeRng`, `pickDistinct`, `expand` (Task 3).
- Produces: `loadGroups(db, orgId, memberIds, rng): Promise<Map<string, string[]>>` — a map from member id to the group ids they belong to. Later tasks need this to pick realistic group audiences.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/bench-loader.test.ts`:

```ts
import { GROUP_FIXTURES, makeRng } from '../src/bench-fixtures.js';
import { loadGroups } from '../src/bench-loader.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: FAIL — `loadGroups` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/db/src/bench-loader.ts`:

```ts
import { GROUP_COUNT_BUCKETS, GROUP_FIXTURES, expand, pickDistinct } from './bench-fixtures.js';

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
```

- [ ] **Step 4: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: PASS — 7 tests.

If the 2,300 assertion fails, the bucket arithmetic in Task 3 is off. Fix `GROUP_COUNT_BUCKETS` — not this test.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-loader.ts packages/db/test/bench-loader.test.ts
git commit -m "feat(db): load groups and memberships with an isolated-member cohort"
```

---

### Task 6: Load tags and tag members

**Files:**

- Modify: `packages/db/src/bench-loader.ts` (append)
- Modify: `packages/db/test/bench-loader.test.ts` (append)

**Interfaces:**

- Consumes: `loadMembers` (Task 4); `TAG_NAMES`, `pick`, `pickDistinct` (Task 3).
- Produces: `loadTags(db, orgId, memberIds, rng): Promise<Map<string, string[]>>` — owner id to the tag ids they own. A prayer can only target a tag its author owns, so later tasks need this keyed by owner.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/bench-loader.test.ts`:

```ts
import { loadTags } from '../src/bench-loader.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: FAIL — `loadTags` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/db/src/bench-loader.ts`:

```ts
import { TAG_NAMES } from './bench-fixtures.js';

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
```

- [ ] **Step 4: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-loader.ts packages/db/test/bench-loader.test.ts
git commit -m "feat(db): load personal tags and their members"
```

---

### Task 7: Load prayers and audiences

The heart of the dataset. Each author writes 10 prayers; the audience mix decides what each targets.

**Files:**

- Modify: `packages/db/src/bench-loader.ts` (append)
- Modify: `packages/db/test/bench-loader.test.ts` (append)

**Interfaces:**

- Consumes: `loadGroups` (Task 5), `loadTags` (Task 6); `AUDIENCE_MIX`, `expand`, `pick`, `pickDistinct` (Task 3).
- Produces: `loadPrayers(db, orgId, memberIds, groupsByMember, tagsByOwner, rng): Promise<number>` returning the number of prayers written.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/bench-loader.test.ts`:

```ts
import { loadPrayers } from '../src/bench-loader.js';

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: FAIL — `loadPrayers` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/db/src/bench-loader.ts`. **Merge the new imports into the single existing `./bench-fixtures.js` import statement at the top of the file** — three separate imports from one module will trip `no-duplicate-imports` in `pnpm lint`. After this task the one import line should read:

```ts
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
```

The implementation to append:

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-loader.ts packages/db/test/bench-loader.test.ts
git commit -m "feat(db): load prayers with group, tag, and church audiences"
```

---

### Task 8: CLI entry point and end-to-end verification

**Files:**

- Create: `packages/db/src/bench-load-cli.ts`
- Modify: `packages/db/package.json` (scripts)
- Modify: `packages/db/test/bench-loader.test.ts` (append)

**Interfaces:**

- Consumes: everything above.
- Produces: `pnpm --filter @prayer/db bench:load`, plus `loadBenchDataset(db, opts): Promise<BenchSummary>` where `BenchSummary = { orgId: string; members: number; groups: number; tags: number; prayers: number; audiences: number }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/bench-loader.test.ts`:

```ts
import { loadBenchDataset } from '../src/bench-loader.js';

describe('loadBenchDataset', () => {
  it('reports a summary matching what it wrote', async () => {
    const summary = await loadBenchDataset(db, { slug: 'bench-full', members: 200, seed: 21 });

    expect(summary.members).toBe(200);
    expect(summary.groups).toBe(58);
    expect(summary.prayers).toBe(2000);
    expect(summary.tags).toBeGreaterThanOrEqual(200);
    expect(summary.audiences).toBeGreaterThan(0);

    const actual = await db
      .selectFrom('post_audiences')
      .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
      .select(({ fn }) => fn.count<string>('post_audiences.post_id').as('n'))
      .where('posts.org_id', '=', summary.orgId)
      .executeTakeFirstOrThrow();
    expect(Number(actual.n)).toBe(summary.audiences);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: FAIL — `loadBenchDataset` is not exported.

- [ ] **Step 3: Implement the orchestrator**

Append to `packages/db/src/bench-loader.ts`:

```ts
export interface BenchSummary {
  orgId: string;
  members: number;
  groups: number;
  tags: number;
  prayers: number;
  audiences: number;
}

export interface LoadOptions {
  slug: string;
  members: number;
  seed: number;
}

/** Runs the whole load in fixture order. One RNG threads through so the run is reproducible. */
export async function loadBenchDataset(db: BenchDb, opts: LoadOptions): Promise<BenchSummary> {
  const rng = makeRng(opts.seed);
  const orgId = await loadOrg(db, opts.slug);
  const members = await loadMembers(db, orgId, opts.members);
  const groups = await loadGroups(db, orgId, members, rng);
  const tags = await loadTags(db, orgId, members, rng);
  const prayers = await loadPrayers(db, orgId, members, groups, tags, rng);

  const tagCount = [...tags.values()].reduce((a, b) => a + b.length, 0);
  const audiences = await db
    .selectFrom('post_audiences')
    .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
    .select(({ fn }) => fn.count<string>('post_audiences.post_id').as('n'))
    .where('posts.org_id', '=', orgId)
    .executeTakeFirstOrThrow();

  return {
    orgId,
    members: members.length,
    groups: GROUP_FIXTURES.length,
    tags: tagCount,
    prayers,
    audiences: Number(audiences.n),
  };
}
```

Add `makeRng` to the existing `bench-fixtures.js` import at the top of the file.

- [ ] **Step 4: Write the CLI**

Create `packages/db/src/bench-load-cli.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { createBenchDb } from './bench-schema.js';
import { loadBenchDataset } from './bench-loader.js';
import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `Refusing to load benchmark data into a non-local database (${host}).\n` +
        'The bench dataset is ~40k rows and must never touch the live deployment.',
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.BENCH_DATABASE_URL;
  if (!url) throw new Error('BENCH_DATABASE_URL is required');
  assertLocal(url);

  console.log('Applying main migrations…');
  await migrate({ direction: 'up', databaseUrl: url });
  console.log('Applying bench migrations…');
  await migrate({
    direction: 'up',
    databaseUrl: url,
    dir: BENCH_MIGRATIONS_DIR,
    migrationsTable: BENCH_MIGRATIONS_TABLE,
  });

  const db = createBenchDb(url);
  try {
    const summary = await loadBenchDataset(db, { slug: 'bench', members: 1000, seed: 1 });
    console.log('\nLoaded:');
    console.log(`  org        ${summary.orgId}`);
    console.log(`  members    ${summary.members}`);
    console.log(`  groups     ${summary.groups}`);
    console.log(`  tags       ${summary.tags}`);
    console.log(`  prayers    ${summary.prayers}`);
    console.log(`  audiences  ${summary.audiences}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Add the script**

In `packages/db/package.json`, add to `scripts`:

```json
"bench:load": "tsx src/bench-load-cli.ts"
```

- [ ] **Step 6: Run the test**

Run: `nvm exec 24 pnpm --filter @prayer/db test bench-loader`
Expected: PASS — 17 tests.

- [ ] **Step 7: Load the real dataset**

```bash
docker exec prayer-postgres psql -U postgres -c "CREATE DATABASE prayer_bench;"
BENCH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/prayer_bench \
  nvm exec 24 pnpm --filter @prayer/db bench:load
```

Expected output: members 1000, groups 58, tags ~2000, prayers 10000, audiences ~12500.

- [ ] **Step 8: Verify the shape by hand**

```bash
docker exec prayer-postgres psql -U postgres -d prayer_bench -c "
SELECT 'members' t, count(*) FROM users
UNION ALL SELECT 'groups', count(*) FROM groups
UNION ALL SELECT 'group_members', count(*) FROM group_members
UNION ALL SELECT 'tags', count(*) FROM tags
UNION ALL SELECT 'tag_members', count(*) FROM tag_members
UNION ALL SELECT 'prayers', count(*) FROM posts
UNION ALL SELECT 'audiences', count(*) FROM post_audiences
UNION ALL SELECT 'isolated members', count(*) FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = u.id);"
```

Expected: `isolated members` is 100. If it is 0, the loader is not producing the slow-feed cohort and plan 3 will report only the easy case.

- [ ] **Step 9: Confirm prayer_dev was untouched**

```bash
docker exec prayer-postgres psql -U postgres -d prayer_dev -c "\dt" | grep -cE "groups|tags|post_audiences|roles"
```

Expected: `0`. Any other number means bench migrations leaked into the app database.

- [ ] **Step 10: Full check and commit**

```bash
nvm exec 24 pnpm --filter @prayer/db test
nvm exec 24 pnpm --filter @prayer/db build
nvm exec 24 pnpm format && nvm exec 24 pnpm lint
git add packages/db/src/bench-load-cli.ts packages/db/src/bench-loader.ts \
        packages/db/package.json packages/db/test/bench-loader.test.ts
git commit -m "feat(db): bench:load CLI and dataset summary"
```

---

## What plan 1 does not cover

- The visibility query and `GET /bench/feed` — plan 2.
- The correctness oracle and the differential test against the feed — plan 2.
- Timing, percentiles, and index experiments — plan 3.
- Feed index strategy, deliberately deferred until there is data to measure against.
