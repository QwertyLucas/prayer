# Point-Check Timing Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and measure the permission check — "can this person see this prayer?" — against the bench datasets, producing a results table fit for a written report.

**Architecture:** The check and everything that measures it live in `packages/db`, where the existing test suite already applies the bench migrations to `prayer_test`. A thin Express app, `apps/bench-api`, is only a control channel: it parses a request, calls the runner, writes two result files, and responds. Bench code reaches `apps/bench-api` through a **new `@prayer/db/bench` export subpath**, so production code importing `@prayer/db` still cannot see the bench tables.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Kysely 0.29, Postgres 16, Express 5, zod 4, Vitest 4, supertest 7, tsx.

Design spec: `docs/superpowers/specs/2026-08-06-point-check-timing-harness-design.md`.
Dataset spec: `docs/superpowers/specs/2026-08-05-group-tag-visibility-design.md`.

## Global Constraints

- Node 24. **There is no `nvm` on this machine** — `node` and `pnpm` are already v24.15.0. Use plain `pnpm <cmd>`; `nvm exec 24 pnpm …` fails with `command not found: nvm`.
- ESM + `"module": "NodeNext"` → relative imports MUST carry `.js` extensions even though source is `.ts`.
- `exactOptionalPropertyTypes: true` → never pass `{ foo: value | undefined }`. Spread conditionally: `...(v !== undefined ? { foo: v } : {})`.
- `noUncheckedIndexedAccess: true` → indexed access yields `T | undefined`. Every array index needs a guard.
- **The bench tables MUST NOT appear in `packages/db/src/schema.ts`, and bench code MUST NOT be exported from `packages/db/src/index.ts`.** Production code referencing these tables would compile and then fail at runtime against `prayer_dev`. Bench consumers use the `@prayer/db/bench` subpath added in Task 6.
- Never run bench migrations against `prayer_dev` or any Supabase URL.
- IDs are UUIDv7 via `newId()` from `./ids.js`.
- `posts.edit_deadline` is `NOT NULL` with no default — every insert must supply it.
- Test data is written directly via Kysely, never through the service layer. Same rule as `bootstrap.ts`.
- Church-scoped roles are `member | moderator | super_user` (`user_orgs.role`). Group-scoped roles are `leader | helper | member` (`group_members.role`). They are deliberately different; do not conflate them.
- `eslint-plugin-import`'s `import/order` rule is enforced: builtin, external, internal, parent, sibling, index — alphabetised, with blank lines between groups. `no-duplicate-imports` is enforced; merge multiple imports from one module into one statement.
- Tests read `TEST_DATABASE_URL` from the repo-root `.env`. `packages/db/test/global-setup.ts` already applies both the main and bench migrations to it.
- Root `pnpm dev` is `pnpm -r --parallel dev`, so **`apps/bench-api` must NOT define a `dev` script** — it would start on every `pnpm dev`. Use `serve` instead.

## The visibility rules being implemented

| #   | Audience    | Rule                                                                              |
| --- | ----------- | --------------------------------------------------------------------------------- |
| ①   | Church-wide | `author = M OR M belongs to that church`                                          |
| ②   | Group       | `author = M OR M ∈ group_members OR user_orgs.role IN ('moderator','super_user')` |
| ③   | Tag         | `author = M OR M ∈ tag_members` — **no role clause; sealed**                      |

A prayer with no audience rows is visible to its author alone. Audience rows are evaluated independently: a prayer targeting both a group and a tag IS moderator-visible via its group row.

---

## File Structure

**Create:**

- `packages/db/test/helpers/visibility-fixtures.ts` — fixture builder shared by Tasks 1, 2 and 6.
- `packages/db/src/bench-visibility.ts` — `canSee`, the SQL check under test.
- `packages/db/test/bench-visibility.test.ts`
- `packages/db/src/bench-visibility-reference.ts` — the independent TypeScript reference.
- `packages/db/test/bench-visibility-reference.test.ts`
- `packages/db/src/bench-sampler.ts` — seeded random (viewer, prayer) pairs, labelled.
- `packages/db/test/bench-sampler.test.ts`
- `packages/db/src/bench-timing.ts` — the timing runner.
- `packages/db/test/bench-timing.test.ts`
- `packages/db/src/bench-results.ts` — percentiles, Markdown rendering, file writing.
- `packages/db/test/bench-results.test.ts`
- `packages/db/src/bench.ts` — the `@prayer/db/bench` entry point.
- `apps/bench-api/package.json`, `tsconfig.json`, `vitest.config.ts`
- `apps/bench-api/src/app.ts`, `src/server.ts`
- `apps/bench-api/test/point-check.test.ts`
- `docs/bench-results/.gitkeep`

**Modify:**

- `packages/db/package.json` — add the `./bench` export subpath (Task 6).
- `tsconfig.json` (root) — add the `apps/bench-api` reference (Task 6).

---

### Task 1: The permission check

The heart of the work. A direct, naive expression of the three rules — written to be obviously correct, not fast. Everything else measures this.

**Files:**

- Create: `packages/db/test/helpers/visibility-fixtures.ts`
- Create: `packages/db/src/bench-visibility.ts`
- Test: `packages/db/test/bench-visibility.test.ts`

**Interfaces:**

- Consumes: `BenchDb`, `createBenchDb` from `./bench-schema.js`; `newId` from `./ids.js`.
- Produces:
  - `type VisibilityRule = 'author' | 'church' | 'group' | 'group_moderator' | 'tag'`
  - `interface CanSeeResult { visible: boolean; rule: VisibilityRule | null }`
  - `canSee(db: BenchDb, viewerId: string, postId: string): Promise<CanSeeResult>`
  - From the test helper: `buildVisibilityFixture(db, slug): Promise<VisibilityFixture>` (see its shape below).

- [ ] **Step 1: Write the fixture helper**

Create `packages/db/test/helpers/visibility-fixtures.ts`:

