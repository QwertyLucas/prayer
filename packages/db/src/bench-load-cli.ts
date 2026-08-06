import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { sql } from 'kysely';

import { AUDIENCE_MIX, type AudienceMix, STRESS_AUDIENCE_MIX } from './bench-fixtures.js';
import { loadBenchDataset } from './bench-loader.js';
import { createBenchDb, type BenchDb } from './bench-schema.js';
import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

const USAGE =
  'Usage: BENCH_DATABASE_URL=… pnpm bench:load [--mix realistic|stress]\n' +
  '  --mix stress  requires a database whose name contains "stress".';

/**
 * Resolves the mix from argv and cross-checks it against the target database.
 *
 * Three separate mistakes to make unreachable, all of which used to produce a
 * successful-looking load of the wrong dataset:
 *
 * - `--mix=stress` (the `=` form) did not match `argv.indexOf('--mix')`, so it
 *   silently loaded the **realistic** mix into prayer_bench_stress. Nothing
 *   downstream could tell; every conclusion drawn from that database would
 *   have been wrong.
 * - Any typo (`--mixx`, `--stress`) did the same thing, silently.
 * - Even a correctly-parsed flag can point at the wrong database. The database
 *   name is the one piece of intent that is impossible to get wrong by
 *   accident, so it is the authority: `…_stress` demands the stress mix and
 *   nothing else may have it.
 */
export function parseMix(
  argv: readonly string[],
  dbName: string,
): { name: string; mix: AudienceMix } {
  let name = 'realistic';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith('--mix=')) {
      name = token.slice('--mix='.length);
      continue;
    }
    if (token === '--mix') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`--mix needs a value.\n${USAGE}`);
      name = next;
      i++;
      continue;
    }
    throw new Error(`Unrecognised argument "${token}".\n${USAGE}`);
  }

  const mix = MIXES[name];
  if (!mix) {
    throw new Error(
      `Unknown --mix "${name}". Expected one of: ${Object.keys(MIXES).join(', ')}.\n${USAGE}`,
    );
  }

  const dbIsStress = dbName.includes('stress');
  if (dbIsStress && name !== 'stress') {
    throw new Error(
      `"${dbName}" is the stress database but --mix is "${name}".\n` +
        'Loading the realistic mix there would leave a database whose name promises one\n' +
        `dataset and whose contents are another. Pass --mix stress.\n${USAGE}`,
    );
  }
  if (!dbIsStress && name === 'stress') {
    throw new Error(
      `--mix stress was requested but "${dbName}" is not a stress database.\n` +
        'The stress dataset belongs in its own database, e.g. prayer_bench_stress, so the two\n' +
        `mixes never overwrite each other.\n${USAGE}`,
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

/** The database name out of a connection string: the path, minus its leading slash. */
export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/**
 * Refuses a target that is not a bench database, by name.
 *
 * `assertLocal` only checks the hostname, and `prayer_dev` / `prayer_test` live
 * on the same localhost Postgres. A single mistyped database name would
 * otherwise reach the bench migrations, and `groups` / `tags` /
 * `post_audiences` / `roles` / `pgmigrations_bench` would be left behind in the
 * app's own database even though the load itself aborted afterwards. Those
 * tables must never exist outside a bench database, so this runs before any
 * migration does.
 */
export function assertBenchDatabase(url: string): void {
  const name = databaseName(url);
  if (!name.includes('bench')) {
    throw new Error(
      `Refusing to load benchmark data into "${name}": a bench database name must contain "bench".\n` +
        'The bench migrations create tables (roles, groups, tags, post_audiences) that must never\n' +
        'exist in prayer_dev, prayer_test, or the deployed database.\n' +
        'Create a dedicated database first, e.g.:\n' +
        '  docker exec prayer-postgres psql -U postgres -c "CREATE DATABASE prayer_bench;"',
    );
  }
}

/**
 * Refuses a target that already holds data, before any migration runs.
 *
 * Three mistakes to stop, and this is the last moment at which stopping is free:
 *
 * - a second `bench:load` into an already-loaded bench database, which appends
 *   another 1,000 members and 10,000 prayers to the same org — the per-kind
 *   ratios still look right while every per-member number (feed depth, the
 *   isolated cohort) has quietly doubled;
 * - a bench database holding a *partial* population — users but no prayers —
 *   which the posts check alone waves straight through;
 * - an application database that slipped past the name check, which must not
 *   receive bench tables at all.
 *
 * A genuinely fresh database has no `posts` table yet — that is the normal
 * first-run path for both bench databases, so probe for the table before
 * querying it.
 */
export async function assertLoadable(db: BenchDb, name: string): Promise<void> {
  const probe = await sql<{ posts: string | null }>`
    SELECT to_regclass('public.posts')::text AS posts
  `.execute(db);
  if (!probe.rows[0]?.posts) return;

  const posts = await db
    .selectFrom('posts')
    .select(({ fn }) => fn.count<string>('id').as('n'))
    .executeTakeFirstOrThrow();
  if (Number(posts.n) > 0) {
    throw new Error(
      `"${name}" already holds ${posts.n} prayers — the loader appends, it does not replace.\n` +
        'Drop and recreate the database, then re-run.',
    );
  }

  // Prayers alone are not enough. A load that died after loadMembers leaves
  // users and zero posts, and adopting that org on the next run doubles the
  // population while the summary still prints 1,000. `loadBenchDataset` is
  // transactional now, so this is the belt to that braces: it catches the same
  // state arriving by any other route (an interrupted psql session, a
  // hand-run loadMembers, a restore from a partial dump).
  const users = await db
    .selectFrom('users')
    .select(({ fn }) => fn.count<string>('id').as('n'))
    .executeTakeFirstOrThrow();
  if (Number(users.n) > 0) {
    throw new Error(
      `"${name}" already holds ${users.n} users but no prayers — a previous load stopped\n` +
        'part-way through. Re-running would append a second population to the same org and\n' +
        'every per-member number would be silently wrong.\n' +
        'Drop and recreate the database, then re-run.',
    );
  }

  const foreign = await db
    .selectFrom('orgs')
    .select('slug')
    .where('slug', '<>', BENCH_SLUG)
    .execute();
  if (foreign.length > 0) {
    throw new Error(
      `"${name}" already belongs to another instance (orgs: ${foreign.map((o) => o.slug).join(', ')}).\n` +
        'Drop and recreate the database, then re-run.',
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.BENCH_DATABASE_URL;
  if (!url) throw new Error('BENCH_DATABASE_URL is required');
  assertLocal(url);
  assertBenchDatabase(url);
  const { name, mix } = parseMix(process.argv.slice(2), databaseName(url));

  const db = createBenchDb(url);
  try {
    // Before migrating, not after: applying the bench migrations to the wrong
    // database is the damage, and aborting the load afterwards does not undo it.
    await assertLoadable(db, databaseName(url));

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
    console.log(`  moderators ${summary.moderators}`);
    console.log(`  superusers ${summary.superUsers}`);
    console.log(`  groups     ${summary.groups}`);
    console.log(`  tags       ${summary.tags}`);
    console.log(`  prayers    ${summary.prayers}`);
    console.log(`  audiences  ${summary.audiences}`);
  } finally {
    await db.destroy();
  }
}

// Importable for tests; only runs the load when invoked directly.
// Same pattern as admin-create-org.ts.
if (process.argv[1] === __filename) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
