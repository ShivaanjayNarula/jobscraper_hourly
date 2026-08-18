import type { Company, RawJob } from '../types.js';
import { getJson } from './util.js';

interface PyjamaJob {
  id: number;
  slug: string;
  title: string;
  min_experience?: number;
  max_experience?: number;
  country?: string;
  location?: string;
  workplace_type?: string;
}

const MAX_PAGES = 20;

/**
 * PyjamaHR — a free-tier Indian ATS, 4,700+ mostly-SMB customers.
 * `token` is the company slug from the board URL,
 * e.g. "born-west-private-limited" in jobs.pyjamahr.com/born-west-private-limited.
 *
 * The list payload carries structured min/max experience in years but no
 * description or posted date — the detail endpoint needs a per-company
 * `company_uuid` that isn't derivable from the slug, so this adapter skips
 * it rather than requiring a second manually-captured config value.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let url: string | undefined =
    `https://api.pyjamahr.com/api/career/jobs/?company_slug=${company.token}&is_careers_page=true`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const data: { results?: PyjamaJob[]; next?: string | null } = await getJson(url);
    const batch = data.results ?? [];
    if (batch.length === 0) break;

    for (const job of batch) {
      const years =
        job.min_experience !== undefined && job.max_experience !== undefined
          ? `${job.min_experience}-${job.max_experience} years`
          : '';

      jobs.push({
        externalId: String(job.id),
        title: job.title,
        location: [job.location ?? job.country, job.workplace_type].filter(Boolean).join(' · '),
        url: `https://jobs.pyjamahr.com/${company.token}/${job.slug}`,
        text: years,
      });
    }

    url = data.next ?? undefined;
  }

  return jobs;
}
