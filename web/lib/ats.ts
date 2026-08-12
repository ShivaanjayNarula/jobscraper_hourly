/**
 * Resolves a pasted careers URL into a board definition and counts its jobs.
 *
 * This runs entirely in the browser. Greenhouse, Lever, Ashby and SmartRecruiters
 * all send `Access-Control-Allow-Origin: *` on these endpoints, so the page can
 * validate a board before you commit it — no backend, no proxy. Workday does not
 * allow cross-origin reads, so those are parsed but not live-counted.
 */
export interface Detected {
  ats: string;
  token: string;
  host?: string;
  site?: string;
  /** null when the ATS blocks cross-origin reads and we couldn't count. */
  jobCount: number | null;
  note?: string;
}

const PATTERNS: { ats: string; pattern: RegExp }[] = [
  { ats: 'greenhouse', pattern: /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i },
  { ats: 'lever', pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { ats: 'ashby', pattern: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i },
  { ats: 'smartrecruiters', pattern: /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i },
];

const WORKDAY = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([A-Za-z0-9_-]+)/i;

async function countJobs(ats: string, token: string): Promise<number> {
  const endpoints: Record<string, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`,
  };

  const res = await fetch(endpoints[ats]!);
  if (!res.ok) throw new Error(`board returned ${res.status}`);
  const data = await res.json();

  if (ats === 'lever') return Array.isArray(data) ? data.length : 0;
  if (ats === 'greenhouse' || ats === 'ashby') return data.jobs?.length ?? 0;
  return data.totalFound ?? 0;
}

export async function detectBoard(input: string): Promise<Detected> {
  const workday = WORKDAY.exec(input);
  if (workday) {
    return {
      ats: 'workday',
      token: workday[1]!,
      host: workday[2],
      site: workday[3],
      jobCount: null,
      note: "Workday blocks cross-origin reads, so this can't be counted here — but the entry is correct.",
    };
  }

  for (const { ats, pattern } of PATTERNS) {
    const match = pattern.exec(input);
    if (match?.[1] && match[1] !== 'embed') {
      const token = match[1];
      const jobCount = await countJobs(ats, token);
      if (jobCount === 0) throw new Error('that board resolved but has no open jobs');
      return { ats, token, jobCount };
    }
  }

  throw new Error(
    'No board found in that URL. Paste the link your careers page sends you to — it should contain greenhouse.io, lever.co, ashbyhq.com, smartrecruiters.com or myworkdayjobs.com.',
  );
}

export function toEntry(detected: Detected, name: string, industry: string): string {
  const entry: Record<string, string> = { name, ats: detected.ats, token: detected.token };
  if (detected.host) entry.host = detected.host;
  if (detected.site) entry.site = detected.site;
  entry.industry = industry;
  entry.source = 'curated';
  return JSON.stringify(entry, null, 2);
}
