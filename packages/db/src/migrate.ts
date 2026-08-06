import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When compiled, this file lives at packages/db/dist/migrate.js — migrations directory is ../migrations.
// In dev (tsx), it lives at packages/db/src/migrate.ts — migrations directory is also ../migrations.
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
