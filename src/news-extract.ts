/**
 * Pure headline-parsing logic for discover-news.ts, split into its own module
 * so selftest.ts can import it without triggering discover-news.ts's `main()`
 * (same reasoning as the probe.ts/board-probe.ts split: importing a script
 * that runs `main()` at module scope would execute the CLI as a side effect).
 */

/** A round was raised, or money changed hands. */
export const FUNDING =
  /\b(raises?|raised|raising|bags?|bagged|secures?|secured|nets?|netted|funding|fundraise|seed round|pre[- ]seed|series\s+[a-j]\b|valuation|invests?\s+(?:(?!\bin\b)\S+\s+){0,3}in\b|backed)\b/i;

/** A company is standing up an India presence. */
export const INDIA_EXPANSION =
  /\b(gcc|global capability cent(?:re|er)|global capacity cent(?:re|er)|india cent(?:re|er)|development cent(?:re|er)|expands? (?:in)?to india|enters india|sets? up .{0,30}\bindia\b|opens? .{0,30}\bindia\b|india (?:office|expansion|operations|hiring|team)|hiring in india)\b/i;

/**
 * Words that start a headline but are never the company. Without this the
 * probe wastes most of its budget on "Exclusive", "Report", weekday names and
 * the like — all of which are legitimately capitalised at the front of a
 * headline.
 *
 * Also covers two noise sources found by auditing live feed output: (1) the
 * FUNDING trigger verbs themselves ("Backed", "Nets", "Raised") get
 * capitalised in title-case headlines and leak through as their own fake
 * candidate; (2) common function words ("And", "To", "For") do the same in
 * fully title-cased headlines (YourStory's roundup-style titles in
 * particular), producing garbage multi-word slices like "Yulu To" or
 * "Investors And".
 */
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'his', 'her', 'their',
  'exclusive', 'report', 'breaking', 'update', 'opinion', 'analysis', 'interview', 'watch',
  'how', 'why', 'what', 'when', 'where', 'who', 'can', 'will', 'is', 'are', 'was', 'were',
  'new', 'top', 'best', 'first', 'last', 'next', 'more', 'most', 'after', 'before', 'from',
  'india', 'indian', 'indias', 'us', 'usa', 'uk', 'china', 'europe', 'asia', 'global',
  'startup', 'startups', 'unicorn', 'fintech', 'edtech', 'ipo', 'sebi', 'rbi', 'gst',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'ai', 'saas', 'b2b', 'd2c', 'ev', 'evs', 'crypto', 'web3', 'funding', 'revenue', 'profit',
  'loss', 'yoy', 'cr', 'mn', 'bn',
  // Funding-verb leakage in title-case headlines.
  'series', 'backed', 'nets', 'netted', 'raised', 'raises', 'raising',
  // Generic lead-in nouns that precede the real name ("D2C Brand Scrubsy").
  'brand', 'week', 'weekly', 'tracker',
  // Function words, only ever capitalised by a title-case headline.
  'and', 'or', 'to', 'for', 'with', 'by', 'in', 'at', 'of', 'on', 'as', 'into', 'over', 'via', 'per', 'than',
]);

/**
 * Words that only ever appear as junk at the END of a capitalised phrase —
 * verbs and generic nouns that trail the real name ("Khartis Therapeutics
 * Emerges", "Expand Home Cleaning Offerings", "Profit More Than Doubles").
 * They are trimmed like stopwords but must never lead-trim, because each one
 * can also be the first word of a real company ("Expand" -> "Expand"), so
 * putting them in STOPWORDS would eat multi-word names.
 */
export const TRAILING_ONLY = new Set([
  'emerges', 'doubles', 'expand', 'offerings', 'cleaning',
]);

/**
 * Words that are only junk when they stand ALONE as a single-word candidate.
 * "Deep-tech startup Quarkitech" yields a stray capitalised "Deep"; "Seven
 * cos", "$95 Million", ": WSJ", "files UDRHP" and "led by 12 Flags" each
 * leave one capitalised orphan. But every one of these is also a plausible
 * first word of a real company ("Deep Industries", "Seven Seas", "Home
 * Depot", "Cleaning Solutions"), so they must not lead-trim multi-word
 * names — only suppress a candidate that is exactly that one word.
 *
 * Month names belong here, not in STOPWORDS: a bare "In August, X raised..."
 * needs "August" filtered as its own stray candidate, but STOPWORDS' leading
 * trim ran unconditionally and was eating the front of any real company that
 * starts with a month name — "August Health raises $10 Mn" extracted as just
 * "Health", "May Mobility raises..." as just "Mobility", both real company
 * names, both a stray-orphan-generic-word collision waiting to happen (the
 * same class as the "LEAP" incident this file already documents).
 */
