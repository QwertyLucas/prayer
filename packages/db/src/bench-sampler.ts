import type { BenchDb } from './bench-schema.js';

/**
 * Uniformly random (viewer, prayer) pairs, drawn from a seed.
 *
 * Sampling is uniform on purpose: it answers "what does a permission check cost
 * in production, weighted by how often each situation actually occurs." Each
 * pair carries the prayer's audience category and the viewer's connectivity, so
 * a per-category breakdown falls out of a random run without needing a
 * stratified one. Rare categories get few samples; the results report each
 * category's sample count so a thin cell is visible rather than misleading.
 */

export type AudienceCategory =
  'church' | 'group_only' | 'tag_only' | 'group_and_tag' | 'author_only';

/** Matches the cohorts in the dataset design spec's connectivity table. */
export type ConnectivityCohort = 'isolated' | 'low' | 'medium' | 'high';

export interface SamplePair {
  viewerId: string;
  postId: string;
  audienceCategory: AudienceCategory;
  cohort: ConnectivityCohort;
}

export interface SamplePool {
  viewers: { id: string; cohort: ConnectivityCohort }[];
  posts: { id: string; category: AudienceCategory }[];
}

function cohortOf(groupCount: number): ConnectivityCohort {
  if (groupCount === 0) return 'isolated';
  if (groupCount === 1) return 'low';
  if (groupCount <= 3) return 'medium';
  return 'high';
}

/**
 * A church-wide row makes the prayer visible to everyone, so it dominates any
 * other row it is combined with — it is classified as `church` regardless.
 */
function categoryOf(hasChurch: boolean, hasGroup: boolean, hasTag: boolean): AudienceCategory {
  if (hasChurch) return 'church';
  if (hasGroup && hasTag) return 'group_and_tag';
  if (hasGroup) return 'group_only';
  if (hasTag) return 'tag_only';
  return 'author_only';
}

export async function loadSamplePool(db: BenchDb, orgId: string): Promise<SamplePool> {
  // The group join is scoped through `groups.church_id`, not just `user_id`:
  // a member of two churches must not have another church's groups counted
  // toward their connectivity here.
  const viewerRows = await db
    .selectFrom('user_orgs')
    .leftJoin('group_members', 'group_members.user_id', 'user_orgs.user_id')
    .leftJoin('groups', (join) =>
      join.onRef('groups.id', '=', 'group_members.group_id').on('groups.church_id', '=', orgId),
    )
    .select(({ fn }) => [
      'user_orgs.user_id as id',
      fn.count<string>('groups.id').as('group_count'),
    ])
    .where('user_orgs.org_id', '=', orgId)
    .groupBy('user_orgs.user_id')
    .execute();

  const postRows = await db
    .selectFrom('posts')
    .leftJoin('post_audiences', 'post_audiences.post_id', 'posts.id')
    .select(({ fn }) => [
      'posts.id as id',
      fn.count<string>('post_audiences.church_id').as('church_rows'),
      fn.count<string>('post_audiences.group_id').as('group_rows'),
      fn.count<string>('post_audiences.tag_id').as('tag_rows'),
    ])
    .where('posts.org_id', '=', orgId)
    .groupBy('posts.id')
    .execute();

  return {
    viewers: viewerRows.map((r) => ({ id: r.id, cohort: cohortOf(Number(r.group_count)) })),
    posts: postRows.map((r) => ({
      id: r.id,
      category: categoryOf(
        Number(r.church_rows) > 0,
        Number(r.group_rows) > 0,
        Number(r.tag_rows) > 0,
      ),
    })),
  };
}

export function drawPairs(pool: SamplePool, count: number, rng: () => number): SamplePair[] {
  if (pool.viewers.length === 0 || pool.posts.length === 0) {
    throw new Error('drawPairs: the sample pool is empty — is the bench dataset loaded?');
  }

  const pairs: SamplePair[] = [];
  for (let i = 0; i < count; i++) {
    const viewer = pool.viewers[Math.floor(rng() * pool.viewers.length)];
    const post = pool.posts[Math.floor(rng() * pool.posts.length)];
    if (viewer === undefined || post === undefined) continue;
    pairs.push({
      viewerId: viewer.id,
      postId: post.id,
      audienceCategory: post.category,
      cohort: viewer.cohort,
    });
  }
  return pairs;
}
