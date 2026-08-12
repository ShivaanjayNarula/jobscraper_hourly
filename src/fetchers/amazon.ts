import type { Company, RawJob } from '../types.js';
import { getJson } from './util.js';

interface AmazonJob {
  id_icims: string;
  title: string;
  location?: string;
  city?: string;
  country_code?: string;
  job_path: string;
  posted_date?: string;
  basic_qualifications?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * Amazon runs its own search API rather than a hosted ATS. We query India
 * directly instead of pulling the global feed — the unfiltered corpus caps out
 * at 10,000 hits and would be almost entirely US roles.
 */
const QUERIES = [
  'https://www.amazon.jobs/en/search.json?loc_query=India&country=IND',
  'https://www.amazon.jobs/en/search.json?loc_query=Remote&base_query=remote',
];

export async function list(_company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];

  for (const query of QUERIES) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await getJson<{ hits?: number; jobs?: AmazonJob[] }>(
        `${query}&result_limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=recent`,
      );
      const batch = data.jobs ?? [];
      if (batch.length === 0) break;

      for (const j of batch) {
        jobs.push({
          externalId: j.id_icims,
          title: j.title,
          location: j.location ?? [j.city, j.country_code].filter(Boolean).join(', '),
          url: `https://www.amazon.jobs${j.job_path}`,
          postedAt: j.posted_date,
          text: j.basic_qualifications,
        });
      }

      if ((page + 1) * PAGE_SIZE >= (data.hits ?? 0)) break;
    }
  }

  return jobs;
}
