import { readFile } from 'node:fs/promises';
import type { CatalogEntry } from './catalog.js';
import { roleFamily } from './filter.js';

/**
 * A second front-end over the catalogue that already exists — no new backend,
 * no new matching logic, just a filter over `data/jobs.json` for local use.
 *
 *   npm run query -- --role swe --company razorpay
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const role = flag('role');
const company = flag('company')?.toLowerCase();
const title = flag('title')?.toLowerCase();
const csv = args.includes('--csv');

async function main(): Promise<void> {
  const catalog: CatalogEntry[] = JSON.parse(await readFile('data/jobs.json', 'utf8'));

  const matches = catalog.filter((job) => {
    if (job.closedAt) return false;
    if (company && !job.company.toLowerCase().includes(company)) return false;
    if (title && !job.title.toLowerCase().includes(title)) return false;
    if (role && roleFamily(job.title, job.industry) !== role) return false;
    return true;
  });

  console.log(`${matches.length} open match${matches.length === 1 ? '' : 'es'}`);
  if (csv) {
    // Spreadsheet-friendly: quoted RFC-4180 fields, header row, no padding.
    console.log('company,title,location,url,postedAt,minYears,maxYears,salaryMin,salaryMax');
    for (const job of matches) {
      const q = (s: string | number | null | undefined) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      console.log(
        [q(job.company), q(job.title), q(job.location), q(job.url), q(job.postedAt), job.minYears, job.maxYears, job.salaryMin ?? '', job.salaryMax ?? ''].join(','),
      );
    }
    return;
  }
  for (const job of matches) {
    console.log(`  ${job.company.padEnd(24)} ${job.title.padEnd(50)} ${job.url}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
