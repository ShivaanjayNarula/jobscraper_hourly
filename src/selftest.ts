import { classify } from './classify.js';
import { isFreshEnough, locationMatches, normalizeForDedup, roleFamily } from './filter.js';
import { extractNames, headlineItems, FUNDING, INVESTORS, LONE_ONLY, TRAILING_ONLY } from './news-extract.js';
import { detectOutage, outageChanges } from './outage.js';
import { selectBoards } from './select-boards.js';
import { epochToIso } from './fetchers/eightfold.js';
import { safeIso } from './fetchers/darwinbox.js';
import { toIso as recruiteeToIso } from './fetchers/recruitee.js';
import { place as teamtailorPlace } from './fetchers/teamtailor.js';
import { place as breezyPlace } from './fetchers/breezy.js';
import { parsePositions, place as personioPlace } from './fetchers/personio.js';
import { normalizeLocation, pageCount, parsePortal } from './fetchers/icims.js';
import { locationColumns, parseRows as parseTaleoRows } from './fetchers/taleo.js';
import { isPlaceholderLocation, parsePostedOn, parseRobotsSites } from './fetchers/workday.js';
import { refreshedPostedAt } from './catalog.js';
import { boardKey, NO_ADAPTER, parseBoardUrl } from './board-url.js';
import { limitForHost, rateLimitKey } from './config.js';
import { mapLimitByKey } from './fetchers/util.js';
import { csvFields, unfedPlatforms } from './bulk-import.js';
import { untrackedSlugs } from './open-jobs-slugs.js';
import { bareDomain } from './yc-directory.js';
import { place as ukgPlace } from './fetchers/ukg.js';
import { FETCHERS } from './fetchers/index.js';
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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mergeState } from './publish-outreach.js';
import { alreadySent } from './outreach-send.js';
import { readJson } from './state.js';
import { EventEmitter } from 'node:events';
import { readReply } from './verify-email.js';
import { SIGNATURE } from './outreach.js';
import { cleanSubject, commitKind, connectQuota, connectTier, factLine, followUpLine, groupConnects, hookKey, linkedinSearchUrl, mergePool, poolToBatch, registryFactLine, section, variablePart, weeklyConnects } from './outreach.js';
import { bodySimilarity, bounceGateDecision, buildFirstDraft, displayName, domainRiskTally, enforceSimilarity, isTriggered, loadCompanyPool, postedAgeDays, renderBody, touchGap, TRIGGER_WINDOW_DAYS, type CatalogJob } from './outreach.js';
import { applyboltLookup, extractEmails, extractLeadership, packageNameCandidates, parseApplyBolt, parseDmarcRua, roleAddresses } from './contact-sources.js';
import { controlAddress, mxProvider, rejectionIsMeaningful } from './verify-email.js';
import type { BoardState, Company, Industry, RawJob } from './types.js';

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

console.log('date parsing (recruitee)');
// "2026-08-19 13:16:05 UTC" — not standard ISO, just close enough that
// `new Date()` happens to parse it; guarded anyway, same rule as every ATS.
check('a real recruitee timestamp parses', recruiteeToIso('2026-08-19 13:16:05 UTC'), '2026-08-19T13:16:05.000Z');
check('a garbled string is dropped, not thrown', recruiteeToIso('not a date'), undefined);
check('null is dropped', recruiteeToIso(null), undefined);
check('undefined stays undefined', recruiteeToIso(undefined), undefined);

console.log('workday multi-location placeholder detection');
// Measured 2026-09-04: 13.6% of live Workday jobs across 907 hot boards carry
// a bare count instead of real place names — a Bangalore role posted
// alongside five other offices is invisible to locationMatches otherwise.
check('a bare count is a placeholder', isPlaceholderLocation('6 Locations'), true);
check('singular form still matches', isPlaceholderLocation('1 Location'), true);
check('lowercase still matches', isPlaceholderLocation('2 locations'), true);
check('a real single location is not a placeholder', isPlaceholderLocation('Bengaluru, India'), false);
check('remote is not a placeholder', isPlaceholderLocation('Remote'), false);
check('empty string is not a placeholder', isPlaceholderLocation(''), false);

console.log('date parsing (workday relative labels)');
// Workday dates postings with an English phrase, not a timestamp. Storing the
// phrase raw made `new Date()` return NaN, and `isFreshEnough` treats an
// unparseable date as fresh — so all 3,561 Workday entries in the catalogue
// (38% of it) were exempt from the freshness gate, 1,377 of them while openly
// saying they were over a month old.
const dayOf = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
check('"Posted Today" is today', parsePostedOn('Posted Today'), dayOf(0));
check('"Posted Yesterday" is one day back', parsePostedOn('Posted Yesterday'), dayOf(1));
check('"Posted 5 Days Ago" is five days back', parsePostedOn('Posted 5 Days Ago'), dayOf(5));
check('"Posted 1 Day Ago" (singular) parses', parsePostedOn('Posted 1 Day Ago'), dayOf(1));
// A floor, not a date: the only expression of it is `now - 30d`, which moves
// forward every day and would read as a permanent date-bump. Undefined keeps
// these exactly as they behave today rather than inventing a moving timestamp.
check('"Posted 30+ Days Ago" stays undefined', parsePostedOn('Posted 30+ Days Ago'), undefined);
check('an unrecognised label is dropped', parsePostedOn('Posted a while back'), undefined);
check('undefined stays undefined', parsePostedOn(undefined), undefined);
check('an absurd day count is dropped, not thrown', parsePostedOn('Posted 999999 Days Ago'), undefined);

console.log('workday robots.txt site discovery');
// Every existing Workday entry carries exactly one `site`, whichever URL
// happened to be observed when it was added — CIBC's tenant actually hosts
// both `search` and `campus`, and there was no way to see the second one.
// Ported from open-jobs' `discoverSites` (CC0), fixture-tested here since it's
// pure text parsing with no network.
check(
  'Allow lines win, one site per line',
  parseRobotsSites('User-agent: *\nAllow: /search/\nAllow: /campus/\n').join(','),
  'search,campus',
);
check(
  'Disallow is the fallback when nothing is Allow\'d',
  parseRobotsSites('User-agent: *\nDisallow: /External_Career/\n').join(','),
  'External_Career',
);
check(
  'Sitemap lines also name a site',
  parseRobotsSites('Sitemap: https://x.wd1.myworkdayjobs.com/en-US/External_Career/siteMap.xml\n').join(','),
  'External_Career',
);
check(
  'refreshFacet/events/wday are plumbing, not sites',
  parseRobotsSites('Allow: /refreshFacet/\nAllow: /events/\nAllow: /wday/\nAllow: /search/\n').join(','),
  'search',
);
check('no Allow or Disallow lines yields nothing', parseRobotsSites('User-agent: *\n').join(','), '');

console.log('posting date refresh (date-bump capture)');
// A posting already in `seen` short-circuits out of the run loop, so its
// catalogue entry's postedAt used to be written once and frozen. That is what
// made an employer re-stamping a stale requisition invisible. Only forward
// moves count: Workday's relative labels only ever age, and taking a backwards
// move would manufacture a bump on the next run when it moved forward again.
check('a newer date replaces the stored one', refreshedPostedAt('2026-01-01', '2026-06-01'), true);
check('an older date is ignored', refreshedPostedAt('2026-06-01', '2026-01-01'), false);
check('the same date is not a change', refreshedPostedAt('2026-06-01', '2026-06-01'), false);
check('a first date fills an empty slot', refreshedPostedAt(undefined, '2026-06-01'), true);
check('a board dropping its date leaves the stored one alone', refreshedPostedAt('2026-06-01', undefined), false);
check('an unparseable incoming date is ignored', refreshedPostedAt('2026-06-01', 'Posted 30+ Days Ago'), false);
check('an unparseable stored date is replaced', refreshedPostedAt('Posted Today', '2026-06-01'), true);

console.log('board identity key');
// Roster identity, not job identity. One tenant can host several genuinely
// different boards: RTX's `Private_Posting_No_TMP` and `REC_RTX_Ext_Gateway`
// share a token and return non-overlapping listings. Keyed on ats+token alone
// they collapse to one key, which silently dropped the second on import and let
// `polledTokens` delete whichever site rotation had not selected that run.
const bk = (p: Partial<Company>): string =>
  boardKey({ name: 'x', ats: 'workday', token: 'globalhr', industry: 'tech', ...p } as Company);
check('site is part of the key', bk({ site: 'REC_RTX_Ext_Gateway' }), 'workday:globalhr:rec_rtx_ext_gateway');
check('two sites on one tenant are different boards',
  bk({ site: 'REC_RTX_Ext_Gateway' }) !== bk({ site: 'Private_Posting_No_TMP' }), true);
check('oracle falls back to siteNumber',
  boardKey({ name: 'x', ats: 'oracle', token: 'EGUG', industry: 'tech', siteNumber: 'CX_1' } as Company),
  'oracle:egug:cx_1');
check('a site-less board still keys cleanly',
  boardKey({ name: 'x', ats: 'greenhouse', token: 'Stripe', industry: 'tech' } as Company),
  'greenhouse:stripe:');
check('case does not create a second board',
  bk({ site: 'External_Career' }), bk({ site: 'EXTERNAL_CAREER' }));

