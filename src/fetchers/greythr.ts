import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface GreytJob {
  id: string;
  req_id?: string;
  title: string;
  slug: string;
  created_at?: string;
  published_on_career_page?: string;
  locations?: string[];
  description?: string;
  job_type?: string;
  is_remote?: boolean;
  min_exp?: number;
  max_exp?: number;
  apply_url?: string;
}

interface EmpCategoryValue {
  cat_id: string;
  name: string;
}

/**
 * greytHR Recruit — a major Indian payroll/HRMS's ATS module, India-only
 * customer base. `token` is the tenant subdomain, e.g. "waydot".
 *
 * Jobs come back with numeric location IDs instead of names — a second
 * unauthenticated call maps them. Base is `/hire/api/...` on the tenant
 * subdomain, not `/api/...` (that serves the main greytHR login portal).
 */
export async function list(company: Company): Promise<RawJob[]> {
  const base = `https://${company.token}.greythr.com/hire/api`;

  const [jobsRes, locRes] = await Promise.all([
    getJson<{ data?: GreytJob[] }>(`${base}/career/published_jobs/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    getJson<{ value?: Record<string, EmpCategoryValue> }>(`${base}/greythr/emp-category/`),
  ]);

  const locationNames = locRes.value ?? {};

  return (jobsRes.data ?? []).map((job) => {
    const location = (job.locations ?? [])
      .map((id) => locationNames[id]?.name)
      .filter(Boolean)
      .join(', ');

    const minYears = job.min_exp !== undefined ? Math.floor(job.min_exp / 12) : undefined;
    const maxYears = job.max_exp !== undefined ? Math.floor(job.max_exp / 12) : undefined;

    return {
      externalId: job.req_id ?? job.id,
      title: job.title,
      location: [location, job.is_remote ? 'Remote' : ''].filter(Boolean).join(' · '),
      url: job.apply_url ?? `https://${company.token}.greythr.com/hire/jobs/${job.slug}`,
      postedAt: job.published_on_career_page ?? job.created_at,
      text: toPlainText(
        [minYears !== undefined ? `${minYears}-${maxYears} years` : '', job.job_type, job.description ?? ''].join(' '),
      ).slice(0, 6000),
    };
  });
}
