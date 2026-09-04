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

/**
 * Bot-wall failures (see `fetchers/block.ts`) hold the eviction clock longer
 * than ordinary failures: a board behind a fresh Cloudflare rule is not dead,
 * and the Darwinbox mass-eviction proved waiting it out is correct. This is
 * the hard backstop — a board blocked continuously for this long needs eyes
 * on it either way, so staleness stays bounded instead of growing forever.
 */
export const BLOCK_HOLD_DAYS = 14;

/** Forget a job ID after this long, so the state file stays small. */
export const SEEN_RETENTION_DAYS = 45;

/**
 * How long a vanished posting stays eligible to be flagged as a repost when it
 * comes back. Beyond this window a returning id is indistinguishable from a
 * genuinely new requisition (same req number reused months later), and the
 * state file would grow for no alerting benefit.
 */
export const REPOST_WINDOW_DAYS = 30;

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
 * Roles with no parseable posting date are always included — some ATSes never
 * expose one at all, so absence of a date cannot be treated as evidence of
 * staleness.
 *
 * This used to name Workday as the chief offender. That was wrong, and it cost
 * us: Workday does expose a date, as a relative label ("Posted 5 Days Ago"),
 * and `workday.ts` was storing it raw so it never parsed. Every Workday role —
 * 38% of the catalogue — took the benefit of the doubt this comment describes.
 * Fixed by `parsePostedOn` in `fetchers/workday.ts`. Before assuming an ATS
 * "has no dates", check whether we are simply failing to read the one it sends.
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
 * Re-measured 2026-08-18 at 13,158 total boards (3,878 hot): 6,000 boards took
 * 23m59s, ~4.2 boards/sec — faster than the 2.6 boards/sec this constant was
 * originally sized from, because per-host scheduling (HOST_CONCURRENCY) has
 * improved since. The schedule is also no longer hourly — `hunt.yml` polls
 * every 20 minutes specifically to tolerate GitHub's flaky scheduler — so a
 * run that takes longer than 20 minutes queues behind the next trigger rather
 * than overlapping it (the concurrency block queues, never cancels). That's
 * fine against the real goal, ~1 hour data freshness, not literal 20-minute
 * delivery.
 *
 * Not every board deserves the same attention: a board that has shown an
 * India/remote role is polled every run (hot); one that never has is swept on
 * rotation, oldest-polled first (cold), and the moment one shows an India role
 * it is promoted and never rotated again — hot only grows, never shrinks.
 *
 * Raised 6,000 -> 8,000 (2026-08-18) because hot alone had reached 3,878 of
 * 6,000 slots (65%) and climbs monotonically — left unaddressed, cold rotation
 * would eventually be squeezed toward zero slots, and new boards would stop
 * getting their first chance to go hot. Verified with a real timed dry run
 * before committing, not a hunch: 8,000 boards took 26m28s (~5.0 boards/sec,
 * a further improvement over the ~4.2 boards/sec measured at 6,000 — likely
 * host-bucket parallelism paying off more as more boards spread across hosts).
 * Still comfortably inside the real goal, ~1 hour freshness, even under the
 * every-20-minute schedule's queue-not-cancel behavior. Re-measure before
 * raising again.
 */
export const BOARDS_PER_RUN = 8000;

/**
 * Cap on newly-resolved (uncached) placeholder-location Workday postings per
 * board per run. Measured 2026-09-04: 13.6% of Workday jobs (22,398 of
 * 164,389 across 907 hot boards) carry a placeholder like "6 Locations"
 * instead of real place names, averaging ~24.7 per board — but that hides a
 * long tail (a large multi-site employer can carry hundreds). Each
 * resolution is one extra detail request inside that board's own poll turn,
 * so an uncapped board with hundreds of them would hog its shared per-pod
 * concurrency slot (HOST_CONCURRENCY.workday) far longer than every other
 * board sharing that pod. The rest catch up over following runs — the cache
 * is permanent, so nothing is lost, just deferred. Re-measure actual added
 * wall-clock before raising.
 */
export const MULTILOC_MAX_PER_BOARD = 20;

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
  workable: 6,
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
  /\b(tcs|tata consultancy|infosys|wipro|cognizant|accenture|capgemini|hcl|hcltech|tech mahindra|ltimindtree|mphasis|hexaware|birlasoft|coforge|persistent systems|zensar|mindtree|dxc|atos|virtusa|ust global|quess|randstad|adecco|manpower|delta capita|genpact|firstsource|wns global|conduent|concentrix|teleperformance)\b/i;

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
