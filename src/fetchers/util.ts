/** Identify the bot honestly. Boards are far more tolerant of a named client. */
export const UA =
  'jobscraper-next/1.0 (personal job alert bot; +https://github.com/topics/job-scraper)';

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
    const res = await fetch(url, {
      ...init,
      headers: { 'user-agent': UA, accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) return (await res.json()) as T;

    lastError = new Error(`${res.status} ${res.statusText} for ${url}`);
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
