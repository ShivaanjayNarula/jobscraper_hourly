import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoardState, BoardStatus, Company, SeenState } from './types.js';
import { boardKey } from './board-url.js';
import type { OutageState } from './outage.js';
import type { HostHistory } from './host-stats.js';
import { SEEN_RETENTION_DAYS, REPOST_WINDOW_DAYS } from './config.js';
import type { RepostState } from './types.js';
import type { VolumeDropState, VolumeHistory } from './volume-stats.js';

const SEEN_PATH = 'state/seen.json';
const COMPANIES_PATH = 'companies.json';
const OUTAGE_PATH = 'state/outage.json';
const HOST_STATS_PATH = 'state/host-stats.json';

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export const loadSeen = () => readJson<SeenState>(SEEN_PATH, {});
export const loadCompanies = () => readJson<Company[]>(COMPANIES_PATH, []);

/**
 * `lastPolledAt` and `failingSince` are stripped on the way out: they now live
 * in `state/board-state.json`. Leaving them here would keep rewriting up to
 * `BOARDS_PER_RUN` rows of a committed file every run, which is the whole thing
 * this split exists to stop. The first save after the split is a large one-off
 * diff removing both fields from every row; after that the file goes quiet.
 */
export const saveCompanies = (companies: Company[]) =>
  writeJson(
    COMPANIES_PATH,
    companies.map(({ lastPolledAt: _polled, failingSince: _failing, ...rest }) => rest),
  );

const BOARD_STATE_PATH = 'state/board-state.json';
export const loadBoardState = () => readJson<BoardState>(BOARD_STATE_PATH, {});
export const saveBoardState = (state: BoardState) => writeJson(BOARD_STATE_PATH, state);

/**
 * Fill in any board the state file has never heard of from the legacy fields
 * still on its `Company` row. One mechanism covers two cases: the first run
 * after the split, and an evicted Actions cache. In both, whatever was last
 * committed to `companies.json` is a better starting point than declaring the
 * entire corpus never-polled — though that fallback is safe too.
 */
export function seedBoardState(state: BoardState, companies: readonly Company[]): BoardState {
  const seeded: BoardState = { ...state };
  for (const company of companies) {
    const key = boardKey(company);
    if (seeded[key] || !(company.lastPolledAt || company.failingSince)) continue;
    seeded[key] = { lastPolledAt: company.lastPolledAt, failingSince: company.failingSince };
  }
  return seeded;
}

/** Tiny — one boolean per ATS — so it rides in the same cache as seen.json. */
export const loadOutageState = () => readJson<OutageState>(OUTAGE_PATH, {});
export const saveOutageState = (state: OutageState) => writeJson(OUTAGE_PATH, state);

/** A capped window of booleans per host — small even with hundreds of hosts. */
export const loadHostHistory = () => readJson<HostHistory>(HOST_STATS_PATH, {});
export const saveHostHistory = (history: HostHistory) => writeJson(HOST_STATS_PATH, history);

const REPOSTS_PATH = 'state/reposts.json';
export const loadReposts = () => readJson<RepostState>(REPOSTS_PATH, {});
export const saveReposts = (state: RepostState) => writeJson(REPOSTS_PATH, state);

const VOLUME_DROPS_PATH = 'state/volume-drops.json';
export const loadVolumeDrops = () => readJson<VolumeDropState>(VOLUME_DROPS_PATH, {});
export const saveVolumeDrops = (state: VolumeDropState) => writeJson(VOLUME_DROPS_PATH, state);

const BOARD_VOLUMES_PATH = 'state/board-volumes.json';
export const loadBoardVolumes = () => readJson<VolumeHistory>(BOARD_VOLUMES_PATH, {});
export const saveBoardVolumes = (history: VolumeHistory) => writeJson(BOARD_VOLUMES_PATH, history);

/**
 * Workday requisition id -> its resolved real location, for postings whose
 * list view only ever shows a placeholder ("6 Locations"). A requisition's
 * location list doesn't change over its lifetime, so this is a permanent
 * cache, not a rolling window like seen.json — resolved once, reused forever.
 */