```ts
import { newId } from '../../src/ids.js';
import type { BenchDb } from '../../src/bench-schema.js';

/**
 * A small, hand-built world covering every visibility rule and its negation.
 *
 * Deliberately not generated by the bench loader: the loader draws at random,
 * and a test that asserts the tag seal needs a moderator who is *provably* not
 * in the tag, not one who happens not to be this run.
 */
export interface VisibilityFixture {
  orgId: string;
  otherOrgId: string;
  /** Author of every prayer below. */
  authorId: string;
  /** Plain member of the church, in the group, not in the tag. */
  groupMemberId: string;
  /** Plain member of the church, in the tag, not in the group. */
  tagMemberId: string;
  /** Plain member of the church, in neither the group nor the tag. */
  outsiderId: string;
  /** Church moderator, in neither the group nor the tag. */
  moderatorId: string;
  /** Church super_user, in neither the group nor the tag. */
  superUserId: string;
  /** Church moderator who IS also in the group. */
  moderatorInGroupId: string;
  /** Member of a different church entirely. */
  foreignerId: string;

  groupId: string;
  tagId: string;

  churchPostId: string;
  groupPostId: string;
  tagPostId: string;
  groupAndTagPostId: string;
  authorOnlyPostId: string;
}

export async function buildVisibilityFixture(
  db: BenchDb,
  slug: string,
): Promise<VisibilityFixture> {
  const orgId = newId();
  const otherOrgId = newId();
  await db
    .insertInto('orgs')
    .values([
      { id: orgId, slug, display_name: `Fixture (${slug})` },
      { id: otherOrgId, slug: `${slug}-other`, display_name: `Fixture other (${slug})` },
    ])
    .execute();

  const person = (
    label: string,
  ): { id: string; supabase_auth_id: string; email: string; display_name: string } => {
    const id = newId();
    return {
      id,
      supabase_auth_id: newId(),
      email: `${label}.${id}@fixture.invalid`,
      display_name: label,
    };
  };

  const author = person('author');
  const groupMember = person('group-member');
  const tagMember = person('tag-member');
  const outsider = person('outsider');
  const moderator = person('moderator');
  const superUser = person('super-user');
  const moderatorInGroup = person('moderator-in-group');
  const foreigner = person('foreigner');

  await db
    .insertInto('users')
    .values([
      author,
      groupMember,
      tagMember,
      outsider,
      moderator,
      superUser,
      moderatorInGroup,
      foreigner,
    ])
    .execute();

  await db
    .insertInto('user_orgs')
    .values([
      { user_id: author.id, org_id: orgId, role: 'member' },
      { user_id: groupMember.id, org_id: orgId, role: 'member' },
      { user_id: tagMember.id, org_id: orgId, role: 'member' },
      { user_id: outsider.id, org_id: orgId, role: 'member' },
      { user_id: moderator.id, org_id: orgId, role: 'moderator' },
      { user_id: superUser.id, org_id: orgId, role: 'super_user' },
      { user_id: moderatorInGroup.id, org_id: orgId, role: 'moderator' },
      { user_id: foreigner.id, org_id: otherOrgId, role: 'member' },
    ])
    .execute();

  const groupId = newId();
  await db
    .insertInto('groups')
    .values({ id: groupId, church_id: orgId, name: 'Fixture Group' })
    .execute();
  await db
    .insertInto('group_members')
    .values([
      { group_id: groupId, user_id: groupMember.id, role: 'member' },
      { group_id: groupId, user_id: moderatorInGroup.id, role: 'member' },
    ])
    .execute();

  // The author owns the tag but is NOT a member of it — mirrors the real shape
  // and makes the author clause load-bearing rather than decorative.
  const tagId = newId();
  await db
    .insertInto('tags')
    .values({ id: tagId, owner_id: author.id, church_id: orgId, name: 'fixture tag' })
    .execute();
  await db.insertInto('tag_members').values({ tag_id: tagId, user_id: tagMember.id }).execute();

  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const post = (
    label: string,
  ): {
    id: string;
    org_id: string;
    parent_id: null;
    author_id: string;
    body: string;
    status: 'published';
    edit_deadline: Date;
  } => ({
    id: newId(),
    org_id: orgId,
    parent_id: null,
    author_id: author.id,
    body: `fixture ${label}`,
    status: 'published',
    edit_deadline: deadline,
  });

  const churchPost = post('church');
  const groupPost = post('group');
  const tagPost = post('tag');
  const groupAndTagPost = post('group+tag');
  const authorOnlyPost = post('author-only');

  await db
    .insertInto('posts')
    .values([churchPost, groupPost, tagPost, groupAndTagPost, authorOnlyPost])
    .execute();

  await db
    .insertInto('post_audiences')
    .values([
      { post_id: churchPost.id, church_id: orgId, group_id: null, tag_id: null },
      { post_id: groupPost.id, church_id: null, group_id: groupId, tag_id: null },
      { post_id: tagPost.id, church_id: null, group_id: null, tag_id: tagId },
      { post_id: groupAndTagPost.id, church_id: null, group_id: groupId, tag_id: null },
      { post_id: groupAndTagPost.id, church_id: null, group_id: null, tag_id: tagId },
      // authorOnlyPost deliberately gets no audience rows.
    ])
    .execute();

  return {
    orgId,
    otherOrgId,
    authorId: author.id,
    groupMemberId: groupMember.id,
    tagMemberId: tagMember.id,
    outsiderId: outsider.id,
    moderatorId: moderator.id,
    superUserId: superUser.id,
    moderatorInGroupId: moderatorInGroup.id,
    foreignerId: foreigner.id,
    groupId,
    tagId,
    churchPostId: churchPost.id,
    groupPostId: groupPost.id,
    tagPostId: tagPost.id,
    groupAndTagPostId: groupAndTagPost.id,
    authorOnlyPostId: authorOnlyPost.id,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/db/test/bench-visibility.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import { canSee } from '../src/bench-visibility.js';
import { newId } from '../src/ids.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-canSee');
});

afterAll(async () => {
  await db.destroy();
});

describe('canSee — rule ① church-wide', () => {
  it('lets any member of that church see it', async () => {
    expect(await canSee(db, f.outsiderId, f.churchPostId)).toEqual({
      visible: true,
      rule: 'church',
    });
  });

  it('does not leak to a member of a different church', async () => {
    expect(await canSee(db, f.foreignerId, f.churchPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — rule ② group', () => {
  it('lets a member of the group see it', async () => {
    expect(await canSee(db, f.groupMemberId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group',
    });
  });

  it('hides it from a church member who is not in the group', async () => {
    expect(await canSee(db, f.outsiderId, f.groupPostId)).toEqual({ visible: false, rule: null });
  });

  it('lets a moderator who is NOT in the group see it', async () => {
    expect(await canSee(db, f.moderatorId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('lets a super_user who is NOT in the group see it', async () => {
    expect(await canSee(db, f.superUserId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('reports membership, not privilege, when the viewer is both', async () => {
    // The more specific truth wins: this person would see it even without the role.
    expect(await canSee(db, f.moderatorInGroupId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group',
    });
  });
});

describe('canSee — rule ③ tag, sealed', () => {
  it('lets a member of the tag see it', async () => {
    expect(await canSee(db, f.tagMemberId, f.tagPostId)).toEqual({ visible: true, rule: 'tag' });
  });

  it('hides it from a church member who is not in the tag', async () => {
    expect(await canSee(db, f.outsiderId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });

  it('SEALS it from a moderator who is not in the tag', async () => {
    expect(await canSee(db, f.moderatorId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });

  it('SEALS it from a super_user who is not in the tag', async () => {
    // The headline privacy property: a super_user gets the same answer as anyone else.
    expect(await canSee(db, f.superUserId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });
});

describe('canSee — the author clause', () => {
  it('lets the author see their own tag prayer even though they are not in the tag', async () => {
    expect(await canSee(db, f.authorId, f.tagPostId)).toEqual({ visible: true, rule: 'author' });
  });

  it('lets the author see a prayer with no audience at all', async () => {
    expect(await canSee(db, f.authorId, f.authorOnlyPostId)).toEqual({
      visible: true,
      rule: 'author',
    });
  });

  it('hides an audience-less prayer from everyone else', async () => {
    expect(await canSee(db, f.outsiderId, f.authorOnlyPostId)).toEqual({
      visible: false,
      rule: null,
    });
    expect(await canSee(db, f.superUserId, f.authorOnlyPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — multiple audience rows', () => {
  it('lets a moderator in via the group row even though a tag row is present', async () => {
    // The tag seal does not extend to the whole post; rows are evaluated independently.
    expect(await canSee(db, f.moderatorId, f.groupAndTagPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('lets a tag member in via the tag row', async () => {
    expect(await canSee(db, f.tagMemberId, f.groupAndTagPostId)).toEqual({
      visible: true,
      rule: 'tag',
    });
  });
});

describe('canSee — bad input', () => {
  it('throws on a prayer that does not exist, rather than reporting "not visible"', async () => {
    // A sampler bug must surface as an error, not as a plausible-looking false.
    await expect(canSee(db, f.outsiderId, newId())).rejects.toThrow(/no prayer/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @prayer/db test bench-visibility`
Expected: FAIL — cannot resolve `../src/bench-visibility.js`.

- [ ] **Step 4: Implement**

Create `packages/db/src/bench-visibility.ts`:

```ts
import { sql } from 'kysely';

import type { BenchDb } from './bench-schema.js';

/** Which rule granted visibility. */
export type VisibilityRule = 'author' | 'church' | 'group' | 'group_moderator' | 'tag';

export interface CanSeeResult {
  visible: boolean;
  /** `null` when the prayer is not visible. */
  rule: VisibilityRule | null;
}

interface ClauseRow {
  by_author: boolean;
  by_church: boolean;
  by_group: boolean;
  by_group_moderator: boolean;
  by_tag: boolean;
}

/**
 * Can `viewerId` see `postId`?
 *
 * This is the ORACLE: a direct, one-EXISTS-per-rule transcription of the three
 * visibility rules. It is written to be obviously correct, not fast. Every
 * future optimised query is audited against it, and every optimisation is
 * measured against it as the baseline.
 *
 * All five clauses are evaluated in one round trip rather than short-circuited
 * across several, because the point of the harness is to time ONE database
 * call. Reporting which rule decided is what makes rule ②'s privilege clause
 * observable — and would make a privilege clause wrongly reaching rule ③'s
 * sealed tag path show up in the output instead of passing silently.
 *
 * Throws when the prayer does not exist. A sampler bug must surface as an
 * error rather than as a plausible-looking `visible: false`.
 */
export async function canSee(db: BenchDb, viewerId: string, postId: string): Promise<CanSeeResult> {
  const result = await sql<ClauseRow>`
    SELECT
      (p.author_id = ${viewerId}) AS by_author,

      -- ① church-wide: an audience row naming a church the viewer belongs to.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN user_orgs uo ON uo.org_id = a.church_id AND uo.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_church,

      -- ② group, membership arm.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN group_members gm ON gm.group_id = a.group_id AND gm.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_group,

      -- ② group, privilege arm. Scoped to the prayer's own church so a
      -- moderator of one church gains nothing in another.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN user_orgs uo ON uo.user_id = ${viewerId} AND uo.org_id = p.org_id
         WHERE a.post_id = p.id
           AND a.group_id IS NOT NULL
           AND uo.role IN ('moderator', 'super_user')
      ) AS by_group_moderator,

      -- ③ tag, sealed. There is deliberately NO privilege arm here.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN tag_members tm ON tm.tag_id = a.tag_id AND tm.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_tag

      FROM posts p
     WHERE p.id = ${postId}
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) throw new Error(`canSee: no prayer with id ${postId}`);

  // Most specific truth first: a viewer who is both a group member and a
  // moderator is reported as a member, because they would see it either way.
  if (row.by_author) return { visible: true, rule: 'author' };
  if (row.by_church) return { visible: true, rule: 'church' };
  if (row.by_group) return { visible: true, rule: 'group' };
  if (row.by_group_moderator) return { visible: true, rule: 'group_moderator' };
  if (row.by_tag) return { visible: true, rule: 'tag' };
  return { visible: false, rule: null };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @prayer/db test bench-visibility`
Expected: PASS — 17 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/bench-visibility.ts packages/db/test/bench-visibility.test.ts \
        packages/db/test/helpers/visibility-fixtures.ts
git commit -m "feat(db): the point-check permission oracle"
```

---

### Task 2: The independent reference implementation

The check has to be verified on every timed run, and a check that verifies itself proves nothing. This is a second implementation, written a different way — set membership in TypeScript instead of joins in SQL — so that agreement between them is evidence.

**Files:**

- Create: `packages/db/src/bench-visibility-reference.ts`
- Test: `packages/db/test/bench-visibility-reference.test.ts`

**Interfaces:**

