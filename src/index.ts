import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { BoardState, Company, Job, RawJob } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimit, mapLimitByKey } from './fetchers/util.js';
import { classify } from './classify.js';
import { isFreshEnough, locationMatches, normalizeForDedup, preScreen, shouldAlert } from './filter.js';
import { renderEmail, subject } from './email.js';
import { rampingCompanies } from './trends.js';
import { updateCatalog, type CatalogEntry } from './catalog.js';
import { CONCURRENCY, BLOCK_HOLD_DAYS, DROP_AFTER_FAILING_DAYS, HOST_CONCURRENCY, MULTILOC_MAX_PER_BOARD } from './config.js';
import { BlockError, type BlockKind } from './fetchers/block.js';
import { boardKey } from './board-url.js';
import { resolvePlaceholderLocations } from './fetchers/workday.js';
import {
  loadCompanies,
  loadBoardState,
  loadBoardVolumes,
  loadHostHistory,
  loadMultiLocations,
  loadOutageState,
  loadReposts,
  loadSeen,
  loadVolumeDrops,
  readJson,
  recordFailure,
  recordSuccess,
  saveBoardState,
  saveBoardVolumes,
  saveCompanies,
  saveHostHistory,
  saveMultiLocations,
  saveOutageState,
  saveReposts,
  saveVolumeDrops,
  saveSeen,
  seedBoardState,
  updateReposts,
} from './state.js';
import { extractSalary } from './salary.js';
import { detectOutage, outageChanges, outageStateFrom } from './outage.js';
import {
  detectVolumeDrops,
  updateVolumeHistory,
  volumeDropChanges,
  volumeDropStateFrom,
  type VolumeDropState,
} from './volume-stats.js';
import { selectBoards } from './select-boards.js';
import { formatHostStats, persistentlySlow, summarizeHostStats, updateHistory, type PollTiming } from './host-stats.js';

const nowIso = new Date().toISOString();
const dryRun = process.env.DRY_RUN === '1';

/**
 * Ignores the seen state so every current match counts as new, and persists
 * nothing. Exists so a first-time setup can prove the email secrets work — the
 * genuine first run is silent by design and tells you nothing either way.
 */
const testEmail = process.env.TEST_EMAIL === '1';

interface BoardResult {
  company: Company;
  jobs: RawJob[];
  error?: string;
  /** Set when the error was a classified bot wall, not an ordinary failure. */
  blockKind?: BlockKind;
  durationMs: number;
}

/**
 * The host that actually enforces the rate limit, which is not the same as the
 * ATS. Every Greenhouse board shares one API host, but Workday tenants are
 * spread across pods (wd1, wd3, wd5, ...) that throttle independently — so the
 * pod has to be part of the key, or 93 wd5 boards queue as if they were 93
 * unrelated hosts. Phenom and Eightfold run on the customer's own domain, so
 * each tenant is genuinely its own host and can go at full speed.
 */
function rateLimitKey(company: Company): string {
  if (company.ats === 'workday') return `workday:${company.host ?? 'wd'}`;
  if (company.ats === 'phenom' || company.ats === 'eightfold') {
    return `${company.ats}:${company.token}`;
  }
  if (company.ats === 'successfactors') return `successfactors:${company.host ?? company.token}`;
  return company.ats;
}

const limitForHost = (key: string): number =>
  HOST_CONCURRENCY[key.split(':')[0]!] ?? HOST_CONCURRENCY.default!;

