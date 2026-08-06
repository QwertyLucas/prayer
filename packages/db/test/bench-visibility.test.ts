import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBenchDb, type BenchDb } from '../src/bench-schema.js';
import { canSee } from '../src/bench-visibility.js';
import { newId } from '../src/ids.js';

import { buildVisibilityFixture, type VisibilityFixture } from './helpers/visibility-fixtures.js';

const url = process.env.TEST_DATABASE_URL as string;
let db: BenchDb;
let f: VisibilityFixture;

beforeAll(async () => {
  db = createBenchDb(url);
  f = await buildVisibilityFixture(db, 'vis-canSee');
});

afterAll(async () => {
  await db.destroy();
});

describe('canSee — rule ① church-wide', () => {
  it('lets any member of that church see it', async () => {
    expect(await canSee(db, f.outsiderId, f.churchPostId)).toEqual({
      visible: true,
      rule: 'church',
    });
  });

  it('does not leak to a member of a different church', async () => {
    expect(await canSee(db, f.foreignerId, f.churchPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — rule ② group', () => {
  it('lets a member of the group see it', async () => {
    expect(await canSee(db, f.groupMemberId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group',
    });
  });

  it('hides it from a church member who is not in the group', async () => {
    expect(await canSee(db, f.outsiderId, f.groupPostId)).toEqual({ visible: false, rule: null });
  });

  it('lets a moderator who is NOT in the group see it', async () => {
    expect(await canSee(db, f.moderatorId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('lets a super_user who is NOT in the group see it', async () => {
    expect(await canSee(db, f.superUserId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('reports membership, not privilege, when the viewer is both', async () => {
    // The more specific truth wins: this person would see it even without the role.
    expect(await canSee(db, f.moderatorInGroupId, f.groupPostId)).toEqual({
      visible: true,
      rule: 'group',
    });
  });

  it('does not leak to a member of a different, unrelated group', async () => {
    // Pins the `gm.group_id = a.group_id` join predicate: membership in *a*
    // group must not satisfy an audience row naming a *different* group.
    expect(await canSee(db, f.decoyGroupMemberId, f.groupPostId)).toEqual({
      visible: false,
      rule: null,
    });
    // Nor does membership in an unrelated group say anything about a tag row.
    expect(await canSee(db, f.decoyGroupMemberId, f.tagPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });

  it('does not grant privilege to a super_user of a different church', async () => {
    // Pins the `uo.org_id = p.org_id` guard on the privilege arm: a super_user
    // role in another org must grant nothing here.
    expect(await canSee(db, f.foreignerId, f.groupPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — rule ③ tag, sealed', () => {
  it('lets a member of the tag see it', async () => {
    expect(await canSee(db, f.tagMemberId, f.tagPostId)).toEqual({ visible: true, rule: 'tag' });
  });

  it('hides it from a church member who is not in the tag', async () => {
    expect(await canSee(db, f.outsiderId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });

  it('SEALS it from a moderator who is not in the tag', async () => {
    expect(await canSee(db, f.moderatorId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });

  it('SEALS it from a super_user who is not in the tag', async () => {
    // The headline privacy property: a super_user gets the same answer as anyone else.
    expect(await canSee(db, f.superUserId, f.tagPostId)).toEqual({ visible: false, rule: null });
  });

  it('does not leak to a member of a different, unrelated tag', async () => {
    // Pins the `tm.tag_id = a.tag_id` join predicate: membership in *a* tag
    // must not satisfy an audience row naming a *different* tag.
    expect(await canSee(db, f.decoyTagMemberId, f.tagPostId)).toEqual({
      visible: false,
      rule: null,
    });
    // Nor does membership in an unrelated tag say anything about a group row.
    expect(await canSee(db, f.decoyTagMemberId, f.groupPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — the author clause', () => {
  it('lets the author see their own tag prayer even though they are not in the tag', async () => {
    expect(await canSee(db, f.authorId, f.tagPostId)).toEqual({ visible: true, rule: 'author' });
  });

  it('lets the author see a prayer with no audience at all', async () => {
    expect(await canSee(db, f.authorId, f.authorOnlyPostId)).toEqual({
      visible: true,
      rule: 'author',
    });
  });

  it('hides an audience-less prayer from everyone else', async () => {
    expect(await canSee(db, f.outsiderId, f.authorOnlyPostId)).toEqual({
      visible: false,
      rule: null,
    });
    expect(await canSee(db, f.superUserId, f.authorOnlyPostId)).toEqual({
      visible: false,
      rule: null,
    });
  });
});

describe('canSee — multiple audience rows', () => {
  it('lets a moderator in via the group row even though a tag row is present', async () => {
    // The tag seal does not extend to the whole post; rows are evaluated independently.
    expect(await canSee(db, f.moderatorId, f.groupAndTagPostId)).toEqual({
      visible: true,
      rule: 'group_moderator',
    });
  });

  it('lets a tag member in via the tag row', async () => {
    expect(await canSee(db, f.tagMemberId, f.groupAndTagPostId)).toEqual({
      visible: true,
      rule: 'tag',
    });
  });
});

describe('canSee — bad input', () => {
  it('throws on a prayer that does not exist, rather than reporting "not visible"', async () => {
    // A sampler bug must surface as an error, not as a plausible-looking false.
    await expect(canSee(db, f.outsiderId, newId())).rejects.toThrow(/no prayer/i);
  });
});
