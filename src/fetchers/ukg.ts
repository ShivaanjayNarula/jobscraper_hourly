import type { Company, RawJob } from '../types.js';
import { getJson, safeIso, toPlainText } from './util.js';

/**
 * UKG Pro Recruiting (formerly UltiPro).
 *
 *   token -> the tenant code in the board path, e.g. "AIS1000AISI"
 *   site  -> the job board's GUID, e.g. "b22b728d-47a6-4550-9005-01c83b9a527f"
 *
 * Both halves are required and neither is guessable — a tenant code alone gets
 * a 404, which is exactly why an earlier blind probe of this platform failed
 * and it was written off as unreachable. The published tenant list that
 * `bulk-import.ts` already reads carries the full board URL with both, so the
 * wall was never the endpoint; it was not having the GUID.
 *
 * The endpoint is a POST with a JSON body and returns real JSON. `Top`/`Skip`
 * page it, and `totalCount` on the first response bounds the walk.
 */
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

interface UkgAddress {
  City?: string;
  State?: { Name?: string };
  Country?: { Name?: string };
}

interface UkgLocation {
  LocalizedName?: string;
  Address?: UkgAddress;
}

interface UkgOpportunity {
  Id?: string;
  Title?: string;
  RequisitionNumber?: string;
  Locations?: UkgLocation[];
  PostedDate?: string;
  BriefDescription?: string;
}

/**
 * Location comes from `Address`, never from `LocalizedName`.
 *
 * `LocalizedName` is the employer's internal site label — "NM - KAFB",
 * "AL - USAG Redstone" — which carries no city or country and would make every
 * posting invisible to `filter.ts`'s India/remote gate. The address block is
 * the only field with a real place name in it.
 */
export function place(locations: UkgLocation[] | undefined): string {
  const names = (locations ?? [])
    .map((location) => {
      const address = location.Address;
      return [address?.City, address?.State?.Name, address?.Country?.Name].filter(Boolean).join(', ');
    })
    .filter(Boolean);
  return [...new Set(names)].join(' / ');
}

function boardUrl(company: Company): string {
  return `https://recruiting.ultipro.com/${company.token}/JobBoard/${company.site}`;
}

export async function list(company: Company): Promise<RawJob[]> {
  if (!company.site) throw new Error(`ukg:${company.token} has no JobBoard GUID`);

  const jobs: RawJob[] = [];
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson<{ opportunities?: UkgOpportunity[]; totalCount?: number }>(
      `${boardUrl(company)}/JobBoardView/LoadSearchResults`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ opportunitySearch: { Top: PAGE_SIZE, Skip: page * PAGE_SIZE } }),
      },
    );

    const batch = body.opportunities ?? [];
    if (page === 0) total = body.totalCount ?? 0;
    if (batch.length === 0) break;

    for (const opportunity of batch) {
      const id = opportunity.Id ?? opportunity.RequisitionNumber;
      if (!id || !opportunity.Title) continue;
      jobs.push({
        externalId: id,
        title: opportunity.Title,
        location: place(opportunity.Locations),
        url: `${boardUrl(company)}/OpportunityDetail?opportunityId=${id}`,
        postedAt: safeIso(opportunity.PostedDate),
        text: opportunity.BriefDescription ? toPlainText(opportunity.BriefDescription) : undefined,
      });
    }

    if (batch.length < PAGE_SIZE) break;
    if (total > 0 && (page + 1) * PAGE_SIZE >= total) break;
  }

  return jobs;
}
