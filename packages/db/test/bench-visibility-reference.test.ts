import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import {
  expectedVisibility,
  loadPostFacts,
  loadViewerFacts,
  type PostFacts,
  type ViewerFacts,
} from '../src/bench-visibility-reference.js';
import { canSee } from '../src/bench-visibility.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-reference');
});

afterAll(async () => {
  await db.destroy();
});

const viewer = (over: Partial<ViewerFacts> = {}): ViewerFacts => ({
  userId: 'v',
  orgIds: new Set(['org']),
  groupIds: new Set(),
  tagIds: new Set(),
  privilegedOrgIds: new Set(),
  ...over,
});

const post = (over: Partial<PostFacts> = {}): PostFacts => ({
  postId: 'p',
  authorId: 'author',
  orgId: 'org',
  churchIds: [],
  groupIds: [],
  tagIds: [],
  ...over,
});

describe('expectedVisibility — pure, no database', () => {
  it('grants the author regardless of audience', () => {
    expect(expectedVisibility(viewer({ userId: 'author' }), post({ tagIds: ['t'] }))).toEqual({
      visible: true,
      rule: 'author',
    });
  });

  it('grants a church member on a church-wide prayer', () => {
    expect(expectedVisibility(viewer(), post({ churchIds: ['org'] }))).toEqual({
      visible: true,
      rule: 'church',
    });
  });

  it('denies a member of a different church', () => {
    expect(
      expectedVisibility(viewer({ orgIds: new Set(['elsewhere']) }), post({ churchIds: ['org'] })),
    ).toEqual({
      visible: false,
      rule: null,
    });
  });

  it('grants a group member', () => {
    expect(
      expectedVisibility(viewer({ groupIds: new Set(['g']) }), post({ groupIds: ['g'] })),
    ).toEqual({
      visible: true,
      rule: 'group',
    });
  });

  it('grants a moderator on a group prayer they are not in', () => {
    expect(
      expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post({ groupIds: ['g'] })),
    ).toEqual({ visible: true, rule: 'group_moderator' });
  });

  it('prefers membership over privilege when the viewer is both', () => {
    expect(
      expectedVisibility(
        viewer({ groupIds: new Set(['g']), privilegedOrgIds: new Set(['org']) }),
        post({ groupIds: ['g'] }),
      ),
    ).toEqual({ visible: true, rule: 'group' });
  });

  it('grants a tag member', () => {
    expect(expectedVisibility(viewer({ tagIds: new Set(['t']) }), post({ tagIds: ['t'] }))).toEqual(
      {
        visible: true,
        rule: 'tag',
      },
    );
  });

  it('SEALS a tag prayer from a privileged viewer who is not in the tag', () => {
    expect(
      expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post({ tagIds: ['t'] })),
    ).toEqual({ visible: false, rule: null });
  });

  it('denies everyone but the author on an audience-less prayer', () => {
    expect(expectedVisibility(viewer({ privilegedOrgIds: new Set(['org']) }), post())).toEqual({
      visible: false,
      rule: null,
    });
  });

  it('lets a moderator in via a group row on a group+tag prayer', () => {
    expect(
      expectedVisibility(
        viewer({ privilegedOrgIds: new Set(['org']) }),
        post({ groupIds: ['g'], tagIds: ['t'] }),
      ),
    ).toEqual({ visible: true, rule: 'group_moderator' });
  });
});

describe('fact loaders', () => {
  it('reads a viewer’s memberships and privilege', async () => {
    const mod = await loadViewerFacts(db, f.moderatorInGroupId);
    expect(mod.orgIds.has(f.orgId)).toBe(true);
    expect(mod.groupIds.has(f.groupId)).toBe(true);
    expect(mod.privilegedOrgIds.has(f.orgId)).toBe(true);

    const plain = await loadViewerFacts(db, f.outsiderId);
    expect(plain.privilegedOrgIds.size).toBe(0);
    expect(plain.groupIds.size).toBe(0);
  });

  it('reads a viewer’s tag memberships but not tags they merely own', async () => {
    // The author OWNS the fixture tag and is not a member of it.
    const author = await loadViewerFacts(db, f.authorId);
    expect(author.tagIds.has(f.tagId)).toBe(false);

    const member = await loadViewerFacts(db, f.tagMemberId);
    expect(member.tagIds.has(f.tagId)).toBe(true);
  });

  it('reads a prayer’s audiences, split by kind', async () => {
    const both = await loadPostFacts(db, f.groupAndTagPostId);
    expect(both.authorId).toBe(f.authorId);
    expect(both.orgId).toBe(f.orgId);
    expect(both.groupIds).toEqual([f.groupId]);
    expect(both.tagIds).toEqual([f.tagId]);
    expect(both.churchIds).toEqual([]);

    const none = await loadPostFacts(db, f.authorOnlyPostId);
    expect(none.churchIds).toEqual([]);
    expect(none.groupIds).toEqual([]);
    expect(none.tagIds).toEqual([]);
  });
});

describe('differential — the SQL check and the reference must agree', () => {
  it('agrees on every viewer × prayer pair in the fixture', async () => {
    const viewers = [
      f.authorId,
      f.groupMemberId,
      f.tagMemberId,
      f.outsiderId,
      f.moderatorId,
      f.superUserId,
      f.moderatorInGroupId,
      f.foreignerId,
      f.decoyGroupMemberId,
      f.decoyTagMemberId,
    ];
    const posts = [
      f.churchPostId,
      f.groupPostId,
      f.tagPostId,
      f.groupAndTagPostId,
      f.authorOnlyPostId,
    ];

    const disagreements: string[] = [];
    for (const viewerId of viewers) {
      const facts = await loadViewerFacts(db, viewerId);
      for (const postId of posts) {
        const actual = await canSee(db, viewerId, postId);
        const expectedResult = expectedVisibility(facts, await loadPostFacts(db, postId));
        if (actual.visible !== expectedResult.visible || actual.rule !== expectedResult.rule) {
          disagreements.push(
            `${viewerId} × ${postId}: sql=${JSON.stringify(actual)} ref=${JSON.stringify(expectedResult)}`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
  });
});
