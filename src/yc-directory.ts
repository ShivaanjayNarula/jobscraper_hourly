/**
 * YC's public Startup Directory (ycombinator.com/companies), read the same
 * way the directory page itself does: a client-side query against Algolia.
 * The application id, index name and API key below are shipped in that
 * page's own JS bundle for every visitor — not scraped or brute-forced, and
 * the same technique already backs public projects like yc-oss/api. The key
 * is scoped read-only to the `ycdc_public` tag, so it can only ever see what
 * the directory page itself shows.
 *
 * Built as a leadership-sweep company pool distinct from companies.json:
 * `regions: ['India']` covers "Indian startups", and the directory as a
 * whole — thousands of YC-backed companies, most well outside the ATS
 * platforms this project already tracks as job boards — stands in for
 * "emerging startups" generally. A broader source (Crunchbase, AngelList)
 * would need a paid API or scraping against terms that are far less clearly
 * public than YC's own directory, so it isn't built here.
 */
import { getJson } from './fetchers/util.js';

const APP_ID = '45BWZJ1SGC';
const API_KEY =
  'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';
const INDEX = 'YCCompany_production';
const HITS_PER_PAGE = 1000; // Algolia's own cap for this index; ~5 pages covers the whole directory.

export interface YCCompany {
  name: string;
  website: string;
  batch: string;
  status: string; // 'Active' | 'Inactive' | 'Acquired' | 'Public'
  regions: string[];
}

interface AlgoliaHit {
  name?: string;
  website?: string;
  batch?: string;
  status?: string;
  regions?: string[];
}

interface AlgoliaResponse {
  results: { hits: AlgoliaHit[]; nbPages: number }[];
}

/**
 * `region` filters on Algolia's own facet (e.g. `"India"`); `activeOnly`
 * drops Inactive/Acquired companies, since a defunct startup has nobody left
 * to email.
 */
export async function fetchYCCompanies(opts: { region?: string; activeOnly?: boolean } = {}): Promise<YCCompany[]> {
  const out: YCCompany[] = [];
  for (let page = 0; ; page++) {
    const params = new URLSearchParams({ query: '', hitsPerPage: String(HITS_PER_PAGE), page: String(page) });
    if (opts.region) params.set('facetFilters', JSON.stringify([[`regions:${opts.region}`]]));

    const data = await getJson<AlgoliaResponse>(`https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`, {
      method: 'POST',
      headers: {
        'x-algolia-application-id': APP_ID,
        'x-algolia-api-key': API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requests: [{ indexName: INDEX, params: params.toString() }] }),
    });

    const result = data.results[0];
    if (!result) break;
    for (const hit of result.hits) {
      if (!hit.name || !hit.website) continue;
      if (opts.activeOnly && hit.status !== 'Active') continue;
      out.push({ name: hit.name, website: hit.website, batch: hit.batch ?? '', status: hit.status ?? '', regions: hit.regions ?? [] });
    }
    if (page + 1 >= result.nbPages) break;
  }
  return out;
}

/**
 * The directory stores whatever URL the founders typed, so the scheme, `www.`,
 * a trailing path, a trailing slash and a query string are all inconsistent —
 * `detect` wants a bare hostname.
 *
 * The query string is not hypothetical: 100x's listed website is
 * `https://100x.bot?utm_source=inbound&utm_medium=bookface&...` with no path
 * separator at all, so splitting on "/" alone leaves the whole campaign tail
 * glued to the hostname and `detect` fetches a URL that cannot resolve.
 */
export function bareDomain(website: string): string {
  return website
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]!
    .trim()
    .toLowerCase();
}

/**
 * CLI: print one bare domain per line, in the format `detect.ts` reads.
 *
 *   npx tsx src/yc-directory.ts India > state/yc-india.txt
 *   npm run detect -- state/yc-india.txt
 *
 * This is deliberately a company-discovery step rather than a job source.
 * YC's own public job listing (ycombinator.com/jobs) is a marketing landing
 * page that ships a rotating sample of ~20 postings and reports its total as
 * the literal string "thousands"; the real Work at a Startup search sits
 * behind an account login, so there is no honest way to poll it. But YC
 * companies overwhelmingly run Greenhouse, Lever or Ashby on their own
 * domains — platforms this project already fetches — so routing the directory
 * through `detect` reaches the same jobs through boards we already support,
 * with no new adapter and nothing login-walled.
 */
if (process.argv[1]?.endsWith('yc-directory.ts')) {
  const region = process.argv[2];
  const companies = await fetchYCCompanies({ region, activeOnly: true });
  const seen = new Set<string>();

  console.log(`# ${companies.length} active YC companies${region ? ` in ${region}` : ''}, generated ${new Date().toISOString().slice(0, 10)}`);
  console.log('# npm run detect -- <this file>');
  for (const company of companies) {
    const domain = bareDomain(company.website);
    if (!domain.includes('.') || seen.has(domain)) continue;
    seen.add(domain);
    console.log(domain);
  }
}
