/**
 * Fixture data and deterministic helpers for the benchmark dataset.
 * Pure — no database access, no clock, no Math.random. Same seed, same dataset,
 * every run, which is what makes two benchmark runs comparable.
 */

export type GroupTier = 'life_stage' | 'ministry' | 'home';

export interface GroupFixture {
  name: string;
  tier: GroupTier;
}

export type AudienceKind =
  | 'church'
  | 'one_group'
  | 'multi_group'
  | 'one_tag'
  | 'multi_tag'
  | 'group_and_tag'
  | 'author_only';

/** mulberry32 — small, fast, and reproducible across platforms. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rng() * xs.length)];
  if (x === undefined) throw new Error('pick called on an empty array');
  return x;
}

/** Returns up to `n` distinct items. Never loops forever when n > xs.length. */
export function pickDistinct<T>(rng: () => number, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  const target = Math.min(n, pool.length);
  while (out.length < target) {
    const i = Math.floor(rng() * pool.length);
    const [taken] = pool.splice(i, 1);
    if (taken !== undefined) out.push(taken);
  }
  return out;
}

/**
 * Up to `n` distinct items, drawn with probability proportional to `weights[i]`.
 *
 * Roulette-wheel selection without replacement: each draw picks from the
 * remaining pool in proportion to the weights still in it. Uniform
 * `pickDistinct` gives every group the same expected size; weighting is what
 * makes a life-stage group ~150 members and a home group ~26, which is the
 * per-group selectivity variance an index experiment cares about.
 */
export function pickDistinctWeighted<T>(
  rng: () => number,
  xs: readonly T[],
  weights: readonly number[],
  n: number,
): T[] {
  const pool = xs.map((value, i) => ({ value, weight: weights[i] ?? 0 }));
  const out: T[] = [];
  const target = Math.min(n, pool.length);

  while (out.length < target) {
    const total = pool.reduce((a, p) => a + p.weight, 0);
    if (!(total > 0)) {
      throw new Error('pickDistinctWeighted needs at least one positive weight in the pool');
    }
    let r = rng() * total;
    // Defaults to the last entry so floating-point drift at the very top of
    // the wheel lands on a real item rather than falling through.
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (p === undefined) continue;
      r -= p.weight;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    const [taken] = pool.splice(idx, 1);
    if (taken !== undefined) out.push(taken.value);
  }

  return out;
}

/** Turns [{count: 2, value: 'a'}] into ['a', 'a']. */
export function expand<T>(buckets: readonly { count: number; value: T }[]): T[] {
  const out: T[] = [];
  for (const b of buckets) {
    for (let i = 0; i < b.count; i++) out.push(b.value);
  }
  return out;
}

const HOME_GROUPS: GroupFixture[] = Array.from({ length: 40 }, (_, i) => ({
  name: `Home Group ${String(i + 1).padStart(2, '0')}`,
  tier: 'home' as const,
}));

export const GROUP_FIXTURES: readonly GroupFixture[] = [
  { name: 'Youth Group', tier: 'life_stage' },
  { name: 'Young Adults', tier: 'life_stage' },
  { name: "Men's Fellowship", tier: 'life_stage' },
  { name: "Women's Fellowship", tier: 'life_stage' },
  { name: 'Seniors Fellowship', tier: 'life_stage' },
  { name: 'Married Couples', tier: 'life_stage' },
  { name: 'Sunday Worship Team', tier: 'ministry' },
  { name: 'Saturday Worship Team', tier: 'ministry' },
  { name: 'Youth Leadership', tier: 'ministry' },
  { name: 'Toddler & Nursery', tier: 'ministry' },
  { name: "Children's Ministry", tier: 'ministry' },
  { name: 'Media & Tech', tier: 'ministry' },
  { name: 'Ushers & Hospitality', tier: 'ministry' },
  { name: 'Prayer Team', tier: 'ministry' },
  { name: 'Outreach & Missions', tier: 'ministry' },
  { name: 'Care Team', tier: 'ministry' },
  { name: 'Finance & Admin', tier: 'ministry' },
  { name: 'Facilities', tier: 'ministry' },
  ...HOME_GROUPS,
];

