/**
 * Second published tenant source: elliottdehn/open-jobs' `slugs.json`.
 *
 *   npm run oj-slugs            # writes state/oj-<platform>.txt, one per line
 *   npm run bulk-import -- --file state/oj-breezy.txt --platform breezy
 *
 * `bulk-import.ts` already reads kalil0321/ats-scrapers. This is a genuinely
 * different corpus, not a mirror: it is derived from a Common Crawl index
 * (CC-MAIN-2026-21 at the time of writing), 64,383 unique slugs, and it is
 * fresher on the platforms the two overlap on. Measured against the corpus on
 * 2026-09-06, after the first source had already been fully imported, it still
 * held 6,783 untracked Workable slugs against the 133 Workable boards we had —
 * a platform that had been in `IMPORTABLE` the whole time. The other source
 * simply did not list them.
 *
 * Being Common-Crawl-derived is also its limitation, and worth knowing before
 * reaching for it: it only sees platforms whose board URLs leak into a web
 * crawl. It carries **no Keka, Darwinbox or Teamtailor at all** — exactly the
 * India-dense platforms — so it complements the first source rather than
 * replacing it. Check both before concluding a platform is small.
 *
 * Emitted platforms are only those where a bare slug is enough to build a
 * fetchable board. Deliberately excluded even though the file lists them:
 * Workday (needs pod + site), Eightfold (needs the tenant's mail domain as its
 * `domain=` parameter), UKG (needs a board GUID), iCIMS and SuccessFactors
 * (hostname tokens, and the file carries 137/3 of them respectively), and
 * Taleo, Dayforce, Paycom, Paylocity, Comeet, Crelate, GoHire, JobScore,
 * Pinpoint, Recruiterbox and Jobvite, none of which have an adapter here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { Ats } from './types.js';
import { UA } from './fetchers/util.js';
import { loadCompanies } from './state.js';

const SLUGS_URL = 'https://raw.githubusercontent.com/elliottdehn/open-jobs/main/slugs.json';

/** open-jobs' key for the platform -> our `Ats`. Identical today, but the two
 *  naming schemes are independent and this file should not assume otherwise. */
const PLATFORMS: Record<string, Ats> = {
  ashby: 'ashby',
  breezy: 'breezy',
  greenhouse: 'greenhouse',
  lever: 'lever',
  personio: 'personio',
  recruitee: 'recruitee',
  smartrecruiters: 'smartrecruiters',
  workable: 'workable',
};

interface SlugsFile {
  crawl?: string;
  total_unique_slugs?: number;
  ats?: Record<string, string[]>;
}

export async function fetchSlugs(): Promise<SlugsFile> {
  const res = await fetch(SLUGS_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${SLUGS_URL}`);
  return (await res.json()) as SlugsFile;
}

/**
 * Drops slugs already tracked for that platform, so the file handed to
 * `bulk-import` is the work actually left rather than a full re-validation of
 * boards we already poll. Comparison is case-insensitive: these lists are
 * crawled from URLs and casing is inconsistent between sources.
 */
export function untrackedSlugs(slugs: readonly string[], tracked: readonly string[]): string[] {
  const known = new Set(tracked.map((t) => t.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of slugs) {
    const slug = String(raw).trim();
    const lower = slug.toLowerCase();
    if (!slug || known.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(slug);
  }
  return out;
}

if (process.argv[1]?.endsWith('open-jobs-slugs.ts')) {
  const data = await fetchSlugs();
  const companies = await loadCompanies();
  await mkdir('state', { recursive: true });

  console.log(`open-jobs slugs.json: ${data.total_unique_slugs ?? '?'} slugs, crawl ${data.crawl ?? '?'}`);

  for (const [key, ats] of Object.entries(PLATFORMS)) {
    const slugs = data.ats?.[key] ?? [];
    if (slugs.length === 0) {
      console.log(`  ${ats.padEnd(16)} not present in this file`);
      continue;
    }
    const tracked = companies.filter((c) => c.ats === ats).map((c) => c.token);
    const fresh = untrackedSlugs(slugs, tracked);
    const path = `state/oj-${ats}.txt`;
    await writeFile(path, `${fresh.join('\n')}\n`, 'utf8');
    console.log(
      `  ${ats.padEnd(16)} ${String(slugs.length).padStart(6)} published, ${String(fresh.length).padStart(6)} untracked -> ${path}`,
    );
  }

  // Invoke tsx directly rather than through `npm run -- ...`. npm's PowerShell
  // shim on Windows swallows the `--` separator and reports `--file` as an
  // unknown npm config, so the flags never reach this project's code and the
  // run silently falls through to a full sweep of every IMPORTABLE platform.
  // That cost a real 18,473-board run before it was noticed.
  console.log('\nnext: npx tsx src/bulk-import.ts --file state/oj-<platform>.txt --platform <platform>');
  console.log('run them one at a time — each one writes companies.json');
}