async function pollBoard(company: Company, multiLocations: Record<string, string>): Promise<BoardResult> {
  const started = Date.now();
  try {
    const jobs = await FETCHERS[company.ats].list(company);
    if (company.ats === 'workday') {
      await resolvePlaceholderLocations(company, jobs, multiLocations, MULTILOC_MAX_PER_BOARD);
    }
    return { company, jobs, durationMs: Date.now() - started };
  } catch (error) {
    const err = error as Error;
    return {
      company,
      jobs: [],
      error: err.message,
      blockKind: err instanceof BlockError ? err.kind : undefined,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Descriptions are only fetched for jobs we've never seen before. Pulling them
 * for every board every hour would move hundreds of megabytes to learn nothing.
 */
async function enrich(company: Company, job: RawJob): Promise<RawJob> {
  const fetcher = FETCHERS[company.ats];
  if (job.text || !fetcher.enrich) return job;
  try {
    return { ...job, text: await fetcher.enrich(company, job) };
  } catch {
    return job;
  }
}

async function main(): Promise<void> {
  const companies = await loadCompanies();
  /**
   * Poll times and failure streaks live here rather than on the Company rows,
   * so `companies.json` stops being rewritten every run. Seeded from the legacy
   * fields for any board the state file doesn't know — the first run after the
   * split, and any run after a cache eviction.
   */
  const boardState = seedBoardState(await loadBoardState(), companies);
  const nextBoardState: BoardState = { ...boardState };
  const seen = await loadSeen();
  const previousOutage = await loadOutageState();
  const previousHostHistory = await loadHostHistory();
  let reposts = await loadReposts();
  const repostIds = new Set<string>();
  const previousVolumeDrops: VolumeDropState = await loadVolumeDrops();
  const previousBoardVolumes = await loadBoardVolumes();
  const multiLocations = await loadMultiLocations();

  /**
   * The seen state lives in the Actions cache, not in git — at ~150,000 live
   * postings it is ~9.5 MB, and committing that daily would add gigabytes a
   * year. If a cache is ever evicted we start empty, which would otherwise
   * email every currently-open role at once. The committed catalogue is the
   * backup: seed from it and stay silent for one run.
   */
  const coldStart = Object.keys(seen).length === 0;
  if (coldStart) {
    const catalog = await readJson<{ id: string }[]>('data/jobs.json', []);
    for (const entry of catalog) seen[entry.id] = nowIso;
    if (catalog.length > 0) {
      console.log(`cold start: seeded ${catalog.length} ids from the catalogue, suppressing email`);
    }
  }

  const selection = selectBoards(companies, boardState);
  console.log(
    `polling ${selection.polling.length} of ${companies.length} boards ` +
      `(${selection.hot} hot, ${selection.cold} cold on rotation, ${selection.skipped} waiting)`,
  );
  const multiLocBefore = Object.keys(multiLocations).length;
  const results = await mapLimitByKey(selection.polling, rateLimitKey, limitForHost, (c) =>
    pollBoard(c, multiLocations),
  );
  const multiLocResolved = Object.keys(multiLocations).length - multiLocBefore;
  if (multiLocResolved > 0) {
    console.log(`resolved ${multiLocResolved} new workday multi-location postings (${multiLocBefore + multiLocResolved} cached total)`);
  }

  const hostStats = summarizeHostStats(
    results.map((r): PollTiming => ({ key: rateLimitKey(r.company), durationMs: r.durationMs, error: r.error })),
  );
  console.log(`slowest hosts this run (p95, worst first):\n${formatHostStats(hostStats)}`);

  // Reconciliation: every board selected must have produced a result, error or
  // not. mapLimitByKey has no reason to drop one, so a shortfall means the
  // polling layer itself misbehaved — say it loudly rather than let the run
  // quietly cover fewer boards than it claims.
  if (results.length !== selection.polling.length) {
    console.warn(
      `RECONCILIATION: ${selection.polling.length - results.length} selected boards produced no result ` +
        `(expected ${selection.polling.length}, got ${results.length})`,
    );
  }

  // Silent partial-loss detection (see volume-stats.ts): only successful polls
  // carry evidence, and only boards polled this run are judged.
  const volumeSamples = results
    .filter((r) => !r.error)
    .map((r) => ({ key: boardKey(r.company), count: r.jobs.length }));
  const polledVolumeKeys = new Set(volumeSamples.map((s) => s.key));
  const boardVolumes = updateVolumeHistory(previousBoardVolumes, volumeSamples);
  const volumeDrops = detectVolumeDrops(boardVolumes, polledVolumeKeys);
  const volumeDelta = volumeDropChanges(previousVolumeDrops, volumeDrops, polledVolumeKeys);
  if (volumeDelta.started.length) {
    console.warn(`suspected silent posting drop: ${volumeDelta.started.join(', ')}`);
  }
  if (volumeDelta.recovered.length) {
    console.log(`earlier suspected posting drops cleared: ${volumeDelta.recovered.join(', ')}`);
  }

  const hostHistory = updateHistory(previousHostHistory, hostStats);
  const slowHosts = persistentlySlow(hostHistory);
  if (slowHosts.length > 0) {
    console.warn(
      `consistently among the worst hosts across its last several runs, not just this one: ${slowHosts.join(', ')}`,
    );
  }

  /**
   * Boards not polled this run must survive untouched. `updatedCompanies` is
   * what gets written back over companies.json, so anything missing from it is
   * silently deleted — and with rotation most of the corpus is missing from
   * any single run.
   */
  const polledTokens = new Set(selection.polling.map(boardKey));
  const updatedCompanies: Company[] = companies.filter((c) => !polledTokens.has(boardKey(c)));
  const dropped: string[] = [];
  const fresh: { company: Company; job: RawJob }[] = [];
  /**
   * Id -> the board's currently-reported posting date. A Set would be enough to
   * decide "is this still open", but the date is what lets the catalogue notice
   * an employer re-stamping an old requisition to look new. It has to be
   * collected here, before the screening gate below, because a posting already
   * in `seen` short-circuits out of the loop long before its refreshed date
   * would otherwise be read.
   */
  const liveIds = new Map<string, string | undefined>();
  const polledBoards = new Set<string>();
  /**
   * Repost evidence, accumulated across every board and applied once after the
   * loop. It used to be applied per board, which rebuilt the whole ~30k-entry
   * repost state up to `BOARDS_PER_RUN` times a run — but the reason it had to
   * move is correctness, not speed: a tenant's sites share one job-id space, so
   * polling RTX's `search` site alone made `campus`'s ids look absent and
   * stamped them `gone`, and they then came back flagged as reposts the moment
   * `campus` was polled. Batching every polled board into one call means a
   * tenant is only ever judged on the union of its sites' ids.
   */
  const polledPrefixes = new Set<string>();
  const presentIds: string[] = [];
  /** Successful polls per `ats:token`, for the closure guard below. */
  const tenantPolls = new Map<string, number>();
  let totalSeen = 0;
  let screened = 0;

  const suspectedOutage = detectOutage(results.map((r) => ({ ats: r.company.ats, error: r.error })));
  if (suspectedOutage.size > 0) {
    console.warn(
      `suspected platform-wide outage this run, not evicting boards on: ${[...suspectedOutage].join(', ')}`,
    );
  }
  const outageDelta = outageChanges(previousOutage, suspectedOutage);
  if (outageDelta.started.length) console.warn(`newly suspected outage: ${outageDelta.started.join(', ')}`);
  if (outageDelta.recovered) console.log('previously suspected outage has cleared');

  for (const { company, jobs, error, blockKind } of results) {
    // Only a board polled this run carries evidence about which of its ids are
    // still live; cold rotation means every other board carries none. That is
    // what `polledPrefixes` records.
    const tenant = `${company.ats}:${company.token}`;
    if (error) {
      const key = boardKey(company);
      const failed = recordFailure(boardState[key], nowIso);
      const days = (Date.now() - new Date(failed.failingSince!).getTime()) / 86_400_000;
      console.warn(`  ! ${company.name}: ${error}`);
      /**
       * A classified bot wall holds the eviction clock past the ordinary day-3
       * drop — a board behind a fresh Cloudflare rule is unreachable from the
       * runner's IPs, not dead (the Darwinbox mass-eviction was exactly this,
       * caught too late because every failure looked identical). The outage
       * ratio detector covers the platform-wide case; this covers the single
       * board on an otherwise-healthy ATS. `BLOCK_HOLD_DAYS` bounds the
       * staleness so a permanently walled board still exits eventually.
       */
      const heldByWall = blockKind !== undefined && days < BLOCK_HOLD_DAYS;
      if (days >= DROP_AFTER_FAILING_DAYS && !suspectedOutage.has(company.ats) && !heldByWall) {
        dropped.push(company.name);
        delete nextBoardState[key];
      } else {
        if (heldByWall) {
          console.warn(
            `    bot wall (${blockKind}), holding past day-${DROP_AFTER_FAILING_DAYS} ` +
              `eviction until day-${BLOCK_HOLD_DAYS}`,
          );
        }
        nextBoardState[key] = failed;
        updatedCompanies.push(company);
      }
      continue;
    }

    /**
     * `lastIndiaAt` is sticky once set — a board that showed an India role
     * last month but has none open today stays hot. Expiring it would demote
     * exactly the companies most worth watching, since a board sits empty in
     * the gap between one req closing and the next opening.
     */
    const hasIndia = jobs.some((job) => locationMatches(job.location));
    nextBoardState[boardKey(company)] = recordSuccess(nowIso);
    updatedCompanies.push({
      ...company,
      ...(hasIndia || company.lastIndiaAt ? { lastIndiaAt: hasIndia ? nowIso : company.lastIndiaAt } : {}),
    });
    totalSeen += jobs.length;
    tenantPolls.set(tenant, (tenantPolls.get(tenant) ?? 0) + 1);
    polledPrefixes.add(`${tenant}:`);

    for (const job of jobs) {
      const id = `${company.ats}:${company.token}:${job.externalId}`;
      liveIds.set(id, job.postedAt);

      /**
       * Screen BEFORE recording, not after. A posting that fails location or
       * role screening can never alert, so remembering it buys nothing — and
       * it was ~94% of the corpus, which is the entire reason seen.json
       * reached 9.7 MB at 1,394 boards. Re-screening those every run instead
       * costs a couple of regexes and no HTTP, while the file now grows with
       * *candidates* rather than with total postings. That is what makes a
       * five-figure board count survivable: the Actions cache holds one copy
       * per run, so 100 MB of state would evict itself within days.
       */
      if (!preScreen(job, company)) continue;
      screened++;
      presentIds.push(id);
      if (seen[id] && !testEmail) continue;
      // A previously-live id alerting again while stamped `gone` is a reopened
      // requisition — flagged on the job, not silently treated as brand-new.
      if (reposts[id]?.gone) repostIds.add(id);
      seen[id] = nowIso;
      fresh.push({ company, job });
    }
  }

  reposts = updateReposts(reposts, presentIds, polledPrefixes, nowIso);

  /**
   * A tenant's postings may be spread across several sites that are separate
   * rows in companies.json, and catalogue closure is decided per tenant because
   * a job id carries no site. So a tenant only counts as polled when *every*
   * row it has succeeded this run — otherwise polling RTX's `search` site while
   * `REC_RTX_Ext_Gateway` sat out on cold rotation would mark every posting
   * from the other site closed. Missing a closure for a run is recoverable;
   * inventing one is not.
   */
  const tenantRows = new Map<string, number>();
  for (const c of companies) {
    const t = `${c.ats}:${c.token}`;
    tenantRows.set(t, (tenantRows.get(t) ?? 0) + 1);
  }
  for (const [tenant, polls] of tenantPolls) {
    if (polls === tenantRows.get(tenant)) polledBoards.add(tenant);
  }

  // Already screened above, so every fresh job is a candidate worth enriching —
  // an extra HTTP round trip per posting is only worth paying for those.
  const candidates = fresh;
  console.log(
    `${totalSeen} live postings, ${screened} pass location and role screening ` +
      `(${((100 * screened) / Math.max(totalSeen, 1)).toFixed(1)}% — only these enter seen state), ` +
      `${candidates.length} of them new`,
  );

  const enriched = await mapLimit(candidates, CONCURRENCY, async ({ company, job }) => ({
    company,
    job: await enrich(company, job),
  }));

  const matches: Job[] = [];
  for (const { company, job } of enriched) {
    const c = classify(job, company.industry);
    const verdict = shouldAlert(job, company, c);
    if (!verdict.keep) continue;
    const salary = extractSalary(job.salary, job.text);
    matches.push({
      ...job,
      id: `${company.ats}:${company.token}:${job.externalId}`,
      company: company.name,
      industry: company.industry,
      minYears: c.minYears,
      maxYears: c.maxYears,
      isIntern: c.isIntern,
      ...(salary ? { salaryMin: salary.minLpa, salaryMax: salary.maxLpa } : {}),
      workMode: c.workMode,
      visa: c.visa || undefined,
      isRepost: repostIds.has(`${company.ats}:${company.token}:${job.externalId}`) || undefined,
    });
  }

  matches.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));

  // Large employers post one role as several requisitions — Amazon lists the
  // same job three times under different IDs. They're one application to you,
  // so collapse them. The company name goes through the same normalizer as
  // the title: two tracked entries for one employer that differ only by case
  // or punctuation (the Growe two-boards shape, before canonical renaming)
  // must collapse too. Every original ID still went into `seen`, so the
  // copies are suppressed permanently rather than re-alerting next hour.
  //
  const byRole = new Map<string, Job>();
  for (const job of matches) {
    const key = `${normalizeForDedup(job.company)}|${normalizeForDedup(job.title)}|${normalizeForDedup(job.location)}`;
    const previous = byRole.get(key);
    if (!previous || (job.minYears ?? 99) < (previous.minYears ?? 99)) byRole.set(key, job);
  }
  const deduped = [...byRole.values()];
  const collapsed = matches.length - deduped.length;
  console.log(
    `${deduped.length} match your filters` +
      (collapsed > 0 ? ` (${collapsed} duplicate requisitions collapsed)` : ''),
  );

  if (dropped.length) console.warn(`dropped dead boards: ${dropped.join(', ')}`);

  // A dry run must not persist state, or the next real run would treat every
  // one of these postings as already-seen and stay silent.
  if (!dryRun && !testEmail) {
    await saveCompanies(updatedCompanies);
    await saveBoardState(nextBoardState);
    const prunedCount = await saveSeen(seen);
    if (prunedCount) console.log(`pruned ${prunedCount} expired IDs`);
    await saveOutageState(outageStateFrom(suspectedOutage));
    await saveHostHistory(hostHistory);
    await saveReposts(reposts);
    await saveBoardVolumes(boardVolumes);
    await saveVolumeDrops(volumeDropStateFrom(volumeDrops));
    await saveMultiLocations(multiLocations);
  }

  await mkdir('out', { recursive: true });
  await writeFile('out/matches.json', `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');

  if (!dryRun && !testEmail) {
    const catalog = await updateCatalog({ fresh: deduped, liveIds, polledBoards, now: nowIso });
    console.log(
      `catalog: ${catalog.open} open, ${catalog.closed} newly closed, ` +
        `${catalog.reopened} reopened, ${catalog.pruned} pruned, ` +
        `${catalog.bumped} date-bumped`,
    );
  }

  // "New" means new to this tracker, not newly posted — a company that was
  // just added, or a board recovering after days of errors, makes its entire
  // current listing look "new" even if much of it is months old, and there is
  // no early-mover edge left on a role that's been open 111 days. But the
  // catalogue above is the ONLY other place a match lives, and nothing reads
  // it unless the web UI is deployed — so demoting a stale match out of the
  // urgent section is fine, dropping it from the email entirely is not. It
  // still ships, in its own low-key "backlog" section (see email.ts).
  const freshForEmail = deduped.filter((job) => isFreshEnough(job.postedAt));
  const staleForEmail = deduped.filter((job) => !isFreshEnough(job.postedAt));
  if (staleForEmail.length > 0) {
    console.log(`${staleForEmail.length} matches are 21+ days old — shown as backlog, not urgent`);
  }

  const wroteEmail = deduped.length > 0 && !dryRun && !coldStart;

  /**
   * Ramping employers come from the catalogue as it stood BEFORE this run's
   * update — the aggregate view lags one run by design and costs no extra
   * state. Only read when an email will actually be written.
   */
  let ramping: Awaited<ReturnType<typeof rampingCompanies>> = [];
  if (wroteEmail) {
    const previousCatalog = await readJson<CatalogEntry[]>('data/jobs.json', []);
    ramping = rampingCompanies(previousCatalog);
  }
  if (wroteEmail) {
    await writeFile('out/email.html', renderEmail(freshForEmail, staleForEmail, ramping), 'utf8');
  }

  /**
   * `new_count` gates the workflow's email step, and `out/` is gitignored — so
   * it is empty on every fresh runner. Reporting a non-zero count without
   * having written the file points that step at a file that does not exist,
   * which is exactly the "no email arrived even though roles were found" case.
   * The count must therefore track whether the email was actually rendered,
   * not just how many matches were found.
   */
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await appendFile(
      output,
      `new_count=${wroteEmail ? deduped.length : 0}\nsubject=${subject(freshForEmail, staleForEmail)}\n` +
        `hour=${new Date().getUTCHours()}\n` +
        `outage_started=${outageDelta.started.join(',')}\n` +
        `outage_recovered=${outageDelta.recovered.join(',')}\n` +
        `volume_dropped=${volumeDelta.started.join(',')}\n` +
        `volume_recovered=${volumeDelta.recovered.join(',')}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
