import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { Candidate, Hit } from './board-probe.js';
import { probeSlug } from './board-probe.js';
import { mapLimit, UA } from './fetchers/util.js';
import { isServiceCompany } from './filter.js';
import { extractNames, headlines, FUNDING, INDIA_EXPANSION } from './news-extract.js';
import { loadCompanies, saveCompanies } from './state.js';

/**
 * Harvests company names from Indian startup-funding and India-expansion
 * coverage, then probes them for a real board.
 *
 *   npm run discover-news
 *
 * The premise: a company that just raised a round, or just announced an India
 * centre, is about to start hiring — and is exactly the employer this tracker
 * would otherwise learn about months late, once it happened to appear in a
 * placement report or a Common Crawl index.
 *
 * Name extraction is deliberately GENEROUS rather than clever. Pulling a wrong
 * phrase out of a headline costs one failed HTTP probe and nothing else, while
 * being strict would miss companies whose headline phrasing wasn't anticipated.
 * The board probe is the real filter — same principle as the URL import: every
 * board is validated before it is kept, so a bad guess is free.
 */
const FEEDS = [
  'https://entrackr.com/rss',
  'https://inc42.com/feed/',
  'https://yourstory.com/feed',
  'https://techcrunch.com/feed/',
  'https://startupstorymedia.com/feed/',
  'https://www.livemint.com/rss/companies',
  'https://economictimes.indiatimes.com/tech/startups/rssfeeds/13357270.cms',
];

async function fetchFeed(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Raw candidate names, before probing — deliberately unfiltered. These are
 * headline-extracted guesses, not verified companies; some are junk (see
 * news-extract.ts's STOPWORDS comment). The point is a fast manual-outreach
 * list ("this company just raised money, go find their HR contact"), not a
 * claim that every name here has a real job board.
 */
function renderDigest(names: string[]): string {
  const rows = names.map((n) => `<li style="margin:4px 0;">${escape(n)}</li>`).join('\n');
  return `<!doctype html><html><body style="font-family:sans-serif;">
<h2>${names.length} company names from today's funding/India-expansion news</h2>
<p style="color:#666;">Unverified — pulled straight from headlines, not checked against any job board. Some entries are extraction noise, not real companies.</p>
<ul>${rows}</ul>
</body></html>`;
}

async function main(): Promise<void> {
  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));
  const knownNames = new Set(existing.map((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '')));

  const feeds = await mapLimit(FEEDS, 6, fetchFeed);
  const live = feeds.filter(Boolean).length;

  const relevant: string[] = [];
  for (const xml of feeds) {
    for (const title of headlines(xml)) {
      if (FUNDING.test(title) || INDIA_EXPANSION.test(title)) relevant.push(title);
    }
  }
  console.log(`${live}/${FEEDS.length} feeds reachable, ${relevant.length} funding/expansion headlines`);

  const candidates = new Map<string, Candidate>();
  for (const title of relevant) {
    for (const name of extractNames(title)) {
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || knownNames.has(key) || candidates.has(key)) continue;
      candidates.set(key, { slug: name, name, industry: 'tech' });
    }
  }
  console.log(`${candidates.size} candidate names not already tracked`);

  const dryRun = process.env.DRY_RUN === '1';
  let keptCount = 0;

  if (candidates.size > 0) {
    const hits = (
      await mapLimit([...candidates.values()], 10, (c) => probeSlug(c, known, 'discovered'))
    ).filter((hit): hit is Hit => hit !== null && !isServiceCompany(hit.company.name));

    // Same bar as `npm run probe`: a live board with no India or remote role is
    // not worth an hourly request. Single-word candidates get a higher bar —
    // a generic word like "LEAP" (extracted from "LEAP India" after "India" was
    // stripped as a stopword) resolved live to an unrelated company's real
    // Ashby board (ashby:leap) during this audit. One coincidental India/remote
    // role on that board would have silently attributed a stranger's job
    // listing to the wrong company — the same class of bug as the Oracle
    // tenants that looked like IBM (see ADDING-COMPANIES.md §4d). A multi-word
    // candidate's token ("leapindia") is specific enough that this is a
    // non-issue; a single common word is not.
    const keep = hits.filter((hit) => (hit.company.name.includes(' ') ? hit.relevant > 0 : hit.relevant >= 2));
    for (const hit of hits) {
      console.log(
        `  ${keep.includes(hit) ? '+' : '-'} ${hit.company.name.padEnd(24)} ${hit.company.ats.padEnd(10)} ${String(hit.total).padStart(4)} jobs, ${hit.relevant} India/remote`,
      );
    }
    console.log(`\n${hits.length} live boards, ${keep.length} with India/remote roles`);
    keptCount = keep.length;

    if (keep.length > 0) {
      if (dryRun) {
        console.log(`DRY_RUN=1 — not writing companies.json (would go ${existing.length} -> ${existing.length + keep.length})`);
      } else {
        await saveCompanies([...existing, ...keep.map((hit) => hit.company)]);
        console.log(`companies.json: ${existing.length} -> ${existing.length + keep.length}`);
      }
    }
  }

  /**
   * `candidate_count` gates the workflow's digest-email step, and `out/` is
   * gitignored — empty on every fresh runner. Reporting a non-zero count
   * without having written the file would point that step at a file that
   * doesn't exist (same failure class `new_count`/`out/email.html` already
   * had in index.ts — see HANDOFF.md). The count must track whether the
   * digest was actually written, not just how many candidates were found.
   */
  const wroteDigest = candidates.size > 0;
  if (wroteDigest) {
    await mkdir('out', { recursive: true });
    await writeFile('out/discover-news.html', renderDigest([...candidates.values()].map((c) => c.name ?? c.slug)), 'utf8');
  }

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await appendFile(
      output,
      `candidate_count=${wroteDigest ? candidates.size : 0}\nkept_count=${keptCount}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
