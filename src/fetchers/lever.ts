import type { Company, RawJob } from '../types.js';
import { getJson } from './util.js';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

function formatSalary(r: LeverPosting['salaryRange']): string | undefined {
  if (!r?.min && !r?.max) return undefined;
  const currency = r?.currency ?? '';
  const interval = r?.interval?.replace('per-', '/') ?? '';
  return `${currency} ${r?.min?.toLocaleString() ?? '?'}–${r?.max?.toLocaleString() ?? '?'} ${interval}`.trim();
}

/** Lever returns descriptions inline, so no enrich step is needed. */
export async function list(company: Company): Promise<RawJob[]> {
  const postings = await getJson<LeverPosting[]>(
    `https://api.lever.co/v0/postings/${company.token}?mode=json`,
  );
  return postings.map((p) => {
    const locations = p.categories?.allLocations?.join(', ') || p.categories?.location || '';
    return {
      externalId: p.id,
      title: p.text,
      location: [locations, p.workplaceType].filter(Boolean).join(' · '),
      url: p.hostedUrl,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
      salary: formatSalary(p.salaryRange),
      text: [p.categories?.commitment, p.descriptionPlain].filter(Boolean).join(' '),
    };
  });
}
