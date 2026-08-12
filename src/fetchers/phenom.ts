import type { Company, RawJob } from '../types.js';
import { toPlainText, UA } from './util.js';

interface PhenomJob {
  jobId?: string;
  reqId?: string;
  jobSeqNo?: string;
  title: string;
  city?: string;
  state?: string;
  country?: string;
  location?: string;
  multi_location?: string[];
  cityStateCountry?: string;
  RemoteType?: string;
  applyUrl?: string;
  postedDate?: string;
  dateCreated?: string;
  type?: string;
  department?: string;
  category?: string;
  descriptionTeaser?: string;
  ml_skills?: string[];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 8;

/**
 * Phenom People powers the careers site of a lot of large enterprises — Cisco,
 * eBay, Splunk, Yelp, Philips, Fiserv among them. Every deployment exposes the
 * same undocumented `POST /widgets` endpoint on the company's own careers
 * domain, which is why one adapter covers all of them.
 *
 * `token` here is the careers hostname, e.g. "careers.cisco.com", because there
 * is no tenant slug — the domain *is* the tenant.
 *
 * We query the India facet directly rather than paging the global corpus, which
 * runs to tens of thousands of postings at companies this size.
 */
async function page(company: Company, from: number): Promise<{ jobs: PhenomJob[]; total: number }> {
  const res = await fetch(`https://${company.token}/widgets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      lang: 'en_us',
      deviceType: 'desktop',
      country: 'in',
      pageName: 'search-results',
      ddoKey: 'refineSearch',
      from,
      size: PAGE_SIZE,
      jobs: true,
      counts: true,
      clearAll: false,
      jdsource: 'facets',
      pageId: 'page11',
      siteType: 'external',
      keywords: '',
      global: true,
      selected_fields: { country: ['India'] },
      locationData: {},
    }),
  });

  if (!res.ok) throw new Error(`phenom ${company.token} ${res.status}`);
  const body = (await res.json()) as {
    refineSearch?: { totalHits?: number; data?: { jobs?: PhenomJob[] } };
  };
  return {
    jobs: body.refineSearch?.data?.jobs ?? [],
    total: body.refineSearch?.totalHits ?? 0,
  };
}

function place(job: PhenomJob): string {
  if (job.multi_location?.length) return job.multi_location.join(', ');
  const parts = [job.city, job.state, job.country].filter(Boolean);
  const base = parts.length ? parts.join(', ') : (job.cityStateCountry ?? job.location ?? '');
  return job.RemoteType && /remote/i.test(job.RemoteType) ? `${base} · Remote` : base;
}

export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let total = 0;

  for (let index = 0; index < MAX_PAGES; index++) {
    const { jobs: batch, total: hits } = await page(company, index * PAGE_SIZE);
    if (index === 0) total = hits;
    if (batch.length === 0) break;

    for (const job of batch) {
      const id = job.jobId ?? job.reqId ?? job.jobSeqNo;
      if (!id) continue;
      jobs.push({
        externalId: String(id),
        title: job.title,
        location: place(job),
        url: job.applyUrl ?? `https://${company.token}`,
        postedAt: job.postedDate ?? job.dateCreated,
        text: toPlainText(
          [job.type, job.department, job.category, job.descriptionTeaser, ...(job.ml_skills ?? [])]
            .filter(Boolean)
            .join(' '),
        ),
      });
    }

    if ((index + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}