console.log('board selection');
// Rotation is what lets the corpus hold ~21,000 boards without the run time
// growing with it. The failure modes here are silent: a hot board demoted to
// rotation stops alerting promptly, and a cold board that never reaches the
// front of the queue is effectively deleted without anyone noticing.
const board = (token: string, extra: Partial<Company> = {}): Company => ({
  name: token, ats: 'greenhouse', token, industry: 'tech', source: 'discovered', ...extra,
});

const mixed = [
  board('hot1', { lastIndiaAt: '2026-08-01T00:00:00Z' }),
  board('hot2', { lastIndiaAt: '2026-07-01T00:00:00Z' }),
  board('coldNew'),                                          // never polled
  board('coldOld'),
  board('coldRecent'),
];

// Poll times come from the board state now, not the Company row, so rotation
// keeps working while companies.json stops being rewritten every run.
const mixedState: BoardState = {
  'greenhouse:hot1:': { lastPolledAt: '2026-08-17T00:00:00Z' },
  'greenhouse:hot2:': { lastPolledAt: '2026-08-17T00:00:00Z' },
  'greenhouse:coldold:': { lastPolledAt: '2026-08-01T00:00:00Z' },
  'greenhouse:coldrecent:': { lastPolledAt: '2026-08-16T00:00:00Z' },
};

const picked = selectBoards(mixed, mixedState, 4);
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
  {},
  1,
);
check('hot boards are never sacrificed to the ceiling', allHot.polling.length, 3);
check('no cold slots remain when hot overflows', allHot.cold, 0);

// An evicted cache must degrade into a clean full sweep, not a frozen slice:
// with no state at all every cold board reads as never-polled, and all of them
// are eligible rather than none.
const noState = selectBoards(mixed, {}, 5);
check('an empty board state polls every board, not zero', noState.polling.length, 5);
check('nothing is stranded when the cache is gone', noState.skipped, 0);

// Seeding covers the first run after the split and any later eviction: the
// legacy fields still on the committed rows are a better starting point than
// declaring the whole corpus never-polled.
const legacy = [board('x', { lastPolledAt: '2026-08-05T00:00:00Z', failingSince: '2026-08-04T00:00:00Z' })];
const seeded = seedBoardState({}, legacy);
check('legacy poll time is seeded from the company row', seeded['greenhouse:x:']?.lastPolledAt, '2026-08-05T00:00:00Z');
check('legacy failure streak is seeded too', seeded['greenhouse:x:']?.failingSince, '2026-08-04T00:00:00Z');
// The state file always wins — it is the live copy, the row is the stale backup.
const already: BoardState = { 'greenhouse:x:': { lastPolledAt: '2026-08-20T00:00:00Z' } };
check('an existing state entry is not overwritten by the legacy row',
  seedBoardState(already, legacy)['greenhouse:x:']?.lastPolledAt, '2026-08-20T00:00:00Z');

// A failed poll keeps its old poll time, so it sorts early and is retried soon
// instead of going to the back of a five-figure queue.
check('a failure preserves the previous poll time',
  recordFailure({ lastPolledAt: '2026-08-05T00:00:00Z' }, '2026-08-06T00:00:00Z').lastPolledAt,
  '2026-08-05T00:00:00Z');
check('a failure starts the streak', recordFailure(undefined, '2026-08-06T00:00:00Z').failingSince, '2026-08-06T00:00:00Z');
check('an ongoing streak keeps its original start',
  recordFailure({ failingSince: '2026-08-01T00:00:00Z' }, '2026-08-06T00:00:00Z').failingSince,
  '2026-08-01T00:00:00Z');
check('success clears the streak', recordSuccess('2026-08-06T00:00:00Z').failingSince, undefined);

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
// Asserted against the constant, not a hard-coded name: the default signature
// changed once already and this check silently pinned the old value.
check('body carries the signature', sample.includes(`— ${SIGNATURE}`), true);
// Every mail must say who is writing and offer a way out — both were missing
// entirely until 2026-09-07, so the recipient met an unnamed stranger quoting
// their commit with nobody to reply to. OUTREACH-DESIGN.md §3/§7 mandate both,
// constant across every touch.
check('body identifies the sender', sample.includes('BE CSE'), true);
check('body carries the opt-out', sample.includes('Tell me to stop'), true);

// The fact line is git-only. Every other rung of the ladder (npm, PyPI, Maven,
// website, leadership) has no commit subject, and the unconditional template
// opened those mails with `Saw your recent commit — "undefined".` — a broken
// merge claiming a commit the recipient never made.
const factlessJob: CatalogJob = {
  id: 'greenhouse:acme:1',
  title: 'Analytics Engineer',
  company: 'meesho',
  location: 'Bengaluru',
  url: 'https://example.com/job/1',
};
const factless = buildFirstDraft(factlessJob, { name: 'Priya Nair', email: 'priya.nair@meesho.com', source: 'npm' });
check('factless draft never says undefined', factless.body.includes('undefined'), false);
// splitName() lowercases for email local parts, so the greeting used to read
// "Hey max," on every mail this tool has ever drafted.
check(
  'the greeting capitalises a lowercased commit-author name',
  buildFirstDraft(factlessJob, { name: 'max mansfield', email: 'max.mansfield@zoom.us' }).body.startsWith('Hi Max,') ||
    buildFirstDraft(factlessJob, { name: 'max mansfield', email: 'max.mansfield@zoom.us' }).body.startsWith('Hello Max,') ||
    buildFirstDraft(factlessJob, { name: 'max mansfield', email: 'max.mansfield@zoom.us' }).body.startsWith('Hey Max,'),
  true,
);
check('factless draft claims no commit', /recent commit|your commit|your push/i.test(factless.body), false);
// "a Analytics Engineer" is the mail-merge tell that reframes the whole message
// as machine-written.
check('article agrees with a vowel-initial title', factless.body.includes('an Analytics Engineer'), true);
check(
  'article agrees with a consonant-initial title',
  buildFirstDraft({ ...factlessJob, title: 'Software Engineer I' }, { name: 'Priya Nair', email: 'priya.nair@meesho.com' }).body.includes(
    'a Software Engineer I',
  ),
  true,
);

// The similarity guard's real threshold is 0.8, not the 0.6 this suite used to
// assert — so the same-company twin case its own comment claimed to protect
// was scoring 0.750 and shipping. Both numbers below are measured, not chosen.
check('same-company twins are actually blocked', enforceSimilarity([{ body: twinA }, { body: twinB }]).kept.length, 1);
check('cross-company bodies survive the guard', bodySimilarity(twinA, sample) < 0.8, true);

// A merely-drafted contact is not a mailed one. syncVerdicts() writes an entry
// for every card it renders, so keying dedup on presence made one hourly build
// exclude every company it displayed — permanently, with nothing sent.
const poolJobs: CatalogJob[] = [
  { id: 'greenhouse:acme:1', title: 'SDE II', company: 'Acme', url: 'https://x/1' },
  { id: 'greenhouse:globex:1', title: 'SDE I', company: 'Globex', url: 'https://x/2' },
];
const contactState = (company: string, touch: number, skipped = false) => ({
  company,
  role: 'x',
  jobUrl: '',
  touch,
  sentAt: touch > 0 ? ['2026-09-01T00:00:00Z'] : [],
  nextDueAt: '',
  subject: 's',
  skipped,
});
const named = (jobs: ReturnType<typeof loadCompanyPool>) => jobs.map((t) => t.company).sort().join(',');
check(
  'a drafted-but-unsent contact keeps its company in the pool',
  named(loadCompanyPool(poolJobs, { 'a@acme.com': contactState('Acme', 0) })),
  'Acme,Globex',
);
check(
  'an actually-mailed contact retires its company',
  named(loadCompanyPool(poolJobs, { 'a@acme.com': contactState('Acme', 1) })),
  'Globex',
);
// "Wrong person" is not "wrong company" — skipping a contact must not burn the
// employer, only that address.
check(
  'skipping a contact does not retire its company',
  named(loadCompanyPool(poolJobs, { 'a@acme.com': contactState('Acme', 0, true) })),
  'Acme,Globex',
);


console.log('smtp reply reading');
// A mail server that hangs up mid-conversation emits 'close' with no 'error'
// and no final reply line. readReply() used to listen for data and error only,
// so the promise never settled; with the socket gone nothing held the event
// loop open and node exited 13 with no stack at all. That took down 5 of 8
// hourly outreach builds. Rejecting is the honest outcome — verifyEmail()
// turns a thrown probe into `unknown`.
{
  const fake = new EventEmitter() as unknown as Parameters<typeof readReply>[0];
  const pending = readReply(fake);
  (fake as unknown as EventEmitter).emit('close');
  const settled = await pending.then(
    () => 'resolved',
    (e: Error) => `rejected: ${e.message}`,
  );
  check('a mid-reply hangup rejects instead of hanging forever', settled, 'rejected: connection closed before a complete reply');
}
{
  // The normal path must still work: a complete final line resolves, and a
  // multi-line 220- continuation must not be read as the answer.
  const fake = new EventEmitter() as unknown as Parameters<typeof readReply>[0];
  const pending = readReply(fake);
  const CRLF = String.fromCharCode(13, 10);
  (fake as unknown as EventEmitter).emit('data', Buffer.from('250-PIPELINING' + CRLF));
  (fake as unknown as EventEmitter).emit('data', Buffer.from('250 OK' + CRLF));
  const reply = await pending;
  check('a complete reply still resolves', `${reply.code} ${reply.text}`, '250 OK');
}

