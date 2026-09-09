import { readFile } from 'node:fs/promises';
import type { Ats, Company, Industry } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimitByKey, UA } from './fetchers/util.js';
import { limitForHost, rateLimitKey } from './config.js';
import { isServiceCompany, locationMatches, roleFamily } from './filter.js';
import { classify } from './classify.js';
import { loadCompanies, saveCompanies } from './state.js';
import { boardKey, parseBoardUrl, prettify, WORKDAY } from './board-url.js';
import { discoverSites } from './fetchers/workday.js';

/**
 * Bulk-imports boards from kalil0321/ats-scrapers' published tenant lists.
 *
 *   npm run bulk-import -- [--bar india|fresher|live] [--limit N] [--platform X]
 *   npm run bulk-import -- --rediscover [--bar india|fresher|live] [--limit N]
 *   npm run bulk-import -- --file <path> [--bar india|fresher|live] [--limit N]
 *   npm run bulk-import -- --file <path> --platform X [--bar ...] [--limit N]
 *
 * `--rediscover` skips the CSV import entirely and instead walks every
 * existing Workday tenant's robots.txt for career-site names we don't already
 * track (see `discoverCandidateSites` below) — a different candidate source,
 * same validate+checkpoint pipeline.
 *
 * `--file <path>` alone is the same site-discovery step, but the tenants come
 * from a local text file of Workday hostnames (one per line, e.g.
 * `3m.wd1.myworkdayjobs.com`) instead of our own companies.json — for a
 * published hostname list, like open-jobs' `slugs.json`, that carries no site
 * at all. `--file <path> --platform X` (X other than workday) is simpler:
 * every line is a bare subdomain slug for that one ATS, no site concept to
 * resolve, straight into the validate+checkpoint loop below.
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

/**
 * Platforms whose CSV row carries everything the fetcher needs.
 *
 * Keka, Teamtailor, Breezy, Personio, Recruitee and Darwinbox joined on
 * 2026-09-06 — a platform can only be listed here if a bare slug (or a URL,
 * via `parseRow`'s fallback) is enough to build a fetchable board. Row counts
 * in that source at the time: personio 2,463, teamtailor 1,464, breezy 1,384,
 * recruitee 1,164, keka 185, darwinbox ~170.
 *
 * Recruitee and Darwinbox are the cautionary ones: both adapters had existed
 * for months while this list stayed at seven platforms, so the corpus held 37
 * Recruitee and 40 Darwinbox boards against four-figure published tenant
 * lists. Keka was the same story and one import took it from 7 boards to 170.
 * **Before adding an adapter, check whether this list is why a platform looks
 * small** — a working fetcher that nothing feeds is the same as no fetcher.
 * Darwinbox is listed with only its tenant slug on purpose: the CSV carries
 * the older `/ms/candidate/careers` URL form, which needs no companyId hash
 * (verified live against Airtel and BigBasket before adding).
 *
 * SuccessFactors (1,392 rows), Phenom (98), Eightfold (83) and iCIMS (2,498)
 * are all hostname-token platforms. iCIMS was excluded here for a day on the
 * strength of a 12-tenant sample that came back 0/12 against its legacy
 * `/api/jobs` endpoint; `icims.ts` now also reads the modern portal's
 * server-rendered search page, and a 40-tenant re-check returned rows on 38.
 */
const IMPORTABLE: Ats[] = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workday',
  'oracle',
  'workable',
  'keka',
  'teamtailor',
  'breezy',
  'personio',
  'recruitee',
  'darwinbox',
  'successfactors',
  'phenom',
  'eightfold',
  'ukg',
  'icims',
  'taleo',
];

/**
 * Platforms with a published tenant list that this file deliberately does not
 * import, and why. Anything named here is excluded from the staleness warning
 * below, so the warning stays a real signal rather than a line everyone learns
 * to scroll past.
 */
const NOT_WORTH_IMPORTING: Partial<Record<Ats, string>> = {
  // Empty on purpose. iCIMS lived here for exactly one day, on the strength of
  // a 12-tenant sample that came back 0/12 against its legacy `/api/jobs`
  // endpoint. The sample was right and the conclusion was wrong: those tenants
  // server-render a search page instead, `icims.ts` now reads it, and a
  // 40-tenant re-check returned rows on 38. A measurement that says "this
  // endpoint is dead" is not a measurement that says "this platform is
  // unreachable" — check the other shapes before adding anything here.
};

