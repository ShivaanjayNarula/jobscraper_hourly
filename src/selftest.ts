import { classify } from './classify.js';
import { isFreshEnough, locationMatches, normalizeForDedup, roleFamily } from './filter.js';
import { extractNames, headlineItems, FUNDING, INVESTORS, LONE_ONLY, TRAILING_ONLY } from './news-extract.js';
import { detectOutage, outageChanges } from './outage.js';
import { selectBoards } from './select-boards.js';
import { epochToIso } from './fetchers/eightfold.js';
import { safeIso } from './fetchers/darwinbox.js';
import { BlockError, classifyFailure, classifyOkBody } from './fetchers/block.js';
import { summarizeHostStats, updateHistory, persistentlySlow } from './host-stats.js';
import {
  applyPattern,
  dominantDomain,
  dominantPattern,
  inferPattern,
  isCorporateAddress,
  splitName,
  domainMatchesOrg,
  isTrivialCommit,
  factScore,
} from './contacts.js';
import { bodySimilarity, bounceGateDecision, displayName, domainRiskTally, isTriggered, postedAgeDays, renderBody, touchGap, TRIGGER_WINDOW_DAYS } from './outreach.js';
import { applyboltLookup, extractEmails, packageNameCandidates, parseApplyBolt, parseDmarcRua, roleAddresses } from './contact-sources.js';
import { controlAddress, mxProvider, rejectionIsMeaningful } from './verify-email.js';
import type { Company, Industry, RawJob } from './types.js';

