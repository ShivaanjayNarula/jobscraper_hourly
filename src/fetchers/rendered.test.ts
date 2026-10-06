import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { list, SITES } from './rendered.js';

test('worker failure cannot become a successful empty rendered listing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rendered-regression-'));
  const worker = join(directory, 'worker.py');
  writeFileSync(worker, 'import json, sys\njson.load(sys.stdin)\nprint(json.dumps({"version":1,"success":False,"error":{"category":"internal","message":"browser navigation failed"}}))\n');
  const previous = process.env.SCRAPLING_WORKER_PATH;
  process.env.SCRAPLING_WORKER_PATH = worker;
  const launch = mock.method(chromium, 'launch', async () => { throw new Error('fallback browser missing'); });
  try {
    await assert.rejects(list({ ats: 'rendered', token: 'uber', name: 'Uber', industry: 'tech' }), /browser navigation failed/);
    assert.equal(launch.mock.callCount(), 1);
  } finally {
    launch.mock.restore();
    if (previous === undefined) delete process.env.SCRAPLING_WORKER_PATH;
    else process.env.SCRAPLING_WORKER_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('valid primary HTML keeps Scrapling first and resolves relative job links', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rendered-links-'));
  const worker = join(directory, 'worker.py');
  writeFileSync(worker, 'import json, sys\np=json.load(sys.stdin)\nprint(json.dumps({"version":1,"success":True,"status":200,"url":p["url"],"body":"<html>jobs</html>","rows":[{"href":"/en/jobs/123456/","title":"Software Engineer","text":"Bangalore"}]}))\n');
  const previous = process.env.SCRAPLING_WORKER_PATH;
  const pages = SITES.uber!.maxPages;
  process.env.SCRAPLING_WORKER_PATH = worker;
  SITES.uber!.maxPages = 1;
  const launch = mock.method(chromium, 'launch', async () => { throw new Error('valid primary HTML must not fall back'); });
  try {
    const jobs = await list({ ats: 'rendered', token: 'uber', name: 'Uber', industry: 'tech' });
    assert.equal(jobs[0]?.url, 'https://jobs.uber.com/en/jobs/123456/');
    assert.equal(launch.mock.callCount(), 0);
  } finally {
    launch.mock.restore();
    SITES.uber!.maxPages = pages;
    if (previous === undefined) delete process.env.SCRAPLING_WORKER_PATH;
    else process.env.SCRAPLING_WORKER_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fallback reads delayed job cards while unrelated resources remain open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rendered-delayed-'));
  const worker = join(directory, 'worker.py');
  writeFileSync(worker, 'import json, sys\njson.load(sys.stdin)\nprint(json.dumps({"version":1,"success":False,"error":{"category":"internal","message":"primary unavailable"}}))\n');
  const server = createServer((request, response) => {
    if (request.url === '/held') return;
    response.setHeader('content-type', 'text/html');
    response.end('<html><body><img src="/held"><script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", "<ul><li><a href=\\"/en/jobs/123456/\\">Software Engineer</a><span>Bangalore</span></li><li><a href=\\"/en/jobs/234567/\\">General Manager</a><span>South Africa</span></li></ul>"); }, 250)</script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const previous = process.env.SCRAPLING_WORKER_PATH;
  const site = { ...SITES.uber! };
  SITES.uber!.url = `http://127.0.0.1:${address.port}/jobs`;
  SITES.uber!.maxPages = 1;
  SITES.uber!.settleMs = 0;
  process.env.SCRAPLING_WORKER_PATH = worker;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const originalLaunch = chromium.launch.bind(chromium);
  const launch = mock.method(chromium, 'launch', async () => {
    browser = await originalLaunch();
    return browser;
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const jobs = await Promise.race([
      list({ ats: 'rendered', token: 'uber', name: 'Uber', industry: 'tech' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('waited for unrelated resource')), 10000); }),
    ]);
    assert.equal(jobs[0]?.externalId, '123456');
    assert.match(jobs[0]!.location, /Bangalore/);
    assert.equal(jobs[1]?.location, '');
  } finally {
    clearTimeout(timer);
    await browser?.close();
    launch.mock.restore();
    Object.assign(SITES.uber!, site);
    if (previous === undefined) delete process.env.SCRAPLING_WORKER_PATH;
    else process.env.SCRAPLING_WORKER_PATH = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
