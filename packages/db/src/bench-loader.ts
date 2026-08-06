import {
  AUDIENCE_MIX,
  type AudienceKind,
  type AudienceMix,
  GROUP_COUNT_BUCKETS,
  GROUP_FIXTURES,
  TAG_NAMES,
  TIER_TARGET_SIZE,
  expand,
  makeRng,
  pick,
  pickDistinct,
  pickDistinctWeighted,
} from './bench-fixtures.js';
import type { BenchDb } from './bench-schema.js';
import { newId } from './ids.js';

/**
 * Writes fixture rows directly via Kysely. Service-layer functions write to the
 * `events` outbox in the same transaction, which would fire notification builders,
 * count recomputers, and feed-snapshot updates for fixture data. Same rule as
 * bootstrap.ts — do not "fix" this by routing through services.
 */

/**
 * Finds or creates the benchmark church.
 *
 * Find-or-create, not create: migration 0021_add_org_id seeds a default org into
 * every fresh database, and `bench-load-cli.ts` names that org `bench` so the
 * bench database holds exactly one. A second org makes `resolveLocalhost`
 * (apps/api/src/services/orgs.ts) refuse to resolve any org at all, which would
 * make the bench API unusable against a localhost database.
 */
export async function loadOrg(db: BenchDb, slug: string): Promise<string> {
  const existing = await db
    .selectFrom('orgs')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (existing) return existing.id;

  const id = newId();
  await db
    .insertInto('orgs')
    .values({ id, slug, display_name: `Bench Church (${slug})` })
    .execute();
  return id;
}

/**
 * Inserts `count` members and joins them to the org. Emails are namespaced by
 * org id so loading twice into one database never trips the UNIQUE constraint.
 * Auth ids are synthetic — the benchmark never authenticates against Supabase.
 */
export async function loadMembers(db: BenchDb, orgId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  const users = [];
  const memberships = [];

  for (let i = 0; i < count; i++) {
    const id = newId();
    ids.push(id);
    users.push({
      id,
      supabase_auth_id: newId(),
      // orgId (not a slice of it) namespaces the email: UUIDv7's leading hex
      // chars encode a millisecond timestamp, so two orgs minted moments
      // apart (as in a single benchmark run) share the same `slice(0, 8)`
      // prefix — that collided across orgs in this exact scenario. The full
      // id is unique by construction and sidesteps the issue entirely.
      email: `m${String(i).padStart(5, '0')}.${orgId.replace(/-/g, '')}@bench.invalid`,
      display_name: `Member ${i + 1}`,
    });
    memberships.push({ user_id: id, org_id: orgId, role: 'member' as const });
  }

  // Chunked to stay well under Postgres's 65,535 bind-parameter ceiling.
  for (let i = 0; i < users.length; i += 500) {
    await db
      .insertInto('users')
      .values(users.slice(i, i + 500))
      .execute();
    await db
      .insertInto('user_orgs')
      .values(memberships.slice(i, i + 500))
      .execute();
  }

  return ids;
}

/**
 * Creates the 58 groups and assigns members according to GROUP_COUNT_BUCKETS.
 * Returns member id -> group ids so callers can pick group audiences the author
 * actually belongs to.
 *
 * Members are assigned a target group count first, then groups are drawn from
 * the pool weighted by TIER_TARGET_SIZE. A member with a target of 0 is left
 * alone — those are the isolated members the benchmark needs.
 *
 * Two things about the ordering are load-bearing:
 *
 * - The targets are **shuffled** before they are handed out. They come out of
 *   `expand` in bucket order (all 100 zero-group members first, the 6-group
 *   members last) and `memberIds` are UUIDv7 in creation order, so assigning
 *   by position made connectivity a pure function of `users.id` order:
 *   `SELECT id FROM users ORDER BY id LIMIT 100` returned exactly the isolated
 *   cohort. Any sampling in Plan 2's oracle or Plan 3's harness would then be
 *   sampling one connectivity cohort while believing it sampled the
 *   population. Shuffling reassigns which member gets which target; the bucket
 *   totals (2,300 memberships, 100 isolated) are untouched.
 * - The draw is **weighted by tier**, not uniform. Uniform draws gave every
 *   group ~40 members; the shape the design calls for is a handful of large
 *   life-stage groups and a long tail of small home groups, because a large
 *   "hot" audience is what makes per-group selectivity vary at all.
 */
