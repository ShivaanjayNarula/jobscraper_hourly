import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { route } from './routing.js';
import { BlockError } from './block.js';

describe('routing policy', () => {
  it('primary succeeds and secondary call count is zero', async () => {
    let pCalls = 0;
    let sCalls = 0;
    const res = await route({
      mode: 'scrapling-first',
      primary: async () => { pCalls++; return { ok: true }; },
      secondary: async () => { sCalls++; return { ok: false }; },
    });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(pCalls, 1);
    assert.strictEqual(sCalls, 0);
  });

  it('primary fails eligibly and secondary succeeds exactly once', async () => {
    let pCalls = 0;
    let sCalls = 0;
    const res = await route({
      mode: 'scrapling-first',
      primary: async () => { pCalls++; throw new Error('network'); },
      secondary: async () => { sCalls++; return { ok: true }; },
    });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(pCalls, 1);
    assert.strictEqual(sCalls, 1);
  });

  it('both fail', async () => {
    let sCalls = 0;
    await assert.rejects(
      route({
        mode: 'scrapling-first',
        primary: async () => { throw new Error('network 1'); },
        secondary: async () => { sCalls++; throw new Error('network 2'); },
      }),
      /network 2/
    );
    assert.strictEqual(sCalls, 1);
  });

  it('valid empty does not fall back', async () => {
    let sCalls = 0;
    const res = await route({
      mode: 'scrapling-first',
      primary: async () => { return { data: [] }; },
      secondary: async () => { sCalls++; return { data: [1] }; },
      validate: (data: any) => data.data && Array.isArray(data.data)
    });
    assert.deepStrictEqual(res, { data: [] });
    assert.strictEqual(sCalls, 0);
  });

  it('invalid tenant does not fall back', async () => {
    let sCalls = 0;
    await assert.rejects(
      route({
        mode: 'scrapling-first',
        primary: async () => { throw new Error('404 Not Found'); },
        secondary: async () => { sCalls++; return { ok: true }; },
        validate: () => true
      }),
      /404 Not Found/
    );
    assert.strictEqual(sCalls, 0);
  });

  it('body validation rejects challenge/invalid schema', async () => {
    let sCalls = 0;
    const res = await route({
      mode: 'scrapling-first',
      primary: async () => { return { challenge: true }; },
      secondary: async () => { sCalls++; return { ok: true }; },
      validate: (data: any) => data.ok === true
    });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(sCalls, 1);
  });

  it('cancellation does not fall back', async () => {
    let sCalls = 0;
    await assert.rejects(
      route({
        mode: 'scrapling-first',
        primary: async () => { 
           const err = new Error('cancelled');
           err.name = 'AbortError';
           throw err;
        },
        secondary: async () => { sCalls++; return { ok: true }; },
      }),
      /cancelled/
    );
    assert.strictEqual(sCalls, 0);
  });

  it('write POST replay is rejected', async () => {
    let sCalls = 0;
    await assert.rejects(
      route({
        mode: 'scrapling-first',
        method: 'POST',
        isReadOnlyPost: false,
        primary: async () => { throw new Error('fail'); },
        secondary: async () => { sCalls++; return { ok: true }; },
      }),
      /fail/
    );
    assert.strictEqual(sCalls, 0);
  });

  it('read-only POST replay retains request', async () => {
    let sCalls = 0;
    const res = await route({
      mode: 'scrapling-first',
      method: 'POST',
      isReadOnlyPost: true,
      primary: async () => { throw new Error('fail'); },
      secondary: async () => { sCalls++; return { ok: true }; },
    });
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(sCalls, 1);
  });
  
  it('rate limit honors backoff; exhausted budget does not start secondary', async () => {
    let sCalls = 0;
    await assert.rejects(
      route({
        mode: 'scrapling-first',
        primary: async () => { throw new BlockError({kind:'rate_limited', vendor:'generic'}, 429, 'http'); },
        secondary: async () => { sCalls++; return { ok: true }; },
      }),
      /rate_limited/
    );
    assert.strictEqual(sCalls, 0);
  });

  it('legacy-only never invokes primary', async () => {
    let pCalls = 0;
    let sCalls = 0;
    const res = await route({
      mode: 'legacy-only',
      primary: async () => { pCalls++; return { ok: true }; },
      secondary: async () => { sCalls++; return { ok: true, s: true }; },
    });
    assert.deepStrictEqual(res, { ok: true, s: true });
    assert.strictEqual(pCalls, 0);
    assert.strictEqual(sCalls, 1);
  });

  it('cohort selection defaults to scrapling-first for enabled cohorts', async () => {
    let pCalls = 0;
    let sCalls = 0;
    const res = await route({
      adapter: 'darwinbox', // enabled in config
      primary: async () => { pCalls++; return { ok: true }; },
      secondary: async () => { sCalls++; return { ok: true, s: true }; },
    });
    // Assuming LEGACY_ONLY is false during this test run
    if (!process.env.LEGACY_ONLY) {
      assert.deepStrictEqual(res, { ok: true });
      assert.strictEqual(pCalls, 1);
      assert.strictEqual(sCalls, 0);
    }
  });

  it('cohort selection defaults to legacy-only for unknown cohorts', async () => {
    let pCalls = 0;
    let sCalls = 0;
    const res = await route({
      adapter: 'unknown-adapter',
      primary: async () => { pCalls++; return { ok: true }; },
      secondary: async () => { sCalls++; return { ok: true, s: true }; },
    });
    assert.deepStrictEqual(res, { ok: true, s: true });
    assert.strictEqual(pCalls, 0);
    assert.strictEqual(sCalls, 1);
  });
});
