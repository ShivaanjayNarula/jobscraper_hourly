import type { Company, RawJob } from '../types.js';
import { UA } from './util.js';

interface ZohoJob {
  id: string;
  Job_Opening_Name?: string;
  Posting_Title?: string;
  Country?: string | null;
  City?: string | null;
  Remote_Job?: boolean;
  Job_Type?: string;
}

/** Only numeric entities are needed — Zoho's SPA HTML-encodes the JSON payload's quotes as `&#34;`. */
function decodeNumericEntities(raw: string): string {
  return raw.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/**
 * Zoho Recruit — Zoho's own hiring product, popular with Indian SMBs
 * (Zoho itself is Chennai-based). `token` holds the full careers page URL,
 * since tenants live on a mix of `{company}.zohorecruit.{com,in}/jobs/Careers`
 * and fully custom domains (careers.zohocorp.com/jobs/careers) with no
 * single predictable pattern.
 *
 * The board is a client-rendered SPA, but the current job list is embedded
 * server-side as a JSON array in a hidden `<input id="jobs">` on first load
 * — no XHR needed for title/location/id. Description and posted-date live
 * only in the SPA's client-rendered detail view, not fetched here.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const res = await fetch(company.token, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${company.token}`);
  const html = await res.text();

  const tagMatch = /<input[^>]*\bid="jobs"[^>]*>/i.exec(html);
  if (!tagMatch) return [];
  const valueMatch = /value="([^"]*)"/.exec(tagMatch[0]);
  if (!valueMatch) return [];

  const jobs = JSON.parse(decodeNumericEntities(valueMatch[1]!)) as ZohoJob[];
  const base = company.token.replace(/\/jobs\/Careers.*/i, '/jobs');

  return jobs.map((job) => {
    const location = job.Remote_Job
      ? 'Remote'
      : [job.City, job.Country].filter(Boolean).join(', ');
    const title = job.Posting_Title || job.Job_Opening_Name || 'Untitled';

    return {
      externalId: job.id,
      title,
      location,
      url: `${base}/${job.id}/${title.replace(/\s+/g, '-')}`,
      text: job.Job_Type,
    };
  });
}