export async function loadGroups(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  rng: () => number,
): Promise<Map<string, string[]>> {
  const capacity = GROUP_COUNT_BUCKETS.reduce((a, b) => a + b.members, 0);
  if (memberIds.length > capacity) {
    // GROUP_COUNT_BUCKETS is a fixed-size histogram, not a distribution that
    // scales. Before this check, members past the cap silently took the `?? 0`
    // fallback and landed in no group at all — a population of 2,000 came out
    // with 1,100 isolated members instead of 100 and no error anywhere.
    throw new Error(
      `GROUP_COUNT_BUCKETS covers ${capacity} members but ${memberIds.length} were requested.\n` +
        'Every member beyond the cap would silently land in zero groups, inflating the isolated\n' +
        'cohort and invalidating the whole distribution. Extend GROUP_COUNT_BUCKETS (and the\n' +
        'counts asserted in bench-fixtures.test.ts) to the population you want.',
    );
  }

  const groupRows = GROUP_FIXTURES.map((g) => ({ id: newId(), church_id: orgId, name: g.name }));
  await db.insertInto('groups').values(groupRows).execute();
  const groupIds = groupRows.map((g) => g.id);
  const groupWeights = GROUP_FIXTURES.map((g) => TIER_TARGET_SIZE[g.tier]);

  const targets = expand(
    GROUP_COUNT_BUCKETS.map((b) => ({ count: b.members, value: b.groups })),
  ).slice(0, memberIds.length);
  shuffle(rng, targets);

  const byMember = new Map<string, string[]>();
  const membershipRows: { group_id: string; user_id: string; role: 'leader' | 'member' }[] = [];

  memberIds.forEach((userId, i) => {
    const target = targets[i] ?? 0;
    const chosen = target === 0 ? [] : pickDistinctWeighted(rng, groupIds, groupWeights, target);
    byMember.set(userId, chosen);
    for (const groupId of chosen) {
      // Roughly one in ten memberships is a leader. Roles govern actions, never visibility.
      membershipRows.push({
        group_id: groupId,
        user_id: userId,
        role: rng() < 0.1 ? 'leader' : 'member',
      });
    }
  });

  for (let i = 0; i < membershipRows.length; i += 500) {
    await db
      .insertInto('group_members')
      .values(membershipRows.slice(i, i + 500))
      .execute();
  }

  return byMember;
}

/** How many members get church-scoped privilege. Small, like a real church. */
export const MODERATOR_COUNT = 20;
export const SUPER_USER_COUNT = 2;
/**
 * At least this many moderators are drawn from the zero-group cohort.
 *
 * Rule ② is `author = M OR M ∈ group_members OR user_orgs.role IN
 * ('moderator','super_user')`. A moderator who is in the targeted group is
 * visible under the second clause anyway, so they cannot tell whether the role
 * clause is implemented at all. Only an *isolated* moderator makes the clause
 * observable — and, symmetrically, makes it observable if a role clause is
 * wrongly added to rule ③'s sealed tag path, which would be a privacy breach.
 */
export const ISOLATED_MODERATOR_COUNT = 2;

export interface PrivilegedRoles {
  moderators: string[];
  superUsers: string[];
}

/**
 * Promotes a deterministic handful of members to `moderator` / `super_user`.
 *
 * Runs after loadGroups because the choice depends on connectivity: without at
 * least one moderator who belongs to none of the groups a post targets, Plan
 * 2's differential oracle cannot distinguish "the role clause works" from "the
 * role clause is missing" — every privileged reader would already be covered by
 * the membership clause. See ISOLATED_MODERATOR_COUNT.
 *
 * These are the church-scoped roles of the `user_role` enum
 * (`member | moderator | super_user`), NOT the group-scoped
 * `leader | helper | member` written into `group_members`.
 *
 * Counts are clamped to what the population can supply, so degenerate test
 * populations (N=20, everyone isolated) still load; at N=1000 the pools are
 * far larger than the counts and the clamp never bites.
 */
