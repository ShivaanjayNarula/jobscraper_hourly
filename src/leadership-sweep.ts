/**
 * Run leadershipContacts() (CEO/founder + engineering-management tier) across
 * the whole board list and tally what it finds.
 *
 *   npm run leadership-sweep              # resumes where the last run stopped
 *   npm run leadership-sweep -- --limit 300
 *   npm run leadership-sweep -- --report  # re-print the tally, fetch nothing
 *   npm run leadership-sweep -- --yc          # sweep the YC directory instead
 *   npm run leadership-sweep -- --yc India    # ...filtered to one region
 *
 * Four confidence tiers, in the order tried:
 *
 *   verified — the company's own ATS token IS its real hostname (phenom,
 *              icims, zohorecruit, successfactors). Same set outreach.ts's
 *              alternates() already trusts enough to construct an emailable
 *              candidate from.
 *   swept    — state/contact-sweep.json already resolved and *name-matched*
 *              this company's domain from real GitHub commit authors. A
 *              different source than the ATS token, but still evidence, not
 *              a guess.
 *   yc       — `--yc` mode only: the domain is YC's own listed `website`
 *              field for that company, straight from their directory. Real
 *              evidence, not a guess, but a separate pool from companies.json
 *              (most YC-stage companies aren't tracked job boards here), so
 *              it gets its own tier rather than overloading `verified`.
 *   guessed  — no evidence either way; `{slug}.com` from the company name.
 *              This is the tier that can misattribute an unrelated
 *              company's leadership page. Kept separate in the output on
 *              purpose — not wired into outreach.ts, not something to mail
 *              off without a human looking at which tier a hit came from.
 *
 * Results are written incrementally to state/leadership-sweep.json and the
 * run resumes from it, same reason contacts-sweep.ts does: a full pass over
 * 13,000+ companies takes hours, and losing it to one network blip would be
 * maddening. Gitignored — a measurement artefact, not product state.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { leadershipContacts, type LeadershipContact } from './contact-sources.js';
import { loadCompanies, readJson } from './state.js';
import { HOSTNAME_ATS } from './outreach.js';
import { fetchYCCompanies } from './yc-directory.js';

const SWEEP_PATH = 'state/leadership-sweep.json';
const INDEX_PATH = 'state/leadership-sweep-index.json';
const CONTACT_SWEEP_PATH = 'state/contact-sweep.json';

/** Each company's own 7 leadership-path fetches are already sequential; this
 *  bounds how many companies are in flight across different hosts at once. */
const CONCURRENCY = 8;
const SAVE_EVERY = 25;

type Tier = 'verified' | 'swept' | 'yc' | 'guessed';
const TIERS: Tier[] = ['verified', 'swept', 'yc', 'guessed'];

export interface LeadershipSweepResult {
  domain: string | null;
  tier: Tier | null;
  contacts: LeadershipContact[];
}

type Sweep = Record<string, LeadershipSweepResult>;

interface SweepTask {
  key: string;
  domain: string;
  tier: Tier;
}

/** Same suffix list as contacts-sweep.ts's orgCandidates, for the same reason:
 *  a legal-entity suffix in the company name is never part of its domain. */
function guessDomain(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|technologies|technology|labs|software|solutions)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return `${slug}.com`;
}

function resolveDomain(
  company: { name: string; ats: string; token: string },
  contactSweep: Record<string, { domain: string | null; matched: boolean }>,
): { domain: string; tier: Tier } {
  if (HOSTNAME_ATS.has(company.ats)) return { domain: company.token, tier: 'verified' };
  const swept = contactSweep[company.name.toLowerCase()];
  if (swept?.domain && swept.matched) return { domain: swept.domain, tier: 'swept' };
  return { domain: guessDomain(company.name), tier: 'guessed' };
}

function report(sweep: Sweep): void {
  const results = Object.entries(sweep);
  const byTier = { verified: 0, swept: 0, yc: 0, guessed: 0 } as Record<Tier, number>;
  const hitsByTier = { verified: 0, swept: 0, yc: 0, guessed: 0 } as Record<Tier, number>;
  let totalContacts = 0;

  for (const [, r] of results) {
    if (!r.tier) continue;
    byTier[r.tier]++;
    if (r.contacts.length > 0) {
      hitsByTier[r.tier]++;
      totalContacts += r.contacts.length;
    }
  }

  const pct = (n: number, of: number) => (of === 0 ? '0.0' : ((n / of) * 100).toFixed(1));

  console.log(`\n=== leadership sweep: ${results.length} companies swept ===`);
  for (const tier of TIERS) {
    console.log(
      `${tier.padEnd(10)} ${String(byTier[tier]).padStart(6)} companies, ` +
        `${hitsByTier[tier]} with a contact found (${pct(hitsByTier[tier], byTier[tier])}%)`,
    );
  }
  console.log(`total named contacts found: ${totalContacts}`);

  console.log('\nsample hits (first 25 with at least one contact)');
  let shown = 0;
  for (const [name, r] of results) {
    if (r.contacts.length === 0) continue;
    console.log(`  ${name.slice(0, 28).padEnd(30)} [${r.tier}] ${r.domain}`);
    for (const c of r.contacts) console.log(`      ${c.name.padEnd(24)} ${c.title}`);
    if (++shown >= 25) break;
  }
}