/**
 * The check that would have caught this file's own worst bug.
 *
 * `IMPORTABLE` sat at seven platforms while the source published forty-eight,
 * so Keka, Recruitee and Darwinbox each had a working fetcher and nothing
 * feeding it — Keka was tracking 7 boards against 185 published tenants, and
 * one import took it to 170. Nothing anywhere said so; it relied on somebody
 * remembering to cross-check two hand-maintained lists.
 *
 * Kept as a pure function so the regression suite can cover it without a
 * network call. The caller does the fetching and treats any failure as
 * silence: this is advisory, and a GitHub rate limit must never fail a run.
 */
export function unfedPlatforms(
  published: readonly string[],
  importable: readonly string[],
  adapters: readonly string[],
  skip: Readonly<Partial<Record<string, string>>> = NOT_WORTH_IMPORTING,
): string[] {
  const have = new Set(published.map((name) => name.replace(/\.csv$/i, '')));
  return adapters
    .filter((ats) => have.has(ats))
    .filter((ats) => !importable.includes(ats))
    .filter((ats) => !(ats in skip))
    .sort();
}

const LISTING_URL = 'https://api.github.com/repos/kalil0321/ats-scrapers/contents/ats-companies';

async function warnAboutUnfedPlatforms(): Promise<void> {
  let names: string[];
  try {
    const res = await fetch(LISTING_URL, {
      headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    names = ((await res.json()) as { name?: string }[]).map((f) => f.name ?? '');
  } catch {
    return; // Advisory only — never fail a real import over the listing call.
  }

  const unfed = unfedPlatforms(names, IMPORTABLE, Object.keys(FETCHERS));
  if (unfed.length === 0) return;

  console.warn(`\n  ! tenant lists are published for platforms with a working adapter that IMPORTABLE does not list: ${unfed.join(', ')}`);
  console.warn('    a working fetcher that nothing feeds is the same as no fetcher — check these before writing a new adapter\n');
}

const ORACLE_URL =
  /https?:\/\/([a-z0-9-]+)\.(fa\.[a-z0-9]+)\.oraclecloud\.com\/.*?\/sites\/([A-Za-z0-9_]+)/i;

/** UKG needs both halves of its board path: neither the tenant code nor the
 *  board GUID is derivable from the other, which is what defeated an earlier
 *  blind probe of this platform. */
const UKG_URL = /recruiting\.ultipro\.com\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i;

type Bar = 'india' | 'fresher' | 'live';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const bar = (flag('bar') ?? 'india') as Bar;
const limit = Number(flag('limit') ?? 0);
const onlyPlatform = flag('platform') as Ats | undefined;
const rediscover = args.includes('--rediscover');
const filePath = flag('file');

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * This used to be a bare `line.split(',')`, on the stated assumption that only
 * the trailing url field could contain a comma. That is false, and measurably
 * so: 896 rows across the six original lists carry a quoted company name with
 * a comma in it — `"80,000 Hours"`, `"Apex Technology, Inc."`, `"48Forty
 * Solutions, LLC"`. Splitting those naively pushes the tail of the name into
 * the slug field, so the row resolves to a nonsense token and is dropped at
 * validation. 331 of iCIMS's 2,498 rows are this shape.
 */
export function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else field += ch;
  }
  fields.push(field.trim());
  return fields;
}

/** Hostname-as-token platforms: the board has no derivable slug, so the whole
 *  host is the token (`careers.gehealthcare.com`, `ace1950.jobs2web.com`). */
const HOSTNAME_TOKEN = new Set<Ats>(['successfactors', 'phenom', 'eightfold', 'icims']);

