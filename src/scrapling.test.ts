import test from 'node:test';
import assert from 'node:assert/strict';
import { scraplingFetch, scraplingJson } from './fetchers/scrapling.js';

test('SC-01 fallback: scraplingJson should fallback to another engine if python worker fails', async () => {
  // If the worker is missing or crashes, the network call should still succeed using the fallback engine.
  // We'll pass an invalid URL scheme to simulate python worker throwing a validation error or failing to spawn,
  // but a resilient fallback would catch it and at least try the request (which would fail later, but not with a ScraplingError).
  // Actually, to prove fallback, let's just assert that scraplingJson returns data even if we simulate a scrapling failure.
  // But wait, we can't easily mock scraplingFetch without changing code.
  // Let's assert that the returned error is NOT a ScraplingError, or that it succeeds.
  // We expect this to fail (be RED) because it currently throws ScraplingError.
  try {
    await scraplingJson('invalid://localhost/dummy');
    assert.fail('Should not succeed with invalid URL');
  } catch (err: any) {
    // If fallback was implemented, it would try the fallback engine (e.g. fetch), 
    // which would throw a TypeError (invalid URL) or similar, not a ScraplingError.
    assert.notEqual(err.name, 'ScraplingError', 'Missing fallback: threw ScraplingError instead of falling back');
  }
});

test('SC-01 envelope: scraplingJson should return HTTP status and headers alongside data', async () => {
  // The caller needs status and headers to detect 403, 429, etc.
  // scraplingJson currently returns just the parsed body.
  const result: any = await scraplingJson('http://localhost/dummy', { body: '{"dummy": 1}' });
  
  // We expect this to fail (be RED) because status and headers are missing.
  assert.ok(result.status !== undefined, 'Missing HTTP status in response envelope');
  assert.ok(result.headers !== undefined, 'Missing HTTP headers in response envelope');
});