export async function loadPrivilegedRoles(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  groupsByMember: ReadonlyMap<string, readonly string[]>,
  rng: () => number,
): Promise<PrivilegedRoles> {
  const isolated = memberIds.filter((id) => (groupsByMember.get(id) ?? []).length === 0);
  const connected = memberIds.filter((id) => (groupsByMember.get(id) ?? []).length > 0);

  const isolatedMods = pickDistinct(
    rng,
    isolated,
    Math.min(ISOLATED_MODERATOR_COUNT, isolated.length),
  );
  const connectedMods = pickDistinct(
    rng,
    connected,
    Math.min(MODERATOR_COUNT - isolatedMods.length, connected.length),
  );
  const moderators = [...isolatedMods, ...connectedMods];

  const taken = new Set(moderators);
  const rest = memberIds.filter((id) => !taken.has(id));
  const superUsers = pickDistinct(rng, rest, Math.min(SUPER_USER_COUNT, rest.length));

  if (moderators.length > 0) {
    await db
      .updateTable('user_orgs')
      .set({ role: 'moderator' })
      .where('org_id', '=', orgId)
      .where('user_id', 'in', moderators)
      .execute();
  }
  if (superUsers.length > 0) {
    await db
      .updateTable('user_orgs')
      .set({ role: 'super_user' })
      .where('org_id', '=', orgId)
      .where('user_id', 'in', superUsers)
      .execute();
  }

  return { moderators, superUsers };
}

/**
 * Every member owns 1-3 tags, each holding 3-12 other members.
 *
 * The owner is deliberately NOT a member of their own tag — that mirrors the
 * real shape (Alice's "family" tag lists John and Taylor, not Alice) and makes
 * the author clause in the visibility rule load-bearing rather than decorative.
 */
export async function loadTags(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  rng: () => number,
): Promise<Map<string, string[]>> {
  const tagRows: { id: string; owner_id: string; church_id: string; name: string }[] = [];
  const byOwner = new Map<string, string[]>();

  for (const ownerId of memberIds) {
    const howMany = 1 + Math.floor(rng() * 3); // 1, 2, or 3
    const names = pickDistinct(rng, TAG_NAMES, howMany);
    const ids: string[] = [];
    for (const name of names) {
      const id = newId();
      ids.push(id);
      tagRows.push({ id, owner_id: ownerId, church_id: orgId, name });
    }
    byOwner.set(ownerId, ids);
  }

  for (let i = 0; i < tagRows.length; i += 500) {
    await db
      .insertInto('tags')
      .values(tagRows.slice(i, i + 500))
      .execute();
  }

  const memberRows: { tag_id: string; user_id: string }[] = [];
  for (const tag of tagRows) {
    const candidates = memberIds.filter((m) => m !== tag.owner_id);
    const size = 3 + Math.floor(rng() * 10); // 3..12
    for (const userId of pickDistinct(rng, candidates, size)) {
      memberRows.push({ tag_id: tag.id, user_id: userId });
    }
  }

  for (let i = 0; i < memberRows.length; i += 500) {
    await db
      .insertInto('tag_members')
      .values(memberRows.slice(i, i + 500))
      .execute();
  }

  return byOwner;
}

interface AudienceRow {
  post_id: string;
  church_id: string | null;
  group_id: string | null;
  tag_id: string | null;
}

/**
 * Whether `kind` can actually be produced for an author with these groups/tags.
 *
 * 'multi_group' and 'multi_tag' require *two* candidates, not one — with only
 * one available, `pickDistinct` would silently degenerate to a single-row
 * audience while the post body still claimed "multi". Requiring 2 here means
 * a kind is never assigned unless it can be honestly produced.
 */
function isCompatible(
  kind: AudienceKind,
  myGroups: readonly string[],
  myTags: readonly string[],
): boolean {
  switch (kind) {
    case 'church':
    case 'author_only':
      return true;
    case 'one_group':
      return myGroups.length >= 1;
    case 'multi_group':
      return myGroups.length >= 2;
    case 'one_tag':
      return myTags.length >= 1;
    case 'multi_tag':
      return myTags.length >= 2;
    case 'group_and_tag':
      return myGroups.length >= 1 && myTags.length >= 1;
  }
}

/** Fisher-Yates, in place, using the given rng. Deterministic per seed. */
function shuffle<T>(rng: () => number, xs: T[]): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = xs[i];
    const b = xs[j];
    if (a === undefined || b === undefined) continue;
    xs[i] = b;
    xs[j] = a;
  }
}

/**
 * Processing order for assigning kinds to authors: most-constrained first.
 *
 * This is a bin-packing problem — 7 kinds each need a fixed count, each
 * author has exactly 10 open slots, and each kind is only compatible with
 * some authors. A single left-to-right greedy pass over a shuffled pool can
 * still get stuck: a kind with a small eligible pool (e.g. 'multi_group',
 * needing 2+ groups) can find its candidates already claimed by earlier,
 * less picky slots, with no way to backtrack.
 *
 * Assigning the tightest kinds first — before anything less picky has had a
 * chance to consume their only eligible slots — avoids that. 'church' goes
 * last and, uniquely, is NOT capped at its quota: it absorbs every slot still
 * open once the rest are placed, so every author ends up with exactly 10
 * assigned kinds even if an earlier kind's eligible pool ran short. That
 * absorption is a distortion, not a feature, so assignKinds throws when it
 * happens unless the caller opts out.
 */
