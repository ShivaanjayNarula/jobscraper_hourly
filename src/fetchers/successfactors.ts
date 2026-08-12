import type { Company, RawJob } from '../types.js';
import { INDIA } from '../config.js';
import { toPlainText, UA } from './util.js';

/**
 * SuccessFactors Career Site Builder and legacy Recruiting Management both
 * publish credential-free XML feeds — no headless browser needed, despite the
 * search results page itself being server-rendered HTML with no JSON API.
 *
 * These feeds are unusually slow (observed 30s-150s for a single company,
 * apparently proportional to total job count), so this adapter uses its own
 * generous timeout rather than the 30s in getJson.
 */
const FEED_TIMEOUT_MS = 180_000;

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/xml, text/xml' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  if (!m) return undefined;
  const raw = m[1]!.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return toPlainText(raw);
}

/** Career Site Builder — Google-Merchant-namespaced RSS with a real location field per item. */
function parseModern(xml: string): RawJob[] {
  const jobs: RawJob[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const id = tag(block, 'g:id');
    const title = tag(block, 'title');
    if (!id || !title) continue;
    jobs.push({
      externalId: id,
      title,
      location: tag(block, 'g:location') ?? '',
      url: tag(block, 'link') ?? '',
    });
  }
  return jobs;
}

/**
 * Legacy Recruiting Management XML carries no location field at all — only a
 * title, a description and a couple of unlabeled filter blocks. The city has
 * to be recovered from free text, so a job only gets a location when the
 * India regex actually matches somewhere in it; everything else is left
 * blank, which correctly excludes it rather than risking a false positive.
 */
function parseLegacy(xml: string, host: string, company: string): RawJob[] {
  const jobs: RawJob[] = [];
  for (const block of xml.match(/<Job>[\s\S]*?<\/Job>/g) ?? []) {
    const id = tag(block, 'ReqId');
    const title = tag(block, 'JobTitle');
    if (!id || !title) continue;

    const description = tag(block, 'Job-Description') ?? '';
    const cityMatch = INDIA.exec(`${title} ${description}`);
    const postedRaw = tag(block, 'Posted-Date'); // DD/MM/YYYY
    const postedMatch = postedRaw ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(postedRaw) : null;

    jobs.push({
      externalId: id,
      title,
      location: cityMatch ? cityMatch[0] : '',
      url: `https://${host}/career?company=${company}&career_ns=job_listing&job_req_id=${id}`,
      postedAt: postedMatch ? `${postedMatch[3]}-${postedMatch[2]}-${postedMatch[1]}` : undefined,
      text: description,
    });
  }
  return jobs;
}

export async function list(company: Company): Promise<RawJob[]> {
  if (company.host) {
    const xml = await fetchXml(
      `https://${company.host}/career?company=${company.token}&career_ns=job_listing_summary&resultType=XML`,
    );
    return parseLegacy(xml, company.host, company.token);
  }
  const xml = await fetchXml(`https://${company.token}/sitemal.xml`);
  return parseModern(xml);
}
