import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Semaphore } from './concurrency.js';

describe('Semaphore', () => {
  it('concurrency peaks never exceed declared bounds', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = async () => {
      await sem.acquire();
      active++;
      if (active > peak) peak = active;
      await new Promise(r => setTimeout(r, 10));
      active--;
      sem.release();
    };

    await Promise.all([task(), task(), task(), task(), task()]);
    assert.strictEqual(peak, 2);
    assert.strictEqual(active, 0);
  });

  it('cancellation while queued releases capacity', async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    
    // occupy the only slot
    await sem.acquire();

    // second one queues and is aborted
    const p = sem.acquire(ac.signal).catch(e => e.name);
    ac.abort();
    assert.strictEqual(await p, 'AbortError');

    // release first slot
    sem.release();
    
    // third should be able to acquire
    await sem.acquire();
    sem.release();
    assert.strictEqual(sem.active, 0);
  });
});
