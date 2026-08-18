import type { Company, RawJob } from '../types.js';
import { toPlainText, UA } from './util.js';

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m?.[1];
}

/** The description's opening line is `<h2 id="job_meta"><p>Location: City,State,Country</p></h2>`, XML-escaped. */
function extractLocation(descRaw: string): string {
  const m = /Location:\s*([^&<]+)/i.exec(descRaw);
  return m?.[1] ? m[1].trim() : '';
}

/**
 * Trakstar Hire (formerly RecruiterBox) — common among Indian product
 * companies (LogiNext, Dream11, WeWork India, Exotel, HappyFox, Whatfix,
 * MoEngage). `token` is the tenant subdomain, e.g. "loginext".
 *
 * The RSS feed carries title, location and the full description in one
 * unauthenticated call — no pagination, no per-job detail fetch needed.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const url = `https://${company.token}.hire.trakstar.com/jobfeeds/${company.token}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/xml, text/xml' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const xml = await res.text();

  const jobs: RawJob[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    if (!title || !link) continue;

    const descRaw = tag(block, 'description') ?? '';
    const externalId = link.split('/jobs/')[1]?.split(/[?#]/)[0] ?? link;

    jobs.push({
      externalId,
      title: toPlainText(title),
      location: extractLocation(descRaw),
      url: link.replace(/^http:/, 'https:'),
      postedAt: tag(block, 'pubDate'),
      text: toPlainText(descRaw).slice(0, 6000),
    });
  }
  return jobs;
}
