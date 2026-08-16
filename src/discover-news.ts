import type { Candidate, Hit } from './board-probe.js';
import { probeSlug } from './board-probe.js';
import { mapLimit, UA } from './fetchers/util.js';
import { isServiceCompany } from './filter.js';
import { loadCompanies, saveCompanies } from './state.js';

/**
 * Harvests company names from Indian startup-funding and India-expansion
 * coverage, then probes them for a real board.
 *
 *   npm run discover-news
 *
 * The premise: a company that just raised a round, or just announced an India
 * centre, is about to start hiring — and is exactly the employer this tracker
 * would otherwise learn about months late, once it happened to appear in a
 * placement report or a Common Crawl index.
 *
 * Name extraction is deliberately GENEROUS rather than clever. Pulling a wrong
 * phrase out of a headline costs one failed HTTP probe and nothing else, while
 * being strict would miss companies whose headline phrasing wasn't anticipated.
 * The board probe is the real filter — same principle as the URL import: every
 * board is validated before it is kept, so a bad guess is free.
 */
const FEEDS = [
  'https://entrackr.com/rss',
  'https://inc42.com/feed/',
  'https://yourstory.com/feed',
  'https://techcrunch.com/feed/',
  'https://startupstorymedia.com/feed/',
  'https://www.livemint.com/rss/companies',
];

/** A round was raised, or money changed hands. */
const FUNDING =
  /\b(raises?|raised|raising|bags?|bagged|secures?|secured|nets?|netted|funding|fundraise|seed round|pre[- ]seed|series\s+[a-j]\b|valuation|invests?\s+in|backed)\b/i;

/** A company is standing up an India presence. */
const INDIA_EXPANSION =
  /\b(gcc|global capability cent(?:re|er)|global capacity cent(?:re|er)|india cent(?:re|er)|development cent(?:re|er)|expands? (?:in)?to india|enters india|sets? up .{0,30}\bindia\b|opens? .{0,30}\bindia\b|india (?:office|expansion|operations|hiring|team)|hiring in india)\b/i;

/**
 * Words that start a headline but are never the company. Without this the
 * probe wastes most of its budget on "Exclusive", "Report", weekday names and
 * the like — all of which are legitimately capitalised at the front of a
 * headline.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'his', 'her', 'their',
  'exclusive', 'report', 'breaking', 'update', 'opinion', 'analysis', 'interview', 'watch',
  'how', 'why', 'what', 'when', 'where', 'who', 'can', 'will', 'is', 'are', 'was', 'were',
  'new', 'top', 'best', 'first', 'last', 'next', 'more', 'most', 'after', 'before', 'from',
  'india', 'indian', 'indias', 'us', 'usa', 'uk', 'china', 'europe', 'asia', 'global',
  'startup', 'startups', 'unicorn', 'fintech', 'edtech', 'ipo', 'sebi', 'rbi', 'gst',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'ai', 'saas', 'b2b', 'd2c', 'ev', 'evs', 'crypto', 'web3', 'funding', 'revenue', 'profit',
  'loss', 'q1', 'q2', 'q3', 'q4', 'fy24', 'fy25', 'fy26', 'yoy', 'cr', 'mn', 'bn',
]);

/**
 * Investors, not employers. Funding headlines name the VC at least as often as
 * the company ("X raises $40 Mn led by Accel"), and on the first live run the
 * only boards this found were Lightspeed's and a "Stealth" placeholder — i.e.
 * the extractor was reliably picking the wrong half of the sentence.
 */
const INVESTORS = new Set([
  'accel', 'sequoia', 'peak xv', 'blume', 'elevation', 'tiger global', 'softbank',
  'lightspeed', 'nexus', 'matrix', 'kalaari', 'chiratae', 'stellaris', 'bessemer',
  'general catalyst', 'insight partners', 'y combinator', 'antler', 'titan capital',
  'info edge', 'fireside', 'westbridge', 'avataar', 'iron pillar', 'trifecta',
  'alteria', 'beenext', 'jungle ventures', 'vertex', 'temasek', 'khosla',
  'andreessen', 'a16z', 'lightbox', 'omidyar', 'prosus', 'naspers', 'stealth',
]);

/** Investor houses share these suffixes; hiring companies rarely do. */
const INVESTOR_SUFFIX = /\b(ventures?|capital|partners|fund|funds|holdings|\bvc\b|advisors)$/i;

async function fetchFeed(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&#39;|&rsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
}

function headlines(xml: string): string[] {
  return (xml.match(/<title>[\s\S]*?<\/title>/g) ?? [])
    .map((t) => decode(t.replace(/<\/?title>/g, '')))
    .filter((t) => t.length > 15 && t.length < 200);
}

/**
 * Pulls capitalised phrases that could be a company name. Headlines write them
 * as "Zypp Electric", "NewTap Finance", "Zetwerk" — so 1-3 capitalised tokens,
 * with possessives and leading qualifiers stripped.
 */
function extractNames(headline: string): string[] {
  const cleaned = headline.replace(/[’']s\b/g, '').replace(/[“”"‘’]/g, '');
  const names: string[] = [];

  for (const m of cleaned.matchAll(/\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,2})\b/g)) {
    const phrase = m[1]!.trim();
    const words = phrase.split(/\s+/);
    // Trim trailing stopwords ("Zetwerk Revenue" -> "Zetwerk").
    while (words.length && STOPWORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
    while (words.length && STOPWORDS.has(words[0]!.toLowerCase())) words.shift();
    if (words.length === 0) continue;
    const name = words.join(' ');
    if (name.length < 3 || name.length > 40) continue;
    if (words.every((w) => w.length <= 2)) continue;
    if (INVESTORS.has(name.toLowerCase()) || INVESTOR_SUFFIX.test(name)) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

async function main(): Promise<void> {
  const existing = await loadCompanies();
  const known = new Set(existing.map((c) => `${c.ats}:${c.token.toLowerCase()}`));
  const knownNames = new Set(existing.map((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '')));

  const feeds = await mapLimit(FEEDS, 6, fetchFeed);
  const live = feeds.filter(Boolean).length;

  const relevant: string[] = [];
  for (const xml of feeds) {
    for (const title of headlines(xml)) {
      if (FUNDING.test(title) || INDIA_EXPANSION.test(title)) relevant.push(title);
    }
  }
  console.log(`${live}/${FEEDS.length} feeds reachable, ${relevant.length} funding/expansion headlines`);

  const candidates = new Map<string, Candidate>();
  for (const title of relevant) {
    for (const name of extractNames(title)) {
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || knownNames.has(key) || candidates.has(key)) continue;
      candidates.set(key, { slug: name, name, industry: 'tech' });
    }
  }
  console.log(`${candidates.size} candidate names not already tracked`);
  if (candidates.size === 0) return;

  const hits = (await mapLimit([...candidates.values()], 10, (c) => probeSlug(c, known))).filter(
    (hit): hit is Hit => hit !== null && !isServiceCompany(hit.company.name),
  );

  // Same bar as `npm run probe`: a live board with no India or remote role is
  // not worth an hourly request.
  const keep = hits.filter((hit) => hit.relevant > 0);
  for (const hit of hits) {
    console.log(
      `  ${keep.includes(hit) ? '+' : '-'} ${hit.company.name.padEnd(24)} ${hit.company.ats.padEnd(10)} ${String(hit.total).padStart(4)} jobs, ${hit.relevant} India/remote`,
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
