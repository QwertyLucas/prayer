import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

/** Group-scoped roles. Deliberately distinct from `UserRole` (church-scoped). */
export type GroupRole = 'leader' | 'helper' | 'member';

export interface RolesTable {
  role: string;
}

export interface RolePermissionsTable {
  role: string;
  access_type: string;
}

export interface GroupsTable {
  id: string;
  church_id: string;
  name: string;
}

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  role: GroupRole;
}

export interface TagsTable {
  id: string;
  owner_id: string;
  church_id: string;
  name: string;
}

export interface TagMembersTable {
  tag_id: string;
  user_id: string;
}

export interface PostAudiencesTable {
  post_id: string;
  church_id: string | null;
  group_id: string | null;
  tag_id: string | null;
}

/**
 * Production tables plus the bench-only ones. Kept out of `schema.ts` on purpose:
 * these tables do not exist in prayer_dev or the deployed database, so production
 * code must not be able to reference them.
 */
export interface BenchDatabase extends Database {
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  tags: TagsTable;
  tag_members: TagMembersTable;
  post_audiences: PostAudiencesTable;
}

export type BenchDb = Kysely<BenchDatabase>;

export function createBenchDb(connectionString: string): BenchDb {
  return new Kysely<BenchDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}
