import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText, UA } from './util.js';

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

const PAGE_SIZE = 20; // Workday caps `limit` at 20 regardless of what you ask for — a real API limit, not ours.

// The unfiltered sweep only needs to catch *recent* postings across the whole
// company (India roles that outrank it get caught by the India-specific search
// below), so it stays cheap.
const RECENT_MAX_PAGES = 15; // ~300 newest roles company-wide.

// The India-specific search is what actually has to be complete, and 300 was
// silently clipping real roles: measured 2026-08-18 across ~720 live Workday
// boards, at least 10 companies exceed it — Citi (1,046), Fresenius Medical
// Care (1,091) and Amgen (978) alone were losing 700+ real India postings a
// run. 75 pages (1,500 roles) covers every measured case with headroom; if a
// board ever exceeds that, re-measure before raising further, same rule as
// BOARDS_PER_RUN in config.ts.
const INDIA_MAX_PAGES = 75;

function base(company: Company): string {
  return `https://${company.token}.${company.host}.myworkdayjobs.com`;
}

/** Names that resolve but aren't a real career site — robots.txt plumbing, not a tenant. */
const NOT_SITES = new Set(['refreshFacet', 'events', 'wday']);

/**
 * Parses a Workday tenant's `robots.txt` for its career-site names.
 *
 * Every existing entry in companies.json carries exactly one `site`, whichever
 * URL happened to be observed when it was added — but a tenant can host
 * several genuinely different boards (CIBC's `search` + `campus`, RTX's
 * `Private_Posting_No_TMP` + `REC_RTX_Ext_Gateway`), and there was no way to
 * see the ones we didn't already have a URL for. robots.txt lists them all:
 * `Allow: /<site>/` for public ones, `Sitemap: .../<site>/siteMap.xml` as a
 * second source, `Disallow: /<site>/` for tenants that only gate a site
 * rather than listing it — ported from open-jobs (CC0), the only public
 * source that had already reverse-engineered this shape.
 */
export function parseRobotsSites(text: string): string[] {
  const allow: string[] = [];
  const disallow: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(Allow|Disallow|Sitemap)\s*:\s*(\S+)/i.exec(line);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const site = kind === 'sitemap'
      ? /\/([^/]+)\/siteMap\.xml/i.exec(m[2]!)?.[1]
      : /^\/([^/]+)\/?$/.exec(m[2]!)?.[1];
    if (!site || NOT_SITES.has(site)) continue;
    (kind === 'disallow' ? disallow : allow).push(site);
  }
  const uniq = (a: string[]) => [...new Set(a)];
  // Allow'd/sitemapped sites are the ones meant to be public; some tenants
  // only ever mention their sites via Disallow.
  return allow.length ? uniq(allow) : uniq(disallow);
}

/**
 * Fetches and parses a tenant's robots.txt. `'gone'` covers both a
 * nonexistent tenant (404/422) and Workday's unknown-tenant signature (every
 * path 500s) — either way there is nothing to discover, and it doubles as a
 * free liveness check on guessed hostnames.
 *
 * A resolution step for `bulk-import --rediscover`, not a runtime fallback
 * inside `list()` — the site name never changes once known, so re-deriving it
 * every run would burn a request per Workday board forever, and it structurally
 * cannot turn one tenant into the multiple companies.json rows this needs.
 */
export async function discoverSites(company: Company): Promise<string[] | 'gone'> {
  const res = await fetch(`${base(company)}/robots.txt`, { headers: { 'user-agent': UA } });
  if (res.status === 404 || res.status === 422 || res.status === 500) return 'gone';
  if (!res.ok) throw new Error(`workday ${company.token}.${company.host}: robots.txt HTTP ${res.status}`);
  return parseRobotsSites(await res.text());
}

/**
 * Workday dates a posting with a relative English label, not a timestamp:
 * "Posted Today", "Posted Yesterday", "Posted 5 Days Ago", "Posted 30+ Days Ago".
 *
 * Those strings used to be stored raw, so `new Date(...)` produced NaN and
 * `isFreshEnough` waved every Workday role through as urgent-fresh. Measured
 * 2026-09-03: 3,561 of the catalogue's 9,300 entries are Workday — 38% — and
 * 1,377 of them openly said they were over a month old while still being
 * treated as brand new. `EMAIL_FRESHNESS_DAYS`'s comment blamed Workday for
 * exposing no date at all; it exposes one, we just never parsed it.
 *
 * "30+ Days Ago" deliberately stays `undefined`. It is a floor, not a date, and
 * the only way to express it is `now - 30d` — which moves forward a day every
 * day, so the posting would report a newer date on every run and read as
 * permanently date-bumped once bump detection lands. An absent date already
 * means "always fresh", which is exactly the behaviour those postings have
 * today, so nothing regresses; the other ~61% get real dates.
 */
