/**
 * Cold-reach draft generator — the human-sends-everything model.
 *
 *   npm run outreach              # build today's batch, serve localhost:7700
 *   npm run outreach -- --print   # text-only plan, no server
 *   npm run outreach -- --static  # write out/outbox/today.html, no server
 *
 * Two independent first-touch lanes plus shared follow-ups:
 *
 *   triggered lane — companies whose newest catalogue role opened within the
 *                    last TRIGGER_WINDOW_DAYS; the hourly-fresh trigger.
 *   random lane    — everything else with an open role, rotated daily.
 *
 * Every candidate address passes SMTP verification (verify-email.ts) before
 * it can reach the page: `invalid` is dropped, `unknown` ships with a warning
 * badge, `valid` ships clean. The verdict is stored on the contact with a
 * timestamp and reused for VERDICT_TTL_DAYS so a mailbox is probed once, not
 * every reload. No fact, no mail; no near-twin bodies in one batch; the human
 * is the transport — nothing here speaks SMTP as a sender.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { readJson } from './state.js';
import { mapLimit } from './fetchers/util.js';
import { githubContacts, splitName, type CommitAuthor } from './contacts.js';
import { dmarcRua, npmContacts, pypiContacts, mavenContacts } from './contact-sources.js';
import { verifyEmail, type Verdict } from './verify-email.js';

// ── knobs ────────────────────────────────────────────────────────────────────

/**
 * These three caps double as the ATTEMPT pool size, not just the output
 * ceiling — `buildBatch()` selects exactly `min(laneBudget, budget)`
 * companies per lane before resolving any contact, so a low cap starves
 * resolution of candidates rather than merely trimming a longer result.
 *
 * First raised 50→100 on 2026-09-02 off a real local measurement (one build
 * attempted 50/50 and resolved 38/29 — both well under cap, so the cap itself
 * was the binding constraint, not a lack of real contacts; the triggered
 * lane's real pool measured 139 companies with a posting inside
 * TRIGGER_WINDOW_DAYS that day). Raised again to 500 the same day on direct
 * request — more cards to manually pick from, independent of what the
 * measured pool needs. The triggered lane still can't exceed its real
 * same-day pool regardless of this number (139 that day; it moves daily), so
 * 500 there is harmless headroom, not 500 real triggered contacts — the
 * random lane's pool is large enough that 500 there is a real target. This is
 * no longer sized off the "measure before raising" ceiling that governed the
 * first bump; if a build starts taking noticeably longer than the hourly
 * cadence can absorb, that is the next thing to measure.
 */
const RANDOM_BUDGET = Number(process.env.OUTREACH_RANDOM ?? 500);
const TRIGGERED_BUDGET = Number(process.env.OUTREACH_TRIGGERED ?? 500);
/**
 * Hard ceiling on total cards per build (follow-ups count toward this). Not a
 * literal per-24h counter despite the name — `buildBatch()` recomputes a
 * fresh `DAILY_BUDGET` allowance on every invocation with no cross-run
 * persistence, so moving `outreach.yml` to hourly means this is really "per
 * build" now, not "per day". Must stay >= the two caps above combined or it
 * silently becomes the binding constraint instead of them.
 */
const DAILY_BUDGET = Number(process.env.OUTREACH_DAILY ?? 1000);
/**
 * A role younger than this puts its company in the triggered lane. Widened
 * 7→21 on 2026-09-02 after measuring the real pool directly against the live
 * catalogue: 105 unique companies at 7 days, 130 at 21 — a real ~24% lift.
 * Stopped at 21, not pushed further: many ATS platforms report age as the
 * bucket string "Posted 30+ Days Ago" rather than a real number, which
 * `postedAgeDays()` parses as literally 30 — so the pool jumps to 201 the
 * instant the window reaches 30, not from genuinely fresher roles but from
 * swallowing that entire "who knows how old, could be years" bucket as if it
 * meant exactly 30 days. Widening past 21 would trade lead quality for a
 * fake volume number, which is the opposite of what this knob is for.
 */
export const TRIGGER_WINDOW_DAYS = 21;
const TOUCH_GAPS = [0, 4, 9, 16];
const FACT_MAX_AGE_DAYS = 90;
/** Bound the wall-clock cost of SMTP probing per company per build. */
const MAX_PROBES_PER_COMPANY = Number(process.env.OUTREACH_PROBES ?? 4);
const VERDICT_TTL_DAYS = 14;
const SIGNATURE = process.env.OUTREACH_NAME ?? 'SM';
const PORT = Number(process.env.OUTREACH_PORT ?? 7700);
/**
 * Deployed mode: when set (e.g. "https://site.vercel.app/api"), card buttons
 * point at the hosted API routes instead of the local server, so clicks from
 * the published page record state exactly like localhost does.
 */
const LINK_BASE = (process.env.OUTREACH_LINK_BASE ?? '').replace(/\/$/, '');
/**
 * Shared secret for the hosted routes. The draft ids are the recipients' own
 * addresses, so an ungated API plus a published batch would let anyone mark
 * the whole campaign skipped. Only appended in deployed mode; the localhost
 * server needs no key.
 */
const LINK_KEY = process.env.OUTREACH_KEY ?? '';
const actionUrl = (path: string) =>
  LINK_BASE ? `${LINK_BASE}/${path}${LINK_KEY ? `?k=${encodeURIComponent(LINK_KEY)}` : ''}` : `/${path}`;

const STATE_PATH = process.env.OUTREACH_STATE_PATH ?? 'state/contacted.json';
const SWEEP_PATH = 'state/contact-sweep.json';
const SWEEP_INDEX_PATH = 'state/contact-sweep-index.json';
const CATALOG_PATH = 'data/jobs.json';
const PID_PATH = 'state/outreach.pid';
const PAGE_PATH = 'out/outbox/today.html';