- Consumes: `CanSeeResult` from `./bench-visibility.js`; `BenchDb` from `./bench-schema.js`.
- Produces:
  - `interface ViewerFacts { userId: string; orgIds: Set<string>; groupIds: Set<string>; tagIds: Set<string>; privilegedOrgIds: Set<string> }`
  - `interface PostFacts { postId: string; authorId: string; orgId: string; churchIds: string[]; groupIds: string[]; tagIds: string[] }`
  - `expectedVisibility(viewer: ViewerFacts, post: PostFacts): CanSeeResult` — pure.
  - `loadViewerFacts(db: BenchDb, userId: string): Promise<ViewerFacts>`
  - `loadPostFacts(db: BenchDb, postId: string): Promise<PostFacts>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-visibility-reference.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import {
  expectedVisibility,
  loadPostFacts,
  loadViewerFacts,
  type PostFacts,
  type ViewerFacts,
} from '../src/bench-visibility-reference.js';
import { canSee } from '../src/bench-visibility.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-reference');
});

afterAll(async () => {
  await db.destroy();
});

const viewer = (over: Partial<ViewerFacts> = {}): ViewerFacts => ({
  userId: 'v',
  orgIds: new Set(['org']),
  groupIds: new Set(),
  tagIds: new Set(),
  privilegedOrgIds: new Set(),
  ...over,
});

const post = (over: Partial<PostFacts> = {}): PostFacts => ({
  postId: 'p',
  authorId: 'author',
  orgId: 'org',
  churchIds: [],
  groupIds: [],
  tagIds: [],
  ...over,
});

describe('expectedVisibility — pure, no database', () => {
  it('grants the author regardless of audience', () => {
    expect(expectedVisibility(viewer({ userId: 'author' }), post({ tagIds: ['t'] }))).toEqual({
      visible: true,
      rule: 'author',
    });
  });

  it('grants a church member on a church-wide prayer', () => {
    expect(expectedVisibility(viewer(), post({ churchIds: ['org'] }))).toEqual({
      visible: true,
      rule: 'church',
    });
  });

  it('denies a member of a different church', () => {
    expect(
      expectedVisibility(viewer({ orgIds: new Set(['elsewhere']) }), post({ churchIds: ['org'] })),
    ).toEqual({
      visible: false,
      rule: null,
    });
  });

  it('grants a group member', () => {
    expect(
      expectedVisibility(viewer({ groupIds: new Set(['g']) }), post({ groupIds: ['g'] })),
    ).toEqual({
      visible: true,
      rule: 'group',
    });
  });

  it('grants a moderator on a group prayer they are not in', () => {
    expect(
      expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post({ groupIds: ['g'] })),
    ).toEqual({ visible: true, rule: 'group_moderator' });
  });

  it('prefers membership over privilege when the viewer is both', () => {
    expect(
      expectedVisibility(
        viewer({ groupIds: new Set(['g']), privilegedOrgIds: new Set(['org']) }),
        post({ groupIds: ['g'] }),
      ),
    ).toEqual({ visible: true, rule: 'group' });
  });

  it('grants a tag member', () => {
    expect(expectedVisibility(viewer({ tagIds: new Set(['t']) }), post({ tagIds: ['t'] }))).toEqual(
      {
        visible: true,
        rule: 'tag',
      },
    );
  });

  it('SEALS a tag prayer from a privileged viewer who is not in the tag', () => {
    expect(
      expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post({ tagIds: ['t'] })),
    ).toEqual({ visible: false, rule: null });
  });

  it('denies everyone but the author on an audience-less prayer', () => {
    expect(expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post())).toEqual({
      visible: false,
      rule: null,
    });
  });

  it('lets a moderator in via a group row on a group+tag prayer', () => {
    expect(
      expectedVisibility(
        viewer({ privilegedOrgIds: new Set(['org']) }),
        post({ groupIds: ['g'], tagIds: ['t'] }),
      ),
    ).toEqual({ visible: true, rule: 'group_moderator' });
  });
});

describe('fact loaders', () => {
  it('reads a viewer’s memberships and privilege', async () => {
    const mod = await loadViewerFacts(db, f.moderatorInGroupId);
    expect(mod.orgIds.has(f.orgId)).toBe(true);
    expect(mod.groupIds.has(f.groupId)).toBe(true);
    expect(mod.privilegedOrgIds.has(f.orgId)).toBe(true);

    const plain = await loadViewerFacts(db, f.outsiderId);
    expect(plain.privilegedOrgIds.size).toBe(0);
    expect(plain.groupIds.size).toBe(0);
  });

  it('reads a viewer’s tag memberships but not tags they merely own', async () => {
    // The author OWNS the fixture tag and is not a member of it.
    const author = await loadViewerFacts(db, f.authorId);
    expect(author.tagIds.has(f.tagId)).toBe(false);

    const member = await loadViewerFacts(db, f.tagMemberId);
    expect(member.tagIds.has(f.tagId)).toBe(true);
  });

  it('reads a prayer’s audiences, split by kind', async () => {
    const both = await loadPostFacts(db, f.groupAndTagPostId);
    expect(both.authorId).toBe(f.authorId);
    expect(both.orgId).toBe(f.orgId);
    expect(both.groupIds).toEqual([f.groupId]);
    expect(both.tagIds).toEqual([f.tagId]);
    expect(both.churchIds).toEqual([]);

    const none = await loadPostFacts(db, f.authorOnlyPostId);
    expect(none.churchIds).toEqual([]);
    expect(none.groupIds).toEqual([]);
    expect(none.tagIds).toEqual([]);
  });
});

describe('differential — the SQL check and the reference must agree', () => {
  it('agrees on every viewer × prayer pair in the fixture', async () => {
    const viewers = [
      f.authorId,
      f.groupMemberId,
      f.tagMemberId,
      f.outsiderId,
      f.moderatorId,
      f.superUserId,
      f.moderatorInGroupId,
      f.foreignerId,
    ];
    const posts = [
      f.churchPostId,
      f.groupPostId,
      f.tagPostId,
      f.groupAndTagPostId,
      f.authorOnlyPostId,
    ];

    const disagreements: string[] = [];
    for (const viewerId of viewers) {
      const facts = await loadViewerFacts(db, viewerId);
      for (const postId of posts) {
        const actual = await canSee(db, viewerId, postId);
        const expectedResult = expectedVisibility(facts, await loadPostFacts(db, postId));
        if (actual.visible !== expectedResult.visible || actual.rule !== expectedResult.rule) {
          disagreements.push(
            `${viewerId} × ${postId}: sql=${JSON.stringify(actual)} ref=${JSON.stringify(expectedResult)}`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @prayer/db test bench-visibility-reference`
Expected: FAIL — cannot resolve `../src/bench-visibility-reference.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-visibility-reference.ts`:

```ts
import type { BenchDb } from './bench-schema.js';
import type { CanSeeResult } from './bench-visibility.js';

/**
 * A second implementation of the three visibility rules, written deliberately
 * differently from `canSee`: set membership in TypeScript rather than joins in
 * SQL, over facts fetched separately.
 *
 * Its whole purpose is to disagree when `canSee` is wrong. A check that
 * verifies itself proves nothing, so the timing runner asserts every timed
 * result against this and refuses to report on any disagreement.
 */

/** Everything about a viewer that affects visibility. Fetched once, reused across many checks. */
export interface ViewerFacts {
  userId: string;
  /** Churches the viewer belongs to. */
  orgIds: Set<string>;
  /** Groups the viewer is a member of. */
  groupIds: Set<string>;
  /** Tags the viewer is a MEMBER of. Owning a tag is not membership in it. */
  tagIds: Set<string>;
  /** Churches where the viewer is a moderator or super_user. */
  privilegedOrgIds: Set<string>;
}

/** Everything about a prayer that affects visibility. */
export interface PostFacts {
  postId: string;
  authorId: string;
  orgId: string;
  churchIds: string[];
  groupIds: string[];
  tagIds: string[];
}

/** Pure. No database, no clock. */
export function expectedVisibility(viewer: ViewerFacts, post: PostFacts): CanSeeResult {
  if (post.authorId === viewer.userId) return { visible: true, rule: 'author' };
  if (post.churchIds.some((id) => viewer.orgIds.has(id))) return { visible: true, rule: 'church' };
  if (post.groupIds.some((id) => viewer.groupIds.has(id))) return { visible: true, rule: 'group' };
  if (post.groupIds.length > 0 && viewer.privilegedOrgIds.has(post.orgId)) {
    return { visible: true, rule: 'group_moderator' };
  }
  if (post.tagIds.some((id) => viewer.tagIds.has(id))) return { visible: true, rule: 'tag' };
  // No privilege arm on tags. This absence is the seal.
  return { visible: false, rule: null };
}

export async function loadViewerFacts(db: BenchDb, userId: string): Promise<ViewerFacts> {
  const orgs = await db
    .selectFrom('user_orgs')
    .select(['org_id', 'role'])
    .where('user_id', '=', userId)
    .execute();
  const groups = await db
    .selectFrom('group_members')
    .select('group_id')
    .where('user_id', '=', userId)
    .execute();
  const tags = await db
    .selectFrom('tag_members')
    .select('tag_id')
    .where('user_id', '=', userId)
    .execute();

  return {
    userId,
    orgIds: new Set(orgs.map((o) => o.org_id)),
    groupIds: new Set(groups.map((g) => g.group_id)),
    tagIds: new Set(tags.map((t) => t.tag_id)),
    privilegedOrgIds: new Set(
      orgs.filter((o) => o.role === 'moderator' || o.role === 'super_user').map((o) => o.org_id),
    ),
  };
}

export async function loadPostFacts(db: BenchDb, postId: string): Promise<PostFacts> {
  const post = await db
    .selectFrom('posts')
    .select(['id', 'author_id', 'org_id'])
    .where('id', '=', postId)
    .executeTakeFirst();
  if (post === undefined) throw new Error(`loadPostFacts: no prayer with id ${postId}`);

  const audiences = await db
    .selectFrom('post_audiences')
    .select(['church_id', 'group_id', 'tag_id'])
    .where('post_id', '=', postId)
    .execute();

  const nonNull = (xs: (string | null)[]): string[] => xs.filter((x): x is string => x !== null);

  return {
    postId,
    authorId: post.author_id,
    orgId: post.org_id,
    churchIds: nonNull(audiences.map((a) => a.church_id)),
    groupIds: nonNull(audiences.map((a) => a.group_id)),
    tagIds: nonNull(audiences.map((a) => a.tag_id)),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @prayer/db test bench-visibility-reference`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-visibility-reference.ts \
        packages/db/test/bench-visibility-reference.test.ts
