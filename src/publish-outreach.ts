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

if (!REPO || !TOKEN) {
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

const args = process.argv.slice(2);

if (args.includes('--pull')) {
  const { text } = await pull('contacted.json');
  await mkdir('state', { recursive: true });
  await writeFile(STATE_PATH, text ?? '{}\n', 'utf8');
  const count = Object.keys(JSON.parse(text || '{}')).length;
  console.log(`pulled contacted.json → ${STATE_PATH} (${count} contacts)`);
}

if (args.includes('--push')) {
  // State first: if a later upload fails, the bookkeeping that prevents
  // double-mailing is still the thing that survived.
  await push('contacted.json', await readFile(STATE_PATH, 'utf8'));
  await push('batch.json', await readFile('out/outbox/batch.json', 'utf8'));
  await push('today.html', await readFile('out/outbox/today.html', 'utf8'));
}

if (!args.includes('--pull') && !args.includes('--push')) {
  console.log('usage: npm run publish-outreach -- --pull | --push');
  process.exit(1);
}