// Deterministic daily rotation. OUTREACH_SEED exists so a day's batch can be
// reproduced exactly (tests, "what did I see yesterday"); default is today.
const daySeed = () => process.env.OUTREACH_SEED ?? new Date().toISOString().slice(0, 10);

// ── state ────────────────────────────────────────────────────────────────────

interface ContactState {
  company: string;
  role: string;
  location?: string;
  jobUrl: string;
  firstName?: string;
  /** Completed touches; TOUCH_GAPS.length means sequence finished. */
  touch: number;
  sentAt: string[];
  nextDueAt: string;
  fact?: string;
  subject: string;
  verdict?: Verdict;
  verifiedAt?: string;
  /** Gravatar confirmed the exact address exists (positive-only signal). */
  gravatar?: boolean;
  replied?: boolean;
  skipped?: boolean;
  bounced?: boolean;
  bouncedAt?: string;
}
type OutreachState = Record<string, ContactState>;

interface CatalogJob {
  id: string;
  title: string;
  company: string;
  industry?: string;
  location?: string;
  url: string;
  postedAt?: string;
  /** When catalog.ts first recorded this exact job id — always a real ISO
   *  timestamp, unlike postedAt which some ATS platforms only report as a
   *  vague bucket ("Posted 30+ Days Ago"). */
  firstSeen?: string;
  minYears?: number | null;
  maxYears?: number | null;
  closedAt?: string;
}

/**
 * Triggered by either signal, not just the ATS's self-reported postedAt:
 * a role this tracker only just started seeing is exactly what "triggered"
 * means, even when the ATS itself won't say how old the posting really is.
 * Shared by loadCompanyPool() (selection) and buildFirstDraft() (the
 * rendered card's own lane label) so the two can never disagree about which
 * lane a company landed in.
 */
export function isTriggered(job: CatalogJob): boolean {
  const byPostedAt = (postedAgeDays(job.postedAt) ?? Infinity) <= TRIGGER_WINDOW_DAYS;
  if (byPostedAt) return true;
  if (!job.firstSeen) return false;
  const firstSeenDays = (Date.now() - new Date(job.firstSeen).getTime()) / 86_400_000;
  return Number.isFinite(firstSeenDays) && firstSeenDays <= TRIGGER_WINDOW_DAYS;
}