const hostOf = (url: string): string | undefined =>
  url.replace(/^https?:\/\//i, '').split('/')[0]?.trim() || undefined;

function parseRow(platform: Ats, line: string): Company | null {
  const fields = csvFields(line);
  // phenom.csv is the one list whose columns are `url,name,...` instead of
  // `name,slug,url`; every other list this file reads leads with the name.
  const [rawName, slug, url] =
    platform === 'phenom'
      ? [fields[1], undefined, fields[0]]
      : [fields[0], fields[1], fields[2]];
  const name = (rawName ?? '').trim();
  if (!name) return null;
  const base = { name, ats: platform, industry: 'tech' as Industry, source: 'discovered' as const };

  if (platform === 'ukg') {
    const m = UKG_URL.exec(url ?? '');
    return m ? { ...base, token: m[1]!, site: m[2]! } : null;
  }

  if (HOSTNAME_TOKEN.has(platform)) {
    const host = hostOf(url ?? '');
    if (!host) return null;
    // Eightfold additionally needs the tenant's own mail domain — it is the
    // `domain=` query parameter its search API requires, not decoration. Rows
    // that leave that column blank cannot be fetched, so they are dropped
    // rather than guessed at.
    if (platform === 'eightfold') {
      const domain = fields[3]?.trim();
      return domain ? { ...base, token: host, site: domain } : null;
    }
    return { ...base, token: host };
  }

  if (!slug) return null;

  if (platform === 'workday') {
    const m = WORKDAY.exec(url ?? '');
    return m ? { ...base, token: m[1]!, host: m[2]!, site: m[3]! } : null;
  }
  if (platform === 'oracle') {
    const m = ORACLE_URL.exec(url ?? '');
    return m ? { ...base, token: m[1]!, host: m[2]!, siteNumber: m[3]! } : null;
  }
  const token = slug.trim();
  if (!token || token.includes('/') || token.startsWith('http')) {
    // Not every list ships a slug column — keka.csv is `name,url` only, so the
    // second field is the board URL itself. That URL is authoritative anyway,
    // and `board-url.ts` already knows how to read every platform we can
    // auto-derive, so fall back to it rather than dropping the row. The
    // platform check matters: a list can carry a stray URL for some other ATS,
    // and importing it under this platform's name would create a board that
    // can never be fetched.
    const parsed = parseBoardUrl(url ?? slug ?? '');
    return parsed?.ats === platform ? { ...parsed, ...base, token: parsed.token } : null;
  }
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

const WORKDAY_HOSTNAME = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;

/**
 * `--file`: a plain-text hostname list carries no `site`, unlike the CSVs
 * above — open-jobs' `slugs.json` crawled the tenant, not any one career
 * page, so `discoverCandidateSites` below has to resolve the site the same
 * way `--rediscover` does for our own tenants.
 */
async function loadSlugFile(path: string): Promise<{ token: string; host: string }[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const tenants = new Map<string, { token: string; host: string }>();
  for (const line of lines) {
    const m = WORKDAY_HOSTNAME.exec(line.trim());
    if (!m) continue;
    tenants.set(`${m[1]}:${m[2]}`, { token: m[1]!, host: m[2]! });
  }
  return [...tenants.values()];
}

/**
 * `--file` for a non-Workday platform: open-jobs' `slugs.json` lists these as
 * bare subdomains (`"11bitstudios"`, one per line), not hostnames — the ATS
 * itself has no multi-site concept, so unlike Workday there's no site to
 * resolve. Each line becomes a candidate directly.
 */
async function loadPlainSlugFile(path: string, platform: Ats): Promise<Company[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const tokens = new Set(lines.map((l) => l.trim()).filter(Boolean));
  return [...tokens].map((token) => ({
    name: prettify(token),
    ats: platform,
    token,
    industry: 'tech' as Industry,
    source: 'discovered' as const,
  }));
}

/**
 * How many host groups an import runs at once.
 *
 * The hourly run needs no such ceiling — `BOARDS_PER_RUN` already bounds how
 * many hosts one run can touch. An import is the opposite shape: it sweeps a
 * whole published tenant list, and SuccessFactors alone spans 1,289 distinct
 * hostnames whose feeds take 30-170s each. Left unbounded, the per-host cap
 * would open a socket per tenant. At 24 the same sweep finishes in roughly an
 * hour and a half while no individual host ever sees more than its own cap.
 */
const IMPORT_MAX_HOSTS = 24;

/**
 * Shared by `--rediscover` and `--file`: neither source carries a `site`, so
 * both resolve it the same way — one robots.txt hit per tenant, one candidate
 * row per site it lists. A resolved site is not proof of a useful board on
 * its own; that's what the validate+checkpoint loop below is for.
 */
async function discoverCandidateSites(
  tenants: { name: string; token: string; host: string; industry: Industry }[],
  known: Set<string>,
): Promise<Company[]> {
  const found: Company[] = [];
  let checked = 0;
  await mapLimitByKey(
    tenants,
    (c) => `workday:${c.host}`,
    limitForHost,
    async (tenant) => {
      if (++checked % 100 === 0) console.log(`  ...${checked}/${tenants.length} tenants`);
      let sites: string[] | 'gone';
      try {
        sites = await discoverSites({ ...tenant, ats: 'workday', source: 'discovered' });
      } catch {
        return;
      }
      if (sites === 'gone') return;
      for (const site of sites) {
        const candidate: Company = { ...tenant, ats: 'workday', source: 'discovered', site };
        if (!known.has(boardKey(candidate))) found.push(candidate);
      }
    },
  );

  const deduped = new Map(found.map((c) => [boardKey(c), c]));
  console.log(`${tenants.length} tenants checked, ${deduped.size} untracked sites found`);
  return [...deduped.values()];
}

async function main(): Promise<void> {
  await warnAboutUnfedPlatforms();
  const existing = await loadCompanies();
  const known = new Set(existing.map(boardKey));

  let candidates: Company[] = [];
  if (rediscover) {
    const workdayRows = existing.filter(
      (c): c is Company & { host: string } => c.ats === 'workday' && Boolean(c.host),
    );
    const tenants = new Map(workdayRows.map((c) => [`${c.token}:${c.host}`, c]));
    console.log(`rediscovering sites on ${tenants.size} workday tenants\n`);
    candidates = await discoverCandidateSites([...tenants.values()], known);
  } else if (filePath && onlyPlatform && onlyPlatform !== 'workday') {
    const rows = await loadPlainSlugFile(filePath, onlyPlatform);
    const fresh = rows.filter((c) => !known.has(boardKey(c)));
    console.log(`${filePath}: ${rows.length} listed, ${fresh.length} untracked`);
    candidates = fresh;
  } else if (filePath) {
    const tenants = await loadSlugFile(filePath);
    console.log(`${filePath}: ${tenants.length} workday tenants\n`);
    candidates = await discoverCandidateSites(
      tenants.map((t) => ({ ...t, name: prettify(t.token), industry: 'tech' as Industry })),
      known,
    );
  } else {
    const platforms = onlyPlatform ? [onlyPlatform] : IMPORTABLE;
    for (const platform of platforms) {
      const rows = await loadCsv(platform);
      const fresh = rows.filter((c) => !known.has(boardKey(c)));
      // One tenant can appear under several names in a crawled list. Keyed by
      // board, not tenant, so a Workday tenant's second career site is a genuine
      // new candidate rather than a duplicate of the site we already track.
      const deduped = new Map(fresh.map((c) => [boardKey(c), c]));
      console.log(`${platform.padEnd(16)} ${rows.length} listed, ${deduped.size} untracked`);
      candidates.push(...deduped.values());
    }
  }

  // Same guard every other importer (detect/discover/probe/import-urls) already
  // applies. Missing it here let Capgemini through a real workable run — its
  // jobs can never alert (preScreen rejects it too), so a kept row here is
  // pure wasted poll budget forever, not a false alert, but still wrong to keep.
  const before = candidates.length;
  candidates = candidates.filter((c) => !isServiceCompany(c.name));
  if (candidates.length < before) {
    console.log(`excluded ${before - candidates.length} service-company candidate(s)`);
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

  await mapLimitByKey(
    candidates,
    rateLimitKey,
    limitForHost,
    async (company) => {
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
    },
    IMPORT_MAX_HOSTS,
  );

  console.log(`\n${live}/${candidates.length} live, ${keep.length} cleared the "${bar}" bar`);
  if (keep.length === 0) return;

  keep.sort((a, b) => a.name.localeCompare(b.name));
  for (const c of keep.slice(0, 40)) console.log(`  + ${c.name} [${c.ats}:${c.token}]`);
  if (keep.length > 40) console.log(`  ... and ${keep.length - 40} more`);

  await checkpoint();
  console.log(`\ncompanies.json: ${existing.length} -> ${existing.length + keep.length}`);
}

// Guarded the same way `contacts.ts` and `contact-sources.ts` guard theirs.
// Without this, importing anything from this file — the regression suite now
// imports `csvFields` — starts a real bulk import as a side effect: live
// requests against thousands of boards, and a `saveCompanies` write at the
// end. `detect.ts` still has the unguarded shape and is deliberately not
// imported anywhere for that reason.
if (process.argv[1]?.endsWith('bulk-import.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
