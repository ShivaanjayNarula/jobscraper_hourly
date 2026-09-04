/**
 * Additional contact-discovery sources beyond git-commit metadata.
 *
 * COLDMAIL-PLAN.md's "rest of the ladder" listed these; only source 1 (git
 * commits, in contacts.ts) was built. This file implements the next three,
 * all free and unauthenticated:
 *
 *   1b. npm registry — maintainers/author emails on packages published by or
 *       for the company. Covers companies whose GitHub org is named nothing
 *       like the company, or who publish packages without a public org at all.
 *   3.  Role addresses — careers@/jobs@/hr@... at a known domain. No name, so
 *       not draft-composable today (buildFirstDraft needs a person), but it is
 *       the floor for companies with no public engineers anywhere.
 *   5.  Company website surfaces — mailto: links and plaintext addresses on
 *       their own pages. Mostly confirms domain + pattern rather than people.
 *
 * Gravatar existence checks are deliberately NOT duplicated here — outreach.ts
 * already has gravatarExists() on the verification path.
 */
import { domainMatchesOrg, isCorporateAddress } from './contacts.js';
import { resolveTxt } from 'node:dns/promises';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'jobscraper-next' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

// ── 1b. npm registry ─────────────────────────────────────────────────────────

export interface RegistryContact {
  name: string;
  email: string;
  /** Package that yielded this address — provenance when a human reviews. */
  viaPackage: string;
}

/**
 * Search npm for packages whose name matches the company, then read each
 * package's latest manifest for maintainer/author addresses.
 *
 * The /latest endpoint returns just the newest manifest instead of every
 * version ever published — `registry.npmjs.org/left-pad` is megabytes, its
 * /latest document is kilobytes.
 *
 * The domainMatchesOrg guard here does the same job it does in contacts.ts:
 * npm hosts thousands of community packages named after companies they have
 * nothing to do with (`slack` the CLI tool predates Slack-the-company). An
 * address only counts if its domain plausibly belongs to the company.
 */