const ASSIGNMENT_ORDER: readonly AudienceKind[] = [
  'multi_group',
  'multi_tag',
  'group_and_tag',
  'one_group',
  'one_tag',
  'author_only',
  'church',
];

export interface LoadPrayersOptions {
  /** Audience distribution to hit. Defaults to AUDIENCE_MIX (the realistic shape). */
  mix?: AudienceMix;
  /**
   * What to do when a kind's eligible author pool is too small to meet its
   * quota. 'throw' (the default) refuses to write a distorted dataset;
   * 'absorb' lets 'church' take the unfilled slots, which is only appropriate
   * for the deliberately degenerate populations used in referential-coherence
   * tests.
   */
  onShortfall?: 'throw' | 'absorb';
}

export interface KindAssignment {
  /** Authors in shuffled order. Posts are created in this order. */
  authors: string[];
  /** Author id -> exactly 10 audience kinds, themselves shuffled. */
  kindsByAuthor: Map<string, AudienceKind[]>;
}

/**
 * Decides which audience kind each of an author's 10 prayers gets, hitting the
 * mix's per-kind counts exactly. Pure — no database, no clock — so the
 * feasibility of a mix can be swept across many seeds cheaply.
 *
 * Assignment happens in two decorrelated random steps — see ASSIGNMENT_ORDER's
 * doc for why a naive single pass isn't exact — and the author-visiting order
 * is shuffled too:
 *
 * - Without the kind shuffle: the mix's fixed bucket order, plus `newId()`
 *   being called in loadPrayers' author-major loop, would make audience kind
 *   perfectly correlated with posts.id order — the oldest posts all
 *   church-wide, the newest all group/tag-targeted.
 * - Without the author-order shuffle: authors would be visited in `memberIds`
 *   order, so each author's 10 posts occupy a contiguous, predictable block of
 *   posts.id values. Any property that correlates with a member's position in
 *   the population — and `loadGroups` shuffles its targets precisely so
 *   connectivity does not — would leak straight into posts.id order. Shuffling
 *   the visiting order makes the two independent by construction rather than
 *   by the good behaviour of an upstream step.
 *
 * Since the production feed orders by posts.id DESC, either correlation
 * alone would explain the "isolated members are slow" signal as an artifact
 * of insert order rather than of visibility — which is exactly what the
 * benchmark exists to measure honestly.
 */
export function assignKinds(
  memberIds: readonly string[],
  groupsByMember: ReadonlyMap<string, readonly string[]>,
  tagsByOwner: ReadonlyMap<string, readonly string[]>,
  rng: () => number,
  opts: LoadPrayersOptions = {},
): KindAssignment {
  const mix = opts.mix ?? AUDIENCE_MIX;
  const onShortfall = opts.onShortfall ?? 'throw';

  const total = memberIds.length * 10;
  const scale = total / mix.reduce((a, m) => a + m.count, 0);
  // Capped kinds get their scaled share. 'church' is the residual bucket, so
  // its quota is whatever the capped kinds leave rather than a rounded share —
  // that keeps the quotas summing to exactly `total` at any population size.
  const quota = new Map<AudienceKind, number>(
    mix
      .filter((m) => m.kind !== 'church')
      .map((m) => [m.kind, Math.max(1, Math.round(m.count * scale))]),
  );
  const churchQuota = total - [...quota.values()].reduce((a, b) => a + b, 0);

  const authors = [...memberIds];
  shuffle(rng, authors);

  const remainingSlots = new Map(authors.map((id) => [id, 10]));
  const kindsByAuthor = new Map<string, AudienceKind[]>(authors.map((id) => [id, []]));

  for (const kind of ASSIGNMENT_ORDER) {
    // One "ticket" per still-open slot on an author this kind is compatible
    // with. Shuffling before drawing means WHICH eligible author gets this
    // kind is random, not just the order kinds are considered in.
    const tickets: string[] = [];
    for (const authorId of authors) {
      const remaining = remainingSlots.get(authorId) ?? 0;
      if (remaining === 0) continue;
      const myGroups = groupsByMember.get(authorId) ?? [];
      const myTags = tagsByOwner.get(authorId) ?? [];
      if (!isCompatible(kind, myGroups, myTags)) continue;
      for (let i = 0; i < remaining; i++) tickets.push(authorId);
    }
    shuffle(rng, tickets);

    // 'church' is the residual bucket (see ASSIGNMENT_ORDER doc): it takes
    // every remaining ticket instead of stopping at its quota.
    const take =
      kind === 'church' ? tickets.length : Math.min(quota.get(kind) ?? 0, tickets.length);
    for (let i = 0; i < take; i++) {
      const authorId = tickets[i];
      if (authorId === undefined) continue;
      remainingSlots.set(authorId, (remainingSlots.get(authorId) ?? 0) - 1);
      kindsByAuthor.get(authorId)?.push(kind);
    }
  }

  if (onShortfall === 'throw') assertNoShortfall(total, quota, churchQuota, kindsByAuthor);

  // Every author's own 10 kinds were appended in ASSIGNMENT_ORDER (tightest
  // kinds first, 'church' last) — shuffle each author's list so that order
  // doesn't leak into posts.id order at the fine-grained, single-author-block
  // scale the way the unshuffled ASSIGNMENT_ORDER would.
  for (const kinds of kindsByAuthor.values()) shuffle(rng, kinds);

  return { authors, kindsByAuthor };
}

