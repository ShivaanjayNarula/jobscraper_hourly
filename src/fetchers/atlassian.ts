import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface AtlassianListing {
  id: number;
  title: string;
  locations?: string[];
  category?: string;
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  applyUrl?: string;
  compensation?: string;
  portalJobPost?: { portalUrl?: string; updatedDate?: string };
}

/**
 * Atlassian fronts iCIMS but publishes its own listings endpoint as plain JSON —
 * one unpaginated GET with descriptions and compensation inlined. Worth a custom
 * adapter precisely because the iCIMS portal behind it serves only HTML.
 */
export async function list(_company: Company): Promise<RawJob[]> {
  const listings = await getJson<AtlassianListing[]>(
    'https://www.atlassian.com/endpoint/careers/listings',
  );

  return listings.map((job) => ({
    externalId: String(job.id),
    title: job.title,
    location: (job.locations ?? []).join(', '),
    url: job.portalJobPost?.portalUrl ?? job.applyUrl ?? 'https://www.atlassian.com/company/careers',
    postedAt: job.portalJobPost?.updatedDate?.replace(' ', 'T'),
    salary: job.compensation ? toPlainText(job.compensation).slice(0, 120) : undefined,
    text: toPlainText(
      [job.category, job.qualifications, job.responsibilities, job.overview]
        .filter(Boolean)
        .join(' '),
    ).slice(0, 6000),
  }));
}
