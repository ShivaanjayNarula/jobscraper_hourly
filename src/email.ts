import type { Job } from './types.js';
import { EMAIL_DETAIL_LIMIT } from './config.js';

/** One-liners shown before the backlog section collapses to "+N more". */
const BACKLOG_DISPLAY_LIMIT = 30;

export interface RampingEmployer {
  company: string;
  open: number;
  newLast30: number;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TECH_INDUSTRIES = new Set(['tech', 'fintech']);

function experienceLabel(job: Job): string {
  if (job.isIntern) return 'Internship';
  if (job.minYears === null) return 'Experience not stated';
  if (job.maxYears !== null) return `${job.minYears}–${job.maxYears} yrs`;
  return `${job.minYears}+ yrs`;
}

/**
 * Applying early measurably matters, so freshness goes on the card. Workday and
 * Amazon return relative strings ("Posted Today") rather than timestamps, so
 * anything unparseable is passed through as-is instead of being dropped.
 */
function freshness(job: Job): string | undefined {
  if (!job.postedAt) return undefined;
  const posted = new Date(job.postedAt).getTime();
  if (Number.isNaN(posted)) return job.postedAt.replace(/^posted\s*/i, '') || undefined;

  const hours = Math.floor((Date.now() - posted) / 3_600_000);
  if (hours < 1) return 'just posted';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function card(job: Job): string {
  const salary = job.salaryMin
    ? `₹${fmtLpa(job.salaryMin)}${job.salaryMax && job.salaryMax !== job.salaryMin ? `–${fmtLpa(job.salaryMax)}` : ''} LPA`
    : undefined;
  const flags = [job.isRepost && 'reposted', job.visa && 'visa sponsorship']
    .filter((v): v is string => Boolean(v));
  const mode = job.workMode === 'remote' ? 'Remote' : job.workMode === 'hybrid' ? 'Hybrid' : undefined;
  const meta = [job.location, experienceLabel(job), freshness(job), salary, mode, ...flags]
    .filter((value): value is string => Boolean(value))
    .map(escape);
  return `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e8e8ea;">
      <a href="${escape(job.url)}" style="font-size:15px;font-weight:600;color:#0b57d0;text-decoration:none;">${escape(job.title)}</a>
      <div style="font-size:13px;color:#444;margin-top:3px;">${escape(job.company)}</div>
      <div style="font-size:12px;color:#777;margin-top:3px;">${meta.join(' &middot; ')}</div>
    </td></tr>`;
}

function compactLine(job: Job): string {
  return `
    <tr><td style="padding:5px 0;font-size:13px;color:#444;">
      <a href="${escape(job.url)}" style="color:#0b57d0;text-decoration:none;">${escape(job.title)}</a>
      &middot; ${escape(job.company)} &middot; <span style="color:#888;">${escape(job.location)}</span>
    </td></tr>`;
}

function section(title: string, jobs: Job[], detailBudget: number): string {
  if (jobs.length === 0) return '';
  const detailed = jobs.slice(0, detailBudget);
  const compact = jobs.slice(detailBudget);

  return `
    <tr><td style="padding-top:26px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#666;">
      ${escape(title)} (${jobs.length})
    </td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0">${detailed.map(card).join('')}</table></td></tr>
    ${
      compact.length
        ? `<tr><td style="padding-top:12px;font-size:12px;color:#888;">${compact.length} more:</td></tr>
           <tr><td><table width="100%" cellpadding="0" cellspacing="0">${compact.map(compactLine).join('')}</table></td></tr>`
        : ''
    }`;
}

const fmtLpa = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * "New" means new to this tracker, not newly posted (see EMAIL_FRESHNESS_DAYS
 * in config.ts) — adding a company, or a board recovering from errors, makes
 * its whole backlog look new at once. `fresh` gets the full urgent treatment;
 * `stale` still needs to reach you *somewhere*, or a role only visible in
 * data/jobs.json (which nothing but the web UI reads) is effectively invisible
 * if that UI isn't deployed. So it's shown too, just demoted to a low-key
 * one-line list instead of framed as breaking news.
 */
function backlogSection(stale: Job[]): string {
  if (stale.length === 0) return '';
  const shown = stale.slice(0, BACKLOG_DISPLAY_LIMIT);
  const overflow = stale.length - shown.length;

  return `
    <tr><td style="padding-top:26px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;">
      Also newly found — posted 21+ days ago (${stale.length})
    </td></tr>
    <tr><td style="padding-top:3px;font-size:11px;color:#999;">
      Not time-sensitive — usually a company or board that was just added, not breaking news.
    </td></tr>
    <tr><td style="padding-top:10px;"><table width="100%" cellpadding="0" cellspacing="0">${shown.map(compactLine).join('')}</table></td></tr>
    ${overflow > 0 ? `<tr><td style="padding-top:6px;font-size:11px;color:#999;">+${overflow} more in data/jobs.json</td></tr>` : ''}`;
}

export function subject(fresh: Job[], stale: Job[] = []): string {
  if (fresh.length === 0) {
    return `${stale.length} backlog role${stale.length === 1 ? '' : 's'} found (21+ days old)`;
  }
  const tech = fresh.filter((j) => TECH_INDUSTRIES.has(j.industry)).length;
  const finance = fresh.length - tech;
  const parts = [tech && `${tech} tech`, finance && `${finance} finance`].filter(Boolean);
  const backlog = stale.length > 0 ? ` (+${stale.length} backlog)` : '';
  return `${fresh.length} new role${fresh.length === 1 ? '' : 's'}${backlog} · ${parts.join(', ')}`;
}

/**
 * Everything found is rendered. The first N fresh roles get full cards and the
 * remainder become one-liners — truncating outright would lose them
 * permanently, because they're already written to seen.json and will never
 * alert again.
 */
/**
 * Phase D: aggregate signal no single posting carries. A company whose
 * catalogue share is climbing is ramping hiring — worth a look even when each
 * individual role is old news. Rendered as a quiet strip above the footer;
 * absent entirely when nothing qualifies, never a filler row.
 */
function rampingSection(employers: RampingEmployer[]): string {
  if (employers.length === 0) return '';
  const items = employers
    .map((e) => `${escape(e.company)} (${e.newLast30} new of ${e.open} open)`)
    .join(' &middot; ');
  return `
    <tr><td style="padding-top:26px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#666;">
      Ramping — hiring fastest right now
    </td></tr>
    <tr><td style="padding-top:6px;font-size:13px;color:#444;">${items}</td></tr>`;
}

export function renderEmail(fresh: Job[], stale: Job[] = [], ramping: RampingEmployer[] = []): string {
  const tech = fresh.filter((j) => TECH_INDUSTRIES.has(j.industry));
  const finance = fresh.filter((j) => !TECH_INDUSTRIES.has(j.industry));

  const techBudget =
    fresh.length > 0 ? Math.max(1, Math.round((EMAIL_DETAIL_LIMIT * tech.length) / fresh.length)) : 0;

  const headline =
    fresh.length > 0
      ? `${fresh.length} new role${fresh.length === 1 ? '' : 's'}`
      : `${stale.length} backlog role${stale.length === 1 ? '' : 's'} found`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f6f7;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:24px 12px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:10px;padding:26px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="font-size:19px;font-weight:700;color:#111;">${headline}</td></tr>
        <tr><td style="font-size:13px;color:#777;padding-top:4px;">India &amp; remote &middot; up to 3 years &middot; internships included</td></tr>
        ${section('Tech · Data · ML', tech, techBudget)}
        ${section('Finance · Consulting · Quant', finance, EMAIL_DETAIL_LIMIT - techBudget)}
        ${backlogSection(stale)}
        ${rampingSection(ramping)}
        <tr><td style="padding-top:26px;font-size:11px;color:#aaa;border-top:1px solid #eee;">
          jobscraper-next &middot; tune filters in <code>src/config.ts</code>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