export async function npmContacts(company: string, limit = 10): Promise<RegistryContact[]> {
  const searchUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(company)}&size=25`;
  const results = (await getJson(searchUrl)) as { objects?: { package?: { name?: string } }[] };
  const names = (results.objects ?? [])
    .map((o) => o.package?.name)
    .filter((n): n is string => Boolean(n))
    .slice(0, 15);

  const byEmail = new Map<string, RegistryContact>();
  for (const name of names) {
    try {
      const manifest = (await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as {
        maintainers?: { name?: string; email?: string }[];
        author?: { email?: string; name?: string } | string;
      };
      const entries: { name?: string; email?: string }[] = [...(manifest.maintainers ?? [])];
      if (typeof manifest.author === 'object' && manifest.author?.email) entries.push(manifest.author);
      for (const entry of entries) {
        const email = entry.email?.toLowerCase().trim();
        if (!email || !isCorporateAddress(email)) continue;
        const domain = email.split('@')[1] ?? '';
        if (!domain || !domainMatchesOrg(company, domain)) continue;
        if (!byEmail.has(email)) {
          byEmail.set(email, {
            name: entry.name?.trim() || email.split('@')[0]!,
            email,
            viaPackage: name,
          });
        }
        if (byEmail.size >= limit) return [...byEmail.values()];
      }
    } catch {
      continue; // Unpublished-in-practice or deleted package; move on.
    }
    await sleep(150); // Politeness; npm has no published rate limit but bursts look like abuse.
  }
  return [...byEmail.values()];
}

// ── 5. Company website surfaces ──────────────────────────────────────────────

/** Pull mailto: targets plus bare email-shaped strings out of an HTML page. */
export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const mailtos = html.matchAll(/mailto:([^"'?>\s]+)/gi);
  for (const m of mailtos) found.add(decodeURIComponent(m[1]!).trim().toLowerCase());
  // Plaintext fallback catches "hr@company.com" rendered as plain text, but it
  // also matches everything inside the mailto: URIs above — hence the set.
  const bare = html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  for (const m of bare) found.add(m[0].toLowerCase());
  return [...found].filter(isCorporateAddress);
}

/** Root domain from a host ("careers.zerodha.com" → "zerodha.com"), crude but
 *  enough to accept subdomain-hosted addresses without accepting strangers. */
function rootDomain(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  return parts.slice(-2).join('.');
}

export interface WebsiteContact {
  email: string;
  path: string;
}

const PAGE_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/careers', '/team'];

/**
 * Scan the company site's obvious pages for published addresses.
 *
 * Only addresses on the site's own root domain (or matching the company name)
 * survive: third-party addresses on those pages are recruiters, agencies and
 * chat-widget vendors, and mailing them is worse than useless.
 */
export async function websiteContacts(siteUrl: string, companyName: string): Promise<WebsiteContact[]> {
  const base = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
  const hostRoot = rootDomain(base.hostname);
  const out = new Map<string, WebsiteContact>();
  for (const path of PAGE_PATHS) {
    try {
      const res = await fetch(new URL(path, base).toString(), {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'follow',
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('html')) continue;
      const emails = extractEmails(await res.text());
      for (const email of emails) {
        const domain = email.split('@')[1] ?? '';
        if (rootDomain(domain) === hostRoot || domainMatchesOrg(companyName, domain)) {
          if (!out.has(email)) out.set(email, { email, path: path || '/' });
        }
      }
    } catch {
      continue; // Dead path or blocked page; the other paths still count.
    }
  }
  return [...out.values()];
}

// ── 2b. Leadership page — a named senior contact, when git/npm find nobody ──

export interface LeadershipContact {
  name: string;
  title: string;
}

const LEADERSHIP_PATHS = ['/about', '/about-us', '/company', '/company/about', '/company/leadership', '/leadership', '/team'];

/**
 * Engineering-tier titles are checked first and preferred over the exec
 * tier below — a fresher/junior engineer's cold email reads as a natural
 * peer-adjacent ask to a CTO or engineering manager, and as a seniority
 * mismatch to a CEO. Both tiers live on the same page in practice, so one
 * scrape covers both; only the ranking at the end decides which one ships.
 */
const ENGINEERING_TITLE =
  /\b(CTO|Chief Technology Officer|VP\s*,?\s*Engineering|Vice President\s*,?\s*Engineering|Head of Engineering|Engineering Manager|Director of Engineering)\b/i;
const EXEC_TITLE = /\b(CEO|Chief Executive Officer|Co-?Founder|Founder|President)\b/i;
const TITLE_RE = new RegExp(`(?:${ENGINEERING_TITLE.source})|(?:${EXEC_TITLE.source})`, 'i');

// 2-3 capitalized words, nothing longer — long enough for "Sridhar Vembu" or
// "Mary Jo Watson", short enough to reject a sentence that happens to start
// with a capital ("The Government of India has bestowed...").
const NAME_RE = /^[A-Z][a-zA-Z.'-]{1,20}(?:\s+[A-Z][a-zA-Z.'-]{1,20}){1,2}$/;

/**
 * HTML to text that keeps block-element boundaries as line breaks, unlike
 * `toPlainText` (workday.ts) which collapses everything to one run-on
 * string. A name and its title almost always sit in separate DOM elements
 * (`<h3>Name</h3><p>Title</p>`), so collapsing them loses the only signal
 * that says which word-pair goes together — measured directly: naive
 * regex-on-collapsed-text found zero real name+title pairs across a sample
 * of real leadership pages that block-aware line splitting found cleanly.
 */
function blockAwareLines(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/td)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Pure extraction, exported for fixture testing without a network call. A
 * title line is checked against its immediate neighbours for a name-shaped
 * line — most layouts put the title directly after the name, some before.
 */
export function extractLeadership(html: string): LeadershipContact[] {
  const lines = blockAwareLines(html);
  const found = new Map<string, LeadershipContact>();
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i]!;
    if (title.length > 60 || !TITLE_RE.test(title)) continue;
    for (const cand of [lines[i - 1], lines[i + 1]]) {
      if (cand && NAME_RE.test(cand) && !TITLE_RE.test(cand) && !found.has(cand)) {
        found.set(cand, { name: cand, title });
        break;
      }
    }
  }
  // Engineering-tier titles first — see the comment on ENGINEERING_TITLE above.
  return [...found.values()].sort(
    (a, b) => Number(!ENGINEERING_TITLE.test(a.title)) - Number(!ENGINEERING_TITLE.test(b.title)),
  );
}

/**
 * A named senior contact from the company's own "about"/"leadership" page —
 * a fallback for when git/npm/PyPI/Maven found nobody at all, not a
 * replacement for a real commit author. Plain `fetch` only: a page that
 * renders its team list client-side (common among modern SPA marketing
 * sites) returns nothing here rather than paying for a headless browser on
 * every company — that escalation is deliberately not built until a real
 * measured need shows up, same rule `curlJson`'s doc comment states for
 * Workday's curl fallback.
 */
export async function leadershipContacts(siteUrl: string): Promise<LeadershipContact[]> {
  const base = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
  const found = new Map<string, LeadershipContact>();
  for (const path of LEADERSHIP_PATHS) {
    try {
      const res = await fetch(new URL(path, base).toString(), {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'follow',
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('html')) continue;
      for (const hit of extractLeadership(await res.text())) {
        if (!found.has(hit.name)) found.set(hit.name, hit);
      }
    } catch {
      continue; // Dead path or blocked page; the other paths still count.
    }
  }
  return [...found.values()].sort(
    (a, b) => Number(!ENGINEERING_TITLE.test(a.title)) - Number(!ENGINEERING_TITLE.test(b.title)),
  );
}

// ── 3. Role addresses ────────────────────────────────────────────────────────

export const ROLE_MAILBOXES = ['careers', 'jobs', 'hiring', 'talent', 'hr', 'recruit'] as const;

/** Candidates only — verify-email must confirm before any of these ship. */
export function roleAddresses(domain: string): string[] {
  return ROLE_MAILBOXES.map((box) => `${box}@${domain}`);
}

// ── 5b. DMARC pre-flight ─────────────────────────────────────────────────────

/** Pull the rua aggregate-report address out of DMARC TXT records, if any.
 *  Pure so selftest can cover the parsing without network. */
export function parseDmarcRua(records: string[]): string | null {
  const joined = records.join(' ');
  const m = /rua=mailto:([^;\s"]+)/i.exec(joined);
  return m ? m[1]!.toLowerCase() : null;
}

const dmarcCache = new Map<string, string | null>();

/**
 * Does this domain publish live, managed mail infrastructure?
 *
 * The rua mailbox itself is useless as a target — nobody reads aggregates —
 * but its presence is one free DNS query proving the domain runs DMARC before
 * anything gets probed or sent to it. Absence proves nothing (Razorpay
 * publishes none); presence is a positive signal worth a warning when missing.
 */
export async function dmarcRua(domain: string): Promise<string | null> {
  if (dmarcCache.has(domain)) return dmarcCache.get(domain)!;
  let rua: string | null = null;
  try {
    const records = await resolveTxt(`_dmarc.${domain}`);
    rua = parseDmarcRua(records.flat());
  } catch {
    // NXDOMAIN / no TXT — absence is a finding, not an error.
  }
  dmarcCache.set(domain, rua);
  return rua;
}

/** Package-name candidates to probe on a registry for a company. Pure. */
export function packageNameCandidates(company: string): string[] {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug.length < 2) return [];
  return [...new Set([slug, `${slug}-sdk`, `${slug}sdk`, `${slug}-python`, `${slug}py`])];
}

// ── 2b. PyPI author emails ───────────────────────────────────────────────────

export interface PypiContact extends RegistryContact {}

/**
 * Same trick as npmContacts against PyPI manifests.
 *
 * PyPI has no JSON search API and its search page bot-walls non-browsers,
 * so this probes exact package-name candidates instead — the company slug
 * plus common SDK suffixes. Coverage is narrower than npm's search but the
 * hits are real: `razorpay`, `kiteconnect`, `snowflake-connector-python` all
 * publish corporate author addresses. Freemail and wrong-domain results are
 * dropped by the same guards as everywhere else (`paytm` on PyPI is owned by
 * an unrelated developer; its address must never ship).
 */
export async function pypiContacts(company: string, limit = 10): Promise<PypiContact[]> {
  const byEmail = new Map<string, PypiContact>();
  for (const name of packageNameCandidates(company)) {
    try {
      const manifest = (await getJson(`https://pypi.org/pypi/${name}/json`)) as {
        info?: {
          author_email?: string | null;
          maintainer_email?: string | null;
          project_urls?: Record<string, string> | null;
        };
      };
      const info = manifest.info ?? {};
      const emails = [info.author_email, info.maintainer_email]
        .flatMap((e) => (e ? e.split(',') : []))
        // PyPI fields often arrive as 'Name <addr>' or with stray quotes.
        .map((raw) => {
          const angled = /<([^>]+)>/.exec(raw);
          return (angled ? angled[1]! : raw).trim().toLowerCase();
        })
        .filter(isCorporateAddress);
      for (const email of emails) {
        const domain = email.split('@')[1] ?? '';
        if (!domain || !domainMatchesOrg(company, domain)) continue;
        if (!byEmail.has(email)) byEmail.set(email, { name: name, email, viaPackage: name });
        if (byEmail.size >= limit) return [...byEmail.values()];
      }
    } catch {
      continue; // 404 = no such package, the common case.
    }
    await sleep(150);
  }
  return [...byEmail.values()];
}