/**
 * Refuses a mix the population cannot actually deliver.
 *
 * A short kind is invisible without this check: 'church' is uncapped, so it
 * quietly swallows every slot the short kind could not claim and the dataset
 * comes out reweighted toward church-wide visibility — the exact distortion
 * the benchmark exists to avoid measuring.
 */
function assertNoShortfall(
  total: number,
  quota: ReadonlyMap<AudienceKind, number>,
  churchQuota: number,
  kindsByAuthor: ReadonlyMap<string, readonly AudienceKind[]>,
): void {
  const assigned = new Map<AudienceKind, number>();
  for (const kinds of kindsByAuthor.values()) {
    for (const kind of kinds) assigned.set(kind, (assigned.get(kind) ?? 0) + 1);
  }

  const short = [...quota].filter(([kind, want]) => (assigned.get(kind) ?? 0) !== want);
  if (short.length === 0) return;

  const churchAssigned = assigned.get('church') ?? 0;
  const lines = short.map(
    ([kind, want]) => `  ${kind}: requested ${want}, assigned ${assigned.get(kind) ?? 0}`,
  );
  throw new Error(
    `The benchmark audience mix is infeasible for this population ` +
      `(${kindsByAuthor.size} members, ${total} prayers).\n` +
      `${lines.join('\n')}\n` +
      `  church absorbed ${churchAssigned - churchQuota} unfilled slot(s) ` +
      `(requested ${churchQuota}, assigned ${churchAssigned}), which would silently\n` +
      `  reweight the dataset toward church-wide visibility.\n` +
      `  Fix the mix, grow the population, or pass { onShortfall: 'absorb' } if this\n` +
      `  population is degenerate on purpose.`,
  );
}

/**
 * Ten prayers per member, with audiences drawn from the given mix.
 *
 * Two constraints keep the data coherent, and both matter for the correctness
 * oracle later: a prayer may only target a tag its author OWNS, and may only
 * target a group its author BELONGS TO. Members in no groups therefore fall back
 * to church-wide — which is exactly why they end up with thin feeds.
 *
 * Which kind each prayer gets — and why the ordering is shuffled twice — is
 * assignKinds' job; see its doc.
 */
