/**
 * Move the outreach batch between the build and a PRIVATE data repo.
 *
 *   npm run publish-outreach -- --pull    # fetch contacted.json before a build
 *   npm run publish-outreach -- --push    # upload state + page + draft map
 *
 * Why a separate repo at all: this project's own repo is public, so anything
 * committed to it — including `web/public/`, which Vercel additionally serves
 * at a guessable URL — is world-readable. The outreach batch contains real
 * engineers' work addresses (the draft map is literally keyed by them) and the
 * full text of mails not yet sent. Those addresses came from public commit
 * metadata, but aggregating them into a ready-made list and republishing it is
 * a different act from them being scattered across commit logs, and it would
 * be published under the user's name. So the batch lives in a private repo
 * that only the token can read, and nothing personal is ever committed here.
 *
 * Set OUTREACH_DATA_REPO ("owner/name", private) and OUTREACH_GH_TOKEN
 * (Contents read/write on that repo).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const REPO = process.env.OUTREACH_DATA_REPO ?? '';
const TOKEN = process.env.OUTREACH_GH_TOKEN ?? '';
const BRANCH = process.env.OUTREACH_DATA_BRANCH ?? 'main';
const STATE_PATH = process.env.OUTREACH_STATE_PATH ?? 'state/contacted.json';
const DRAFTS_PATH = process.env.OUTREACH_DRAFTS_PATH ?? 'state/drafts.json';

/**
 * Guarded exactly like outreach.ts's own CLI block: selftest imports
 * mergeState() from here, and an import must never exit the process for a
 * missing token or print the usage banner.
 */
const RUNNING = process.argv[1]?.endsWith('publish-outreach.ts') ?? false;

if (RUNNING && (!REPO || !TOKEN)) {
  console.error('OUTREACH_DATA_REPO and OUTREACH_GH_TOKEN must both be set');
  process.exit(1);
}

const api = (path: string, init?: RequestInit) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'jobscraper-next',
      ...(init?.headers ?? {}),
    },
  });

/**
 * The Contents API answers with a JSON envelope, not the file — the `content`
 * field holds base64. Reading it as if it were the file itself yields valid
 * JSON of entirely the wrong shape, which is the failure that silently wiped
 * the contact state once: dedup found no ids, every already-mailed person was
 * re-offered, and the envelope was then committed back over the real file.
 */