console.log('commit-kind openers');
// A fix, a perf change and a refactor each deserve a different sentence; one
// generic "saw your recent commit" for all of them is what made the opener
// read as generated. Conventional prefixes first, keyword shapes after.
check('conventional fix prefix', commitKind('fix: null check in order parser'), 'fix');
check('conventional feat prefix', commitKind('feat(rtms): add reconnection sample'), 'feat');
check('breaking-change marker does not confuse the prefix', commitKind('feat!: overhaul the onboarding flow'), 'feat');
// Subject matter beats the generic prefix on purpose: a commit touching auth,
// logging, a schema or an endpoint is a more interesting thing to open a mail
// with than the bare fact that something was added. fix and perf still win
// outright, being the strongest hooks available.
check('an api change outranks its feat prefix', commitKind('feat!: drop v1 api'), 'api');
check('security outranks everything', commitKind('feat: add oauth token refresh'), 'security');
check('but a fix stays a fix', commitKind('fix: null check in the request handler'), 'fix');
// Real commit messages are overwhelmingly past tense. Matching only the
// imperative forms a style guide asks for missed 24% of the generic bucket
// across 2,070 real subjects pulled from the orgs this project targets.
check('past-tense verbs classify', commitKind('added support for multiple currencies'), 'feat');
check('past-tense logging work classifies', commitKind('added more logging'), 'observability');
// A ticket id in front defeated every anchored pattern: 13% of the generic
// bucket was nothing but this.
check('a leading ticket id is stripped first', commitKind('PO-166 added support for offsite redirect'), 'feat');
check('and a ticketed version bump is housekeeping', isTrivialCommit('PO-184 : version bump 1.3.0'), true);
check('perf by keyword, no prefix', commitKind('Speed up cold start by lazily loading the parser'), 'perf');
check('fix by keyword, no prefix', commitKind('Fixes crash when the socket closes mid-handshake'), 'fix');
check('ci counts as infra', commitKind('ci: bump runner image'), 'infra');
check('a ticket prefix is not a conventional type', commitKind('SP-1173: say what to do when CUI marking fails'), 'other');
// Both spellings of a revert must be caught, including the unprefixed form
// git itself generates ('Revert "feat: ..."').
check('git-generated revert', commitKind('Revert "feat: add streaming ingest"'), 'revert');
check('conventional revert', commitKind('revert: streaming ingest'), 'revert');
// Opening a cold email by mentioning that somebody had to undo their own work
// is a bad first impression no phrasing rescues, so it produces no fact at all
// and buildFirstDraft omits the paragraph.
check('a revert never becomes an opening line', factLine('Revert "feat: add streaming ingest"', 'Zoom', 'seed'), null);
// The opener says how the sender found them. Unexplained knowledge of a
// stranger's work is what makes this kind of mail feel like surveillance.
{
  // Both variants of every kind explain the provenance; they differ in whether
  // they say 'public repos' or just 'repos', so assert the substance not the
  // exact wording.
  const opener = factLine('fix: null check', 'Zoom', 'seed')!;
  check('the opener explains where the fact came from', /Zoom's.*repos|repos.*Zoom's/.test(opener), true);
}
// The opener already says what kind of change it was, so quoting the prefix
// too labels it twice and reads like a pasted field.
check('a conventional prefix is stripped before quoting', cleanSubject('fix: null check in order parser'), 'null check in order parser');
check('a scoped prefix is stripped too', cleanSubject('feat(rtms): add reconnection'), 'add reconnection');
check('a non-conventional subject is left alone', cleanSubject('Fixes crash on reconnect'), 'Fixes crash on reconnect');
check('stripping never empties the subject', cleanSubject('fix:'), 'fix:');

console.log('registry contacts get a hook too');
// npm, PyPI and Maven all return the package whose manifest carried the
// address, and the mapping into Candidate dropped it — so every registry
// contact shipped with no opening fact at all, a visibly thinner mail than the
// git path for no reason but a lost field.
check('an npm package becomes an opener', registryFactLine('@razorpay/blade', 'npm', 'Razorpay', 'seed')?.includes('@razorpay/blade'), true);
check('the registry is named correctly', registryFactLine('sentry-sdk', 'pypi', 'Sentry', 'seed')?.includes('PyPI'), true);
check('maven reads as Maven Central', registryFactLine('razorpay-java', 'maven', 'Razorpay', 'seed')?.includes('Maven Central'), true);
// A contact with no package (website scan, leadership page) still has no hook,
// and must not get a sentence claiming one.
check('no package means no registry opener', registryFactLine(undefined, 'npm', 'X', 'seed'), null);
check('an unknown source means no registry opener', registryFactLine('pkg', 'git', 'X', 'seed'), null);

console.log('the twin guard is structural, not lexical');
// OUTREACH-DESIGN.md §6 allows two mails to one company on one day provided
// "hooks must differ per recipient". That is a statement about company, role
// and hook, which a bag-of-words score cannot express: once the template pools
// were widened, two colleagues quoting the SAME commit scored 0.559 and two
// with no hook at all scored 0.619 — both under any threshold that does not
// also delete unrelated companies, whose varying part reaches 0.833.
const hk = (company: string, role: string, fact?: string) => hookKey({ company, role, fact });
check('same company, role and hook collide', hk('Acme', 'SDE II', 'fix: x'), hk('acme', 'sde ii', 'fix: x'));
check('a different hook does not collide', hk('Acme', 'SDE II', 'fix: x') === hk('Acme', 'SDE II', 'feat: y'), false);
// Two hookless mails to one company about one role are exactly the blast this
// rule exists to prevent, so a missing hook deliberately collides with itself.
check('two missing hooks collide', hk('Acme', 'SDE II'), hk('Acme', 'SDE II'));
check('a different company never collides', hk('Acme', 'SDE II') === hk('Globex', 'SDE II'), false);

// The signature, identity line, opt-out and link are constant by design
// (§3), and they are about a third of a seventy-word mail. Counting them
// measured the design as if it were repetition.
{
  const withBlock = renderBody({ greet: 'Hi', first: 'A', roleLine: 'R just opened a T.', ask: 'Q?', passAlong: 'P?' });
  check('the varying part drops the constant block', variablePart(withBlock).includes('Tell me to stop'), false);
  check('the varying part keeps the role line', variablePart(withBlock).includes('R just opened a T.'), true);
}

console.log('follow-ups carry new information');
// OUTREACH-DESIGN.md section 4 requires new information every touch and forbids
// "bumping this" — which is exactly what the old single template was. All three
// facts below are already in the catalogue, free, with no extra fetch.
const FU = { company: 'Zoom', role: 'Network Engineer', jobUrl: 'https://x/1' };
const FU_JOB = { id: 'gh:zoom:1', title: 'Network Engineer', company: 'zoom', url: 'https://x/1' };
check(
  'a closed req becomes the reason to write',
  followUpLine(FU, [{ ...FU_JOB, closedAt: '2026-09-01' }], 10).includes('came down'),
  true,
);
check(
  'a newer opening at the same company outranks repeating the old one',
  followUpLine(FU, [FU_JOB, { ...FU_JOB, id: 'gh:zoom:2', url: 'https://x/2', title: 'Media Systems Engineer' }], 10).includes('Media Systems Engineer'),
  true,
);
check('a still-open req is itself the signal', followUpLine(FU, [FU_JOB], 10).includes('still up, 10 days on'), true);
check('a company gone from the catalogue still names the role', followUpLine(FU, [], 10).includes('Network Engineer'), true);
// The old body was identical for every contact, so the similarity guard then
// deleted most follow-ups before they were ever seen.
check(
  'two follow-ups to different companies do not collide',
  bodySimilarity(
    followUpLine(FU, [FU_JOB], 10),
    followUpLine({ company: 'Meesho', role: 'Data Scientist', jobUrl: 'https://y/1' }, [], 4),
  ) < 0.8,
  true,
);

console.log('weekly linkedin list');
// Search urls only — this project never fetches LinkedIn (CONTACT-DISCOVERY.md
// section 9). The human clicks through, already signed in, and sends it.
check(
  'a search url is built, not a profile url',
  linkedinSearchUrl('Max Mansfield', 'Zoom'),
  'https://www.linkedin.com/search/results/people/?keywords=Max%20Mansfield%20Zoom',
);
const CONNECT_NOW = Date.UTC(2026, 8, 10);
const ago = (days: number) => new Date(CONNECT_NOW - days * 86_400_000).toISOString();
const connectState = {
  'a@zoom.us': { company: 'Zoom', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(6)], nextDueAt: '', subject: '', name: 'Max Mansfield' },
  'b@meesho.com': { company: 'Meesho', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(2)], nextDueAt: '', subject: '', name: 'Priya Nair', replied: true },
  'c@never.com': { company: 'Never', role: 'r', jobUrl: '', touch: 0, sentAt: [], nextDueAt: '', subject: '', name: 'Never Mailed' },
  'd@done.com': { company: 'Done', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(9)], nextDueAt: '', subject: '', name: 'Already Connected', connectedAt: ago(1) },
  'e@bounced.com': { company: 'Bounced', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(8)], nextDueAt: '', subject: '', name: 'Bounced Person', bounced: true },
};
const connects = weeklyConnects(connectState as never, CONNECT_NOW);
// Only people already mailed: a request landing days after a real email is a
// second touch, the same request to a stranger is a different play entirely.
check('never-mailed, already-connected and bounced contacts are all excluded', connects.length, 2);
// A reply is the best possible reason to connect, so it sorts to the top.
check('a reply outranks age', connects[0]?.name, 'Priya Nair');
check('then oldest-mailed first', connects[1]?.name, 'Max Mansfield');

