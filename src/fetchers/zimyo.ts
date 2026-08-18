import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface ZimyoJob {
  JOB_ID: number | string;
  JOB_TITLE: string;
  CREATED_ON?: string;
  STREET_ADDRESS?: string;
  TOTAL_EXPERIENCE?: string;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

/**
 * Zimyo — an Indian HCM with an ATS widget. `token` is the numeric org_id
 * from the company's career-page embed URL (opaque, base64-encoded there —
 * decode it once when adding a company, e.g. Zimyo's own org_id is "1").
 */
export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson<{ data?: { result?: ZimyoJob[]; totalCount?: number } }>(
      `https://ats.zimyo.work/ats/ats/widget/joblist2?id=${company.token}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const batch = data.data?.result ?? [];
    if (batch.length === 0) break;

    for (const job of batch) {
      jobs.push({
        externalId: String(job.JOB_ID),
        title: job.JOB_TITLE,
        location: job.STREET_ADDRESS ?? '',
        url: `https://ats.zimyo.work/ats/ats/widget/jobDetails?jobId=${job.JOB_ID}`,
        postedAt: job.CREATED_ON,
        text: job.TOTAL_EXPERIENCE ? `${job.TOTAL_EXPERIENCE} years` : undefined,
      });
    }

    if (data.data?.totalCount !== undefined && page * PAGE_SIZE >= data.data.totalCount) break;
  }

  return jobs;
}

export async function enrich(_company: Company, job: RawJob): Promise<string | undefined> {
  const data = await getJson<{ data?: { jobDetail?: { JOB_DESCRIPTION?: string } } }>(
    `https://ats.zimyo.work/ats/ats/widget/jobDetails?jobId=${job.externalId}`,
  );
  const html = data.data?.jobDetail?.JOB_DESCRIPTION;
  return html ? toPlainText(html).slice(0, 6000) : undefined;
}
