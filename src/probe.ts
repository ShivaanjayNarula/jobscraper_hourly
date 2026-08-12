import { readFileSync } from 'node:fs';
import type { Ats, Company, Industry } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimit } from './fetchers/util.js';
import { isServiceCompany, locationMatches } from './filter.js';
import { loadCompanies, saveCompanies } from './state.js';

/**
 * Bulk-probes candidate slugs against Greenhouse, Lever and Ashby.
 *
 * This works because those three derive the board token from the company name —
 * "postman" really is Postman's token. It does NOT work for Workday or Oracle,
 * whose tenants are opaque (JPMorgan is `jpmc`); those come from the Common
 * Crawl harvest in discover.ts instead.
 *
 *   npm run probe -- candidates.txt [--all]
 *
 * Lines are `slug` or `slug,industry`. By default only boards with at least one
 * India/remote role are kept; --all keeps every live board.
 */
const HOSTED: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

/** Board tokens are lowercase slugs; company names shouldn't inherit that. */
function prettify(slug: string): string {
  return slug
    .split(/[\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface Candidate {
  slug: string;
  industry: Industry;
}

function parseCandidates(path: string): Candidate[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]!.trim())
    .filter(Boolean)
    .map((line) => {
      const [slug, industry] = line.split(',').map((part) => part.trim());
      return { slug: slug!, industry: (industry as Industry) || 'tech' };
    });
}

/** "urban company" -> urbancompany, urban-company. Boards use both conventions. */
function variants(slug: string): string[] {
  const base = slug.toLowerCase().replace(/[^a-z0-9 -]/g, '');
  return [...new Set([base.replace(/[ -]/g, ''), base.replace(/ /g, '-')])];
}

interface Hit {
  company: Company;
  total: number;
  relevant: number;
}

async function probe(candidate: Candidate, known: Set<string>): Promise<Hit | null> {
  for (const token of variants(candidate.slug)) {
    for (const ats of HOSTED) {
      if (known.has(`${ats}:${token}`)) return null;
      const company: Company = {
        name: prettify(candidate.slug),
        ats,
        token,
        industry: candidate.industry,
        source: 'curated',
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

async function main(): Promise<void> {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) throw new Error('usage: npm run probe -- candidates.txt [--all]');
  const keepAll = flags.includes('--all');

  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));
  const candidates = parseCandidates(path);

  console.log(`probing ${candidates.length} candidates across ${HOSTED.join(', ')}`);
  const hits = (await mapLimit(candidates, 12, (c) => probe(c, known))).filter(
    (hit): hit is Hit => hit !== null && !isServiceCompany(hit.company.name),
  );

  const keep = hits.filter((hit) => keepAll || hit.relevant > 0);
  for (const hit of hits) {
    const mark = keep.includes(hit) ? '+' : '-';
    console.log(
      `  ${mark} ${hit.company.ats.padEnd(10)} ${hit.company.token.padEnd(22)} ${String(hit.total).padStart(4)} jobs, ${hit.relevant} India/remote`,
    );
  }

  console.log(`\n${hits.length} live boards, ${keep.length} with India/remote roles`);
  if (keep.length === 0) return;

  await saveCompanies([...existing, ...keep.map((hit) => hit.company)]);
  console.log(`companies.json: ${existing.length} -> ${existing.length + keep.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