// Tiering. The recruiter beats the founder beats the engineer, and a
// SmartRecruiters contact is a recruiter on its source alone — that rung is
// the human who created the req, whether or not a title was ever scraped.
check('a scraped recruiter title tiers as recruiter', connectTier({ title: 'Senior Technical Recruiter' }), 'recruiter');
check('the req creator tiers as recruiter with no title at all', connectTier({ source: 'smartrecruiters' }), 'recruiter');
// A CTO matches the exec pattern too; for a hiring conversation the hiring-lead
// reading is the useful one, so the order of the checks is the behaviour.
check('a CTO tiers as the hiring lead, not as an exec', connectTier({ title: 'CTO' }), 'hiring-lead');
check('a founder tiers as exec', connectTier({ title: 'Co-Founder & CEO' }), 'exec');
check('an unknown title falls through to peer', connectTier({ title: 'Staff Software Engineer' }), 'peer');
check('a reply outranks every title', connectTier({ replied: true, title: 'Recruiter' }), 'replied');

// Clubbing and the follower-count stand-in. Two companies, both peer-only, so
// the tiebreak is company size: the one with fewer open roles goes first, and
// a company the catalogue shows no open role for sorts last rather than first.
{
  const st = {
    'a@big.com': { company: 'Big', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(3)], nextDueAt: '', subject: '', name: 'Big One' },
    'b@big.com': { company: 'Big', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(4)], nextDueAt: '', subject: '', name: 'Big Two' },
    'c@small.com': { company: 'Small', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(1)], nextDueAt: '', subject: '', name: 'Small One' },
    'd@unseen.com': { company: 'Unseen', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(1)], nextDueAt: '', subject: '', name: 'Unseen One' },
  };
  const openRoles = new Map([['big', 90], ['small', 3]]);
  const rows = weeklyConnects(st as never, CONNECT_NOW, { openRoles });
  check('fewer open roles is a better bet than more', rows[0]?.company, 'Small');
  check('a company with no visible open role sorts last, not first', rows[rows.length - 1]?.company, 'Unseen');
  const groups = groupConnects(rows);
  check('one group per company', groups.map((g) => g.company).join(','), 'Small,Big,Unseen');
  check('the company cluster stays together', groups[1]?.rows.length, 2);

  // One recruiter drags their whole company up the list: the request to them
  // and the requests to their colleagues are one sitting.
  const withRecruiter = weeklyConnects(
    { ...st, 'e@big.com': { company: 'Big', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(2)], nextDueAt: '', subject: '', name: 'Big Recruiter', source: 'smartrecruiters' } } as never,
    CONNECT_NOW,
    { openRoles },
  );
  check('a recruiter lifts their whole company above a smaller one', withRecruiter[0]?.company, 'Big');

  // The weekly budget is the real limit on this page, so it must bound the
  // list itself — offering twenty when four are left is how the LinkedIn cap
  // gets blown through.
  check('the offer is capped by what is left this week', weeklyConnects(st as never, CONNECT_NOW, { openRoles, limit: 2 }).length, 2);
  check('nothing is offered at cap', weeklyConnects(st as never, CONNECT_NOW, { openRoles, limit: 0 }).length, 0);
}

// The quota counts marked-sent requests on a rolling 7 days, the way LinkedIn
// counts and the way sentInLast24h() counts mail — not per calendar week.
{
  const st = {
    'a@x.com': { company: 'X', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(20)], nextDueAt: '', subject: '', name: 'A', connectedAt: ago(2) },
    'b@x.com': { company: 'X', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(20)], nextDueAt: '', subject: '', name: 'B', connectedAt: ago(6) },
    'c@x.com': { company: 'X', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(20)], nextDueAt: '', subject: '', name: 'C', connectedAt: ago(8) },
    'd@x.com': { company: 'X', role: 'r', jobUrl: '', touch: 1, sentAt: [ago(20)], nextDueAt: '', subject: '', name: 'D', connectedAt: 'not a date' },
  };
  const q = connectQuota(st as never, CONNECT_NOW);
  check('only requests inside the last 7 days count', q.sent, 2);
  check('remaining is the cap minus those', q.remaining, q.cap - 2);
}

console.log('a crashed send never re-sends what it delivered');
// The only guard used to be "does the .txt still exist", and nothing deletes a
// file after sending it: re-running an interrupted send re-sent every message
// it had already delivered, to the same people, byte for byte.
{
  const entry = { addr: 'a@x.com', file: 'a@x.com.txt', company: 'X', role: 'r', touch: 0 };
  check('unsent draft still sends', alreadySent({} as never, entry), false);
  check('a recorded send of this exact draft blocks the re-send', alreadySent({ 'a@x.com': { touch: 1 } } as never, entry), true);
  // Touch 1 recorded, and this file is the touch-2 follow-up: a different
  // message that has not gone out yet.
  check('the next follow-up in the sequence still sends', alreadySent({ 'a@x.com': { touch: 1 } } as never, { ...entry, touch: 1 }), false);
  // Manifests written before the field existed carry no touch to compare, so
  // they keep the old permissive behaviour rather than refusing a whole run.
  check('a pre-existing manifest is not blocked wholesale', alreadySent({ 'a@x.com': { touch: 3 } } as never, { ...entry, touch: undefined }), false);
}

console.log('publish merge never forgets a click');
// The hourly workflow pulls contacted.json, builds for minutes, then pushes.
// Clicks landing on the live page during those minutes commit to the remote
// through the hosted API, and push() re-reads the sha right before writing, so
// GitHub cannot reject the overwrite. Overwriting reverted a reply or a bounce
// and the next build then mailed that person again.
{
  const local = {
    'a@x.com': { touch: 1, sentAt: ['2026-09-01T00:00:00.000Z'], nextDueAt: '2026-09-05T00:00:00.000Z', verdict: 'valid' },
    'new@x.com': { touch: 0, sentAt: [], nextDueAt: '2026-09-01T00:00:00.000Z' },
  };
  const remote = {
    'a@x.com': { touch: 2, sentAt: ['2026-09-01T00:00:00.000Z', '2026-09-05T00:00:00.000Z'], nextDueAt: '2026-09-14T00:00:00.000Z', replied: true },
    'clicked@x.com': { touch: 1, sentAt: ['2026-09-06T00:00:00.000Z'], nextDueAt: '2026-09-10T00:00:00.000Z', bounced: true },
  };
  const merged = mergeState(local as never, remote as never);
  check('a reply recorded mid-build survives the push', merged['a@x.com']?.replied, true);
  check('a send recorded mid-build survives the push', merged['a@x.com']?.sentAt?.length, 2);
  check('touch follows the union, not either counter', merged['a@x.com']?.touch, 2);
  check('the later follow-up date wins', merged['a@x.com']?.nextDueAt, '2026-09-14T00:00:00.000Z');
  check('locally computed research fields survive too', merged['a@x.com']?.verdict, 'valid');
  check('a contact only the remote knows about is kept', merged['clicked@x.com']?.bounced, true);
  check('a contact only the local build knows about is kept', 'new@x.com' in merged, true);
}

