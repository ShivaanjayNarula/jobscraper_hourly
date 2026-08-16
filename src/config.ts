/**
* Every tunable lives here. Start wide, tighten after a week of real output —
* it is much easier to notice noise than to notice a job you never saw.
*/

/** Keep roles at or below this many years. Postings with no stated years are kept. */
export const MAX_YEARS = 3;

/** Full-time and internships both count. */
export const INCLUDE_INTERNSHIPS = true;

/**
* Drop a board after it has been failing continuously for this long. Time-based
* rather than a failure count, so a bad afternoon doesn't evict a good company.
*/
export const DROP_AFTER_FAILING_DAYS = 3;

/** Forget a job ID after this long, so the state file stays small. */
export const SEEN_RETENTION_DAYS = 45;

/** Render this many roles as full cards; the rest become compact one-liners. */
export const EMAIL_DETAIL_LIMIT = 25;

/**
* "New" in the pipeline means "never seen by this tracker before" — a role's
* requisition ID, not its posting date. Those diverge constantly: adding a
* company, or a board recovering after days of errors, makes its entire
* current listing look brand-new even if half of it was posted months ago.
* 573 of 1,101 dated roles in the catalog on 2026-08-11 were 30+ days old.
*
* The whole point of an hourly alert is being early — a role open 111 days
* has no early-mover advantage left. So the email only surfaces roles posted
* within this window; older "new to us" discoveries still land in the
* catalogue (nothing is dropped), they just don't masquerade as urgent.
* Roles with no parseable posting date are always included — many ATSes
* (Workday chief among them) never expose one at all, so absence of a date
* cannot be treated as evidence of staleness.
*/
export const EMAIL_FRESHNESS_DAYS = 21;

/**
* Concurrent board fetches. Politeness, not a technical limit — but with 500+
* boards the run was approaching ten minutes at 6, so this is the balance.
*/
export const CONCURRENCY = 9;

/**
* Word-bounded, and that matters more than it looks: without `\b`, "india"
* matches **Indiana** and **Indianapolis** (62 US roles were leaking through),
* and "goa" matches "Goal". Substring matching on place names is a trap.
*/
export const INDIA = new RegExp(
`\\b(${[
   'india',
   'bengaluru',
   'bangalore',
   'hyderabad',
   'mumbai',
   'pune',
   'chennai',
   'new delhi',
   'delhi',
   'gurgaon',
   'gurugram',
   'noida',
   'kolkata',
   'ahmedabad',
   'jaipur',
   'indore',
   'kochi',
   'trivandrum',
   'thiruvananthapuram',
   'coimbatore',
   'chandigarh',
   'bhubaneswar',
   'nagpur',
   'vadodara',
   'mysuru',
   'mysore',
   'visakhapatnam',
   'goa',
 ].join('|')})\\b`,
'i',
);

export const REMOTE = /\b(remote|work from home|wfh|anywhere|distributed)\b/i;

/**
* "Remote - US" is not remote for someone applying from India. If a posting
* names a specific non-India region, we drop it unless India is named too.
*/
export const REGION_LOCKED =
/\b(united states|u\.?s\.?a?\b|usa|canada|united kingdom|\buk\b|emea|latam|apac only|europe|germany|france|netherlands|poland|brazil|mexico|australia|singapore|japan|china)\b/i;

/** Mass-hiring IT services firms — excluded by request. */
export const SERVICE_COMPANIES =
/\b(tcs|tata consultancy|infosys|wipro|cognizant|accenture|capgemini|hcl|hcltech|tech mahindra|ltimindtree|mphasis|hexaware|birlasoft|coforge|persistent systems|zensar|mindtree|dxc|atos|virtusa|ust global|quess|randstad|adecco|genpact|firstsource|wns global|conduent|concentrix|teleperformance)\b/i;

/** A role only alerts if its title matches one of these families. */
/**
 * A role only alerts if its title matches one of these families.
 *
 * Measured against the 12 highest-India-volume boards, 830 of 1,969 India
 * roles (42%) were being dropped here — not because they were senior or
 * irrelevant, but because whole job categories had no family at all. The
 * additions below come from that measured vocabulary, not from guesswork:
 * `advisory` alone appeared 235 times (KPMG/PwC label nearly everything
 * "Advisory"), and `qa|test` never matched the spelled-out "Quality
 * Assurance".
 *
 * Widening a family only makes a role *visible*; the per-industry seniority
 * rules in classify.ts still gate it. That division is deliberate — it is why
 * adding `product` does not flood the inbox with "Product Manager", since
 * `manager` remains a senior term everywhere.
 */
export const ROLE_FAMILIES: Record<string, RegExp> = {
  swe: /\b(software|engineer|developer|sde|swe|programmer|full[- ]?stack|backend|back[- ]end|frontend|front[- ]end|mobile|android|ios|platform|infrastructure|devops|sre|reliability|qa|test|security engineer|systems)\b/i,
  // Hardware/silicon terms matter here specifically because the semiconductor
  // GCCs (Qualcomm, TI, AMD, Infineon, Microchip) are now covered, and their
  // India design centres hire freshers heavily.
  swe: /\b(software|engineer|developer|sde|swe|programmer|full[- ]?stack|backend|back[- ]end|frontend|front[- ]end|mobile|android|ios|platform|infrastructure|devops|sre|reliability|qa|quality assurance|sdet|test|automation|security engineer|systems|embedded|firmware|vlsi|rtl|asic|fpga|silicon|physical design)\b/i,
data: /\b(data|machine learning|\bml\b|\bai\b|analytics|scientist|research|nlp|computer vision|deep learning|quantitative|quant)\b/i,
  finance: /\b(analyst|associate|consultant|investment|risk|trading|trader|actuar|audit|finance|banking|strategy|operations analyst)\b/i,
  finance: /\b(analyst|associate|consultant|advisory|investment|risk|\bgrc\b|\btprm\b|compliance|treasury|\btax\b|trading|trader|actuar|audit|finance|banking|strategy|operations analyst)\b/i,
  // Product and program work is a standard CS-grad path; `manager` still gates
  // the senior end, so in practice this surfaces APM/Product Analyst/Product
  // Owner rather than the manager rungs.
  product: /\b(product manager|product owner|product analyst|associate product|\bapm\b|program manager|programme manager|technical program|project manager|scrum|business analyst)\b/i,
  design: /\b(designer|\bux\b|\bui\b|user experience|user research|product design|interaction design)\b/i,
  security: /\b(security|cyber|infosec|penetration test|appsec|threat|vulnerability|identity (?:&|and) access)\b/i,
};