export async function loadPrayers(
  db: BenchDb,
  orgId: string,
  memberIds: readonly string[],
  groupsByMember: Map<string, string[]>,
  tagsByOwner: Map<string, string[]>,
  rng: () => number,
  opts: LoadPrayersOptions = {},
): Promise<number> {
  const { authors, kindsByAuthor } = assignKinds(memberIds, groupsByMember, tagsByOwner, rng, opts);

  const now = Date.now();
  const posts: {
    id: string;
    org_id: string;
    parent_id: null;
    author_id: string;
    body: string;
    status: 'published';
    edit_deadline: Date;
  }[] = [];
  const audiences: AudienceRow[] = [];

  for (const authorId of authors) {
    const myGroups = groupsByMember.get(authorId) ?? [];
    const myTags = tagsByOwner.get(authorId) ?? [];
    const kindsForAuthor = kindsByAuthor.get(authorId) ?? [];

    kindsForAuthor.forEach((kind, n) => {
      const postId = newId();

      posts.push({
        id: postId,
        org_id: orgId,
        parent_id: null,
        author_id: authorId,
        body: `Bench prayer ${n + 1} from ${authorId.slice(0, 8)} (${kind})`,
        status: 'published',
        edit_deadline: new Date(now + 24 * 60 * 60 * 1000),
      });

      const row = (over: Partial<AudienceRow>): AudienceRow => ({
        post_id: postId,
        church_id: null,
        group_id: null,
        tag_id: null,
        ...over,
      });

      switch (kind) {
        case 'church':
          audiences.push(row({ church_id: orgId }));
          break;
        case 'one_group':
          audiences.push(row({ group_id: pick(rng, myGroups) }));
          break;
        case 'multi_group':
          for (const g of pickDistinct(rng, myGroups, 2 + Math.floor(rng() * 2))) {
            audiences.push(row({ group_id: g }));
          }
          break;
        case 'one_tag':
          audiences.push(row({ tag_id: pick(rng, myTags) }));
          break;
        case 'multi_tag':
          for (const t of pickDistinct(rng, myTags, 2 + Math.floor(rng() * 2))) {
            audiences.push(row({ tag_id: t }));
          }
          break;
        case 'group_and_tag':
          audiences.push(row({ group_id: pick(rng, myGroups) }));
          audiences.push(row({ tag_id: pick(rng, myTags) }));
          break;
        case 'author_only':
          break;
      }
    });
  }

  for (let i = 0; i < posts.length; i += 500) {
    await db
      .insertInto('posts')
      .values(posts.slice(i, i + 500))
      .execute();
  }
  for (let i = 0; i < audiences.length; i += 500) {
    await db
      .insertInto('post_audiences')
      .values(audiences.slice(i, i + 500))
      .execute();
  }

  return posts.length;
}

export interface BenchSummary {
  orgId: string;
  members: number;
  moderators: number;
  superUsers: number;
  groups: number;
  tags: number;
  prayers: number;
  audiences: number;
}

export interface LoadOptions {
  slug: string;
  members: number;
  seed: number;
  /** Audience distribution. Defaults to AUDIENCE_MIX (the realistic shape). */
  mix?: AudienceMix;
}

/**
 * Runs the whole load in fixture order. One RNG threads through so the run is
 * reproducible.
 *
 * All five write sequences run inside **one transaction**. `loadPrayers` throws
 * by design when a mix is infeasible, which is exactly what happens the first
 * time someone tunes a new mix — and without the transaction that left behind
 * 1 org, 1,000 users, 58 groups and 0 posts. `assertLoadable` then waved the
 * next run through on its `posts = 0` check, `loadOrg` adopted the leftover
 * org, and the second run appended another 1,000 members to it: a 2,000-member
 * church whose printed summary said 1,000 and whose isolated cohort was 200.
 * Every per-member number would have been silently wrong.
 */
export async function loadBenchDataset(db: BenchDb, opts: LoadOptions): Promise<BenchSummary> {
  return db.transaction().execute(async (trx) => {
    const rng = makeRng(opts.seed);
    const orgId = await loadOrg(trx, opts.slug);
    const members = await loadMembers(trx, orgId, opts.members);
    const groups = await loadGroups(trx, orgId, members, rng);
    const roles = await loadPrivilegedRoles(trx, orgId, members, groups, rng);
    const tags = await loadTags(trx, orgId, members, rng);
    // Never 'absorb': a full dataset silently reweighted toward church-wide is
    // worse than no dataset, because the benchmark would still report numbers.
    const prayers = await loadPrayers(trx, orgId, members, groups, tags, rng, {
      ...(opts.mix !== undefined ? { mix: opts.mix } : {}),
      onShortfall: 'throw',
    });

    const tagCount = [...tags.values()].reduce((a, b) => a + b.length, 0);
    const audiences = await trx
      .selectFrom('post_audiences')
      .innerJoin('posts', 'posts.id', 'post_audiences.post_id')
      .select(({ fn }) => fn.count<string>('post_audiences.post_id').as('n'))
      .where('posts.org_id', '=', orgId)
      .executeTakeFirstOrThrow();

    return {
      orgId,
      members: members.length,
      moderators: roles.moderators.length,
      superUsers: roles.superUsers.length,
      groups: GROUP_FIXTURES.length,
      tags: tagCount,
      prayers,
      audiences: Number(audiences.n),
    };
  });
}
