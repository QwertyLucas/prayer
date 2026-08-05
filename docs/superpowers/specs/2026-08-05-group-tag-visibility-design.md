# Group / Tag Post Visibility — Design & Benchmark Dataset

**Status:** draft, pending approval
**Date:** 2026-08-05

Adds audience-scoped prayers (groups, personal tags) to the prayer app, plus a benchmark
dataset and harness for measuring how fast the system decides who can see what.

---

## 1. Problem

Today every post is visible to the whole church. Visibility is three predicates folded into
the fetch query — `posts.org_id = <caller's org>`, `posts.status`, and role gates in
middleware (`apps/api/src/services/feed.ts:63,73`). There is no per-post audience model.

We want prayers shareable to a **group** (church-run, e.g. Worship Team) or a **tag**
(personal, e.g. Alice's family), and we want to know what that costs at scale.

---

## 2. Schema

Six new tables. `orgs`, `users`, and `posts` already exist.

```sql
groups (
  id         UUID PRIMARY KEY,
  church_id  UUID NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  name       TEXT NOT NULL )

group_members (
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' REFERENCES roles(role),
  PRIMARY KEY (group_id, user_id) )

tags (
  id         UUID PRIMARY KEY,
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  church_id  UUID NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  name       TEXT NOT NULL )

tag_members (
  tag_id     UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, user_id) )

post_audiences (
  post_id    UUID NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
  church_id  UUID NULL REFERENCES orgs(id)   ON DELETE CASCADE,
  group_id   UUID NULL REFERENCES groups(id) ON DELETE CASCADE,
  tag_id     UUID NULL REFERENCES tags(id)   ON DELETE CASCADE,
  CHECK (num_nonnulls(church_id, group_id, tag_id) = 1) )

roles (
  role         TEXT PRIMARY KEY )

role_permissions (
  role         TEXT NOT NULL REFERENCES roles(role) ON DELETE CASCADE,
  access_type  TEXT NOT NULL,
  PRIMARY KEY (role, access_type) )
```

### Design decisions

**`post_audiences` points at a set, never at a person.** Adding Bob to Alice's `family`
tag does not rewrite any post row. This is the Zanzibar indirection.

**Three nullable FKs instead of `(audience_kind, audience_id)`.** The original plan used a
polymorphic pointer, which Postgres cannot constrain: deleting a tag would leave orphan
audience rows, and nothing would stop a `kind='group'` row pointing at a tag id. Three
nullable FK columns plus a `CHECK` keeps identical semantics with real cascades.

**Roles govern actions, never visibility.** `roles` names the roles that exist;
`role_permissions` says what each can do — many rows per role, so one role holds several
powers. The read path never joins these tables.

**Role list is global**, shared by every church. Adding a role is `INSERT`, not a
migration. Caveat: a new _role_ composed of existing powers is free; a new _access_type_
requires code that checks for it.

**Group role names stay distinct from church role names.** The live `user_role` enum is
`member | moderator | super_user` (church-wide, in `user_orgs`, migration 0020). Group
roles ship as `leader | helper | member` so the two scopes can't be confused in code.

---

## 3. Visibility rules

The author always sees their own post. This clause is load-bearing: a tag owner is
typically _not_ a member of their own tag, so without it Alice could not read a prayer
she posted to her own `family` tag.

### ① Church-wide

```
author = M  OR  M belongs to that church
```

Short-circuits before any join. The most common post is the cheapest check.

### ② Group

```
author = M  OR  M ∈ group_members  OR  user_orgs.role IN ('moderator','super_user')
```

Groups are church community space, so moderators can moderate them.

### ③ Tag — sealed

```
author = M  OR  M ∈ tag_members
```

**No role clause exists.** A super_user gets the same answer as a brand-new member.
If Alice puts John and Taylor in `family` and posts there, the readers are Alice, John,
and Taylor — nobody else, ever.

**Accepted consequence:** a reported tag-shared prayer cannot be opened by any moderator.
Flag-count auto-hide (migration 0014) still applies, but human review is impossible by
construction. This is a deliberate privacy trade.

**Accepted edge case:** audience rows are evaluated independently, so a prayer targeting
both a group and a tag _is_ moderator-visible via its group row. The tag seal does not
extend to the whole post. Compose UI should say so at share time.

**Church-wide is a superset, not a peer.** A church-wide post gains no readers from an
additional group or tag row. Only `group∩group`, `group∩tag`, and `tag∩tag` overlaps are
meaningful.

---

## 4. Benchmark dataset

1 church · 1,000 members · 10,000 prayers (10 per member).

### Groups — 58 total

| Tier           | Groups                                                                                                                                                                                                   |  Count | Avg size | Memberships |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------: | ----------: |
| Life stage     | Youth Group, Young Adults, Men's Fellowship, Women's Fellowship, Seniors, Married Couples                                                                                                                |      6 |      150 |         900 |
| Ministry teams | Sunday Worship, Saturday Worship, Youth Leadership, Toddler & Nursery, Children's Ministry, Media & Tech, Ushers & Hospitality, Prayer Team, Outreach & Missions, Care Team, Finance & Admin, Facilities |     12 |       29 |         350 |
| Home groups    | Home Group 01 … 40                                                                                                                                                                                       |     40 |       26 |       1,050 |
| **Total**      |                                                                                                                                                                                                          | **58** |          |   **2,300** |

### Groups per member

| Groups joined | Members | Purpose in the mix                                  |
| ------------- | ------: | --------------------------------------------------- |
| 0             |     100 | **The isolated member** — the slow feed case        |
| 1             |     300 | One life-stage group                                |
| 2–3           |     350 | Typical: life stage + home group                    |
| 4–6           |     250 | **The connected member** — leaders on several teams |

The 100 zero-group members are deliberate. A well-connected member's feed is fast —
Postgres finds 20 visible posts and stops. An isolated member forces a walk back through
thousands of invisible posts to fill one page. Without them the benchmark reports only
the easy case.

### Tags

|                    | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Tags owned         | 2,000 (avg 2 per member; min 1, max 3)                            |
| Names drawn from   | family, close friends, prayer partners, work, college, neighbours |
| Members per tag    | 3–12, avg 6                                                       |
| `tag_members` rows | 12,000                                                            |

### Prayer audience dispersion

| Kind        |    Prayers | audience rows | Exercises                                                                                                                       |
| ----------- | ---------: | ------------: | ------------------------------------------------------------------------------------------------------------------------------- |
| Church-wide |      4,000 |         4,000 | Rule ① short-circuit                                                                                                            |
| One group   |      2,200 |         2,200 | Rule ② single join                                                                                                              |
| 2–3 groups  |        900 |         2,160 | `group∩group` — must not duplicate rows                                                                                         |
| One tag     |      1,500 |         1,500 | Rule ③ sealed — moderator lockout                                                                                               |
| 2–3 tags    |        400 |           920 | `tag∩tag` — overlapping personal circles                                                                                        |
| Group + tag |        800 |         1,760 | `group∩tag` — moderator sees it via the group                                                                                   |
| Author-only |        200 |             0 | Zero audience rows — a private prayer journal, distinct from `status='draft'`. Asserts a post with no audience leaks to nobody. |
| **Total**   | **10,000** |    **12,540** |                                                                                                                                 |

### Total volume

| Table                    |                   Rows |
| ------------------------ | ---------------------: |
| orgs                     |                      1 |
| users                    |                  1,000 |
| groups                   |                     58 |
| group_members            |                  2,300 |
| tags                     |                  2,000 |
| tag_members              |                 12,000 |
| posts                    |                 10,000 |
| post_audiences           |                 12,540 |
| roles + role_permissions |                    ~15 |
| **Total**                | **~40,000 (a few MB)** |

### Storage

`prayer_bench`, a new database in the Postgres 16 container already used for
`prayer_dev` and `prayer_test`. Reached via `BENCH_DATABASE_URL` so the same scripts can
later target a throwaway Supabase project by changing one env var.

**Not** the live Supabase project (`bhwboyipgrgovsusalrq`) — that holds the real church's
data and would compete with it for shared free-tier CPU.

### Migrations — bench-only

The six tables do **not** join the main migration sequence. They live in a separate
`packages/db/bench-migrations/` directory applied only to `prayer_bench`:

```
packages/db/
├── migrations/          0001..0029 — prod, unchanged
└── bench-migrations/    NEW, prayer_bench only
    ├── b001_groups.sql
    ├── b002_tags.sql
    ├── b003_post_audiences.sql
    └── b004_roles.sql
```

`prayer_dev`, `prayer_test`, and the live Supabase database are untouched. Promoting this
to production later is a file move plus renumbering into the `0030+` sequence.

**Consequence:** the Kysely schema types in `packages/db/src/schema.ts` must not gain these
tables either. If they did, code in `@prayer/api` referencing `group_members` would compile
cleanly and then fail at runtime against `prayer_dev`, where the table does not exist. The
bench tables get their own type definitions, kept separate from the production schema.

---

## 5. Testing

**Correctness oracle — "can person A see person B's post?"** A direct expression of the
three rules. Cheap to run, easy to assert.

**Performance target — the feed.** "Every post this member can see," ordered and paged.
This is what a user waits on.

**Differential test binding them together:** for any member M, the set of posts the feed
returns must be exactly the set where the point check returns true. Any disagreement is a
bug — specifically the class that matters here, since feed queries fail via `LEFT JOIN` +
`OR` producing duplicate rows, leaks across tag boundaries, or posts that silently vanish.
The point check is simple enough to trust; the feed query is not. Use the simple one to
audit the fast one.

---

## 6. The benchmark API

A new workspace app, `apps/bench-api` (`@prayer/bench-api`), on port 3002.

```
apps/
├── api/         @prayer/api        :3001  → prayer_dev    (untouched)
├── bench-api/   @prayer/bench-api  :3002  → prayer_bench  (NEW)
└── web/         @prayer/web        :5173
```

It imports `buildApp()` from `@prayer/api` (`apps/api/src/app.ts:80`), which is already
fully dependency-injected — `db`, `env`, `jwtVerifier`, `logger`, `corsOrigin`,
`rateLimitEnabled`, `databaseUrl`, `storage`. The API test helpers use the same seam
(`apps/api/test/helpers/supertest.ts:45`).

That gives the real `requireAuth`, `orgContext`, and rate limiters with **no duplicated
middleware and no drift risk** — it is the real stack, not a copy of it. It also keeps
bench-only table types out of the production API bundle, which the bench-only migration
decision requires.

Adds one route: `GET /bench/feed` — "every prayer this member can see," ordered and paged.

Per-request query timing is built in from the start, so a slow number can be attributed to
the query, the serialization, or a middleware layer. Cheap now, painful to retrofit.

---

## 7. Running it

### Phase 1 — local (the iteration loop)

```bash
docker exec prayer-postgres psql -U postgres -c "CREATE DATABASE prayer_bench;"
BENCH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/prayer_bench \
  PORT=3002 pnpm --filter @prayer/bench-api dev
```

API and database on the same machine, no network in the path. Reload the dataset in
seconds to try a different index.

### Phase 2 — cloud validation (optional, later)

Only once the schema is settled locally and the question becomes "what does a real member
experience." Requires both halves deployed:

| Piece               | Where                                                         |
| ------------------- | ------------------------------------------------------------- |
| `bench-api`         | Railway — **a new project**, not `comfortable-acceptance`     |
| `prayer_bench` data | A throwaway Supabase project — **not** `bhwboyipgrgovsusalrq` |

Railway is right for this step specifically because `@prayer/api` already runs there
(`prayerapi-production.up.railway.app`), so numbers compare to production rather than
introducing a new infrastructure variable.

**Do not deploy during iteration.** A round-trip to Railway is 50–200ms and varies run to
run, while the access check itself is well under a millisecond — the signal would be ~0.5%
of the reading. Tear the service down after measuring; a second always-on service consumes
Railway quota.

---

## 8. Open items

- Index strategy for the feed direction — it needs different indexes than the point check.
  To be determined empirically once the dataset is loaded.