async function pull(remote: string): Promise<{ text: string | null; sha: string | null }> {
  const res = await api(`/contents/${remote}?ref=${BRANCH}`);
  if (res.status === 404) return { text: null, sha: null };
  if (!res.ok) throw new Error(`GET ${remote}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { content?: string; sha: string };
  return {
    text: body.content ? Buffer.from(body.content, 'base64').toString('utf8') : '',
    sha: body.sha,
  };
}

async function push(remote: string, contents: string): Promise<void> {
  const { sha } = await pull(remote);
  const res = await api(`/contents/${remote}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `outreach: publish batch`,
      content: Buffer.from(contents, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`PUT ${remote}: ${res.status} ${await res.text()}`);
  console.log(`pushed ${remote} (${contents.length} bytes)`);
}

/** Only the fields this merge has to reason about; everything else rides
 *  along on whichever record wins. */
interface ContactRecord {
  touch?: number;
  sentAt?: string[];
  nextDueAt?: string;
  replied?: boolean;
  skipped?: boolean;
  bounced?: boolean;
  bouncedAt?: string;
  connectedAt?: string;
}
type OutreachState = Record<string, ContactRecord & Record<string, unknown>>;

/**
 * Union the two copies so nothing that actually happened is forgotten.
 *
 * The rule is monotone in both directions, because both sides hold real
 * events: the local build owns the research fields it just computed (SMTP
 * verdicts, names, facts), and the remote owns whatever a human clicked while
 * that build was running. So sends are unioned by timestamp, a flag set on
 * either side stays set, and `touch` follows the send list rather than either
 * side's counter. A flag is never cleared here — un-replying or un-bouncing
 * somebody is precisely the mistake that would put another mail in their
 * inbox.
 */
export function mergeState(local: OutreachState, remote: OutreachState): OutreachState {
  const merged: OutreachState = { ...remote };
  for (const [addr, l] of Object.entries(local)) {
    const r = remote[addr];
    if (!r) {
      merged[addr] = l;
      continue;
    }
    const sentAt = [...new Set([...(l.sentAt ?? []), ...(r.sentAt ?? [])])].sort();
    const out: OutreachState[string] = { ...r, ...l, sentAt };
    // touch counts sends, so it follows the union — taking either side's own
    // number would undercount a send the other side recorded.
    out.touch = Math.max(l.touch ?? 0, r.touch ?? 0, sentAt.length);
    // The later due date belongs to the later send.
    out.nextDueAt = [l.nextDueAt, r.nextDueAt].filter(Boolean).sort().pop() ?? l.nextDueAt;
    for (const flag of ['replied', 'skipped', 'bounced'] as const) {
      if (l[flag] || r[flag]) out[flag] = true;
    }
    for (const stamp of ['bouncedAt', 'connectedAt'] as const) {
      const seen = [l[stamp], r[stamp]].filter(Boolean).sort();
      if (seen.length) out[stamp] = seen[0];
    }
    merged[addr] = out;
  }
  return merged;
}

const args = RUNNING ? process.argv.slice(2) : [];

if (args.includes('--pull')) {
  // The standing pool of options travels with the state. Without it every
  // hosted build starts from an empty pool and the whole point of keeping
  // yesterday's un-sent drafts is lost on the very next run.
  const pooled = await pull('drafts.json');
  await mkdir('state', { recursive: true });
  await writeFile(DRAFTS_PATH, pooled.text ?? '[]', 'utf8');
  console.log(`pulled drafts.json -> ${DRAFTS_PATH} (${JSON.parse(pooled.text || '[]').length} options)`);

  const { text } = await pull('contacted.json');
  await mkdir('state', { recursive: true });
  await writeFile(STATE_PATH, text ?? '{}\n', 'utf8');
  const count = Object.keys(JSON.parse(text || '{}')).length;
  console.log(`pulled contacted.json → ${STATE_PATH} (${count} contacts)`);
}

if (args.includes('--push')) {
  // State first: if a later upload fails, the bookkeeping that prevents
  // double-mailing is still the thing that survived.
  //
  // Merged rather than overwritten. `push()` deliberately re-reads the sha
  // right before writing so GitHub cannot reject the write — which also means
  // GitHub cannot protect this file. The local copy was pulled at the START of
  // a build that takes minutes, and every click on the live page during those
  // minutes commits to the remote through the hosted API. Pushing the local
  // snapshot straight over the top silently reverted them: a "replied" or
  // "bounced" flag set mid-build would disappear, and the next build would
  // then draft a follow-up to somebody who had already answered or whose
  // address had already bounced.
  const localState = JSON.parse(await readFile(STATE_PATH, 'utf8')) as OutreachState;
  const remoteState = JSON.parse((await pull('contacted.json')).text || '{}') as OutreachState;
  await push('contacted.json', `${JSON.stringify(mergeState(localState, remoteState), null, 2)}\n`);
  // A halted build (bounce gate) returns before it writes the pool, so the
  // file can legitimately be absent. Pushing an empty array in that case would
  // wipe the standing options in the data repo, which is the opposite of what
  // persistence is for — so skip the push entirely and leave the stored pool
  // alone rather than overwrite it with nothing.
  const pool = await readFile(DRAFTS_PATH, "utf8").catch(() => null);
  if (pool === null) console.log(`no ${DRAFTS_PATH} this run — leaving the stored pool untouched`);
  else await push('drafts.json', pool);
  await push('batch.json', await readFile('out/outbox/batch.json', 'utf8'));
  await push('today.html', await readFile('out/outbox/today.html', 'utf8'));
  // The weekly LinkedIn list, served as its own tab on the site. Absent on a
  // --mbox or --print build, and leaving last week's copy in place beats
  // failing the whole push over it.
  const connects = await readFile('out/outbox/connects.html', 'utf8').catch(() => null);
  if (connects === null) console.log('no out/outbox/connects.html this run — leaving the published one alone');
  else await push('connects.html', connects);
}

if (RUNNING && !args.includes('--pull') && !args.includes('--push')) {
  console.log('usage: npm run publish-outreach -- --pull | --push');
  process.exit(1);
}
