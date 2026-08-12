import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText, UA } from './util.js';

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

const PAGE_SIZE = 20; // Workday caps `limit` at 20 regardless of what you ask for.
const MAX_PAGES = 15; // ~300 newest roles per board; see note below.

function base(company: Company): string {
  return `https://${company.token}.${company.host}.myworkdayjobs.com`;
}

/**
 * Workday's list view returns relative dates ("Posted Today") and no absolute
 * timestamp — which is fine, because we detect new roles by requisition ID, not
 * by date. Results come back newest-first, so capping pages is safe for alerting
 * even though it means we never enumerate the full back catalogue.
 */
export async function list(company: Company): Promise<RawJob[]> {
  // Results come back newest-first across the whole company, so at a large US
  // employer the India roles can sit well beyond the page cap. Running an
  // explicit "India" search alongside the unfiltered sweep surfaces them for a
  // handful of extra requests.
  const [recent, india] = await Promise.all([search(company, ''), search(company, 'India')]);

  const byId = new Map(recent.map((job) => [job.externalId, job]));
  for (const job of india) byId.set(job.externalId, job);
  return [...byId.values()];
}

async function search(company: Company, searchText: string): Promise<RawJob[]> {
  const endpoint = `${base(company)}/wday/cxs/${company.token}/${company.site}/jobs`;
  const jobs: RawJob[] = [];

  // Workday reports the real total only on the first request — every later page
  // comes back with `"total": 0` while still returning results. Trusting it per
  // page silently caps every board at 40 jobs.
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<{ total?: number; jobPostings?: WdPosting[] }>(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchText }),
    });

    if (page === 0) total = data.total ?? 0;

    const postings = data.jobPostings ?? [];
    if (postings.length === 0) break;

    for (const p of postings) {
      jobs.push({
        externalId: p.bulletFields?.[0] ?? p.externalPath,
        title: p.title,
        location: p.locationsText ?? '',
        url: `${base(company)}/en-US/${company.site}${p.externalPath}`,
        postedAt: p.postedOn,
      });
    }

    // A short page is the reliable end-of-results signal; `total` is only a
    // shortcut for boards small enough to finish early.
    if (postings.length < PAGE_SIZE) break;
    if (total > 0 && (page + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}

export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const path = job.url.split(`/${company.site}`)[1];
  if (!path) return undefined;
  const res = await fetch(
    `${base(company)}/wday/cxs/${company.token}/${company.site}/job${path}`,
    { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) return undefined;
  const data = (await res.json()) as { jobPostingInfo?: { jobDescription?: string } };
  const html = data.jobPostingInfo?.jobDescription;
  return html ? toPlainText(html) : undefined;
}