// ── 2c. Maven Central developer emails ──────────────────────────────────────

export interface MavenContact extends RegistryContact {}

/**
 * Same idea as npm/PyPI against a third registry, but a different mechanism:
 * Maven Central's search API returns no author/email fields at all, so the
 * address has to come from the artifact's own POM file, which corporate Java/
 * Android libraries commonly publish a `<developers>` block into.
 *
 * Checked crates.io and RubyGems for the same trick first and both are dead
 * ends — crates.io's public API only ever returns a linked GitHub username via
 * `/owners`, never an email, and RubyGems' `email` field came back null on
 * every real gem probed (stripe, twilio, sendgrid-ruby, razorpay, rails).
 * Maven Central's POM path is real: `com.razorpay:razorpay-java`'s POM
 * live-verified `developers@razorpay.com` in a `<developers>` block.
 *
 * `groupId` is guessed from the company slug under the handful of prefixes
 * corporate Java packages actually use (reverse-domain convention), not
 * searched freely — Maven Central's search API has no free-text "packages
 * roughly named X" mode like npm's.
 */
const MAVEN_GROUP_PREFIXES = ['com', 'io', 'org', 'in'];

export async function mavenContacts(company: string, limit = 10): Promise<MavenContact[]> {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug.length < 2) return [];

  const byEmail = new Map<string, MavenContact>();
  for (const prefix of MAVEN_GROUP_PREFIXES) {
    const groupId = `${prefix}.${slug}`;
    let hits: { g: string; a: string; latestVersion: string }[];
    try {
      const search = (await getJson(
        `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(`g:${groupId}`)}&rows=5&wt=json`,
      )) as { response?: { docs?: { g: string; a: string; latestVersion: string }[] } };
      hits = search.response?.docs ?? [];
    } catch {
      continue;
    }
    for (const hit of hits.slice(0, 3)) {
      const groupPath = hit.g.replace(/\./g, '/');
      const pomUrl = `https://repo1.maven.org/maven2/${groupPath}/${hit.a}/${hit.latestVersion}/${hit.a}-${hit.latestVersion}.pom`;
      let xml: string;
      try {
        const res = await fetch(pomUrl, { headers: { 'user-agent': 'jobscraper-next' }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        xml = await res.text();
      } catch {
        continue;
      }
      // Scoped to the <developers> block, and to one <developer> entry at a
      // time — a POM's <organization>/<scm> tags can carry unrelated
      // addresses (a parent-POM contact, a CI bot), and pairing name to
      // email by position rather than by shared <developer> block would
      // mismatch them the moment an artifact lists more than one person.
      const block = /<developers>([\s\S]*?)<\/developers>/.exec(xml)?.[1] ?? '';
      for (const devMatch of block.matchAll(/<developer>([\s\S]*?)<\/developer>/g)) {
        const dev = devMatch[1]!;
        const email = /<email>\s*([^<\s]+@[^<\s]+)\s*<\/email>/.exec(dev)?.[1]?.toLowerCase().trim();
        if (!email || !isCorporateAddress(email)) continue;
        const domain = email.split('@')[1] ?? '';
        if (!domain || !domainMatchesOrg(company, domain)) continue;
        if (!byEmail.has(email)) {
          const name = /<name>\s*([^<]+?)\s*<\/name>/.exec(dev)?.[1] ?? email.split('@')[0]!;
          byEmail.set(email, { name, email, viaPackage: hit.a });
        }
        if (byEmail.size >= limit) return [...byEmail.values()];
      }
      await sleep(150);
    }
  }
  return [...byEmail.values()];
}

// ── 2d. SmartRecruiters requisition creators ─────────────────────────────────

export interface SmartRecruitersCreator {
  name: string;
  jobTitle: string;
  postingUrl: string;
}

/**
 * Every SmartRecruiters posting publicly names the person who created the
 * requisition (`creator.name`) — live-verified 2026-09-02 against a real
 * board (Werner & Mertz GmbH → "Carolin Reichert"), no auth, same list call
 * the fetcher already makes for job data itself.
 *
 * This is a name, never an address — unlike npm/PyPI/Maven, SmartRecruiters
 * has nothing resembling an email field anywhere in the public API. A name
 * alone is useless without a domain and address pattern to attach it to, so
 * callers must already know both (from the git source) before this is worth
 * calling; `resolveRecipients()` does exactly that, applying `applyPattern()`
 * to turn each name here into a candidate address.
 */
export async function smartRecruitersCreators(token: string, limit = 10): Promise<SmartRecruitersCreator[]> {
  const data = (await getJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`,
  )) as { content?: { name?: string; id?: string; creator?: { name?: string } }[] };

  const byName = new Map<string, SmartRecruitersCreator>();
  for (const p of data.content ?? []) {
    const name = p.creator?.name?.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      jobTitle: p.name ?? '',
      postingUrl: p.id ? `https://jobs.smartrecruiters.com/${token}/${p.id}` : '',
    });
    if (byName.size >= limit) break;
  }
  return [...byName.values()];
}

