/**
 * Run the git-commit contact source across the whole board list and tally what
 * it finds.
 *
 *   npm run contacts-sweep              # resumes where the last run stopped
 *   npm run contacts-sweep -- --limit 200
 *   npm run contacts-sweep -- --report  # re-print the tally, fetch nothing
 *
 * The point is to turn "12 of 15 companies in a hand-picked sample" into a real
 * hit rate over `companies.json`, since that number decides whether the contact
 * layer is worth building on or whether the paid alternative wins.
 *
 * Results are written incrementally to `state/contact-sweep.json` and the run
 * resumes from it, because a full sweep takes hours and losing it to one
 * network blip would be maddening. That file is a measurement artefact, not
 * product state — it is not committed.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { domainMatchesOrg, githubContacts, type Pattern } from './contacts.js';
import { loadCompanies, readJson } from './state.js';

const SWEEP_PATH = 'state/contact-sweep.json';

/** Politeness, and secondary-limit avoidance — GitHub punishes bursty clients. */
const CONCURRENCY = 4;
/** How often to flush to disk. Every result would be thousands of writes. */
const SAVE_EVERY = 25;

export interface SweepResult {
  /** The org slug that actually resolved, or null if none did. */
  org: string | null;
  domain: string | null;
  /** False when the domain looks like an outside contributor's, not this company's. */
  matched: boolean;
  pattern: Pattern | null;
  authors: number;
}

type Sweep = Record<string, SweepResult>;

/**
 * Candidate GitHub org slugs for a company. The ATS token is included because
 * it is very often the company's own slug already (a Greenhouse board token of
 * `razorpay` for Razorpay), which catches names that normalise badly.
 *
 * ponytail: at most two candidates, tried in order. Trying every plausible
 * variant (hyphenated, `-inc`, `-labs`, `-hq`) would multiply the request count
 * by four for the ~85% of companies that have no org at all. Log the misses and
 * run a wider second pass over that shorter list if the hit rate justifies it.
 */
export function orgCandidates(name: string, token: string): string[] {
  const slug = name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|technologies|technology|labs|software|solutions)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  const fromToken = token.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return [...new Set([slug, fromToken].filter((candidate) => candidate.length >= 2))];
}

async function sweepCompany(name: string, token: string): Promise<SweepResult> {
  // A candidate whose domain matches the company name wins outright. An
  // unmatched one is kept only as a fallback, so that trying the second
  // candidate still has a chance of doing better than the first.
  let fallback: SweepResult | null = null;
  for (const candidate of orgCandidates(name, token)) {
    const found = await githubContacts(candidate);
    if (!found.domain) continue;
    const result: SweepResult = {
      org: candidate,
      domain: found.domain,
      matched: found.domainMatchesOrg || domainMatchesOrg(name, found.domain),
      pattern: found.pattern,
      authors: found.authors.length,
    };
    if (result.matched) return result;
    fallback ??= result;
  }
  return fallback ?? { org: null, domain: null, matched: false, pattern: null, authors: 0 };
}

function report(sweep: Sweep): void {
  const results = Object.values(sweep);
  const raw = results.filter((r) => r.domain);
  // Only name-matched domains count as usable. The rest are almost all outside
  // contributors to an open-source repo, and mailing them would reach the
  // wrong company.
  const hits = raw.filter((r) => r.matched);
  const withPattern = hits.filter((r) => r.pattern);

  const patterns = new Map<string, number>();
  for (const { pattern } of withPattern) patterns.set(pattern!, (patterns.get(pattern!) ?? 0) + 1);

  const tlds = new Map<string, number>();
  for (const { domain } of hits) {
    const tld = domain!.slice(domain!.lastIndexOf('.'));
    tlds.set(tld, (tlds.get(tld) ?? 0) + 1);
  }

  const pct = (n: number, of: number) => (of === 0 ? '0.0' : ((n / of) * 100).toFixed(1));

  console.log(`\n=== contact sweep: ${results.length} companies swept ===`);
  console.log(`usable hits         ${hits.length} (${pct(hits.length, results.length)}%)`);
  console.log(`rejected: domain did not match the company name  ${raw.length - hits.length}`);
  console.log(`pattern inferred    ${withPattern.length} (${pct(withPattern.length, hits.length)}% of hits)`);
  console.log(`total addresses     ${hits.reduce((sum, r) => sum + r.authors, 0)}`);

  console.log('\npattern distribution (of companies with an inferred pattern)');
  for (const [pattern, count] of [...patterns].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pattern.padEnd(12)} ${String(count).padStart(5)}  ${pct(count, withPattern.length)}%`);
  }

  console.log('\ntop mail TLDs among hits');
  for (const [tld, count] of [...tlds].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${tld.padEnd(12)} ${String(count).padStart(5)}`);
  }

  console.log('\nrichest companies (most addresses found)');
  const richest = Object.entries(sweep)
    .filter(([, r]) => r.authors > 0 && r.matched)
    .sort((a, b) => b[1].authors - a[1].authors)
    .slice(0, 20);
  for (const [name, r] of richest) {
    console.log(`  ${name.slice(0, 28).padEnd(30)} ${(r.domain ?? '').padEnd(26)} ${(r.pattern ?? '—').padEnd(12)} ${r.authors}`);
  }
}

