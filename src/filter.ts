import type { Company, Industry, RawJob } from './types.js';
import type { Classification } from './classify.js';
import {
  EMAIL_FRESHNESS_DAYS,
  INCLUDE_INTERNSHIPS,
  INDIA,
  MAX_YEARS,
  REGION_LOCKED,
  REMOTE,
  ROLE_FAMILIES,
  SERVICE_COMPANIES,
} from './config.js';

/**
 * India, or genuinely-global remote.
 *
 * Blocklisting countries never converges — "Remote, Denmark" and "Remote -
 * Ireland" both slipped past a list of the obvious ones. So we invert it: strip
 * the remote-related noise words and see what geography is left. Anything
 * remaining that isn't India is a country restriction, whatever its name.
 */
const REMOTE_NOISE =
  /\b(remote|friendly|hybrid|on[- ]?site|in[- ]office|work from home|wfh|flexible|optional|travel|required|preferred|global|worldwide|anywhere|multiple locations|various|other|location)\b/gi;

export function locationMatches(location: string): boolean {
  if (!location) return false;
  if (INDIA.test(location)) return true;
  if (!REMOTE.test(location)) return false;
  if (REGION_LOCKED.test(location)) return false;

  const residue = location.replace(REMOTE_NOISE, ' ').replace(/[^a-z]+/gi, ' ').trim();
  return residue.length === 0;
}

/**
 * The `finance` family only applies at actual financial firms. "Associate" and
 * "Analyst" are generic job-title filler at a tech company — matching them there
 * pulls in sales, support and warehouse roles by the hundred.
 */
const FINANCE_INDUSTRIES = new Set<Industry>(['banking', 'consulting', 'quant']);

export function roleFamily(title: string, industry: Industry): string | null {
  for (const [family, pattern] of Object.entries(ROLE_FAMILIES)) {
    if (family === 'finance' && !FINANCE_INDUSTRIES.has(industry)) continue;
    if (pattern.test(title)) return family;
  }
  return null;
}

export function isServiceCompany(name: string): boolean {
  return SERVICE_COMPANIES.test(name);
}

export interface Verdict {
  keep: boolean;
  reason?: string;
}

/**
 * Cheap gates that need only the title and location — no description required.
 *
 * This runs *before* enrichment and is what keeps the first run from taking ten
 * minutes: fetching a description for all ~13,000 previously-unseen postings is
 * pointless when location and role family already rule out the vast majority.
 * Only the years check genuinely needs the description text.
 */
export function preScreen(job: RawJob, company: Company): boolean {
  if (isServiceCompany(company.name)) return false;
  if (!locationMatches(job.location)) return false;
  return roleFamily(job.title, company.industry) !== null;
}

/**
 * Collapses whitespace and every dash-like Unicode character to a plain
 * hyphen before two titles are compared for dedup. Cigna posted the same
 * requisition twice — once with a plain hyphen, once with an en-dash in
 * "HIH – Evernorth" — and an exact-string key treated them as different roles.
 */
export function normalizeForDedup(s: string): string {
  return s.toLowerCase().trim().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');
}

/**
 * Whether a role is worth an urgent email, as opposed to just entering the
 * catalogue. A role with no parseable posting date is always "fresh" — we
 * cannot penalize a board for not exposing one at all.
 */
export function isFreshEnough(postedAt: string | undefined, days = EMAIL_FRESHNESS_DAYS): boolean {
  if (!postedAt) return true;
  const posted = new Date(postedAt).getTime();
  if (Number.isNaN(posted)) return true;
  return (Date.now() - posted) / 86_400_000 <= days;
}

export function shouldAlert(job: RawJob, company: Company, c: Classification): Verdict {
  if (isServiceCompany(company.name)) return { keep: false, reason: 'service company' };
  if (c.excluded) return { keep: false, reason: 'excluded role type' };
  if (c.isIntern && !INCLUDE_INTERNSHIPS) return { keep: false, reason: 'internship' };
  if (!locationMatches(job.location)) return { keep: false, reason: 'location' };
  if (!roleFamily(job.title, company.industry)) return { keep: false, reason: 'role family' };

  // Interns are entry-level by definition; skip the years gate for them.
  if (!c.isIntern) {
    if (c.minYears !== null && c.minYears > MAX_YEARS) {
      return { keep: false, reason: `${c.minYears}y minimum` };
    }
    if (!c.isJunior) return { keep: false, reason: 'seniority' };
  }

  return { keep: true };
}
