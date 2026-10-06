import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { globalPythonSemaphore } from './concurrency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ScraplingRequest {
  version: 1;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  engine: 'static' | 'browser';
  timeout?: number;
  wait_selector?: string;
  solve_cloudflare?: boolean;
  job_link_pattern?: string;
  card_up?: number;
}

export interface ScraplingResponse {
  version: 1;
  success: boolean;
  status?: number;
  headers?: Record<string, string>;
  url?: string;
  body?: string;
  encoding?: string;
  engine?: 'static' | 'browser';
  rows?: { href: string; title: string; text: string }[];
  error?: {
    category: string;
    message: string;
  };
}

export class ScraplingError extends Error {
  public category: string;
  constructor(message: string, category: string = 'internal') {
    super(message);
    this.name = 'ScraplingError';
    this.category = category;
  }
}

export async function scraplingFetch(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; engine?: 'static' | 'browser'; timeout?: number; wait_selector?: string; solve_cloudflare?: boolean; job_link_pattern?: string; card_up?: number; signal?: AbortSignal } = {}
): Promise<ScraplingResponse> {
  const method = options.method || 'GET';
  const engine = options.engine || 'static';
  
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new ScraplingError('Invalid URL scheme', 'validation');
  }

  const payload: ScraplingRequest = {
    version: 1,
    url,
    method,
    headers: options.headers || {},
    body: options.body,
    engine,
    timeout: options.timeout || 30,
    wait_selector: options.wait_selector,
    solve_cloudflare: options.solve_cloudflare,
    job_link_pattern: options.job_link_pattern,
    card_up: options.card_up,
  };

  const payloadStr = JSON.stringify(payload);

  const timeoutMs = (options.timeout || 30) * 1000;

  return globalPythonSemaphore.run(() => new Promise((resolvePromise, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let py: any;
    
    let settled = false;
    const settle = (err?: Error, result?: ScraplingResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (py && py.pid) {
        try { py.kill(); } catch (e) {}
      }
      if (err) reject(err);
      else resolvePromise(result!);
    };

    const onAbort = () => {
      settle(new ScraplingError('Request cancelled', 'cancellation'));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        return settle(new ScraplingError('Request cancelled', 'cancellation'));
      }
      options.signal.addEventListener('abort', onAbort);
    }

    const pythonExe = process.env.SCRAPLING_PYTHON_EXE || 'python';
    const workerPath = process.env.SCRAPLING_WORKER_PATH || resolve(__dirname, 'scrapling_worker.py');
    
    const startTime = Date.now();
    try {
      py = spawn(pythonExe, [workerPath]);
      const overhead = Date.now() - startTime;
      if (overhead > 500) {
        console.warn(`Scrapling spawn overhead high: ${overhead}ms`);
      }
    } catch (err: any) {
      return settle(new ScraplingError(`Process spawn failed: ${err.message}`, 'process'));
    }

    const MAX_STDOUT = 50 * 1024 * 1024;
    const MAX_STDERR = 5 * 1024 * 1024;
    
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    
    py.stdout.on('data', (data: Buffer) => {
      stdout = Buffer.concat([stdout, data]);
      if (stdout.length > MAX_STDOUT) {
        settle(new ScraplingError('Worker stdout exceeded 50MB bound', 'process'));
      }
    });
    
    py.stderr.on('data', (data: Buffer) => {
      stderr = Buffer.concat([stderr, data]);
      if (stderr.length > MAX_STDERR) {
        settle(new ScraplingError('Worker stderr exceeded 5MB bound', 'process'));
      }
    });
    
    py.on('error', (err: any) => {
      settle(new ScraplingError(`Process spawn failed: ${err.message}`, 'process'));
    });

    py.on('close', (code: number, signal: string) => {
      if (settled) return;
      
      if (code !== 0 && code !== null) {
        return settle(new ScraplingError(`Worker exited with code ${code}. stderr: ${stderr.toString('utf-8').slice(0, 200)}`, 'process'));
      }
      if (signal) {
        return settle(new ScraplingError(`Worker killed by signal ${signal}`, 'process'));
      }

      let parsed: any;
      try {
        parsed = JSON.parse(stdout.toString('utf-8'));
      } catch (err) {
        return settle(new ScraplingError(`Failed to parse worker output: ${stdout.toString('utf-8').slice(0, 100)}... stderr: ${stderr.toString('utf-8').slice(0, 100)}`, 'protocol'));
      }
      
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return settle(new ScraplingError('Invalid response shape', 'protocol'));
      }
      
      if (parsed.version !== 1) {
        return settle(new ScraplingError('Unsupported protocol version in response', 'protocol'));
      }
      
      settle(undefined, parsed as ScraplingResponse);
    });

    timer = setTimeout(() => {
      settle(new ScraplingError(`Worker timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    try {
      py.stdin.write(payloadStr);
      py.stdin.end();
    } catch (err: any) {
      settle(new ScraplingError(`Failed to write to worker stdin: ${err.message}`, 'process'));
    }
  }), options.signal);
}

export async function scraplingJson<T>(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; engine?: 'static' | 'browser'; timeout?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await scraplingFetch(url, options);
  if (!res.success) {
    throw new ScraplingError(`Scrapling error: ${res.error?.message}`, res.error?.category);
  }
  
  if (!res.body) {
    throw new ScraplingError('Empty body', 'validation');
  }
  
  try {
    return JSON.parse(res.body) as T;
  } catch (err) {
    throw new ScraplingError(`Failed to parse Scrapling output as JSON: ${res.body.slice(0, 200)}`, 'validation');
  }
}
