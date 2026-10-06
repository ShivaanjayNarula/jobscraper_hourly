import type { Page } from 'playwright';
import type { Company, RawJob } from '../types.js';
import { route } from './routing.js';
import { scraplingFetch, ScraplingError } from './scrapling.js';
import { BlockError, classifyFailure, headOf } from './block.js';
import { globalBrowserSemaphore } from './concurrency.js';

/**
 * Last-resort adapter for careers sites that expose no readable API at all.
 *
 * Google runs `boq-hiring`, an internal batchexecute RPC; Meta, Uber and
 * DocuSign are similarly closed. For these the only stable contract is the
 * rendered page, so this launches headless Chromium and reads the DOM.
 *
 * It is deliberately the exception, not the pattern:
 *
 *  - ~20x slower than a JSON call, and needs a 115 MB browser download.
 *  - Class names are obfuscated and rotate, so we anchor on the **job URL
 *    pattern** and take the title from the nearest heading. That survives a
 *    restyle; a `div.sMn82b` selector would not.
 *  - Acquisition failure is explicit so unavailable browsers cannot close
 *    existing catalogue jobs as if the board were empty.
 */
interface RenderedSite {
  url: string;
  /** Job links match this; everything else on the page is navigation. */
  linkPattern: RegExp;
  /** Wait for job links rather than unrelated navigation links. */
  waitSelector: string;
  /** Extra settle time after DOM readiness, for lists that stream in. */
  settleMs?: number;
  /** Query parameter for paging, if the site supports it. */
  pageParam?: string;
  /** How many pages to walk. Lists are date-sorted, so newest come first. */
  maxPages?: number;
  /**
   * True when `url` is already filtered to India, so a card that doesn't name a
   * city can still be assumed Indian. Must stay false for unfiltered listings —
   * otherwise every global role inherits "India" and sails through the filter.
   */
  indiaOnly?: boolean;
  /**
   * How many parent levels to climb when collecting the card's text. Uber's
   * anchor contains only the title — the location sits several levels up — so
   * the default (nearest `li`/parent) misses it entirely.
   */
  cardUp?: number;
}

export const SITES: Record<string, RenderedSite> = {
  google: {
    url: 'https://www.google.com/about/careers/applications/jobs/results?location=India&sort_by=date',
    linkPattern: /\/jobs\/results\/\d+/,
    waitSelector: 'a[href*="/jobs/results/"]',
    settleMs: 4000,
    pageParam: 'page',
    maxPages: 5,
    indiaOnly: true,
  },
  uber: {
    // Uber's own location filter values are opaque codes and every format I
    // tried returned zero results, so this pulls the unfiltered list and lets
    // the India/remote filter do the work — the card text carries the location.
    url: 'https://jobs.uber.com/en/jobs?page=1&pagesize=100',
    linkPattern: /\/en\/jobs\/\d+/,
    waitSelector: 'a[href*="/en/jobs/"]',
    settleMs: 5000,
    cardUp: 4,
    pageParam: 'page',
    maxPages: 4,
  },
  vanguard: {
    url: 'https://www.vanguardjobs.com/job-search-results/?country=India',
    linkPattern: /\/job\/\d+\//,
    waitSelector: 'a[href*="/job/"]',
    settleMs: 4500,
  },
  dazn: {
    // Custom platform (not Lever/Ashby despite the /postings/{uuid} shape).
    url: 'https://careers.dazn.com/en',
    linkPattern: /\/en\/postings\/[0-9a-f-]{20,}/,
    waitSelector: 'a[href*="/en/postings/"]',
    settleMs: 4500,
  },
  meta: {
    url: 'https://www.metacareers.com/jobs?offices[0]=Bangalore%2C%20India&offices[1]=Gurgaon%2C%20India&offices[2]=Hyderabad%2C%20India',
    linkPattern: /\/profile\/job_details\/\d+/,
    waitSelector: 'a[href*="/profile/job_details/"]',
    settleMs: 5000,
    indiaOnly: true,
  },
};

const INDIAN_PLACE =
  /(Bengaluru|Bangalore|Hyderabad|Mumbai|Pune|Chennai|Gurugram|Gurgaon|Noida|New Delhi|Delhi|Kolkata|Ahmedabad|Kochi|Coimbatore|Remote)[^.;|]{0,30}/i;

interface Row {
  href: string;
  title: string;
  text: string;
}

