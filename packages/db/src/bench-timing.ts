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
import {
  canSee,
  visibilityClausesSql,
  type CanSeeResult,
  type VisibilityRule,
} from './bench-visibility.js';

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
  /**
   * EXPLAIN ANALYZE corroboration over a subsample, split into the two figures
   * Postgres actually reports. Both are inflated by EXPLAIN's own
   * instrumentation, so neither replaces the wall-clock figures — they
   * corroborate. Kept separate (rather than summed into one "explain" figure)
   * because for this query shape planning dominates execution by roughly 7x;
   * a single combined number would bury that finding.
   */
  explainPlanningMeanMs: number | null;
  explainExecutionMeanMs: number | null;
  /** The single Postgres backend every timed query ran on. Proves the floor is comparable. */
  backendPid: number | null;
}

export interface TimingRun {
  conditions: RunConditions;
  samples: TimedSample[];
}

/**
 * The thing being timed. Defaults to `canSee`; injectable ONLY so the
 * correctness gate below can be exercised against a deliberately wrong check.
 * A gate nobody has ever seen fire is not a gate.
 */
export type PointCheck = (db: BenchDb, viewerId: string, postId: string) => Promise<CanSeeResult>;

const INDEXED_TABLES = ['post_audiences', 'group_members', 'tag_members', 'user_orgs', 'posts'];

/** How many samples get the EXPLAIN ANALYZE corroboration pass. */
const EXPLAIN_SUBSAMPLE = 20;

interface ExplainRow {
  'QUERY PLAN': { 'Planning Time': number; 'Execution Time': number }[];
}

export interface ExplainSubsampleResult {
  planningMeanMs: number | null;
  executionMeanMs: number | null;
}

/**
 * Mean in-database planning and execution time over a handful of
 * already-timed pairs, kept as two separate figures rather than one.
 *
 * Postgres's own EXPLAIN output distinguishes "Planning Time" (choosing a
 * plan) from "Execution Time" (running it) — collapsing them into a single
 * number would hide which one actually dominates. For this query shape,
 * planning has been measured at roughly 7x execution, so labeling only the
 * execution figure as "the" database cost silently misrepresents where the
 * time goes.
 *
 * Reported as corroboration only. EXPLAIN ANALYZE's own instrumentation
 * inflates both numbers it produces, which is exactly why the headline
 * marginal cost comes from floor subtraction instead.
 */
async function explainSubsample(
  db: BenchDb,
  samples: TimedSample[],
): Promise<ExplainSubsampleResult> {
  if (samples.length === 0) return { planningMeanMs: null, executionMeanMs: null };
  const planningTimes: number[] = [];
  const executionTimes: number[] = [];
  for (const s of samples) {
    // Explains the EXACT statement canSee runs, not a paraphrase of it.
    const explained = await sql<ExplainRow>`
      EXPLAIN (ANALYZE, TIMING ON, FORMAT JSON) ${visibilityClausesSql(s.viewerId, s.postId)}
    `.execute(db);
    const plan = explained.rows[0]?.['QUERY PLAN'][0];
    if (plan !== undefined) {
      planningTimes.push(plan['Planning Time']);
      executionTimes.push(plan['Execution Time']);
    }
  }
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  return { planningMeanMs: mean(planningTimes), executionMeanMs: mean(executionTimes) };
}

/** The Postgres backend serving this connection. Used to prove the connection was pinned. */
async function backendPid(db: BenchDb): Promise<number> {
  const row = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  return Number(row.rows[0]?.pid ?? 0);
}

/**
 * `cwd` defaults to the process's working directory; exposed as a parameter
 * (rather than hardcoded) purely so tests can point it at a disposable repo
 * instead of asserting against whatever this checkout happens to look like.
 */
export function gitInfo(cwd: string = process.cwd()): {
  commit: string | null;
  dirty: boolean | null;
} {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim();
    // --untracked-files=no: dirty means "a tracked file the commit doesn't
    // account for has changed," not "there is untracked cruft lying around."
    // An untracked scratch file (a screenshot, a note) doesn't affect what
    // code ran, so it must not flag a reproducible run as dirty.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
      cwd,
    });
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
export async function runPointCheckTiming(
  db: BenchDb,
  opts: TimingOptions,
  check: PointCheck = canSee,
): Promise<TimingRun> {
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
  let explainPlanningMeanMs: number | null = null;
  let explainExecutionMeanMs: number | null = null;
  let backendPidUsed: number | null = null;

  // EVERY timed query runs on ONE pinned connection. `createBenchDb` builds a
  // pg.Pool, and a pool is free to hand consecutive queries to different
  // backends — which would wreck the floor calibration, since the floor is only
  // meaningful as the round-trip cost of the SAME connection the check used.
  // `db.connection()` pins one for the whole callback.
  await db.connection().execute(async (conn) => {
    const pidBefore = await backendPid(conn);

    // Warmup: discarded. Settles plan caching and connection setup.
    for (let i = 0; i < opts.warmup; i++) {
      const pair = pairs[i];
      if (pair === undefined) continue;
      await check(conn, pair.viewerId, pair.postId);
      await sql`SELECT 1`.execute(conn);
    }

    for (let i = opts.warmup; i < pairs.length; i++) {
      const pair = pairs[i];
      if (pair === undefined) continue;

      const floorStart = process.hrtime.bigint();
      await sql`SELECT 1`.execute(conn);
      const floorNs = Number(process.hrtime.bigint() - floorStart);

      const checkStart = process.hrtime.bigint();
      const result = await check(conn, pair.viewerId, pair.postId);
      const checkNs = Number(process.hrtime.bigint() - checkStart);

      // The correctness gate. A pair with no loaded facts is itself a failure:
      // it would mean an unverified sample slipping into the reported numbers.
      const viewer = viewerFacts.get(pair.viewerId);
      const post = postFacts.get(pair.postId);
      if (viewer === undefined || post === undefined) {
        disagreements.push(
          `${pair.viewerId} × ${pair.postId}: no reference facts were loaded for this pair`,
        );
      } else {
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
    const explainResult = await explainSubsample(conn, samples.slice(0, EXPLAIN_SUBSAMPLE));
    explainPlanningMeanMs = explainResult.planningMeanMs;
    explainExecutionMeanMs = explainResult.executionMeanMs;

    // Proof, not assumption. If the pool handed us a different backend part way
    // through, every floor measurement is against a connection the check never
    // used, and the marginal figure is meaningless. Verified rather than
    // trusted, because a silently wrong benchmark is the failure mode here.
    const pidAfter = await backendPid(conn);
    if (pidBefore !== pidAfter) {
      throw new Error(
        `runPointCheckTiming: the connection changed mid-run (backend ${pidBefore} → ${pidAfter}). ` +
          'The round-trip floor is only meaningful on the same connection as the check.',
      );
    }
    backendPidUsed = pidBefore;
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
  // `SHOW shared_buffers` returns a column literally named `shared_buffers`,
  // not `setting` — a `SELECT ... AS setting` query names its own column, so
  // it can't silently fall through to 'unknown' the way `SHOW` did here.
  const buffersRow = await sql<{ setting: string }>`
    SELECT current_setting('shared_buffers') AS setting
  `.execute(db);
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
      explainPlanningMeanMs,
      explainExecutionMeanMs,
      backendPid: backendPidUsed,
    },
    samples,
  };
}