const args = process.argv.slice(2);
const limitFlag = args.indexOf('--limit');
const limit = limitFlag === -1 ? Infinity : Number(args[limitFlag + 1]);
const ycFlag = args.indexOf('--yc');
// `--yc` alone sweeps the whole directory; `--yc India` (any bare word right
// after it, not another flag) narrows to one of Algolia's region facets.
const ycRegion = ycFlag !== -1 && args[ycFlag + 1] && !args[ycFlag + 1]!.startsWith('--') ? args[ycFlag + 1] : undefined;

const sweep = await readJson<Sweep>(SWEEP_PATH, {});

if (args.includes('--report')) {
  report(sweep);
  process.exit(0);
}

let tasks: SweepTask[];
if (ycFlag !== -1) {
  const ycCompanies = await fetchYCCompanies({ region: ycRegion, activeOnly: true });
  console.log(`YC directory: ${ycCompanies.length} active companies${ycRegion ? ` in ${ycRegion}` : ''}`);
  tasks = ycCompanies.map((c) => {
    let domain: string;
    try {
      domain = new URL(c.website.startsWith('http') ? c.website : `https://${c.website}`).hostname;
    } catch {
      domain = guessDomain(c.name);
    }
    return { key: `yc:${c.name}`, domain, tier: 'yc' };
  });
} else {
  const contactSweepRaw = await readJson<Record<string, { domain: string | null; matched: boolean }>>(
    CONTACT_SWEEP_PATH,
    {},
  );
  const contactSweep = Object.fromEntries(
    Object.entries(contactSweepRaw).map(([name, v]) => [name.toLowerCase(), v]),
  );
  const companies = await loadCompanies();
  // Deduplicate by name: one company can have several boards, and would
  // otherwise be swept once per board for the same answer.
  const uniqueCompanies = [...new Map(companies.map((c) => [c.name, c])).values()];
  tasks = uniqueCompanies.map((c) => ({ key: c.name, ...resolveDomain(c, contactSweep) }));
}

const pending = tasks.filter((t) => !(t.key in sweep)).slice(0, limit === Infinity ? undefined : limit);

console.log(`${Object.keys(sweep).length} already swept, ${pending.length} to go`);

let done = 0;
let hits = 0;
const started = Date.now();
const queue = [...pending];

const save = async (): Promise<void> => {
  await mkdir('state', { recursive: true });
  await writeFile(SWEEP_PATH, `${JSON.stringify(sweep, null, 2)}\n`, 'utf8');
  /**
   * A second, committable projection of the same run.
   *
   * SWEEP_PATH is gitignored (megabytes, rewritten wholesale), so a hosted
   * build on a runner sees none of it — exactly the failure contacts-sweep.ts
   * already hit and solved this same way. Without this, the 625 companies where
   * this sweep found a real name against a real domain are unreachable by the
   * live pipeline, and the leadership section renders empty on every hosted
   * build no matter how much the sweep actually found.
   *
   * Only the tiers backed by evidence travel: `verified` (the ATS token is the
   * company's own hostname) and `swept` (the domain came from real commit
   * authors in contacts-sweep). The `guessed` tier is a slug-plus-.com hunch
   * that produced a documented false positive, so it stays local research only.
   * Two contacts per company: enough to draft from, small enough to commit to a
   * public repo, and it carries no addresses at all.
   */
  const index: Record<string, { domain: string; contacts: { name: string; title: string }[] }> = {};
  for (const [name, entry] of Object.entries(sweep)) {
    if (entry.tier === 'guessed' || !entry.domain || !entry.contacts?.length) continue;
    index[name] = { domain: entry.domain, contacts: entry.contacts.slice(0, 2) };
  }
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + String.fromCharCode(10), 'utf8');
};

const worker = async (): Promise<void> => {
  for (;;) {
    const task = queue.shift();
    if (!task) return;
    const { key, domain, tier } = task;
    try {
      const contacts = await leadershipContacts(domain);
      sweep[key] = { domain, tier, contacts };
      if (contacts.length > 0) {
        hits++;
        console.log(
          `  ${key.slice(0, 28).padEnd(30)} [${tier}] ${domain}: ` +
            contacts.map((c) => `${c.name} (${c.title})`).join('; '),
        );
      }
    } catch (error) {
      sweep[key] = { domain: null, tier: null, contacts: [] };
      console.log(`  ! ${key}: ${(error as Error).message}`);
    }
    done++;
    if (done % SAVE_EVERY === 0) {
      await save();
      const rate = done / ((Date.now() - started) / 1000);
      const remaining = Math.round((queue.length / rate / 60) * 10) / 10;
      console.log(`[${done}/${pending.length}] ${hits} hits, ${rate.toFixed(1)}/s, ~${remaining}m left`);
    }
  }
};

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await save();
report(sweep);
