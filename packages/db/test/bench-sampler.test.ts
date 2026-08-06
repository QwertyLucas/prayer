import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeRng } from '../src/bench-fixtures.js';
import { drawPairs, loadSamplePool, type SamplePool } from '../src/bench-sampler.js';
import { createBenchDb, type BenchDb } from '../src/bench-schema.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;
let pool: SamplePool;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-sampler');
  pool = await loadSamplePool(db, f.orgId);
});

afterAll(async () => {
  await db.destroy();
});

describe('loadSamplePool', () => {
  it('loads every member of the church and no one else', () => {
    // The fixture puts 9 people in this church; the foreigner belongs to
    // `otherOrgId` and must not appear.
    expect(pool.viewers).toHaveLength(9);
    expect(pool.viewers.map((v) => v.id)).not.toContain(f.foreignerId);
  });

  it('labels connectivity from group count', () => {
    const byId = new Map(pool.viewers.map((v) => [v.id, v.cohort]));
    expect(byId.get(f.outsiderId)).toBe('isolated'); // 0 groups
    expect(byId.get(f.groupMemberId)).toBe('low'); // 1 group
  });

  it('labels every prayer with its audience category', () => {
    const byId = new Map(pool.posts.map((p) => [p.id, p.category]));
    expect(byId.get(f.churchPostId)).toBe('church');
    expect(byId.get(f.groupPostId)).toBe('group_only');
    expect(byId.get(f.tagPostId)).toBe('tag_only');
    expect(byId.get(f.groupAndTagPostId)).toBe('group_and_tag');
    expect(byId.get(f.authorOnlyPostId)).toBe('author_only');
  });
});

describe('drawPairs', () => {
  it('draws the requested number of pairs', () => {
    expect(drawPairs(pool, 50, makeRng(1))).toHaveLength(50);
  });

  it('produces identical pairs for identical seeds', () => {
    expect(drawPairs(pool, 30, makeRng(7))).toEqual(drawPairs(pool, 30, makeRng(7)));
  });

  it('produces different pairs for different seeds', () => {
    expect(drawPairs(pool, 30, makeRng(7))).not.toEqual(drawPairs(pool, 30, makeRng(8)));
  });

  it('only ever draws ids that are in the pool', () => {
    const viewerIds = new Set(pool.viewers.map((v) => v.id));
    const postIds = new Set(pool.posts.map((p) => p.id));
    for (const pair of drawPairs(pool, 100, makeRng(3))) {
      expect(viewerIds.has(pair.viewerId)).toBe(true);
      expect(postIds.has(pair.postId)).toBe(true);
    }
  });

  it('carries the label of the exact viewer and prayer it drew', () => {
    const cohortById = new Map(pool.viewers.map((v) => [v.id, v.cohort]));
    const categoryById = new Map(pool.posts.map((p) => [p.id, p.category]));
    for (const pair of drawPairs(pool, 100, makeRng(4))) {
      expect(pair.cohort).toBe(cohortById.get(pair.viewerId));
      expect(pair.audienceCategory).toBe(categoryById.get(pair.postId));
    }
  });

  it('refuses to draw from an empty pool instead of returning junk', () => {
    expect(() => drawPairs({ viewers: [], posts: [] }, 5, makeRng(1))).toThrow(/empty/i);
  });
});
