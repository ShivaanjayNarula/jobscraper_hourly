import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface EightfoldPosition {
  id: number | string;
  displayJobId?: string;
  atsJobId?: string;
  name: string;
  locations?: string[];
  standardizedLocations?: string[];
  workLocationOption?: string;
  locationFlexibility?: string;
  department?: string;
  postedTs?: number;
  creationTs?: number;
  positionUrl?: string;
  job_description?: string;
}

/** The endpoint returns 10 per call and ignores any `num` you pass. */
const PAGE_SIZE = 10;
// Same clipping bug as Workday's old 300 cap, found the same way: measured
// 2026-08-18, Qualcomm's real India total is 572 (`data.count`), but 300 was
// silently dropping 272 of them - the endpoint's `total` was never wrong,
// nothing was reading past page 30 to see it. 100 pages (1,000 roles) covers
// it with headroom; the loop already stops early once `total` is reached, so
// raising this doesn't add requests for smaller boards.
const MAX_PAGES = 100;

/**
 * Same bug class Zappyhire shipped once: a sort/rank field with no real date
 * can hold a sentinel far outside JS Date's ±8,640,000,000,000,000ms range,
 * and `new Date()` throws RangeError rather than returning an invalid date.
 * Never trust an ATS's own numeric field to be in range without checking.
 */
export function epochToIso(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined;
  const ms = seconds * 1000;
  return Math.abs(ms) > 8_640_000_000_000_000 ? undefined : new Date(ms).toISOString();
}

/**
 * Eightfold AI ("pcsx") powers Microsoft's careers site and a number of other
 * large employers. The search endpoint is unauthenticated and takes a `domain`
 * parameter identifying the tenant.
 *
 *   token -> the careers host, e.g. "apply.careers.microsoft.com"
 *   site  -> the tenant domain, e.g. "microsoft.com"
 *
 * Queried against India directly; the global corpus runs to tens of thousands.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `https://${company.token}/api/pcsx/search?domain=${company.site}` +
      `&query=&location=India&start=${page * PAGE_SIZE}&num=${PAGE_SIZE}`;

    const body = await getJson<{ data?: { positions?: EightfoldPosition[]; count?: number } }>(url);
    const positions = body.data?.positions ?? [];
    if (positions.length === 0) break;
    const total = body.data?.count ?? 0;

    for (const position of positions) {
      const where = position.standardizedLocations?.length
        ? position.standardizedLocations
        : (position.locations ?? []);
      const remote = [position.workLocationOption, position.locationFlexibility]
        .filter((value) => value && /remote/i.test(value))
        .join(' ');

      jobs.push({
        externalId: String(position.displayJobId ?? position.atsJobId ?? position.id),
        title: position.name,
        location: [where.join(', '), remote].filter(Boolean).join(' · '),
        url: position.positionUrl?.startsWith('http')
          ? position.positionUrl
          : `https://${company.token}${position.positionUrl ?? `/global/en/job/${position.id}`}`,
        postedAt: epochToIso(position.postedTs),
        text: toPlainText([position.department, position.job_description ?? ''].join(' ')),
      });
    }

    if (positions.length < PAGE_SIZE) break;
    if (total > 0 && (page + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}
