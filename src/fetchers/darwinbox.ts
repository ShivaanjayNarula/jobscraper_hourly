import type { Company, RawJob } from '../types.js';
import { curlJson, toPlainText } from './util.js';

interface DarwinboxJob {
  id: string;
  designation?: string;
  designation_title?: string;
  designation_name?: string;
  designation_display_name?: string;
  department_name?: string;
  employee_type?: string;
  employee_sub_type?: string;
  experience?: string | { min?: number; max?: number };
  salary_range?: string | { min?: number; max?: number; currency?: string };
  jd?: string;
  officelocation_show_arr?: string[] | string;
  officelocations_without_area?: string[] | string;
  officelocation_arr?: string[] | string;
  country?: string | string[];
  is_remote?: boolean | number | string;
  created_on?: string | number;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 12;

/**
 * `created_on` is typed `string | number` because the API sends both across
 * tenants, and either shape can fail to parse — a garbled string or an
 * out-of-range epoch number both make `new Date(...).toISOString()` throw
 * `RangeError: Invalid time value` instead of returning something falsy.
 * Same failure class as Eightfold/Zappyhire's epoch sentinels: a single bad
 * value would otherwise make this one company look permanently dead instead
 * of just missing a posted date.
 */
export function safeIso(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Darwinbox — the HR suite behind a lot of large Indian employers.
 *
 *   token -> tenant subdomain, e.g. "pwhr"  (NOT the company name; PhysicsWallah
 *            is `pwhr`, and `*.darwinbox.in` is a wildcard so probing proves nothing)
 *   site  -> the companyId hash from the careers URL, e.g. "a62d7a6e288992"
 *
 * Two things make this endpoint fussy, and both cost real time to find:
 *
 *  1. `companyId` must appear in the POST **body** as well as the query string.
 *     Send it only as a query param and you get `{"status":"success","data":[]}`
 *     — a successful-looking empty result, not an error.
 *  2. It sits behind Cloudflare, which fingerprints the TLS/HTTP2 handshake —
 *     not just headers. Node's fetch is rejected with 403 no matter what headers
 *     you send (verified against plain, sec-fetch and accept-encoding variants);
 *     curl's handshake passes. So this one adapter shells out to curl, which is
 *     preinstalled on GitHub's runners. Ugly, but it's the difference between
 *     nine Indian employers being covered and not.
 *
 * Darwinbox's *documented* API needs a key issued by their integration team.
 * This is the unauthenticated endpoint the public careers widget itself calls.
 */
/**
 * `site` is optional. Newer v2 tenants (PhysicsWallah) require the companyId
 * hash from the careers URL; older v1 tenants (Licious, Porter, Tata 1mg)
 * resolve the company from the subdomain and accept an empty one.
 */
async function post(company: Company, page: number): Promise<unknown> {
  const companyId = company.site ?? '';
  const url = `https://${company.token}.darwinbox.in/ms/candidateapi/job/alljobs?companyId=${companyId}`;
  const origin = `https://${company.token}.darwinbox.in`;
  return curlJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: origin,
      Referer: `${origin}/ms/candidate/careers`,
    },
    body: JSON.stringify({ companyId, page, sort_option: 'new', limit: PAGE_SIZE }),
  });
}

function flatten(value: string[] | string | undefined): string {
  if (!value) return '';
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : value;
}

function money(range: DarwinboxJob['salary_range']): string | undefined {
  if (!range) return undefined;
  if (typeof range === 'string') return range.trim() || undefined;
  if (range.min || range.max) {
    return `${range.currency ?? ''} ${range.min ?? '?'}–${range.max ?? '?'}`.trim();
  }
  return undefined;
}

function years(experience: DarwinboxJob['experience']): string {
  if (!experience) return '';
  if (typeof experience === 'string') return experience;
  if (experience.min !== undefined || experience.max !== undefined) {
    return `${experience.min ?? 0}-${experience.max ?? ''} years`;
  }
  return '';
}

export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = (await post(company, page)) as {
      status?: string;
      data?: DarwinboxJob[];
      job_counts?: number;
    };
    const batch = body.data ?? [];
    if (page === 1) total = body.job_counts ?? 0;
    if (batch.length === 0) break;

    for (const job of batch) {
      const where = [
        flatten(job.officelocation_show_arr) ||
          flatten(job.officelocations_without_area) ||
          flatten(job.officelocation_arr),
        flatten(job.country),
      ]
        .filter(Boolean)
        .join(', ');

      const remote = job.is_remote && job.is_remote !== '0' ? ' · Remote' : '';

      jobs.push({
        externalId: job.id,
        // Fields can be present but empty, so `??` isn't enough here.
        title:
          [
            job.designation_display_name,
            job.designation_title,
            job.designation_name,
            job.designation,
          ].find((value) => value && value.trim()) ?? 'Untitled',
        location: `${where}${remote}`,
        url: company.site
          ? `https://${company.token}.darwinbox.in/ms/candidatev2/${company.site}/careers/jobDetails/${job.id}`
          : `https://${company.token}.darwinbox.in/ms/candidate/careers/jobdetail/${job.id}`,
        postedAt: safeIso(job.created_on),
        salary: money(job.salary_range),
        text: toPlainText(
          [
            job.employee_type,
            job.employee_sub_type,
            job.department_name,
            years(job.experience),
            job.jd ?? '',
          ].join(' '),
        ).slice(0, 6000),
      });
    }

    if (total > 0 && page * PAGE_SIZE >= total) break;
  }

  return jobs;
}
