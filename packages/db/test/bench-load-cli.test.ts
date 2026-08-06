import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { AUDIENCE_MIX, STRESS_AUDIENCE_MIX } from '../src/bench-fixtures.js';
import {
  assertBenchDatabase,
  assertLoadable,
  databaseName,
  parseMix,
} from '../src/bench-load-cli.js';
import { createBenchDb } from '../src/bench-schema.js';

const url = process.env.TEST_DATABASE_URL as string;

describe('bench:load target guards', () => {
  it('refuses any database whose name does not mark it as a bench database', () => {
    // assertLocal only checks the hostname, and prayer_dev / prayer_test sit on
    // the same localhost Postgres. Without this, a mistyped BENCH_DATABASE_URL
    // gets far enough to apply the bench migrations, leaving groups/tags/
    // post_audiences/roles behind in the app's own database.
    for (const name of ['prayer_dev', 'prayer_test', 'postgres']) {
      expect(() =>
        assertBenchDatabase(`postgres://postgres:postgres@localhost:5432/${name}`),
      ).toThrow(/bench/);
    }
  });

  it('accepts the two bench databases', () => {
    for (const name of ['prayer_bench', 'prayer_bench_stress']) {
      expect(() =>
        assertBenchDatabase(`postgres://postgres:postgres@localhost:5432/${name}`),
      ).not.toThrow();
    }
  });

  it('parses --mix in both the space and the equals form', () => {
    // Regression test: argv.indexOf('--mix') never matched '--mix=stress', so
    // `pnpm bench:load --mix=stress` against prayer_bench_stress silently
    // loaded the REALISTIC mix. Every check passed, the load succeeded, and
    // the only signal was one printed line — while every conclusion drawn from
    // that database was about the wrong dataset.
    expect(parseMix(['--mix', 'stress'], 'prayer_bench_stress').mix).toBe(STRESS_AUDIENCE_MIX);
    expect(parseMix(['--mix=stress'], 'prayer_bench_stress').mix).toBe(STRESS_AUDIENCE_MIX);
    expect(parseMix(['--mix=realistic'], 'prayer_bench').mix).toBe(AUDIENCE_MIX);
    expect(parseMix([], 'prayer_bench')).toEqual({ name: 'realistic', mix: AUDIENCE_MIX });
  });

  it('throws on a typo instead of quietly defaulting to realistic', () => {
    for (const argv of [['--mixx=stress'], ['--stress'], ['stress'], ['--mix']]) {
      expect(() => parseMix(argv, 'prayer_bench_stress'), argv.join(' ')).toThrow();
    }
    expect(() => parseMix(['--mix', 'strss'], 'prayer_bench_stress')).toThrow(/Unknown --mix/);
  });

  it('requires the mix and the database name to agree', () => {
    // The database name is the one piece of intent that cannot be mistyped
    // into something plausible — it is the authority on which dataset belongs
    // where. This makes "right flag, wrong database" unreachable in both
    // directions.
    expect(() => parseMix(['--mix=realistic'], 'prayer_bench_stress')).toThrow(
      /is the stress database but --mix is "realistic"/,
    );
    expect(() => parseMix([], 'prayer_bench_stress')).toThrow(/is the stress database/);
    expect(() => parseMix(['--mix=stress'], 'prayer_bench')).toThrow(
      /"prayer_bench" is not a stress database/,
    );
  });

  it('reads the database name out of the connection string', () => {
    expect(databaseName('postgres://postgres:postgres@localhost:5432/prayer_bench')).toBe(
      'prayer_bench',
    );
  });

  it('refuses a bench database that holds users but no prayers', async () => {
    // A load that stopped after loadMembers leaves exactly this state, and the
    // posts check alone waves it through: loadOrg adopts the leftover org and
    // the next run appends a second population to it — 2,000 members in a
    // church whose summary prints 1,000, with a 200-member isolated cohort.
    //
    // Built inside a transaction that always rolls back, so the shared test
    // database is unchanged and the assertion does not depend on whatever
    // earlier test files left behind.
    const db = createBenchDb(url);
    try {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`TRUNCATE posts CASCADE`.execute(trx);
          await trx
            .insertInto('users')
            .values({
              id: '019eff00-0000-7000-8000-0000000000ab',
              supabase_auth_id: '019eff00-0000-7000-8000-0000000000ac',
              email: 'partial-load@bench.invalid',
              display_name: 'Partial Load',
            })
            .execute();
          await assertLoadable(trx, 'prayer_bench');
        }),
      ).rejects.toThrow(/already holds \d+ users but no prayers/);
    } finally {
      await db.destroy();
    }
  });

  it('refuses a database that already holds another instance’s data', async () => {
    // The test database is migrated and carries the default `hope` org, so it
    // stands in for exactly the mistake this guard exists to catch: a real
    // application database passed as BENCH_DATABASE_URL.
    const db = createBenchDb(url);
    const name = databaseName(url);
    try {
      await expect(assertLoadable(db, name)).rejects.toThrow(new RegExp(name));
    } finally {
      await db.destroy();
    }
  });
});
