import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scraplingFetch, ScraplingError } from './scrapling.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('SC-03 Subprocess bounds', () => {
  const createWorker = (code: string) => {
    const path = resolve(tmpdir(), `scrapling_test_worker_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
    writeFileSync(path, code);
    return path;
  };

  it('should fail cleanly if python interpreter is missing', async () => {
    process.env.SCRAPLING_PYTHON_EXE = 'missing_python_12345';
    await assert.rejects(
      scraplingFetch('http://example.com'),
      (err: ScraplingError) => err.category === 'process' && err.message.includes('spawn')
    );
    delete process.env.SCRAPLING_PYTHON_EXE;
  });

  it('should enforce timeout on hanging worker', async () => {
    const path = createWorker(`import time; time.sleep(10)`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    await assert.rejects(
      scraplingFetch('http://example.com', { timeout: 0.1 }),
      (err: ScraplingError) => err.category === 'timeout'
    );
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });

  it('should handle crash before output', async () => {
    const path = createWorker(`import sys; sys.stderr.write("boom"); sys.exit(1)`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    await assert.rejects(
      scraplingFetch('http://example.com'),
      (err: ScraplingError) => err.category === 'process' && err.message.includes('boom') && err.message.includes('code 1')
    );
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });

  it('should enforce stdout bound', async () => {
    // 50MB + a bit
    const path = createWorker(`import sys; sys.stdout.write("x" * (51 * 1024 * 1024)); sys.stdout.flush()`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    await assert.rejects(
      scraplingFetch('http://example.com'),
      (err: ScraplingError) => err.category === 'process' && err.message.includes('exceeded')
    );
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });

  it('should handle pre-spawn cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    
    await assert.rejects(
      scraplingFetch('http://example.com', { signal: ac.signal }),
      (err: ScraplingError) => err.category === 'cancellation'
    );
  });

  it('should handle cancellation during execution', async () => {
    const path = createWorker(`import time; time.sleep(10)`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    
    await assert.rejects(
      scraplingFetch('http://example.com', { signal: ac.signal }),
      (err: ScraplingError) => err.category === 'cancellation'
    );
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });

  it('should handle concurrent calls independently', async () => {
    const path = createWorker(`
import sys, json, time
payload = json.loads(sys.stdin.read())
time.sleep(0.2)
sys.stdout.write(json.dumps({
    "version": 1,
    "success": True,
    "url": payload.get("url")
}))
sys.stdout.flush()
`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    const [res1, res2] = await Promise.all([
      scraplingFetch('http://example.com/1'),
      scraplingFetch('http://example.com/2')
    ]);
    
    assert.equal(res1.url, 'http://example.com/1');
    assert.equal(res2.url, 'http://example.com/2');
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });

  it('should resolve worker independently of cwd', async () => {
    // We do not set SCRAPLING_WORKER_PATH here, so it falls back to resolve(__dirname, 'scrapling_worker.py')
    // We change cwd and verify it still works.
    const originalCwd = process.cwd();
    process.chdir(tmpdir());
    
    try {
      const res = await scraplingFetch('http://example.com/');
      assert.equal(res.success, true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should prove POST reaches Scrapling static API without browser', async () => {
    // We create a fake scrapling_worker.py that just returns its inputs and confirms engine='static'
    const path = createWorker(`
import sys, json
payload = json.loads(sys.stdin.read())
response = {
    "version": 1,
    "success": True,
    "status": 200,
    "url": payload.get("url"),
    "engine": payload.get("engine"),
    "method_received": payload.get("method"),
    "body": "spy_success"
}
sys.stdout.write(json.dumps(response))
sys.stdout.flush()
`);
    process.env.SCRAPLING_WORKER_PATH = path;
    
    const res = await scraplingFetch('http://example.com/post', {
      method: 'POST',
      body: 'test=1',
      engine: 'static'
    });
    
    assert.equal(res.success, true);
    assert.equal(res.engine, 'static');
    assert.equal((res as any).method_received, 'POST');
    assert.equal(res.body, 'spy_success');
    
    unlinkSync(path);
    delete process.env.SCRAPLING_WORKER_PATH;
  });
});