const MULTILOC_PATH = 'state/multiloc.json';
export const loadMultiLocations = () => readJson<Record<string, string>>(MULTILOC_PATH, {});
export const saveMultiLocations = (m: Record<string, string>) => writeJson(MULTILOC_PATH, m);

/**
 * Is this job id under one of the tenant prefixes polled this run?
 *
 * Prefixes are `${ats}:${token}:`, but the token itself can contain colons —
 * Zoho Recruit stores a whole board URL there — so the prefix boundary cannot
 * be found by splitting. Instead every colon position in the id is offered to
 * the set, which is a handful of lookups per id rather than a scan over every
 * polled prefix.
 *
 * This trusts the set to hold only whole `ats:token:` prefixes built from real
 * rows. A bare `ats:` in there would match every id on that platform; nothing
 * constructs one, because no row has an empty token.
 */
function underPolledBoard(id: string, prefixes: Set<string>): boolean {
  for (let i = id.indexOf(':'); i !== -1; i = id.indexOf(':', i + 1)) {
    if (prefixes.has(id.slice(0, i + 1))) return true;
  }
  return false;
}

/**
 * Repost bookkeeping for every board polled this run, in one pass.
 *
 * Takes the whole run's ids and prefixes together rather than one board at a
 * time. A tenant's sites are separate rows but share a single job-id space, so
 * judging one site in isolation makes its siblings' ids look absent and stamps
 * them `gone` — they then return flagged as reposts when the sibling is polled.
 * One call over the union cannot make that mistake, and it rebuilds the state
 * object once instead of once per board.
 */
export function updateReposts(state: RepostState, presentIds: Iterable<string>, prefixes: Set<string>, nowIso: string): RepostState {
  const next: RepostState = {};
  const cutoff = Date.now() - REPOST_WINDOW_DAYS * 86_400_000;
  const seenPresent = new Set(presentIds);
  for (const [id, entry] of Object.entries(state)) {
    // Boards not polled this run carry no evidence either way — only entries
    // under a polled board's prefix may be stamped, refreshed, or pruned.
    if (!underPolledBoard(id, prefixes)) {
      next[id] = entry;
      continue;
    }
    if (!seenPresent.has(id)) {
      if (new Date(entry.last).getTime() >= cutoff) {
        // Still absent within the window — keep it, stamping gone on first absence.
        next[id] = entry.gone ? entry : { last: entry.last, gone: nowIso };
      }
      // else expired: a returning id this old is just a new posting again.
    } else {
      next[id] = { last: nowIso };
    }
  }
  // Ids live now but not yet tracked start their window from this run.
  for (const id of seenPresent) {
    if (!next[id]) next[id] = { last: nowIso };
  }
  return next;
}

/**
 * Pruning is what keeps this viable without a database. Git stores a full blob
 * per commit, so an ever-growing state file would add megabytes every hour.
 * Anything older than the retention window can't meaningfully be "new" again.
 */
export async function saveSeen(seen: SeenState): Promise<number> {
  const cutoff = Date.now() - SEEN_RETENTION_DAYS * 86_400_000;
  const pruned: SeenState = {};
  for (const [id, iso] of Object.entries(seen)) {
    if (new Date(iso).getTime() >= cutoff) pruned[id] = iso;
  }
  await writeJson(SEEN_PATH, pruned);
  return Object.keys(seen).length - Object.keys(pruned).length;
}

/**
 * Tokens rot when companies rename or migrate ATS. Track it, don't guess.
 *
 * `lastPolledAt` is deliberately carried through unchanged on a failure: a
 * board that errored keeps its old poll date, so it sorts early in the cold
 * rotation and gets another attempt soon rather than going to the back of a
 * five-figure queue.
 */
export function recordFailure(previous: BoardStatus | undefined, nowIso: string): BoardStatus {
  return { lastPolledAt: previous?.lastPolledAt, failingSince: previous?.failingSince ?? nowIso };
}

/** A clean poll: stamp the time and end any failure streak. */
export function recordSuccess(nowIso: string): BoardStatus {
  return { lastPolledAt: nowIso };
}
