import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface PsJob {
  jobTitle?: string;
  designation?: string;
  jobCode: string;
  requisitionId: number | string;
  jobPostedDate?: string;
  locationHierarchyComplete?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 40; // covers boards up to 4,000 jobs (Aditya Birla is ~2,468)

/**
 * PeopleStrong — an Asia-Pacific HCM platform with a public "Candidate
 * Portal" product. One base API path fits every tenant. `token` is the
 * tenant subdomain, e.g. "abgcareers" (Aditya Birla Group).
 */
function base(company: Company): string {
  return `https://${company.token}.peoplestrong.com/api/cp/rest/altone/cp/`;
}

export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const data = await getJson<{ totalRecords?: number; response?: PsJob[] }>(
      `${base(company)}jobs/v1?offset=${offset}&limit=${PAGE_SIZE}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );

    if (page === 0) total = data.totalRecords ?? 0;
    const batch = data.response ?? [];
    if (batch.length === 0) break;

    for (const job of batch) {
      jobs.push({
        externalId: String(job.requisitionId),
        title: job.jobTitle ?? job.designation ?? 'Untitled',
        location: job.locationHierarchyComplete ?? '',
        url: `https://${company.token}.peoplestrong.com/job/detail/${job.jobCode}`,
        postedAt: job.jobPostedDate,
      });
    }

    if (jobs.length >= total) break;
  }

  return jobs;
}

/** Note the typo "descriprion" — it's spelled that way in PeopleStrong's own API. */
export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const url =
    `${base(company)}job/${job.externalId}/v2` +
    `?part=basic,organisational,descriprion,workflow,skill,qualification,certification,language&isReqId=true`;
  const data = await getJson<{ response?: { jobDescription?: string } }>(url);
  const html = data.response?.jobDescription;
  return html ? toPlainText(html).slice(0, 6000) : undefined;
}
