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

function experience(job: Job): string {
  if (job.isIntern) return 'Internship';
  if (job.minYears === null) return 'Not stated';
  if (job.maxYears !== null) return `${job.minYears}–${job.maxYears} yrs`;
  return `${job.minYears}+ yrs`;
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

  useEffect(() => {
    fetch(DATA_URL, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`catalogue returned ${res.status}`);
        return res.json();
      })
      .then(setJobs)
      .catch((e: Error) => setError(e.message));
  }, []);

  const companies = useMemo(
    () => [...new Set((jobs ?? []).map((j) => j.company))].sort(),
    [jobs],
  );

  const shown = useMemo(() => {
    if (!jobs) return [];
    const needle = query.trim().toLowerCase();

    return jobs.filter((job) => {
      if (!showClosed && job.closedAt) return false;
      if (internsOnly && !job.isIntern) return false;
      if (company && job.company !== company) return false;
      if (industries.length && !industries.includes(job.industry)) return false;

      // Interns are entry-level by definition, so the years gate doesn't apply.
      if (!job.isIntern) {
        if (job.minYears === null) {
          if (!includeUnstated) return false;
        } else if (job.minYears > maxYears) return false;
      }

      if (needle) {
        const haystack = `${job.title} ${job.company} ${job.location}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [jobs, query, maxYears, includeUnstated, industries, internsOnly, showClosed, company]);

  const toggleIndustry = (value: string) =>
    setIndustries((current) =>
      current.includes(value) ? current.filter((i) => i !== value) : [...current, value],
    );

  return (
    <main className="wrap">
      <header>
        <h1>Job Radar</h1>
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
            {shown.length} of {jobs.filter((j) => !j.closedAt).length} open roles
          </p>

          {shown.length === 0 ? (
            <p className="empty">Nothing matches those filters.</p>
          ) : (
            <ul className="jobs">
              {shown.map((job) => {
                const posted = ago(job.postedAt ?? job.firstSeen);
                return (
                  <li className="job" key={job.id} data-closed={Boolean(job.closedAt)}>
                    <a className="title" href={job.url} target="_blank" rel="noreferrer">
                      {job.title}
                    </a>
                    <div className="company">{job.company}</div>
                    <div className="meta">
                      <span>{job.location}</span>
                      <span className={`tag${job.isIntern ? ' intern' : ''}`}>{experience(job)}</span>
                      {posted && <span>{posted}</span>}
                      {job.salary && <span>{job.salary}</span>}
                      {job.closedAt && <span className="tag closed">closed</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
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
