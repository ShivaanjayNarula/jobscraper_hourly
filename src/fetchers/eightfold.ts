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
const MAX_PAGES = 30;

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
        url:
          position.positionUrl ??
          `https://${company.token}/global/en/job/${position.id}`,
        postedAt: position.postedTs
          ? new Date(position.postedTs * 1000).toISOString()
          : undefined,
        text: toPlainText([position.department, position.job_description ?? ''].join(' ')),
      });
    }

    if (positions.length < PAGE_SIZE) break;
    if (total > 0 && (page + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}
