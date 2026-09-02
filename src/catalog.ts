import { mkdir, writeFile } from 'node:fs/promises';
import type { Job } from './types.js';
import { readJson } from './state.js';

const CATALOG_PATH = 'data/jobs.json';

/** Drop closed roles this long after they disappear from the board. */
const CLOSED_RETENTION_DAYS = 30;

/**
 * Deliberately NOT `extends Job` — `Job` carries `text`, the full job
 * description. At ~2,500 open roles that inflated this file to 4.3 MB, and it is
 * committed every hour, so git would gain tens of gigabytes a year storing a
 * fresh copy each time. Nothing downstream reads the description: the years are
 * already extracted into `minYears`, and the email and UI show neither.
 */
export interface CatalogEntry {
  id: string;
  title: string;
  company: string;
  industry: Job['industry'];
  location: string;
  url: string;
  postedAt?: string;
  salary?: string;
  /** Normalized ₹ LPA band from src/salary.ts — drives the UI's salary facet. */
  salaryMin?: number;
  salaryMax?: number;
  workMode?: 'remote' | 'hybrid' | 'onsite';
  visa?: boolean;
  minYears: number | null;
  maxYears: number | null;
  isIntern: boolean;
  firstSeen: string;
  lastSeen: string;
  /** Set once the posting stops appearing on a board we polled successfully. */
  closedAt?: string;
}

function slim(job: Job): Omit<CatalogEntry, 'firstSeen' | 'lastSeen'> {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    industry: job.industry,
    location: job.location,
    url: job.url,
    postedAt: job.postedAt,
    salary: job.salary,
    // A few bytes per entry; the web UI facets on all three. `isRepost` is
    // deliberately excluded — it is an alert-time judgment, not a property of
    // the posting, and it would go stale in the catalogue.
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    workMode: job.workMode ?? undefined,
    visa: job.visa || undefined,
    minYears: job.minYears,
    maxYears: job.maxYears,
    isIntern: job.isIntern,
  };
}

export interface CatalogUpdate {
  /** Matches discovered this run. */
  fresh: Job[];
  /** Every job ID currently live, across boards that responded. */
  liveIds: Set<string>;
  /** `ats:token` of boards polled successfully — a failed board must not close its jobs. */
  polledBoards: Set<string>;
  now: string;
}

function boardKey(id: string): string {
  const [ats, token] = id.split(':');
  return `${ats}:${token}`;
}

/**
 * The catalogue is what the UI reads: every match currently open, plus recently
 * closed ones. Closure is inferred from absence — a posting that vanishes from a
 * board that answered normally has been taken down. Boards that errored are
 * skipped, otherwise one flaky response would mark a company's entire listing
 * as closed.
 */
export async function updateCatalog(update: CatalogUpdate): Promise<{
  open: number;
  closed: number;
  reopened: number;
  pruned: number;
}> {
  const existing = await readJson<CatalogEntry[]>(CATALOG_PATH, []);
  const byId = new Map(existing.map((entry) => [entry.id, entry]));

  let closed = 0;
  let reopened = 0;

  for (const entry of byId.values()) {
    if (!update.polledBoards.has(boardKey(entry.id))) continue;

    if (update.liveIds.has(entry.id)) {
      entry.lastSeen = update.now;
      if (entry.closedAt) {
        delete entry.closedAt;
        reopened++;
      }
    } else if (!entry.closedAt) {
      entry.closedAt = update.now;
      closed++;
    }
  }

  for (const job of update.fresh) {
    const previous = byId.get(job.id);
    byId.set(job.id, {
      ...slim(job),
      firstSeen: previous?.firstSeen ?? update.now,
      lastSeen: update.now,
    });
  }

  const cutoff = Date.now() - CLOSED_RETENTION_DAYS * 86_400_000;
  const kept = [...byId.values()].filter(
    (entry) => !entry.closedAt || new Date(entry.closedAt).getTime() >= cutoff,
  );

  kept.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));

  await mkdir('data', { recursive: true });
  await writeFile(CATALOG_PATH, `${JSON.stringify(kept)}\n`, 'utf8');

  return {
    open: kept.filter((entry) => !entry.closedAt).length,
    closed,
    reopened,
    pruned: byId.size - kept.length,
  };
}
