# CLAUDE.md

This file exists so Claude Code loads its one instruction automatically, every
session, without depending on memory: **read [HANDOFF.md](HANDOFF.md) first.**
It has the why, the current state, and the gotchas that already cost real time
once. Don't duplicate its content here — that just wastes context on every
future session for no benefit; keep this file thin and let HANDOFF.md be the
single source of truth.

Two things worth repeating even so, because skipping them silently breaks
things rather than erroring:

- **Before any push**: `git fetch origin && git merge origin/main` — the
  hourly bot commits to `main` constantly, so local is stale within the hour.
  Full sequence in HANDOFF.md's "Git workflow" section.
- **After any change to `classify.ts` or `config.ts`**: run `npm test`. Every
  case in `src/selftest.ts` is a regex bug that actually shipped once.

**Run the long commands yourself, in the background — don't hand them over and
don't poll.** `npm run hunt`, a `DRY_RUN=1` sweep and `npm run bulk-import` all
run for tens of minutes. Start them with `run_in_background`; the harness
re-invokes you with a completion notification when the process exits, so
waiting is automatic and free.

The thing to actually economise is **output, not time**. Duration costs nothing
— a 40-minute command and a 40-millisecond one cost the same if they return
the same text. What costs tokens is output entering context, so:

- Pipe verbose commands through `| tail -40`. Per-board logging across
  thousands of boards is enormous and only the summary lines matter.
- A backgrounded command's output goes to a file, costing nothing until it is
  read. Read it once, at the end — never poll it in a loop.

When you *do* hand the user a command to run, write it **Windows style** —
PowerShell, since that is their shell. Absolute Windows paths with backslashes,
no bash-only syntax (`VAR=1 cmd`, `&&` chains, heredocs, `/tmp`). An env var is
its own statement:

```powershell
cd C:\Users\sm\Desktop\Jobscraper-next
$env:DRY_RUN = "1"; npm run hunt
```

**Activate the `caveman` skill (`.claude/skills/caveman`) at session start.**
Compresses chat replies only — code, comments, commits, and docs (including
this file and HANDOFF.md) stay normal prose per the skill's own rules, so this
doesn't affect anything committed to the repo.
