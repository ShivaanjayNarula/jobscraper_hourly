import type { Company, RawJob } from '../types.js';
import { getJson, safeIso } from './util.js';

/**
 * Breezy HR — a small/mid-market ATS.
 *
 *   token -> the board subdomain, e.g. "acme" for acme.breezy.hr
 *
 * `/json` returns every published position in one unpaginated call, with no
 * credential. A subdomain with no board returns Breezy's own 404 page rather
 * than an empty array, so a dead tenant fails loudly and stays evictable
 * instead of looking like a live board with nothing open.
 *
 * The list payload carries no description, and the per-position detail route
 * (`/json/{id}`) redirects to the board root rather than serving one — so
 * there is no cheap enrichment path and `text` is left undefined. That is
 * safe rather than lossy: filter.ts keeps a posting whose years-of-experience
 * cannot be read, so a missing description costs recall on the years gate,
 * never a false exclusion.
 */
interface BzPlace {
  city?: string;
  state?: { name?: string };
  country?: { name?: string };
  is_remote?: boolean;
  name?: string;
}

interface BzPosition {
  id?: string;
  friendly_id?: string;
  /** The job title. Breezy names this `name`, not `title` — the one real trap in this payload. */
  name?: string;
  url?: string;
  published_date?: string;
  salary?: string;
  location?: BzPlace;
  locations?: BzPlace[];
}

function label(place: BzPlace): string {
  if (place.name) return place.is_remote ? `${place.name}, Remote` : place.name;
  const parts = [place.city, place.state?.name, place.country?.name].filter(Boolean);
  if (place.is_remote) parts.push('Remote');
  return parts.join(', ');
}

/** `locations` is the multi-office form; `location` is the single-office one. */
export function place(position: BzPosition): string {
  const places = position.locations?.length ? position.locations : position.location ? [position.location] : [];
  return [...new Set(places.map(label).filter(Boolean))].join(' / ');
}

export async function list(company: Company): Promise<RawJob[]> {
  const positions = await getJson<BzPosition[]>(`https://${company.token}.breezy.hr/json`);
  const jobs: RawJob[] = [];

  for (const position of positions ?? []) {
    const id = position.id ?? position.friendly_id;
    if (!id || !position.name) continue;
    jobs.push({
      externalId: id,
      title: position.name,
      location: place(position),
      url: position.url ?? `https://${company.token}.breezy.hr/p/${position.friendly_id ?? id}`,
      postedAt: safeIso(position.published_date),
      salary: position.salary || undefined,
    });
  }

  return jobs;
}