/**
 * The full sweep is gitignored, which means GitHub Actions has never had any of
 * it: `outreach.yml` builds its batch on a runner where `loadSweepLower()`
 * reads an empty object, so every company falls back to guessing its GitHub org
 * from an ATS token. That discards the 3,238 companies whose real org this
 * sweep had already resolved — including the 1,637 whose domain it verified —
 * and it is why a hosted batch finds contacts for a fraction of the companies a
 * local run does.
 *
 * So write a second, committed file alongside it. It carries only the three
 * fields resolveRecipients() actually reads, and only for companies that
 * resolved to something, which is 154 KB rather than 1.6 MB. Nothing personal
 * is in it — no addresses, no names, only org/domain/matched — so unlike the
 * batch itself it is safe in this public repo.
 */
const INDEX_PATH = 'state/contact-sweep-index.json';

const save = async (sweep: Sweep): Promise<void> => {
  await mkdir('state', { recursive: true });
  await writeFile(SWEEP_PATH, `${JSON.stringify(sweep, null, 2)}\n`, 'utf8');
  const index = Object.fromEntries(
    Object.entries(sweep)
      .filter(([, r]) => r.org)
      .map(([name, r]) => [name, { org: r.org, domain: r.domain, matched: r.matched }]),
  );
  await writeFile(INDEX_PATH, `${JSON.stringify(index)}\n`, 'utf8');
};

const args = process.argv.slice(2);
const limitFlag = args.indexOf('--limit');
const limit = limitFlag === -1 ? Infinity : Number(args[limitFlag + 1]);

const sweep = await readJson<Sweep>(SWEEP_PATH, {});

if (args.includes('--report')) {
  report(sweep);
  process.exit(0);
}

const companies = await loadCompanies();
// Deduplicate by name: the board list holds one entry per board, and a company
// with several boards would otherwise be swept several times for one answer.
const pending = [...new Map(companies.map((c) => [c.name, c])).values()]
  .filter((c) => !(c.name in sweep))
  .slice(0, limit === Infinity ? undefined : limit);

console.log(`${Object.keys(sweep).length} already swept, ${pending.length} to go`);

let done = 0;
let hits = 0;
const started = Date.now();
const queue = [...pending];

const worker = async (): Promise<void> => {
  for (;;) {
    const company = queue.shift();
    if (!company) return;
    try {
      const result = await sweepCompany(company.name, company.token);
      sweep[company.name] = result;
      if (result.domain && result.matched) {
        hits++;
        // Only hits are logged. A line per company across 13,000 companies is
        // an enormous amount of output for no information.
        console.log(`  ${company.name.slice(0, 28).padEnd(30)} ${result.domain.padEnd(26)} ${result.pattern ?? '—'}  (${result.authors})`);
      }
    } catch (error) {
      // Anything that survived the retry ladder in gh() is worth seeing, but
      // is not worth abandoning the sweep over — the entry stays absent from
      // `sweep` so a later run retries it.
      console.log(`  ! ${company.name}: ${(error as Error).message}`);
    }
    done++;
    if (done % SAVE_EVERY === 0) {
      await save(sweep);
      const rate = done / ((Date.now() - started) / 1000);
      const remaining = Math.round((queue.length / rate / 60) * 10) / 10;
      console.log(`[${done}/${pending.length}] ${hits} hits, ${rate.toFixed(1)}/s, ~${remaining}m left`);
    }
  }
};

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await save(sweep);
report(sweep);
