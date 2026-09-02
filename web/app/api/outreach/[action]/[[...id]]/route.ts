import { NextRequest, NextResponse } from 'next/server';

/**
 * Hosted click-API for the deployed outreach page. Mirrors the localhost
 * server's routes in src/outreach.ts — same bookkeeping (touch counters,
 * follow-up gaps, flags), different transport. Nothing here speaks SMTP.
 *
 * Everything lives in a PRIVATE data repo, never in this public one: the batch
 * is keyed by real people's work addresses and holds unsent draft text. See
 * the header of src/publish-outreach.ts.
 *
 * Vercel env vars:
 *   OUTREACH_GH_TOKEN   — token with Contents read/write on the data repo
 *   OUTREACH_DATA_REPO  — "owner/name" of that private repo
 *   OUTREACH_KEY        — shared secret; every route requires ?k=<it>
 */

const REPO = process.env.OUTREACH_DATA_REPO ?? '';
const BRANCH = process.env.OUTREACH_DATA_BRANCH ?? 'main';
const KEY = process.env.OUTREACH_KEY ?? '';
/** Same cadence as TOUCH_GAPS in src/outreach.ts — keep in sync. */
const GAPS = [0, 4, 9, 16];

/**
 * Indexed by the touch just sent, matching `touchGap()` in src/outreach.ts.
 * An earlier version used GAPS[touch - 1], which made every follow-up fall due
 * one slot early — the first one immediately after sending.
 */
const gapAfter = (touchJustSent: number) => GAPS[Math.min(Math.max(touchJustSent, 0), GAPS.length - 1)]!;

interface ContactState {
  company?: string;
  role?: string;
  touch: number;
  sentAt: string[];
  nextDueAt: string;
  subject?: string;
  replied?: boolean;
  skipped?: boolean;
  bounced?: boolean;
  bouncedAt?: string;
}
type OutreachState = Record<string, ContactState>;
interface DraftRef {
  gmailUrl: string;
  mailtoUrl: string;
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.OUTREACH_GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
}

async function getFile(path: string): Promise<{ text: string | null; sha: string | null }> {
  const res = await gh(`/contents/${path}?ref=${BRANCH}`);
  if (!res.ok) return { text: null, sha: null };
  const j = (await res.json()) as { content?: string; sha: string };
  return { text: j.content ? Buffer.from(j.content, 'base64').toString('utf8') : '', sha: j.sha };
}

async function putState(state: OutreachState, sha: string | null): Promise<boolean> {
  const res = await gh(`/contents/contacted.json`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'outreach: click update',
      content: Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  return res.ok;
}

/**
 * Read-modify-write against a file is a lost-update race: two clicks in flight
 * both read the same sha and the second write is rejected. Retrying with a
 * fresh read is what makes "I clicked it" and "it was recorded" the same fact.
 * The caller must treat `false` as a hard failure — redirecting to Gmail after
 * a lost write is how someone gets mailed twice.
 */
async function commitState(
  mutate: (state: OutreachState) => void,
  attempts = 3,
): Promise<{ ok: boolean; state: OutreachState | null }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { text, sha } = await getFile('contacted.json');
    if (text === null) return { ok: false, state: null };
    const state = JSON.parse(text || '{}') as OutreachState;
    mutate(state);
    if (await putState(state, sha)) return { ok: true, state };
  }
  return { ok: false, state: null };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ action: string; id?: string[] }> },
) {
  if (!REPO || !process.env.OUTREACH_GH_TOKEN || !KEY) {
    return new Response('outreach API not configured (OUTREACH_GH_TOKEN / OUTREACH_DATA_REPO / OUTREACH_KEY)', {
      status: 500,
    });
  }
  // Every route is gated. Without this the draft map's ids — which are the
  // recipients' addresses — would be enough for anyone to mark the whole
  // campaign skipped, or to spam commits into the data repo.
  if (req.nextUrl.searchParams.get('k') !== KEY) return new Response('forbidden', { status: 403 });

  const { action, id: idParts } = await params;

  if (action === 'page') {
    const { text } = await getFile('today.html');
    if (text === null) return new Response('no batch published yet — run the outreach workflow', { status: 404 });
    return new Response(text, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const id = idParts?.[0];
  if (!id) return new Response('missing id', { status: 400 });

  const backToPage = new URL(`/api/outreach/page?k=${encodeURIComponent(KEY)}`, req.url);
  const now = new Date().toISOString();

  if (action === 'open' || action === 'mailapp') {
    const { text: draftsText } = await getFile('batch.json');
    if (draftsText === null) return new Response('batch unavailable — rebuild first', { status: 409 });
    const draft = (JSON.parse(draftsText || '{}') as Record<string, DraftRef>)[id];
    if (!draft) return new Response('draft not in current batch', { status: 404 });

    const { ok } = await commitState((state) => {
      const prev = state[id];
      const touch = (prev?.touch ?? 0) + 1;
      state[id] = {
        ...prev,
        touch,
        sentAt: [...(prev?.sentAt ?? []), now],
        nextDueAt: new Date(Date.now() + gapAfter(touch) * 86_400_000).toISOString(),
      };
    });
    // Deliberately do NOT redirect on failure: an unrecorded send is how a
    // follow-up goes out as if it were a first touch.
    if (!ok) return new Response('could not record the send — not opening the draft, try again', { status: 409 });
    return NextResponse.redirect(action === 'open' ? draft.gmailUrl : draft.mailtoUrl, 302);
  }

  if (action === 'replied' || action === 'skip' || action === 'bounce') {
    let known = true;
    const { ok } = await commitState((state) => {
      const cur = state[id];
      if (!cur) {
        known = false;
        return;
      }
      if (action === 'bounce') Object.assign(cur, { bounced: true, skipped: true, bouncedAt: now });
      else cur[action === 'replied' ? 'replied' : 'skipped'] = true;
    });
    if (!known) return new Response('unknown contact', { status: 404 });
    if (!ok) return new Response('could not record — try again', { status: 409 });
    return NextResponse.redirect(backToPage, 302);
  }

  return new Response('unknown action', { status: 400 });
}
