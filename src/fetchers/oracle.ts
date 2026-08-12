import type { Company, RawJob } from '../types.js';
import { getJson } from './util.js';

interface OracleReq {
  Id: string;
  Title: string;
  PrimaryLocation?: string;
  PostedDate?: string;
  ShortDescriptionStr?: string;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/**
 * Oracle Cloud HCM — the ATS behind JPMorgan and a lot of large enterprises.
 * The tenant is opaque (JPMorgan is `jpmc`, not `jpmorgan`), so tenants come
 * from Common Crawl or manual capture, never from guessing the company name.
 */
export async function list(company: Company): Promise<RawJob[]> {
  // Tenants sit on regional pods, so the middle segment varies: JPMorgan is
  // `jpmc.fa.oraclecloud.com` while Oracle's own board is `eeho.fa.us2.…`.
  const host = `https://${company.token}.${company.host ?? 'fa'}.oraclecloud.com`;
  const site = company.siteNumber ?? 'CX_1001';
  const jobs: RawJob[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList` +
      `&finder=findReqs;siteNumber=${site},limit=${PAGE_SIZE},offset=${page * PAGE_SIZE}`;

    const data = await getJson<{
      items?: { requisitionList?: OracleReq[]; TotalJobsCount?: number }[];
    }>(url);

    const items = data.items?.[0];
    const reqs = items?.requisitionList ?? [];
    if (reqs.length === 0) break;

    for (const r of reqs) {
      jobs.push({
        externalId: r.Id,
        title: r.Title,
        location: r.PrimaryLocation ?? '',
        url: `${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        postedAt: r.PostedDate,
        text: r.ShortDescriptionStr,
      });
    }

    if ((page + 1) * PAGE_SIZE >= (items?.TotalJobsCount ?? 0)) break;
  }

  return jobs;
}
