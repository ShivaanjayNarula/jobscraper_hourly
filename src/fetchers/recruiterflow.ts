import type { Company, RawJob } from '../types.js';
import { UA } from './util.js';

interface RecruiterflowJob {
  job_id: number;
  job_name: string;
  details?: string;
  apply_link?: string;
  last_opened?: string;
  employment_type?: string;
}

/** Grabs the balanced `{...}` object literal right after `needle` in `src`. */
function extractJsonAfter(src: string, needle: string): string | undefined {
  const start = src.indexOf(needle);
  if (start === -1) return undefined;
  const open = src.indexOf('{', start);
  if (open === -1) return undefined;

  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

/**
 * Recruiterflow — a small but real Indian ATS (CoinSwitch, Wishup).
 * `token` is the company slug from the board URL,
 * e.g. "coinswitch" in recruiterflow.com/coinswitch/jobs.
 *
 * The board embeds the full job list as `window.jobsList = {department:
 * [[deptName, [job, job, ...]], ...]}` in an inline `<script>` — no XHR.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const url = `https://recruiterflow.com/${company.token}/jobs`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const html = await res.text();

  const raw = extractJsonAfter(html, 'window.jobsList');
  if (!raw) return [];

  const parsed = JSON.parse(raw) as { department?: [string, RecruiterflowJob[]][] };
  const jobs: RawJob[] = [];

  for (const [, group] of parsed.department ?? []) {
    for (const job of group) {
      jobs.push({
        externalId: String(job.job_id),
        title: job.job_name,
        location: job.details ?? '',
        url: `https://recruiterflow.com/${job.apply_link ?? `${company.token}/jobs/${job.job_id}`}`,
        postedAt: job.last_opened,
        text: job.employment_type,
      });
    }
  }
  return jobs;
}
