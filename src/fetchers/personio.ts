import type { Company, RawJob } from '../types.js';
import { UA, safeIso, toPlainText } from './util.js';

/**
 * Personio — the dominant HR suite for German/DACH mid-market companies.
 *
 *   token -> the board subdomain, e.g. "acme" for acme.jobs.personio.de
 *
 * `/xml` is a credential-free feed of every open position. `.de` and `.com`
 * serve identical content for the same tenant (verified live), so only `.de`
 * is used here — there is no second host to try.
 *
 * A subdomain with no board 307s to Personio's marketing site rather than
 * 404ing, which would otherwise arrive as a successful fetch of an HTML page
 * and read as "live board, nothing open". The `<workzag-jobs>` root-element
 * check is what keeps a dead tenant failing loudly and therefore evictable.
 */
const FEED_TIMEOUT_MS = 60_000;

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  if (!m) return undefined;
  const value = toPlainText(m[1]!.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, ''));
  return value || undefined;
}

/**
 * Personio offices are bare labels — "München", "Göttingen", "Riederich" — and
 * the feed carries no country field anywhere, on any position. That is fine
 * for a city name, which the India regex can judge on its own, but it makes an
 * office literally named **"Remote"** unresolvable: there is nothing in the
 * record saying remote from where.
 *
 * `filter.ts`'s `locationMatches` accepts a remote posting when nothing but
 * noise words survive, so a country-less "Remote" would sail through as
 * globally remote. Measured on the first 60 imported boards: 56 of them
 * matched *only* on that, against 4 with a real India location — 94 postings
 * whose office is exactly "Remote", nearly all German-language listings from
 * German employers, where "remote" means remote-within-Germany.
 *
 * So an all-remote office set reports no location at all, which excludes it.
 * That is the same conservative call SuccessFactors' legacy path already
 * makes: no usable location field means excluded, never guessed. A mixed set
 * like "Remote / Hamburg / Berlin" keeps its cities and is correctly excluded
 * by the residue check, and a genuine "IN_Bangalore / IN_Pune" set is
 * unaffected.
 */
const REMOTE_ONLY = /^(remote|remote work|home ?office|anywhere|worldwide)$/i;

export function place(offices: string[]): string {
  // Underscores become spaces first. Personio tenants commonly name offices
  // with a country-prefixed code — "IN_Bangalore", "IN_Noida", "DE_Muenchen" —
  // and `_` is a word character, so `\bbangalore` in config.ts's INDIA regex
  // never matches "IN_Bangalore". Real India boards were being dropped by a
  // word boundary. Normalising here rather than loosening that regex keeps the
  // fix on the platform that has the quirk.
  const unique = [...new Set(offices.map((office) => office.replace(/_/g, ' ').trim()).filter(Boolean))];
  if (unique.length === 0) return '';
  return unique.every((office) => REMOTE_ONLY.test(office)) ? '' : unique.join(' / ');
}

/**
 * Nested blocks are stripped before scalar fields are read, rather than
 * relying on the first `<name>`/`<office>` in document order being the
 * position's own. `<jobDescriptions>` contains its own `<name>` per section
 * and `<additionalOffices>` its own `<office>`, so a future reordering of the
 * feed would otherwise silently start reporting a description heading as the
 * job title.
 */
export function parsePositions(xml: string, token: string): RawJob[] {
  const jobs: RawJob[] = [];

  for (const block of xml.match(/<position>[\s\S]*?<\/position>/g) ?? []) {
    const descriptions = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(block)?.[1] ?? '';
    const additional = /<additionalOffices>([\s\S]*?)<\/additionalOffices>/.exec(block)?.[1] ?? '';
    const scalars = block.replace(descriptions, '').replace(additional, '');

    const id = tag(scalars, 'id');
    const title = tag(scalars, 'name');
    if (!id || !title) continue;

    const offices = [
      tag(scalars, 'office'),
      ...(additional.match(/<office>[\s\S]*?<\/office>/g) ?? []).map((o) => tag(o, 'office')),
    ].filter((o): o is string => Boolean(o));

    jobs.push({
      externalId: id,
      title,
      location: place(offices),
      url: `https://${token}.jobs.personio.de/job/${id}`,
      postedAt: safeIso(tag(scalars, 'createdAt')),
      text: descriptions ? toPlainText(descriptions) || undefined : undefined,
    });
  }

  return jobs;
}

export async function list(company: Company): Promise<RawJob[]> {
  const url = `https://${company.token}.jobs.personio.de/xml`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/xml, text/xml' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);

  const xml = await res.text();
  if (!xml.includes('<workzag-jobs')) throw new Error(`not a Personio feed: ${url}`);

  return parsePositions(xml, company.token);
}