git commit -m "feat(db): independent reference implementation of the visibility rules"
```

---

### Task 3: The sampler

Draws random (viewer, prayer) pairs from a seed and labels each with its category, so a per-category breakdown falls out of a uniformly random run.

**Files:**

- Create: `packages/db/src/bench-sampler.ts`
- Test: `packages/db/test/bench-sampler.test.ts`

**Interfaces:**

- Consumes: `BenchDb` from `./bench-schema.js`; `makeRng` from `./bench-fixtures.js`.
- Produces:
  - `type AudienceCategory = 'church' | 'group_only' | 'tag_only' | 'group_and_tag' | 'author_only'`
  - `type ConnectivityCohort = 'isolated' | 'low' | 'medium' | 'high'`
  - `interface SamplePair { viewerId: string; postId: string; audienceCategory: AudienceCategory; cohort: ConnectivityCohort }`
  - `interface SamplePool { viewers: { id: string; cohort: ConnectivityCohort }[]; posts: { id: string; category: AudienceCategory }[] }`
  - `loadSamplePool(db: BenchDb, orgId: string): Promise<SamplePool>`
  - `drawPairs(pool: SamplePool, count: number, rng: () => number): SamplePair[]`

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-sampler.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeRng } from '../src/bench-fixtures.js';
import { drawPairs, loadSamplePool, type SamplePool } from '../src/bench-sampler.js';
import { createBenchDb, type BenchDb } from '../src/bench-schema.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;
let pool: SamplePool;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-sampler');
  pool = await loadSamplePool(db, f.orgId);
});

afterAll(async () => {
  await db.destroy();
});

describe('loadSamplePool', () => {
  it('loads every member of the church and no one else', () => {
    expect(pool.viewers).toHaveLength(7); // the fixture's 7 org members; the foreigner is elsewhere
    expect(pool.viewers.map((v) => v.id)).not.toContain(f.foreignerId);
  });

  it('labels connectivity from group count', () => {
    const byId = new Map(pool.viewers.map((v) => [v.id, v.cohort]));
    expect(byId.get(f.outsiderId)).toBe('isolated'); // 0 groups
    expect(byId.get(f.groupMemberId)).toBe('low'); // 1 group
  });

  it('labels every prayer with its audience category', () => {
    const byId = new Map(pool.posts.map((p) => [p.id, p.category]));
    expect(byId.get(f.churchPostId)).toBe('church');
    expect(byId.get(f.groupPostId)).toBe('group_only');
    expect(byId.get(f.tagPostId)).toBe('tag_only');
    expect(byId.get(f.groupAndTagPostId)).toBe('group_and_tag');
    expect(byId.get(f.authorOnlyPostId)).toBe('author_only');
  });
});

describe('drawPairs', () => {
  it('draws the requested number of pairs', () => {
    expect(drawPairs(pool, 50, makeRng(1))).toHaveLength(50);
  });

  it('produces identical pairs for identical seeds', () => {
    expect(drawPairs(pool, 30, makeRng(7))).toEqual(drawPairs(pool, 30, makeRng(7)));
  });

  it('produces different pairs for different seeds', () => {
    expect(drawPairs(pool, 30, makeRng(7))).not.toEqual(drawPairs(pool, 30, makeRng(8)));
  });

  it('only ever draws ids that are in the pool', () => {
    const viewerIds = new Set(pool.viewers.map((v) => v.id));
    const postIds = new Set(pool.posts.map((p) => p.id));
    for (const pair of drawPairs(pool, 100, makeRng(3))) {
      expect(viewerIds.has(pair.viewerId)).toBe(true);
      expect(postIds.has(pair.postId)).toBe(true);
    }
  });

  it('carries the label of the exact viewer and prayer it drew', () => {
    const cohortById = new Map(pool.viewers.map((v) => [v.id, v.cohort]));
    const categoryById = new Map(pool.posts.map((p) => [p.id, p.category]));
    for (const pair of drawPairs(pool, 100, makeRng(4))) {
      expect(pair.cohort).toBe(cohortById.get(pair.viewerId));
      expect(pair.audienceCategory).toBe(categoryById.get(pair.postId));
    }
  });

  it('refuses to draw from an empty pool instead of returning junk', () => {
    expect(() => drawPairs({ viewers: [], posts: [] }, 5, makeRng(1))).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @prayer/db test bench-sampler`
Expected: FAIL — cannot resolve `../src/bench-sampler.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-sampler.ts`:

```ts
import type { BenchDb } from './bench-schema.js';

/**
 * Uniformly random (viewer, prayer) pairs, drawn from a seed.
 *
 * Sampling is uniform on purpose: it answers "what does a permission check cost
 * in production, weighted by how often each situation actually occurs." Each
 * pair carries the prayer's audience category and the viewer's connectivity, so
 * a per-category breakdown falls out of a random run without needing a
 * stratified one. Rare categories get few samples; the results report each
 * category's sample count so a thin cell is visible rather than misleading.
 */

export type AudienceCategory =
  'church' | 'group_only' | 'tag_only' | 'group_and_tag' | 'author_only';

/** Matches the cohorts in the dataset design spec's connectivity table. */
export type ConnectivityCohort = 'isolated' | 'low' | 'medium' | 'high';

export interface SamplePair {
  viewerId: string;
  postId: string;
  audienceCategory: AudienceCategory;
  cohort: ConnectivityCohort;
}

export interface SamplePool {
  viewers: { id: string; cohort: ConnectivityCohort }[];
  posts: { id: string; category: AudienceCategory }[];
}

function cohortOf(groupCount: number): ConnectivityCohort {
  if (groupCount === 0) return 'isolated';
  if (groupCount === 1) return 'low';
  if (groupCount <= 3) return 'medium';
  return 'high';
}

/**
 * A church-wide row makes the prayer visible to everyone, so it dominates any
 * other row it is combined with — it is classified as `church` regardless.
 */
function categoryOf(hasChurch: boolean, hasGroup: boolean, hasTag: boolean): AudienceCategory {
  if (hasChurch) return 'church';
  if (hasGroup && hasTag) return 'group_and_tag';
  if (hasGroup) return 'group_only';
  if (hasTag) return 'tag_only';
  return 'author_only';
}

export async function loadSamplePool(db: BenchDb, orgId: string): Promise<SamplePool> {
  // The group join is scoped through `groups.church_id`, not just `user_id`:
  // a member of two churches must not have another church's groups counted
  // toward their connectivity here.
  const viewerRows = await db
    .selectFrom('user_orgs')
    .leftJoin('group_members', 'group_members.user_id', 'user_orgs.user_id')
    .leftJoin('groups', (join) =>
      join.onRef('groups.id', '=', 'group_members.group_id').on('groups.church_id', '=', orgId),
    )
    .select(({ fn }) => [
      'user_orgs.user_id as id',
      fn.count<string>('groups.id').as('group_count'),
    ])
    .where('user_orgs.org_id', '=', orgId)
    .groupBy('user_orgs.user_id')
    .execute();

  const postRows = await db
    .selectFrom('posts')
    .leftJoin('post_audiences', 'post_audiences.post_id', 'posts.id')
    .select(({ fn }) => [
      'posts.id as id',
      fn.count<string>('post_audiences.church_id').as('church_rows'),
      fn.count<string>('post_audiences.group_id').as('group_rows'),
      fn.count<string>('post_audiences.tag_id').as('tag_rows'),
    ])
    .where('posts.org_id', '=', orgId)
    .groupBy('posts.id')
    .execute();

  return {
    viewers: viewerRows.map((r) => ({ id: r.id, cohort: cohortOf(Number(r.group_count)) })),
    posts: postRows.map((r) => ({
      id: r.id,
      category: categoryOf(
        Number(r.church_rows) > 0,
        Number(r.group_rows) > 0,
        Number(r.tag_rows) > 0,
      ),
    })),
  };
}

export function drawPairs(pool: SamplePool, count: number, rng: () => number): SamplePair[] {
  if (pool.viewers.length === 0 || pool.posts.length === 0) {
    throw new Error('drawPairs: the sample pool is empty — is the bench dataset loaded?');
  }

  const pairs: SamplePair[] = [];
  for (let i = 0; i < count; i++) {
    const viewer = pool.viewers[Math.floor(rng() * pool.viewers.length)];
    const post = pool.posts[Math.floor(rng() * pool.posts.length)];
    if (viewer === undefined || post === undefined) continue;
    pairs.push({
      viewerId: viewer.id,
      postId: post.id,
      audienceCategory: post.category,
      cohort: viewer.cohort,
    });
  }
  return pairs;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @prayer/db test bench-sampler`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-sampler.ts packages/db/test/bench-sampler.test.ts
git commit -m "feat(db): seeded random sampler for viewer/prayer pairs"
```

---

### Task 4: The timing runner

Runs the batch, times each check against a measured round-trip floor, verifies every answer, and captures the conditions the results have to be read against.

**Files:**

- Create: `packages/db/src/bench-timing.ts`
- Test: `packages/db/test/bench-timing.test.ts`

**Interfaces:**

- Consumes: `canSee` (Task 1); `expectedVisibility`, `loadPostFacts`, `loadViewerFacts` (Task 2); `drawPairs`, `loadSamplePool`, `AudienceCategory`, `ConnectivityCohort` (Task 3); `makeRng` from `./bench-fixtures.js`.
- Produces:
  - `interface TimingOptions { orgId: string; samples: number; seed: number; warmup: number; databaseName: string }`
  - `interface TimedSample { viewerId; postId; audienceCategory; cohort; visible; rule; checkNs; floorNs }`
  - `interface RunConditions { … }` (fields listed in the implementation)
  - `interface TimingRun { conditions: RunConditions; samples: TimedSample[] }`
  - `runPointCheckTiming(db: BenchDb, opts: TimingOptions): Promise<TimingRun>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-timing.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import { runPointCheckTiming } from '../src/bench-timing.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-timing');
});

afterAll(async () => {
  await db.destroy();
});

