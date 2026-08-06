import { sql, type RawBuilder } from 'kysely';

import type { BenchDb } from './bench-schema.js';

/** Which rule granted visibility. */
export type VisibilityRule = 'author' | 'church' | 'group' | 'group_moderator' | 'tag';

export interface CanSeeResult {
  visible: boolean;
  /** `null` when the prayer is not visible. */
  rule: VisibilityRule | null;
}

export interface ClauseRow {
  by_author: boolean;
  by_church: boolean;
  by_group: boolean;
  by_group_moderator: boolean;
  by_tag: boolean;
}

/**
 * Can `viewerId` see `postId`?
 *
 * This is the ORACLE: a direct, one-EXISTS-per-rule transcription of the three
 * visibility rules. It is written to be obviously correct, not fast. Every
 * future optimised query is audited against it, and every optimisation is
 * measured against it as the baseline.
 *
 * All five clauses are evaluated in one round trip rather than short-circuited
 * across several, because the point of the harness is to time ONE database
 * call. Reporting which rule decided is what makes rule ②'s privilege clause
 * observable — and would make a privilege clause wrongly reaching rule ③'s
 * sealed tag path show up in the output instead of passing silently.
 *
 * Throws when the prayer does not exist. A sampler bug must surface as an
 * error rather than as a plausible-looking `visible: false`.
 */
export async function canSee(db: BenchDb, viewerId: string, postId: string): Promise<CanSeeResult> {
  const result = await visibilityClausesSql(viewerId, postId).execute(db);

  const row = result.rows[0];
  if (row === undefined) throw new Error(`canSee: no prayer with id ${postId}`);

  // Most specific truth first: a viewer who is both a group member and a
  // moderator is reported as a member, because they would see it either way.
  if (row.by_author) return { visible: true, rule: 'author' };
  if (row.by_church) return { visible: true, rule: 'church' };
  if (row.by_group) return { visible: true, rule: 'group' };
  if (row.by_group_moderator) return { visible: true, rule: 'group_moderator' };
  if (row.by_tag) return { visible: true, rule: 'tag' };
  return { visible: false, rule: null };
}

/**
 * The statement `canSee` runs, as a reusable fragment.
 *
 * Exported so the timing harness can wrap this EXACT statement in EXPLAIN
 * ANALYZE. A corroboration pass that explains a paraphrase of the query
 * corroborates nothing, and copying the SQL to a second call site would let the
 * two drift apart silently.
 */
export function visibilityClausesSql(viewerId: string, postId: string): RawBuilder<ClauseRow> {
  return sql<ClauseRow>`
    SELECT
      (p.author_id = ${viewerId}) AS by_author,

      -- ① church-wide: an audience row naming a church the viewer belongs to.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN user_orgs uo ON uo.org_id = a.church_id AND uo.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_church,

      -- ② group, membership arm.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN group_members gm ON gm.group_id = a.group_id AND gm.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_group,

      -- ② group, privilege arm. Scoped to the prayer's own church so a
      -- moderator of one church gains nothing in another.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN user_orgs uo ON uo.user_id = ${viewerId} AND uo.org_id = p.org_id
         WHERE a.post_id = p.id
           AND a.group_id IS NOT NULL
           AND uo.role IN ('moderator', 'super_user')
      ) AS by_group_moderator,

      -- ③ tag, sealed. There is deliberately NO privilege arm here.
      EXISTS (
        SELECT 1
          FROM post_audiences a
          JOIN tag_members tm ON tm.tag_id = a.tag_id AND tm.user_id = ${viewerId}
         WHERE a.post_id = p.id
      ) AS by_tag

      FROM posts p
     WHERE p.id = ${postId}
  `;
}
