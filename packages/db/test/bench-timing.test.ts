import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import { gitInfo, runPointCheckTiming } from '../src/bench-timing.js';

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
    // Corroboration pass ran and produced plausible in-database figures for
    // BOTH planning and execution — collapsing them into one number would
    // hide which of the two actually dominates.
    expect(c.explainPlanningMeanMs).not.toBeNull();
    expect(c.explainPlanningMeanMs ?? 0).toBeGreaterThan(0);
    expect(c.explainExecutionMeanMs).not.toBeNull();
    expect(c.explainExecutionMeanMs ?? 0).toBeGreaterThan(0);
    // `SHOW shared_buffers` names its column `shared_buffers`, not `setting` —
    // reading it under the wrong column name silently falls back to
    // 'unknown' on every run. Assert the real recorded value, not merely
    // that some string was produced.
    expect(c.sharedBuffers).not.toBe('unknown');
    expect(c.sharedBuffers).toMatch(/^\d+\s*(kB|MB|GB)$/i);
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

describe('gitInfo', () => {
  // Uses a disposable repo rather than asserting against this checkout's own
  // status, so the test doesn't depend on (or get confused by) whatever
  // tracked or untracked changes happen to be sitting in this working tree
  // when the suite runs.
  function makeTempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-timing-gitinfo-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    return dir;
  }

  it('does not flag a run dirty for an untracked file', () => {
    const dir = makeTempRepo();
    try {
      // A screenshot, a scratch note — never committed, never run. This must
      // not make a reproducible run look dirty.
      fs.writeFileSync(path.join(dir, 'untracked.png'), 'not-really-a-png');
      expect(gitInfo(dir).dirty).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a run dirty when a tracked file has uncommitted changes', () => {
    const dir = makeTempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'modified');
      expect(gitInfo(dir).dirty).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