async function saveState(state: OutreachState): Promise<void> {
  await mkdir('state', { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ── single-instance lock ─────────────────────────────────────────────────────

/**
 * Two concurrent runs would double-draft the same people and race the state
 * file. The pidfile refuses a second live instance; a stale file (crashed
 * run) is detected by probing the pid and overwritten.
 */
async function acquireLock(): Promise<boolean> {
  let prevPid: number | null = null;
  try {
    prevPid = Number((await readFile(PID_PATH, 'utf8')).trim());
  } catch {
    /* first run */
  }
  if (prevPid && Number.isFinite(prevPid) && prevPid !== process.pid) {
    try {
      process.kill(prevPid, 0); // throws ESRCH if dead
      console.error(`outreach already running (pid ${prevPid}). Close it or delete ${PID_PATH}.`);
      return false;
    } catch {
      /* stale — fall through and take over */
    }
  }
  await mkdir('state', { recursive: true });
  await writeFile(PID_PATH, `${process.pid}\n`, 'utf8');
  const release = async () => {
    try {
      const txt = await readFile(PID_PATH, 'utf8');
      if (Number(txt.trim()) === process.pid) await rm(PID_PATH);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', () => void release());
  process.once('SIGINT', () => { void release().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void release().finally(() => process.exit(0)); });
  return true;
}

// ── pure helpers (selftested) ────────────────────────────────────────────────

export function touchGap(touch: number): number {
  return TOUCH_GAPS[Math.min(Math.max(touch, 0), TOUCH_GAPS.length - 1)]!;
}

export function nextDueAt(fromIso: string, touchJustSent: number): string {
  return new Date(new Date(fromIso).getTime() + touchGap(touchJustSent) * 86_400_000).toISOString();
}

/**
 * Age in days of a catalogue posting. Handles ISO timestamps and Workday's
 * relative strings ("Posted Today", "Posted 30+ Days Ago"); anything else
 * parses as null, which reads as "unknown age", never as fresh.
 */
export function postedAgeDays(postedAt?: string): number | null {
  if (!postedAt) return null;
  // 'Yesterday' is its own word on Workday and iCIMS boards — not a number,
  // not 'today'. Without it those postings fall through to the Date parse,
  // come back NaN, and are treated as age-unknown: the single freshest slice
  // of the catalogue (71 of 2,367 entries when this was found) was landing in
  // the random lane instead of the triggered one.
  const rel = /^posted\s+(?<today>today)|^posted\s+(?<yday>yesterday)|^posted\s+(?<n>\d+)\+?\s+days?\s+ago/i.exec(postedAt.trim());
  if (rel) {
    if (rel.groups?.n != null) return Number(rel.groups.n);
    return rel.groups?.yday ? 1 : 0;
  }
  const t = new Date(postedAt).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Catalogue names arrive raw from auto-discovery; lowercase ones read badly in mail. */
export function displayName(name: string): string {
  return name === name.toLowerCase()
    ? name.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : name;
}

export function bodySimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3),
    );
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

export interface BodyInput {
  greet: string;
  first: string;
  fact?: string;
  roleLine: string;
  ask: string;
  passAlong: string;
}

export function renderBody(o: BodyInput): string {
  const lines = [`${o.greet} ${o.first},`, ''];
  if (o.fact) lines.push(`${o.fact}`, '');
  lines.push(o.roleLine, '', o.ask, '', o.passAlong, '', `— ${SIGNATURE}`);
  return lines.join('\n');
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
const GREETINGS = ['Hi', 'Hello', 'Hey'];
const FACT_VERBS = ['Saw your recent commit', 'Came across your commit', 'Noticed your push'];
const ASK_T1 = [
  'Is this req open to my experience band? y/n works.',
  'Should I apply through the portal, or is there someone better to send this to?',
  'Is it open to early-career folks? One word helps.',
];
const ASK_T2 = [
  'Following up once — still open? A one-word reply is plenty.',
  'Circling back on this. Still live?',
];
const ASK_T3 = [
  "Last nudge from me — if it's filled or off-target, a 'no' closes the loop and I won't write again.",
];
const PASS_ALONG = [
  'Not you? Happy if you point me right.',
  "If this isn't yours, who should it go to?",
];
const pick = <T>(pool: T[], seed: string): T => pool[hash(seed) % pool.length]!;

function experienceLabel(minYears?: number | null, maxYears?: number | null): string {
  if (minYears == null && maxYears == null) return '';
  if (minYears != null && maxYears != null) return `${minYears}–${maxYears} yrs`;
  if (minYears != null) return `${minYears}+ yrs`;
  return `up to ${maxYears} yrs`;
}

// ── target selection ─────────────────────────────────────────────────────────

interface CompanyTarget {
  company: string;
  job: CatalogJob;
  lane: 'triggered' | 'random';
}

function loadCompanyPool(catalog: CatalogJob[], state: OutreachState): CompanyTarget[] {
  const byCompany = new Map<string, CatalogJob>();
  for (const job of catalog) {
    if (job.closedAt) continue;
    const key = job.company.toLowerCase();
    const prev = byCompany.get(key);
    if (!prev || (postedAgeDays(job.postedAt) ?? Infinity) < (postedAgeDays(prev.postedAt) ?? Infinity)) {
      byCompany.set(key, job);
    }
  }
  const contactedCompanies = new Set(
    Object.values(state)
      .filter((c) => !c.skipped)
      .map((c) => c.company.toLowerCase()),
  );
  return [...byCompany.values()]
    .filter((job) => !contactedCompanies.has(job.company.toLowerCase()))
    // Seed is PREFIXED, not suffixed: a suffix change adds one uniform
    // constant to every polynomial hash and provably preserves sort order
    // (shipped broken once — ten test runs came back byte-identical).
    .map((job) => ({ rank: hash(`${daySeed()}::${job.company}`), job }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ job }) => ({
      company: displayName(job.company),
      job,
      lane: isTriggered(job) ? 'triggered' : 'random',
    }));
}

// ── contacts, facts, verification ────────────────────────────────────────────

interface SweepEntry {
  org: string | null;
  domain: string | null;
  matched: boolean;
}

interface Candidate extends CommitAuthor {
  verdict?: Verdict;
  gravatar?: boolean;
}

/**
 * companies.json is the bridge between catalogue display names and GitHub
 * orgs. Catalogue names are often the raw ATS *tenant* string ("valtech",
 * "tracelinkinc"), so a company's own board token is frequently the real org
 * slug. Indexed under both name and token, lowercased — sweep, catalogue and
 * companies.json disagree on casing constantly.
 */
async function buildCompanyIndex(): Promise<{
  byName: Map<string, { token: string; ats: string }>;
}> {
  const companies = await readJson<{ name: string; ats: string; token: string }[]>('companies.json', []);
  const byName = new Map<string, { token: string; ats: string }>();
  for (const c of companies) {
    if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), { token: c.token, ats: c.ats });
  }
  return { byName };
}

/**
 * Sweep entries are keyed by exact display name; lowercase both sides.
 *
 * Prefers the full local sweep, falls back to the committed index. The full
 * file is gitignored (1.6 MB, rewritten wholesale), so on a runner it is
 * simply absent — and without the fallback every hosted build resolves orgs
 * by guessing at ATS tokens and ignores everything the sweep already
 * established. See the comment on save() in src/contacts-sweep.ts.
 */
async function loadSweepLower(): Promise<Map<string, SweepEntry>> {
  const full = await readJson<Record<string, SweepEntry>>(SWEEP_PATH, {});
  const sweep =
    Object.keys(full).length > 0 ? full : await readJson<Record<string, SweepEntry>>(SWEEP_INDEX_PATH, {});
  return new Map(Object.entries(sweep).map(([k, v]) => [k.toLowerCase(), v]));
}

let companyIndex: Awaited<ReturnType<typeof buildCompanyIndex>> | null = null;
let sweepLower: Map<string, SweepEntry> | null = null;

async function resolveRecipients(
  company: string,
  tokenHint: string,
  want: number,
  state: OutreachState,
): Promise<Candidate[]> {
  companyIndex ??= await buildCompanyIndex();
  sweepLower ??= await loadSweepLower();

  const key = company.toLowerCase();
  const entry = sweepLower.get(key);
  const known = companyIndex.byName.get(key);
  // Org candidates in priority order: what the sweep verified → the
  // company's own ATS token (often IS the tenant/org slug) → the job-id
  // token hint → the raw name itself (covers tenant-named catalogues).
  const orgCandidates = [
    ...new Set(
      [entry?.org ?? null, known?.token ?? null, tokenHint.replace(/[^a-z0-9-]/gi, '').toLowerCase() || null, key].filter(
        (c): c is string => Boolean(c && c.length >= 2),
      ),
    ),
  ];

  /** SMTP verdict + Gravatar tie-break, shared by the git path and the npm path. */
  const finalize = async (candidates: Candidate[]): Promise<Candidate[]> => {
    // DMARC pre-flight, once per company domain: a published rua record is the
    // cheapest evidence the mail domain is real and managed before any probe.
    const firstDomain = candidates[0]?.email.split('@')[1];
    if (firstDomain) {
      try {
        if (!(await dmarcRua(firstDomain))) {
          console.log(`    ! ${firstDomain}: no DMARC published — extra caution on bounces`);
        }
      } catch {
        // DNS trouble must never block the discovery path.
      }
    }
    let probes = 0;
    for (const c of candidates) {
      const prior = state[c.email];
      const freshVerdict =
        prior?.verdict && prior?.verifiedAt &&
        Date.now() - new Date(prior.verifiedAt).getTime() < VERDICT_TTL_DAYS * 86_400_000;
      if (freshVerdict) {
        c.verdict = prior.verdict;
        continue;
      }
      if (probes >= MAX_PROBES_PER_COMPANY) break;
      probes++;
      try {
        const v = await verifyEmail(c.email);
        c.verdict = v.verdict;
        console.log(`    verify ${c.email} → ${v.verdict} (${v.reason})`);
      } catch {
        c.verdict = 'unknown';
      }
    }
    // invalid never reaches the page; unknown ships but tagged, valid clean.
    // For the unknowns (catch-all / gateway), one free positive signal:
    // a Gravatar registered to this exact address proves a human owns it.
    const result: Candidate[] = [];
    for (const c of candidates.filter((c) => c.verdict !== 'invalid').slice(0, want)) {
      if (c.verdict === 'unknown' && c.gravatar === undefined) {
        const prior = state[c.email];
        if (prior?.gravatar !== undefined && prior?.verifiedAt) {
          c.gravatar = prior.gravatar;
        } else {
          const g = await gravatarExists(c.email);
          if (g !== null) c.gravatar = g;
        }
      }
      result.push(c);
    }
    return result;
  };

  try {
    let found: Awaited<ReturnType<typeof githubContacts>> | null = null;
    let usedOrg: string | null = null;
    for (const org of orgCandidates.slice(0, 3)) {
      found = await githubContacts(org);
      if (found.domain) {
        usedOrg = org;
        break;
      }
    }
    /**
     * Fallback ladder, COLDMAIL-PLAN.md §1b: npm registry maintainers cover
     * companies whose GitHub org is named nothing like them or who publish
     * packages without a public org at all. Names exist on npm maintainers,
     * so these stay draft-composable; facts don't, so they ship un-facted.
     *
     * Both git misses reach this, not just the empty-handed one. The
     * wrong-company branch below used to `return []` outright, which meant a
     * company whose public repos are dominated by outside contributors got no
     * shot at npm or PyPI at all — Citi, Sprinklr, Logitech, LSEG and Unisys
     * all died there in one real run while their npm packages went unqueried.
     * Nothing is loosened by this: npmContacts/pypiContacts/mavenContacts all
     * apply the same domainMatchesOrg guard themselves, so a wrong-company
     * address still cannot ship.
     *
     * Maven Central is third, not second: it covers corporate Java/Android
     * SDKs specifically, a narrower slice than npm/PyPI's general-purpose
     * registries, so it only runs when both of those came up empty.
     */
    const alternates = async (why: string): Promise<Candidate[]> => {
      const reg = await npmContacts(company, want).catch(() => []);
      const py = reg.length === 0 ? await pypiContacts(company, want).catch(() => []) : [];
      const mvn = reg.length === 0 && py.length === 0 ? await mavenContacts(company, want).catch(() => []) : [];
      const alt = [...reg, ...py, ...mvn];
      if (alt.length === 0) {
        console.log(`    · ${company}: ${why}, no npm/PyPI/Maven contacts either`);
        return [];
      }
      console.log(`    · ${company}: ${why}; npm/PyPI/Maven gave ${alt.length} address(es)`);
      return finalize(alt.slice(0, MAX_PROBES_PER_COMPANY).map((r) => ({ name: r.name, email: r.email })));
    };

    if (!found || !found.domain || !usedOrg) {
      return await alternates(
        `no GitHub org with corporate-domain commits (tried ${orgCandidates.slice(0, 3).join(', ')})`,
      );
    }
    // Wrong-company guard: the domain must either match the org name or have
    // been accepted as matched by the sweep. Outside contributors fail this.
    if (!(found.domainMatchesOrg || (entry?.matched ?? false))) {
      return await alternates(`GitHub domain ${found.domain} does not match org ${usedOrg} — outside contributors?`);
    }

    const cutoff = Date.now() - FACT_MAX_AGE_DAYS * 86_400_000;
    const factual = found.authors.filter((a) => {
      if (!a.subject || !a.date) return false;
      const t = new Date(a.date).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    });
    const base = factual.length >= want ? factual : found.authors.filter((a) => a.subject);

    // Rank facts, don't just take them: a "fix: race in order matching"
    // beats "docs: replace screenshot" as an opener. Strong facts are
    // preferred; weak ones only backfill when the company is thin.
    const FACT_MIN_SCORE = Number(process.env.OUTREACH_MIN_FACT_SCORE ?? 3);
    const ranked = [...base].sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime(),
    );
    const strong = ranked.filter((c) => (c.score ?? 0) >= FACT_MIN_SCORE);
    const ordered =
      strong.length >= want
        ? strong
        : [...strong, ...ranked.filter((r) => !strong.includes(r))];
    const candidates: Candidate[] = ordered.slice(0, MAX_PROBES_PER_COMPANY).map((a) => ({ ...a }));

    return await finalize(candidates);
  } catch (error) {
    // Distinguish "no contact" from real trouble — a silent rate-limit death
    // would look exactly like a legitimate miss (the HANDOFF lesson).
    console.log(`    ! ${company}: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Gravatar existence check — a 200 on the avatar for this exact address
 * proves somebody registered it, which is near-proof the mailbox is live.
 * Positive-only: a 404 proves nothing. One plain HTTPS request, no mail
 * server involved, so it is safe where SMTP probing is not.
 */
export async function gravatarExists(addr: string): Promise<boolean | null> {
  const md5 = createHash('md5').update(addr.trim().toLowerCase()).digest('hex');
  try {
    const res = await fetch(`https://gravatar.com/avatar/${md5}?d=404`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

// ── drafts ───────────────────────────────────────────────────────────────────

export interface Draft {
  id: string;
  addr: string;
  name: string;
  firstName: string;
  company: string;
  role: string;
  location?: string;
  jobUrl: string;
  lane: 'triggered' | 'random';
  kind: 'first' | 'followup';
  touch: number;
  overdueDays: number;
  subject: string;
  body: string;
  gmailUrl: string;
  mailtoUrl: string;
  verdict?: Verdict;
  gravatar?: boolean;
  /** Prior async bounces recorded at this address's domain — risk memory. */
  domainRiskBounces?: number;
  fact?: string;
}

function composeLinks(addr: string, subject: string, body: string) {
  const q = (s: string) => encodeURIComponent(s);
  return {
    gmailUrl: `https://mail.google.com/mail/?view=cm&fs=1&to=${q(addr)}&su=${q(subject)}&body=${q(body)}`,
    mailtoUrl: `mailto:${addr}?subject=${q(subject)}&body=${q(body)}`,
  };
}

function buildFirstDraft(job: CatalogJob, author: Candidate, domainRiskBounces = 0): Draft {
  const company = displayName(job.company);
  const first = splitName(author.name)?.first ?? author.name.split(/\s+/)[0]!;
  const greet = pick(GREETINGS, author.email);
  const fact = `${pick(FACT_VERBS, author.name)} — “${author.subject}”.`;
  const loc = job.location ? ` in ${job.location}` : '';
  const exp = experienceLabel(job.minYears ?? null, job.maxYears ?? null);
  const ask = pick(ASK_T1, author.email + job.id);
  const roleLine = `${company} just opened a ${job.title.trim()}${loc}.${exp ? ` Band listed: ${exp}.` : ''}`;
  const body = renderBody({ greet, first, fact, roleLine, ask, passAlong: pick(PASS_ALONG, author.name) });
  const subject = pick(
    [`quick question re: ${job.title.toLowerCase().slice(0, 40)}`, `${company} ${job.title.toLowerCase().slice(0, 30)} — open?`],
    author.email,
  );
  return {
    id: author.email,
    addr: author.email,
    name: author.name,
    firstName: first,
    company,
    role: job.title,
    location: job.location,
    jobUrl: job.url,
    lane: isTriggered(job) ? 'triggered' : 'random',
    kind: 'first',
    touch: 0,
    overdueDays: 0,
    subject,
    body,
    ...composeLinks(author.email, subject, body),
    verdict: author.verdict,
    gravatar: author.gravatar,
    domainRiskBounces,
    fact: author.subject,
  };
}

function buildFollowUps(state: OutreachState): Draft[] {
  const now = Date.now();
  const drafts: Draft[] = [];
  for (const [addr, c] of Object.entries(state)) {
    if (c.skipped || c.replied || c.bounced) continue;
    if (c.touch <= 0 || c.touch >= TOUCH_GAPS.length) continue;
    const due = new Date(c.nextDueAt).getTime();
    if (Number.isNaN(due) || due > now) continue;
    const overdueDays = Math.floor((now - due) / 86_400_000);
    const daysSinceFirst = Math.round((now - new Date(c.sentAt[0]!).getTime()) / 86_400_000);
    const askPool = c.touch === 1 ? ASK_T2 : ASK_T3;
    const body = renderBody({
      greet: 'Hi',
      first: c.firstName ?? 'there',
      roleLine: `Following up on ${c.role} at ${c.company} — wrote ${daysSinceFirst} days ago.`,
      ask: pick(askPool, addr),
      passAlong: PASS_ALONG[c.touch % PASS_ALONG.length]!,
    });
    const subject = `re: ${c.subject}`;
    drafts.push({
      id: addr,
      addr,
      name: addr,
      firstName: c.firstName ?? 'there',
      company: c.company,
      role: c.role,
      jobUrl: c.jobUrl,
      lane: 'triggered',
      kind: 'followup',
      touch: c.touch,
      overdueDays,
      subject,
      body,
      ...composeLinks(addr, subject, body),
      verdict: c.verdict,
    });
  }
  return drafts.sort((a, b) => b.overdueDays - a.overdueDays);
}

export function enforceSimilarity<T extends { body: string }>(drafts: T[]): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const d of drafts) {
    const twin = kept.find((k) => bodySimilarity(k.body, d.body) > 0.8);
    (twin ? dropped : kept).push(d);
  }
  return { kept, dropped };
}

/**
 * Risk memory per mail domain: how many recorded bounces each domain has
 * produced. A catch-all gateway that ate one address probably ate others —
 * future ⚠ cards at that domain carry the warning forward.
 */
export function domainRiskTally(state: OutreachState): Map<string, number> {
  const tally = new Map<string, number>();
  for (const [addr, c] of Object.entries(state)) {
    if (!c.bounced || !c.sentAt?.length) continue;
    const domain = addr.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    tally.set(domain, (tally.get(domain) ?? 0) + 1);
  }
  return tally;
}

// ── batch ────────────────────────────────────────────────────────────────────

export interface Batch {
  followups: Draft[];
  random: Draft[];
  triggered: Draft[];
}

// ── bounce gate ──────────────────────────────────────────────────────────────

const BOUNCE_WINDOW_DAYS = Number(process.env.OUTREACH_BOUNCE_WINDOW_DAYS ?? 30);
const BOUNCE_MIN_SAMPLE = Number(process.env.OUTREACH_BOUNCE_MIN_SAMPLE ?? 15);
const BOUNCE_INCIDENT_RATE = 0.02;
/** Lifetime ratio that halts no matter how old the bounces are. */
const BOUNCE_BACKSTOP_RATE = 0.05;
const BOUNCE_BACKSTOP_MIN_SENDS = 50;

export interface GateInput {
  sentAt: string[];
  bounced?: boolean;
  bouncedAt?: string;
}

export interface GateDecision {
  halt: boolean;
  reason: string;
}

/**
 * Two gates replace a lifetime average, which froze on one bad week and went
 * blind under months of dilution:
 *
 *   incident — bounces vs sends inside a rolling WINDOW_DAYS window; this is
 *              the signal that catches "something broke recently" fast.
 *   backstop — lifetime ratio above BACKSTOP_RATE halts regardless of age;
 *              catches slow rot that never produces a sharp spike.
 *
 * A sparse window (paused outreach) stays silent until MIN_SAMPLE rebuilds,
 * because judging 3 sends tells you nothing.
 */
export function bounceGateDecision(contacts: GateInput[], now: number): GateDecision {
  const cutoff = now - BOUNCE_WINDOW_DAYS * 86_400_000;
  let windowSends = 0;
  let windowBounces = 0;
  let lifeSends = 0;
  let lifeBounces = 0;
  for (const c of contacts) {
    for (const s of c.sentAt ?? []) {
      lifeSends++;
      if (new Date(s).getTime() >= cutoff) windowSends++;
    }
    if (!c.bounced) continue;
    lifeBounces++;
    if (c.bouncedAt && new Date(c.bouncedAt).getTime() >= cutoff) windowBounces++;
  }

  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);

  if (
    windowSends >= BOUNCE_MIN_SAMPLE &&
    windowBounces / Math.max(windowSends, 1) > BOUNCE_INCIDENT_RATE
  ) {
    return {
      halt: true,
      reason: `HALTED: ${windowBounces}/${windowSends} sends in the last ${BOUNCE_WINDOW_DAYS}d bounced (${pct(windowBounces, windowSends)} > ${BOUNCE_INCIDENT_RATE * 100}%). Fix targeting before resuming.`,
    };
  }
  if (
    lifeSends >= BOUNCE_BACKSTOP_MIN_SENDS &&
    lifeBounces / Math.max(lifeSends, 1) > BOUNCE_BACKSTOP_RATE
  ) {
    return {
      halt: true,
      reason: `HALTED: lifetime bounces ${lifeBounces}/${lifeSends} (${pct(lifeBounces, lifeSends)} > ${BOUNCE_BACKSTOP_RATE * 100}%). List quality is rotting.`,
    };
  }
  return { halt: false, reason: `ok (${pct(windowBounces, windowSends)} window · ${pct(lifeBounces, lifeSends)} lifetime)` };
}

async function bounceGate(): Promise<boolean> {
  const state = await readJson<OutreachState>(STATE_PATH, {});
  const decision = bounceGateDecision(Object.values(state), Date.now());
  if (!decision.halt) return false;
  if (process.env.OUTREACH_IGNORE_BOUNCE === '1') {
    console.warn(`${decision.reason} — BYPASSED via OUTREACH_IGNORE_BOUNCE`);
    return false;
  }
  console.warn(decision.reason);
  return true;
}

async function buildBatch(): Promise<Batch> {
  if (await bounceGate()) return { followups: [], random: [], triggered: [] };
  const state = await readJson<OutreachState>(STATE_PATH, {});
  let budget = DAILY_BUDGET;

  const followups = buildFollowUps(state).slice(0, budget);
  budget -= followups.length;
  const riskTally = domainRiskTally(state);

  const random: Draft[] = [];
  const triggered: Draft[] = [];
  // Triggered lane builds every day — its value is time-since-posted and the
  // human chooses when to click. Only the random lane respects weekends.
  const weekend = [0, 6].includes(new Date().getDay()) && process.env.OUTREACH_WEEKEND !== '1';
  if (budget > 0 && process.env.OUTREACH_NO_NEW !== '1') {
    const catalog = await readJson<CatalogJob[]>(CATALOG_PATH, []);
    const pool = loadCompanyPool(catalog, state);

    // Select targets first (cheap, deterministic), then resolve contacts for
    // all of them in parallel — serial SMTP probing made full-day builds take
    // tens of minutes when gateways tarpitted.
    const selected: CompanyTarget[] = [];
    const usedCompanies = new Set<string>();
    for (const lane of ['triggered', 'random'] as const) {
      if (weekend && lane === 'random') continue;
      const cap = Math.min(lane === 'triggered' ? TRIGGERED_BUDGET : RANDOM_BUDGET, budget);
      let picked = 0;
      for (const target of pool) {
        if (picked >= cap) break;
        if (target.lane !== lane || usedCompanies.has(target.company.toLowerCase())) continue;
        usedCompanies.add(target.company.toLowerCase());
        selected.push(target);
        picked++;
      }
    }

    const concurrency = Number(process.env.OUTREACH_RESOLVE_CONCURRENCY ?? 6);
    const resolved = await mapLimit(selected, concurrency, async (target) => ({
      target,
      recipients: await resolveRecipients(target.company, target.job.id.split(':')[1] ?? '', 2, state),
    }));

    for (const { target, recipients } of resolved) {
      if (budget <= 0) break;
      if (recipients.length === 0) {
        console.log(`  · ${target.company}: no usable contact, skipped`);
        continue;
      }
      const laneArr = target.lane === 'triggered' ? triggered : random;
      const cap = Math.min(target.lane === 'triggered' ? TRIGGERED_BUDGET : RANDOM_BUDGET, DAILY_BUDGET);
      for (const author of recipients) {
        if (budget <= 0 || laneArr.length >= cap) break;
        if (state[author.email]) continue;
        laneArr.push(
          buildFirstDraft(
            target.job,
            author,
            riskTally.get(author.email.split('@')[1]?.toLowerCase() ?? '') ?? 0,
          ),
        );
        budget--;
      }
    }
  }

  const all = [...followups, ...random, ...triggered];
  const { kept } = enforceSimilarity(all);
  const keepIds = new Set(kept.map((d) => d.id));
  const filterLane = (arr: Draft[]) => arr.filter((d) => keepIds.has(d.id));
  return { followups: filterLane(followups), random: filterLane(random), triggered: filterLane(triggered) };
}

// ── server ───────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function card(d: Draft): string {
  const badges = [
    d.verdict === 'valid' ? '<span class="ok">verified</span>' : '',
    d.verdict === 'unknown'
      ? `<span class="warn">unverified${d.gravatar ? ' · gravatar✓' : ''}</span>`
      : '',
    d.domainRiskBounces
      ? `<span class="late">⚠ ${d.domainRiskBounces} prior bounce${d.domainRiskBounces > 1 ? 's' : ''} at this domain</span>`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="card" id="c-${esc(d.id)}">
  <div class="head"><b>${esc(d.company)}</b> · ${esc(d.role)} · touch ${d.touch + 1} · ${d.lane}
    ${d.kind === 'followup' && d.overdueDays > 0 ? `<span class="late">${d.overdueDays}d overdue</span>` : ''}
    ${badges}
  </div>
  <div class="to">to: ${esc(d.addr)}</div>
  <pre>${esc(d.body)}</pre>
  <div class="btns">
    <a class="btn primary" href="${actionUrl(`outreach/open/${encodeURIComponent(d.id)}`)}">Open in Gmail</a>
    <a class="btn" href="${actionUrl(`outreach/mailapp/${encodeURIComponent(d.id)}`)}">Mail app</a>
    <a class="btn ghost" href="${actionUrl(`outreach/replied/${encodeURIComponent(d.id)}`)}">Replied</a>
    <a class="btn ghost" href="${actionUrl(`outreach/bounce/${encodeURIComponent(d.id)}`)}">Bounced</a>
    <a class="btn ghost" href="${actionUrl(`outreach/skip/${encodeURIComponent(d.id)}`)}">Skip</a>
  </div>
</div>`;
}

/** Addresses mailed recently whose delayed NDR may still arrive days later. */
export function recentlySent(
  state: OutreachState,
): { addr: string; company: string; role: string; daysAgo: number }[] {
  const cutoff = Date.now() - 21 * 86_400_000;
  return Object.entries(state)
    .filter(([addr, c]) => c.touch >= 1 && !c.bounced && !c.replied && addr.includes('@'))
    .map(([addr, c]) => ({
      addr,
      company: c.company,
      role: c.role,
      daysAgo: Math.floor((Date.now() - new Date(c.sentAt[c.sentAt.length - 1] ?? c.nextDueAt).getTime()) / 86_400_000),
    }))
    .filter((r) => Number.isFinite(r.daysAgo) && r.daysAgo >= 0 && Date.now() - r.daysAgo * 86_400_000 >= cutoff)
    .sort((a, b) => a.daysAgo - b.daysAgo)
    .slice(0, 12);
}

function recentRows(recent: ReturnType<typeof recentlySent>): string {
  if (recent.length === 0) return '<div class="count">nothing in flight</div>';
  return `<table width="100%">${recent
    .map(
      (r) => `<tr><td>${esc(r.addr)}</td><td>${esc(r.company)}</td><td>${r.daysAgo}d ago</td>
    <td><a href="/bounce/${encodeURIComponent(r.addr)}">mark bounced</a> · <a href="/replied/${encodeURIComponent(r.addr)}">replied</a></td></tr>`,
    )
    .join('')}</table>`;
}

function page(b: Batch, recent: ReturnType<typeof recentlySent>): string {
  const total = b.followups.length + b.random.length + b.triggered.length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>outreach — ${daySeed()}</title><style>
body{font-family:ui-monospace,monospace;background:#111;color:#ddd;max-width:780px;margin:24px auto;padding:0 12px}
h1{font-size:18px}.count{color:#666;font-size:12px;margin-bottom:4px}
h2{font-size:13px;color:#9ab;margin-top:28px;text-transform:uppercase;letter-spacing:.08em}
.card{border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:14px;background:#181818}
.head{color:#fff;margin-bottom:4px}.to{color:#888;font-size:12px;margin-bottom:8px}
pre{white-space:pre-wrap;font-size:13px;line-height:1.45;color:#ccc;border-left:3px solid #2a4a2a;padding-left:10px}
.late{color:#f66}.ok{color:#7dcf95;font-size:11px;margin-left:6px}.warn{color:#e0b050;font-size:11px;margin-left:6px}
.btns{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:5px 12px;border-radius:6px;background:#26364a;color:#cfe3ff;text-decoration:none;font-size:13px}
.primary{background:#1a4a2e;color:#bfe8c8}.ghost{background:#222;color:#777}
a.refresh{color:#569;font-size:12px}</style></head><body>
<h1>outreach — ${daySeed()}</h1>
<div class="count">${b.followups.length} follow-ups + ${b.triggered.length} role-triggered + ${b.random.length} random = <b>${total}</b> clicks today · <a class="refresh" href="/refresh">↻ rebuild</a></div>
<h2>follow-ups due (${b.followups.length})</h2>${b.followups.map(card).join('')}
<h2>role just opened (${b.triggered.length})</h2>${b.triggered.map(card).join('')}
<h2>open roles, rotating list (${b.random.length})</h2>${b.random.map(card).join('')}
<h2>in flight — delayed bounces land here (mark when the NDR arrives)</h2>
<div class="count">${recentRows(recent)}</div>
</body></html>`;
}

async function markSent(state: OutreachState, d: Draft): Promise<void> {
  const now = new Date().toISOString();
  const prev = state[d.addr];
  state[d.addr] = {
    company: d.company,
    role: d.role,
    location: d.location,
    jobUrl: d.jobUrl,
    firstName: d.firstName,
    touch: (prev?.touch ?? 0) + 1,
    sentAt: [...(prev?.sentAt ?? []), now],
    nextDueAt: nextDueAt(now, (prev?.touch ?? 0) + 1),
    fact: prev?.fact ?? d.fact,
    subject: d.subject,
    verdict: prev?.verdict ?? d.verdict,
    verifiedAt: prev?.verifiedAt ?? new Date().toISOString(),
    gravatar: prev?.gravatar ?? d.gravatar,
    replied: prev?.replied,
    skipped: prev?.skipped,
    bounced: prev?.bounced,
  };
  await saveState(state);
}

async function flag(
  state: OutreachState,
  id: string,
  flagName: 'replied' | 'skipped' | 'bounced',
): Promise<void> {
  const cur = state[id];
  if (!cur) return;
  cur[flagName] = true;
  if (flagName === 'bounced') {
    cur.skipped = true; // a bounce suppresses forever
    cur.bouncedAt = new Date().toISOString();
  }
  await saveState(state);
}

async function serve(initial: Batch): Promise<void> {
  // Batch lives in memory; clicks mutate/remove cards; reload never refetches
  // GitHub. Only /refresh pays for a rebuild.
  let batch = initial;
  const byId = new Map<string, Draft>();
  const index = (b: Batch) => {
    byId.clear();
    [...b.followups, ...b.triggered, ...b.random].forEach((d) => byId.set(d.id, d));
  };
  index(batch);

  const take = (id: string): Draft | undefined => {
    const d = byId.get(id);
    if (d) {
      byId.delete(id);
      batch.followups = batch.followups.filter((x) => x.id !== id);
      batch.random = batch.random.filter((x) => x.id !== id);
      batch.triggered = batch.triggered.filter((x) => x.id !== id);
    }
    return d;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [action, rawId] = seg;
    try {
      const st = await readJson<OutreachState>(STATE_PATH, {});
      if ((action === 'open' || action === 'mailapp') && rawId) {
        const d = take(rawId);
        if (d) {
          await markSent(st, d);
          res.writeHead(302, { location: action === 'open' ? d.gmailUrl : d.mailtoUrl });
          res.end();
          return;
        }
      } else if (action === 'replied' || action === 'skip' || action === 'bounce') {
        // Works for in-flight addresses even after their card left the page —
        // delayed NDRs arrive days later; the state file outlives the batch.
        take(rawId ?? '');
        await flag(st, rawId!, action === 'bounce' ? 'bounced' : (action as 'replied' | 'skipped'));
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      } else if (action === 'refresh') {
        batch = await buildBatch();
        index(batch);
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(batch, recentlySent(st)));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  });

  server.listen(PORT, () => {
    const total = initial.followups.length + initial.random.length + initial.triggered.length;
    console.log(`\noutreach ready → http://localhost:${PORT}`);
    console.log(`(${total} cards: ${initial.followups.length} follow-ups, ${initial.triggered.length} triggered, ${initial.random.length} random)`);
  });
}

// ── cli ──────────────────────────────────────────────────────────────────────
// Guarded exactly like contacts.ts: importing this module (selftest does)
// must never trigger the network build or the pidfile lock.

const args = process.argv.slice(2);

if (process.argv[1]?.endsWith('outreach.ts')) {
  if (!(await acquireLock())) process.exit(1);

  const batch = await buildBatch();
  console.log(`batch: ${batch.followups.length} follow-ups + ${batch.triggered.length} triggered + ${batch.random.length} random`);
  for (const d of [...batch.followups, ...batch.triggered, ...batch.random]) {
    const v = d.verdict === 'valid' ? '✓' : d.verdict === 'unknown' ? '?' : '-';
    console.log(`  [t${d.touch + 1}] ${d.company.padEnd(20)} ${d.addr.padEnd(32)} ${v} ${d.fact ? `"${d.fact.slice(0, 40)}"` : ''}`);
  }

  if (args.includes('--serve')) {
    await serve(batch);
  } else if (!args.includes('--print')) {
    // buildBatch() computed a fresh SMTP verdict (and gravatar check, for
    // catch-all/unknown addresses) per candidate, but only held it on the
    // in-memory Draft — nothing persisted it. Every static build was
    // therefore re-probing every address from scratch, silently defeating the
    // 14-day verdict cache this same file documents elsewhere. Fold the
    // results back into state before writing the page, merging rather than
    // overwriting so an address that already has send history keeps it.
    const freshState = await readJson<OutreachState>(STATE_PATH, {});
    const now = new Date().toISOString();
    for (const d of [...batch.followups, ...batch.triggered, ...batch.random]) {
      const prev = freshState[d.addr];
      freshState[d.addr] = {
        company: prev?.company ?? d.company,
        role: prev?.role ?? d.role,
        location: prev?.location ?? d.location,
        jobUrl: prev?.jobUrl ?? d.jobUrl,
        firstName: prev?.firstName ?? d.firstName,
        touch: prev?.touch ?? 0,
        sentAt: prev?.sentAt ?? [],
        nextDueAt: prev?.nextDueAt ?? now,
        fact: prev?.fact ?? d.fact,
        subject: prev?.subject ?? d.subject,
        verdict: d.verdict,
        gravatar: d.gravatar ?? prev?.gravatar,
        verifiedAt: now,
        replied: prev?.replied,
        skipped: prev?.skipped,
        bounced: prev?.bounced,
        bouncedAt: prev?.bouncedAt,
      };
    }
    await saveState(freshState);

    await mkdir('out/outbox', { recursive: true });
    await writeFile(PAGE_PATH, page(batch, recentlySent(freshState)), 'utf8');
    console.log(`static page written → ${PAGE_PATH}`);
    // Deployed mode companion: the hosted click-API needs each draft's
    // redirect targets (the Gmail/mailto URLs are computed at build time from
    // subject+body, and the API route never sees them otherwise).
    const drafts = Object.fromEntries(
      [...batch.followups, ...batch.triggered, ...batch.random].map((d) => [
        d.id,
        { gmailUrl: d.gmailUrl, mailtoUrl: d.mailtoUrl, company: d.company, role: d.role, touch: d.touch },
      ]),
    );
    await writeFile('out/outbox/batch.json', `${JSON.stringify(drafts, null, 2)}\n`, 'utf8');
    console.log(`draft map written → out/outbox/batch.json`);
  }
}