function scrape(page: Page, pattern: string, cardUp: number): Promise<Row[]> {
  return page.evaluate(({ source, cardUp }: { source: string; cardUp: number }) => {
    const re = new RegExp(source);
    const seen = new Set<string>();
    const rows: { href: string; title: string; text: string }[] = [];

    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (anchor as HTMLAnchorElement).href;
      if (!re.test(href) || seen.has(href)) continue;

      // The anchor's OWN text is the only per-job source we can trust. Meta
      // renders every card inside one shared container, so walking up to find a
      // heading gives all ten jobs the same title.
      const own = (anchor as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
      let card = (anchor.closest('li') ?? anchor.parentElement) as HTMLElement | null;
      for (let up = 0; up < cardUp && card?.parentElement; up++) {
        const links = new Set(Array.from(card.parentElement.querySelectorAll('a[href]'))
          .map(a => (a as HTMLAnchorElement).href).filter(href => re.test(href)));
        if (links.size > 1) break;
        card = card.parentElement;
      }
      const heading = card?.querySelector('h2,h3,h4')?.textContent?.trim() ?? '';
      const raw = own.length >= 6 ? own : heading;
      if (!raw || raw.length < 4) continue;

      // Titles arrive glued to the location: "ASIC EngineerBangalore, India⋅Hardware".
      const cut = raw.search(
        /(Bengaluru|Bangalore|Hyderabad|Mumbai|Pune|Chennai|Gurugram|Gurgaon|Noida|New Delhi|Kolkata|India|Remote|⋅|\+\d+ location)/i,
      );
      const title = (cut > 4 ? raw.slice(0, cut) : raw).replace(/[\s,·⋅-]+$/, '').trim();
      if (!title || title.length < 4) continue;

      seen.add(href);
      rows.push({
        href,
        title,
        text: `${own} ${card?.innerText ?? ''}`.replace(/\s+/g, ' ').slice(0, 1500),
      });
    }
    return rows;
  }, { source: pattern, cardUp });
}
export async function list(company: Company): Promise<RawJob[]> {
  const site = SITES[company.token];
  if (!site) throw new Error(`rendered: no site config for "${company.token}"`);
  const parseJobs = (collected: Map<string, Row>) => {
    return [...collected.values()].map((row) => {
      const cut = row.title.search(/(Bengaluru|Bangalore|Hyderabad|Mumbai|Pune|Chennai|Gurugram|Gurgaon|Noida|New Delhi|Kolkata|India|Remote|⋅|\+\d+ location)/i);
      const title = (cut > 4 ? row.title.slice(0, cut) : row.title).replace(/[\s,·⋅-]+$/, '').trim();
      return {
        externalId: row.href.match(/(\d{6,})/)?.[1] ?? row.href,
        title,
        location:
          `${row.text} ${row.href}`.match(INDIAN_PLACE)?.[0]?.trim() ??
          (site.indiaOnly ? 'India' : ''),
        url: row.href,
        text: row.text,
      };
    });
  };

  const fetchPrimary = async (): Promise<RawJob[]> => {
    const collected = new Map<string, Row>();
    const pages = site.pageParam ? (site.maxPages ?? 3) : 1;

    for (let index = 1; index <= pages; index++) {
      const target = new URL(site.url);
      if (site.pageParam && index > 1) target.searchParams.set(site.pageParam, String(index));

      const res = await scraplingFetch(target.toString(), {
        engine: 'browser',
        timeout: 60,
        headers: { referer: 'https://www.google.com/' },
        wait_selector: site.waitSelector,
        solve_cloudflare: true,
        job_link_pattern: site.linkPattern.source,
        card_up: site.cardUp ?? 0,
      });

      if (!res.success) {
        throw new ScraplingError(res.error?.message ?? 'Browser worker failed', res.error?.category);
      }
      if (typeof res.body !== 'string' || typeof res.status !== 'number') {
        throw new ScraplingError('Invalid browser response', 'protocol');
      }
      const html = res.body;
      // HTML is the expected payload here. The JSON parse-failure classifier
      // would incorrectly label every successful rendered page structural.
      const verdict = classifyFailure(res.status, headOf(html));
      if (verdict) throw new BlockError(verdict, res.status, target.toString());
      if (res.status >= 400) throw new Error(`${res.status} for ${target}`);
      if (!Array.isArray(res.rows) || res.rows.some(row => !row ||
          typeof row.href !== 'string' || typeof row.title !== 'string' || typeof row.text !== 'string')) {
        throw new ScraplingError('Invalid rendered job rows', 'protocol');
      }
      const before = collected.size;
      for (const row of res.rows) {
        row.href = new URL(row.href, res.url ?? target.toString()).href;
        if (!site.linkPattern.test(row.href)) continue;
        collected.set(row.href, row);
      }
      if (index === 1 && collected.size === 0) {
        throw new Error('Rendered page contained no verified job cards');
      }
      if (collected.size === before) break;
    }

    return parseJobs(collected);
  };
  const fetchSecondary = async (): Promise<RawJob[]> => {
    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('missing browser: playwright not installed');
    }
    return globalBrowserSemaphore.run(async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        });

        const collected = new Map<string, Row>();
        const pages = site.pageParam ? (site.maxPages ?? 3) : 1;

        for (let index = 1; index <= pages; index++) {
          const target = new URL(site.url);
          if (site.pageParam && index > 1) target.searchParams.set(site.pageParam, String(index));

          const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
          if (!response || !response.ok()) throw new Error(`${response?.status() ?? 'No response'} for ${target}`);
          await page.locator(site.waitSelector).first().waitFor({ state: 'attached', timeout: 30_000 });
          await page.waitForTimeout(site.settleMs ?? 3500);

          const before = collected.size;
          for (const row of await scrape(page, site.linkPattern.source, site.cardUp ?? 0)) {
            collected.set(row.href, row);
          }
          if (collected.size === before) break;
        }

        return parseJobs(collected);
      } finally {
        await browser.close();
      }
    });
  };

  return route({
    mode: 'scrapling-first',
    primary: fetchPrimary,
    secondary: fetchSecondary,
  });
}