describe('runPointCheckTiming', () => {
  it('returns exactly the requested number of samples, excluding warmup', async () => {
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 25,
      seed: 42,
      warmup: 10,
      databaseName: 'prayer_test',
    });
    expect(run.samples).toHaveLength(25);
    expect(run.conditions.warmup).toBe(10);
    expect(run.conditions.samples).toBe(25);
  });

  it('times both the check and the round-trip floor for every sample', async () => {
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 20,
      seed: 1,
      warmup: 5,
      databaseName: 'prayer_test',
    });
    for (const s of run.samples) {
      expect(s.checkNs).toBeGreaterThan(0);
      expect(s.floorNs).toBeGreaterThan(0);
    }
  });

  it('records the conditions the numbers have to be read against', async () => {
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 5,
      seed: 3,
      warmup: 1,
      databaseName: 'prayer_test',
    });
    const c = run.conditions;
    expect(c.dataset).toBe('prayer_test');
    expect(c.seed).toBe(3);
    expect(c.cache).toBe('warm');
    expect(c.postgresVersion).toMatch(/^\d+/);
    expect(c.sharedBuffers).toBeTruthy();
    expect(c.rowCounts.posts).toBeGreaterThan(0);
    expect(c.machine.cpus).toBeGreaterThan(0);
    expect(c.indexes.length).toBeGreaterThan(0);
    expect(c.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Corroboration pass ran and produced a plausible in-database figure.
    expect(c.explainMeanMs).not.toBeNull();
    expect(c.explainMeanMs ?? 0).toBeGreaterThan(0);
  });

  it('measures the floor on the same connection as the check', async () => {
    // A pg.Pool may hand consecutive queries to different backends, which would
    // make the floor meaningless. The runner pins one connection; if it stops
    // doing so, floor and check would be sampling different backends and this
    // assertion on a settled, single-connection run gets flaky.
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 40,
      seed: 8,
      warmup: 20,
      databaseName: 'prayer_test',
    });
    const floors = run.samples.map((s) => s.floorNs).sort((a, b) => a - b);
    const median = floors[Math.floor(floors.length / 2)] ?? 0;
    expect(median).toBeGreaterThan(0);
    // A pinned, warmed connection's floor is tight. Two different backends —
    // one warm, one cold — would blow the spread far past this.
    expect(floors[floors.length - 1] ?? 0).toBeLessThan(median * 50);
  });

  it('is deterministic in which pairs it draws, for a fixed seed', async () => {
    const opts = {
      orgId: f.orgId,
      samples: 15,
      seed: 99,
      warmup: 0,
      databaseName: 'prayer_test',
    };
    const a = await runPointCheckTiming(db, opts);
    const b = await runPointCheckTiming(db, opts);
    expect(a.samples.map((s) => [s.viewerId, s.postId])).toEqual(
      b.samples.map((s) => [s.viewerId, s.postId]),
    );
  });

  it('records which rule decided each check', async () => {
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 60,
      seed: 5,
      warmup: 0,
      databaseName: 'prayer_test',
    });
    const rules = new Set(run.samples.map((s) => s.rule));
    // The fixture has church, group, tag and author-only prayers, so a 60-pair
    // draw over 7 viewers must have produced at least one grant and one denial.
    expect(run.samples.some((s) => s.visible)).toBe(true);
    expect(run.samples.some((s) => !s.visible)).toBe(true);
    expect(rules.has(null)).toBe(true);
  });

  it('refuses to report when a check disagrees with the reference', async () => {
    // Feed it an org with members but no prayers: drawPairs must fail loudly
    // rather than produce a run with zero samples that looks successful.
    await expect(
      runPointCheckTiming(db, {
        orgId: f.otherOrgId,
        samples: 5,
        seed: 1,
        warmup: 0,
        databaseName: 'prayer_test',
      }),
    ).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @prayer/db test bench-timing`
Expected: FAIL — cannot resolve `../src/bench-timing.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-timing.ts`:

```ts
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { sql } from 'kysely';

import { makeRng } from './bench-fixtures.js';
import {
  drawPairs,
  loadSamplePool,
  type AudienceCategory,
  type ConnectivityCohort,
} from './bench-sampler.js';
import type { BenchDb } from './bench-schema.js';
import {
  expectedVisibility,
  loadPostFacts,
  loadViewerFacts,
  type PostFacts,
  type ViewerFacts,
} from './bench-visibility-reference.js';
import { canSee, type VisibilityRule } from './bench-visibility.js';

export interface TimingOptions {
  orgId: string;
  samples: number;
  seed: number;
  warmup: number;
  /** Recorded in the results so a table can be traced to the dataset it came from. */
  databaseName: string;
}

export interface TimedSample {
  viewerId: string;
  postId: string;
  audienceCategory: AudienceCategory;
  cohort: ConnectivityCohort;
  visible: boolean;
  rule: VisibilityRule | null;
  /** Wall-clock for the permission check, nanoseconds. */
  checkNs: number;
  /** Wall-clock for an interleaved `SELECT 1` on the same connection, nanoseconds. */
  floorNs: number;
}

export interface RunConditions {
  dataset: string;
  rowCounts: {
    users: number;
    posts: number;
    post_audiences: number;
    group_members: number;
    tag_members: number;
  };
  samples: number;
  seed: number;
  warmup: number;
  /** Always 'warm' — the harness warms up. Recorded so the assumption is explicit. */
  cache: 'warm';
  postgresVersion: string;
  sharedBuffers: string;
  /** Indexes on the tables the check touches, so an index A/B is unambiguous. */
  indexes: string[];
  machine: { platform: string; arch: string; cpuModel: string; cpus: number };
  timestamp: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  /** EXPLAIN ANALYZE corroboration over a subsample. Inflated by instrumentation; not the headline. */
  explainMeanMs: number | null;
}

export interface TimingRun {
  conditions: RunConditions;
  samples: TimedSample[];
}

const INDEXED_TABLES = ['post_audiences', 'group_members', 'tag_members', 'user_orgs', 'posts'];

/** How many samples get the EXPLAIN ANALYZE corroboration pass. */
const EXPLAIN_SUBSAMPLE = 20;

interface ExplainRow {
  'QUERY PLAN': { 'Execution Time': number }[];
}

/**
 * Mean in-database execution time over a handful of already-timed pairs.
 *
 * Reported as corroboration only. EXPLAIN ANALYZE's own instrumentation
 * inflates the number it produces, which is exactly why the headline marginal
 * cost comes from floor subtraction instead.
 */
async function explainSubsample(db: BenchDb, samples: TimedSample[]): Promise<number | null> {
  if (samples.length === 0) return null;
  const times: number[] = [];
  for (const s of samples) {
    const explained = await sql<ExplainRow>`
      EXPLAIN (ANALYZE, TIMING ON, FORMAT JSON)
      SELECT EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN user_orgs uo ON uo.org_id = a.church_id AND uo.user_id = ${s.viewerId}
         WHERE a.post_id = ${s.postId}
      )
    `.execute(db);
    const plan = explained.rows[0]?.['QUERY PLAN'][0];
    if (plan !== undefined) times.push(plan['Execution Time']);
  }
  if (times.length === 0) return null;
  return times.reduce((a, b) => a + b, 0) / times.length;
}

function gitInfo(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    // Not a git checkout, or git is unavailable. Recorded as unknown rather than guessed.
    return { commit: null, dirty: null };
  }
}

async function countRows(db: BenchDb, orgId: string): Promise<RunConditions['rowCounts']> {
  const one = async (q: Promise<{ n: string } | undefined>): Promise<number> =>
    Number((await q)?.n ?? 0);

  return {
    users: await one(
      db
        .selectFrom('user_orgs')
        .select(({ fn }) => fn.count<string>('user_id').as('n'))
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    ),
    posts: await one(
      db
        .selectFrom('posts')
        .select(({ fn }) => fn.count<string>('id').as('n'))
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    ),
    post_audiences: await one(
      db
        .selectFrom('post_audiences')
        .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
        .select(({ fn }) => fn.count<string>('post_audiences.post_id').as('n'))
        .where('posts.org_id', '=', orgId)
        .executeTakeFirst(),
    ),
    group_members: await one(
      db
        .selectFrom('group_members')
        .innerJoin('groups', 'groups.id', 'group_members.group_id')
        .select(({ fn }) => fn.count<string>('group_members.user_id').as('n'))
        .where('groups.church_id', '=', orgId)
        .executeTakeFirst(),
    ),
    tag_members: await one(
      db
        .selectFrom('tag_members')
        .innerJoin('tags', 'tags.id', 'tag_members.tag_id')
        .select(({ fn }) => fn.count<string>('tag_members.user_id').as('n'))
        .where('tags.church_id', '=', orgId)
        .executeTakeFirst(),
    ),
  };
}

/**
 * Times the permission check against a measured round-trip floor.
 *
 * The floor is an interleaved `SELECT 1` on the same connection: driver,
 * socket, protocol, and nothing else. Subtracting it gives the marginal cost of
 * the permission logic. This is preferred over EXPLAIN ANALYZE, whose
 * instrumentation overhead would land in the very number being quoted, and over
 * pg_stat_statements, which is unavailable here (shared_preload_libraries is
 * empty).
 *
 * Every timed result is verified against the independent reference
 * implementation. On any disagreement the run THROWS rather than reporting — a
 * fast wrong number is the failure mode this project has already hit once.
 */
export async function runPointCheckTiming(db: BenchDb, opts: TimingOptions): Promise<TimingRun> {
  // Fresh statistics: the bench data is bulk-loaded, and a planner working from
  // stale stats would make choices production never would.
  await sql`ANALYZE`.execute(db);

  const pool = await loadSamplePool(db, opts.orgId);
  const rng = makeRng(opts.seed);
  const pairs = drawPairs(pool, opts.warmup + opts.samples, rng);

  // Facts are fetched BEFORE timing starts so the reference's own queries never
  // land in the measurement.
  const viewerFacts = new Map<string, ViewerFacts>();
  const postFacts = new Map<string, PostFacts>();
  for (const pair of pairs) {
    if (!viewerFacts.has(pair.viewerId)) {
      viewerFacts.set(pair.viewerId, await loadViewerFacts(db, pair.viewerId));
    }
    if (!postFacts.has(pair.postId)) {
      postFacts.set(pair.postId, await loadPostFacts(db, pair.postId));
    }
  }

  const samples: TimedSample[] = [];
  const disagreements: string[] = [];
  let explainMeanMs: number | null = null;

  // EVERY timed query runs on ONE pinned connection. `createBenchDb` builds a
  // pg.Pool, and a pool is free to hand consecutive queries to different
  // backends — which would wreck the floor calibration, since the floor is only
  // meaningful as the round-trip cost of the SAME connection the check used.
  // `db.connection()` pins one for the whole callback.
  await db.connection().execute(async (conn) => {
    // Warmup: discarded. Settles plan caching and connection setup.
    for (let i = 0; i < opts.warmup; i++) {
      const pair = pairs[i];
      if (pair === undefined) continue;
      await canSee(conn, pair.viewerId, pair.postId);
      await sql`SELECT 1`.execute(conn);
    }

    for (let i = opts.warmup; i < pairs.length; i++) {
      const pair = pairs[i];
      if (pair === undefined) continue;

      const floorStart = process.hrtime.bigint();
      await sql`SELECT 1`.execute(conn);
      const floorNs = Number(process.hrtime.bigint() - floorStart);

      const checkStart = process.hrtime.bigint();
      const result = await canSee(conn, pair.viewerId, pair.postId);
      const checkNs = Number(process.hrtime.bigint() - checkStart);

      const viewer = viewerFacts.get(pair.viewerId);
      const post = postFacts.get(pair.postId);
      if (viewer !== undefined && post !== undefined) {
        const reference = expectedVisibility(viewer, post);
        if (reference.visible !== result.visible || reference.rule !== result.rule) {
          disagreements.push(
            `${pair.viewerId} × ${pair.postId}: check=${JSON.stringify(result)} reference=${JSON.stringify(reference)}`,
          );
        }
      }

      samples.push({
        viewerId: pair.viewerId,
        postId: pair.postId,
        audienceCategory: pair.audienceCategory,
        cohort: pair.cohort,
        visible: result.visible,
        rule: result.rule,
        checkNs,
        floorNs,
      });
    }

    // Sanity cross-check on a small subsample, AFTER timing so its
    // instrumentation overhead never lands in the reported numbers. EXPLAIN
    // ANALYZE inflates what it measures, so this is corroboration that the
    // marginal figure is the right order of magnitude — not a second estimate.
    explainMeanMs = await explainSubsample(conn, samples.slice(0, EXPLAIN_SUBSAMPLE));
  });

  if (disagreements.length > 0) {
    throw new Error(
      `runPointCheckTiming: the permission check disagreed with the reference on ` +
        `${disagreements.length} of ${samples.length} samples. Refusing to report a timing ` +
        `result for a check that is not correct.\n` +
        disagreements.slice(0, 10).join('\n'),
    );
  }

  const versionRow = await sql<{ v: string }>`SELECT version() AS v`.execute(db);
  const buffersRow = await sql<{ setting: string }>`SHOW shared_buffers`.execute(db);
  const indexRows = await sql<{ indexdef: string }>`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY(${INDEXED_TABLES})
     ORDER BY indexname
  `.execute(db);

  const git = gitInfo();
  const cpu = os.cpus()[0];

  return {
    conditions: {
      dataset: opts.databaseName,
      rowCounts: await countRows(db, opts.orgId),
      samples: opts.samples,
      seed: opts.seed,
      warmup: opts.warmup,
      cache: 'warm',
      postgresVersion: (versionRow.rows[0]?.v ?? 'unknown').replace(/^PostgreSQL /, ''),
      sharedBuffers: buffersRow.rows[0]?.setting ?? 'unknown',
      indexes: indexRows.rows.map((r) => r.indexdef),
      machine: {
        platform: os.platform(),
        arch: os.arch(),
        cpuModel: cpu?.model ?? 'unknown',
        cpus: os.cpus().length,
      },
      timestamp: new Date().toISOString(),
      gitCommit: git.commit,
      gitDirty: git.dirty,
      explainMeanMs,
    },
    samples,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @prayer/db test bench-timing`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-timing.ts packages/db/test/bench-timing.test.ts
git commit -m "feat(db): point-check timing runner with a measured round-trip floor"
```

---

### Task 5: Percentiles, Markdown, and the result files

Turns raw samples into the artifact that goes in the write-up. Nothing here is hand-typed.

**Files:**

- Create: `packages/db/src/bench-results.ts`
- Test: `packages/db/test/bench-results.test.ts`

**Interfaces:**

- Consumes: `TimingRun`, `TimedSample` (Task 4).
- Produces:
  - `percentile(sortedNs: number[], p: number): number`
  - `interface Stats { n: number; p50Ms: number; p95Ms: number; p99Ms: number }`
  - `interface Summary { overall: Stats; floor: Stats; marginalMs: number; visibleShare: number; byCategory: Record<string, Stats>; byCohort: Record<string, Stats>; byRule: Record<string, number> }`
  - `summarize(run: TimingRun): Summary`
  - `renderMarkdown(run: TimingRun, summary: Summary): string`
  - `resultBasename(run: TimingRun): string`
  - `writeResults(run: TimingRun, dir: string): Promise<{ jsonPath: string; mdPath: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/bench-results.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  percentile,
  renderMarkdown,
  resultBasename,
  summarize,
  writeResults,
} from '../src/bench-results.js';
import type { TimedSample, TimingRun } from '../src/bench-timing.js';

function sample(over: Partial<TimedSample> = {}): TimedSample {
  return {
    viewerId: 'v',
    postId: 'p',
    audienceCategory: 'church',
    cohort: 'isolated',
    visible: true,
    rule: 'church',
    checkNs: 100_000,
    floorNs: 60_000,
    ...over,
  };
}

function run(samples: TimedSample[]): TimingRun {
  return {
    conditions: {
      dataset: 'prayer_bench',
      rowCounts: {
        users: 1000,
        posts: 10000,
        post_audiences: 12286,
        group_members: 2300,
        tag_members: 14672,
      },
      samples: samples.length,
      seed: 42,
      warmup: 100,
      cache: 'warm',
      postgresVersion: '16.14',
      sharedBuffers: '128MB',
      indexes: [
        'CREATE INDEX idx_post_audiences_post_id ON public.post_audiences USING btree (post_id)',
      ],
      machine: { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M1', cpus: 8 },
      timestamp: '2026-08-06T21:40:00.000Z',
      gitCommit: 'abc1234',
      gitDirty: false,
      explainMeanMs: 0.021,
    },
    samples,
  };
}

describe('percentile', () => {
  it('uses nearest-rank on a sorted array', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 99)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
  });

  it('returns 0 for an empty array rather than NaN', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarize', () => {
  it('reports the marginal cost as check minus floor', () => {
    const s = summarize(run([sample(), sample(), sample()]));
    expect(s.overall.p50Ms).toBeCloseTo(0.1, 5);
    expect(s.floor.p50Ms).toBeCloseTo(0.06, 5);
    expect(s.marginalMs).toBeCloseTo(0.04, 5);
  });

  it('breaks down by audience category and by cohort, with sample counts', () => {
    const s = summarize(
      run([
        sample({ audienceCategory: 'church', cohort: 'isolated' }),
        sample({ audienceCategory: 'tag_only', cohort: 'high', checkNs: 300_000 }),
        sample({ audienceCategory: 'tag_only', cohort: 'high', checkNs: 500_000 }),
      ]),
    );
    expect(s.byCategory.church?.n).toBe(1);
    expect(s.byCategory.tag_only?.n).toBe(2);
    expect(s.byCohort.high?.n).toBe(2);
    expect(s.byCohort.isolated?.n).toBe(1);
  });

  it('counts how often each rule decided, denials included', () => {
    const s = summarize(run([sample({ rule: 'church' }), sample({ visible: false, rule: null })]));
    expect(s.byRule.church).toBe(1);
    expect(s.byRule.not_visible).toBe(1);
    expect(s.visibleShare).toBeCloseTo(0.5, 5);
  });
});

describe('renderMarkdown', () => {
  it('states the headline numbers, the conditions, and the limitations', () => {
    const r = run([sample(), sample({ audienceCategory: 'tag_only', cohort: 'high' })]);
    const md = renderMarkdown(r, summarize(r));

    expect(md).toContain('application wall-clock');
    expect(md).toContain('round-trip floor');
    expect(md).toContain('marginal permission cost');
    expect(md).toContain('prayer_bench');
    expect(md).toContain('16.14');
    expect(md).toContain('128MB');
    expect(md).toContain('abc1234');
    // The caveat has to travel with the numbers, not live only in the spec.
    expect(md).toMatch(/warm|CPU/i);
    expect(md).toContain('tag_only');
  });

  it('marks a dirty working tree so a result is never mistaken for a clean build', () => {
    const r = run([sample()]);
    r.conditions.gitDirty = true;
    expect(renderMarkdown(r, summarize(r))).toMatch(/dirty/i);
  });
});

describe('writeResults', () => {
  it('writes a json file and a markdown file named for the run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bench-results-'));
    const r = run([sample()]);
    const { jsonPath, mdPath } = await writeResults(r, dir);

    expect(path.basename(jsonPath)).toBe('2026-08-06T2140-prayer_bench-seed42.json');
    expect(path.basename(mdPath)).toBe('2026-08-06T2140-prayer_bench-seed42.md');

    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as TimingRun;
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.conditions.seed).toBe(42);
    expect(await readFile(mdPath, 'utf8')).toContain('marginal permission cost');
  });
});

describe('resultBasename', () => {
  it('builds a chronologically sortable name from the run conditions', () => {
    expect(resultBasename(run([sample()]))).toBe('2026-08-06T2140-prayer_bench-seed42');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @prayer/db test bench-results`
Expected: FAIL — cannot resolve `../src/bench-results.js`.

- [ ] **Step 3: Implement**

Create `packages/db/src/bench-results.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TimedSample, TimingRun } from './bench-timing.js';

export interface Stats {
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface Summary {
  overall: Stats;
  floor: Stats;
  /** p50 check minus p50 floor: the marginal cost of the permission logic. */
  marginalMs: number;
  visibleShare: number;
  byCategory: Record<string, Stats>;
  byCohort: Record<string, Stats>;
  /** How often each rule decided. Denials are counted under `not_visible`. */
  byRule: Record<string, number>;
}

/** Nearest-rank. Returns 0 on an empty input rather than NaN. */
export function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedNs.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedNs.length - 1);
  return sortedNs[index] ?? 0;
}

const NS_PER_MS = 1_000_000;

function statsOf(ns: number[]): Stats {
  const sorted = [...ns].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: percentile(sorted, 50) / NS_PER_MS,
    p95Ms: percentile(sorted, 95) / NS_PER_MS,
    p99Ms: percentile(sorted, 99) / NS_PER_MS,
  };
}

function groupStats<K extends string>(
  samples: TimedSample[],
  key: (s: TimedSample) => K,
): Record<string, Stats> {
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const k = key(s);
    const existing = buckets.get(k);
    if (existing === undefined) buckets.set(k, [s.checkNs]);
    else existing.push(s.checkNs);
  }
  const out: Record<string, Stats> = {};
  for (const [k, ns] of buckets) out[k] = statsOf(ns);
  return out;
}

export function summarize(run: TimingRun): Summary {
  const overall = statsOf(run.samples.map((s) => s.checkNs));
  const floor = statsOf(run.samples.map((s) => s.floorNs));

  const byRule: Record<string, number> = {};
  for (const s of run.samples) {
    const k = s.visible ? (s.rule ?? 'unknown') : 'not_visible';
    byRule[k] = (byRule[k] ?? 0) + 1;
  }

  return {
    overall,
    floor,
    marginalMs: overall.p50Ms - floor.p50Ms,
    visibleShare:
      run.samples.length === 0
        ? 0
        : run.samples.filter((s) => s.visible).length / run.samples.length,
    byCategory: groupStats(run.samples, (s) => s.audienceCategory),
    byCohort: groupStats(run.samples, (s) => s.cohort),
    byRule,
  };
}

/** `2026-08-06T2140-prayer_bench-seed42` — sorts chronologically, reads plainly. */
export function resultBasename(run: TimingRun): string {
  const stamp = run.conditions.timestamp.slice(0, 16).replace(/:/g, '');
  return `${stamp}-${run.conditions.dataset}-seed${run.conditions.seed}`;
}

const ms = (n: number): string => n.toFixed(4);

function statsTable(title: string, byKey: Record<string, Stats>): string {
  const rows = Object.entries(byKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, s]) => `| ${k} | ${s.n} | ${ms(s.p50Ms)} | ${ms(s.p95Ms)} | ${ms(s.p99Ms)} |`)
    .join('\n');
  return `### ${title}\n\n| | samples | p50 (ms) | p95 (ms) | p99 (ms) |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n`;
}

export function renderMarkdown(run: TimingRun, summary: Summary): string {
  const c = run.conditions;
  const dirtyNote = c.gitDirty === true ? ' **(working tree dirty — not a clean build)**' : '';

  return `# Point-check timing — \`${c.dataset}\`, seed ${c.seed}

Generated ${c.timestamp}. Do not edit by hand; regenerate instead.

## Headline

\`\`\`
application wall-clock   ${ms(summary.overall.p50Ms)} ms   what the app waits for
round-trip floor         ${ms(summary.floor.p50Ms)} ms   driver + socket, measured not assumed
                         ${'-'.repeat(9)}
marginal permission cost ${ms(summary.marginalMs)} ms   the rules themselves
\`\`\`

| | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: |
| permission check | ${ms(summary.overall.p50Ms)} | ${ms(summary.overall.p95Ms)} | ${ms(summary.overall.p99Ms)} |
| round-trip floor | ${ms(summary.floor.p50Ms)} | ${ms(summary.floor.p95Ms)} | ${ms(summary.floor.p99Ms)} |

${summary.overall.n} samples, ${(summary.visibleShare * 100).toFixed(1)}% of which were visible to the viewer.

${statsTable('By audience category', summary.byCategory)}
${statsTable('By viewer connectivity', summary.byCohort)}
### Which rule decided

| rule | samples |
| --- | ---: |
${Object.entries(summary.byRule)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, n]) => `| ${k} | ${n} |`)
  .join('\n')}

## Conditions

| | |
| --- | --- |
| dataset | \`${c.dataset}\` |
| rows | ${c.rowCounts.users} users, ${c.rowCounts.posts} prayers, ${c.rowCounts.post_audiences} audience rows, ${c.rowCounts.group_members} group memberships, ${c.rowCounts.tag_members} tag memberships |
| samples / warmup | ${c.samples} / ${c.warmup} |
| seed | ${c.seed} |
| cache | ${c.cache} |
| Postgres | ${c.postgresVersion} |
| shared_buffers | ${c.sharedBuffers} |
| machine | ${c.machine.cpuModel}, ${c.machine.cpus} cores, ${c.machine.platform}/${c.machine.arch} |
| commit | ${c.gitCommit ?? 'unknown'}${dirtyNote} |
| EXPLAIN ANALYZE cross-check | ${c.explainMeanMs === null ? 'not run' : `${ms(c.explainMeanMs)} ms mean (instrumented; corroboration only)`} |

<details><summary>Indexes present (${c.indexes.length})</summary>

${c.indexes.map((i) => `- \`${i}\``).join('\n')}

</details>

## How to read this

Timing is wall-clock measured in the application around a single database call.
The floor is an interleaved \`SELECT 1\` on the same connection — driver, socket
and protocol, nothing else. Subtracting it isolates the permission logic.

**Limitations.** The dataset is small enough to sit entirely in \`shared_buffers\`,
so after warmup there is no disk I/O and these are CPU numbers. They compare
query formulations and indexes well; they do not predict behaviour at much
larger data volumes, where I/O begins to dominate. This measures the naive
reference check — the baseline optimisations are compared against, not a
shipping implementation. Every sample here was verified against an independent
implementation of the same rules; the run refuses to report otherwise.
`;
}

