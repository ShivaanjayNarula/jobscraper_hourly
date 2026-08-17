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
 * Soft ceiling on boards polled per run.
 *
 * Measured: 3,793 boards took 23m59s, i.e. roughly 2.6 boards/sec once
 * per-host scheduling is doing its job. The importable corpus is ~21,000
 * boards on platforms we already support, which at that rate is over two
 * hours — past the hourly cadence and past what an Actions job should hold
 * open.
 *
 * The resolution is that not every board deserves the same attention. A board
 * that has shown an India/remote role is polled every run; one that never has
 * is swept on rotation, oldest-polled first, and the moment one shows an India
 * role it is promoted and never rotated again.
 *
 * 6,000 is derived from the measurement, not picked: at ~2.6 boards/sec it is
 * roughly 38 minutes, which leaves real headroom inside the hourly cadence.
 * With ~3,800 hot boards that leaves ~2,200 rotation slots, so a 15,000-board
 * cold tier is swept end to end about every seven hours — every board seen
 * several times a day, while anything that can actually alert is polled hourly.
 *
 * Raise this only after measuring a real run, not on a hunch — the cron was
 * already moved to bi-hourly once on an unmeasured concern and reverted.
 */
export const BOARDS_PER_RUN = 6000;

/**
 * Per-rate-limit-domain concurrency. Total throughput is now the sum across
 * domains rather than one global number, so this is much faster than the old
 * flat CONCURRENCY while being *gentler* on any single host.
 *
 * Workday is deliberately the lowest: a whole pod (wd5 hosts 93 boards) started
 * returning 429 under a global cap of 9, because nothing stopped those 9 slots
 * all landing on the same pod. Greenhouse is the highest because it is one
 * CDN-backed API serving 981 boards — the per-board cost is a cheap cached
 * response, and throttling it would dominate the whole run's wall clock.
 */
export const HOST_CONCURRENCY: Record<string, number> = {
  greenhouse: 10,
  workday: 3,
  ashby: 6,
  lever: 6,
  smartrecruiters: 6,
  oracle: 4,
  successfactors: 2, // its XML feeds take 30-170s each; parallelism here buys nothing
  default: 4,
};

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
  // Hardware/silicon terms matter here specifically because the semiconductor
  // GCCs (Qualcomm, TI, AMD, Infineon, Microchip) are now covered, and their
  // India design centres hire freshers heavily.
  swe: /\b(software|engineer|developer|sde|swe|programmer|full[- ]?stack|backend|back[- ]end|frontend|front[- ]end|mobile|android|ios|platform|infrastructure|devops|sre|reliability|qa|quality assurance|sdet|test|automation|security engineer|systems|embedded|firmware|vlsi|rtl|asic|fpga|silicon|physical design)\b/i,
  data: /\b(data|machine learning|\bml\b|\bai\b|analytics|scientist|research|nlp|computer vision|deep learning|quantitative|quant)\b/i,
  finance: /\b(analyst|associate|consultant|advisory|investment|risk|\bgrc\b|\btprm\b|compliance|treasury|\btax\b|trading|trader|actuar|audit|finance|banking|strategy|operations analyst)\b/i,
  // Product and program work is a standard CS-grad path; `manager` still gates
  // the senior end, so in practice this surfaces APM/Product Analyst/Product
  // Owner rather than the manager rungs.
  product: /\b(product manager|product owner|product analyst|associate product|\bapm\b|program manager|programme manager|technical program|project manager|scrum|business analyst)\b/i,
  design: /\b(designer|\bux\b|\bui\b|user experience|user research|product design|interaction design)\b/i,
  security: /\b(security|cyber|infosec|penetration test|appsec|threat|vulnerability|identity (?:&|and) access)\b/i,
};