export function parsePostedOn(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const t = label.toLowerCase();
  if (t.includes('+')) return undefined; // "30+ Days Ago" — a floor, not a date.

  let days: number;
  if (t.includes('today')) days = 0;
  else if (t.includes('yesterday')) days = 1;
  else {
    const m = /(\d+)\s*days?\s*ago/.exec(t);
    if (!m) return undefined;
    days = Number(m[1]);
  }

  // Guard the Date construction rather than trusting a field the ATS controls —
  // same rule as `safeIso`/`epochToIso`, after an out-of-range value in
  // zappyhire.ts threw RangeError and evicted every board on that platform.
  if (!Number.isFinite(days) || days < 0 || days > 3650) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Results come back newest-first, so capping pages is safe for alerting even
 * though it means we never enumerate the full back catalogue.
 */
export async function list(company: Company): Promise<RawJob[]> {
  // Results come back newest-first across the whole company, so at a large US
  // employer the India roles can sit well beyond the page cap. Running an
  // explicit "India" search alongside the unfiltered sweep surfaces them for a
  // handful of extra requests.
  const [recent, india] = await Promise.all([
    search(company, '', RECENT_MAX_PAGES),
    search(company, 'India', INDIA_MAX_PAGES),
  ]);

  const byId = new Map(recent.map((job) => [job.externalId, job]));
  for (const job of india) byId.set(job.externalId, job);
  return [...byId.values()];
}

async function search(company: Company, searchText: string, maxPages: number): Promise<RawJob[]> {
  const endpoint = `${base(company)}/wday/cxs/${company.token}/${company.site}/jobs`;
  const jobs: RawJob[] = [];

  // Workday reports the real total only on the first request — every later page
  // comes back with `"total": 0` while still returning results. Trusting it per
  // page silently caps every board at 40 jobs.
  let total = 0;

  for (let page = 0; page < maxPages; page++) {
    const data = await getJson<{ total?: number; jobPostings?: WdPosting[] }>(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchText }),
    });

    if (page === 0) total = data.total ?? 0;

    const postings = data.jobPostings ?? [];
    if (postings.length === 0) break;

    for (const p of postings) {
      jobs.push({
        externalId: p.bulletFields?.[0] ?? p.externalPath,
        title: p.title,
        location: p.locationsText ?? '',
        url: `${base(company)}/en-US/${company.site}${p.externalPath}`,
        postedAt: parsePostedOn(p.postedOn),
      });
    }

    // A short page is the reliable end-of-results signal; `total` is only a
    // shortcut for boards small enough to finish early.
    if (postings.length < PAGE_SIZE) break;
    if (total > 0 && (page + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}

interface JobPostingInfo {
  jobDescription?: string;
  location?: string;
  additionalLocations?: string[];
}

/**
 * Shared by `enrich()` and `resolvePlaceholderLocations()` — same endpoint,
 * different fields.
 *
 * `path` already starts with `/job/...` (that's how `externalPath` comes
 * back from the list endpoint, and `job.url` is built by concatenating it
 * onto the site path in `search()` below) — a long-standing bug here
 * appended a second literal `/job`, producing `.../job/job/{location}/{req}`
 * and a 422 from Workday on every single detail call. Invisible until now:
 * `enrich()` swallows a failed fetch into `undefined` and a missing
 * description just ships silently, so nothing ever errored loudly. Found
 * only because `resolvePlaceholderLocations` actually needs the call to
 * succeed to do anything at all — confirmed live against a real posting
 * (200 with the fix, 422 without) before trusting the diagnosis.
 */
async function fetchDetail(company: Company, job: { url: string }): Promise<JobPostingInfo | undefined> {
  const path = job.url.split(`/${company.site}`)[1];
  if (!path) return undefined;
  const res = await fetch(
    `${base(company)}/wday/cxs/${company.token}/${company.site}${path}`,
    { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) return undefined;
  const data = (await res.json()) as { jobPostingInfo?: JobPostingInfo };
  return data.jobPostingInfo;
}

export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const html = (await fetchDetail(company, job))?.jobDescription;
  return html ? toPlainText(html) : undefined;
}

/**
 * Workday renders a multi-location posting's list view as a bare count —
 * "6 Locations" — with no place names at all. Measured 2026-09-04 across 907
 * hot boards: 22,398 of 164,389 live jobs (13.6%) carry this placeholder, so a
 * Bangalore role posted alongside five other offices is silently invisible to
 * `locationMatches`, which has nothing to match against.
 */
export function isPlaceholderLocation(location: string): boolean {
  return /\d+\s+locations?/i.test(location);
}

/**
 * Resolves placeholder locations to the real list (`location` +
 * `additionalLocations`, same shape open-jobs' detail fetch uses), one
 * detail request per unresolved posting.
 *
 * Not a runtime fallback baked into `list()` — a requisition's location list
 * doesn't change over its lifetime, so `cache` (id -> resolved location,
 * persisted by the caller across runs) makes this a one-time cost per
 * posting rather than paid on every poll. `maxNew` bounds how many
 * previously-unseen placeholders one call resolves, so a board with hundreds
 * of them (large multi-site employers are the common case) can't balloon its
 * own turn inside the shared per-pod concurrency slot; the rest catch up over
 * following runs. Failures are silent and permanent-cache-free by design —
 * the placeholder text stays, and the next run tries again.
 */
export async function resolvePlaceholderLocations(
  company: Company,
  jobs: RawJob[],
  cache: Record<string, string>,
  maxNew: number,
): Promise<void> {
  let resolved = 0;
  for (const job of jobs) {
    if (!isPlaceholderLocation(job.location)) continue;
    const key = `${company.token}:${job.externalId}`;
    const cached = cache[key];
    if (cached !== undefined) {
      job.location = cached;
      continue;
    }
    if (resolved >= maxNew) continue;
    resolved++;
    try {
      const info = await fetchDetail(company, job);
      const real = info?.location ? [info.location, ...(info.additionalLocations ?? [])].join(', ') : undefined;
      if (real) {
        job.location = real;
        cache[key] = real;
      }
    } catch {
      /* leave the placeholder text; try again next run */
    }
  }
}