export async function writeResults(
  run: TimingRun,
  dir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(dir, { recursive: true });
  const base = resultBasename(run);
  const jsonPath = path.join(dir, `${base}.json`);
  const mdPath = path.join(dir, `${base}.md`);

  await writeFile(jsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMarkdown(run, summarize(run)), 'utf8');

  return { jsonPath, mdPath };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @prayer/db test bench-results`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/bench-results.ts packages/db/test/bench-results.test.ts
git commit -m "feat(db): percentiles and generated result files"
```

---

### Task 6: The bench API

The control channel. Everything it does is parse, delegate, write, respond — so there is almost nothing here to get wrong, which is the point.

**Files:**

- Create: `packages/db/src/bench.ts`
- Modify: `packages/db/package.json` (add the `./bench` export subpath)
- Create: `apps/bench-api/package.json`, `apps/bench-api/tsconfig.json`, `apps/bench-api/vitest.config.ts`
- Create: `apps/bench-api/src/app.ts`, `apps/bench-api/src/server.ts`
- Create: `apps/bench-api/test/point-check.test.ts`
- Create: `docs/bench-results/.gitkeep`
- Modify: `tsconfig.json` (root) — add the `apps/bench-api` reference

**Interfaces:**

- Consumes: everything above, via the new `@prayer/db/bench` subpath.
- Produces: `buildBenchApp(deps: BenchAppDeps): Express`, and `POST /bench/timing/point-check`.

- [ ] **Step 1: Add the bench export subpath**

Create `packages/db/src/bench.ts`:

```ts
/**
 * Entry point for benchmark consumers, exposed as `@prayer/db/bench`.
 *
 * Deliberately separate from `./index.ts`: the bench tables do not exist in
 * prayer_dev or the deployed database, so production code importing
 * `@prayer/db` must not be able to reach them. Anything re-exported here is
 * bench-only by definition.
 */
export { createBenchDb } from './bench-schema.js';
export type { BenchDatabase, BenchDb, GroupRole } from './bench-schema.js';
export { canSee } from './bench-visibility.js';
export type { CanSeeResult, VisibilityRule } from './bench-visibility.js';
export {
  expectedVisibility,
  loadPostFacts,
  loadViewerFacts,
} from './bench-visibility-reference.js';
export type { PostFacts, ViewerFacts } from './bench-visibility-reference.js';
export { drawPairs, loadSamplePool } from './bench-sampler.js';
export type {
  AudienceCategory,
  ConnectivityCohort,
  SamplePair,
  SamplePool,
} from './bench-sampler.js';
export { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from './migrate.js';
export { runPointCheckTiming } from './bench-timing.js';
export type { RunConditions, TimedSample, TimingOptions, TimingRun } from './bench-timing.js';
export {
  percentile,
  renderMarkdown,
  resultBasename,
  summarize,
  writeResults,
} from './bench-results.js';
export type { Stats, Summary } from './bench-results.js';
export { assertBenchDatabase, databaseName } from './bench-load-cli.js';
```

In `packages/db/package.json`, extend `exports`:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./bench": {
      "types": "./dist/bench.d.ts",
      "import": "./dist/bench.js"
    }
  },
