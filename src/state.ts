import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Company, SeenState } from './types.js';
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
export const saveCompanies = (c: Company[]) => writeJson(COMPANIES_PATH, c);

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
 * Repost bookkeeping for one board (see the function comment below for why
 * scoping to a single polled board matters).
 */
export function updateReposts(state: RepostState, presentIds: Iterable<string>, prefix: string, nowIso: string): RepostState {
  const next: RepostState = {};
  const cutoff = Date.now() - REPOST_WINDOW_DAYS * 86_400_000;
  const seenPresent = new Set(presentIds);
  for (const [id, entry] of Object.entries(state)) {
    // Boards not polled this run carry no evidence either way — only entries
    // under this board's prefix may be stamped, refreshed, or pruned.
    if (!id.startsWith(prefix)) {
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

/** Tokens rot when companies rename or migrate ATS. Track it, don't guess. */
export function recordFailure(company: Company, nowIso: string): Company {
  return { ...company, failingSince: company.failingSince ?? nowIso };
}

export function recordSuccess(company: Company): Company {
  const { failingSince: _drop, ...rest } = company;
  return rest;
}
