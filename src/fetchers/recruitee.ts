import type { Company, RawJob } from '../types.js';
import { getJson, toPlainText } from './util.js';

interface RtOffer {
  id: number;
  title: string;
  slug?: string;
  location?: string | null;
  city?: string | null;
  country?: string | null;
  remote?: boolean;
  careers_url?: string;
  published_at?: string | null;
  created_at?: string | null;
  description?: string | null;
  requirements?: string | null;
}

function place(o: RtOffer): string {
  if (o.location) return o.location;
  const parts = [o.city, o.country].filter(Boolean);
  if (o.remote) parts.push('Remote');
  return parts.join(', ');
}

/**
 * Recruitee dates look like "2026-08-19 13:16:05 UTC" — not standard ISO, just
 * close enough that `new Date()` happens to parse it. Guarded anyway rather
 * than trusted, same rule as every other ATS's date field: an out-of-range or
 * malformed value must fail closed, not throw and evict the board.
 */
export function toIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * One unpaginated call returns every published offer, full description
 * included — same shape as Ashby, nothing to enrich separately.
 */
export async function list(company: Company): Promise<RawJob[]> {
  const data = await getJson<{ offers?: RtOffer[] }>(
    `https://${company.token}.recruitee.com/api/offers/`,
  );
  return (data.offers ?? []).map((o) => ({
    externalId: String(o.id),
    title: o.title,
    location: place(o),
    url: o.careers_url ?? `https://${company.token}.recruitee.com/o/${o.slug ?? o.id}`,
    postedAt: toIso(o.published_at ?? o.created_at),
    text: toPlainText([o.description, o.requirements].filter(Boolean).join(' ')),
  }));
}
