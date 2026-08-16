import { mkdir, writeFile } from 'node:fs/promises';
import type { Ats, Company } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { getJson, mapLimit, UA } from './fetchers/util.js';
import { isServiceCompany, locationMatches } from './filter.js';
import { loadCompanies, readJson, saveCompanies } from './state.js';
import { CONCURRENCY } from './config.js';

/** Safety cap on rows parsed from one block, to bound memory. */
const MAX_ROWS_PER_BLOCK = 250_000;
/** Ceiling on boards added per weekly run, so the corpus grows steadily. */
const MAX_NEW_PER_RUN = 60;
/** Where the CDX page cursor lives, so successive runs scan new ground. */
const CURSOR_PATH = 'state/discover-cursor.json';

interface CdxRow {
  url: string;
}

const PATTERNS: { pattern: string; ats: Ats }[] = [
  { pattern: 'boards.greenhouse.io/*', ats: 'greenhouse' },
  { pattern: 'job-boards.greenhouse.io/*', ats: 'greenhouse' },
  { pattern: 'jobs.lever.co/*', ats: 'lever' },
  { pattern: 'jobs.ashbyhq.com/*', ats: 'ashby' },
  { pattern: '*.myworkdayjobs.com', ats: 'workday' },
];

/** Board tokens that are Greenhouse/Lever plumbing rather than companies. */
const NOT_A_COMPANY = /^(embed|api|v1|assets|static|images|css|js|robots|sitemap|favicon|_next)$/i;

async function latestIndex(): Promise<string> {
  const collections = await getJson<{ 'cdx-api': string }[]>(
    'https://index.commoncrawl.org/collinfo.json',
  );
  const newest = collections[0]?.['cdx-api'];
  if (!newest) throw new Error('no Common Crawl collection found');
  return newest;
}

/**
 * The CDX API streams JSON Lines, not a JSON array, and returns rows in
 * alphabetical URL order.
 *
 * Paging is by *block*, and `limit` truncates before paging applies — passing
 * both silently returns an empty page 1, so every run would rescan the same
 * `0x…2k` slice forever and find nothing new after the first. `pageSize=1`
 * takes exactly one block per run and the cursor walks them.
 */
async function cdxRows(indexUrl: string, pattern: string, page: number): Promise<CdxRow[]> {
  const res = await fetch(
    `${indexUrl}?url=${encodeURIComponent(pattern)}&output=json&page=${page}&pageSize=1`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(300_000) },
  );
  if (!res.ok) return [];
  const body = await res.text();
  return body
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_ROWS_PER_BLOCK)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CdxRow];
      } catch {
        return [];
      }
    });
}

function parseCandidate(url: string, ats: Ats): Company | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (ats === 'workday') {
    // Sandbox tenants (impl-wd502 and friends) serve fake jobs. Skip them.
    const [tenant, host] = parsed.hostname.split('.');
    if (!tenant || !host || host.startsWith('impl')) return null;
    const isLocale = /^[a-z]{2}-[A-Za-z]{2}$/.test(segments[0] ?? '');
    const site = isLocale ? segments[1] : segments[0];
    if (!site) return null;
    return { name: tenant, ats, token: tenant, host, site, industry: 'tech', source: 'discovered' };
  }

  const token = segments[0];
  if (!token || NOT_A_COMPANY.test(token)) return null;
  return { name: token, ats, token, industry: 'tech', source: 'discovered' };
}

/**
 * A board only earns a slot if it currently has at least one role in India or
 * genuinely-remote. Without this gate the harvest adds thousands of companies
 * that can never produce a single alert.
 */
async function isWorthKeeping(company: Company): Promise<boolean> {
  try {
    const jobs = await FETCHERS[company.ats].list(company);
    return jobs.length > 0 && jobs.some((job) => locationMatches(job.location));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));

  let indexUrl: string;
  try {
    indexUrl = await latestIndex();
  } catch (err) {
    console.warn(`Common Crawl index unavailable (${(err as Error).message}) — skipping harvest for this run.`);
    return;
  }
  console.log(`harvesting from ${indexUrl}`);

  const cursor = await readJson<{ page: number }>(CURSOR_PATH, { page: 0 });
  console.log(`scanning CDX page ${cursor.page}`);

  const candidates = new Map<string, Company>();
  let exhausted = 0;

  for (const { pattern, ats } of PATTERNS) {
    const rows = await cdxRows(indexUrl, pattern, cursor.page);
    if (rows.length === 0) exhausted++;
    for (const row of rows) {
      const candidate = parseCandidate(row.url, ats);
      if (!candidate) continue;
      if (isServiceCompany(candidate.name)) continue;
      const key = `${candidate.ats}:${candidate.token.toLowerCase()}`;
      if (known.has(key) || candidates.has(key)) continue;
      candidates.set(key, candidate);
    }
    console.log(`  ${pattern}: ${rows.length} rows, ${candidates.size} unique candidates so far`);
  }

  const list = [...candidates.values()];
  console.log(`probing ${list.length} candidates for India/remote roles`);

  const keep: Company[] = [];
  await mapLimit(list, CONCURRENCY, async (candidate) => {
    if (keep.length >= MAX_NEW_PER_RUN) return;
    if (await isWorthKeeping(candidate)) {
      keep.push(candidate);
      console.log(`  + ${candidate.ats}:${candidate.token}`);
    }
  });

  // Advance the cursor whichever way the run went — wrapping to 0 once every
  // pattern comes back empty, so the sweep cycles rather than dead-ends.
  const nextPage = exhausted === PATTERNS.length ? 0 : cursor.page + 1;
  await mkdir('state', { recursive: true });
  await writeFile(CURSOR_PATH, `${JSON.stringify({ page: nextPage })}\n`, 'utf8');
  console.log(`next run scans CDX page ${nextPage}`);

  if (keep.length === 0) {
    console.log('no new boards worth adding');
    return;
  }

  await saveCompanies([...existing, ...keep]);
  console.log(`added ${keep.length} boards (${existing.length} -> ${existing.length + keep.length})`);
  console.log('review companies.json — discovered entries default to industry "tech"');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
