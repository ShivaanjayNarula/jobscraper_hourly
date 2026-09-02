'use client';

import { useEffect, useMemo, useState } from 'react';
import { DATA_URL, REPO_URL, type Job } from '@/lib/types';
import { AddCompany } from './add-company';

const INDUSTRIES = ['tech', 'fintech', 'quant', 'banking', 'consulting'] as const;

function ago(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.replace(/^posted\s*/i, '') || null;
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours < 1) return 'just posted';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// Grouped/sorted by firstSeen (when our hourly crawl first found the posting),
// not postedAt — ATS-reported dates are often relative ("2 days ago") and get
// bumped on repost, so crawl time is the only reliable "how new is this" signal.
function crawledTime(job: Job): number {
  const t = new Date(job.firstSeen).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Same threshold and "no date = benefit of the doubt" rule as EMAIL_FRESHNESS_DAYS
// / isFreshEnough in src/config.ts + src/filter.ts. Without this, a newly-added
// company dumps its whole (real, but old) backlog into the "past hour" bucket
// just because our crawl found it an hour ago — same bug the email digest hit
// first, fixed there by demoting backlog to its own section instead of hiding
// or mis-labeling it.
const BACKLOG_DAYS = 21;

function isBacklog(job: Job): boolean {
  if (!job.postedAt) return false;
  const posted = new Date(job.postedAt).getTime();
  if (Number.isNaN(posted)) return false;
  return (Date.now() - posted) / 86_400_000 > BACKLOG_DAYS;
}

// 2-hour bins for the first day. The first six are labeled "Last N hours"
// (Last 2, Last 4, ... Last 12); after that the same bins read as ranges
// ("12–14 hours ago") since "Last 14 hours" stops meaning anything.
function bucketLabel(job: Job): string {
  const then = crawledTime(job);
  if (then === 0) return 'Date unknown';
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  const binStart = Math.floor(hours / 2) * 2;
  if (hours < 12) return `Last ${binStart + 2} hours`;
  if (hours < 24) return `${binStart}–${binStart + 2} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  // Past the first week, keep splitting rather than dumping everything into
  // one "over a week" pile — with ~2,500 open matches that single group held
  // thousands of roles and made the page read as "last 2 hours vs everything".
  if (days < 7) return `${days} days ago`;
  if (days < 14) return '1–2 weeks ago';
  if (days < 21) return '2–3 weeks ago';
  if (days < 28) return '3–4 weeks ago';
  const months = Math.min(Math.floor(days / 30), 3);
  return months <= 1 ? 'Over a month ago' : `${months}+ months ago`;
}

// Calendar-day key of firstSeen (the UTC date of the ISO stamp). The site's
// "how new" buckets are relative and scroll away as time passes; these keys
// give every posting a stable home tab, so days you didn't check stay browsable.
function dayKey(job: Job): string {
  return job.firstSeen.slice(0, 10);
}

// UTC-stable labels: comparing ISO date strings, not local midnights, so a
// job never shifts tab depending on which timezone you open the page from.
function dayLabel(key: string): string {
  if (key === new Date().toISOString().slice(0, 10)) return 'Today';
  if (key === new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
}

function experience(job: Job): string {
  if (job.isIntern) return 'Internship';
  if (job.minYears === null) return 'Not stated';
  if (job.maxYears !== null) return `${job.minYears}–${job.maxYears} yrs`;
  return `${job.minYears}+ yrs`;
}

const OPENED_KEY = 'jobradar-opened';
const SAVED_KEY = 'jobradar-saved';
const APPLIED_KEY = 'jobradar-applied';
const EXCLUDE_KEY = 'jobradar-exclude';

function loadIdSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    return new Set();
  }
}

function loadOpened(): Set<string> {
  return loadIdSet(OPENED_KEY);
}

function JobRow({
  job,
  opened,
  saved,
  applied,
  onOpen,
  onMark,
}: {
  job: Job;
  opened: boolean;
  saved: boolean;
  applied: boolean;
  onOpen: () => void;
  onMark: (kind: 'saved' | 'applied') => void;
}) {
  const posted = ago(job.postedAt ?? job.firstSeen);
  const band =
    job.salaryMin && job.salaryMax
      ? `₹${Number.isInteger(job.salaryMin) ? job.salaryMin : job.salaryMin.toFixed(1)}–${Number.isInteger(job.salaryMax) ? job.salaryMax : job.salaryMax.toFixed(1)} LPA`
      : undefined;
  return (
    <li className="job" data-closed={Boolean(job.closedAt)} data-opened={opened} data-applied={applied}>
      <a className="title" href={job.url} target="_blank" rel="noreferrer" onClick={onOpen}>
        {job.title}
      </a>
      <span className="company-inline">{job.company}</span>
      <button
        className={`mark${saved ? ' on' : ''}`}
        title={saved ? 'Remove from saved' : 'Save for later'}
        onClick={() => onMark('saved')}
      >
        {saved ? '★' : '☆'}
      </button>
      <button
        className={`mark${applied ? ' on' : ''}`}
        title={applied ? 'Unmark applied' : 'Mark applied'}
        onClick={() => onMark('applied')}
      >
        ✓
      </button>
      <div className="company">{job.company}</div>
      <div className="meta">
        <span>{job.location}</span>
        <span className={`tag${job.isIntern ? ' intern' : ''}`}>{experience(job)}</span>
        {posted && <span>{posted}</span>}
        {band ? <span>{band}</span> : job.salary ? <span>{job.salary}</span> : null}
        {job.workMode === 'remote' && <span className="tag">remote</span>}
        {job.workMode === 'hybrid' && <span className="tag">hybrid</span>}
        {job.visa && <span className="tag">visa sponsorship</span>}
        {job.closedAt && <span className="tag closed">closed</span>}
      </div>
    </li>
  );
}

/**
 * Open the outreach batch page.
 *
 * The key is asked for once and kept in localStorage rather than compiled into
 * this page: the site is public, so anything in the bundle is public too, and
 * the outreach batch is keyed by real people's addresses. Prompting keeps the
 * secret on the one device that needs it.
 */
function openOutreach() {
  const stored = window.localStorage.getItem('outreachKey');
  const key = stored ?? window.prompt('Outreach key (asked once, then remembered on this device)');
  if (!key) return;
  if (!stored) window.localStorage.setItem('outreachKey', key);
  window.open(`/api/outreach/page?k=${encodeURIComponent(key)}`, '_blank', 'noopener');
}

export default function Page() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [maxYears, setMaxYears] = useState(3);
  const [includeUnstated, setIncludeUnstated] = useState(true);
  const [industries, setIndustries] = useState<string[]>([]);
  const [internsOnly, setInternsOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [company, setCompany] = useState('');
  // Facets over the Phase A fields (src/salary.ts + classify.ts).
  const [workMode, setWorkMode] = useState<'' | 'remote' | 'hybrid' | 'onsite'>('');
  const [minSalary, setMinSalary] = useState(0);
  const [visaOnly, setVisaOnly] = useState(false);
  // Personal, localStorage-only: excluded keywords and saved/applied marks.
  const [exclude, setExclude] = useState('');
  // Per-day browsing: '' is the All tab, otherwise a firstSeen YYYY-MM-DD key.
  const [day, setDay] = useState('');
  const [hideApplied, setHideApplied] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  /**
   * URL is the shareable source of truth for the filter state. Read once on
   * mount (not in the lazy initializers — the page is statically exported, so
   * initializers also run at build time where `location` doesn't exist), and
   * written back with replaceState so every filtered view has a bookmarkable
   * URL without polluting history on each keystroke.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('q')) setQuery(params.get('q')!);
    if (params.get('company')) setCompany(params.get('company')!);
    if (params.get('maxYears')) setMaxYears(Number(params.get('maxYears')));
    if (params.get('industries')) setIndustries(params.get('industries')!.split(','));
    if (params.get('mode')) setWorkMode(params.get('mode') as typeof workMode);
    if (params.get('minSalary')) setMinSalary(Number(params.get('minSalary')));
    if (params.get('interns') === '1') setInternsOnly(true);
    if (params.get('visa') === '1') setVisaOnly(true);
    if (params.get('closed') === '1') setShowClosed(true);
    if (params.get('unstated') === '0') setIncludeUnstated(false);
    if (params.get('hideApplied') === '1') setHideApplied(true);
    if (params.get('exclude')) setExclude(params.get('exclude')!);
    if (params.get('day')) setDay(params.get('day')!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (company) params.set('company', company);
    if (maxYears !== 3) params.set('maxYears', String(maxYears));
    if (industries.length) params.set('industries', industries.join(','));
    if (workMode) params.set('mode', workMode);
    if (minSalary) params.set('minSalary', String(minSalary));
    if (internsOnly) params.set('interns', '1');
    if (visaOnly) params.set('visa', '1');
    if (showClosed) params.set('closed', '1');
    if (!includeUnstated) params.set('unstated', '0');
    if (hideApplied) params.set('hideApplied', '1');
    if (exclude) params.set('exclude', exclude);
    if (day) params.set('day', day);
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [query, company, maxYears, industries, workMode, minSalary, internsOnly, visaOnly, showClosed, includeUnstated, hideApplied, exclude, day]);

  useEffect(() => {
    fetch(DATA_URL, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`catalogue returned ${res.status}`);
        return res.json();
      })
      .then(setJobs)
      .catch((e: Error) => setError(e.message));
    setOpened(loadOpened());
    setSavedIds(loadIdSet(SAVED_KEY));
    setAppliedIds(loadIdSet(APPLIED_KEY));
    setExclude(localStorage.getItem(EXCLUDE_KEY) ?? '');
  }, []);

  const markOpened = (id: string) =>
    setOpened((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      localStorage.setItem(OPENED_KEY, JSON.stringify([...next]));
      return next;
    });

  /** Saved/applied are the same pattern as opened: one id-set per kind. */
  const toggleMark = (kind: 'saved' | 'applied', id: string) => {
    const setter = kind === 'saved' ? setSavedIds : setAppliedIds;
    const key = kind === 'saved' ? SAVED_KEY : APPLIED_KEY;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(key, JSON.stringify([...next]));
      return next;
    });
  };

  const setExcludeBoth = (value: string) => {
    setExclude(value);
    localStorage.setItem(EXCLUDE_KEY, value);
  };

  const companies = useMemo(
    () => [...new Set((jobs ?? []).map((j) => j.company))].sort(),
    [jobs],
  );

  const shown = useMemo(() => {
    if (!jobs) return [];
    const needle = query.trim().toLowerCase();
    const excludeWords = exclude
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);

    return jobs.filter((job) => {
      if (!showClosed && job.closedAt) return false;
      if (internsOnly && !job.isIntern) return false;
      if (company && job.company !== company) return false;
      if (industries.length && !industries.includes(job.industry)) return false;
      if (workMode && job.workMode !== workMode) return false;
      // "Pays at least X" reads off the top of the band — a 10–14 LPA posting
      // clears a 12 LPA floor even though its min doesn't.
      if (minSalary && (job.salaryMax ?? 0) < minSalary) return false;
      if (visaOnly && !job.visa) return false;
      if (hideApplied && appliedIds.has(job.id)) return false;

      // Interns are entry-level by definition, so the years gate doesn't apply.
      if (!job.isIntern) {
        if (job.minYears === null) {
          if (!includeUnstated) return false;
        } else if (job.minYears > maxYears) return false;
      }

      const haystack = `${job.title} ${job.company} ${job.location}`.toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      // Excluded keywords are personal junk words — same carve-out philosophy
      // as HARD_EXCLUDE in src/classify.ts, but yours, and client-side only.
      if (excludeWords.some((word) => haystack.includes(word))) return false;
      return true;
    }).sort((a, b) => crawledTime(b) - crawledTime(a));
  }, [jobs, query, maxYears, includeUnstated, industries, internsOnly, showClosed, company, workMode, minSalary, visaOnly, hideApplied, appliedIds, exclude]);

  // Tab counts come off `shown` (all other filters applied), the view comes
  // off `dayShown` — filtering in two steps keeps each tab's count meaningful
  // while one is selected.
  const dayCounts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const job of shown) {
      const key = dayKey(job);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [shown]);
  const dayShown = useMemo(
    () => (day ? shown.filter((j) => dayKey(j) === day) : shown),
    [shown, day],
  );

  const freshJobs = useMemo(() => dayShown.filter((j) => !isBacklog(j)), [dayShown]);
  const backlogJobs = useMemo(() => dayShown.filter(isBacklog), [dayShown]);

  const groups = useMemo(() => {
    const byLabel = new Map<string, Job[]>();
    for (const job of freshJobs) {
      const label = bucketLabel(job);
      const list = byLabel.get(label);
      if (list) list.push(job);
      else byLabel.set(label, [job]);
    }
    return [...byLabel.entries()];
  }, [freshJobs]);

  const toggleIndustry = (value: string) =>
    setIndustries((current) =>
      current.includes(value) ? current.filter((i) => i !== value) : [...current, value],
    );

  return (
    <main className="wrap">
      <header>
        <div className="header-row">
          <h1>Job Radar</h1>
          <button className="chip outreach-link" onClick={openOutreach} title="Today's cold-email batch">
            Outreach batch
          </button>
        </div>
        <p>
          Fresher and entry-level roles in India and remote, read straight from company ATS
          boards. Updated hourly.
        </p>
      </header>

      <section className="controls panel">
        <div className="row">
          <input
            type="search"
            placeholder="Search title, company or location…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="field">
            Company
            <select value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">All companies</option>
              {companies.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row">
          <div className="slider">
            <span>Max experience</span>
            <input
              type="range"
              min={0}
              max={3}
              step={1}
              value={maxYears}
              onChange={(e) => setMaxYears(Number(e.target.value))}
            />
            <strong>
              {maxYears} {maxYears === 1 ? 'year' : 'years'}
            </strong>
          </div>
          <button
            className="chip"
            data-on={includeUnstated}
            onClick={() => setIncludeUnstated((v) => !v)}
          >
            Include unstated
          </button>
          <button className="chip" data-on={internsOnly} onClick={() => setInternsOnly((v) => !v)}>
            Internships only
          </button>
          <button className="chip" data-on={showClosed} onClick={() => setShowClosed((v) => !v)}>
            Show closed
          </button>
        </div>

        <div className="row">
          {INDUSTRIES.map((value) => (
            <button
              key={value}
              className="chip"
              data-on={industries.includes(value)}
              onClick={() => toggleIndustry(value)}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="row">
          <div className="facet-group">
            <span className="facet-label">Work mode</span>
            {(['', 'remote', 'hybrid', 'onsite'] as const).map((value) => (
              <button
                key={value || 'any'}
                className="chip"
                data-on={workMode === value}
                onClick={() => setWorkMode(value)}
              >
                {value || 'any'}
              </button>
            ))}
          </div>
          <label className="field">
            Min salary
            <select value={minSalary} onChange={(e) => setMinSalary(Number(e.target.value))}>
              {[0, 4, 6, 8, 10, 12, 15, 20].map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'Any' : `₹${v}+ LPA`}
                </option>
              ))}
            </select>
          </label>
          <button className="chip" data-on={visaOnly} onClick={() => setVisaOnly((v) => !v)}>
            Visa sponsorship
          </button>
          <button className="chip" data-on={hideApplied} onClick={() => setHideApplied((v) => !v)}>
            Hide applied
          </button>
        </div>

        <div className="row">
          <input
            type="text"
            placeholder="Exclude keywords (comma-separated, stored locally)…"
            value={exclude}
            onChange={(e) => setExcludeBoth(e.target.value)}
          />
        </div>
      </section>

      {error && (
        <div className="result err">
          Couldn&apos;t load job data: {error}. Check that <code>NEXT_PUBLIC_REPO</code> is set and
          that the repository is public.
        </div>
      )}

      {!jobs && !error && <p className="empty">Loading roles…</p>}

      {jobs && (
        <>
          <p className="count">
            {dayShown.length} of {jobs.filter((j) => !j.closedAt).length} open roles
            {company && (() => {
              // Lightweight company view (PHASES.md #69): a static-export site
              // can't cheaply generate a page per company, but the same data
              // answers the interesting question right here — is this employer
              // actively hiring, and how much of it is new this month?
              const all = jobs.filter((j) => j.company === company);
              const open = all.filter((j) => !j.closedAt).length;
              const month = all.filter(
                (j) => Date.now() - new Date(j.firstSeen).getTime() < 30 * 86_400_000,
              ).length;
              return ` · ${company}: ${open} open, ${month} first seen in the last 30 days`;
            })()}
          </p>

          <div className="row">
            <button className="chip" data-on={day === ''} onClick={() => setDay('')}>
              All ({dayCounts.reduce((sum, [, n]) => sum + n, 0)})
            </button>
            {dayCounts.map(([key, n]) => (
              <button key={key} className="chip" data-on={day === key} onClick={() => setDay(key)}>
                {dayLabel(key)} ({n})
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="empty">Nothing matches those filters.</p>
          ) : (
            <>
              {groups.map(([label, jobsInGroup], index) => (
                <details key={label} className="time-group" open={index < 2}>
                  <summary className="time-heading">
                    {label} ({jobsInGroup.length})
                  </summary>
                  <ul className="jobs">
                    {jobsInGroup.map((job) => (
                      <JobRow
                        job={job}
                        key={job.id}
                        opened={opened.has(job.id)}
                        saved={savedIds.has(job.id)}
                        applied={appliedIds.has(job.id)}
                        onOpen={() => markOpened(job.id)}
                        onMark={(kind) => toggleMark(kind, job.id)}
                      />
                    ))}
                  </ul>
                </details>
              ))}

              {backlogJobs.length > 0 && (
                <details className="time-group backlog">
                  <summary className="time-heading">
                    Backlog — {backlogJobs.length} role{backlogJobs.length === 1 ? '' : 's'} posted
                    over {BACKLOG_DAYS} days ago
                  </summary>
                  <ul className="jobs">
                    {backlogJobs.map((job) => (
                      <JobRow
                        job={job}
                        key={job.id}
                        opened={opened.has(job.id)}
                        saved={savedIds.has(job.id)}
                        applied={appliedIds.has(job.id)}
                        onOpen={() => markOpened(job.id)}
                        onMark={(kind) => toggleMark(kind, job.id)}
                      />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}

      <AddCompany />

      <footer>
        Data and source on <a href={REPO_URL}>GitHub</a>. Apply on the company link — direct
        applications convert far better than aggregators.
      </footer>
    </main>
  );
}
