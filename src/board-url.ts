import type { Ats, Company, Industry } from './types.js';

/**
 * Turns any job or board URL into a `companies.json` entry.
 *
 * Shared by `detect` (which finds URLs on careers pages) and `import` (which
 * takes them from a list), so the parsing rules live in exactly one place.
 */
export const HOSTED: { ats: Ats; pattern: RegExp }[] = [
  {
    ats: 'greenhouse',
    pattern:
      /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
  },
  { ats: 'lever', pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { ats: 'ashby', pattern: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i },
  { ats: 'smartrecruiters', pattern: /(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/i },
  // These three capture a *subdomain* rather than a path segment, which is why
  // NOT_A_COMPANY below has to cover the vendors' own hostnames: `www` and
  // `app` are real subdomains on all three platforms and would otherwise
  // resolve to a board named "Www".
  { ats: 'keka', pattern: /([a-z0-9-]+)\.keka\.com/i },
  { ats: 'teamtailor', pattern: /([a-z0-9-]+)\.teamtailor\.com/i },
  { ats: 'breezy', pattern: /([a-z0-9-]+)\.breezy\.hr/i },
  { ats: 'personio', pattern: /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i },
  // Taleo Business Edition only. The `org` code is the whole board identity —
  // the pod in the path is routing (any pod serves any org and 302s to the
  // right one) and `cws` is filled in by that redirect. Enterprise Taleo's
  // `careersection` boards are a different product entirely and `taleo.ts`
  // cannot read them; they resolve to null here rather than being imported as
  // boards that could never be fetched.
  { ats: 'taleo', pattern: /tbe\.taleo\.net\/[^"'\s]*?[?&]org=([A-Za-z0-9_-]+)/i },
];

/**
 * Platforms a careers-page scan can recognise but not turn into a ready-to-add
 * `Company` on its own. `NO_ADAPTER` is "this project cannot fetch it at all";
 * `NEEDS_MANUAL_EXTRACTION` is "the adapter exists, but it needs fields (a
 * companyId hash, an org GUID, a whole hostname) that no single regex group on
 * the page can supply". `detect.ts` reports both rather than letting a real
 * board disappear into "no ATS link found".
 *
 * These live here rather than in `detect.ts` so the regression suite can hold
 * them against `FETCHERS` — importing `detect.ts` would run its `main()`.
 * That check exists because this list went stale silently: Keka and iCIMS both
 * sat in `NO_ADAPTER` long after their adapters shipped, so every Keka board a
 * scan found was reported unsupported and dropped. A YC-directory sweep on
 * 2026-09-06 hit five in one run (Peoplebox, Zuddl, Inito, Loop Health,
 * AccioJob); three held 23 live India roles between them. A platform named
 * here that has an adapter is invisible loss, not a warning.
 *
 * Keka now resolves automatically — its token is a bare subdomain, so it is in
 * `HOSTED` above. iCIMS cannot: it keeps the whole hostname as its token.
 *
 * Taleo left this list when `taleo.ts` shipped. Only Business Edition
 * (`tbe.taleo.net`) is covered; enterprise Taleo's `careersection` boards stay
 * unreachable, but they cannot be named here — the check below tests for the
 * platform name as a substring, so listing them would read as "taleo is
 * unsupported" while an adapter exists, which is the exact staleness this
 * regex has twice been guilty of.
 */
export const NO_ADAPTER =
  /jobvite\.com|csod\.com|bamboohr\.com|applytojob\.com|comeet\.co|dayforcehcm\.com|ats\.rippling\.com/i;

/**
 * UKG moved here from `NO_ADAPTER` when `taleo.ts` was wired in — `ukg.ts` has
 * worked since the day it shipped, but the platform's domain (`ultipro.com`)
 * shares no substring with its `FETCHERS` key (`ukg`), so the staleness check
 * below could not see it and every UKG board a scan found was reported
 * unsupported. It needs the manual bucket rather than `HOSTED`: the board GUID
 * in `recruiting.ultipro.com/{tenant}/JobBoard/{guid}` is a second required
 * field that no single capture group on a careers page supplies.
 */
export const NEEDS_MANUAL_EXTRACTION =
  /darwinbox\.[a-z]+|turbohire\.co|successfactors\.[a-z]+|phenompeople\.com|icims\.com|ultipro\.com/i;

export const WORKDAY =
  /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:(?:[a-z]{2}-[A-Za-z]{2})\/)?([A-Za-z0-9_-]+)/i;

/** Oracle tenants sit on regional pods: `{tenant}.fa.{pod}.oraclecloud.com`. */
const ORACLE =
  /https?:\/\/([a-z0-9-]+)\.(fa(?:\.[a-z0-9]+)?)\.oraclecloud\.com[^"'\s]*?(?:siteNumber=|\/sites\/)(CX_[0-9]+)/i;

/** Path segments that are ATS plumbing rather than a company. */
const NOT_A_COMPANY =
  /^(embed|api|v1|assets|static|images|css|js|robots|sitemap|favicon|_next|search|jobs|job|www|app|help|support|blog)$/i;

export function prettify(slug: string): string {
  return slug
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function parseBoardUrl(url: string, industry: Industry = 'tech'): Company | null {
  const workday = WORKDAY.exec(url);
  if (workday) {
    const [, token, host, site] = workday;
    if (!token || !site || host?.startsWith('impl')) return null;
    return {
      name: prettify(token),
      ats: 'workday',
      token,
      host,
      site,
      industry,
      source: 'curated',
    };
  }

  const oracle = ORACLE.exec(url);
  if (oracle) {
    const [, token, host, siteNumber] = oracle;
    return {
      name: prettify(token!),
      ats: 'oracle',
      token: token!,
      host,
      siteNumber,
      industry,
      source: 'curated',
    };
  }

  for (const { ats, pattern } of HOSTED) {
    const match = pattern.exec(url);
    const token = match?.[1];
    if (token && !NOT_A_COMPANY.test(token)) {
      return { name: prettify(token), ats, token, industry, source: 'curated' };
    }
  }

  return null;
}

/**
 * Roster identity: which row in `companies.json` this is.
 *
 * Site-aware, because one tenant can host several genuinely different boards.
 * RTX runs `Private_Posting_No_TMP` and `REC_RTX_Ext_Gateway` with no overlap
 * between their listings, and Deutsche Bank's tenant carries both `DBWebsite`
 * and DWS's `dwswebsite`. Keyed on ats+token alone those collapse into a single
 * key, so an importer silently drops the second one and the run loop cannot
 * tell them apart — which is also how `polledTokens` in index.ts could delete a
 * sibling site that simply wasn't selected for polling this run.
 *
 * NOT job identity. A job id stays `${ats}:${token}:${externalId}` and its
 * tenant prefix stays site-blind: requisition ids are already unique across a
 * tenant's sites, and re-keying them would invalidate every id in seen.json and
 * every entry in the catalogue, re-alerting the whole corpus on the next run.
 */
export function boardKey(company: Company): string {
  return `${company.ats}:${company.token}:${company.site ?? company.siteNumber ?? ''}`.toLowerCase();
}
