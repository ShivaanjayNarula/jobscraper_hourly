import { createConnection, type Socket } from 'node:net';
import { resolveMx } from 'node:dns/promises';

/**
 * Three-state SMTP recipient verification.
 *
 * Two states would be a lie. Roughly a third of B2B domains are catch-all —
 * they answer 250 to every address including invented ones — and Microsoft's
 * frontends accept RCPT TO for mailboxes that no longer exist. Reporting any
 * of that as "verified" gets corrected later by the bounce rate, which is the
 * expensive way to find out: above 2% hard bounces a sending domain is marked
 * unreliable, and above 5% inbox placement drops for every recipient, not just
 * the bounced ones.
 *
 * Requires outbound TCP port 25, which Azure blocks by default — so this does
 * NOT run on GitHub-hosted Actions runners. Run it locally and commit the
 * result; CI only sends.
 */
export type Verdict = 'valid' | 'invalid' | 'unknown';

export interface Verification {
  verdict: Verdict;
  /** Why, in a few words — worth logging, since `unknown` has several causes. */
  reason: string;
}

/**
 * The domain used in EHLO and MAIL FROM. Should be a domain that actually
 * resolves, or strict receivers reject the conversation before RCPT TO.
 */
export const PROBE_DOMAIN = process.env.PROBE_DOMAIN ?? 'example.com';

const PORT = 25;
/**
 * 5s, not the more common 10: honest servers answer RCPT in well under a
 * second, and catch-all gateways deliberately tarpit probes toward whatever
 * timeout you declare. Waiting longer only buys a slower "unknown".
 */
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 5_000);

/**
 * Which mail provider is behind an MX host. Providers differ enormously in
 * whether RCPT TO tells the truth: measured comparisons put Google Workspace
 * at ~90% conclusive against ~51% for Microsoft-hosted domains, and the
 * security gateways sit in front of whatever the tenant actually runs, so they
 * can only ever answer for the gateway.
 */
export type Provider = 'google' | 'microsoft' | 'gateway' | 'other';

export function mxProvider(host: string): Provider {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/(^|\.)(aspmx|smtp)\.(l\.)?google(mail)?\.com$/.test(h) || /\.google\.com$/.test(h)) return 'google';
  if (/\.(outlook|office365|microsoft)\.com$/.test(h) || /\.mail\.protection\.outlook\.com$/.test(h)) {
    return 'microsoft';
  }
  if (/(pphosted|proofpoint|mimecast|barracudanetworks|messagelabs|trendmicro)\.com$/.test(h)) return 'gateway';
  return 'other';
}

/**
 * Whether a RCPT TO rejection from this provider means anything. Google says
 * no when it means no; Microsoft and the gateways frequently do not, so a
 * rejection there is treated as inconclusive rather than as proof of absence.
 */
export const rejectionIsMeaningful = (provider: Provider): boolean =>
  provider === 'google' || provider === 'other';

/** A local part no real mailbox would own, used to detect catch-all domains. */
export const controlAddress = (domain: string): string =>
  `no-such-user-9f3c1a7e-probe@${domain}`;

export interface MxRecord {
  priority: number;
  exchange: string;
}

/**
 * MX lookup over HTTPS, used when the system resolver is unreachable.
 *
 * `resolveMx` talks to the configured nameserver on port 53 directly, which
 * plenty of networks block outright — sandboxes, restrictive corporate LANs,
 * some ISPs. `dns.lookup` (and therefore an ordinary socket connect) keeps
 * working in those places because it goes through the OS, but there is no
 * getaddrinfo equivalent for MX records. DoH is the fallback that keeps this
 * usable on a network where 53 is closed but 443 is not.
 */
async function resolveMxOverHttps(domain: string): Promise<MxRecord[]> {
  const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
    headers: { accept: 'application/dns-json' },
  });
  if (!response.ok) throw new Error(`DoH ${response.status}`);
  const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? [])
    .filter((answer) => answer.type === 15)
    .map((answer) => {
      const [priority, exchange] = answer.data.split(/\s+/);
      return { priority: Number(priority), exchange: exchange ?? '' };
    })
    .filter((record) => record.exchange !== '');
}

