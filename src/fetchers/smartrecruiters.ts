import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  experienceLevel?: { label?: string };
  typeOfEmployment?: { label?: string };
  /** The requisition's creator — a real name, public, unauthenticated, no
   *  extra call needed (already present on this same list response). */
  creator?: { name?: string };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function place(location: SrPosting['location']): string {
  const parts = [location?.city, location?.region, location?.country].filter(Boolean);
  if (location?.remote) parts.push('Remote');
  return parts.join(', ');
}

/**
 * SmartRecruiters answers 200 with `totalFound: 0` for companies that don't
 * exist, rather than 404 — so a zero-length result is the only "not found"
 * signal here. It's also the one ATS that returns a structured experience
 * level, which is a far better seniority signal than title text.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const jobs: RawJob[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<{ totalFound?: number; content?: SrPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${company.token}/postings` +
        `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    const batch = data.content ?? [];
    if (batch.length === 0) break;

    for (const p of batch) {
      jobs.push({
        externalId: p.id,
        title: p.name,
        location: place(p.location),
        url: `https://jobs.smartrecruiters.com/${company.token}/${p.id}`,
        postedAt: p.releasedDate,
        text: [p.experienceLevel?.label, p.typeOfEmployment?.label].filter(Boolean).join(' '),
        postedBy: p.creator?.name,
      });
    }

    if ((page + 1) * PAGE_SIZE >= (data.totalFound ?? 0)) break;
  }

  return jobs;
}

export async function enrich(company: Company, job: RawJob): Promise<string | undefined> {
  const data = await getJson<{
    jobAd?: { sections?: Record<string, { text?: string }> };
  }>(`https://api.smartrecruiters.com/v1/companies/${company.token}/postings/${job.externalId}`);

  const sections = data.jobAd?.sections ?? {};
  const text = Object.values(sections)
    .map((section) => section?.text ?? '')
    .join(' ');
  return text ? `${job.text ?? ''} ${toPlainText(text)}`.trim() : job.text;
}
