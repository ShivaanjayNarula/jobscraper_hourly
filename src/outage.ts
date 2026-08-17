import type { Ats } from './types.js';

/**
 * A platform-wide outage looks identical to N companies dying at once —
 * `recordFailure` has no way to tell them apart on its own. That ambiguity is
 * what silently dropped every tracked Darwinbox board (PhysicsWallah, Porter,
 * Licious, Tata 1mg, PharmEasy, Subex, LeadSquared, BigBasket) within days of
 * each other: testing the exact same adapter and tenant by hand afterward
 * returned live jobs immediately, so the boards were never actually dead —
 * only unreachable from GitHub Actions, almost certainly a Cloudflare block
 * on the runners' shared IP ranges.
 *
 * Detect the pattern instead of trusting each company's failure in isolation:
 * if most of one ATS's boards fail in the same run, it's a suspected outage,
 * not eight coincidental deaths. A genuinely dead company keeps failing after
 * the outage clears and gets evicted then, on its own — a platform outage
 * costs a few days of staleness instead of the whole platform's boards.
 */
export const OUTAGE_FAILURE_RATE = 0.5;
export const OUTAGE_MIN_SAMPLE = 3;

export interface PollOutcome {
  ats: Ats;
  error?: string;
}

export function detectOutage(
  results: readonly PollOutcome[],
  failureRate = OUTAGE_FAILURE_RATE,
  minSample = OUTAGE_MIN_SAMPLE,
): Set<Ats> {
  const byAts = new Map<Ats, { total: number; failed: number }>();
  for (const { ats, error } of results) {
    const stats = byAts.get(ats) ?? { total: 0, failed: 0 };
    stats.total++;
    if (error) stats.failed++;
    byAts.set(ats, stats);
  }

  const suspected = new Set<Ats>();
  for (const [ats, stats] of byAts) {
    if (stats.total >= minSample && stats.failed / stats.total >= failureRate) suspected.add(ats);
  }
  return suspected;
}
