import type { Company, RawJob } from '../types.js';
import { UA, getJson, toPlainText } from './util.js';

interface IcimsJobData {
  slug: string;
  req_id?: string;
  title: string;
  description?: string;
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  full_location?: string;
  posted_date?: string;
  apply_url?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * iCIMS — a US enterprise ATS. `token` holds the full host, since iCIMS runs on
 * either the customer's own custom domain (careers.docusign.com) or a
 * `{region}careers-{company}.icims.com` host.
 *
 * There are two genuinely different tenant shapes and this adapter reads both,
 * the same way `successfactors.ts` carries its modern and legacy paths:
 *
 * - **Legacy** tenants serve a JSON `/api/jobs` endpoint. This is the path this
 *   adapter has always had, and DocuSign is one.
 * - **Modern** "Talent Cloud" tenants 404 on that endpoint entirely, which is
 *   why iCIMS was written off as unreachable. That conclusion was too broad: a
 *   12-tenant sample came back 0/12 on `/api/jobs`, but all 12 serve a
 *   **server-rendered** search page. The company's public careers page embeds
 *   the portal in an iframe, and fetching that iframe URL directly
 *   (`/jobs/search?in_iframe=1`) returns the job rows as plain HTML — no
 *   headless browser, no JSON-LD scraping of detail pages, no credential.
 *
 * Legacy is tried first because its failure is *definitive*: a 404 there means
 * "not a legacy tenant". Detecting the modern shape first would mean treating
 * "zero rows parsed" as the signal, which is indistinguishable from a real
 * board with nothing open.
 *
 * **These postings carry no date.** The search page exposes no posted date on
 * any tenant sampled, and the detail page's JSON-LD `datePosted` cannot help:
 * `index.ts` only calls `enrich()` after the freshness gate has already run.
 * So modern iCIMS roles are always treated as fresh, which is the deliberate
 * behaviour `config.ts`'s EMAIL_FRESHNESS_DAYS comment describes for an ATS
 * that exposes no date at all. Flagged here rather than left to be discovered:
 * this is the same shape as the Workday `parsePostedOn` bug, and if iCIMS ever
 * grows past a handful of boards it is worth re-checking whether a date column
 * can be turned on per tenant.
 */
async function listLegacy(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson<{
      jobs?: { data: IcimsJobData }[];
      totalCount?: number;
    }>(`https://${company.token}/api/jobs?limit=${PAGE_SIZE}&page=${page}`);

    if (page === 1) total = data.totalCount ?? 0;
    const batch = data.jobs ?? [];
    if (batch.length === 0) break;

    for (const { data: job } of batch) {
      jobs.push({
        externalId: job.req_id ?? job.slug,
        title: job.title,
        location:
          job.full_location ?? [job.city, job.state, job.country].filter(Boolean).join(', '),
        url: job.apply_url ?? `https://${company.token}/jobs/${job.slug}`,
        postedAt: job.posted_date,
        text: toPlainText(job.description ?? '').slice(0, 6000),
      });
    }

    if (jobs.length >= total) break;
  }

  return jobs;
}

const PORTAL_TIMEOUT_MS = 30_000;
/** Page size is tenant-configured (20 and 50 both observed), so the walk is
 *  bounded by the portal's own "Page X of Y" rather than by a row count. */
const PORTAL_MAX_PAGES = 20;

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/**
 * The label on the location field is tenant-configured — "Location" and "Job
 * Locations" both occur in a two-tenant sample — so this matches any
 * `field-label` whose text contains "Location" rather than one exact string.
 */
const LOCATION = /field-label">[^<]*Location[^<]*<\/span>\s*<span[^>]*>([^<]*)<\/span>/i;
/**
 * Fallback for the two cases the label match cannot cover, both real in a
 * 40-tenant sample: a tenant that puts the location only in its
 * `additionalFields` block, and a tenant whose labels are localized — one
 * Italian board labels it "Sedi di lavoro", which no English pattern reaches.
 *
 * The map-marker glyphicon is the language-independent part. iCIMS attaches it
 * to exactly the location fields, so the icon identifies them where the text
 * cannot. Matching on position instead would be wrong: on some tenants the
 * first header field is "Client Team" or "Vehicle Information".
 */
const MAP_MARKER = 'glyphicons-map-marker';
const HEADER_DATA = /iCIMS_JobHeaderData"><span[^>]*>([^<]*)</;

