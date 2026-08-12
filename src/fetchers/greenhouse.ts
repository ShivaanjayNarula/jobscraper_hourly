import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  content?: string;
}

/**
 * Deliberately fetched WITHOUT `?content=true`. Descriptions roughly 20x the
 * payload, and we only need them for jobs that turn out to be new — see enrich().
 */
export async function list(company: Company): Promise<RawJob[]> {
  const data = await getJson<{ jobs?: GhJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs`,
  );
  return (data.jobs ?? []).map((j) => ({
    externalId: String(j.id),
    title: j.title,
    location: j.location?.name ?? '',
    url: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at,
  }));
}

export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const data = await getJson<GhJob>(
    `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs/${job.externalId}`,
  );
  return data.content ? toPlainText(data.content) : undefined;
}
