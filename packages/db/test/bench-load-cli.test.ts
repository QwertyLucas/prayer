import { describe, expect, it } from 'vitest';

import { assertBenchDatabase, assertLoadable, databaseName } from '../src/bench-load-cli.js';
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

  it('reads the database name out of the connection string', () => {
    expect(databaseName('postgres://postgres:postgres@localhost:5432/prayer_bench')).toBe(
      'prayer_bench',
    );
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
