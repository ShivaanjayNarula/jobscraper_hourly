import { readFileSync } from 'node:fs';
import type { Company, Industry } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimit } from './fetchers/util.js';
import { locationMatches } from './filter.js';
import { loadCompanies, saveCompanies } from './state.js';
import { HOSTED as SUPPORTED, WORKDAY } from './board-url.js';

/**
 * Resolves a company's careers page to its actual ATS board.
 *
 * This exists because probing slugs is unreliable in exactly the cases that
 * matter: Razorpay's Greenhouse token is `razorpaysoftwareprivatelimited` (the
 * registered entity), and PhysicsWallah's Darwinbox tenant is `pwhr`. Neither is
 * guessable from the brand name. The careers page, however, always links to the
 * real board — so read it instead of guessing.
 *
 *   npm run detect -- domains.txt
 */
const CAREER_PATHS = ['/careers', '/careers/', '/jobs', '/jobs/', '/company/careers', '/about/careers'];

/**
 * Platforms this file can't resolve to a ready-to-add `Company` automatically
 * — either because there's genuinely no adapter yet, or because the adapter
 * exists but needs fields (tenant + companyId hash, org GUID, host pod, ...)
 * that aren't recoverable from a single regex group on the careers-page HTML.
 * Reported either way so a real board doesn't silently vanish from the scan.
 */
const NO_ADAPTER = /keka\.com|icims\.com/i;
const NEEDS_MANUAL_EXTRACTION = /darwinbox\.[a-z]+|turbohire\.co|successfactors\.[a-z]+|phenompeople\.com/i;

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; jobscraper-next)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

interface Detection {
  domain: string;
  company?: Company;
  unsupported?: string;
}

/** "razorpay.com" -> "Razorpay", "fractal.ai" -> "Fractal". */
function nameFromDomain(domain: string): string {
  const base = domain.replace(/^www\./, '').split('.')[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function detect(domain: string, industry: Industry): Promise<Detection> {
  for (const path of CAREER_PATHS) {
    const html = await fetchText(`https://${domain}${path}`);
    if (!html) continue;

    const workday = WORKDAY.exec(html);
    if (workday) {
      const [, token, host, site] = workday;
      return {
        domain,
        company: { name: nameFromDomain(domain), ats: 'workday', token: token!, host, site, industry, source: 'curated' },
      };
    }

    for (const { ats, pattern } of SUPPORTED) {
      const match = pattern.exec(html);
      if (match?.[1] && match[1] !== 'embed') {
        return { domain, company: { name: nameFromDomain(domain), ats, token: match[1], industry, source: 'curated' } };
      }
    }

    const manual = NEEDS_MANUAL_EXTRACTION.exec(html);
    if (manual) return { domain, unsupported: `${manual[0]} (adapter exists — extract the board URL by hand, see ADDING-COMPANIES.md)` };

    const blocked = NO_ADAPTER.exec(html);
    if (blocked) return { domain, unsupported: blocked[0] };
  }
  return { domain };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: npm run detect -- domains.txt');

  const targets = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]!.trim())
    .filter(Boolean)
    .map((line) => {
      const [domain, industry] = line.split(',').map((part) => part.trim());
      return { domain: domain!, industry: (industry as Industry) || 'tech' };
    });

  console.log(`resolving ${targets.length} careers pages`);
  const found = await mapLimit(targets, 8, (t) => detect(t.domain, t.industry));

  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));
  const additions: Company[] = [];

  for (const result of found) {
    if (result.unsupported) {
      console.log(`  ? ${result.domain.padEnd(24)} runs ${result.unsupported} — no adapter yet`);
      continue;
    }
    if (!result.company) {
      console.log(`  - ${result.domain.padEnd(24)} no ATS link found`);
      continue;
    }
    const { company } = result;
    const key = `${company.ats}:${company.token.toLowerCase()}`;
    if (known.has(key)) {
      console.log(`  = ${result.domain.padEnd(24)} ${company.ats}:${company.token} (already have it)`);
      continue;
    }

    try {
      const jobs = await FETCHERS[company.ats].list(company);
      const relevant = jobs.filter((job) => locationMatches(job.location)).length;
      if (jobs.length === 0) {
        console.log(`  - ${result.domain.padEnd(24)} ${company.ats}:${company.token} resolved but empty`);
        continue;
      }
      console.log(`  + ${result.domain.padEnd(24)} ${company.ats}:${company.token} — ${jobs.length} jobs, ${relevant} India/remote`);
      known.add(key);
      additions.push(company);
    } catch (error) {
      console.log(`  ! ${result.domain.padEnd(24)} ${company.ats}:${company.token} failed: ${(error as Error).message}`);
    }
  }

  if (additions.length === 0) {
    console.log('\nnothing new to add');
    return;
  }
  await saveCompanies([...existing, ...additions]);
  console.log(`\ncompanies.json: ${existing.length} -> ${existing.length + additions.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
