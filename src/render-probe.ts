import { chromium } from 'playwright';

/**
 * Works out how to read a new entry in `SITES` (src/fetchers/rendered.ts).
 *
 *   npx tsx src/render-probe.ts "https://careers.example.com/jobs?location=India"
 *
 * Reports two things, because sites split into two shapes:
 *
 *  - **link shapes** — sites whose job cards are anchors (Google, Meta). Pick the
 *    repeated path template and use it as `linkPattern`.
 *  - **repeated containers** — sites that render results into non-anchor elements
 *    (Uber, Walmart). Pick a selector and use it as `cardSelector`.
 */
const url = process.argv[2];
if (!url) throw new Error('usage: npx tsx src/render-probe.ts <url>');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(6000);

  const report = await page.evaluate(() => {
    const shapes: Record<string, { count: number; example: string }> = {};
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (anchor as HTMLAnchorElement).href;
      let path: string;
      try {
        path = new URL(href).pathname;
      } catch {
        continue;
      }
      const shape = path
        .replace(/\/\d{4,}/g, '/{id}')
        .replace(/\/[a-z0-9]{8,}-[a-z0-9-]{6,}/gi, '/{slug}');
      shapes[shape] ??= { count: 0, example: href };
      shapes[shape]!.count += 1;
    }

    // Repeated containers whose text looks like a job row.
    const jobish = /engineer|manager|analyst|developer|scientist|associate|intern|designer|specialist/i;
    const buckets: Record<string, { count: number; sample: string }> = {};
    for (const el of Array.from(document.querySelectorAll('div,li,article,tr'))) {
      const node = el as HTMLElement;
      const text = (node.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 15 || text.length > 260 || !jobish.test(text)) continue;
      if (node.querySelectorAll('div,li,article,tr').length > 6) continue;

      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/) : [];
      const key = cls.length
        ? `${node.tagName.toLowerCase()}.${cls.slice(0, 2).join('.')}`
        : node.tagName.toLowerCase();
      buckets[key] ??= { count: 0, sample: text.slice(0, 110) };
      buckets[key]!.count += 1;
    }

    return {
      title: document.title,
      marker: document.body.innerText.match(/[\d,]+\s*(jobs|openings|results|positions)/i)?.[0],
      linkShapes: Object.entries(shapes)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6),
      cardSelectors: Object.entries(buckets)
        .filter(([, v]) => v.count >= 3)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8),
    };
  });

  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