console.log('state reads never fake an empty file');
// The 2026-09-04 catalogue loss: the hunt restored data/jobs.json with
// `curl -o` (whose --retry covers connection failures, not a truncated 200
// body), readJson swallowed the parse error and returned [], updateCatalog
// concluded there was no catalogue yet, and the publish step force-pushed 144
// entries over 2,859 on an orphan branch with no history. Three weeks of
// firstSeen, gone, with the run green and reporting "0 pruned".
{
  const dir = 'out/selftest-readjson';
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/truncated.json`, '[{"id":"a"},{"id":"b","ti', 'utf8');
  await writeFile(`${dir}/empty.json`, '', 'utf8');
  await writeFile(`${dir}/good.json`, '[{"id":"a"}]', 'utf8');
  const outcome = async (path: string): Promise<string> => {
    try {
      return `ok:${JSON.stringify(await readJson<unknown[]>(path, []))}`;
    } catch {
      return 'threw';
    }
  };
  // A genuinely absent file is an ordinary first run and must stay silent.
  check('a missing state file still falls back', await outcome(`${dir}/absent.json`), 'ok:[]');
  // Everything else is corruption wearing an empty file as a disguise.
  check('a truncated download throws instead of reading as empty', await outcome(`${dir}/truncated.json`), 'threw');
  check('a zero-byte file throws too', await outcome(`${dir}/empty.json`), 'threw');
  check('a valid file is unaffected', await outcome(`${dir}/good.json`), 'ok:[{"id":"a"}]');
  await rm(dir, { recursive: true, force: true });
}

console.log('the standing draft pool');
// Drafts used to be regenerated and thrown away every build, so a card seen in
// the morning was gone by lunchtime. Since the send cap is far below what a
// build produces, most drafts were being discarded unsent and unseen.
const poolDraft = (addr: string, over: Record<string, unknown> = {}) => ({
  id: addr, addr, name: 'N', firstName: 'N', company: 'C', role: 'r', jobUrl: '',
  lane: 'random' as const, kind: 'first' as const, touch: 0, overdueDays: 0,
  subject: 's', body: 'b', gmailUrl: '', mailtoUrl: '', ...over,
});
const poolContact = (over: Record<string, unknown> = {}) => ({
  company: 'C', role: 'r', jobUrl: '', touch: 0, sentAt: [], nextDueAt: '', subject: 's', ...over,
});
const NOW_ISO = '2026-09-10T00:00:00.000Z';
const OLD_ISO = '2026-09-01T00:00:00.000Z';

// An option nobody actioned survives the next build — that is the whole point.
const carried = mergePool([{ ...poolDraft('old@x.com'), firstDraftedAt: OLD_ISO }], [poolDraft('new@x.com')], {}, NOW_ISO);
check('an un-actioned option survives a rebuild', carried.length, 2);

// A follow-up is derived state, recomputed from contacted.json every build,
// and its whole identity is a touch count that has already advanced. Pooling
// one is self-defeating: the eviction rule below retires anything with
// touch > 0, so a pooled follow-up is thrown straight back out. A live build
// reported "0 follow-ups" against 207 contacts with two genuinely overdue
// before this was caught, so buildBatch layers them on after the pool split.
const withFollowup = mergePool([], [poolDraft('f@x.com', { kind: 'followup', touch: 1 }), poolDraft('n@x.com')], {}, NOW_ISO);
check('a follow-up is never pooled', withFollowup.map((d) => d.addr).join(','), 'n@x.com');
check('and keeps the date it first appeared', carried.find((d) => d.addr === 'old@x.com')?.firstDraftedAt, OLD_ISO);

// Resolved contacts leave. Same touch > 0 rule the company dedup uses, for the
// same reason: rendering a card is not sending one.
const resolvedOut = mergePool(
  [{ ...poolDraft('sent@x.com'), firstDraftedAt: OLD_ISO }, { ...poolDraft('skip@x.com'), firstDraftedAt: OLD_ISO }, { ...poolDraft('open@x.com'), firstDraftedAt: OLD_ISO }],
  [],
  { 'sent@x.com': poolContact({ touch: 1, sentAt: ['x'] }), 'skip@x.com': poolContact({ skipped: true }) } as never,
  NOW_ISO,
);
check('a mailed or skipped contact leaves the pool', resolvedOut.map((d) => d.addr).join(','), 'open@x.com');

// A week-old option must still name a role that is currently open, so the body
// refreshes while the age does not.
const refreshed = mergePool(
  [{ ...poolDraft('a@x.com', { body: 'stale' }), firstDraftedAt: OLD_ISO }],
  [poolDraft('a@x.com', { body: 'current' })],
  {},
  NOW_ISO,
);
check('a re-drafted option takes the fresh body', refreshed[0]?.body, 'current');
check('but keeps its original age', refreshed[0]?.firstDraftedAt, OLD_ISO);

// Leadership wins over lane: the lane says how fresh the role is, the source
// says what kind of human is on the other end, and the second decides the mail.
check('a follow-up sections as a follow-up', section(poolDraft('a@x.com', { kind: 'followup' }) as never), 'followups');
check('leadership beats a triggered lane', section(poolDraft('a@x.com', { lane: 'triggered', source: 'leadership' }) as never), 'leadership');
check('a triggered git contact stays triggered', section(poolDraft('a@x.com', { lane: 'triggered', source: 'git' }) as never), 'triggered');
check('everything else is random', section(poolDraft('a@x.com', { source: 'npm' }) as never), 'random');
const split = poolToBatch([
  { ...poolDraft('a@x.com', { lane: 'triggered', source: 'git' }), firstDraftedAt: NOW_ISO },
  { ...poolDraft('b@x.com', { source: 'leadership' }), firstDraftedAt: NOW_ISO },
  { ...poolDraft('c@x.com'), firstDraftedAt: NOW_ISO },
] as never);
check('the pool splits into the page sections', [split.triggered.length, split.leadership.length, split.random.length].join(','), '1,1,1');

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

// isTriggered() — a KNOWN posting age decides on its own; firstSeen is only
// consulted when the ATS will not say.
//
// This used to be "fresh by either signal", which was reasonable when written
// but did not survive measurement against the live catalogue: 631 of 1,358
// triggered companies (46%) qualified on firstSeen alone while their own
// postedAt said the role was older than the window. firstSeen p50 is under
// five days, so it tracks how long this project has been watching, not how
// long the role has been open — and the lane exists to find roles the employer
// still cares about, which our own discovery date says nothing about.
//
// The "Posted 30+ Days Ago" case below is the one worth understanding.
// postedAgeDays() parses that bucket as literally 30, though it really means
// "at least 30, possibly years". Either reading keeps it out of a 21-day
// window, which is the right answer: a req the employer itself describes as a
// month old is not a fresh trigger however recently we noticed it.
const catalogJob = (postedAt?: string, firstSeen?: string) => ({
  id: 'x', title: 't', company: 'c', url: '', postedAt, firstSeen,
});
check('fresh postedAt alone triggers', isTriggered(catalogJob('Posted Today', undefined)), true);
check('a known-stale postedAt is not rescued by a fresh firstSeen', isTriggered(catalogJob('Posted 30+ Days Ago', daysAgo(1))), false);
// The case the either-signal rule was actually written for, and it still works:
// plenty of ATSes report no date at all, and for those a role this tracker has
// only just started seeing is exactly what triggered is meant to mean.
check('firstSeen carries it when the ATS reports no date', isTriggered(catalogJob(undefined, daysAgo(1))), true);
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
import { recordFailure, recordSuccess, seedBoardState, updateReposts } from './state.js';
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
// Commas are stripped before matching, so a US range reaches the absolute-INR
// branch (the ₹ is optional in every pattern), clears the bounds, and used to be
// reported as a confident ₹1.2–1.8 LPA on a $120k-$180k posting.
check('usd range is not read as rupees', sal(undefined, 'Base pay: $120,000 - $180,000 per annum'), null);
check('usd code spelled out is caught too', sal(undefined, 'Salary USD 120,000 to 180,000 per annum'), null);
check('gbp range rejected', sal(undefined, 'Salary £70,000 - £90,000 per annum'), null);
check('usd monthly is not read as a rupee stipend', sal(undefined, 'Stipend: $5,000 per month'), null);
// The guard is scoped to the match, not the whole source — an Indian posting
// that happens to mention a dollar figure elsewhere still parses.
check(
  'a stray dollar elsewhere does not block a real inr range',
  JSON.stringify(sal(undefined, 'We raised $50M last year. Compensation: ₹8,00,000 - 12,00,000 per annum')),
  JSON.stringify({ minLpa: 8, maxLpa: 12 }),
);
check('lpa wording is unambiguous and unaffected', JSON.stringify(sal('$ figures aside, 12-18 LPA')), JSON.stringify({ minLpa: 12, maxLpa: 18 }));

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
const P = (...p: string[]) => new Set(p);
let rs: RepostState = updateReposts({}, ['a:1:x'], P('a:1:'), T0);
check('live id tracked clean', rs['a:1:x']?.gone, undefined);
rs = updateReposts(rs, [], P('a:1:'), T1);
check('absent id stamped gone', Boolean(rs['a:1:x']?.gone), true);
rs = updateReposts(rs, ['a:1:x'], P('a:1:'), T3);
check('return clears gone', rs['a:1:x']?.gone, undefined);
// Other-board entries are never touched by another board's poll — cold
// rotation must not stamp absence on boards nobody looked at.
rs['b:2:y'] = { last: T0 };
rs = updateReposts(rs, [], P('a:1:'), T1);
check('foreign board entry untouched by this poll', rs['b:2:y']?.gone, undefined);
check('own board entry got gone stamp', Boolean(rs['a:1:x']?.gone), true);
// Window expiry: an entry last seen long ago is pruned even while absent.
const OLD = daysAgo(REPOST_WINDOW_DAYS + 1);
rs = { 'stale:x': { last: OLD } };
rs = updateReposts(rs, [], P('stale:'), T3);
check('expired absent entry pruned', rs['stale:x'], undefined);

// Multi-site tenants: RTX runs two Workday sites that are separate rows in
// companies.json but share one job-id space, because an id carries no site.
// Judging one site's poll alone made the other's ids look absent and stamped
// them gone; they then came back flagged as reposts. The run now passes every
// polled board's ids in a single call, so the union is what gets judged.
rs = updateReposts({}, ['workday:globalhr:req-A', 'workday:globalhr:req-B'], P('workday:globalhr:'), T0);
rs = updateReposts(rs, ['workday:globalhr:req-A', 'workday:globalhr:req-B'], P('workday:globalhr:'), T1);
check('sibling site ids survive a combined poll', rs['workday:globalhr:req-B']?.gone, undefined);
check('and so does the first site', rs['workday:globalhr:req-A']?.gone, undefined);
// A genuinely closed requisition on a polled tenant is still stamped.
rs = updateReposts(rs, ['workday:globalhr:req-A'], P('workday:globalhr:'), T3);
check('a truly absent id is still stamped gone', Boolean(rs['workday:globalhr:req-B']?.gone), true);

// A token can itself contain colons — Zoho Recruit stores a whole board URL
// there — so the prefix boundary cannot be found by splitting on ':'.
const zoho = 'zohorecruit:https://careers.zohocorp.com/jobs/careers:9001';
rs = updateReposts({ [zoho]: { last: T0 } }, [], P('zohorecruit:https://careers.zohocorp.com/jobs/careers:'), T1);
check('a colon-bearing token still matches its own prefix', Boolean(rs[zoho]?.gone), true);
// A different Zoho board's prefix must not claim it. (A bare `zohorecruit:`
// would match, but the set only ever holds whole `ats:token:` prefixes built
// from real rows, and no row has an empty token.)
rs = updateReposts({ [zoho]: { last: T0 } }, [], P('zohorecruit:https://careers.bbinsight.com/jobs/Careers:'), T1);
check('a sibling zoho board does not claim it', rs[zoho]?.gone, undefined);

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
// extractLeadership — fixtures modeled directly on real leadership pages
// checked live 2026-09-04. Freshworks' card layout (name/title in separate
// block elements) is the shape this is built for; Zoho's flowing-prose
// sentence about "our CEO, Sridhar Vembu" is the false positive an earlier,
// text-collapsing version of this actually produced and had to be guarded
// against — the 60-char title-line cap is what rejects it.
const freshworksLike =
  '<div class="card"><h3>Dennis Woodside</h3><p>CEO and President</p></div>' +
  '<div class="card"><h3>Murali Swaminathan</h3><p>Chief Technology Officer</p></div>';
check(
  'name+title pairs extracted from a card layout',
  JSON.stringify(extractLeadership(freshworksLike)),
  JSON.stringify([
    { name: 'Murali Swaminathan', title: 'Chief Technology Officer' },
    { name: 'Dennis Woodside', title: 'CEO and President' },
  ]),
);
check(
  'engineering-tier title ranks above CEO',
  extractLeadership(freshworksLike)[0]?.title,
  'Chief Technology Officer',
);
const zohoLike =
  '<p>The Government of India has bestowed the prestigious Padma Shri on our CEO, Sridhar Vembu! It is a moment of great honor.</p>';
check('a long prose sentence is not read as a title line', extractLeadership(zohoLike).length, 0);
check('a bare "CEO" with no name-shaped neighbour yields nothing', extractLeadership('<p>Leadership</p><p>CEO</p><p>Reports</p>').length, 0);
// Three more false positives found live 2026-09-05 running leadership-sweep
// against real companies, each fixed and pinned here.
check(
  'an all-caps section heading is not read as a name (abb.com)',
  JSON.stringify(extractLeadership('<p>OUR BUSINESS AREAS</p><p>Morten Wierod, ABB CEO</p>')),
  JSON.stringify([{ name: 'Morten Wierod', title: 'ABB CEO' }]),
);
check(
  'a "Name, Title" one-line pair is read correctly, not the preceding heading (7shifts.com)',
  JSON.stringify(extractLeadership('<p>Our Mission</p><p>Jordan Boesch, CEO</p>')),
  JSON.stringify([{ name: 'Jordan Boesch', title: 'CEO' }]),
);
check(
  'a founding-story sentence with parenthetical titles yields nothing (1bios.co)',
  extractLeadership('<p>Fast Facts</p><p>Founded by Andy Scott (CEO) and David Faber (CTO) in 2014.</p>').length,
  0,
);
check(
  'a title naming another company via "at X" is rejected as a client testimonial (4flow.com)',
  extractLeadership('<p>Wayne Winter</p><p>Vice President EMEA SCM &amp; Procurement at Adient</p>').length,
  0,
);
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
console.log('teamtailor location (schema.org extension, not the feed item)');
// JSON Feed carries no location field at all — the city only exists inside
// Teamtailor's `_jobposting` extension. Reading the item alone silently gives
// every posting an empty location, which filter.ts then drops as unmatched.
check(
  'a single office reads locality, region and country',
  teamtailorPlace({ jobLocation: { address: { addressLocality: 'Bengaluru', addressRegion: 'Karnataka', addressCountry: 'IN' } } }),
  'Bengaluru, Karnataka, IN',
);
check(
  'several offices are joined, not silently reduced to the first',
  teamtailorPlace({ jobLocation: [{ address: { addressLocality: 'Munich' } }, { address: { addressLocality: 'Berlin' } }] }),
  'Munich / Berlin',
);
// "Remote" is appended to the addresses rather than replacing them. Replacing
// them would make every country-locked hybrid role read as globally remote,
// because filter.ts only accepts a remote posting when nothing but noise
// words is left after the addresses are stripped.
check(
  'a remote-flagged posting keeps its country so a locked role stays excluded',
  locationMatches(teamtailorPlace({ jobLocation: [{ address: { addressLocality: 'Stockholm', addressCountry: 'SE' } }], jobLocationType: 'TELECOMMUTE' })),
  false,
);
check(
  'a remote posting with no address at all reads as genuinely global',
  locationMatches(teamtailorPlace({ jobLocationType: 'TELECOMMUTE' })),
  true,
);
check('no location block at all yields empty, not a crash', teamtailorPlace(undefined), '');

console.log('breezy location shapes');
// Breezy sends the single-office form as `location` and the multi-office form
// as `locations`; reading only one of them loses half the corpus.
check('the multi-office array wins over the single field', breezyPlace({ locations: [{ name: 'Bengaluru, KA' }, { name: 'Pune, MH' }] }), 'Bengaluru, KA / Pune, MH');
check('the single-office field is still read', breezyPlace({ location: { name: 'Chaos, FL' } }), 'Chaos, FL');
check('a place with no `name` falls back to its parts', breezyPlace({ location: { city: 'Hyderabad', country: { name: 'India' } } }), 'Hyderabad, India');
check('a remote flag is appended, not substituted', breezyPlace({ location: { name: 'Berlin', is_remote: true } }), 'Berlin, Remote');

console.log('personio XML parsing');
// This shipped broken once, in this adapter's own first draft: the tag regex
// was built inside a template literal written with single backslashes, where
// `\s` is not a recognized escape and collapses to a bare `s`. The pattern
// silently became `([sS]*?)`, every position parsed to nothing, and the board
// returned zero jobs while looking perfectly healthy.
const PERSONIO_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1834171</id>
    <office>Munich</office>
    <additionalOffices><office>Bengaluru</office></additionalOffices>
    <name>Staff Software Engineer</name>
    <jobDescriptions><jobDescription><name>Your tasks</name><value>Build things</value></jobDescription></jobDescriptions>
    <createdAt>2024-11-13T14:10:41+00:00</createdAt>
</position>
</workzag-jobs>`;
const personioJobs = parsePositions(PERSONIO_FEED, 'acme');
check('a real feed yields one position, not zero', personioJobs.length, 1);
check('the title is the position name', personioJobs[0]?.title, 'Staff Software Engineer');
// A description section carries its own <name>, and additionalOffices its own
// <office>. Both nested blocks are stripped before the scalar fields are read,
// so a reordered feed can never report a section heading as the job title.
check('a description heading is not mistaken for the title', personioJobs[0]?.title !== 'Your tasks', true);
check('additional offices are included, not dropped', personioJobs[0]?.location, 'Munich / Bengaluru');
check('the description text is kept for the years gate', personioJobs[0]?.text?.includes('Build things'), true);
check('an empty feed parses to nothing rather than throwing', parsePositions('<workzag-jobs></workzag-jobs>', 'acme').length, 0);
// Personio's feed carries no country field on any position, so an office
// named exactly "Remote" says nothing about where. locationMatches would
// read that as globally remote and let it through. Measured on the first 60
// imported boards: 56 matched only on country-less "Remote" against 4 with a
// real India location, nearly all German listings from German employers.
check('a country-less remote-only office reports no location', personioPlace(['Remote']), '');
check('case and spacing do not rescue it', personioPlace(['  remote  ', 'Home Office']), '');
check(
  'a remote-only office is therefore excluded, not treated as global',
  locationMatches(personioPlace(['Remote'])),
  false,
);
check('a real city is kept even alongside Remote', personioPlace(['Remote', 'Hamburg']), 'Remote / Hamburg');
check('a mixed set with cities stays excluded by the residue check', locationMatches(personioPlace(['Remote', 'Hamburg'])), false);
// Personio tenants name offices with a country-prefixed code. `_` is a word
// character, so `bangalore` never matched "IN_Bangalore" and real India
// boards were being dropped by a word boundary — caught by this check.
check('a country-prefixed office code still reads as India', personioPlace(['IN_Bangalore', 'IN_Pune']), 'IN Bangalore / IN Pune');
check('genuine India offices clear the gate', locationMatches(personioPlace(['IN_Bangalore', 'IN_Pune'])), true);


console.log('subdomain-captured board URLs reject the vendors own hostnames');
// Teamtailor, Breezy and Personio are matched on a *subdomain* rather than a
// path segment, so the vendor's own marketing and app hosts look exactly like
// a customer board. Without the NOT_A_COMPANY guard, `detect` would happily
// add a company literally named "Www".
// Keka spent months listed in the NO_ADAPTER regex after its adapter had
// already shipped, so every Keka board a scan found was reported as
// unsupported and dropped. Its token is a plain subdomain, so it belongs here
// with the other auto-derivable platforms. The check below is the one that
// can't go stale: a platform named as unsupported while an adapter for it
// exists is silent loss, and nothing else in the pipeline would ever say so.
check(
  'nothing listed as unsupported already has a working adapter',
  Object.keys(FETCHERS).filter((ats) => NO_ADAPTER.source.includes(ats)).join(','),
  '',
);
check('a real keka board resolves rather than reading as unsupported', parseBoardUrl('https://peoplebox.keka.com/careers')?.ats, 'keka');
check('a real teamtailor board resolves', parseBoardUrl('https://lifesum.teamtailor.com/jobs')?.token, 'lifesum');
check('a real breezy board resolves', parseBoardUrl('https://acme.breezy.hr/')?.ats, 'breezy');
check('a real personio board resolves', parseBoardUrl('https://acme.jobs.personio.de/xml')?.ats, 'personio');
check('personio .com is the same platform', parseBoardUrl('https://acme.jobs.personio.com/')?.ats, 'personio');
check('the vendor marketing host is rejected', parseBoardUrl('https://www.teamtailor.com/en/'), null);
check('the vendor app host is rejected', parseBoardUrl('https://app.breezy.hr/signin'), null);


console.log('taleo business edition parsing')
// TBE lets each tenant choose its result columns, and they genuinely differ:
// `Title | Department | Work Location | Search Country`, `Title | City |
// State/Territory | ZIP`, and `Title | Job Category` (no location at all) are
// all real, from a six-tenant sample. Reading a fixed column as the location
// would give one board a department, another a ZIP code, and a third nothing.
// Column 0 is always the title, so a label at column N is the row's Nth-1 div.
const TALEO_SORT = (labels: string[]) =>
  labels.map((label, i) => `<option value="https://x/ats/careers/v2/searchResults?org=X&cws=1&act=sort&sortColumn=${i}">${label}</option>`).join('\n');

// The two halves compose, so they are checked together: a column list is only
// correct if it lands on the right field of a real row.
const taleoLocation = (labels: string[], row: string) => parseTaleoRows(row, locationColumns(TALEO_SORT(labels)))[0]?.location;

const TALEO_ROWS = `<div class="oracletaleocwsv2-accordion-head-info">
<h4 class="oracletaleocwsv2-head-title"><a href="https://phg.tbe.taleo.net/phg02/ats/careers/v2/viewRequisition?org=ACME&cws=52&rid=8041" class="viewJobLink">Software Engineer &amp; Analyst</a></h4>
<div tabindex="0" >Engineering</div>
<div tabindex="0" >Bengaluru, India</div>
<div tabindex="0" >India, United States</div>
</div>`;
const taleoJobs = parseTaleoRows(TALEO_ROWS, [1]);
check('a row yields one job', taleoJobs.length, 1);
check('the requisition id comes from the rid parameter', taleoJobs[0]?.externalId, '8041');
check('the title is entity-decoded', taleoJobs[0]?.title, 'Software Engineer & Analyst');
check('the location comes from the chosen column', taleoJobs[0]?.location, 'Bengaluru, India');
check('an India board clears the gate', locationMatches(taleoJobs[0]?.location ?? ''), true);
// The same row parsed with the department column selected is what a fixed
// column index would have produced on a tenant laid out differently.
check('a wrong column would have read a department as the location', parseTaleoRows(TALEO_ROWS, [0])[0]?.location, 'Engineering');
check('a row with no location column parses rather than being dropped', parseTaleoRows(TALEO_ROWS, [])[0]?.title, 'Software Engineer & Analyst');

check(
  'a Work Location column is read as the location',
  taleoLocation(['Title', 'Department', 'Work Location', 'Search Country'], TALEO_ROWS),
  'Bengaluru, India',
);
// The third column here is a country *list* — every country a role can be
// applied from, six of them on one CARE USA posting based in Manila. Folding
// that into the location puts a foreign role into an India-only alert the
// moment such a list mentions India, so a country column is a fallback only.
check(
  'a country list never overrides a real location column',
  taleoLocation(['Title', 'Work Location', 'Search Country'], TALEO_ROWS.replace('<div tabindex="0" >Engineering</div>\n', '')),
  'Bengaluru, India',
);
// ACME Brick's real layout: no "Location" column at all, the place split
// across City and State/Territory, and a ZIP column that must stay out of it.
const TALEO_ADDRESS_ROW = TALEO_ROWS.replace(
  /<div tabindex="0" >[\s\S]*<\/div>\n/,
  '<div tabindex="0" >Houston</div>\n<div tabindex="0" >US-TX</div>\n<div tabindex="0" >77095</div>\n',
);
check(
  'city and state are joined when the tenant has no Location column',
  taleoLocation(['Title', 'City', 'State/Territory', 'ZIP/Postal code'], TALEO_ADDRESS_ROW),
  'Houston, US-TX',
);
check(
  'a tenant with no location column yields an empty location, not a department',
  taleoLocation(['Title', 'Job Category', 'Job Type'], TALEO_ROWS),
  '',
);
check(
  'a country column is used when nothing better exists',
  taleoLocation(['Title', 'Job Category', 'Job Type', 'Country'], TALEO_ROWS),
  'India, United States',
);

// Only Business Edition is covered. The org code is the whole identity: the pod
// in the path is routing (any pod 302s to the tenant's own) and `cws` comes
// back from that redirect, so neither is stored.
check('a TBE board resolves to its org code', parseBoardUrl('https://phg.tbe.taleo.net/phg02/ats/careers/v2/searchResults?org=CAREUSA&cws=52')?.token, 'CAREUSA');
check('and to the taleo adapter', parseBoardUrl('https://phe.tbe.taleo.net/phe01/ats/careers/v2/searchResults?org=ACTIONLINK&cws=1')?.ats, 'taleo');
// Enterprise Taleo is a different product that `taleo.ts` cannot read. It must
// resolve to null rather than be imported as a board that can never be fetched.
check('enterprise Taleo careersection is not mistaken for TBE', parseBoardUrl('https://acme.taleo.net/careersection/ex/jobsearch.ftl'), null);


console.log('YC directory domain cleanup')
// The directory stores whatever URL the founders typed. This list is now swept
// weekly by discover.yml, so a domain that `detect` cannot fetch is a company
// silently skipped every week rather than a one-off annoyance.
check('a plain https url', bareDomain('https://razorpay.com'), 'razorpay.com');
check('www is dropped', bareDomain('https://www.zuddl.com/'), 'zuddl.com');
check('a trailing path is dropped', bareDomain('http://loophealth.com/careers'), 'loophealth.com');
// 100x's listed website is `https://100x.bot?utm_source=inbound&...` with no
// path separator at all, so splitting on "/" alone left the whole campaign tail
// glued to the hostname.
check('a query string with no path is dropped', bareDomain('https://100x.bot?utm_source=inbound&utm_medium=bookface'), '100x.bot');
check('a fragment is dropped', bareDomain('https://acme.in#about'), 'acme.in');


console.log('rate-limit bucketing')
// This key function was duplicated in bulk-import.ts, and the copy kept only
// the Workday case while its comment claimed to be "the same shape as the
// hourly run's scheduler". It therefore keyed all 1,392 published
// SuccessFactors tenants — which live on 1,289 *distinct* hostnames — into one
// bucket capped at 2, turning a sweep that touches each host once into a
// ~16-hour serial crawl. There is now one exported copy; these checks are what
// makes a second one show up as a failure rather than as a slow overnight run.
const sf = (host: string) => rateLimitKey({ ats: 'successfactors' as const, token: 'acme', host });
check('SuccessFactors is keyed by its own host', sf('career5.successfactors.eu'), 'successfactors:career5.successfactors.eu');
check('two SF tenants on different hosts do not share a bucket', sf('career5.successfactors.eu') === sf('jobs.sap.com'), false);
check('an SF tenant with no host falls back to its token', rateLimitKey({ ats: 'successfactors', token: 'careers.acme.com' }), 'successfactors:careers.acme.com');
check('Workday is keyed by pod, so wd5 boards queue together', rateLimitKey({ ats: 'workday', token: 'acme', host: 'wd5' }), 'workday:wd5');
check('Greenhouse boards all share one API host', rateLimitKey({ ats: 'greenhouse', token: 'acme' }), 'greenhouse');
// The cap is looked up by platform even though the key carries the host, which
// is what makes "2 per host" mean 2 per host rather than 2 in total.
check('the per-host cap is read from the platform half of the key', limitForHost('successfactors:career5.successfactors.eu'), 2);
check('an unlisted platform falls back to the default cap', limitForHost('taleo'), 4);

// `maxBuckets` bounds how many host groups run at once. Without it a full
// SuccessFactors import opens ~1,300 concurrent XML feeds, each with a
// 180-second timeout and a multi-megabyte body.
let liveBuckets = 0;
let peakBuckets = 0;
await mapLimitByKey(
  Array.from({ length: 40 }, (_, i) => `host${i}`),
  (h) => `successfactors:${h}`,
  () => 2,
  async () => {
    peakBuckets = Math.max(peakBuckets, ++liveBuckets);
    await new Promise((r) => setTimeout(r, 1));
    liveBuckets--;
  },
  4,
);
check('maxBuckets bounds how many hosts run at once', peakBuckets <= 4, true);


console.log('bulk-import CSV field splitting')
// The splitter was a bare `line.split(',')` on the assumption that only the
// trailing url could contain a comma. 896 rows across the six original tenant
// lists disprove that: a quoted company name with a comma pushes the tail of
// the name into the slug field, and the row resolves to a nonsense token that
// dies at validation. 331 of iCIMS's 2,498 rows are this shape.
check(
  'a quoted name containing a comma keeps the slug intact',
  csvFields('"80,000 Hours",80000hours,https://jobs.ashbyhq.com/80000hours')[1],
  '80000hours',
);
check(
  'the company name is reassembled, not truncated at the comma',
  csvFields('"Apex Technology, Inc.",apex-technology-inc,https://x')[0],
  'Apex Technology, Inc.',
);
check('an ordinary unquoted row is unchanged', csvFields('Airtel,airtel,https://airtel.darwinbox.in')[1], 'airtel');
check('a row with a trailing empty column keeps it', csvFields('10x Genomics,10xgenomics,https://x,').length, 4);

console.log('ukg location (address block, not the internal site label)')
// UKG's `LocalizedName` is the employer's own site code — "NM - KAFB",
// "AL - USAG Redstone" — with no city or country in it. Reading that as the
// location would make every posting on the platform invisible to the
// India/remote gate, since there is nothing in it for the regex to match.
check(
  'the address block supplies a real place name',
  ukgPlace([{ LocalizedName: 'KA - BLR7', Address: { City: 'Bengaluru', State: { Name: 'Karnataka' }, Country: { Name: 'India' } } }]),
  'Bengaluru, Karnataka, India',
);
check(
  'an India address actually clears the location gate',
  locationMatches(ukgPlace([{ LocalizedName: 'KA - BLR7', Address: { City: 'Bengaluru', Country: { Name: 'India' } } }])),
  true,
);
check('several sites are joined', ukgPlace([{ Address: { City: 'Pune' } }, { Address: { City: 'Chennai' } }]), 'Pune / Chennai');
check('a location with no address at all yields empty, not the site code', ukgPlace([{ LocalizedName: 'NM - KAFB' }]), '');
check('no locations at all yields empty', ukgPlace(undefined), '');

console.log('IMPORTABLE staleness guard')
// The check that would have caught this file's own worst bug: IMPORTABLE sat
// at seven platforms while the source published forty-eight, so Keka tracked 7
// boards against 185 published tenants with a working adapter the whole time.
// Pure function so this needs no network call.
check(
  'a published list for an adapter nobody feeds is reported',
  unfedPlatforms(['keka.csv', 'greenhouse.csv'], ['greenhouse'], ['keka', 'greenhouse']).join(','),
  'keka',
);
check(
  'a platform already in IMPORTABLE is not reported',
  unfedPlatforms(['keka.csv'], ['keka'], ['keka']).length,
  0,
);
check(
  'a published list with no adapter is not reported — that is a build decision, not staleness',
  unfedPlatforms(['taleo.csv', 'bamboohr.csv'], [], ['keka']).length,
  0,
);
// A platform can be published, have an adapter, and still be deliberately not
// imported — without the exemption it would warn on every run and become a
// line everyone scrolls past. The exemption set is passed in rather than read
// from the module, because what belongs in it changes: iCIMS sat there for one
// day until its modern-portal path was built, and the test should outlive that.
check(
  'a deliberately-skipped platform stays quiet',
  unfedPlatforms(['someats.csv'], [], ['someats'], { someats: 'measured dead' }).length,
  0,
);
check(
  'and is reported again once the exemption is lifted',
  unfedPlatforms(['someats.csv'], [], ['someats'], {}).join(','),
  'someats',
);

console.log('open-jobs slug diffing')
// These lists are crawled out of URLs, so the same tenant appears with
// different casing across the two published sources. A case-sensitive compare
// would hand bulk-import thousands of boards it already polls.
check('an already-tracked slug is dropped', untrackedSlugs(['acme', 'newco'], ['acme']).join(','), 'newco');
check('casing does not defeat the dedup', untrackedSlugs(['ACME'], ['acme']).length, 0);
check('duplicates within the source collapse', untrackedSlugs(['newco', 'NewCo', 'newco'], []).join(','), 'newco');
check('blank and whitespace-only entries are skipped', untrackedSlugs(['', '   ', 'real'], []).join(','), 'real');
check('original casing is preserved for the board token', untrackedSlugs(['NewCo'], []).join(','), 'NewCo');

console.log('icims modern portal parsing')
// iCIMS was written off as unreachable because /api/jobs 404s on modern
// "Talent Cloud" tenants. It does — but those tenants server-render their
// search page inside an iframe, and fetching that URL directly returns real
// rows. Measured on a 40-tenant sample: 38 return rows.
const ICIMS_ROW = `<ul class="iCIMS_JobsTable"><li class="iCIMS_JobCardItem">
  <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span > IN-KA-Bengaluru</span></div>
  <div class="col-xs-12 title"><a href="https://x-acme.icims.com/jobs/4021/staff-engineer/job?in_iframe=1" class="iCIMS_Anchor"><span class="sr-only field-label">Title</span><h3 > Staff Engineer</h3></a></div>
  <div class="col-xs-12 description">Five years of experience required.</div>
</li></ul>`;
const icimsJobs = parsePortal(ICIMS_ROW, 'x-acme.icims.com');
check('a card yields one job', icimsJobs.length, 1);
check('the requisition id comes from the job path', icimsJobs[0]?.externalId, '4021');
check('the title comes from the card heading', icimsJobs[0]?.title, 'Staff Engineer');
check('the url drops the iframe parameter', icimsJobs[0]?.url, 'https://x-acme.icims.com/jobs/4021/staff-engineer/job');
check('an inline description is kept, so no enrich round trip is needed', icimsJobs[0]?.text, 'Five years of experience required.');
// The location label is tenant-configured: "Location" and "Job Locations" both
// occur, so the pattern matches any label containing "Location".
check(
  'the other label spelling parses too',
  parsePortal(ICIMS_ROW.replace('Job Locations', 'Location'), 'x-acme.icims.com')[0]?.location,
  'IN-KA-Bengaluru, India',
);
// Some tenants localize the label — one Italian board calls it "Sedi di
// lavoro" — and some put the location only in additionalFields. Neither is
// reachable by an English pattern, but iCIMS tags exactly the location fields
// with a map-marker glyphicon, so the icon identifies them where text cannot.
// Position would be the wrong fallback: other tenants lead with "Client Team".
const ICIMS_LOCALIZED = `<li class="iCIMS_JobCardItem">
  <div class="col-xs-12 title"><a href="https://it-acme.icims.com/jobs/3904/process-engineer/job"><h3 > Process Engineer</h3></a></div>
  <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField"><span class="glyphicons glyphicons-map-marker"></span><span class="sr-only field-label">Sedi di lavoro</span></dt><dd class="iCIMS_JobHeaderData"><span > IT-Rho</span></dd></div>
</li>`;
check(
  'a localized label is recovered from the map-marker icon',
  parsePortal(ICIMS_LOCALIZED, 'it-acme.icims.com')[0]?.location,
  'IT-Rho',
);
const ICIMS_NON_LOCATION = `<li class="iCIMS_JobCardItem">
  <div class="col-xs-12 title"><a href="https://x.icims.com/jobs/7/driver/job"><h3 > Driver</h3></a></div>
  <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Vehicle Information</dt><dd class="iCIMS_JobHeaderData"><span > Van</span></dd></div>
</li>`;
check(
  'an unmarked header field is not mistaken for a location',
  parsePortal(ICIMS_NON_LOCATION, 'x.icims.com')[0]?.location,
  '',
);
// iCIMS writes locations as COUNTRY-STATE-CITY. A bare country code is not
// something the INDIA regex can match, so a leading IN- gets the country name
// appended. Only leading: "US-IN-Indianapolis" is Indiana, and expanding that
// would put US roles into an India-only alert.
check('a leading IN- is expanded so the India gate can see it', normalizeLocation('IN-KA-Bengaluru'), 'IN-KA-Bengaluru, India');
check('an India location clears the gate', locationMatches(normalizeLocation('IN-Remote')), true);
check('Indiana in the state slot is left alone', normalizeLocation('US-IN-Indianapolis'), 'US-IN-Indianapolis');
check('and Indiana still does not read as India', locationMatches(normalizeLocation('US-IN-Indianapolis')), false);
check('an empty location stays empty rather than becoming ", India"', normalizeLocation('  '), '');
// Page size is tenant-configured (20 and 50 both observed), so the walk is
// bounded by the portal's own count rather than by rows returned.
check('the page count is read from the portal', pageCount('<div>Search Results Page 1 of 7</div>'), 7);
check('a single-page board reports one', pageCount('<div>Page 1 of 1</div>'), 1);
check('a portal with no paging text still reports one', pageCount('<div>nothing here</div>'), 1);

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
