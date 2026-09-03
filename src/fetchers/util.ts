import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BlockError, classifyFailure, classifyOkBody, headOf } from './block.js';

const run = promisify(execFile);

/** Identify the bot honestly. Boards are far more tolerant of a named client. */
export const UA =
  'jobscraper-next/1.0 (personal job alert bot; +https://github.com/topics/job-scraper)';

/** A real browser's UA, for the curl-impersonation path below — the opposite
 * choice from `UA` above, deliberately: this path exists specifically to
 * pass as a real browser, not to self-identify as a bot. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Shells out to system `curl` instead of Node's `fetch`, for the rare board
 * behind Cloudflare-grade bot detection that fingerprints the TLS/HTTP2
 * handshake itself, not just headers — Node's OpenSSL-based fetch gets
 * rejected outright regardless of what headers you send, while curl's
 * handshake (via the system's own TLS library) passes. `curl` is
 * preinstalled on GitHub's runners, no new dependency.
 *
 * First proven necessary for Darwinbox, generalized here so a second
 * adapter hitting the same wall doesn't have to re-derive this from
 * scratch. If a future board's Cloudflare deployment gets strict enough
 * that even plain curl starts failing, the documented next step is
 * `curl-impersonate` (a curl build patched to match a specific browser's
 * *exact* TLS fingerprint, not just its headers) — not built speculatively
 * here, since no currently-tracked board has needed it.
 */
export async function curlJson<T>(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body } = options;
  const args = ['-s', '--max-time', '30'];
  if (method === 'POST') args.push('-X', 'POST');
  for (const [key, value] of Object.entries({ 'User-Agent': BROWSER_UA, ...headers })) {
    args.push('-H', `${key}: ${value}`);
  }
  if (body !== undefined) args.push('-d', body);
  args.push(url);

  const { stdout } = await run('curl', args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

const RETRY_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries 429/503 with backoff, honouring `Retry-After` when the host sends it.
 *
 * Worth doing rather than letting the board fail: a 429 is not a broken board,
 * but `recordFailure` cannot tell the difference, so a burst of them starts the
 * DROP_AFTER_FAILING_DAYS clock on perfectly healthy companies. Whole Workday
 * pods were being rate-limited at once, so this would have quietly evicted them
 * three days later.
 */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'user-agent': UA, accept: 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // A thrown fetch (socket reset, DNS blip, timeout) is not classifiable by
      // status code but is exactly as transient as a 503 — retry it the same
      // way instead of failing the whole run on one flaky connection.
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_ATTEMPTS - 1) throw lastError;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    // The body is read once and kept as text so a failure can be classified
    // before parsing — a Cloudflare challenge served with a 200 status would
    // otherwise surface as an opaque SyntaxError indistinguishable from our
    // own parsing bugs.
    const text = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        const verdict = classifyOkBody(headOf(text));
        if (verdict) throw new BlockError(verdict, res.status, url);
        throw new Error(`unparseable 200 body for ${url}: ${text.slice(0, 120)}`);
      }
    }

    const verdict = classifyFailure(res.status, headOf(text));
    lastError = verdict ? new BlockError(verdict, res.status, url) : new Error(`${res.status} ${res.statusText} for ${url}`);
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS - 1) throw lastError;

    // `Retry-After` is seconds; cap it so one unlucky board can't stall the run.
    const after = Number(res.headers.get('retry-after'));
    const backoff = Number.isFinite(after) && after > 0
      ? Math.min(after * 1000, 15_000)
      : 1000 * 2 ** attempt;
    await sleep(backoff);
  }

  throw lastError ?? new Error(`failed for ${url}`);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** ATS descriptions arrive as escaped HTML. We only need plain text for regex. */
export function toPlainText(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Runs tasks grouped by rate-limit domain, each group with its own cap, all
 * groups in parallel.
 *
 * A single global cap is the wrong shape for this workload. 981 of 1,394 boards
 * are Greenhouse and share one API host, and 93 Workday boards share the wd5
 * pod — so a global cap of 9 could still land 9 simultaneous requests on wd5
 * and get every one of them 429'd, which is exactly what happened. Capping
 * per-host instead lets total throughput go *up* (many hosts at once) while
 * each individual host sees less pressure than before.
 */
export async function mapLimitByKey<T, R>(
  items: readonly T[],
  keyOf: (item: T) => string,
  limitFor: (key: string) => number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const buckets = new Map<string, { item: T; index: number }[]>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ item, index });
    else buckets.set(key, [{ item, index }]);
  });

  const results: R[] = new Array(items.length);
  await Promise.all(
    [...buckets.entries()].map(([key, entries]) =>
      mapLimit(entries, limitFor(key), async ({ item, index }) => {
        results[index] = await fn(item);
      }),
    ),
  );
  return results;
}

/** Run tasks with bounded concurrency so we never open 60 sockets at once. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
