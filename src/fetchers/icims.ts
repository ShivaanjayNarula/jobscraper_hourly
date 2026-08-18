import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

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
 * iCIMS — a US enterprise ATS, genuinely rare among Indian employers (a
 * focused search across ~20 large India-GCC employers found only DocuSign
 * and iCIMS's own board). `token` holds the full host, since iCIMS runs on
 * either the customer's own custom domain (careers.docusign.com) or a
 * `{region}careers-{company}.icims.com` host — both work identically on
 * `/api/jobs`.
 */
export async function list(company: Company): Promise<RawJob[]> {
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
