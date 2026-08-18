import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface KekaLocation {
  city?: string;
  state?: string;
  countryCode?: string;
  countryName?: string;
}

interface KekaJob {
  id: number;
  title: string;
  description?: string;
  excerpt?: string;
  departmentName?: string;
  jobLocations?: KekaLocation[];
  experience?: string;
  publishedOn?: string;
}

/**
 * Keka — an Indian HR/ATS platform popular with mid-market Indian companies.
 *
 *   token -> tenant subdomain, e.g. "enveu"
 *   site  -> the portal name from the careers page's `portalName` meta tag;
 *            almost always empty, in which case "default" works.
 *
 * One call returns every active job, no pagination and no auth — the
 * simplest adapter in the project.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const portal = company.site || 'default';
  const jobs = await getJson<KekaJob[]>(
    `https://${company.token}.keka.com/careers/api/jobs/${portal}/active`,
  );

  return jobs.map((job) => {
    const loc = job.jobLocations ?? [];
    const location = loc
      .map((l) => [l.city, l.state, l.countryName].filter(Boolean).join(', '))
      .join(' · ');

    return {
      externalId: String(job.id),
      title: job.title,
      location,
      url: `https://${company.token}.keka.com/careers/jobdetails/${job.id}`,
      postedAt: job.publishedOn,
      text: toPlainText(
        [job.departmentName, job.experience, job.excerpt, job.description ?? ''].join(' '),
      ).slice(0, 6000),
    };
  });
}
