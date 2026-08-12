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

for (const job of local.slice(0, 25)) {
  const c = classify(job, company.industry);
  const verdict = shouldAlert(job, company, c);
  const family = roleFamily(job.title, company.industry) ?? 'no family';
  console.log(
    `${verdict.keep ? '+' : '-'} ${job.title.slice(0, 52).padEnd(54)} ${family.padEnd(9)} ${
      verdict.reason ?? 'kept'
    }`,
  );
}