// ── 7. ApplyBolt public endpoint ─────────────────────────────────────────────

export interface ApplyBoltResult {
  name: string;
  email: string;
  title?: string;
}

/** Pure: normalize the endpoint's response shape into a contact or nothing. */
export function parseApplyBolt(body: unknown): ApplyBoltResult | null {
  const r = body as { found?: boolean; email?: string; validation?: string; fullName?: string; jobTitle?: string };
  if (!r || r.found !== true || typeof r.email !== 'string' || !r.email.includes('@')) return null;
  return { name: r.fullName?.trim() || r.email.split('@')[0]!, email: r.email.toLowerCase().trim(), title: r.jobTitle };
}

let applyboltDeadUntil = 0;

/**
 * Look up one person's work email by their public LinkedIn profile URL, via
 * ApplyBolt's unauthenticated endpoint.
 *
 * Status history: measured 502-dead on 2026-08-21, live again on 2026-08-26
 * (3x HTTP 200 at ~1s). No SLA and no contract — so this is OFF by default
 * (APPLYBOLT_ENABLED=1), retries transient failures once, and a hard failure
 * cools the endpoint down for the rest of the process instead of being
 * re-tried per call. It does the LinkedIn-scraping step nobody can safely do
 * themselves; what it cannot do is find the right profile URL — callers must
 * already have one.
 */
