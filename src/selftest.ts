import { classify } from './classify.js';
import { isFreshEnough, locationMatches, normalizeForDedup, roleFamily } from './filter.js';
import { extractNames, FUNDING, INVESTORS, LONE_ONLY, TRAILING_ONLY } from './news-extract.js';
import { detectOutage, outageChanges } from './outage.js';
import { selectBoards } from './select-boards.js';
import { epochToIso } from './fetchers/eightfold.js';
import { safeIso } from './fetchers/darwinbox.js';
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
  'clearing the entire suspected set is reported as recovered',
  outageChanges({ darwinbox: true }, new Set()).recovered,
  true,
);
check(
  'no prior outage and none now is not a recovery',
  outageChanges({}, new Set()).recovered,
  false,
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

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
