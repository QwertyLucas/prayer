import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { AUDIENCE_MIX, type AudienceMix, STRESS_AUDIENCE_MIX } from './bench-fixtures.js';
import { loadBenchDataset } from './bench-loader.js';
import { createBenchDb } from './bench-schema.js';
import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

/** Same slug in both bench databases, so one hostname works against either. */
const BENCH_SLUG = 'bench';

/**
 * Two datasets, two databases, one slug.
 *
 * `realistic` is the honest shape of a church feed: 40% church-wide, so page 1
 * fills from the firehose for everyone. `stress` drops that to ~10%, forcing a
 * real walk through group/tag audiences to fill a page.
 *
 * They go into separate databases rather than separate orgs because
 * `apps/api/src/middleware/org-context.ts` refuses to resolve an org when a
 * localhost database holds more than one.
 */
const MIXES: Record<string, AudienceMix> = {
  realistic: AUDIENCE_MIX,
  stress: STRESS_AUDIENCE_MIX,
};

function parseMix(argv: string[]): { name: string; mix: AudienceMix } {
  const idx = argv.indexOf('--mix');
  const name = idx === -1 ? 'realistic' : (argv[idx + 1] ?? '');
  const mix = MIXES[name];
  if (!mix) {
    throw new Error(
      `Unknown --mix "${name}". Expected one of: ${Object.keys(MIXES).join(', ')}.\n` +
        'Usage: BENCH_DATABASE_URL=… pnpm bench:load [--mix realistic|stress]',
    );
  }
  return { name, mix };
}

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `Refusing to load benchmark data into a non-local database (${host}).\n` +
        'The bench dataset is ~40k rows and must never touch the live deployment.',
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.BENCH_DATABASE_URL;
  if (!url) throw new Error('BENCH_DATABASE_URL is required');
  assertLocal(url);
  const { name, mix } = parseMix(process.argv.slice(2));

  // The bench database is its own single-tenant cell. 0021_add_org_id seeds a
  // default org (`hope` unless told otherwise) into every fresh database, and
  // `resolveLocalhost` refuses to resolve an org when a localhost database holds
  // more than one — so name the seeded org `bench` and let loadOrg adopt it.
  // Same slug in both bench databases: one hostname, either dataset.
  process.env.MIGRATION_DEFAULT_ORG_SLUG = BENCH_SLUG;
  process.env.MIGRATION_DEFAULT_ORG_NAME = 'Bench Church';

  console.log('Applying main migrations…');
  await migrate({ direction: 'up', databaseUrl: url });
  console.log('Applying bench migrations…');
  await migrate({
    direction: 'up',
    databaseUrl: url,
    dir: BENCH_MIGRATIONS_DIR,
    migrationsTable: BENCH_MIGRATIONS_TABLE,
  });

  const db = createBenchDb(url);
  try {
    // A second run would append another 1,000 members and 10,000 prayers to the
    // same org — the per-kind ratios would still look right while every
    // per-member number (feed depth, isolated cohort) quietly doubled.
    const existing = await db
      .selectFrom('posts')
      .select(({ fn }) => fn.count<string>('id').as('n'))
      .executeTakeFirstOrThrow();
    if (Number(existing.n) > 0) {
      throw new Error(
        `This database already holds ${existing.n} prayers — the loader appends, it does not replace.\n` +
          'Drop and recreate the database, then re-run.',
      );
    }

    const summary = await loadBenchDataset(db, {
      slug: BENCH_SLUG,
      members: 1000,
      seed: 1,
      mix,
    });
    console.log('\nLoaded:');
    console.log(`  mix        ${name}`);
    console.log(`  org        ${summary.orgId}`);
    console.log(`  members    ${summary.members}`);
    console.log(`  groups     ${summary.groups}`);
    console.log(`  tags       ${summary.tags}`);
    console.log(`  prayers    ${summary.prayers}`);
    console.log(`  audiences  ${summary.audiences}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
