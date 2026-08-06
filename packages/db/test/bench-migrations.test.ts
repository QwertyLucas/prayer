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
});
