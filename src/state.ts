import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Company, SeenState } from './types.js';
import { SEEN_RETENTION_DAYS } from './config.js';

const SEEN_PATH = 'state/seen.json';
const COMPANIES_PATH = 'companies.json';

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
