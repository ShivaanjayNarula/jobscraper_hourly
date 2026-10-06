export class Semaphore {
  private queue: (() => void)[] = [];
  public active = 0;

  constructor(private max: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const err = new Error('aborted before acquire');
      err.name = 'AbortError';
      throw err;
    }
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        const err = new Error('aborted while waiting in queue');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        const originalResolve = resolve;
        resolve = () => {
          signal.removeEventListener('abort', onAbort);
          originalResolve();
        };
      }
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.active--;
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const globalPythonSemaphore = new Semaphore(10);
export const globalBrowserSemaphore = new Semaphore(5);
