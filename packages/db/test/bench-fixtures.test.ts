import { describe, expect, it } from 'vitest';

import {
  AUDIENCE_MIX,
  type AudienceMix,
  GROUP_COUNT_BUCKETS,
  GROUP_FIXTURES,
  STRESS_AUDIENCE_MIX,
  TAG_NAMES,
  TIER_TARGET_SIZE,
  makeRng,
  pickDistinct,
  pickDistinctWeighted,
} from '../src/bench-fixtures.js';

/**
 * Rows the feed has to walk, on average, to find 20 it may show a member who
 * can see nothing but church-wide posts.
 *
 * Posts are visited newest-first and a `church` post is visible to everyone, so
 * one in every `total / churchCount` rows is a hit for even the least-connected
 * member. That bounds scan depth in expectation for *every* member — a member
 * with groups and tags sees strictly more, never less — which is the quantity
 * the mix actually controls, and why this test asserts on it rather than on the
 * church share it is derived from.
 */
const churchBoundedScanDepth = (mix: AudienceMix): number => {
  const total = mix.reduce((a, b) => a + b.count, 0);
  const church = mix.find((m) => m.kind === 'church')?.count ?? 0;
  return (20 * total) / church;
};

describe('bench fixtures', () => {
  it('defines 58 groups across three tiers', () => {
    expect(GROUP_FIXTURES).toHaveLength(58);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'life_stage')).toHaveLength(6);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'ministry')).toHaveLength(12);
    expect(GROUP_FIXTURES.filter((g) => g.tier === 'home')).toHaveLength(40);
  });

  it('has unique group names', () => {
    expect(new Set(GROUP_FIXTURES.map((g) => g.name)).size).toBe(58);
  });

  it('covers exactly 1,000 members and 2,300 memberships', () => {
    const members = GROUP_COUNT_BUCKETS.reduce((a, b) => a + b.members, 0);
    const memberships = GROUP_COUNT_BUCKETS.reduce((a, b) => a + b.groups * b.members, 0);
    expect(members).toBe(1000);
    expect(memberships).toBe(2300);
  });

  it('seeds 100 members into zero groups — the slow-feed case', () => {
    const isolated = GROUP_COUNT_BUCKETS.find((b) => b.groups === 0);
    expect(isolated?.members).toBe(100);
  });

  it('splits 10,000 prayers across seven audience kinds', () => {
    expect(AUDIENCE_MIX.reduce((a, b) => a + b.count, 0)).toBe(10000);
    expect(AUDIENCE_MIX).toHaveLength(7);
  });

  it('splits the stress variant across the same seven kinds and the same 10,000 prayers', () => {
    expect(STRESS_AUDIENCE_MIX.reduce((a, b) => a + b.count, 0)).toBe(10000);
    expect(STRESS_AUDIENCE_MIX.map((m) => m.kind).sort()).toEqual(
      AUDIENCE_MIX.map((m) => m.kind).sort(),
    );
  });

  it('states how deep each mix makes the scan for a least-connected member', () => {
    // The previous version of this test asserted the church *share* (0.4 and
    // <=0.12) — derived from the same two constants it was guarding, so it
    // could catch an edit to the numbers but never tell you whether the
    // numbers were right for the purpose. This asserts the consequence
    // instead: how far back a feed query must walk to fill one 20-post page
    // for a member whose only visible posts are the church-wide ones.
    //
    //   realistic  20 * 10,000 / 4,000 =  50 rows
    //   stress     20 * 10,000 / 1,000 = 200 rows
    //
    // Measured against the loaded datasets (rows walked, newest-first, to
    // collect 20 visible posts; 50 members sampled per connectivity cohort):
    //
    //   cohort                prayer_bench p50/p99   stress p50/p99
    //   0 groups (isolated)          46 /  46           215 / 215
    //   1 group                      46 /  46           159 / 215
    //   2-3 groups                   39 /  46           137 / 215
    //   4+ groups                    39 /  46           108 / 202
    //
    // Close to the expected values, as they should be — these are averages
    // over a random layout, not hard bounds, so a run can land either side.
    //
    // Both are cheap in absolute terms. That is a real property of a church
    // where 10-40% of prayers go to everyone, not a defect in the dataset: at
    // any realistic church-wide share, feed visibility is bounded for every
    // member regardless of connectivity. Plans 2-3 report that; they do not
    // fix it. If a future edit changes these numbers, it is changing what the
    // benchmark can observe, and that should be a deliberate decision made
    // here rather than a side effect noticed downstream.
    expect(churchBoundedScanDepth(AUDIENCE_MIX)).toBe(50);
    expect(churchBoundedScanDepth(STRESS_AUDIENCE_MIX)).toBe(200);
    expect(churchBoundedScanDepth(STRESS_AUDIENCE_MIX)).toBeGreaterThanOrEqual(
      3 * churchBoundedScanDepth(AUDIENCE_MIX),
    );
  });

  it('weights the group tiers so the tier sizes sum to the membership total', () => {
    // TIER_TARGET_SIZE is what loadGroups draws with. If the weights stop
    // adding up to the 2,300 memberships GROUP_COUNT_BUCKETS hands out, the
    // realised sizes drift away from the tiers the design asks for while every
    // count-based test still passes.
    const implied = GROUP_FIXTURES.reduce((a, g) => a + TIER_TARGET_SIZE[g.tier], 0);
    expect(implied).toBeGreaterThanOrEqual(2250);
    expect(implied).toBeLessThanOrEqual(2350);
    expect(TIER_TARGET_SIZE.life_stage).toBeGreaterThan(TIER_TARGET_SIZE.ministry);
    expect(TIER_TARGET_SIZE.life_stage).toBeGreaterThan(TIER_TARGET_SIZE.home);
  });

  it('offers six tag names', () => {
    expect(TAG_NAMES).toHaveLength(6);
  });

  it('produces identical sequences for identical seeds', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different sequences for different seeds', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it('picks n distinct items', () => {
    const rng = makeRng(7);
    const got = pickDistinct(rng, [1, 2, 3, 4, 5], 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  it('caps pickDistinct at the pool size instead of looping forever', () => {
    expect(pickDistinct(makeRng(7), [1, 2], 10)).toHaveLength(2);
  });

  it('draws in proportion to the weights', () => {
    // Uniformly, 'heavy' would come out ~1 time in 3. At 10x the weight it
    // should dominate — this is the mechanism that makes a life-stage group
    // land near 150 members and a home group near 26.
    const rng = makeRng(3);
    let heavy = 0;
    for (let i = 0; i < 600; i++) {
      if (pickDistinctWeighted(rng, ['heavy', 'a', 'b'], [10, 1, 1], 1)[0] === 'heavy') heavy++;
    }
    expect(heavy / 600).toBeGreaterThan(0.7);
    expect(heavy / 600).toBeLessThan(0.9);
  });

  it('returns distinct items and caps at the pool size, like pickDistinct', () => {
    const got = pickDistinctWeighted(makeRng(4), [1, 2, 3], [5, 1, 1], 10);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  it('refuses a weight vector with nothing to draw', () => {
    // Silently falling back to uniform here would flatten the tiers back out
    // and undo the whole point of the weighting.
    expect(() => pickDistinctWeighted(makeRng(5), [1, 2], [0, 0], 1)).toThrow(/positive weight/);
  });
});
