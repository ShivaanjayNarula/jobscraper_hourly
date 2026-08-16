import { FETCHERS } from './fetchers/index.js';
import { loadCompanies } from './state.js';
import { classify } from './classify.js';
import { locationMatches, roleFamily, shouldAlert } from './filter.js';

/** npm run debug -- <company name> — shows why each of its roles passed or failed. */
const wanted = process.argv.slice(2).join(' ').toLowerCase();
const companies = await loadCompanies();
const company = companies.find((c) => c.name.toLowerCase() === wanted);
if (!company) throw new Error(`no company named "${wanted}"`);

const jobs = await FETCHERS[company.ats].list(company);
console.log(`${company.name}: ${jobs.length} postings`);

const local = jobs.filter((job) => locationMatches(job.location));
console.log(`${local.length} pass the location filter\n`);

/**
 * Every location-passing role, not a slice. A 25-row cap here once hid 58 of
 * Target's 83 India roles — including the fact that 48 of them were being
 * dropped on `role family`, which is the sort of systematic filter problem
 * this command exists to surface.
 */
const tally: Record<string, number> = {};

for (const job of local) {
  const c = classify(job, company.industry);
  const verdict = shouldAlert(job, company, c);
  const family = roleFamily(job.title, company.industry) ?? 'no family';
  const reason = verdict.keep ? 'kept' : (verdict.reason ?? 'unknown');
  tally[reason] = (tally[reason] ?? 0) + 1;
  console.log(
    `${verdict.keep ? '+' : '-'} ${job.title.slice(0, 52).padEnd(54)} ${family.padEnd(9)} ${reason}`,
  );
}

console.log(
  `\n${local.length} India/remote roles: ` +
    Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', '),
);
