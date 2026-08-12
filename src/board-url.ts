import type { Ats, Company, Industry } from './types.js';

/**
 * Turns any job or board URL into a `companies.json` entry.
 *
 * Shared by `detect` (which finds URLs on careers pages) and `import` (which
 * takes them from a list), so the parsing rules live in exactly one place.
 */
const HOSTED: { ats: Ats; pattern: RegExp }[] = [
  {
    ats: 'greenhouse',
    pattern:
      /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
  },
  { ats: 'lever', pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { ats: 'ashby', pattern: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i },
  { ats: 'smartrecruiters', pattern: /(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/i },
];

const WORKDAY =
  /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:(?:[a-z]{2}-[A-Za-z]{2})\/)?([A-Za-z0-9_-]+)/i;

/** Oracle tenants sit on regional pods: `{tenant}.fa.{pod}.oraclecloud.com`. */
const ORACLE =
  /https?:\/\/([a-z0-9-]+)\.(fa(?:\.[a-z0-9]+)?)\.oraclecloud\.com[^"'\s]*?(?:siteNumber=|\/sites\/)(CX_[0-9]+)/i;

/** Path segments that are ATS plumbing rather than a company. */
const NOT_A_COMPANY =
  /^(embed|api|v1|assets|static|images|css|js|robots|sitemap|favicon|_next|search|jobs|job)$/i;

function prettify(slug: string): string {
  return slug
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function parseBoardUrl(url: string, industry: Industry = 'tech'): Company | null {
  const workday = WORKDAY.exec(url);
  if (workday) {
    const [, token, host, site] = workday;
    if (!token || !site || host?.startsWith('impl')) return null;
    return {
      name: prettify(token),
      ats: 'workday',
      token,
      host,
      site,
      industry,
      source: 'curated',
    };
  }

  const oracle = ORACLE.exec(url);
  if (oracle) {
    const [, token, host, siteNumber] = oracle;
    return {
      name: prettify(token!),
      ats: 'oracle',
      token: token!,
      host,
      siteNumber,
      industry,
      source: 'curated',
    };
  }

  for (const { ats, pattern } of HOSTED) {
    const match = pattern.exec(url);
    const token = match?.[1];
    if (token && !NOT_A_COMPANY.test(token)) {
      return { name: prettify(token), ats, token, industry, source: 'curated' };
    }
  }

  return null;
}

export function boardKey(company: Company): string {
  return `${company.ats}:${company.token.toLowerCase()}`;
}