/**
 * Target average size, in members, for a group of each tier — used as the
 * sampling weight in `loadGroups`, not as a hard cap.
 *
 * A life-stage group is the congregation sliced by age or stage, so nearly
 * everyone is in one; ministry teams and home groups are small by nature. The
 * numbers come from the design spec's group table (6 * 150 + 12 * 29 + 40 * 26
 * ≈ 2,300, the membership total GROUP_COUNT_BUCKETS fixes exactly).
 *
 * What is exact is the 2,300 total and the 100-member isolated cohort — those
 * come from GROUP_COUNT_BUCKETS and are unaffected by how the draw is
 * weighted. The per-tier sizes are the *expectation* of a weighted draw
 * without replacement, so realised sizes land near, not on, these numbers.
 */
export const TIER_TARGET_SIZE: Readonly<Record<GroupTier, number>> = {
  life_stage: 150,
  ministry: 29,
  home: 26,
};

export const TAG_NAMES: readonly string[] = [
  'family',
  'close friends',
  'prayer partners',
  'work',
  'college',
  'neighbours',
];

/**
 * How many groups each member belongs to. The 100 zero-group members are
 * deliberate: they are the least-connected cohort, so if group/tag membership
 * has any effect on how far the feed query must walk to fill a page, they are
 * where it shows up. Without them the benchmark only ever reports the
 * well-connected case.
 *
 * The bucket totals are asserted by bench-fixtures.test.ts; the arithmetic is
 * spelled out under the array.
 */
export const GROUP_COUNT_BUCKETS: readonly { groups: number; members: number }[] = [
  { groups: 0, members: 100 },
  { groups: 1, members: 300 },
  { groups: 2, members: 175 },
  { groups: 3, members: 175 },
  { groups: 4, members: 130 },
  { groups: 5, members: 115 },
  { groups: 6, members: 5 },
];
// members:     100 + 300 + 175 + 175 + 130 + 115 +  5 = 1,000
// memberships:   0 + 300 + 350 + 525 + 520 + 575 + 30 = 2,300

/** How many of the 10,000 prayers each audience kind gets. */
export type AudienceMix = readonly { kind: AudienceKind; count: number }[];

/**
 * The realistic mix: 10,000 prayers shaped like a real church feed, where most
 * requests go to the whole congregation. Church-wide is a superset, so it never
 * combines with a group or tag.
 */
export const AUDIENCE_MIX: AudienceMix = [
  { kind: 'church', count: 4000 },
  { kind: 'one_group', count: 2200 },
  { kind: 'multi_group', count: 900 },
  { kind: 'one_tag', count: 1500 },
  { kind: 'multi_tag', count: 400 },
  { kind: 'group_and_tag', count: 800 },
  { kind: 'author_only', count: 200 },
];

/**
 * Stress variant: ~10% church-wide instead of 40%. A member's feed can no longer be
 * filled from the church-wide firehose, so filling one 20-post page forces a real walk
 * through group/tag audiences — which is the cost the benchmark exists to measure.
 * Still 10,000 prayers.
 *
 * The counts are chosen to stay feasible at N=1000 under GROUP_COUNT_BUCKETS: the
 * group-requiring kinds (2800 + 1600 + 1000 = 5,400 slots) sit well under the 9,000
 * slots held by the 900 members in at least one group, and multi_group's 1,600 sits
 * under the 6,000 slots held by the 600 members in 2+ groups. Feasibility is asserted
 * per seed by the assignKinds sweep in bench-loader.test.ts — loadPrayers throws
 * rather than let 'church' absorb an unfillable kind.
 */
export const STRESS_AUDIENCE_MIX: AudienceMix = [
  { kind: 'church', count: 1000 },
  { kind: 'one_group', count: 2800 },
  { kind: 'multi_group', count: 1600 },
  { kind: 'one_tag', count: 2400 },
  { kind: 'multi_tag', count: 1000 },
  { kind: 'group_and_tag', count: 1000 },
  { kind: 'author_only', count: 200 },
];
