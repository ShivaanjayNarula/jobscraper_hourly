import type { Company, RawJob } from '../types.js';
import { getJson, safeIso, toPlainText } from './util.js';

/**
 * Teamtailor — a Nordic-origin ATS with a large European footprint.
 *
 *   token -> the career-site subdomain, e.g. "lifesum" for
 *            lifesum.teamtailor.com. A tenant on a custom domain keeps the
 *            full hostname in `token` instead (the same convention iCIMS and
 *            Zoho Recruit already use), because Teamtailor lets a customer
 *            serve the same board from its own domain and there is then no
 *            subdomain to derive.
 *
 * Every board publishes `/jobs.json`, a JSON Feed 1.1 document, with no
 * credential and no pagination — one call returns the whole open listing.
 * Verified live against two real tenants (2026-09-06).
 *
 * The feed's own item fields carry no location at all; JSON Feed has no
 * concept of one. Teamtailor attaches a `_jobposting` extension holding the
 * page's schema.org JobPosting block, and that is the only place the city
 * appears — so location parsing goes through the extension, not the item.
 */
interface Place {
  address?: {
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string;
  };
}

interface JobPosting {
  jobLocation?: Place | Place[];
  jobLocationType?: string;
}

interface TtItem {
  id?: string;
  title?: string;
  url?: string;
  date_published?: string;
  content_html?: string;
  _jobposting?: JobPosting;
}

function host(company: Company): string {
  return company.token.includes('.') ? company.token : `${company.token}.teamtailor.com`;
}

/**
 * A posting can list several offices, and a remote one is flagged by
 * `jobLocationType: "TELECOMMUTE"` rather than by any address.
 *
 * "Remote" is appended rather than substituted on purpose: filter.ts's
 * `locationMatches` only accepts a remote role when nothing but noise words
 * remain, so "Stockholm, Sweden / Remote" correctly stays excluded while a
 * posting with no address at all reads as genuinely global remote. Dropping
 * the addresses and reporting a bare "Remote" would turn every country-locked
 * hybrid role into a false match.
 */
export function place(posting: JobPosting | undefined): string {
  const raw = posting?.jobLocation;
  const places = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const names = places
    .map((p) =>
      [p.address?.addressLocality, p.address?.addressRegion, p.address?.addressCountry]
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean);
  if (posting?.jobLocationType === 'TELECOMMUTE') names.push('Remote');
  return [...new Set(names)].join(' / ');
}

export async function list(company: Company): Promise<RawJob[]> {
  const data = await getJson<{ items?: TtItem[] }>(`https://${host(company)}/jobs.json`);
  const jobs: RawJob[] = [];

  for (const item of data.items ?? []) {
    if (!item.id || !item.title) continue;
    jobs.push({
      externalId: item.id,
      title: item.title,
      location: place(item._jobposting),
      url: item.url ?? `https://${host(company)}/jobs`,
      postedAt: safeIso(item.date_published),
      text: item.content_html ? toPlainText(item.content_html) : undefined,
    });
  }

  return jobs;
}
