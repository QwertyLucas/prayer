import { describe, expect, it } from 'vitest';

import {
  AUDIENCE_MIX,
  type AudienceMix,
  GROUP_COUNT_BUCKETS,
  GROUP_FIXTURES,
  STRESS_AUDIENCE_MIX,
  TAG_NAMES,
  makeRng,
  pickDistinct,
} from '../src/bench-fixtures.js';

const churchShare = (mix: AudienceMix): number => {
  const total = mix.reduce((a, b) => a + b.count, 0);
  return (mix.find((m) => m.kind === 'church')?.count ?? 0) / total;
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

  it('makes the stress variant genuinely harsher on church-wide reach', () => {
    // The whole point of the stress dataset: a member cannot fill page 1 from
    // the church-wide firehose, so the query has to walk group/tag audiences.
    // If a future edit quietly reweights it back toward church-wide, the
    // benchmark silently stops measuring the thing it exists to measure.
    expect(churchShare(AUDIENCE_MIX)).toBeCloseTo(0.4, 5);
    expect(churchShare(STRESS_AUDIENCE_MIX)).toBeLessThanOrEqual(0.12);
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
});
