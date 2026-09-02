import type { Industry, RawJob } from './types.js';

/**
 * Seniority vocabulary is per-industry on purpose.
 *
 *   "Associate"  -> junior at JPMorgan, mid-senior at Stripe
 *   "Analyst"    -> entry-level in consulting/banking, often mid-level in tech
 *   "Consultant" -> entry-ish at Big 4, senior at a product company
 *
 * One shared keyword list would misclassify roughly half of the finance side,
 * so each industry gets its own promote/demote pair.
 */
interface SeniorityRules {
  junior: RegExp;
  senior: RegExp;
}

/**
 * Level suffixes mean "not entry level" in every industry, not just tech.
 * The separator has to be greedy: "Engineer II", "Engineer - II" and
 * "Engineer- 2" are all the same role, and an anchored single-character class
 * silently misses the spaced-hyphen forms.
 */
// Large employers run levels past 4 — "Mgmt 5", "L6", "Level 7" are all senior,
// not just II-IV. "Software Test Engineer I" and "Refrigeration Engineer I"
// deliberately don't match here: level *I* / *1* is the entry rung, not senior.
const LEVEL_SUFFIX = '[\\s-]+(ii|iii|iv|v|vi|2|3|4|5|6|7|8|9)\\b';

/**
 * Terms that mean "not entry level" regardless of sector. Keeping these in one
 * place matters: "Distinguished" originally lived only in the tech list, so
 * Capital One — tagged `banking` — surfaced a Distinguished AI Engineer as a
 * fresher role.
 */
const UNIVERSAL_SENIOR =
  // Bare "head" rather than "head of" — "Head - Advanced Analytics" slipped
  // through until this was widened.
  // "Supv" is a common enterprise-Workday abbreviation for Supervisor — a
  // management title, not entry-level — and slipped through as plain "aah".
  'senior|sr\\.?|staff|principal|director|head|architect|distinguished|chief|vice president|vp|executive director|managing director|md|mgmt|supv\\.?|supervisor';

const TECH: SeniorityRules = {
  junior:
    /\b(intern|internship|new ?grad|graduate|campus|trainee|apprentic|entry[- ]level|fresher|junior|jr\.?|sde[ -]?(1|i)\b|swe[ -]?(1|i)\b|software engineer (1|i)\b|associate (engineer|developer|software)|early career|l3\b)/i,
  senior: new RegExp(`\\b(${UNIVERSAL_SENIOR}|lead|manager|fellow)\\b|${LEVEL_SUFFIX}`, 'i'),
};

const FINANCE: SeniorityRules = {
  junior:
    /\b(analyst|associate|graduate|summer|off[- ]cycle|campus|trainee|intern|internship|entry[- ]level|programme|program 20\d\d)/i,
  senior: new RegExp(`\\b(${UNIVERSAL_SENIOR}|lead|manager|partner)\\b|${LEVEL_SUFFIX}`, 'i'),
};

const CONSULTING: SeniorityRules = {
  junior:
    /\b(business analyst|associate consultant|analyst|associate|summer|graduate|campus|intern|internship|trainee|fellow)/i,
  senior: new RegExp(
    `\\b(${UNIVERSAL_SENIOR}|engagement manager|manager|partner|expert|lead)\\b|${LEVEL_SUFFIX}`,
    'i',
  ),
};

const RULES: Record<Industry, SeniorityRules> = {
  tech: TECH,
  fintech: TECH,
  quant: FINANCE,
  banking: FINANCE,
  consulting: CONSULTING,
};

const INTERN = /\b(intern|internship|co[- ]?op|summer analyst|industrial trainee)\b/i;

/**
 * Work-mode normalization. The location string decides remote/hybrid/onsite
 * (a "Remote, US" posting must not read as remote-for-India here — that gate
 * already lives in filter.ts's locationMatches), with the body only breaking
 * ties a bare location can't: many Workday boards say just "Bengaluru" while
 * the description says "remote during onboarding".
 */
const REMOTE_MODE = /\b(?:remote|work from home|wfh|fully distributed)\b/i;
const HYBRID_MODE = /\bhybrid\b/i;
const VISA = /\bvisa\b[^.]{0,40}\bsponsor|\bsponsor(ship)?\b[^.]{0,40}\bvisa\b|work (?:authorization|permit) (?:sponsorship|support)/i;

/**
 * Roles that are entry-level but not what a BE CSE grad is hunting for.
 * JPMorgan's board in particular is full of retail branch positions.
 */
