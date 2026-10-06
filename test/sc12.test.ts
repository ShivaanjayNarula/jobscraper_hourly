import { test } from 'node:test';
import * as assert from 'node:assert';
import { route, FallbackError, extractBlockKind, routingDiagnostics } from '../src/fetchers/routing.js';
import { BlockError } from '../src/fetchers/block.js';

test('SC-12 diagnostics: captures primary and final engines on success', async () => {
  const diag = {};
  await routingDiagnostics.run(diag, async () => {
    await route({
      mode: 'scrapling-first',
      primaryName: 'scrapling',
      secondaryName: 'curl',
      primary: async () => 'ok',
      secondary: async () => 'fail'
    });
  });
  assert.strictEqual((diag as any).primaryEngine, 'scrapling');
  assert.strictEqual((diag as any).finalEngine, 'scrapling');
  assert.strictEqual((diag as any).fallbackReason, undefined);
});

test('SC-12 diagnostics: captures fallback reason on fallback success', async () => {
  const diag = {};
  await routingDiagnostics.run(diag, async () => {
    await route({
      mode: 'scrapling-first',
      primaryName: 'scrapling',
      secondaryName: 'curl',
      primary: async () => { throw new Error('timeout'); },
      secondary: async () => 'ok'
    });
  });
  assert.strictEqual((diag as any).primaryEngine, 'scrapling');
  assert.strictEqual((diag as any).finalEngine, 'curl');
  assert.strictEqual((diag as any).fallbackReason, 'timeout');
});

test('SC-12 diagnostics: captures failure class when both fail', async () => {
  const diag = {};
  await routingDiagnostics.run(diag, async () => {
    try {
      await route({
        mode: 'scrapling-first',
        primary: async () => { throw new BlockError({ kind: 'rate_limited', vendor: 'generic' }, 429, 'test'); },
        secondary: async () => { throw new Error('fail'); }
      });
    } catch {
      // expected
    }
  });
  assert.strictEqual((diag as any).failureClass, 'rate_limited');
  assert.strictEqual((diag as any).finalEngine, 'none');
});

// Shadow mode tests would be in a separate file or integration test.