/**
 * Regression tests for the two regex layers that decide everything.
 *
 *   npm test
 *
 * Every case here is a bug that actually shipped. "Indiana" matching `india`
 * leaked 62 US roles into a real alert email before it was caught by eye — the
 * kind of thing a typecheck can never find.
 */
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  if (got !== want) {
    failures++;
    console.log(`  FAIL  ${label}\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

console.log('locations');
const locations: [string, boolean][] = [
  // Substring traps — these all leaked at some point.
  ['United States - Indiana - Westfield', false],
  ['US-IN-Indianapolis', false],
  ['Indianapolis, Indiana, United States', false],
  ['Goal setting, Texas', false],
  // Genuine India.
  ['India - Mumbai', true],
  ['Bangalore, India', true],
  ['IN, KA, Bengaluru', true],
  ['Goa, India', true],
  ['Hyderabad, Telangana, India', true],
  // Remote handling: bare remote counts, region-locked remote does not.
  ['Remote', true],
  ['Remote - India', true],
  ['Remote, Denmark', false],
  ['Remote - Ireland', false],
  ['Remote - US', false],
  ['', false],
];
for (const [location, want] of locations) check(`location ${JSON.stringify(location)}`, locationMatches(location), want);

console.log('seniority');
const job = (title: string, text = ''): RawJob => ({ externalId: 'x', title, location: 'Bengaluru', url: '', text });
const senior: [string, Industry][] = [
  ['Head - Advanced Analytics', 'tech'],
  ['Sr. Business Analyst', 'banking'],
  ['Software Dev Engineer II', 'tech'],
  ['Site Reliability Engineer - 2', 'tech'],
  ['Forward Deployed Engineer - II', 'tech'],
  ['Distinguished AI Engineer', 'banking'],
  ['Principal Software Engineer', 'tech'],
  ['Senior Software Engineer', 'tech'],
  ['Engineering Manager, Looker', 'tech'],
  ['Software Development Mgmt 5', 'tech'],
  ['Data Platform Lead - L6', 'tech'],
  // "Supv" (Supervisor) at a Workday-discovered company tagged plain "tech" —
  // a management title with no other senior signal to catch it.
  ['Supv Claim Analytics', 'tech'],
];
for (const [title, industry] of senior) {
  check(`senior: ${title}`, classify(job(title), industry).isJunior, false);
}

const junior: [string, Industry][] = [
  ['Software Engineer, University Graduate', 'tech'],
  ['SDE-1, Payments', 'tech'],
  ['Associate Application Engineer', 'tech'],
  ['Analyst - Asset Servicing', 'banking'],
  ['Business Analyst', 'consulting'],
  // Level *I* / *1* is the entry rung — must NOT be caught by the II-IV/2-9
  // senior suffix, or every genuinely junior "Engineer I" title gets rejected.
  ['Software Test Engineer I', 'tech'],
  ['Refrigeration Engineer I', 'tech'],
];
for (const [title, industry] of junior) {
  check(`junior: ${title}`, classify(job(title), industry).isJunior, true);
}

console.log('years');
check('0-2 years', classify(job('Engineer', 'requires 0-2 years experience'), 'tech').minYears, 0);
check('8+ years', classify(job('Engineer', 'needs 8+ years of experience'), 'tech').minYears, 8);
check('lowest wins', classify(job('Engineer', '2 years required, 7+ years preferred'), 'tech').minYears, 2);
check('unstated', classify(job('Engineer', 'no numbers here'), 'tech').minYears, null);

console.log('excluded role types');
const excluded = [
  'Part Time Associate Banker',
  'Cloud Data Platform Sales',
  'Data Center Technician',
  'IT Support Associate',
  // Industrial/pharma GCC titles that slipped through because the `swe` family
  // bare-matches \bengineer\b and `data` bare-matches \bscientist\b — real leaks
  // from Baker Hughes, GE Vernova, Amazon and Thermo Fisher on 2026-08-11.
  'Services Professional - Field Service Engineer',
  'Reliability & Maintenance Engineer',
  'RME Engineer',
  'Engineer - Electrical Plant Layout & Cable Trays',
  'Engineer - Plant Layout & Piping',
  'Junior Fire Protection Engineer I',
  'Refrigeration Engineer I',
  'Process Engineer - Mechanical',
  'Application Scientist Pharma and Biopharma',
  'Field Applications Scientist',
  'Scientist I - Protein Biology',
  'Data Entry Specialist',
];
for (const title of excluded) {
  check(`excluded: ${title}`, classify(job(title), 'tech').excluded, true);
}

// Legitimate tech roles from the same GCC boards must survive the new
// exclusions — this is what stops the exclude list from being too broad.
const notExcluded = [
  'Site Reliability Engineer',
  'QA Automation Engineer',
  'Data Scientist, Applied ML',
  'Application Engineer, Platform',
];
for (const title of notExcluded) {
  check(`not excluded: ${title}`, classify(job(title), 'tech').excluded, false);
}

console.log('role families');
check('finance family off at tech firms', roleFamily('Associate, Operations', 'tech'), null);
check('finance family on at banks', roleFamily('Asset Servicing Analyst', 'banking'), 'finance');
check('swe family', roleFamily('Backend Engineer', 'tech'), 'swe');

// 830 of 1,969 India roles across the 12 highest-volume boards were being
// dropped for having no family at all. Each of these is a category that was
// invisible until measured — not a hypothetical.
check('spelled-out QA, which \\bqa\\b never matched', roleFamily('Executive - Digital Quality Assurance', 'tech'), 'swe');
check('silicon roles at the semiconductor GCCs', roleFamily('Physical Design Engineer', 'tech'), 'swe');
check('embedded/firmware', roleFamily('Firmware Developer', 'tech'), 'swe');
// "Advisory" appeared 235 times in the dropped set — KPMG and PwC label
// nearly every engagement with it.
check('consulting advisory work', roleFamily('Executive - TPRM-Advisory Services', 'consulting'), 'finance');
check('product family', roleFamily('Associate Product Manager', 'tech'), 'product');
check('design family', roleFamily('Product Designer', 'tech'), 'design');
check('security family', roleFamily('Cyber Defense Analyst', 'tech'), 'security');
// Widening a family must not promote the senior rungs: `manager` is still a
// senior term everywhere, so the family only makes the role visible.
check('product family does not smuggle in managers', classify(job('Product Manager'), 'tech').isJunior, false);

// Back-office roles reached the inbox through the finance family's junior
// "Analyst"/"Executive" titles. "Analyst - Employee Vetting & Background
// checks" was posted ~10 times in a single KPMG sweep.
check('HR vetting ops excluded', classify(job('Analyst - Employee Vetting & Background checks'), 'consulting').excluded, true);
check('admin roles excluded', classify(job('Analyst - Executive Assistant'), 'consulting').excluded, true);
check('finance back-office excluded', classify(job('Executive - Accounts Payable, Finance'), 'consulting').excluded, true);
// The carve-outs above must not take real engineering with them.
check('real consulting engineering still kept', classify(job('Consultant - Gen AI'), 'consulting').excluded, false);

console.log('dedup normalization');
// Cigna posted the same requisition twice — one title used a plain hyphen,
// the other an en-dash in "HIH – Evernorth" — so an exact-string dedup key
// treated them as two different roles.
check(
  'hyphen and en-dash collapse to the same key',
  normalizeForDedup('Software Engineering Associate Advisor - HIH – Evernorth'),
  normalizeForDedup('Software Engineering Associate Advisor – HIH - Evernorth'),
);
check('genuinely different titles stay different', normalizeForDedup('Backend Engineer') === normalizeForDedup('Frontend Engineer'), false);

console.log('email freshness gate');
// "New to the tracker" and "recently posted" are different claims — a company
// added today can have listings months old. 573 of 1,101 dated roles in the
// live catalog on 2026-08-11 were 30+ days old, e.g. "Vonage — 111d ago"
// alerted as if it were breaking news.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
check('posted today is fresh', isFreshEnough(daysAgo(0)), true);
check('posted 20 days ago is fresh', isFreshEnough(daysAgo(20)), true);
check('posted 111 days ago is not fresh', isFreshEnough(daysAgo(111)), false);
check('no posting date at all defaults to fresh', isFreshEnough(undefined), true);
check('unparseable date (Workday relative strings) defaults to fresh', isFreshEnough('Posted Today'), true);

console.log('outage detection');
// Every tracked Darwinbox board (PhysicsWallah, Porter, Licious, Tata 1mg,
// PharmEasy, Subex, LeadSquared, BigBasket) was silently evicted within days
// of each other — testing the same adapter and tenant by hand afterward
// returned live jobs immediately, so this was a platform-wide block (almost
// certainly Cloudflare on GitHub Actions' shared runner IPs), not eight
// coincidental deaths. `detectOutage` exists so that pattern gets caught
// instead of trusted as eight independent failures.
const asSet = (s: Set<string>) => [...s].sort().join(',');
check(
  'most of one platform failing at once is flagged as a suspected outage',
  asSet(detectOutage([
    { ats: 'darwinbox', error: 'timeout' },
    { ats: 'darwinbox', error: 'timeout' },
    { ats: 'darwinbox', error: 'timeout' },
    { ats: 'darwinbox' },
  ])),
  'darwinbox',
);
check(
  'one company failing among many healthy ones on the same platform is not an outage',
  asSet(detectOutage([
    { ats: 'greenhouse', error: 'timeout' },
    ...Array.from({ length: 20 }, () => ({ ats: 'greenhouse' as const })),
  ])),
  '',
);
check(
  'a tiny platform with too few boards to judge is never flagged, even at 100% failure',
  asSet(detectOutage([{ ats: 'phenom', error: 'timeout' }, { ats: 'phenom', error: 'timeout' }])),
  '',
);
check(
  'two platforms failing simultaneously are both flagged, independently',
  asSet(detectOutage([
    { ats: 'darwinbox', error: 'x' }, { ats: 'darwinbox', error: 'x' }, { ats: 'darwinbox', error: 'x' },
    { ats: 'turbohire', error: 'x' }, { ats: 'turbohire', error: 'x' }, { ats: 'turbohire', error: 'x' },
    { ats: 'greenhouse' }, { ats: 'greenhouse' }, { ats: 'greenhouse' },
  ])),
  'darwinbox,turbohire',
);

// outageChanges is what the workflow reports from — a 20-minute schedule
// means a single multi-hour outage gets flagged by detectOutage dozens of
// times, so the workflow-facing signal must fire only on actual transitions.
check(
  'a platform newly joining the suspected set is reported as started',
  outageChanges({}, new Set(['darwinbox'])).started.join(','),
  'darwinbox',
);
check(
  'a platform still suspected from last run is not reported again',
  outageChanges({ darwinbox: true }, new Set(['darwinbox'])).started.join(','),
  '',
);
check(
  'a platform leaving the suspected set is reported as recovered',
  outageChanges({ darwinbox: true }, new Set()).recovered.join(','),
  'darwinbox',
);
check(
  'no prior outage and none now is not a recovery',
  outageChanges({}, new Set()).recovered.join(','),
  '',
);
// The bug this replaced: recovery keyed on the whole set emptying, so one
// permanently-suspected platform pinned every other platform's issue open.
check(
  'one platform recovering is reported even while another stays suspected',
  outageChanges({ darwinbox: true, phenom: true }, new Set(['darwinbox'])).recovered.join(','),
  'phenom',
);

// Bot-wall classification (ported from fastCRW's antibot signals). The Darwinbox
// eviction above was caught only after the damage, and only at platform scale —
// these make each individual response say which kind of failure it was, so a
// single blocked board on a healthy ATS is recognized too. Every case below is
// a real-world shape: Turnstile interstitials arrive as HTTP 200 with a big
// HTML body; Walls serve 403 with tiny HTML; the API's own JSON 4xx means the
// board config is genuinely stale and MUST stay evictable.
console.log('bot-wall classification');
check(
  'cloudflare turnstile served with HTTP 200 is a challenge',
  classifyFailure(200, '<html><head><script>window._cf_chl_opt={"cType":"managed"}</script>')?.kind,
  'challenge',
);
check(
  'a strong CF marker outranks an otherwise clean-looking page',
  classifyFailure(200, '<!doctype html><html>/cdn-cgi/challenge-platform/orchestrate</html>')?.vendor,
  'cloudflare',
);
check('plain JSON success classifies as nothing', classifyFailure(200, '{"jobs":[]}'), undefined);
check('429 is rate limiting', classifyFailure(429, '')?.kind, 'rate_limited');
check(
  '403 with a near-empty body is a wall, not a dead board',
  classifyFailure(403, '<html></html>')?.kind,
  'waf_block',
);
check(
  '403 with HTML but no known fingerprint is still a wall',
  classifyFailure(403, '<html><body>Request blocked.</body></html>')?.kind,
  'waf_block',
);
check(
  "403 with the API's own JSON refusal stays evictable",
  classifyFailure(403, '{"status":403,"error":"Forbidden"}'),
  undefined,
);
check('a real 404 stays evictable', classifyFailure(404, '{"error":"Not Found"}'), undefined);
check('522 is cloudflare-side', classifyFailure(522, 'x')?.vendor, 'cloudflare');
check('530 is cloudflare-side', classifyFailure(530, '')?.vendor, 'cloudflare');
check(
  'datadome interstitial is recognized',
  classifyFailure(403, '<script src="https://captcha-delivery.com/c.js"></script>')?.vendor,
  'datadome',
);
check(
  'akamai reference-id page is recognized',
  classifyFailure(403, 'Access Denied. Reference #18.4f9f6d17.1760438400.a1b2c3d')?.vendor,
  'akamai',
);
check(
  'perimeterx app-id script is recognized',
  classifyFailure(403, '<script>window._pxAppId="PX1234"</script>')?.vendor,
  'perimeterx',
);
check(
  'vercel checkpoint needs both phrases, prose alone does not trip it',
  [
    classifyFailure(403, '<p>Vercel Security Checkpoint blocked us</p>')?.vendor === 'vercel',
    classifyFailure(403, '<h1>Vercel Security Checkpoint</h1><p>verifying your browser</p>')?.vendor,
  ].join(','),
  'false,vercel',
);
check(
  '"Just a moment" title is the classic CF challenge',
  classifyFailure(503, '<title>Just a moment...</title>')?.kind,
  'challenge',
);
check(
  'an empty 200 body that fails JSON.parse is structural, not a bug to chase',
  classifyOkBody('   \n ')?.kind,
  'structural',
);
check(
  'a 200 HTML shell is structural',
  classifyOkBody('<div id="root"></div>')?.kind,
  'structural',
);
check(
  'garbled-but-real data stays unclassified so the parse error surfaces honestly',
  classifyOkBody('{"jobs":[{"broken"'),
  undefined,
);
check(
  'the error message carries the verdict tag for log lines that only see text',
  new BlockError({ kind: 'challenge', vendor: 'cloudflare' }, 200, 'https://x').message.startsWith(
    '[challenge] cloudflare',
  ),
  true,
);

console.log('epoch conversion (eightfold)');
// Same bug class Zappyhire shipped: an ATS's own sort/rank field can hold a
// sentinel value with no real date behind it, far outside JS Date's valid
// range — `new Date()` throws RangeError rather than returning something
// falsy, so it has to be caught before construction, not after.
check('a normal unix-seconds timestamp converts to ISO', epochToIso(1_700_000_000) !== undefined, true);
check('undefined stays undefined', epochToIso(undefined), undefined);
check('zero (falsy) stays undefined, not epoch-zero', epochToIso(0), undefined);
check(
  'a sentinel far outside Date range is dropped, not thrown',
  epochToIso(-9_223_372_036_854_776),
  undefined,
);

console.log('date parsing (darwinbox)');
// created_on arrives as either a string or a number depending on tenant, and
// either shape can fail to parse into a real date.
check('a real ISO string parses', safeIso('2026-01-15T10:00:00Z') !== undefined, true);
check('a real epoch-ms number parses', safeIso(1_700_000_000_000) !== undefined, true);
check('a garbled string is dropped, not thrown', safeIso('not a date'), undefined);
check('an out-of-range number is dropped, not thrown', safeIso(-9_223_372_036_854_776_000), undefined);
check('undefined stays undefined', safeIso(undefined), undefined);

console.log('board selection');
// Rotation is what lets the corpus hold ~21,000 boards without the run time
// growing with it. The failure modes here are silent: a hot board demoted to
// rotation stops alerting promptly, and a cold board that never reaches the
// front of the queue is effectively deleted without anyone noticing.
const board = (token: string, extra: Partial<Company> = {}): Company => ({
  name: token, ats: 'greenhouse', token, industry: 'tech', source: 'discovered', ...extra,
});

const mixed = [
  board('hot1', { lastIndiaAt: '2026-08-01T00:00:00Z', lastPolledAt: '2026-08-17T00:00:00Z' }),
  board('hot2', { lastIndiaAt: '2026-07-01T00:00:00Z', lastPolledAt: '2026-08-17T00:00:00Z' }),
  board('coldNew'),                                          // never polled
  board('coldOld', { lastPolledAt: '2026-08-01T00:00:00Z' }),
  board('coldRecent', { lastPolledAt: '2026-08-16T00:00:00Z' }),
];

const picked = selectBoards(mixed, 4);
check('every hot board is polled', picked.hot, 2);
check('cold boards fill the remaining slots only', picked.cold, 2);
check('overflow cold boards are deferred, not dropped', picked.skipped, 1);
// Never-polled sorts first, so a fresh import is swept promptly instead of
// queueing behind boards that were already checked.
check(
  'cold rotation is oldest-polled-first, unpolled ahead of all',
  picked.polling.slice(2).map((c) => c.token).join(','),
  'coldNew,coldOld',
);
// A board that can alert must never wait on rotation, even if hot boards
// alone blow past the ceiling.
const allHot = selectBoards(
  [board('a', { lastIndiaAt: 'x' }), board('b', { lastIndiaAt: 'x' }), board('c', { lastIndiaAt: 'x' })],
  1,
);
check('hot boards are never sacrificed to the ceiling', allHot.polling.length, 3);
check('no cold slots remain when hot overflows', allHot.cold, 0);

console.log('news extraction (discover-news.ts)');
// headlineItems() pairs each title with its own <item>'s <link> — the digest
// this feeds used to ship bare names with no way to verify them against the
// actual article, which is exactly the gap that prompted adding it.
const rssSample = `<rss><channel>
<item><title>Zypp Electric raises Series B</title><link>https://example.com/zypp</link></item>
<item><title><![CDATA[NewTap Finance bags seed round]]></title><link>https://example.com/newtap</link></item>
<item><title>No link on this one somehow</title></item>
</channel></rss>`;
check(
  'title paired with its own item link',
  JSON.stringify(headlineItems(rssSample)),
  JSON.stringify([
    { title: 'Zypp Electric raises Series B', link: 'https://example.com/zypp' },
    { title: 'NewTap Finance bags seed round', link: 'https://example.com/newtap' },
    { title: 'No link on this one somehow', link: '' },
  ]),
);
// All cases below are real headlines pulled from the six live RSS feeds
// during an audit — each one was a genuine extraction bug, not a
// hypothetical. "Series B/C" leaking as a fake candidate, "FY27" surviving
// because only fy24-26 were hardcoded (the staleness the original author's
// own comment predicted, one year later), and a FUNDING trigger verb
// ("Backed", "Nets") getting capitalised mid-headline and extracted as its
// own candidate all shipped in production before this suite existed.
check(
  '"Series B" is not extracted as a company name',
  extractNames('AI code testing platform Blacksmith raises $45 Mn in Series B led by Peak XV').join(','),
  'Blacksmith',
);
check(
  'fiscal-year token is stripped regardless of which year it is (FY27, not just FY24-26)',
  extractNames('PhysicsWallah Q1 FY27 revenue jumps 24% to Rs 1,054 Cr amid Rs 88 Cr net loss').join(','),
  'PhysicsWallah',
);
check(
  'a capitalised FUNDING trigger verb ("Backed") does not attach itself to the real name',
  extractNames("CRED-Backed NewTap Finance's FY26 Profit More Than Doubles To ₹2.4 Cr").includes('NewTap Finance'),
  true,
);
check(
  'the funded company survives even when "Nets" (a FUNDING verb) is title-cased next to it',
  extractNames('D2C Brand Scrubsy Nets $3 Mn to Expand Home Cleaning Offerings').includes('Scrubsy'),
  true,
);
check('KKR is filtered as an investor, not extracted as the funded company', INVESTORS.has('kkr'), true);
check(
  '"invest $X in Y" (amount between the verb and "in") still matches FUNDING, not just "invest in Y"',
  FUNDING.test('Nvidia-OpenAI partnership: US chipmaker plans to invest $3 billion in SB Energy'),
  true,
);

// Second audit pass (2026-08-17), against the live feeds. Three new bug
// classes shipped between the first audit and this one:
//
//  1. Investor-suffix truncation: "SMBC Asia Rising Fund" was cut to its
//     first three words before INVESTOR_SUFFIX ran, so the trailing "Fund"
//     never matched and the investor leaked through as a candidate.
//  2. Trailing verbs/nouns stuck to the real name ("Khartis Therapeutics
//     Emerges") and stray single capitalised words leaked from longer
//     phrases ("Deep-tech startup Quarkitech" -> "Deep", "led by 12 Flags"
//     -> "Flags", "files UDRHP" -> "UDRHP", "ESOP buyback" -> "ESOP").
//  3. A junk phrase split across the stopword classes ("Expand Home
//     Cleaning Offerings" -> "Expand Home") survived because the trailing
//     trim stopped on a lone-only word.
check(
  'a 4-word investor name is filtered whole, not truncated past its suffix',
  extractNames('Centricity raises Rs 280 Cr in Series A round led by SMBC Asia Rising Fund').join(','),
  'Centricity',
);
check(
  'a trailing verb attached to the real name is trimmed (Emerges from Stealth)',
  extractNames('Khartis Therapeutics Emerges from Stealth with $95 Million in Funding to Advance Oral Small Molecule Immunology Pipeline')[0],
  'Khartis Therapeutics',
);
check('the orphan of "Deep-tech startup X" is not extracted as its own company', extractNames('Deep-tech startup Quarkitech raises pre-seed funding').join(','), 'Quarkitech');
check('"Home cleaning products startup X" extracts only X, not the sector word', extractNames('Home cleaning products startup Scrubsy raises Rs 27 Cr from V3 Ventures').join(','), 'Scrubsy');
check('"Every fusion startup" (a feature headline) extracts nothing', extractNames('Every fusion startup that has raised over $100M').join(','), '');
check('"Seven cos" (a count, not a company) extracts nothing', extractNames('IPO wave: Seven cos eye to raise Rs 6,400 Cr next week').join(','), '');
check('"Tribunal allows Zee" extracts only Zee', extractNames('Tribunal allows Zee to proceed with fundraise, but keeps market ban intact').join(','), 'Zee');
check('IPO-document acronyms are not companies (UDRHP, OFS)', extractNames('Zetwerk files UDRHP to raise Rs 2,600 Cr via fresh issue; promoters to account for 53% of OFS').join(','), 'Zetwerk');
check('ESOP is not a company', extractNames('Astrotalk turns unicorn at $1 Bn valuation via ESOP buyback').join(','), 'Astrotalk');
check('the tail of a numeral-led VC name ("led by 12 Flags" -> "Flags") is not a company', extractNames('Wippi raises $1.2 Mn in seed round led by 12 Flags').join(','), 'Wippi');
check('": WSJ" (a publication suffix) is not a company', extractNames('Nvidia scales back funding guarantee for Ohio OpenAI data centre: WSJ').join(',').split(',').filter((n) => n.toLowerCase() === 'wsj').length, 0);
check('"Trump-backed" extracts the company, not the backer', extractNames('US regulator approves bank charter for Trump-backed crypto company World Liberty Financial').join(','), 'World Liberty Financial');
check('a junk phrase split across stopword classes is dropped whole', extractNames('D2C Brand Scrubsy Nets $3 Mn to Expand Home Cleaning Offerings').join(','), 'Scrubsy');

// The junk-class words must only suppress *junk* — each one is also a
// plausible first word of a real company, and multi-word names that start
// with one must survive untouched.
check('lone-only words do not lead-trim real multi-word names (Deep Industries)', extractNames('Deep Industries bags Rs 100 Cr contract').join(','), 'Deep Industries');
check('lone-only words do not lead-trim real multi-word names (Seven Seas)', extractNames('Seven Seas Technologies raises Series A').join(','), 'Seven Seas Technologies');
check('lone-only words do not lead-trim real multi-word names (Cleaning Solutions)', extractNames('Cleaning Solutions raises seed round').join(','), 'Cleaning Solutions');
check('lone-only words do not lead-trim real multi-word names (Home Depot)', extractNames('Home Depot opens India sourcing office').includes('Home Depot'), true);
check('trailing-only words do not lead-trim real multi-word names (Expand)', extractNames('Expand Corp raises Series B').join(','), 'Expand Corp');
check('the sets exist and are disjoint from STOPWORDS', LONE_ONLY.has('deep') && TRAILING_ONLY.has('emerges') && !LONE_ONLY.has('the'), true);

// Third audit pass (2026-08-19): month names lived in STOPWORDS, whose
// leading-trim runs unconditionally — so any real company starting with a
// month name got the front chopped off. Moved to LONE_ONLY, same as every
// other "junk alone, real word in a real name" case.
check('a month-named company survives whole (August Health)', extractNames('August Health raises $10 Mn in seed round').join(','), 'August Health');
check('a month-named company survives whole (May Mobility)', extractNames('May Mobility raises $50 Mn in Series C').join(','), 'May Mobility');
check('a bare month mention extracts nothing', extractNames('August raises $10 Mn seed round').join(','), '');
check('a month used as a date reference is still dropped, not attached', extractNames('In August, Zetwerk raised $5 Mn seed funding').join(','), 'Zetwerk');

console.log('host stats (per-host latency/error summary)');
const hostSample = [
  { key: 'greenhouse', durationMs: 100 },
  { key: 'greenhouse', durationMs: 200 },
  { key: 'greenhouse', durationMs: 300, error: 'timeout' },
  { key: 'workday:wd5', durationMs: 5000 },
];
const hostStats = summarizeHostStats(hostSample);
check('one bucket per key, not per result', hostStats.length, 2);
check('worst p95 sorts first', hostStats[0]!.key, 'workday:wd5');
check('error count only counts results with an error', hostStats.find((s) => s.key === 'greenhouse')!.errors, 1);
check('count is every result for that key, errors included', hostStats.find((s) => s.key === 'greenhouse')!.count, 3);

console.log('host history (rolling worst-N persistence)');
// updateHistory takes stats.slice(0, WORST_N=3) as-is (already worst-first
// from summarizeHostStats), so this run needs >3 hosts for "never worst" to
// mean anything — with only 2 entries both would land in the top 3.
const alwaysWorst = { key: 'wd504', count: 1, errors: 0, p50: 1, p95: 1 };
const filler = (key: string) => ({ key, count: 1, errors: 0, p50: 1, p95: 1 });
const neverWorst = { key: 'greenhouse', count: 1, errors: 0, p50: 1, p95: 1 };
const runStats = [alwaysWorst, filler('a'), filler('b'), neverWorst];
let history: Record<string, boolean[]> = {};
for (let i = 0; i < 6; i++) history = updateHistory(history, runStats);
check('a host in the worst-N every run accumulates all-true history', history['wd504']!.every(Boolean), true);
check('a host never in the worst-N accumulates all-false history', history['greenhouse']!.some(Boolean), false);
check('a host consistently worst is flagged persistently slow', persistentlySlow(history).includes('wd504'), true);
check('a host never worst is not flagged persistently slow', persistentlySlow(history).includes('greenhouse'), false);

const skippedRun = updateHistory(history, [neverWorst]);
check('a host skipped this run (cold rotation) keeps its prior history untouched', skippedRun['wd504']!.join(','), history['wd504']!.join(','));

const cappedHistory = updateHistory({ wd504: Array(10).fill(true) }, [alwaysWorst]);
check('history is capped at 10 runs, oldest dropped first', cappedHistory['wd504']!.length, 10);

const oneBadRun = updateHistory({ wd504: [true, false, false, false, false] }, [neverWorst]);
check('a single bad run among mostly-good ones does not trip the flag', persistentlySlow(oneBadRun).length, 0);


console.log('contact addresses (which commit authors are usable)');
const addresses: [string, boolean][] = [
  // Real corporate addresses seen in the 2026-08-21 sweep.
  ['manish.soni@razorpay.com', true],
  ['someone@swiggy.in', true],
  ['dev@cred.club', true],
  // GitHub's privacy addresses are the single biggest source of noise.
  ['89454448+ankitdas13@users.noreply.github.com', false],
  ['noreply@github.com', false],
  // Bots commit constantly and would dominate any tally.
  ['dependabot[bot]@users.noreply.github.com', false],
  ['actions@github.com', false],
  // Personal mail is real but useless for reaching someone at work.
  ['vividvilla@gmail.com', false],
  ['nasir.ciem.it@gmail.com', false],
  ['someone@protonmail.com', false],
  // A shared service account is corporate; deciding to skip it is the
  // caller's job, not the filter's.
  ['security-svc@razorpay.com', true],
];
for (const [email, want] of addresses) check(`usable ${email}`, isCorporateAddress(email), want);

console.log('name splitting');
check('two-part name', JSON.stringify(splitName('Manish Soni')), '{"first":"manish","last":"soni"}');
check('middle name is dropped, not treated as the surname', JSON.stringify(splitName('Mahlaqa Fatima Haque')), '{"first":"mahlaqa","last":"haque"}');
check('accents fold to ASCII', JSON.stringify(splitName('Jose\u0301 Rami\u0301rez')), '{"first":"jose","last":"ramirez"}');
// Mononyms are common in Indian datasets. Guessing a surname would poison the
// pattern tally for the whole company, so they are refused outright.
check('single-token name yields nothing', splitName('Ankit'), null);
check('empty name yields nothing', splitName('   '), null);

console.log('email pattern inference');
check('first.last', inferPattern('Manish Soni', 'manish.soni@razorpay.com'), 'first.last');
check('firstlast', inferPattern('Manish Soni', 'manishsoni@razorpay.com'), 'firstlast');
check('flast', inferPattern('Manish Soni', 'msoni@razorpay.com'), 'flast');
check('f.last', inferPattern('Manish Soni', 'm.soni@razorpay.com'), 'f.last');
check('first_last', inferPattern('Manish Soni', 'manish_soni@razorpay.com'), 'first_last');
check('last.first', inferPattern('Manish Soni', 'soni.manish@razorpay.com'), 'last.first');
check('bare first', inferPattern('Manish Soni', 'manish@razorpay.com'), 'first');
// A vanity or legacy address matches nothing and must not be forced into the
// nearest pattern — one wrong inference mislabels every colleague.
check('nickname matches no pattern', inferPattern('Manish Soni', 'mani@razorpay.com'), null);
check('mononym author cannot establish a pattern', inferPattern('Ankit', 'ankit@razorpay.com'), null);

console.log('pattern application');
check('construct first.last', applyPattern('first.last', 'Priya Nair', 'meesho.com'), 'priya.nair@meesho.com');
check('construct flast', applyPattern('flast', 'Priya Nair', 'meesho.com'), 'pnair@meesho.com');
check('cannot construct from a mononym', applyPattern('first.last', 'Priya', 'meesho.com'), null);

console.log('domain and pattern tallies');
const authors = [
  { name: 'Manish Soni', email: 'manish.soni@razorpay.com' },
  { name: 'Mahlaqa Haque', email: 'mahlaqa.haque@razorpay.com' },
  { name: 'Rohan Verma', email: 'rohan@rohanverma.net' },
];
check('dominant domain is the one most authors share', dominantDomain(authors), 'razorpay.com');
check('dominant pattern ignores authors on other domains', dominantPattern(authors, 'razorpay.com'), 'first.last');
check('no authors means no domain', dominantDomain([]), null);
// One person with a legacy address must not outvote the house style.
const mixedAuthors = [
  { name: 'A One', email: 'a.one@x.com' },
  { name: 'B Two', email: 'b.two@x.com' },
  { name: 'C Three', email: 'cthree@x.com' },
];
check('the majority pattern wins over a single outlier', dominantPattern(mixedAuthors, 'x.com'), 'first.last');

console.log('mail provider classification');
// Measured MX hosts from the 2026-08-21 sweep. Which provider is behind an
// address decides whether a rejection means anything at all.
check('google workspace', mxProvider('aspmx.l.google.com.'), 'google');
check('google, newer host form', mxProvider('smtp.google.com'), 'google');
check('microsoft 365', mxProvider('company-com.mail.protection.outlook.com'), 'microsoft');
check('mimecast gateway', mxProvider('eu-smtp-inbound-1.mimecast.com'), 'gateway');
check('proofpoint gateway', mxProvider('mxa-001d9801.gslb.pphosted.com'), 'gateway');
check('anything else', mxProvider('mailstream-bom.mxrecord.mx'), 'other');
// The whole point of the classification: Microsoft accepts RCPT TO for dead
// mailboxes and the gateways only ever answer for themselves, so a rejection
// from either is inconclusive rather than proof the address is wrong.
check('google rejections are conclusive', rejectionIsMeaningful('google'), true);
check('microsoft rejections are not', rejectionIsMeaningful('microsoft'), false);
check('gateway rejections are not', rejectionIsMeaningful('gateway'), false);
check('control address is scoped to the domain under test', controlAddress('razorpay.com').endsWith('@razorpay.com'), true);


console.log('domain belongs to the company (wrong-company guard)');
// Real hits from the sweep — these must survive.
check('exact match', domainMatchesOrg('razorpay', 'razorpay.com'), true);
check('non-com TLD', domainMatchesOrg('swiggy', 'swiggy.in'), true);
check('non-standard TLD', domainMatchesOrg('cred', 'cred.club'), true);
check('subdomain mail host', domainMatchesOrg('aussiebroadband', 'team.aussiebroadband.com.au'), true);
check('multi-word company flattens', domainMatchesOrg('augmentcode', 'augmentcode.com'), true);
// Real false positives from the first sweep — an open-source repo where
// outside contributors out-commit the company's own engineers. Mailing these
// reaches the wrong company entirely, which is worse than finding nothing.
check('outside contributor domain', domainMatchesOrg('audinate', 'nordicsemi.no'), false);
check('unrelated big-company domain', domainMatchesOrg('augusthealth', 'intuit.com'), false);
check('unrelated vendor domain', domainMatchesOrg('authentic8', 'thinstuff.at'), false);
// Short names are prefix-matched, or "cred" would match "credentials.io".
check('short name must prefix, not merely appear', domainMatchesOrg('cred', 'accredited.com'), false);
// Real misses from a live outreach run (2026-09-01): a 2-letter org whose
// domain is exactly that slug used to die on the old 3-char floor before the
// exact-label check ever ran.
check('two-letter org, exact-label domain', domainMatchesOrg('bp', 'bp.com'), true);
// A distinctive short domain label contained in a longer flattened org name —
// the reverse of the "razorpaycorp" case above.
check('short domain label inside long org name', domainMatchesOrg('rockwellautomation', 'ra.rockwell.com'), true);
// The reverse direction still needs its own length floor, or a generic short
// label ("tech", "labs") would spuriously match any long org name containing
// that substring.
check('reverse match rejects generic short labels', domainMatchesOrg('technovasolutions', 'unrelated.tech.io'), false);

console.log('regional freemail is not a corporate address');
// qq.com reached the first sweep as a "company domain" — Chinese and Korean
// consumer providers were missing from the original list.
for (const email of ['x@qq.com', 'x@163.com', 'x@naver.com', 'x@foxmail.com', 'x@web.de']) {
  check(`freemail ${email}`, isCorporateAddress(email), false);
}

console.log('outreach drafts');
// Housekeeping messages would open a mail with noise; only real work qualifies.
check('merge commit is trivial', isTrivialCommit('Merge pull request #12 from x'), true);
check('bump commit is trivial', isTrivialCommit('Bump vite from 5.1 to 5.2'), true);
check('release tag is trivial', isTrivialCommit('v2.3.1'), true);
check('real work survives', isTrivialCommit('fix partial-fill race in order book'), false);
check('merge remote-tracking is trivial', isTrivialCommit("Merge remote-tracking branch 'personal/b'"), true);

console.log('fact ranking');
// Substance beats housekeeping: both survive the trivial filter, only one
// should win when an author has committed both.
const strongFact = factScore('fix partial-fill race in order matching service');
const weakFact = factScore('update code of conduct contents');
check('race fix outscores conduct update', strongFact > weakFact, true);
check('strong fact clears the default bar', strongFact >= 3, true);
check('ticketed work scores mid', factScore('SP-1173: say what to do when CUI marking fails') >= 3, true);
check(
  'feat outranks docs',
  factScore('feat: add streaming ingest for live quotes') > factScore('docs: replace agents board screenshot with new one'),
  true,
);
// "Add comprehensive README" wears an action prefix over docs substance.
check(
  'readme-in-disguise penalized below the bar',
  factScore('Add comprehensive README with installation instructions') < 3,
  true,
);
// The similarity guard is what makes "same role, same company, many people"
// safe: identical skeletons must still score high enough to be blocked.
const twinA = renderBody({
  greet: 'Hi',
  first: 'a',
  fact: 'saw your commit fixing rate limits in gateway',
  roleLine: 'Acme just opened an SDE II in Bangalore.',
  ask: 'Is this req open? y/n works.',
  passAlong: 'Not you? Happy if you point me right.',
});
const twinB = renderBody({
  greet: 'Hi',
  first: 'b',
  fact: 'saw your commit adding retries in scheduler',
  roleLine: 'Acme just opened an SDE II in Bangalore.',
  ask: 'Is this req open? y/n works.',
  passAlong: 'Not you? Happy if you point me right.',
});
check('same-template twins cluster', bodySimilarity(twinA, twinB) > 0.6, true);
check(
  'unrelated bodies stay apart',
  bodySimilarity(twinA, 'invoice attached for august services rendered thanks accounts team') < 0.4,
  true,
);
check('touch gaps are day 0/4/9/16', JSON.stringify([0, 1, 2, 3].map(touchGap)), JSON.stringify([0, 4, 9, 16]));
const sample = renderBody({
  greet: 'Hey',
  first: 'x',
  fact: 'Saw your recent commit — "fix partial-fill race".',
  roleLine: 'Zerodha just opened an SDE II (Bangalore).',
  ask: 'Is this req open? y/n works.',
  passAlong: 'If this isn\'t yours, who should it go to?',
});
check('body carries the fact', sample.includes('partial-fill race'), true);
check('body carries the signature', sample.includes('— SM'), true);

console.log('outreach lane gating');
// Workday's relative strings must land in the triggered lane, not parse as null.
check('posted today is fresh', postedAgeDays('Posted Today'), 0);
check('posted N days ago parses', postedAgeDays('Posted 30+ Days Ago'), 30);
check('posted yesterday is one day, not unknown', postedAgeDays('Posted Yesterday'), 1);
const isoAge = postedAgeDays(new Date(Date.now() - 5 * 86_400_000).toISOString())!;
check('iso date age ~5d', isoAge >= 4 && isoAge <= 6, true);
check('garbage date is unknown, never fresh', postedAgeDays('whenever'), null);
check('missing date is unknown', postedAgeDays(undefined), null);
check('lowercase catalogue name displays capitalized', displayName('valtech'), 'Valtech');
check('mixed-case names pass through', displayName('WorldQuant'), 'WorldQuant');

// isTriggered() — fresh by EITHER signal, since firstSeen only became
// trustworthy once catalog.ts started merging against the live catalogue
// (hunt.yml fix, 2026-09-02); before that almost every entry's firstSeen
// read as "now" regardless of how old the posting actually was.
const catalogJob = (postedAt?: string, firstSeen?: string) => ({
  id: 'x', title: 't', company: 'c', url: '', postedAt, firstSeen,
});
check('fresh postedAt alone triggers', isTriggered(catalogJob('Posted Today', undefined)), true);
check('fresh firstSeen alone triggers, even with a stale postedAt', isTriggered(catalogJob('Posted 30+ Days Ago', daysAgo(1))), true);
check('stale on both signals does not trigger', isTriggered(catalogJob('Posted 30+ Days Ago', daysAgo(90))), false);
check('neither signal present does not trigger', isTriggered(catalogJob(undefined, undefined)), false);
check('firstSeen just outside the window does not trigger', isTriggered(catalogJob(undefined, daysAgo(TRIGGER_WINDOW_DAYS + 1))), false);

console.log('outreach risk memory');
const tally = domainRiskTally({
  'a@airbus.com': { company: 'Airbus', role: 'x', jobUrl: '', touch: 1, sentAt: ['2026-08-20T00:00:00Z'], nextDueAt: '', subject: 's', bounced: true },
  'b@airbus.com': { company: 'Airbus', role: 'x', jobUrl: '', touch: 1, sentAt: ['2026-08-21T00:00:00Z'], nextDueAt: '', subject: 's', bounced: true },
  'c@workato.com': { company: 'Workato', role: 'x', jobUrl: '', touch: 1, sentAt: ['2026-08-22T00:00:00Z'], nextDueAt: '', subject: 's' },
});
check('bounces tally per domain', tally.get('airbus.com'), 2);
check('clean domain absent', tally.get('workato.com'), undefined);

console.log('outreach bounce gate');
const NOW = Date.now();
const D = 86_400_000;
const mk = (sentDaysAgo: number[], bouncedDaysAgo?: number) => ({
  sentAt: sentDaysAgo.map((d) => new Date(NOW - d * D).toISOString()),
  bounced: bouncedDaysAgo != null,
  bouncedAt: bouncedDaysAgo != null ? new Date(NOW - bouncedDaysAgo * D).toISOString() : undefined,
});
// Week-1 spike: 30 fresh sends, 2 fresh bounces → incident halt.
check(
  'fresh spike halts',
  bounceGateDecision([{ ...mk([...Array(28).keys()].map((i) => i % 25 + 1), undefined) }, mk([3], 2), mk([4], 3)], NOW).halt,
  true,
);
// Healed: same bounces aged out of the window, fresh sends clean → pass.
const healed = [
  { ...mk([...Array(40).keys()].map((i) => 45 + i), 44) },
  mk([...Array(15).keys()].map((i) => i + 1)),
];
check('aged-out bounces stop halting', bounceGateDecision(healed, NOW).halt, false);
// Late incident: huge clean history dilutes lifetime to ~0.5%, window catches it.
const late = [
  { ...mk([...Array(400).keys()].map((i) => 60 + i)) },
  { ...mk([...Array(14).keys()].map((i) => i + 1), 5) },
  mk([2], 6),
];
check('recent spike caught despite clean history', bounceGateDecision(late, NOW).halt, true);
check('late-incident lifetime ratio stays low', (() => {
  const d = bounceGateDecision(late, NOW);
  return !d.reason.includes('lifetime bounces');
})(), true);
// Backstop: everything old and sparse in-window, but lifetime rotted.
const rot = [...Array(60).keys()].map((i) =>
  i < 5 ? { ...mk([50 + i], 50 + i) } : { ...mk([50 + i]) },
);
check('lifetime backstop halts on slow rot', bounceGateDecision(rot, NOW).halt, true);
// Sparse pause: too few recent sends to judge → silent.
check('sparse window stays quiet', bounceGateDecision([mk([1], 1), mk([2]), mk([3])], NOW).halt, false);

// --- Phase A: salary extraction, work-mode/visa classification, repost state.
import { extractSalary } from './salary.js';
import { updateReposts } from './state.js';
import { REPOST_WINDOW_DAYS } from './config.js';
import type { RepostState } from './types.js';

console.log('salary extraction');
const sal = (s?: string, t?: string) => extractSalary(s, t);
check('lpa range', JSON.stringify(sal(undefined, 'CTC: 12-18 LPA')), JSON.stringify({ minLpa: 12, maxLpa: 18 }));
check('lakhs wording', JSON.stringify(sal('₹8.5 - 12 Lakhs P.A.')), JSON.stringify({ minLpa: 8.5, maxLpa: 12 }));
check('single lpa figure', JSON.stringify(sal('15 LPA fixed')), JSON.stringify({ minLpa: 15, maxLpa: 15 }));
check(
  'absolute inr range needs per-annum marker',
  JSON.stringify(sal(undefined, '₹8,00,000 - 12,00,000 per annum')),
  JSON.stringify({ minLpa: 8, maxLpa: 12 }),
);
check('absolute inr without marker rejected', sal(undefined, 'get 800000-1200000 users'), null);
check('monthly stipend converts', JSON.stringify(sal(undefined, 'Stipend: ₹30,000/month')), JSON.stringify({ minLpa: 3.6, maxLpa: 3.6 }));
check('garbage is null not wrong', sal(undefined, 'salary negotiable, 500 employees'), null);
check('absurd range rejected', sal(undefined, '0.5-99 LPA'), null);
check('ats field beats body noise', JSON.stringify(sal('10-14 LPA', 'we once paid someone 2 LPA')), JSON.stringify({ minLpa: 10, maxLpa: 14 }));

console.log('work mode + visa');
const wm = (location: string, text?: string) => classify({ externalId: 'x', title: 'Engineer', location, url: '', text }, 'tech').workMode;
check('remote location', wm('Remote'), 'remote');
check('india city defaults onsite', wm('Bengaluru, Karnataka, India'), 'onsite');
check('hybrid wins over remote wording', wm('Remote', 'this is a hybrid role'), 'hybrid');
check('body remote breaks city tie', wm('Pune, India', 'remote work available'), 'remote');
check('visa sponsorship detected', classify({ externalId: 'x', title: 'Engineer', location: 'Pune', url: '', text: 'we provide visa sponsorship' }, 'tech').visa, true);
check('visa absent stays false', classify({ externalId: 'x', title: 'Engineer', location: 'Pune', url: '' }, 'tech').visa, false);

console.log('repost tracking (board-scoped)');
// Relative to now, not fixed dates: updateReposts() prunes anything older than
// REPOST_WINDOW_DAYS against the real clock, so hardcoded timestamps quietly
// become "expired" once the wall clock passes them and the suite starts
// failing on a date rather than on a bug. It did: these were 2026-08-01/02/04
// and went red on 2026-09-01, thirty-one days later. Reuses the daysAgo
// helper already defined above.
const T0 = daysAgo(3);
const T1 = daysAgo(2);
const T3 = daysAgo(1);
let rs: RepostState = updateReposts({}, ['a:1:x'], 'a:1:', T0);
check('live id tracked clean', rs['a:1:x']?.gone, undefined);
rs = updateReposts(rs, [], 'a:1:', T1);
check('absent id stamped gone', Boolean(rs['a:1:x']?.gone), true);
rs = updateReposts(rs, ['a:1:x'], 'a:1:', T3);
check('return clears gone', rs['a:1:x']?.gone, undefined);
// Other-board entries are never touched by another board's poll — cold
// rotation must not stamp absence on boards nobody looked at.
rs['b:2:y'] = { last: T0 };
rs = updateReposts(rs, [], 'a:1:', T1);
check('foreign board entry untouched by this poll', rs['b:2:y']?.gone, undefined);
check('own board entry got gone stamp', Boolean(rs['a:1:x']?.gone), true);
// Window expiry: an entry last seen long ago is pruned even while absent.
const OLD = daysAgo(REPOST_WINDOW_DAYS + 1);
rs = { 'stale:x': { last: OLD } };
rs = updateReposts(rs, [], 'stale:', T3);
check('expired absent entry pruned', rs['stale:x'], undefined);

console.log('board volume anomaly detection');
import { detectVolumeDrops, updateVolumeHistory, volumeDropChanges } from './volume-stats.js';
// Build a 5-run history of ~200 postings then a collapse.
let vh = {};
for (const c of [200, 210, 190, 205, 195, 8]) vh = updateVolumeHistory(vh, [{ key: 'k', count: c }]);
check('collapse below 20% of baseline flagged', detectVolumeDrops(vh, new Set(['k'])).has('k'), true);
vh = updateVolumeHistory(vh, [{ key: 'k', count: 198 }]);
check('recovered count clears the flag', detectVolumeDrops(vh, new Set(['k'])).has('k'), false);
vh = updateVolumeHistory({}, [{ key: 'k', count: 3 }]);
check('too little history stays quiet', detectVolumeDrops(vh, new Set(['k'])).has('k'), false);
let vs = {};
for (const c of [30, 32, 28]) vs = updateVolumeHistory(vs, [{ key: 'small', count: c }]);
vs = updateVolumeHistory(vs, [{ key: 'small', count: 1 }]);
check('tiny baseline board exempt', detectVolumeDrops(vs, new Set(['small'])).has('small'), false);
// Unpolled boards are never judged — no evidence either way.
for (const c of [200, 200, 200, 200, 200]) vh = updateVolumeHistory(vh, [{ key: 'cold', count: c }]);
vh = updateVolumeHistory(vh, [{ key: 'cold', count: 2 }]);
check('unpolled board not judged this run', detectVolumeDrops(vh, new Set(['k'])).has('cold'), false);
check('polled board with drop is judged', detectVolumeDrops(vh, new Set(['k', 'cold'])).has('cold'), true);
// Transition diff: held keys for unpolled boards, recovery only on real polls.
const prevDrops = { cold: true as const };
check('unpolled dropped key held, not recovered', volumeDropChanges(prevDrops, new Set(['cold']), new Set(['k'])).recovered.length, 0);
check('recovery requires an actual poll', volumeDropChanges(prevDrops, new Set(), new Set(['cold'])).recovered.length, 1);
check('new drop reported as started', volumeDropChanges({}, new Set(['x']), new Set(['x'])).started.length, 1);

console.log('trend intelligence (Phase D)');
import { companyVelocity, rampingCompanies, salaryTrends } from './trends.js';
import type { CatalogEntry } from './catalog.js';
const NOW_T = new Date('2026-08-23T00:00:00Z').getTime();
const mkEntry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  id: over.id ?? 'x', title: over.title ?? 'Software Engineer', company: over.company ?? 'Acme',
  industry: 'tech', location: 'Bengaluru', url: '', minYears: 0, maxYears: 3, isIntern: false,
  firstSeen: over.firstSeen ?? new Date(NOW_T - 5 * 86_400_000).toISOString(), lastSeen: '', ...over,
});
// RampCo: 10 open, half brand new. StaleCo: 40 open, all months old.
const trendEntries = [
  ...Array.from({ length: 10 }, (_, i) => mkEntry({ id: `r${i}`, company: 'RampCo', firstSeen: new Date(NOW_T - (i < 5 ? 3 : 60) * 86_400_000).toISOString() })),
  ...Array.from({ length: 40 }, (_, i) => mkEntry({ id: `s${i}`, company: 'StaleCo', firstSeen: new Date(NOW_T - 90 * 86_400_000).toISOString(), closedAt: i === 0 ? undefined : undefined })),
];
const vel = companyVelocity(trendEntries, NOW_T);
check('velocity sorts ramping first', vel[0]?.company, 'RampCo');
check('stale giant ranks by volume not churn', vel.find((c) => c.company === 'StaleCo')?.newLast30, 0);
check('ramping filter keeps real ramps', JSON.stringify(rampingCompanies(trendEntries, 6, 8, 3, NOW_T).map((c) => c.company)), JSON.stringify(['RampCo']));
check('floors exclude one-posting noise', rampingCompanies([mkEntry({ id: 'one', company: 'Tiny' })], 6, 8, 3, NOW_T).length, 0);
// Salary medians bucketed by crawl month; unparsed salaries must not dilute.
const salEntries = [
  mkEntry({ id: 'a', title: 'Data Analyst', salaryMin: 10, salaryMax: 14, firstSeen: '2026-08-02T00:00:00Z' }),
  mkEntry({ id: 'b', title: 'Data Scientist II', salaryMin: 12, salaryMax: 16, firstSeen: '2026-08-10T00:00:00Z' }),
  mkEntry({ id: 'c', title: 'Data Scientist', salaryMin: 30, salaryMax: 40, firstSeen: '2026-07-05T00:00:00Z' }),
  mkEntry({ id: 'd', title: 'Data Analyst' }), // no band — excluded
];
const st = salaryTrends(salEntries, 3, NOW_T);
check('salary buckets split by month', st.map((t) => `${t.family}/${t.month}`).join(','), 'data/2026-07,data/2026-08');
check('august median band', JSON.stringify(st.find((t) => t.month === '2026-08')), JSON.stringify({ family: 'data', month: '2026-08', n: 2, medianMin: 11, medianMax: 15 }));
check('entry without band skipped from n', st.every((t) => t.n <= 2), true);

// Contact-source helpers: email extraction and role-address candidates.
// The extraction regexes run over arbitrary company HTML, where a wrong match
// means a mail to a vendor or an agency — hence the corporate-filter checks.
check('extractEmails pulls mailto + plaintext, deduped', JSON.stringify(extractEmails('<a href="mailto:HR@Zerodha.com">mail</a> and hr@zerodha.com')), JSON.stringify(['hr@zerodha.com']));
check('extractEmails drops freemail', JSON.stringify(extractEmails('contact us at personal@gmail.com')), '[]');
check('roleAddresses covers the standard boxes', roleAddresses('cred.club').length, 6);
// DMARC rua parsing — vendor-hosted and multi-record shapes both occur.
check('parseDmarcRua reads plain rua', parseDmarcRua(['v=DMARC1; p=none; rua=mailto:dmarcreports@meesho.com']), 'dmarcreports@meesho.com');
check('parseDmarcRua handles vendor host + split records', parseDmarcRua(['v=DMARC1;', 'rua=mailto:g72jrssx@ag.ap.dmarcian.com; p=quarantine']), 'g72jrssx@ag.ap.dmarcian.com');
check('parseDmarcRua returns null when absent', parseDmarcRua(['v=DMARC1; p=reject']), null);
// PyPI candidate names — slug variants, deduped, junk slugs rejected.
check('packageNameCandidates expands + dedupes', JSON.stringify(packageNameCandidates('Razorpay')), JSON.stringify(['razorpay', 'razorpay-sdk', 'razorpaysdk', 'razorpay-python', 'razorpaypy']));
check('packageNameCandidates rejects tiny slugs', JSON.stringify(packageNameCandidates('a')), '[]');
// ApplyBolt response parsing — found:false, junk, and missing-name shapes.
check('parseApplyBolt reads a hit', JSON.stringify(parseApplyBolt({ found: true, email: 'Bill.Gates@GatesFoundation.org', fullName: 'Bill Gates', jobTitle: 'Co-chair' })), JSON.stringify({ name: 'Bill Gates', email: 'bill.gates@gatesfoundation.org', title: 'Co-chair' }));
check('parseApplyBolt rejects not-found and malformed', [parseApplyBolt({ found: false }), parseApplyBolt(null), parseApplyBolt({ found: true })].every((r) => r === null), true);
console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
