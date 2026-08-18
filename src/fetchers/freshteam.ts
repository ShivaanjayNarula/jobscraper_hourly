import type { Company, RawJob } from '../types.js';
import { toPlainText, UA } from './util.js';

/**
 * Freshteam (Freshworks' recruiting product) — Freshworks is
 * Chennai-headquartered, so this shows up on a fair number of Indian
 * company boards. `token` is the subdomain, e.g. "nxtwave".
 *
 * The job list page is server-rendered — no API (`/api/jobs` needs a key,
 * `/jobs.json` just returns HTML). Each job card's anchor carries a
 * reliable `data-portal-location`, but `data-portal-title` is a lowercase
 * slug, not the real title — the real title is the visible text in a
 * following `.job-title` div, so both get pulled from the same regex pass.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const url = `https://${company.token}.freshteam.com/jobs`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const html = await res.text();

  const jobRe =
    /<a href="(\/jobs\/[^"]+)"[^>]*data-portal-location="([^"]*)"[^>]*>[\s\S]{0,400}?<div class="job-title">([^<]*)<\/div>/g;

  const jobs: RawJob[] = [];
  for (const m of html.matchAll(jobRe)) {
    const [, href, location, title] = m;
    if (!href || !title) continue;
    const id = href.split('/')[2];
    if (!id) continue;
    jobs.push({
      externalId: id,
      title: toPlainText(title),
      location: toPlainText(location ?? ''),
      url: `https://${company.token}.freshteam.com${href}`,
    });
  }
  return jobs;
}

/** Detail pages carry a schema.org/JobPosting JSON-LD block with the full description. */
export async function enrich(_company: Company, job: RawJob): Promise<string | undefined> {
  const res = await fetch(job.url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return undefined;
  const html = await res.text();

  const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!ldMatch) return undefined;
  try {
    const data = JSON.parse(ldMatch[1]!) as { description?: string };
    return data.description ? toPlainText(data.description).slice(0, 6000) : undefined;
  } catch {
    return undefined;
  }
}
