import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { newId } from '../src/ids.js';
import { BENCH_MIGRATIONS_DIR, BENCH_MIGRATIONS_TABLE, migrate } from '../src/migrate.js';

const url = process.env.TEST_DATABASE_URL as string;

interface OrgAndUser {
  orgId: string;
  userId: string;
}

interface OrgUserAndPost extends OrgAndUser {
  postId: string;
}

// Seeds real orgs/users rows so FK constraints on org_id/author_id/user_id are
// already satisfied — the only thing left for a test to violate is the
// constraint actually under test, not an incidental FK on a fabricated id.
async function seedOrgAndUser(pool: Pool): Promise<OrgAndUser> {
  const orgId = newId();
  const userId = newId();
  await pool.query(`INSERT INTO orgs (id, slug, display_name) VALUES ($1, $2, $3)`, [
    orgId,
    `bench-test-${orgId}`,
    'Bench Test Org',
  ]);
  await pool.query(
    `INSERT INTO users (id, supabase_auth_id, email, display_name) VALUES ($1, $2, $3, $4)`,
    [userId, newId(), `bench-test-${userId}@example.com`, 'Bench Test User'],
  );
  return { orgId, userId };
}

async function cleanupOrgAndUser(pool: Pool, ids: OrgAndUser): Promise<void> {
  await pool.query('DELETE FROM users WHERE id = $1', [ids.userId]);
  await pool.query('DELETE FROM orgs WHERE id = $1', [ids.orgId]);
}

async function seedPost(pool: Pool): Promise<OrgUserAndPost> {
  const { orgId, userId } = await seedOrgAndUser(pool);
  const postId = newId();
  // edit_deadline is NOT NULL with no default.
  await pool.query(
    `INSERT INTO posts (id, org_id, author_id, body, edit_deadline)
     VALUES ($1, $2, $3, $4, NOW() + interval '1 hour')`,
    [postId, orgId, userId, 'Please pray.'],
  );
  return { orgId, userId, postId };
}

async function cleanupPost(pool: Pool, ids: OrgUserAndPost): Promise<void> {
  await pool.query('DELETE FROM posts WHERE id = $1', [ids.postId]);
  await cleanupOrgAndUser(pool, ids);
}

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
    const seed = await seedPost(pool);
    const groupId = newId();
    try {
      await pool.query(`INSERT INTO groups (id, church_id, name) VALUES ($1, $2, $3)`, [
        groupId,
        seed.orgId,
        'Bench Test Group',
      ]);
      // post_id, church_id, and group_id all point at rows that really exist —
      // only the post_audiences CHECK can reject this row.
      await expect(
        pool.query(
          `INSERT INTO post_audiences (post_id, church_id, group_id) VALUES ($1, $2, $3)`,
          [seed.postId, seed.orgId, groupId],
        ),
      ).rejects.toThrow();
    } finally {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      await cleanupPost(pool, seed);
      await pool.end();
    }
  });

  it('rejects an audience row naming no audience at all', async () => {
    const pool = new Pool({ connectionString: url });
    const seed = await seedPost(pool);
    try {
      // post_id points at a row that really exists — only the CHECK can reject this row.
      await expect(
        pool.query(`INSERT INTO post_audiences (post_id) VALUES ($1)`, [seed.postId]),
      ).rejects.toThrow();
    } finally {
      await cleanupPost(pool, seed);
      await pool.end();
    }
  });

  it('rejects a group member with an unknown role', async () => {
    const pool = new Pool({ connectionString: url });
    const { orgId, userId } = await seedOrgAndUser(pool);
    const groupId = newId();
    try {
      await pool.query(`INSERT INTO groups (id, church_id, name) VALUES ($1, $2, $3)`, [
        groupId,
        orgId,
        'Bench Test Group',
      ]);
      // group_id and user_id both point at rows that really exist —
      // only the role FK to roles(role) can reject this row.
      await expect(
        pool.query(
          `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'wizard')`,
          [groupId, userId],
        ),
      ).rejects.toThrow();
    } finally {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      await cleanupOrgAndUser(pool, { orgId, userId });
      await pool.end();
    }
  });
});