/** System resolver first, DoH only if it cannot be reached at all. */
async function lookupMx(domain: string): Promise<MxRecord[]> {
  try {
    return await resolveMx(domain);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A definitive "this domain has no MX" is an answer, not a failure — do
    // not go asking a second resolver for a different one.
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    return resolveMxOverHttps(domain);
  }
}

function readReply(socket: Socket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // Multi-line replies repeat the code with a hyphen; the final line uses a
      // space. Waiting for that is what stops a 220-banner continuation from
      // being read as the answer to the next command.
      const final = buffer.split(/\r?\n/).find((line) => /^\d{3} /.test(line));
      if (!final) return;
      cleanup();
      resolve({ code: Number(final.slice(0, 3)), text: final.slice(4).trim() });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function say(socket: Socket, line: string): Promise<{ code: number; text: string }> {
  const reply = readReply(socket);
  socket.write(`${line}\r\n`);
  return reply;
}

function connect(host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: PORT, timeout: TIMEOUT_MS });
    socket.once('connect', () => resolve(socket));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

/**
 * One connection, two RCPT TO probes: the control first, then the real
 * address. The control has to come first — once a catch-all has answered 250
 * to it, nothing the real address returns can be trusted, so there is no point
 * asking.
 *
 * ponytail: one connection per address, no pooling and no parallelism. At the
 * volumes this project sends (tens per day) that is irrelevant; if it ever
 * needs hundreds, batch by domain and reuse the connection across recipients.
 */
export async function verifyEmail(email: string): Promise<Verification> {
  const domain = email.split('@')[1];
  if (!domain) return { verdict: 'invalid', reason: 'malformed address' };

  let records: MxRecord[];
  try {
    records = await lookupMx(domain);
  } catch (error) {
    return { verdict: 'unknown', reason: `MX lookup failed (${(error as Error).message})` };
  }
  // No MX at all means nothing can receive mail here. That is a real negative,
  // not an inconclusive one.
  if (records.length === 0) return { verdict: 'invalid', reason: `no MX for ${domain}` };

  const host = records.sort((a, b) => a.priority - b.priority)[0]!.exchange;
  const provider = mxProvider(host);

  let socket: Socket;
  try {
    socket = await connect(host);
  } catch (error) {
    return { verdict: 'unknown', reason: `connect ${host}: ${(error as Error).message}` };
  }

  try {
    const banner = await readReply(socket);
    if (banner.code !== 220) return { verdict: 'unknown', reason: `banner ${banner.code}` };

    const helo = await say(socket, `EHLO ${PROBE_DOMAIN}`);
    if (helo.code !== 250) return { verdict: 'unknown', reason: `EHLO ${helo.code}` };

    const from = await say(socket, `MAIL FROM:<probe@${PROBE_DOMAIN}>`);
    if (from.code !== 250) return { verdict: 'unknown', reason: `MAIL FROM ${from.code}` };

    const control = await say(socket, `RCPT TO:<${controlAddress(domain)}>`);
    if (control.code >= 200 && control.code < 300) {
      return { verdict: 'unknown', reason: `${domain} is catch-all` };
    }

    const target = await say(socket, `RCPT TO:<${email}>`);
    if (target.code >= 200 && target.code < 300) return { verdict: 'valid', reason: `accepted by ${host}` };
    if (target.code >= 400 && target.code < 500) {
      return { verdict: 'unknown', reason: `throttled (${target.code} ${target.text})` };
    }
    if (!rejectionIsMeaningful(provider)) {
      return { verdict: 'unknown', reason: `${provider} rejection is not conclusive` };
    }
    return { verdict: 'invalid', reason: `${target.code} ${target.text}` };
  } catch (error) {
    return { verdict: 'unknown', reason: (error as Error).message };
  } finally {
    // Best-effort courtesy close; the verdict is already decided either way.
    socket.write('QUIT\r\n');
    socket.destroy();
  }
}

if (process.argv[1]?.endsWith('verify-email.ts')) {
  const address = process.argv[2];
  if (!address) {
    console.log('usage: npm run verify -- someone@company.com');
    process.exit(1);
  }
  const result = await verifyEmail(address);
  console.log(`${address}  ${result.verdict}  (${result.reason})`);
}
