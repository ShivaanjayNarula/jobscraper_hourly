/**
 * Silent partial-loss detection: a board whose adapter still works but which
 * suddenly returns a fraction of its usual postings. This is the failure mode
 * the platform-outage detector (`outage.ts`) structurally cannot see — one
 * board returning 5 roles instead of its usual 200 looks healthy next to
 * hundreds of peers, but it usually means a changed site slug, a truncated
 * response, or a cap regression (the Workday ~300-role bug shipped exactly
 * this way: silent, invisible, dropping real postings for weeks).
 *
 * Same shape as the other detectors: pure functions over a small rolling
 * history persisted per run (`state/board-volumes.json`), transitions diffed
 * against the previous run's verdicts so hunt.yml's issue step only fires on
 * an actual change, never every 20 minutes for as long as a drop persists.
 *
 * Deliberately conservative on every axis:
 *   - needs ≥5 runs of history before it will say anything at all,
 *   - ignores boards whose baseline is too small to judge (<20 postings),
 *   - flags only when the latest count collapses below 20% of the baseline
 *     median — noise and normal churn stay quiet,
 *   - only ever judges boards actually polled this run (cold rotation means
 *     an unpolled board carries no evidence either way).
 */
export const VOLUME_RUNS = 10;
export const VOLUME_MIN_HISTORY = 5;
export const VOLUME_MIN_BASELINE = 20;
export const VOLUME_DROP_FRACTION = 0.2;

/** One count per successful poll, most recent last. */
export type VolumeHistory = Record<string, number[]>;

export function updateVolumeHistory(
  history: VolumeHistory,
  samples: readonly { key: string; count: number }[],
): VolumeHistory {
  const next: VolumeHistory = {};
  for (const [key, counts] of Object.entries(history)) next[key] = counts;
  for (const { key, count } of samples) {
    const counts = [...(next[key] ?? []), count];
    next[key] = counts.slice(-VOLUME_RUNS);
  }
  return next;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Keys among `polledThisRun` whose latest count collapsed relative to their
 * own recent baseline. History entries for unpolled boards are neither read
 * nor written here — absence of evidence is not evidence of a drop.
 */
export function detectVolumeDrops(
  history: VolumeHistory,
  polledThisRun: ReadonlySet<string>,
  minHistory = VOLUME_MIN_HISTORY,
  minBaseline = VOLUME_MIN_BASELINE,
  dropFraction = VOLUME_DROP_FRACTION,
): Set<string> {
  const dropped = new Set<string>();
  for (const key of polledThisRun) {
    const counts = history[key] ?? [];
    if (counts.length < minHistory) continue;
    // The just-appended latest observation is excluded from its own baseline.
    const baseline = median(counts.slice(0, -1));
    const latest = counts[counts.length - 1]!;
    if (baseline >= minBaseline && latest < baseline * dropFraction) dropped.add(key);
  }
  return dropped;
}

export type VolumeDropState = Record<string, true>;

export function volumeDropStateFrom(dropped: ReadonlySet<string>): VolumeDropState {
  return Object.fromEntries([...dropped].map((key) => [key, true]));
}

/**
 * Transition-only reporting, same reasoning as `outageChanges`: the flag
 * stays set for as long as the drop persists, and the workflow should hear
 * about the change, not re-hear the status.
 *
 * Recovery has an asymmetry the outage version doesn't: a board can stop
 * being flagged simply because it hasn't been polled since (its key sits in
 * the previous state while carrying no fresh evidence). Such keys are held —
 * reported neither as started nor recovered — until their next real poll
 * either re-confirms or clears them via `polledThisRun`.
 */
export function volumeDropChanges(
  previous: VolumeDropState,
  current: ReadonlySet<string>,
  polledThisRun: ReadonlySet<string>,
): { started: string[]; recovered: string[] } {
  const started = [...current].filter((key) => !previous[key]);
  const recovered = Object.keys(previous).filter(
    (key) => previous[key] && !current.has(key) && polledThisRun.has(key),
  );
  return { started, recovered };
}
