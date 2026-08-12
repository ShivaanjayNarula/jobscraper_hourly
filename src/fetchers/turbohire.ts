import type { Company, RawJob } from '../types.js';
import { toPlainText, UA } from './util.js';

interface TurboJob {
  JobId: string;
  JobIdObfuscated?: string;
  JobCode?: string;
  JobTitle: string;
  Department?: string;
  /** A JSON *string* holding an array of `{ Address }`, not an array. */
  Location?: string;
  Type?: string;
  CTCInfo?: { Type?: string; MinCTC?: number; MaxCTC?: number; IsHidden?: boolean };
  Experience?: { MinExp?: number; MaxExp?: number };
  Skills?: string[] | string;
  JobDescV2?: string;
  PublishedDate?: string;
  UpdatedDate?: string;
}

function places(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { Address?: string }[];
    return parsed.map((p) => p.Address).filter(Boolean).join(', ');
  } catch {
    return raw;
  }
}

function pay(ctc: TurboJob['CTCInfo']): string | undefined {
  if (!ctc || ctc.IsHidden || (!ctc.MinCTC && !ctc.MaxCTC)) return undefined;
  return `${ctc.MinCTC ?? '?'}–${ctc.MaxCTC ?? '?'}`;
}

/** Structured years beat parsing prose, so feed them to the classifier verbatim. */
function experience(exp: TurboJob['Experience']): string {
  if (!exp || (exp.MinExp === undefined && exp.MaxExp === undefined)) return '';
  if (exp.MaxExp !== undefined && exp.MinExp !== undefined) {
    return `${exp.MinExp}-${exp.MaxExp} years`;
  }
  return `${exp.MinExp ?? exp.MaxExp} years`;
}

const API = 'https://thapi.azurewebsites.net';

/**
 * TurboHire — Flipkart, Purplle, Navi.
 *
 *   token -> the organisation GUID from the careers URL
 *            (`{sub}.turbohire.co/careerpage/{GUID}`)
 *   site  -> the careers subdomain, e.g. "flipkart", used for Origin/Referer
 *
 * Three things had to line up here:
 *
 *  1. `/api/token/noauth` issues an anonymous bearer token, but only when the
 *     request carries `Origin` and `Referer` for the tenant's careers domain.
 *     Without them it answers `"Invalid request."`.
 *  2. `filteredjobs` is POST-only and rejects unauthenticated calls with
 *     "Authorization has been denied", so the token must be fetched first.
 *  3. **`pageType` selects the result set, and the default is wrong.** `0`
 *     returns a fixed teaser of 10, `1` returns 6,862 (the full historical
 *     corpus), and `2` returns the 61 genuinely-open roles. Every pagination
 *     parameter is ignored — the whole set comes back in one response.
 */
async function token(company: Company): Promise<string> {
  const origin = `https://${company.site}.turbohire.co`;
  const res = await fetch(`${API}/api/token/noauth`, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      origin,
      referer: `${origin}/`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`turbohire token ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('turbohire: no access_token issued');
  return body.access_token;
}

export async function list(company: Company): Promise<RawJob[]> {
  const bearer = await token(company);
  const origin = `https://${company.site}.turbohire.co`;

  const res = await fetch(
    `${API}/api/careerpagev2/filteredjobs?orgId=${company.token}&pageType=2`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'user-agent': UA,
        origin,
        referer: `${origin}/`,
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`turbohire ${company.token} ${res.status}`);

  const body = (await res.json()) as { Total?: number; Result?: TurboJob[] };

  return (body.Result ?? []).map((job) => ({
    externalId: job.JobId,
    title: job.JobTitle,
    location: places(job.Location),
    url: job.JobIdObfuscated
      ? `${origin}/jobs/${job.JobIdObfuscated}`
      : `${origin}/careerpage/${company.token}`,
    postedAt: job.PublishedDate ?? job.UpdatedDate,
    salary: pay(job.CTCInfo),
    text: toPlainText(
      [
        job.Department,
        experience(job.Experience),
        Array.isArray(job.Skills) ? job.Skills.join(' ') : (job.Skills ?? ''),
        job.JobDescV2 ?? '',
      ].join(' '),
    ).slice(0, 6000),
  }));
}
