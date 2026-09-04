/**
 * Sends a reviewed `--mbox` batch (src/outreach.ts) via `git send-email`,
 * then folds each successful send back into outreach's own state so
 * follow-up cadence and the verdict cache stay correct — the same
 * bookkeeping the click-through server's markSent() does for a manually
 * clicked draft, just triggered from here instead.
 *
 *   npm run outreach -- --mbox              # write out/outbox/<date>/*.txt
 *   # delete any file you don't want sent, then:
 *   npm run outreach:send -- out/outbox/<date>
 *
 * Deleting a file from the directory before running this is the review
 * step — only files still present get sent. Extra CLI args after the
 * directory pass straight through to `git send-email` (e.g. --confirm=never
 * for an unattended run, or --dry-run to see what would happen).
 *
 * git send-email owns the actual SMTP conversation and its own per-message
 * confirm prompt — this script never touches SMTP itself, same rule
 * outreach.ts documents for its own click-through path.
 *
 * Two guards a human clicking one-by-one on the served page got for free,
 * which an automated loop doesn't: a rolling-24h send cap and a pause
 * between sends (a burst of back-to-back messages is its own spam-heuristic
 * red flag, independent of the daily count).
 *
 * The cap default (12) is OUTREACH-DESIGN.md §1's `OUTREACH_AUTO_CAP` —
 * designed there, never wired up until this script. It is deliberately
 * *not* Gmail's ~500/day mechanical SMTP ceiling: COLDMAIL-PLAN.md §2 found
 * the real binding constraint is reputation, not the mechanical cap —
 * practitioner consensus converges on 20-30 cold emails/mailbox/day overall,
 * with automation specifically capped tighter than a human's share of that
 * budget. Read both docs before raising this.
 *
 * The cap counts every `sentAt` timestamp across the whole state file from
 * the last 24h, not just this run — a per-process counter would reset to a
 * fresh allowance every time this script starts, which does nothing to stop
 * two runs in the same day from together crossing the real limit. Override
 * with OUTREACH_AUTO_CAP / OUTREACH_SEND_DELAY_MS deliberately, not by default.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readJson } from './state.js';
import { nextDueAt, STATE_PATH, type OutreachState } from './outreach.js';

const DAILY_CAP = Number(process.env.OUTREACH_AUTO_CAP ?? 12);
const SEND_DELAY_MS = Number(process.env.OUTREACH_SEND_DELAY_MS ?? 3_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sentInLast24h(state: OutreachState): number {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  let count = 0;
  for (const entry of Object.values(state)) {
    for (const iso of entry.sentAt) {
      if (new Date(iso).getTime() >= cutoff) count++;
    }
  }
  return count;
}

interface ManifestEntry {
  addr: string;
  file: string;
  company: string;
  role: string;
  source?: string;
}

async function saveState(state: OutreachState): Promise<void> {
  await mkdir('state', { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const [dir, ...extraArgs] = process.argv.slice(2);
  if (!dir) {
    console.log('usage: npm run outreach:send -- <out/outbox/date-dir> [extra git send-email args]');
    process.exit(1);
  }

  const manifest: ManifestEntry[] = JSON.parse(await readFile(`${dir}/manifest.json`, 'utf8'));
  const state = await readJson<OutreachState>(STATE_PATH, {});

  const already = sentInLast24h(state);
  const remaining = Math.max(0, DAILY_CAP - already);
  console.log(`${already} sent in the last 24h · ${remaining} left before the ${DAILY_CAP}/24h cap`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let capped = 0;

  for (const entry of manifest) {
    const filePath = `${dir}/${entry.file}`;
    const stillPresent = await readFile(filePath, 'utf8').then(
      () => true,
      () => false,
    );
    if (!stillPresent) {
      skipped++;
      continue;
    }

    if (sent >= remaining) {
      capped++;
      continue;
    }

    if (sent > 0) await sleep(SEND_DELAY_MS);

    console.log(`\n→ ${entry.company} <${entry.addr}>`);
    const result = spawnSync('git', ['send-email', `--to=${entry.addr}`, ...extraArgs, filePath], {
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      console.log(`  ! git send-email exited ${result.status} for ${entry.addr} — not marked sent`);
      failed++;
      continue;
    }

    const now = new Date().toISOString();
    const prev = state[entry.addr];
    const touch = (prev?.touch ?? 0) + 1;
    state[entry.addr] = {
      company: prev?.company ?? entry.company,
      role: prev?.role ?? entry.role,
      location: prev?.location,
      jobUrl: prev?.jobUrl ?? '',
      firstName: prev?.firstName,
      touch,
      sentAt: [...(prev?.sentAt ?? []), now],
      nextDueAt: nextDueAt(now, touch),
      fact: prev?.fact,
      subject: prev?.subject ?? '',
      verdict: prev?.verdict,
      verifiedAt: prev?.verifiedAt,
      gravatar: prev?.gravatar,
      replied: prev?.replied,
      skipped: prev?.skipped,
      bounced: prev?.bounced,
      bouncedAt: prev?.bouncedAt,
      source: prev?.source ?? entry.source,
    };
    sent++;
    // Persisted after every send, not just at the end: a real message has
    // already gone out at this point, so losing this bookkeeping to a crash
    // or Ctrl+C risks a duplicate send next run — worse than the extra writes.
    await saveState(state);
  }

  console.log(`\n${sent} sent, ${skipped} skipped (deleted before send), ${failed} failed, ${capped} held back by the ${DAILY_CAP}/24h cap.`);
  if (capped > 0) console.log(`the rest becomes sendable as today's sends age out of the 24h window — re-run later.`);
}

if (process.argv[1]?.endsWith('outreach-send.ts')) {
  await main();
}
