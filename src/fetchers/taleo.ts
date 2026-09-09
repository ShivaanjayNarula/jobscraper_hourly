import type { Company, RawJob } from '../types.js';
import { UA, toPlainText } from './util.js';

/**
 * Taleo Business Edition — Oracle's SMB Taleo, served from `*.tbe.taleo.net`.
 *
 *   token -> the `org` code from the board URL, e.g. "CAREUSA"
 *
 * This is the first adapter in the project that scrapes server-rendered HTML as
 * its only path, and that was the finding that unblocked it: an earlier session
 * wrote Taleo off after assuming it needed a JSON API and failing to find one.
 * There isn't one. The search page server-renders every row into the HTML, so
 * no headless browser and no credential is needed — just a parser.
 *
 * Three things about the platform shape the code below, all measured against
 * live tenants rather than assumed:
 *
 * 1. **The pod in the URL is routing, not identity.** Every published board URL
 *    looks like `https://phg.tbe.taleo.net/phg02/ats/careers/v2/searchResults
 *    ?org=X&cws=N`, but any pod serves any org: TBE 302s to the tenant's real
 *    pod and fills in the right `cws` itself. So the org code alone is a
 *    complete board identity, and neither the pod nor `cws` is stored.
 * 2. **Paging is session-stateful.** Results come 10 at a time (no page-size
 *    parameter works — `rowMax`, `rowsPerPage`, `maxRows` and `pageSize` were
 *    all tried against a live board and all returned 10). The "next" link is a
 *    `rowFrom` cursor that only resolves inside the JSESSIONID the first
 *    response set; without the cookie it returns an empty body, which would
 *    read as "board has exactly 10 jobs" on every board.
 * 3. **A dead tenant answers 200, not 404** — with either the TBE recruiter
 *    login page or an Oracle "Come Back Soon" page. Both are the Personio-307
 *    trap: a successful fetch of the wrong page reads as a live board with
 *    nothing open, so the board never fails and never gets evicted. The
 *    `oracletaleocwsv2` marker (present on every real results page, absent from
 *    both error pages) is what keeps a dead tenant failing loudly.
 *
 * Postings carry no date on the search page, so `postedAt` is always undefined
 * and these roles are always treated as fresh — the same deliberate trade as
 * modern iCIMS, documented on `config.ts`'s EMAIL_FRESHNESS_DAYS.
 */

/** Any pod works as an entry point; TBE redirects to the tenant's own. */
const ENTRY_POD = 'https://phg.tbe.taleo.net/phg02/ats/careers/v2/searchResults';
const TIMEOUT_MS = 30_000;
/** 10 rows per page is fixed by the platform. TBE is an SMB product — the
 *  largest tenant sampled held ~200 roles — so this caps a board at 500 rather
 *  than being a limit anything real is expected to hit. If a board ever lands
 *  exactly on it, that is the Workday-300 clipping signature and the cap is the
 *  bug, not the board. */
const MAX_PAGES = 50;
/** Present on every real results page; absent from both TBE error pages. */
const LIVE_MARKER = 'oracletaleocwsv2';

interface Page {
  html: string;
  /** Absolute, post-redirect — the "next" href is root-relative to this. */
  url: string;
}

async function fetchPage(url: string, cookie?: string): Promise<Page & { cookie: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return {
    html: await res.text(),
    url: res.url,
    cookie: cookie ?? res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
  };
}

/**
 * Which of a row's columns hold the location — read from the board's own sort
 * dropdown, never assumed by position.
 *
 * TBE lets each tenant choose its result columns, and they genuinely differ:
 * `Title | Department | Work Location | Search Country`, `Title | City |
 * State/Territory | ZIP`, `Title | Employment duration | City | State`, and
 * `Title | Job Category` (no location at all) are all real, from a six-tenant
 * sample. Reading the third column as the location would give one board a
 * department, another a ZIP code, and a third nothing — the same trap
 * `icims.ts` documents for header fields.
 *
 * Column 0 is always the title (the `<h4>`), so a label at column N is the
 * row's Nth-1 `<div>`.
 *
 * "Country" is a fallback rather than a match, deliberately: CARE USA's
 * `Search Country` lists every country a role can be applied from — six of
 * them on a Manila posting. Folding that into the location would put a US role
 * into an India-only alert the moment one such list mentions India, which is
 * the false positive this project cares most about avoiding.
 */
const PLACE_COLUMN = /\b(location|city|state|province|region)\b/i;
const COUNTRY_COLUMN = /\bcountry\b/i;
const SORT_OPTION = /sortColumn=(\d+)"[^>]*>([^<]*)</g;

export function locationColumns(html: string): number[] {
  const labels = new Map<number, string>();
  for (const [, index, label] of html.matchAll(SORT_OPTION)) {
    const column = Number(index);
    if (!labels.has(column)) labels.set(column, toPlainText(label ?? ''));
  }

  const pick = (pattern: RegExp) =>
    [...labels.entries()]
      .filter(([column, label]) => column > 0 && pattern.test(label))
      .map(([column]) => column - 1)
      .sort((a, b) => a - b);

  const places = pick(PLACE_COLUMN);
  return places.length > 0 ? places : pick(COUNTRY_COLUMN);
}

const ROW_TITLE = /head-title"><a href="([^"]*[?&]rid=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/;
const ROW_FIELD = /<div tabindex="0"[^>]*>([\s\S]*?)<\/div>/g;

export function parseRows(html: string, columns: number[]): RawJob[] {
  const jobs: RawJob[] = [];

  for (const row of html.split('oracletaleocwsv2-accordion-head-info').slice(1)) {
    const head = ROW_TITLE.exec(row);
    if (!head) continue;

    const fields = [...row.matchAll(ROW_FIELD)].map((m) => toPlainText(m[1] ?? ''));
    jobs.push({
      externalId: head[2]!,
      title: toPlainText(head[3]!),
      location: columns
        .map((column) => fields[column])
        .filter(Boolean)
        .join(', '),
      url: head[1]!,
    });
  }

  return jobs;
}

const NEXT_PAGE = /<a href="([^"]+)" class="jscroll-next"/;

export async function list(company: Company): Promise<RawJob[]> {
  const first = await fetchPage(`${ENTRY_POD}?org=${encodeURIComponent(company.token)}`);
  if (!first.html.includes(LIVE_MARKER)) {
    throw new Error(`taleo:${company.token} is not a live board (TBE served an error page)`);
  }

  const columns = locationColumns(first.html);
  const jobs = parseRows(first.html, columns);

  let page = first;
  for (let count = 1; count < MAX_PAGES; count++) {
    const next = NEXT_PAGE.exec(page.html);
    if (!next) break;

    page = await fetchPage(new URL(next[1]!, page.url).toString(), first.cookie);
    const batch = parseRows(page.html, columns);
    if (batch.length === 0) break;
    jobs.push(...batch);
  }

  return jobs;
}

/**
 * The listing carries no description, but the requisition page embeds a full
 * schema.org JobPosting — cleaner than scraping its rendered body, and the
 * same shape `icims.ts` reads.
 */
export async function enrich(_company: Company, job: RawJob): Promise<string | undefined> {
  const { html } = await fetchPage(job.url);
  const block = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!block) return undefined;

  try {
    const posting = JSON.parse(block[1]!) as { description?: string };
    return posting.description ? toPlainText(posting.description).slice(0, 6000) : undefined;
  } catch {
    return undefined;
  }
}
