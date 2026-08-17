import type { Ats, Company, Industry } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { locationMatches } from './filter.js';

/**
 * Shared slug-probing used by both `npm run probe` (a file of candidates) and
 * `npm run discover-news` (names harvested from funding coverage).
 *
 * This works because these four platforms derive the board token from the
 * company name — "postman" really is Postman's token. It does NOT work for
 * Workday or Oracle, whose tenants are opaque (JPMorgan is `jpmc`); those come
 * from the Common Crawl harvest in discover.ts instead.
 *
 * Lives in its own module because probe.ts runs `main()` at import time, so
 * importing from it would execute the CLI as a side effect.
 */
export const HOSTED: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

/** Board tokens are lowercase slugs; company names shouldn't inherit that. */
export function prettify(slug: string): string {
  return slug
    .split(/[\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** "urban company" -> urbancompany, urban-company. Boards use both conventions. */
export function variants(slug: string): string[] {
  const base = slug.toLowerCase().replace(/[^a-z0-9 -]/g, '');
  return [...new Set([base.replace(/[ -]/g, ''), base.replace(/ /g, '-')])];
}

export interface Hit {
  company: Company;
  total: number;
  relevant: number;
}

export interface Candidate {
  slug: string;
  industry: Industry;
  /** Optional display name — news headlines carry better casing than a slug. */
  name?: string;
}

export async function probeSlug(
  candidate: Candidate,
  known: Set<string>,
  source: Company['source'] = 'curated',
): Promise<Hit | null> {
  for (const token of variants(candidate.slug)) {
    for (const ats of HOSTED) {
      if (known.has(`${ats}:${token}`)) return null;
      const company: Company = {
        name: candidate.name ?? prettify(candidate.slug),
        ats,
        token,
        industry: candidate.industry,
        source,
      };
      try {
        const jobs = await FETCHERS[ats].list(company);
        if (jobs.length === 0) continue;
        return {
          company,
          total: jobs.length,
          relevant: jobs.filter((job) => locationMatches(job.location)).length,
        };
      } catch {
        // 404 just means this company isn't on this ATS. Try the next.
      }
    }
  }
  return null;
}
