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
 * deliberate: a well-connected member's feed is fast because Postgres finds 20
 * visible posts and stops, while an isolated member forces a walk back through
 * thousands of invisible posts to fill one page. Without them the benchmark
 * only ever reports the easy case.
 *
 * 0*100 + 1*300 + 2.5*350 + 4.5*250 = 2,300 memberships across 1,000 members.
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

/** 10,000 prayers. Church-wide is a superset, so it never combines with a group or tag. */
export const AUDIENCE_MIX: readonly { kind: AudienceKind; count: number }[] = [
  { kind: 'church', count: 4000 },
  { kind: 'one_group', count: 2200 },
  { kind: 'multi_group', count: 900 },
  { kind: 'one_tag', count: 1500 },
  { kind: 'multi_tag', count: 400 },
  { kind: 'group_and_tag', count: 800 },
  { kind: 'author_only', count: 200 },
];