export const LONE_ONLY = new Set([
  'home', 'deep', 'every', 'seven', 'investors', 'tribunal', 'million', 'billion',
  'wsj', 'drhp', 'udrhp', 'rhp', 'ofs', 'esop', 'flags', 'trump',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);


/**
 * Investors, not employers. Funding headlines name the VC at least as often as
 * the company ("X raises $40 Mn led by Accel"), and on the first live run the
 * only boards this found were Lightspeed's and a "Stealth" placeholder — i.e.
 * the extractor was reliably picking the wrong half of the sentence.
 */
export const INVESTORS = new Set([
  'accel', 'sequoia', 'peak xv', 'blume', 'elevation', 'tiger global', 'softbank',
  'lightspeed', 'nexus', 'matrix', 'kalaari', 'chiratae', 'stellaris', 'bessemer',
  'general catalyst', 'insight partners', 'y combinator', 'antler', 'titan capital',
  'info edge', 'fireside', 'westbridge', 'avataar', 'iron pillar', 'trifecta',
  'alteria', 'beenext', 'jungle ventures', 'vertex', 'temasek', 'khosla',
  'andreessen', 'a16z', 'lightbox', 'omidyar', 'prosus', 'naspers', 'stealth', 'kkr',
  // "led by 12 Flags" — the numeral breaks the capitalized-token regex, so the
  // VC surfaces as "Flags" (already a stopword) rather than under this name,
  // but keep the full name filtered for when the numeral is spelled out.
  '12 flags',
]);

/** Investor houses share these suffixes; hiring companies rarely do. */
export const INVESTOR_SUFFIX = /\b(ventures?|capital|partners|fund|funds|holdings|\bvc\b|advisors)$/i;

/** Fiscal-year and quarter/half tokens ("FY27", "Q1", "H2") — dated by nature, so matched by shape rather than a literal list that goes stale every year. */
function isDatedToken(word: string): boolean {
  return /^fy\d{2}$/i.test(word) || /^q[1-4]$/i.test(word) || /^h[12]$/i.test(word);
}

function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase()) || isDatedToken(word);
}

/** Junk only when it trails a longer phrase ("Khartis Therapeutics Emerges"). */
function isTrailingOnly(word: string): boolean {
  return TRAILING_ONLY.has(word.toLowerCase());
}

/** Junk only when it is the whole candidate ("Deep-tech startup" -> "Deep"). */
function isLoneOnly(word: string): boolean {
  return LONE_ONLY.has(word.toLowerCase());
}

export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&#39;|&rsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
}

export interface HeadlineItem {
  title: string;
  /** The article's own URL — empty if this item's <link> was missing or empty. */
  link: string;
}

/**
 * Extracts each RSS <item>'s title and link together, so a discovered
 * candidate name can be traced back to the specific article it came from.
 * (An earlier version, `headlines()`, returned bare titles with no link;
 * replaced outright rather than kept alongside once nothing else called it —
 * the digest this feeds was unverifiable without the source, which is
 * exactly the complaint that prompted this.)
 */
export function headlineItems(xml: string): HeadlineItem[] {
  const items: HeadlineItem[] = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/g) ?? []) {
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
    if (!titleMatch) continue;
    const title = decode(titleMatch[1]!);
    if (title.length <= 15 || title.length >= 200) continue;
    const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
    items.push({ title, link: linkMatch ? decode(linkMatch[1]!) : '' });
  }
  return items;
}

/**
 * Pulls capitalised phrases that could be a company name. Headlines write them
 * as "Zypp Electric", "NewTap Finance", "Zetwerk" — so 1-3 capitalised tokens,
 * with possessives and leading qualifiers stripped.
 */
export function extractNames(headline: string): string[] {
  const cleaned = headline.replace(/[’']s\b/g, '').replace(/[“”"‘’]/g, '');
  const names: string[] = [];

  // Capture up to FOUR capitalized words, not three: "SMBC Asia Rising Fund"
  // used to be truncated to "SMBC Asia Rising" before INVESTOR_SUFFIX ran, so
  // the trailing "Fund" never matched and the investor leaked through as a
  // candidate (live audit find). Check the investor pattern against the full
  // phrase first, then truncate the survivor back to three words.
  for (const m of cleaned.matchAll(/\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,3})\b/g)) {
    const phrase = m[1]!.trim();
    const words = phrase.split(/\s+/);
    // Trim trailing stopwords ("Zetwerk Revenue" -> "Zetwerk"). Trailing-only
    // words join this pass — a verb or generic noun attached after the name
    // ("Emerges") is never part of it, but the same word can lead a real
    // company name, so it must not be trimmed from the front.
    while (words.length && (isStopword(words[words.length - 1]!) || isTrailingOnly(words[words.length - 1]!))) {
      words.pop();
    }
    while (words.length && isStopword(words[0]!)) words.shift();
    if (words.length === 0) continue;
    const full = words.join(' ');
    if (INVESTORS.has(full.toLowerCase()) || INVESTOR_SUFFIX.test(full)) continue;
    const name = words.slice(0, 3).join(' ');
    if (name.length < 3 || name.length > 40) continue;
    if (name.split(/\s+/).every((w) => w.length <= 2)) continue;
    // If every remaining word is junk-class, the candidate itself is junk.
    // This catches the orphan of a longer phrase ("Deep-tech startup
    // Quarkitech" -> "Deep") AND the split case where the trailing trim
    // stops on a lone-only word ("Expand Home Cleaning Offerings" ->
    // "Expand Home": all four words are junk-class, just split across
    // STOPWORDS/TRAILING_ONLY/LONE_ONLY). Real multi-word names survive
    // because they contain at least one non-junk word ("Deep Industries",
    // "Seven Seas", "Cleaning Solutions", "Home Depot").
    const isJunkClass = (w: string) =>
      isStopword(w) || isTrailingOnly(w) || isLoneOnly(w);
    if (name.split(/\s+/).every(isJunkClass)) continue;
    names.push(name);
  }
  return [...new Set(names)];
}