const HARD_EXCLUDE = new RegExp(
  [
    // Retail and facilities — JPMorgan and Amazon boards are full of these.
    'banker|teller|branch|cashier|custodian|janitor|warehouse|driver|nurse|therapist',
    'security guard|barista|retail sales|store associate|part[- ]time associate',
    'technician|data cent(?:er|re)|in stock|fulfil?lment',
    // Annotation/ops roles that look technical but are not engineering.
    'data associate|digital associate|ai data|support associate|it support',
    'customer (?:service|support)|account executive|recruiter',
    // Back-office roles at the consulting firms. These reach the inbox via the
    // `finance` family's "Analyst"/"Executive" (both junior titles in Indian
    // consulting), not via anything technical — "Analyst - Employee Vetting &
    // Background checks" alone was posted ~10 times on one KPMG sweep.
    'employee vetting|background check|executive assistant|\\bsecretary\\b',
    'accounts payable|accounts receivable|payroll|talent acquisition|human resources',
    // Commercial roles slip in through keyword overlap — "Cloud Data Platform
    // Sales" matched the data family on the word "Data". \bsales\b is safe:
    // "Salesforce Developer" has no word boundary after "sales".
    'sales|marketing|business development|account manager|partner manager|pre[- ]?sales',
    // The `swe` family's bare \bengineer\b and `data` family's bare \bscientist\b
    // were written for pure-tech boards. Industrial/pharma GCCs (Thermo Fisher,
    // GE Vernova, Baker Hughes) post hundreds of mechanical, electrical, HVAC
    // and wet-lab roles that also say "Engineer" or "Scientist" — none of them
    // software. Same fix as the sales carve-out above: keep the family regex
    // broad, exclude the specific non-software domains here.
    'mechanical engineer|refrigeration|fire protection|\\bhvac\\b|plant layout|cable tray|piping engineer',
    'field service engineer|reliability (?:&|and) maintenance|\\brme\\b|process engineer',
    'application(?:s)? scientist|field applications? scientist|protein biology|\\bbiopharma\\b',
    // Same leak, automotive flavor: Mahindra's and Bajaj Auto's boards are full
    // of "Engineer - <part>" reqs for physical vehicle components, not software.
    'chassis|transaxle|powertrain|drive away|dimensional engg|body systems|tractor engine|\\bbrakes\\b',
    'vehicle testing|vehicle style|vehicle integration|lighting systems|plastic parts',
    'casting (?:&|and) forging|steering systems|civil engineer|facility management',
    'data entry',
  ].join('|'),
  'i',
);

const YEARS_RANGE = /(\d{1,2})\s*(?:\+|to|-|–|—)\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?)/gi;
const YEARS_MIN = /(?:minimum(?: of)?|at least|min\.?)\s*(\d{1,2})\s*(?:years?|yrs?)/gi;
/**
 * Any bare "N years", which the range and "N+" patterns both miss. Needed for
 * text like "2 years required, 7+ years preferred" — without it only the 7 was
 * seen and the role was filtered out as senior.
 */
const YEARS_ANY = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;

/**
 * Postings routinely state several ranges — "0-2 years required, 5+ preferred".
 * We keep the smallest stated minimum, because that's the bar to actually apply.
 */
export function extractYears(text: string): { min: number | null; max: number | null } {
  const mins: number[] = [];
  const maxes: number[] = [];

  for (const m of text.matchAll(YEARS_RANGE)) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : null;
    if (Number.isFinite(lo) && lo <= 40) mins.push(lo);
    if (hi !== null && Number.isFinite(hi) && hi <= 40) maxes.push(hi);
  }
  for (const re of [YEARS_MIN, YEARS_ANY]) {
    for (const m of text.matchAll(re)) {
      const lo = Number(m[1]);
      if (Number.isFinite(lo) && lo <= 40) mins.push(lo);
    }
  }

  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxes.length ? Math.max(...maxes) : null,
  };
}

export interface Classification {
  minYears: number | null;
  maxYears: number | null;
  isIntern: boolean;
  /** False when the title clearly marks the role as beyond entry level. */
  isJunior: boolean;
  excluded: boolean;
  /** Normalized from location+body wording; null when the posting doesn't say. */
  workMode: 'remote' | 'hybrid' | 'onsite' | null;
  /** Posting explicitly mentions visa sponsorship — rare and high-signal for India GCC roles. */
  visa: boolean;
}

export function classify(job: RawJob, industry: Industry): Classification {
  const title = job.title;
  const body = `${title} ${job.text ?? ''}`;
  const rules = RULES[industry];

  const { min, max } = extractYears(body);
  const titleSaysJunior = rules.junior.test(title);
  const titleSaysSenior = rules.senior.test(title);

  const yearsSayJunior = min !== null && min <= 3;
  const yearsSaySenior = min !== null && min > 3;

  // An explicitly senior title is decisive. "Sr. Business Analyst" and
  // "Engineer II" are never fresher roles, however friendly the body text looks
  // — descriptions routinely quote a low range for one bullet and a high one for
  // another, so letting years override the title lets seniors straight through.
  const isJunior =
    !titleSaysSenior && !yearsSaySenior && (yearsSayJunior || titleSaysJunior || min === null);

  const locRemote = REMOTE_MODE.test(job.location);
  const workMode: Classification['workMode'] = HYBRID_MODE.test(`${job.location} ${body}`)
    ? 'hybrid'
    : locRemote || REMOTE_MODE.test(body)
      ? 'remote'
      : job.location
        ? 'onsite'
        : null;

  return {
    minYears: min,
    maxYears: max,
    isIntern: INTERN.test(title),
    isJunior,
    excluded: HARD_EXCLUDE.test(title),
    workMode,
    visa: VISA.test(body),
  };
}