```

- [ ] **Step 2: Scaffold the app**

Create `apps/bench-api/package.json`. **There is deliberately no `dev` script** — root `pnpm dev` is `pnpm -r --parallel dev` and would otherwise start this on every run.

```json
{
  "name": "@prayer/bench-api",
  "version": "0.0.0",
  "private": true,
  "license": "Elastic-2.0",
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "serve": "tsx watch src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc -b --dry"
  },
  "dependencies": {
    "@prayer/db": "workspace:*",
    "express": "^5.2.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "dotenv": "^17.4.2",
    "supertest": "^7.0.0",
    "tsx": "^4.23.1",
    "vitest": "^4.1.10"
  }
}
```

Create `apps/bench-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/db" }]
}
```

Create `apps/bench-api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
```

Create `apps/bench-api/test/global-setup.ts`. Without it `TEST_DATABASE_URL` is never
loaded and the bench tables may not exist — `pnpm -r test` runs packages first, but this
suite must not depend on another package's suite having run.

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from '@prayer/db/bench';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

// Deliberately does NOT drop the public schema, unlike packages/db's setup:
// this suite seeds its own org and must not destroy a sibling suite's fixtures.
// Both migrate calls are idempotent.
export async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required');

  await migrate({ direction: 'up', databaseUrl: testUrl });
  await migrate({
    direction: 'up',
    databaseUrl: testUrl,
    dir: BENCH_MIGRATIONS_DIR,
    migrationsTable: BENCH_MIGRATIONS_TABLE,
  });
}

export async function teardown(): Promise<void> {
  // Tests seed their own org; nothing global to tear down.
}
```

