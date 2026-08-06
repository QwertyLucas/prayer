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

  it('runs every timed query on one pinned Postgres backend', async () => {
    // A pg.Pool may hand consecutive queries to different backends, which would
    // make the floor meaningless — it is only comparable as the round-trip cost
    // of the SAME connection the check used. The runner records the backend pid
    // and throws if it changed mid-run, so this is a proof rather than a
    // heuristic about timing spread.
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 40,
      seed: 8,
      warmup: 20,
      databaseName: 'prayer_test',
    });
    expect(run.conditions.backendPid).not.toBeNull();
    expect(run.conditions.backendPid ?? 0).toBeGreaterThan(0);
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
    // draw over its members must have produced at least one grant and one denial.
    expect(run.samples.some((s) => s.visible)).toBe(true);
    expect(run.samples.some((s) => !s.visible)).toBe(true);
    expect(rules.has(null)).toBe(true);
  });

  it('refuses to report a run with no pairs to draw from', async () => {
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

  it('refuses to report when a check disagrees with the reference', async () => {
    // The correctness gate is the only thing standing between a wrong
    // permission check and a believable-looking number, so it is exercised
    // directly rather than assumed: a stub whose visibility answers are
    // deliberately wrong must make the run throw, not warn.
    await expect(
      runPointCheckTiming(
        db,
        {
          orgId: f.orgId,
          samples: 10,
          seed: 11,
          warmup: 0,
          databaseName: 'prayer_test',
        },
        // A "check" that grants everything to everyone. The reference denies
        // most of these pairs, so every disagreement must be caught.
        async () => ({ visible: true, rule: 'church' }),
      ),
    ).rejects.toThrow(/disagreed with the reference/i);
  });

  it('agrees with the reference on the real check, over the whole fixture', async () => {
    // The mirror image of the test above: if the gate fired on correct answers
    // it would be useless noise rather than a guard.
    const run = await runPointCheckTiming(db, {
      orgId: f.orgId,
      samples: 45,
      seed: 21,
      warmup: 0,
      databaseName: 'prayer_test',
    });
    expect(run.samples).toHaveLength(45);
  });
});
