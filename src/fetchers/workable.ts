import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText, UA } from './util.js';

interface WorkableLocation {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
}

interface WorkableJob {
  title: string;
  shortcode: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  country?: string;
  city?: string;
  state?: string;
  locations?: WorkableLocation[];
}

/**
 * Workable — a widely-used SMB/startup ATS (1,805 of 8,265 companies in a
 * separate open dataset run on it, by far the biggest single platform
 * there). `token` is the account slug from the board URL,
 * e.g. "rentokil-initial" in apply.workable.com/rentokil-initial.
 *
 * The widget API returns every job in one call, no pagination, no auth —
 * but it carries no description, so that's an `enrich()` fetch against the
 * server-rendered job page instead.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const data = await getJson<{ jobs?: WorkableJob[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${company.token}`,
  );

  return (data.jobs ?? []).map((job) => {
    const locations = job.locations ?? [];
    const location =
      locations
        .map((l) => [l.city, l.region, l.country].filter(Boolean).join(', '))
        .join(' · ') || [job.city, job.state, job.country].filter(Boolean).join(', ');

    return {
      externalId: job.shortcode,
      title: job.title,
      location,
      url: job.url ?? `https://apply.workable.com/j/${job.shortcode}`,
      postedAt: job.published_on,
    };
  });
}

/** The widget API has no per-job JSON endpoint — description lives only on the rendered job page. */
export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const res = await fetch(`https://apply.workable.com/${company.token}/j/${job.externalId}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return undefined;

  const html = await res.text();
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return toPlainText(withoutScripts).slice(0, 6000);
}
