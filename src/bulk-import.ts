import type { Ats, Company, Industry } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimitByKey, UA } from './fetchers/util.js';
import { HOST_CONCURRENCY } from './config.js';
import { locationMatches, roleFamily } from './filter.js';
import { classify } from './classify.js';
import { loadCompanies, saveCompanies } from './state.js';
import { WORKDAY } from './board-url.js';

/**
 * Bulk-imports boards from kalil0321/ats-scrapers' published tenant lists.
 *
 *   npm run bulk-import -- [--bar india|fresher|live] [--limit N] [--platform X]
 *
 * That project crawls ~77,000 ATS tenants, ~21,000 of them on platforms this
 * codebase already reads. `detect` and `probe` cannot reach these: detect needs
 * a careers page that links its own board, and probe only guesses tokens that
 * match the brand name. A published tenant list sidesteps both.
 *
 * Every candidate is polled before it is kept, because a tenant slug that
 * resolves is not evidence of a real company — three plausible-looking "IBM"
 * Oracle tenants turned out to be a Guatemalan retailer, an Iowa college and a
 * Syracuse school district.
 */
const RAW = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';

/** Platforms whose CSV row carries everything the fetcher needs. */
const IMPORTABLE: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'oracle'];

const ORACLE_URL =
  /https?:\/\/([a-z0-9-]+)\.(fa\.[a-z0-9]+)\.oraclecloud\.com\/.*?\/sites\/([A-Za-z0-9_]+)/i;

type Bar = 'india' | 'fresher' | 'live';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const bar = (flag('bar') ?? 'india') as Bar;
const limit = Number(flag('limit') ?? 0);
const onlyPlatform = flag('platform') as Ats | undefined;

/** Naive CSV split is enough here: only the trailing url field can contain commas. */
function parseRow(platform: Ats, line: string): Company | null {
  const [rawName, slug, url] = line.split(',');
  const name = (rawName ?? '').trim().replace(/^"|"$/g, '');
  if (!name || !slug) return null;
  const base = { name, ats: platform, industry: 'tech' as Industry, source: 'discovered' as const };

  if (platform === 'workday') {
    const m = WORKDAY.exec(url ?? '');
    return m ? { ...base, token: m[1]!, host: m[2]!, site: m[3]! } : null;
  }
  if (platform === 'oracle') {
    const m = ORACLE_URL.exec(url ?? '');
    return m ? { ...base, token: m[1]!, host: m[2]!, siteNumber: m[3]! } : null;
  }
  const token = slug.trim();
  if (!token || token.includes('/') || token.startsWith('http')) return null;
  return { ...base, token };
}

async function loadCsv(platform: Ats): Promise<Company[]> {
  const res = await fetch(`${RAW}/${platform}.csv`, { headers: { 'user-agent': UA } });
  if (!res.ok) {
    console.warn(`  ! ${platform}.csv: ${res.status}`);
    return [];
  }
  const lines = (await res.text()).trim().split('\n').slice(1);
  return lines.map((l) => parseRow(platform, l)).filter((c): c is Company => c !== null);
}

/** Same shape as the hourly run's scheduler, so imports respect the same host caps. */
const rateLimitKey = (c: Company) => (c.ats === 'workday' ? `workday:${c.host}` : c.ats);
const limitForHost = (key: string) =>
  HOST_CONCURRENCY[key.split(':')[0]!] ?? HOST_CONCURRENCY.default!;

async function main(): Promise<void> {
  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));

  const platforms = onlyPlatform ? [onlyPlatform] : IMPORTABLE;
  let candidates: Company[] = [];
  for (const platform of platforms) {
    const rows = await loadCsv(platform);
    const fresh = rows.filter((c) => !known.has(`${c.ats}:${c.token.toLowerCase()}`));
    // One tenant can appear under several names in a crawled list.
    const deduped = new Map(fresh.map((c) => [`${c.ats}:${c.token.toLowerCase()}`, c]));
    console.log(`${platform.padEnd(16)} ${rows.length} listed, ${deduped.size} untracked`);
    candidates.push(...deduped.values());
  }

  if (limit > 0) {
    const step = Math.max(1, Math.floor(candidates.length / limit));
    candidates = candidates.filter((_, i) => i % step === 0).slice(0, limit);
  }
  console.log(`\nvalidating ${candidates.length} boards (bar: ${bar})\n`);

  const keep: Company[] = [];
  let live = 0;
  let done = 0;

  /**
   * Checkpoint as we go. A full sweep is ~16,600 network round trips and takes
   * over an hour, and saving only at the end means anything that interrupts it
   * throws the whole run away — a first attempt died at 15,000/16,618 and lost
   * all 2,086 boards it had already validated.
   *
   * Writes are serialised by chaining onto the previous one rather than by a
   * boolean "busy" flag. A flag makes concurrent callers *skip* their write,
   * which silently drops whatever they had added since the last save — the
   * final write raced a checkpoint that way and landed 3,793 boards on disk
   * when 3,798 had been validated. Chaining makes every caller wait its turn
   * instead, so the last write always reflects the full set.
   */
  let pendingSave: Promise<void> = Promise.resolve();
  const checkpoint = (): Promise<void> => {
    pendingSave = pendingSave.then(() => saveCompanies([...existing, ...keep]));
    return pendingSave;
  };

  await mapLimitByKey(candidates, rateLimitKey, limitForHost, async (company) => {
    if (++done % 250 === 0) {
      console.log(`  ...${done}/${candidates.length}, ${keep.length} kept`);
      await checkpoint();
    }
    try {
      const jobs = await FETCHERS[company.ats].list(company);
      if (jobs.length === 0) return;
      live++;
      if (bar === 'live') return void keep.push(company);

      const india = jobs.filter((j) => locationMatches(j.location));
      if (india.length === 0) return;
      if (bar === 'india') return void keep.push(company);

      const fresher = india.some((j) => {
        if (!roleFamily(j.title, company.industry)) return false;
        const c = classify(j, company.industry);
        return !c.excluded && c.isJunior;
      });
      if (fresher) keep.push(company);
    } catch {
      /* dead or unreachable board — silently skipped, same as detect */
    }
  });

  console.log(`\n${live}/${candidates.length} live, ${keep.length} cleared the "${bar}" bar`);
  if (keep.length === 0) return;

  keep.sort((a, b) => a.name.localeCompare(b.name));
  for (const c of keep.slice(0, 40)) console.log(`  + ${c.name} [${c.ats}:${c.token}]`);
  if (keep.length > 40) console.log(`  ... and ${keep.length - 40} more`);

  await checkpoint();
  console.log(`\ncompanies.json: ${existing.length} -> ${existing.length + keep.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
