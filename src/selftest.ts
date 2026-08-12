import { classify } from './classify.js';
import { isFreshEnough, locationMatches, normalizeForDedup, roleFamily } from './filter.js';
import type { Industry, RawJob } from './types.js';

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

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
