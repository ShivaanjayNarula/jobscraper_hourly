import { readFileSync } from 'node:fs';
import type { Industry } from './types.js';
import { mapLimit } from './fetchers/util.js';
import { isServiceCompany } from './filter.js';
import { loadCompanies, saveCompanies } from './state.js';
import { HOSTED, probeSlug, type Candidate, type Hit } from './board-probe.js';

/**
 * Bulk-probes candidate slugs against Greenhouse, Lever, Ashby and
 * SmartRecruiters. The probing itself lives in board-probe.ts, shared with
 * discover-news.ts.
 *
 *   npm run probe -- candidates.txt [--all]
 *
 * Lines are `slug` or `slug,industry`. By default only boards with at least one
 * India/remote role are kept; --all keeps every live board.
 */
function parseCandidates(path: string): Candidate[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]!.trim())
    .filter(Boolean)
    .map((line) => {
      const [slug, industry] = line.split(',').map((part) => part.trim());
      return { slug: slug!, industry: (industry as Industry) || 'tech' };
    });
}

async function main(): Promise<void> {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) throw new Error('usage: npm run probe -- candidates.txt [--all]');
  const keepAll = flags.includes('--all');

  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));
  const candidates = parseCandidates(path);

  console.log(`probing ${candidates.length} candidates across ${HOSTED.join(', ')}`);
  const hits = (await mapLimit(candidates, 12, (c) => probeSlug(c, known))).filter(
    (hit): hit is Hit => hit !== null && !isServiceCompany(hit.company.name),
  );

  const keep = hits.filter((hit) => keepAll || hit.relevant > 0);
  for (const hit of hits) {
    const mark = keep.includes(hit) ? '+' : '-';
    console.log(
      `  ${mark} ${hit.company.ats.padEnd(10)} ${hit.company.token.padEnd(22)} ${String(hit.total).padStart(4)} jobs, ${hit.relevant} India/remote`,
    );
  }

  console.log(`\n${hits.length} live boards, ${keep.length} with India/remote roles`);
  if (keep.length === 0) return;

  await saveCompanies([...existing, ...keep.map((hit) => hit.company)]);
  console.log(`companies.json: ${existing.length} -> ${existing.length + keep.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
