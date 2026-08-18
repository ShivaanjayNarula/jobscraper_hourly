import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface ZappyHit {
  _id: string;
  _source: { job: number | string; title: string; location?: string };
  sort?: number[];
}

const MAX_PAGES = 20;

/** Elasticsearch sorts missing dates to a sentinel far outside JS Date's valid range. */
function epochToIso(ms: number | undefined): string | undefined {
  if (!ms || Math.abs(ms) > 8_640_000_000_000_000) return undefined;
  return new Date(ms).toISOString();
}

function base(company: Company): string {
  return `https://${company.token}.zappyhire-multitenant-be-prod.zappyhire.com`;
}

/**
 * Zappyhire — an Indian (Kochi) AI recruitment platform, 1,600+ clients.
 * `token` is the tenant path segment from the board URL,
 * e.g. "wuerth" in recruitcareers.zappyhire.com/wuerth.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson<{ results?: { hits?: ZappyHit[] } }>(
      `${base(company)}/api/jobs/jobsearch/?page=${page}`,
    );
    const hits = data.results?.hits ?? [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      jobs.push({
        externalId: String(hit._source.job ?? hit._id),
        title: hit._source.title,
        location: hit._source.location ?? '',
        url: `https://recruitcareers.zappyhire.com/${company.token}`,
        postedAt: epochToIso(hit.sort?.[0]),
      });
    }
  }

  return jobs;
}

export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const data = await getJson<{ results?: { description?: string } }>(
    `${base(company)}/api/careers/jobs/${job.externalId}/`,
  );
  const html = data.results?.description;
  return html ? toPlainText(html).slice(0, 6000) : undefined;
}