function locationFromHeaderTags(row: string): string {
  const values: string[] = [];
  for (const tag of row.split('iCIMS_JobHeaderTag').slice(1)) {
    if (!tag.includes(MAP_MARKER)) continue;
    const value = HEADER_DATA.exec(tag)?.[1]?.trim();
    if (value) values.push(value);
  }
  return [...new Set(values)].join(', ');
}
const JOB_HREF = /\/jobs\/(\d+)\/([^/"?]+)\/job/;
const TITLE = /<h3[^>]*>([\s\S]*?)<\/h3>/;
/** Some tenants inline the summary in the listing; those need no enrich call. */
const DESCRIPTION = /<div class="col-xs-12 description">([\s\S]*?)<\/div>/;

export function pageCount(html: string): number {
  const m = /Page\s+\d+\s+of\s+(\d+)/i.exec(html.replace(/<[^>]+>/g, ' '));
  const pages = m ? Number(m[1]) : 1;
  return Number.isFinite(pages) && pages > 0 ? pages : 1;
}

/**
 * iCIMS writes a location as `COUNTRY-STATE-CITY`, e.g. "US-GA-Douglas". The
 * country code alone is not something `config.ts`'s INDIA regex can match, so a
 * board listing "IN-Remote" would be dropped even though it is an India role.
 * Appending the country name when the *leading* segment is `IN` fixes that.
 *
 * Only the leading segment, and that matters: "US-IN-Indianapolis" has IN in
 * the state slot and is Indiana, not India. Expanding that one would put US
 * roles into an India-only alert, which is the exact false positive this
 * project cares most about avoiding.
 */
export function normalizeLocation(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  return /^IN-/i.test(value) ? `${value}, India` : value;
}

export function parsePortal(html: string, host: string): RawJob[] {
  const jobs: RawJob[] = [];

  // Split on the card marker rather than matching a balanced <li>: the row
  // contains nested lists and definition lists, and a lazy <li>...</li> match
  // truncates at the first inner close tag.
  for (const row of html.split('iCIMS_JobCardItem').slice(1)) {
    const href = JOB_HREF.exec(row);
    const title = TITLE.exec(row);
    if (!href || !title) continue;

    const text = DESCRIPTION.exec(row)?.[1];
    jobs.push({
      externalId: href[1]!,
      title: toPlainText(title[1]!),
      location: normalizeLocation(
        toPlainText(LOCATION.exec(row)?.[1] ?? '') || locationFromHeaderTags(row),
      ),
      url: `https://${host}/jobs/${href[1]}/${href[2]}/job`,
      text: text ? toPlainText(text).slice(0, 6000) : undefined,
    });
  }

  return jobs;
}

async function listPortal(company: Company): Promise<RawJob[]> {
  const base = `https://${company.token}/jobs/search?in_iframe=1`;
  const first = await fetchHtml(base);
  const jobs = parsePortal(first, company.token);
  const pages = Math.min(pageCount(first), PORTAL_MAX_PAGES);

  // `pr` is zero-indexed: the bare URL is page 1, `pr=1` is page 2.
  for (let page = 1; page < pages; page++) {
    const batch = parsePortal(await fetchHtml(`${base}&pr=${page}`), company.token);
    if (batch.length === 0) break;
    jobs.push(...batch);
  }

  return jobs;
}

export async function list(company: Company): Promise<RawJob[]> {
  try {
    const legacy = await listLegacy(company);
    if (legacy.length > 0) return legacy;
  } catch {
    // Not a legacy tenant, or its API is down — either way the portal is the
    // only other shape worth trying. If it fails too, its error propagates,
    // which is what should drive the eviction clock.
  }
  return listPortal(company);
}

/**
 * Only reached for a posting whose listing row carried no inline summary. The
 * detail page embeds a full schema.org JobPosting, which is a cleaner source
 * for the description than scraping the rendered body.
 */
export async function enrich(_company: Company, job: RawJob): Promise<string | undefined> {
  const html = await fetchHtml(`${job.url}?in_iframe=1`);
  const block = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!block) return undefined;

  try {
    const posting = JSON.parse(block[1]!) as { description?: string };
    return posting.description ? toPlainText(posting.description).slice(0, 6000) : undefined;
  } catch {
    return undefined;
  }
}
