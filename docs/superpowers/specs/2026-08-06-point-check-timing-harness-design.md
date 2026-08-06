# Point-Check Timing Harness — Design

**Date:** 2026-08-06
**Status:** approved, pending implementation plan
**Depends on:** `2026-08-05-group-tag-visibility-design.md` (the dataset this measures)

---

## 1. What this is

A stopwatch for the permission decision, plus a button to press it.

The benchmark dataset exists — 1,000 members, 10,000 prayers, 58 groups, 1,960 personal
tags, 20 moderators and 2 super_users, loaded into `prayer_bench` and
`prayer_bench_stress`. **No code anywhere answers "can this person see this prayer?"**
The visibility rules are written down in the design spec and demonstrated ad hoc in psql,
but they have never been committed as code.

This harness supplies that code and measures it, producing a results table suitable for
a written report.

## 2. Scope

**In scope — the point check.** One person, one prayer, yes or no. No ordering, no paging,
no feed.

**Out of scope — the feed.** "The 20 newest prayers this member can see" is the next piece
of work, deferred by decision until the point-check numbers pass review. The feed costs
roughly 50–200 point checks plus ordering (measured: 46 rows walked in `prayer_bench`, 215
in `prayer_bench_stress`), so it is a different measurement with a different harness.

**Out of scope — production.** Nothing here touches `@prayer/api`, `prayer_dev`,
`prayer_test`, or the deployed Supabase database.

## 3. The visibility rules

Reproduced from the dataset design spec, section 3. The author always sees their own post;
this clause is load-bearing, because a tag owner is typically not a member of their own tag.

| #   | Audience    | Rule                                                                              |
| --- | ----------- | --------------------------------------------------------------------------------- |
| ①   | Church-wide | `author = M OR M belongs to that church`                                          |
| ②   | Group       | `author = M OR M ∈ group_members OR user_orgs.role IN ('moderator','super_user')` |
| ③   | Tag         | `author = M OR M ∈ tag_members` — **no role clause; sealed**                      |

A prayer with no audience rows is visible to its author alone.

A prayer may carry several audience rows. They are evaluated independently: a prayer
targeting both a group and a tag _is_ moderator-visible via its group row. The tag seal
does not extend to the whole post.

## 4. Components

Three units, each independently testable.

### 4.1 `canSee` — the permission check

`packages/db/src/bench-visibility.ts`

```
canSee(db: BenchDb, viewerId: string, postId: string): Promise<CanSeeResult>

interface CanSeeResult {
  visible: boolean;
  /** Which rule granted visibility. `null` when not visible. */
  rule: 'author' | 'church' | 'group' | 'group_moderator' | 'tag' | null;
}
```

`group_moderator` is distinct from `group` on purpose: it is how a run proves rule ②'s
privilege clause actually fires, and how a privilege clause wrongly reaching rule ③ would
become visible in the output rather than silently passing.

A direct, naive expression of the three rules — one `EXISTS` per rule. **It is written to be
obviously correct, not fast.** It is the oracle: the reference implementation that any
future optimised query is audited against, and the baseline every optimisation is compared
to.

Returns whether the prayer is visible and which rule decided it, so results can be broken
down by rule without a second query.

It lives in `packages/db` beside the bench schema types, not in the API app, so tests can
call it directly without HTTP.

### 4.2 The sampler

`packages/db/src/bench-sampler.ts`

Draws random (viewer, prayer) pairs from a seed, using the existing `makeRng`. Sampling is
**uniformly random** — that answers "what does a permission check cost in production,
weighted by how often each situation actually occurs."

Each pair is labelled with the prayer's audience kind and the viewer's connectivity cohort,
so a per-category breakdown falls out of a random run without needing a stratified one.
Rare categories will have few samples; the output states each category's sample count so a
thin cell is visible rather than misleading.

### 4.3 The timing runner

`apps/bench-api` (`@prayer/bench-api`), port 3002, one endpoint:

```
POST /bench/timing/point-check
{ "samples": 500, "seed": 42, "warmup": 100 }
```

Runs the batch in-process, times each check, verifies each answer, writes the results, and
returns the summary.

**One request runs the whole batch.** A permission check is well under a millisecond while
an HTTP round-trip is ~0.1–1ms, so one-request-per-check would measure HTTP. Batching pays
the network cost once, outside the measurement.

## 5. How it is measured

`pg_stat_statements` is unavailable — `shared_preload_libraries` is empty, and enabling it
requires restarting the container that also holds `prayer_dev` and `prayer_test`. So the
database-side cost is obtained by **calibrating the floor** rather than instrumenting the
query:

1. Time the permission check from the application — the full distribution.
2. Interleave a trivial `SELECT 1` on the same connection — the round-trip floor: driver,
   socket, protocol, nothing else.