In the root `tsconfig.json`, add the reference:

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/db" },
    { "path": "apps/api" },
    { "path": "apps/bench-api" },
    { "path": "apps/web" }
  ]
}
```

Create `docs/bench-results/.gitkeep` as an empty file.

- [ ] **Step 3: Write the failing test**

Create `apps/bench-api/test/point-check.test.ts`:

```ts
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { newId } from '@prayer/db';
import { createBenchDb, type BenchDb } from '@prayer/db/bench';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildBenchApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let app: ReturnType<typeof buildBenchApp>;
let resultsDir: string;
let orgId: string;

beforeAll(async () => {
  db = createBenchDb(url);
  resultsDir = await mkdtemp(path.join(tmpdir(), 'bench-api-'));
  orgId = await seedTinyOrg(db);
  app = buildBenchApp({ db, orgId, databaseName: 'prayer_test', resultsDir });
});

afterAll(async () => {
  await db.destroy();
});

describe('POST /bench/timing/point-check', () => {
  it('runs the batch and writes both result files', async () => {
    const res = await request(app)
      .post('/bench/timing/point-check')
      .send({ samples: 10, seed: 42, warmup: 2 });

    expect(res.status).toBe(200);
    expect(res.body.summary.overall.n).toBe(10);
    expect(typeof res.body.files.json).toBe('string');
    expect(typeof res.body.files.markdown).toBe('string');

    const written = await readdir(resultsDir);
    expect(written.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(written.filter((f) => f.endsWith('.md'))).toHaveLength(1);
  });

  it('rejects a request with no sample count', async () => {
    const res = await request(app).post('/bench/timing/point-check').send({ seed: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects a sample count above the cap instead of running for minutes', async () => {
    const res = await request(app)
      .post('/bench/timing/point-check')
      .send({ samples: 1_000_000, seed: 1 });
    expect(res.status).toBe(400);
  });

  it('defaults the warmup rather than requiring it', async () => {
    const res = await request(app).post('/bench/timing/point-check').send({ samples: 5, seed: 9 });
    expect(res.status).toBe(200);
    expect(res.body.conditions.warmup).toBeGreaterThan(0);
  });
});
```

Append the seeding helper to the same file — it builds the smallest world the sampler can draw from:

```ts
async function seedTinyOrg(db: BenchDb): Promise<string> {
  const orgId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, slug: `bench-api-${orgId.slice(-8)}`, display_name: 'Bench API test' })
    .execute();

  const users = Array.from({ length: 5 }, (_, i) => {
    const id = newId();
    return {
      id,
      supabase_auth_id: newId(),
      email: `bapi${i}.${id}@fixture.invalid`,
      display_name: `Member ${i}`,
    };
  });
  await db.insertInto('users').values(users).execute();
  await db
    .insertInto('user_orgs')
    .values(users.map((u) => ({ user_id: u.id, org_id: orgId, role: 'member' as const })))
    .execute();

  const author = users[0];
  if (author === undefined) throw new Error('seedTinyOrg: no users');
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const posts = Array.from({ length: 5 }, (_, i) => ({
    id: newId(),
    org_id: orgId,
    parent_id: null,
    author_id: author.id,
    body: `bench-api fixture ${i}`,
    status: 'published' as const,
    edit_deadline: deadline,
  }));
  await db.insertInto('posts').values(posts).execute();
  await db
    .insertInto('post_audiences')
    .values(posts.map((p) => ({ post_id: p.id, church_id: orgId, group_id: null, tag_id: null })))
    .execute();

  return orgId;
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @prayer/bench-api test`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 5: Implement the app**

Create `apps/bench-api/src/app.ts`:

```ts
import { runPointCheckTiming, summarize, writeResults, type BenchDb } from '@prayer/db/bench';
import express, { type Express } from 'express';
import { z } from 'zod';

export interface BenchAppDeps {
  db: BenchDb;
  /** The single org in the bench database. Resolved once at startup. */
  orgId: string;
  /** Recorded in the results so a table can be traced to its dataset. */
  databaseName: string;
  resultsDir: string;
}

/**
 * The control channel, and nothing more.
 *
 * It parses, delegates, writes and responds — all the measurement lives in
 * @prayer/db, where the existing suite already has the bench tables. One
 * request runs the WHOLE batch: a permission check is well under a
 * millisecond while an HTTP round trip is ~0.1-1ms, so one-request-per-check
 * would measure HTTP rather than the check.
 *
 * This app deliberately does NOT compose `buildApp()` from @prayer/api. Bench
 * members have synthetic Supabase auth ids and no accounts exist, so
 * `requireAuth` would reject every request — and the middleware stack is not in
 * the measurement anyway. The feed route, when it arrives, MUST compose
 * `buildApp()` as the dataset spec requires, because that route measures what a
 * user actually pays end to end.
 */
const RequestSchema = z.object({
  // Capped: an unbounded batch would run for minutes behind a hung HTTP request.
  samples: z.number().int().min(1).max(100_000),
  seed: z.number().int().default(1),
  warmup: z.number().int().min(0).max(100_000).default(100),
});

export function buildBenchApp(deps: BenchAppDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, dataset: deps.databaseName });
  });

  app.post('/bench/timing/point-check', (req, res) => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', detail: parsed.error.issues });
      return;
    }

    void (async () => {
      try {
        const run = await runPointCheckTiming(deps.db, {
          orgId: deps.orgId,
          databaseName: deps.databaseName,
          samples: parsed.data.samples,
          seed: parsed.data.seed,
          warmup: parsed.data.warmup,
        });
        const files = await writeResults(run, deps.resultsDir);
        res.json({
          conditions: run.conditions,
          summary: summarize(run),
          files: { json: files.jsonPath, markdown: files.mdPath },
        });
      } catch (err: unknown) {
        // A correctness disagreement lands here. It is a refusal to report, not
        // a crash, and the message names the disagreeing pairs.
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  return app;
}
```

- [ ] **Step 6: Implement the server**

Create `apps/bench-api/src/server.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBenchDatabase, createBenchDb, databaseName } from '@prayer/db/bench';
import dotenv from 'dotenv';

import { buildBenchApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const PORT = Number(process.env.PORT ?? 3002);

async function main(): Promise<void> {
  const url = process.env.BENCH_DATABASE_URL;
  if (!url) throw new Error('BENCH_DATABASE_URL is required');
  // Same guard the loader uses: refuses prayer_dev, prayer_test and anything
  // that is not a bench database, before a single query runs.
  assertBenchDatabase(url);

  const db = createBenchDb(url);
  const org = await db.selectFrom('orgs').select(['id', 'slug']).execute();
  const only = org[0];
  if (org.length !== 1 || only === undefined) {
    throw new Error(
      `Expected exactly one org in ${databaseName(url)}, found ${org.length}. ` +
        'Run `pnpm --filter @prayer/db bench:load` first.',
    );
  }

  const app = buildBenchApp({
    db,
    orgId: only.id,
    databaseName: databaseName(url),
    resultsDir: path.resolve(__dirname, '..', '..', '..', 'docs', 'bench-results'),
  });

  app.listen(PORT, () => {
    console.log(`bench-api on :${PORT} → ${databaseName(url)} (org ${only.slug})`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Install and run the test**

```bash
pnpm install
pnpm --filter @prayer/db build
pnpm --filter @prayer/bench-api test
```

Expected: PASS — 4 tests. `pnpm --filter @prayer/db build` must run first: the bench-api test imports `@prayer/db/bench`, which resolves to `dist/bench.js`.

- [ ] **Step 8: Full check**

```bash
pnpm test
pnpm build
pnpm format && pnpm lint
```

Expected: all green. `pnpm build` is what CI runs and catches type errors Vitest permits.

- [ ] **Step 9: Verify it serves, against the real dataset**

```bash
BENCH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/prayer_bench \
  pnpm --filter @prayer/bench-api serve
```

In another shell:

```bash
curl -s localhost:3002/health
```

Expected: `{"ok":true,"dataset":"prayer_bench"}`.

**Do not run a timing batch.** The parameters are the human partner's to give; the harness ships idle. Stop the server after the health check.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/bench.ts packages/db/package.json apps/bench-api tsconfig.json \
        docs/bench-results/.gitkeep pnpm-lock.yaml
git commit -m "feat(bench-api): point-check timing endpoint"
```

---

## What this plan does not cover

- **The feed** — "the 20 newest prayers this member can see," ordered and paged. Deferred by decision until the point-check numbers pass review. It needs `buildApp()` from `@prayer/api`, a different harness, and the differential test that audits it against `canSee`.
- **Index experiments.** The harness records which indexes were present so an A/B is unambiguous, but choosing and testing indexes is separate work.
- **Cloud validation.** Local only. A round trip to Railway is 50–200ms against a sub-millisecond check.
