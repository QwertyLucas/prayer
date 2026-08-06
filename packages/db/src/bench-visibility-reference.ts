import type { BenchDb } from './bench-schema.js';
import type { CanSeeResult } from './bench-visibility.js';

/**
 * A second implementation of the three visibility rules, written deliberately
 * differently from `canSee`: set membership in TypeScript rather than joins in
 * SQL, over facts fetched separately.
 *
 * Its whole purpose is to disagree when `canSee` is wrong. A check that
 * verifies itself proves nothing, so the timing runner asserts every timed
 * result against this and refuses to report on any disagreement.
 */

/** Everything about a viewer that affects visibility. Fetched once, reused across many checks. */
export interface ViewerFacts {
  userId: string;
  /** Churches the viewer belongs to. */
  orgIds: Set<string>;
  /** Groups the viewer is a member of. */
  groupIds: Set<string>;
  /** Tags the viewer is a MEMBER of. Owning a tag is not membership in it. */
  tagIds: Set<string>;
  /** Churches where the viewer is a moderator or super_user. */
  privilegedOrgIds: Set<string>;
}

/** Everything about a prayer that affects visibility. */
export interface PostFacts {
  postId: string;
  authorId: string;
  orgId: string;
  churchIds: string[];
  groupIds: string[];
  tagIds: string[];
}

/** Pure. No database, no clock. */
export function expectedVisibility(viewer: ViewerFacts, post: PostFacts): CanSeeResult {
  if (post.authorId === viewer.userId) return { visible: true, rule: 'author' };
  if (post.churchIds.some((id) => viewer.orgIds.has(id))) return { visible: true, rule: 'church' };
  if (post.groupIds.some((id) => viewer.groupIds.has(id))) return { visible: true, rule: 'group' };
  if (post.groupIds.length > 0 && viewer.privilegedOrgIds.has(post.orgId)) {
    return { visible: true, rule: 'group_moderator' };
  }
  if (post.tagIds.some((id) => viewer.tagIds.has(id))) return { visible: true, rule: 'tag' };
  // No privilege arm on tags. This absence is the seal.
  return { visible: false, rule: null };
}

export async function loadViewerFacts(db: BenchDb, userId: string): Promise<ViewerFacts> {
  const orgs = await db
    .selectFrom('user_orgs')
    .select(['org_id', 'role'])
    .where('user_id', '=', userId)
    .execute();
  const groups = await db
    .selectFrom('group_members')
    .select('group_id')
    .where('user_id', '=', userId)
    .execute();
  const tags = await db
    .selectFrom('tag_members')
    .select('tag_id')
    .where('user_id', '=', userId)
    .execute();

  return {
    userId,
    orgIds: new Set(orgs.map((o) => o.org_id)),
    groupIds: new Set(groups.map((g) => g.group_id)),
    tagIds: new Set(tags.map((t) => t.tag_id)),
    privilegedOrgIds: new Set(
      orgs.filter((o) => o.role === 'moderator' || o.role === 'super_user').map((o) => o.org_id),
    ),
  };
}

export async function loadPostFacts(db: BenchDb, postId: string): Promise<PostFacts> {
  const post = await db
    .selectFrom('posts')
    .select(['id', 'author_id', 'org_id'])
    .where('id', '=', postId)
    .executeTakeFirst();
  if (post === undefined) throw new Error(`loadPostFacts: no prayer with id ${postId}`);

  const audiences = await db
    .selectFrom('post_audiences')
    .select(['church_id', 'group_id', 'tag_id'])
    .where('post_id', '=', postId)
    .execute();

  const nonNull = (xs: (string | null)[]): string[] => xs.filter((x): x is string => x !== null);

  return {
    postId,
    authorId: post.author_id,
    orgId: post.org_id,
    churchIds: nonNull(audiences.map((a) => a.church_id)),
    groupIds: nonNull(audiences.map((a) => a.group_id)),
    tagIds: nonNull(audiences.map((a) => a.tag_id)),
  };
}