3. The difference is the **marginal cost of the permission logic**.

This is preferred over `EXPLAIN ANALYZE`, whose instrumentation overhead lands in the very
number being quoted. `EXPLAIN ANALYZE` is still run on a small subsample as a sanity
cross-check and reported as such.

Reported side by side:

```
application wall-clock   0.094 ms   what the app waits for
round-trip floor         0.063 ms   driver + socket, measured not assumed
                         --------
marginal permission cost 0.031 ms   the rules themselves
```

### Rigor measures

- **Warmup** — a configurable count of discarded iterations, so plan caching and connection
  setup do not land in the data.
- **Correctness asserted per check.** Every result is compared against an expectation
  computed independently in TypeScript from the viewer's memberships, fetched once per
  viewer. If any check disagrees, **the run refuses to report.** A fast wrong number is the
  failure mode this project has already hit once.
- **A single pooled connection**, so connection churn is not in the numbers.
- **`ANALYZE` before measuring**, so the planner is not working from stale bulk-load
  statistics.
- **Percentiles, not means** — p50 / p95 / p99. The mean hides the tail.

## 6. Output

Two generated files per run in `docs/bench-results/`. Never hand-typed.

Filenames are `YYYY-MM-DDTHHmm-<dataset>-seed<N>.<ext>` — e.g.
`2026-08-06T2140-prayer_bench-seed42.json`. Minute precision sorts chronologically and is
readable; two runs in the same minute against the same dataset and seed would be the same
experiment, so the collision is not worth guarding against.

**The `.json` file** — every individual sample (viewer, prayer, deciding rule, visible,
elapsed) plus a conditions block:

| Field                                | Value                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `dataset`                            | database name, plus row counts for users / posts / post_audiences / group_members / tag_members                     |
| `samples`, `seed`, `warmup`          | as requested                                                                                                        |
| `cache`                              | `"warm"` — the harness always warms up; recorded so the assumption is explicit rather than implied                  |
| `postgres_version`, `shared_buffers` | read from the server at run time, not hardcoded                                                                     |
| `indexes`                            | the indexes present on `post_audiences`, `group_members`, `tag_members` at run time, so an index A/B is unambiguous |
| `machine`                            | platform, CPU model, core count                                                                                     |
| `timestamp`, `git_commit`            | ISO 8601; commit is the working tree's HEAD, flagged if dirty                                                       |

Retaining raw samples is what allows a percentile to be re-derived, a bimodal distribution
to be spotted, or a challenge answered, without re-running anything.

**`<timestamp>-<dataset>-seed<N>.md`** — the paste-ready table: overall percentiles, the
floor, the marginal cost, and breakdowns by audience kind and by viewer connectivity.

## 7. Deviation from the dataset spec

The dataset spec (section 6) states `bench-api` should import `buildApp()` from
`@prayer/api` to reuse the real auth and middleware.

**This harness does not, and the reason is concrete:** bench members have synthetic
Supabase auth ids and no accounts exist, so `requireAuth` would reject every request. More
fundamentally, the measurement is of a database query — the middleware stack is not in it.

`apps/bench-api` is therefore a thin Express app at this stage. **The feed route, when it
arrives, must compose `buildApp()`** as the spec requires, because that route measures what
a user actually pays end to end. This is recorded in the code, not only here.

## 8. Stated limitations

These belong in any write-up, stated up front rather than discovered by a reader.

- **Warm cache, CPU-bound.** The dataset is 16MB against 128MB of `shared_buffers`. After
  warmup there is no disk I/O. This compares query formulations and indexes well; it does
  **not** predict behaviour at 100× the data, where I/O begins to dominate.
- **This measures the naive check.** It is the baseline against which future optimisations
  are compared, not a shipping implementation.
- **The two datasets are not independent samples.** `prayer_bench` and
  `prayer_bench_stress` share identical members, groups, tags and roles; only the audience
  mix differs. Differences between them are attributable to the mix and to nothing else —
  which is the point — but they are not two draws from a population.
- **Local only.** Both bench databases exist solely in the local Docker container and are
  not reproducible byte-for-byte, since `newId()` is time-based.

## 9. Testing

- `canSee` is unit-tested against hand-built fixtures covering all three rules, the
  author clause, the empty-audience case, and the multi-audience case where a group row and
  a tag row coexist.
- The sampler is tested for determinism under a fixed seed and for correct category
  labelling.
- The runner is tested for: warmup exclusion, refusal to report on a correctness
  disagreement, and well-formed output files.
- The tag seal gets an explicit test: a moderator and a super_user who are neither author
  nor tag member must both be denied. This is the most sensitive rule in the design and the
  one where a wrongly-added privilege clause would be a silent privacy breach.
