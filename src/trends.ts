import { readFile } from 'node:fs/promises';
import type { CatalogEntry } from './catalog.js';
import { roleFamily } from './filter.js';

/**
 * Trend intelligence over the existing catalogue (PHASES.md Phase D). No new
 * state: `data/jobs.json` already carries `firstSeen` per posting, which is
 * the only clock hiring velocity needs. Everything here is derivable on
 * demand — deliberately NOT another rolling history file to persist.
 *
 *   npm run trends
 */

export interface CompanyVelocity {
  company: string;
  /** Open postings right now. */
  open: number;
  /** First seen by the crawler within the last 30 days. */
  newLast30: number;
  /**
   * newLast30 / max(open, 1): a company at 40 open with 20 brand-new is
   * ramping hard; one at 400 open with 20 new is just churning listings.
   */
  velocity: number;
}

/**
 * Employers whose posting count is climbing. A company that is ramping is
 * worth attention even when no single posting is new — this is the aggregate
 * version of that signal (PHASES.md #54).
 */
export function companyVelocity(
  entries: readonly CatalogEntry[],
  now = Date.now(),
): CompanyVelocity[] {
  const byCompany = new Map<string, { open: number; newLast30: number }>();
  for (const job of entries) {
    if (job.closedAt) continue;
    const stats = byCompany.get(job.company) ?? { open: 0, newLast30: 0 };
    stats.open++;
    const first = new Date(job.firstSeen).getTime();
    if (!Number.isNaN(first) && now - first < 30 * 86_400_000) stats.newLast30++;
    byCompany.set(job.company, stats);
  }
  return [...byCompany.entries()]
    .map(([company, s]) => ({ company, ...s, velocity: s.newLast30 / Math.max(s.open, 1) }))
    .sort((a, b) => b.newLast30 - a.newLast30 || b.open - a.open);
}

/**
 * The employers actually worth surfacing: enough open roles to be a real
 * pipeline, enough fresh ones to be a real ramp. Both floors keep the section
 * from filling with one-posting companies where "50% new" means nothing.
 */
export function rampingCompanies(
  entries: readonly CatalogEntry[],
  limit = 6,
  minOpen = 8,
  minNew = 3,
  now = Date.now(),
): CompanyVelocity[] {
  return companyVelocity(entries, now)
    .filter((c) => c.open >= minOpen && c.newLast30 >= minNew)
    .slice(0, limit);
}

export interface SalaryTrend {
  family: string;
  /** Calendar month, e.g. "2026-08". */
  month: string;
  n: number;
  medianMin: number | null;
  medianMax: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

/**
 * Median offered band per role family per calendar month, from the Phase A
 * salary extraction (`salaryMin`/`salaryMax` in ₹ LPA). Postings without an
 * extracted band are skipped — an unparsed salary must never dilute a median.
 * Bucketed by firstSeen month: what we saw, when we saw it.
 */
export function salaryTrends(
  entries: readonly CatalogEntry[],
  monthsBack = 3,
  now = Date.now(),
): SalaryTrend[] {
  const buckets = new Map<string, { mins: number[]; maxs: number[] }>();
  for (const job of entries) {
    if (job.closedAt || job.salaryMin === undefined || job.salaryMax === undefined) continue;
    const family = roleFamily(job.title, job.industry);
    if (!family) continue;
    const first = new Date(job.firstSeen);
    if (Number.isNaN(first.getTime())) continue;
    const ageDays = (now - first.getTime()) / 86_400_000;
    if (ageDays > monthsBack * 31 || ageDays < 0) continue;

    // Month bucket from the crawl date itself.
    const month = first.toISOString().slice(0, 7);
    const bucket = buckets.get(`${family}|${month}`) ?? { mins: [], maxs: [] };
    bucket.mins.push(job.salaryMin);
    bucket.maxs.push(job.salaryMax);
    buckets.set(`${family}|${month}`, bucket);
  }
  return [...buckets.entries()]
    .map(([key, b]) => {
      const [family, month] = key.split('|');
      return { family: family!, month: month!, n: b.mins.length, medianMin: median(b.mins), medianMax: median(b.maxs) };
    })
    .sort((a, b) => a.family.localeCompare(b.family) || a.month.localeCompare(b.month));
}

async function main(): Promise<void> {
  const catalog: CatalogEntry[] = JSON.parse(await readFile('data/jobs.json', 'utf8'));

  console.log(`Ramping employers (of ${catalog.filter((e) => !e.closedAt).length} open roles):\n`);
  for (const c of rampingCompanies(catalog)) {
    console.log(`  ${c.company.padEnd(28)} ${String(c.open).padStart(4)} open, ${String(c.newLast30).padStart(3)} new in 30d (${Math.round(c.velocity * 100)}% churn-in)`);
  }

  console.log('\nMedian offered band (₹ LPA) by role family and month:\n');
  for (const t of salaryTrends(catalog)) {
    console.log(
      `  ${t.family.padEnd(10)} ${t.month}  n=${String(t.n).padStart(4)}  ₹${t.medianMin ?? '?'}–${t.medianMax ?? '?'} LPA`,
    );
  }
}

// CLI entry point; index.ts imports the pure functions only.
if (process.argv[1]?.endsWith('trends.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
