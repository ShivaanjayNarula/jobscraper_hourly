import { readFileSync } from 'node:fs';
import type { Company } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimit } from './fetchers/util.js';
import { isServiceCompany, locationMatches } from './filter.js';
import { loadCompanies, saveCompanies } from './state.js';
import { boardKey, parseBoardUrl } from './board-url.js';
import { CONCURRENCY } from './config.js';

/**
 * Harvests board definitions from any file containing job URLs — a curated
 * README, a bookmarks export, a pasted list of links.
 *
 *   npm run import -- listings.md [--all]
 *
 * Community job-listing repos are a good seam: their tables link straight to
 * Greenhouse, Workday and Ashby boards, so one file can yield hundreds of
 * companies that would otherwise need discovering one at a time.
 *
 * Boards are validated before being kept, and by default only those with a live
 * India/remote role are added.
 */
async function main(): Promise<void> {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) throw new Error('usage: npm run import -- <file-with-urls> [--all]');
  const keepAll = flags.includes('--all');

  const text = readFileSync(path, 'utf8');
  const urls = text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [];
  console.log(`scanned ${urls.length} URLs`);

  const existing = await loadCompanies();
  const known = new Set(existing.map(boardKey));

  const candidates = new Map<string, Company>();
  for (const url of urls) {
    const company = parseBoardUrl(url);
    if (!company || isServiceCompany(company.name)) continue;
    const key = boardKey(company);
    if (known.has(key) || candidates.has(key)) continue;
    candidates.set(key, company);
  }

  const list = [...candidates.values()];
  console.log(`${list.length} boards not already tracked; validating`);
  if (list.length === 0) return;

  const keep: Company[] = [];
  await mapLimit(list, CONCURRENCY, async (company) => {
    try {
      const jobs = await FETCHERS[company.ats].list(company);
      if (jobs.length === 0) return;
      const relevant = jobs.filter((job) => locationMatches(job.location)).length;
      if (!keepAll && relevant === 0) return;
      keep.push(company);
      console.log(`  + ${company.ats.padEnd(10)} ${company.token.padEnd(26)} ${jobs.length} jobs, ${relevant} India/remote`);
    } catch {
      // Dead token, renamed board, or a tenant that needs a site path we don't have.
    }
  });

  if (keep.length === 0) {
    console.log('nothing new worth adding');
    return;
  }

  await saveCompanies([...existing, ...keep]);
  console.log(`\ncompanies.json: ${existing.length} -> ${existing.length + keep.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
