import type { Page } from 'playwright';
import type { Company, RawJob } from '../types.js';

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
 *  - If Playwright isn't installed it returns nothing rather than failing the
 *    whole run, so the other 300+ boards are unaffected.
 */
interface RenderedSite {
  url: string;
  /** Job links match this; everything else on the page is navigation. */
  linkPattern: RegExp;
  /** Extra settle time after networkidle, for lists that stream in. */
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
    settleMs: 5000,
    cardUp: 4,
    pageParam: 'page',
    maxPages: 4,
  },
  vanguard: {
    url: 'https://www.vanguardjobs.com/job-search-results/?country=India',
    linkPattern: /\/job\/\d+\//,
    settleMs: 4500,
  },
  dazn: {
    // Custom platform (not Lever/Ashby despite the /postings/{uuid} shape).
    url: 'https://careers.dazn.com/en',
    linkPattern: /\/en\/postings\/[0-9a-f-]{20,}/,
    settleMs: 4500,
  },
  meta: {
    url: 'https://www.metacareers.com/jobs?offices[0]=Bangalore%2C%20India&offices[1]=Gurgaon%2C%20India&offices[2]=Hyderabad%2C%20India',
    linkPattern: /\/profile\/job_details\/\d+/,
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
      for (let up = 0; up < cardUp && card?.parentElement; up++) card = card.parentElement;
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

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn(`  ~ ${company.name}: playwright not installed, skipping`);
    return [];
  }

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

      await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(site.settleMs ?? 3500);

      const before = collected.size;
      for (const row of await scrape(page, site.linkPattern.source, site.cardUp ?? 0)) {
        collected.set(row.href, row);
      }
      // A page that adds nothing new means we've run past the end.
      if (collected.size === before) break;
    }

    return [...collected.values()].map((row) => ({
      // The numeric id in the URL is stable across title and slug edits.
      externalId: row.href.match(/(\d{6,})/)?.[1] ?? row.href,
      title: row.title,
      // Match the href too — slugs routinely encode the city
      // ("/job/23590255/application-engineer-iii-hyderabad-in/") even when the
      // rendered card shows only a title.
      location:
        `${row.text} ${row.href}`.match(INDIAN_PLACE)?.[0]?.trim() ??
        (site.indiaOnly ? 'India' : ''),
      url: row.href,
      text: row.text,
    }));
  } finally {
    await browser.close();
  }
}