export async function applyboltLookup(linkedinUrl: string): Promise<ApplyBoltResult | null> {
  if (process.env.APPLYBOLT_ENABLED !== '1') return null;
  if (Date.now() < applyboltDeadUntil) return null;
  const body = JSON.stringify({ linkedinUrl });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.applybolt.app/public/findEmailByLinkedIn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseApplyBolt(await res.json());
    } catch (error) {
      // A second failure (or an explicit 5xx) means the endpoint is down:
      // cool it off rather than burning 15s timeouts on every later call.
      const message = (error as Error).message;
      if (attempt === 1 || /^HTTP 5/.test(message)) {
        applyboltDeadUntil = Date.now() + 30 * 60_000;
        return null;
      }
      await sleep(2_000);
    }
  }
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('contact-sources.ts')) {
  const args = process.argv.slice(2);
  const [company, site, domainArg] = args;
  if (company && company.startsWith('http') && company.includes('linkedin.com')) {
    // Single-profile lookup mode: npm run contact-find -- https://linkedin.com/in/...
    const hit = await applyboltLookup(company);
    console.log(hit ? `${hit.email}  (${hit.name}${hit.title ? `, ${hit.title}` : ''})` : 'no result (disabled? down? not found)');
    process.exit(0);
  }
  if (!company) {
    console.log('usage: npm run contact-find -- "Company Name" https://company.com [mail-domain]');
    console.log('  runs npm registry + website scans and lists role-address candidates.');
    console.log('  (For git commits use the existing: npm run contacts -- <org>)');
    process.exit(args.length > 0 ? 1 : 0);
  }

  console.log(`npm registry — packages matching "${company}"`);
  const reg = await npmContacts(company).catch((e: Error) => {
    console.log(`  ! ${e.message}`);
    return [];
  });
  if (reg.length === 0) console.log('  (nothing corporate)');
  for (const c of reg) console.log(`  ${c.email.padEnd(34)} ${c.name}  (${c.viaPackage})`);

  console.log(`\nPyPI — packages named like "${company}"`);
  const py = await pypiContacts(company).catch((e: Error) => {
    console.log(`  ! ${e.message}`);
    return [];
  });
  if (py.length === 0) console.log('  (nothing corporate)');
  for (const c of py) console.log(`  ${c.email.padEnd(34)} (${c.viaPackage})`);

  let domain = domainArg;
  if (site) {
    console.log(`\nwebsite — mailto/plain-text scan of ${site}`);
    const web = await websiteContacts(site, company).catch((e: Error) => {
      console.log(`  ! ${e.message}`);
      return [];
    });
    if (web.length === 0) console.log('  (nothing on own domain)');
    for (const c of web) console.log(`  ${c.email.padEnd(34)} (${c.path})`);
    domain ||= web[0]?.email.split('@')[1] ?? rootDomain(new URL(site.startsWith('http') ? site : `https://${site}`).hostname);
  }

  if (domain) {
    const rua = await dmarcRua(domain);
    console.log(`\nDMARC ${domain}: ${rua ? `managed (rua ${rua})` : 'not published — verify extra carefully'}`);
    console.log(`role addresses @${domain} (verify before use)`);
    for (const addr of roleAddresses(domain)) console.log(`  ${addr}`);
  }
}
