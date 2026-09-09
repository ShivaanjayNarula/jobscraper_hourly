'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Job } from '@/lib/types';

/**
 * YC's India directory, cross-referenced against our own catalogue.
 *
 * The pipeline already sweeps this list weekly (`discover.yml`'s `yc-directory`
 * job runs `yc-domains India` into `detect`), but that only ever shows up as
 * boards quietly appearing in companies.json. This tab is the view of it: which
 * YC India companies we can actually see hiring right now, and which ones we
 * cannot reach yet.
 *
 * The credentials below are the same ones `src/yc-directory.ts` uses, and they
 * are shipped in the directory page's own JS bundle for every visitor — the key
 * is scoped read-only to the `ycdc_public` tag, so it can only ever see what
 * that page already shows. Duplicated rather than imported because the web app
 * is a separate package that does not read from `src/`, the same deliberate
 * split (and the same drift risk) as `lib/types.ts`'s Job mirror.
 */
const APP_ID = '45BWZJ1SGC';
const API_KEY =
  'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';
const INDEX = 'YCCompany_production';
const HITS_PER_PAGE = 1000;

interface YCCompany {
  name: string;
  website: string;
  batch: string;
  domain: string;
}

async function fetchYCIndia(): Promise<YCCompany[]> {
  const out: YCCompany[] = [];
  const seen = new Set<string>();

  for (let page = 0; ; page++) {
    const params = new URLSearchParams({
      query: '',
      hitsPerPage: String(HITS_PER_PAGE),
      page: String(page),
      facetFilters: JSON.stringify([['regions:India']]),
    });

    const res = await fetch(`https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`, {
      method: 'POST',
      headers: {
        'x-algolia-application-id': APP_ID,
        'x-algolia-api-key': API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requests: [{ indexName: INDEX, params: params.toString() }] }),
    });
    if (!res.ok) throw new Error(`YC directory returned ${res.status}`);

    const result = (
      (await res.json()) as {
        results: { hits: { name?: string; website?: string; batch?: string; status?: string }[]; nbPages: number }[];
      }
    ).results[0];
    if (!result) break;

    for (const hit of result.hits) {
      // A defunct startup has nobody left to hire, so it is noise here for the
      // same reason `fetchYCCompanies({ activeOnly: true })` drops it.
      if (!hit.name || !hit.website || hit.status !== 'Active') continue;
      // Founders type whatever URL they like, so scheme, `www.`, a trailing
      // path, a trailing slash and a query string are all inconsistent. 100x's
      // listed website is `https://100x.bot?utm_source=...` with no path
      // separator, so splitting on "/" alone leaves the campaign tail glued to
      // the hostname. Same rule as `bareDomain` in src/yc-directory.ts.
      const domain = hit.website
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split(/[/?#]/)[0]!
        .trim()
        .toLowerCase();
      if (!domain.includes('.') || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ name: hit.name, website: `https://${domain}`, batch: hit.batch ?? '', domain });
    }

    if (page + 1 >= result.nbPages) break;
  }

  return out;
}

/**
 * Catalogue rows and directory rows name the same company differently: `detect`
 * builds a board's name from its domain, so loophealth.com becomes "Loophealth"
 * while YC calls it "Loop Health". Stripping everything but letters and digits
 * collapses both to the same key, and the domain's own base is tried as a
 * second key for the cases where the brand and the domain diverge further.
 */
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function YCPanel({ jobs }: { jobs: Job[] }) {
  const [companies, setCompanies] = useState<YCCompany[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchYCIndia()
      .then(setCompanies)
      .catch((e: Error) => setError(e.message));
  }, []);

  const byCompany = useMemo(() => {
    const map = new Map<string, Job[]>();
    // Closed requisitions are excluded the same way the Jobs view's own counts
    // exclude them: "N live roles" has to mean roles you can still apply to.
    for (const job of jobs.filter((j) => !j.closedAt)) {
      const key = normalize(job.company);
      const bucket = map.get(key);
      if (bucket) bucket.push(job);
      else map.set(key, [job]);
    }
    return map;
  }, [jobs]);

  const rows = useMemo(() => {
    if (!companies) return [];
    return companies
      .map((company) => ({
        company,
        jobs:
          byCompany.get(normalize(company.name)) ??
          byCompany.get(normalize(company.domain.split('.')[0]!)) ??
          [],
      }))
      // Hiring first, then most roles, then alphabetical — the point of the tab
      // is the companies we can see hiring, not the alphabet.
      .sort(
        (a, b) =>
          b.jobs.length - a.jobs.length || a.company.name.localeCompare(b.company.name),
      );
  }, [companies, byCompany]);

  if (error) {
    return (
      <section className="panel">
        <div className="result err">Could not load the YC directory: {error}</div>
      </section>
    );
  }

  if (!companies) {
    return (
      <section className="panel">
        <div className="empty">Loading the YC India directory…</div>
      </section>
    );
  }

  const hiring = rows.filter((row) => row.jobs.length > 0);
  const roles = hiring.reduce((total, row) => total + row.jobs.length, 0);

  return (
    <>
      <section className="panel">
        <div className="count" style={{ margin: 0 }}>
          {hiring.length} of {rows.length} active YC India companies have roles in this catalogue
          right now — {roles} in total. The rest either run no ATS this project can read yet, or
          have nothing open.
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)' }}>
          The directory is re-swept weekly and every company on it is re-resolved against its own
          careers page, because YC-stage startups adopt an ATS after they start hiring — a company
          that resolves to nothing today often resolves to a real board a few months later.
        </p>
      </section>

      <div className="yc-list">
        {rows.map(({ company, jobs: open }) => (
          <div className="job yc-row" key={company.domain}>
            <div>
              <a className="title" href={company.website} target="_blank" rel="noreferrer">
                {company.name}
              </a>
              <div className="meta">
                {company.batch && <span className="tag">{company.batch}</span>}
                <span>{company.domain}</span>
                {open.length === 0 && <span className="tag stale">no live roles</span>}
              </div>
            </div>

            {open.length > 0 && (
              <details className="yc-jobs">
                <summary>
                  {open.length} live role{open.length === 1 ? '' : 's'}
                </summary>
                <ul>
                  {open.map((job) => (
                    <li key={job.id}>
                      <a href={job.url} target="_blank" rel="noreferrer">
                        {job.title}
                      </a>
                      <span className="meta"> {job.location}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
