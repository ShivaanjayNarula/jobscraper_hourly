import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { Company, Job, RawJob } from './types.js';
import { FETCHERS } from './fetchers/index.js';
import { mapLimit } from './fetchers/util.js';
import { classify } from './classify.js';
import { isFreshEnough, normalizeForDedup, preScreen, shouldAlert } from './filter.js';
import { renderEmail, subject } from './email.js';
import { updateCatalog } from './catalog.js';
import { CONCURRENCY, DROP_AFTER_FAILING_DAYS } from './config.js';
import { loadCompanies, loadSeen, readJson, recordFailure, recordSuccess, saveCompanies, saveSeen } from './state.js';

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
}

async function pollBoard(company: Company): Promise<BoardResult> {
  try {
    const jobs = await FETCHERS[company.ats].list(company);
    return { company, jobs };
  } catch (error) {
    return { company, jobs: [], error: (error as Error).message };
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
  const seen = await loadSeen();

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

  console.log(`polling ${companies.length} boards`);
  const results = await mapLimit(companies, CONCURRENCY, pollBoard);

  const updatedCompanies: Company[] = [];
  const dropped: string[] = [];
  const fresh: { company: Company; job: RawJob }[] = [];
  const liveIds = new Set<string>();
  const polledBoards = new Set<string>();
  let totalSeen = 0;

  for (const { company, jobs, error } of results) {
    if (error) {
      const failed = recordFailure(company, nowIso);
      const days = (Date.now() - new Date(failed.failingSince!).getTime()) / 86_400_000;
      console.warn(`  ! ${company.name}: ${error}`);
      if (days >= DROP_AFTER_FAILING_DAYS) dropped.push(company.name);
      else updatedCompanies.push(failed);
      continue;
    }

    updatedCompanies.push(recordSuccess(company));
    totalSeen += jobs.length;
    polledBoards.add(`${company.ats}:${company.token}`);

    for (const job of jobs) {
      const id = `${company.ats}:${company.token}:${job.externalId}`;
      liveIds.add(id);
      if (seen[id] && !testEmail) continue;
      seen[id] = nowIso;
      fresh.push({ company, job });
    }
  }

  console.log(`${totalSeen} live postings, ${fresh.length} not seen before`);

  // Screen on title and location first — an extra HTTP round trip per posting is
  // only worth paying for candidates that could actually survive the filters.
  const candidates = fresh.filter(({ company, job }) => preScreen(job, company));
  console.log(`${candidates.length} pass location and role screening, enriching those`);

  const enriched = await mapLimit(candidates, CONCURRENCY, async ({ company, job }) => ({
    company,
    job: await enrich(company, job),
  }));

  const matches: Job[] = [];
  for (const { company, job } of enriched) {
    const c = classify(job, company.industry);
    const verdict = shouldAlert(job, company, c);
    if (!verdict.keep) continue;
    matches.push({
      ...job,
      id: `${company.ats}:${company.token}:${job.externalId}`,
      company: company.name,
      industry: company.industry,
      minYears: c.minYears,
      maxYears: c.maxYears,
      isIntern: c.isIntern,
    });
  }

  matches.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));

  // Large employers post one role as several requisitions — Amazon lists the
  // same job three times under different IDs. They're one application to you, so
  // collapse them. Every original ID still went into `seen`, so the copies are
  // suppressed permanently rather than re-alerting next hour.
  //
  const byRole = new Map<string, Job>();
  for (const job of matches) {
    const key = `${job.company}|${normalizeForDedup(job.title)}|${normalizeForDedup(job.location)}`;
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
    const prunedCount = await saveSeen(seen);
    if (prunedCount) console.log(`pruned ${prunedCount} expired IDs`);
  }

  await mkdir('out', { recursive: true });
  await writeFile('out/matches.json', `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');

  if (!dryRun && !testEmail) {
    const catalog = await updateCatalog({ fresh: deduped, liveIds, polledBoards, now: nowIso });
    console.log(
      `catalog: ${catalog.open} open, ${catalog.closed} newly closed, ` +
        `${catalog.reopened} reopened, ${catalog.pruned} pruned`,
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

  const emailCount = coldStart && !testEmail ? 0 : deduped.length;

  if (emailCount > 0 && !dryRun) {
    await writeFile('out/email.html', renderEmail(freshForEmail, staleForEmail), 'utf8');
  }

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await appendFile(
      output,
      `new_count=${emailCount}\nsubject=${subject(freshForEmail, staleForEmail)}\nhour=${new Date().getUTCHours()}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
