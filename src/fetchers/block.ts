/**
 * Per-response bot-wall classification.
 *
 * A failed poll currently carries no information about *why* it failed, and
 * "why" is the difference between a dead board (evict after 3 days) and a
 * healthy board behind a bot wall that will pass again from another network
 * (never evict — see the Darwinbox mass-eviction in HANDOFF.md). The platform
 * ratio detector in `outage.ts` catches the mass case; this classifies each
 * individual response so even a single blocked board on an otherwise-healthy
 * ATS is recognized for what it is.
 *
 * Signals and structure are ported from fastCRW's antibot classifier
 * (github.com/us/crw, `crates/crw-extract/src/antibot.rs`), reduced to what
 * this project's JSON-first fetchers can actually encounter. Two deliberate
 * divergences: markers are plain substrings rather than regexes where possible
 * (this repo has shipped the `\b`-in-a-string-literal bug three times), and a
 * 4xx whose body looks like the API's own JSON is NOT a wall — that is the ATS
 * refusing that specific request, which is real evidence the board config is
 * stale and should keep its eviction clock.
 */

/** What a non-success response means for the eviction decision downstream. */
export type BlockKind = 'rate_limited' | 'challenge' | 'waf_block' | 'structural';

export interface BlockVerdict {
  kind: BlockKind;
  /** Best-guess vendor ("cloudflare", "datadome", ...) or "generic". */
  vendor: string;
}

/**
 * Cloudflare's modern Turnstile interstitials arrive as HTTP 200 with a large
 * HTML body — status-code checks alone cannot see them. These markers are
 * case-sensitive on purpose: they are code identifiers, and case-insensitive
 * matching would only widen the false-positive surface.
 */
const CF_STRONG_MARKERS = [
  '_cf_chl_opt',
  '__cf_chl_f_tk',
  '__cf_chl_managed_tk__',
  'cf-challenge-running',
  'cf-browser-verification',
  '/cdn-cgi/challenge-platform/',
];

/** Akamai's block page carries a structured reference id (#<num>.<hex>.<num>.<hex>). */
const AKAMAI_REFERENCE = /Reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i;

/** A body starting with these is the API's own JSON speaking, not a wall page. */
const looksLikeJson = (head: string): boolean => {
  const t = head.trimStart();
  return t.startsWith('{') || t.startsWith('[');
};

/** One distinctive substring per vendor WAF page, scanned in first-seen order. */
const VENDOR_MARKERS: [vendor: string, needles: string[]][] = [
  ['cloudflare', ['<span class="cf-error-code">', 'Attention Required! | Cloudflare', 'Pardon Our Interruption']],
  ['datadome', ['captcha-delivery.com']],
  ['perimeterx', ['window._pxAppId', 'captcha.px-cdn.net', 'Access to This Page Has Been Blocked']],
  ['imperva', ['_Incapsula_Resource', 'Incapsula incident ID']],
  ['sucuri', ['Sucuri WebSite Firewall']],
  ['kasada', ['KPSDK.scriptStart']],
  [
    'generic',
    [
      '<title>Just a moment',
      'Checking your browser',
      'class="g-recaptcha"',
      'class="h-captcha"',
      'blocked by security',
    ],
  ],
];

/**
 * Vercel's checkpoint prose can appear inside an ordinary article ABOUT being
 * blocked, so fastCRW requires both the product name and the verifying phrase
 * before calling it — same pair rule here.
 */
const VERCEL_CHECKPOINT = /Vercel Security Checkpoint/;
const VERIFYING_PHRASE = /your browser/;

/** Only the head of a large body is worth scanning; walls are small pages. */
export const HEAD_SCAN_BYTES = 15_000;

/** A challenge/block page trimmed below this size is just an empty refusal. */
const NEAR_EMPTY_BYTES = 100;

function scanMarkers(head: string): BlockVerdict | undefined {
  if (VERCEL_CHECKPOINT.test(head) && VERIFYING_PHRASE.test(head)) {
    return { kind: 'challenge', vendor: 'vercel' };
  }
  if (AKAMAI_REFERENCE.test(head)) return { kind: 'challenge', vendor: 'akamai' };
  for (const marker of CF_STRONG_MARKERS) {
    if (head.includes(marker)) return { kind: 'challenge', vendor: 'cloudflare' };
  }
  for (const [vendor, needles] of VENDOR_MARKERS) {
    for (const needle of needles) {
      if (head.includes(needle)) return { kind: 'challenge', vendor };
    }
  }
  return undefined;
}

/**
 * Classify a non-2xx response. `undefined` means "no evidence of a bot wall" —
 * a plain 404 or a JSON-shaped 403 is the API speaking, and the eviction clock
 * should run normally.
 */
export function classifyFailure(status: number, head: string): BlockVerdict | undefined {
  if (status === 429) return { kind: 'rate_limited', vendor: 'generic' };
  // Cloudflare's own error codes: 52x are origin-side failures behind CF,
  // 530 carries a CF-firewall code. Either way the board did not die.
  if ((status >= 520 && status <= 527) || status === 530) {
    return { kind: 'waf_block', vendor: 'cloudflare' };
  }

  const marked = scanMarkers(head);
  if (marked) return marked;

  // The API's own JSON refusal — however small — is the board config being
  // stale, which is exactly what the eviction clock exists to catch.
  if (looksLikeJson(head)) return undefined;

  const trimmed = head.trim();
  if (trimmed.length < NEAR_EMPTY_BYTES && status >= 400) {
    return { kind: 'waf_block', vendor: 'near-empty' };
  }
  // An HTML refusal with none of the known fingerprints is still a refusal
  // aimed at browsers, not the API answering.
  if (trimmed.startsWith('<') && status >= 400) {
    return { kind: 'waf_block', vendor: 'html' };
  }
  return undefined;
}

/**
 * Classify a 2xx body that failed to parse as JSON — where a challenge served
 * with a 200 status (or an empty shell) hides. `undefined` means the body was
 * plausibly real data our parser choked on, i.e. a genuine bug worth surfacing
 * as a normal error, not a wall.
 */
export function classifyOkBody(head: string): BlockVerdict | undefined {
  const marked = scanMarkers(head);
  if (marked) return marked;
  // JSON-shaped but unparseable is a real bug in our parsing (or a schema
  // change) — surface it as an ordinary error rather than calling it a wall.
  if (looksLikeJson(head)) return undefined;
  const trimmed = head.trim();
  if (trimmed.length < NEAR_EMPTY_BYTES) return { kind: 'structural', vendor: 'empty' };
  if (trimmed.startsWith('<')) return { kind: 'structural', vendor: 'html' };
  return undefined;
}

/**
 * Thrown by `getJson` instead of a bare status string when the classifier
 * fires. The message keeps a `[kind]` tag so log lines and any path that only
 * sees the error text still carries the verdict.
 */
export class BlockError extends Error {
  readonly kind: BlockKind;
  readonly vendor: string;

  constructor(verdict: BlockVerdict, status: number, url: string) {
    super(`[${verdict.kind}] ${verdict.vendor} bot wall: ${status} for ${url}`);
    this.name = 'BlockError';
    this.kind = verdict.kind;
    this.vendor = verdict.vendor;
  }
}

export const headOf = (body: string): string => body.slice(0, HEAD_SCAN_BYTES);
