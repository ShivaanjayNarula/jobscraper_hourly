# Handoff

Read this first in any new session on this repo. It's the "why," not the "what" —
README.md, ARCHITECTURE.md and ADDING-COMPANIES.md cover the what; this covers
the decisions, the gotchas, and what's still open.

## The user

BE CSE grad, final semester ending August 2026, wants full-time + internships,
India and genuinely-remote only, ≤3 years experience (unstated years kept),
SWE/Data/ML plus finance/banking/consulting/quant. Mass-hiring IT-services and
BPO firms (TCS, Infosys, Wipro, Cognizant, HCL, Hexaware, Genpact, ...) are
explicitly excluded — that was a direct, deliberate request, not a default.

## Current state (as of this doc's last edit)

- **3,793 boards**, ~350-400K live postings per run, ~2,300-2,500 open matches
  in the catalogue. Runs every 2 hours (see hunt.yml for why not hourly).
- **`main`** branch has the code. **`data`** branch (orphan, force-pushed,
  always 1 commit) has the catalogue the web UI reads.
- **The web UI (`web/`) is built but NOT deployed to Vercel yet.** This matters —
  it's why the email backlog section exists (see below). Deploying it is an
  outstanding step: `vercel.com/new` → import repo → Root Directory `web` →
  env var `NEXT_PUBLIC_REPO` = `smresponsibilities/jobscraper_hourly`.
- Regression suite (`npm test`) passes; treat a failing test as a real bug, not
  noise — every case in `src/selftest.ts` is a bug that actually shipped once.

## Decisions that aren't obvious from the code alone

**"New" means new-to-tracker, not newly-posted, and that distinction broke
things twice.** A company being added, or a board recovering from errors,
makes its whole backlog look "new" at once (measured: 573 of 1,101 dated roles
were 30+ days old on one sample day). First fix: gate the email on posting
freshness (`EMAIL_FRESHNESS_DAYS` in config.ts). That fix was itself wrong —
it silently dropped backlog roles from view entirely, because `data/jobs.json`
is the only other place they go and nothing reads it pre-deployment. Real fix:
backlog roles still email, just demoted to a low-key section in `email.ts`
(`backlogSection`). **Lesson: before gating anything out of the only
user-visible surface, check whether there's actually a second surface, or
"gated" is just "deleted."**

**Per-industry seniority vocabulary, not one global list.** "Associate" is
junior at a bank, mid-senior at a tech company. "Analyst" is entry-level in
banking/consulting, often mid-level in tech. Each `Company.industry` picks a
vocabulary in `classify.ts`. `UNIVERSAL_SENIOR` holds terms that mean senior
*everywhere* (senior, staff, principal, distinguished, head, mgmt, supv, ...) —
grown incrementally every time a real leak surfaced.

**Role-family regex is broad on purpose; junk gets carved out via
`HARD_EXCLUDE`, not by narrowing the family match.** `swe` bare-matches
`\bengineer\b`, `data` bare-matches `\bscientist\b` — necessary for coverage,
but it means industrial/pharma GCCs (Thermo Fisher, GE Vernova, Baker Hughes)
leak mechanical/refrigeration/wet-lab titles through. Fix each leak by adding
a specific exclusion phrase, same pattern already used for `sales|marketing`.
Don't narrow the family regex itself — that loses real matches elsewhere.

**Storage discipline is load-bearing, not decoration.** Git stores a full copy
per commit. `state/seen.json` (~9MB, ~150K IDs) is cache-only, never
committed — a `.gitignore` entry alone wasn't enough, it was already tracked
from the first commit and had to be explicitly `git rm --cached`. The
catalogue (`data/jobs.json`) lives on the orphan `data` branch,
force-pushed as a single commit every run specifically so its history never
grows — it's derived/regenerable data, keeping years of hourly snapshots has
zero value. `CatalogEntry` deliberately does NOT `extend Job` — `Job.text`
(job descriptions) would have made the catalogue 4x larger for no reason
anything downstream reads.

**Company dedup is by canonical display name, not by token.** Growe runs two
separate Greenhouse boards (`growe`, `growetalents`) with genuinely
overlapping-but-not-identical postings. Fix was renaming both entries'
`name` field to the same string so the existing per-company dedup key
collapses true duplicates while keeping each board's unique postings. If you
see the same real company under two different names in the catalogue, this is
the fix — not a special case in the dedup logic.

**Scale is bounded by `seen.json` and by per-host rate limits, not by runtime.**
Both were fixed together, and both are load-bearing if the board count keeps
growing:

- `seen.json` used to record *every* posting, including the ~93% that fail
  location/role screening and could therefore never alert. Screening before
  recording cut it from 167,194 IDs to 12,151 (measured: **7.3% pass**), i.e.
  9.7 MB → ~0.7 MB. This matters because the Actions cache stores one copy per
  run: at ~105 MB it would evict itself within days and drop the run into a
  permanent cold start. If you ever add a filter that runs *after* screening,
  don't move it before — the 93% must stay unrecorded.
- A single global `CONCURRENCY` is the wrong shape. ~70% of boards are
  Greenhouse sharing one API host, and Workday tenants cluster on pods (wd5
  alone hosts 93), so nine "global" slots could all land on one pod — and did,
  producing dozens of 429s in a single run. Scheduling per *rate-limit domain*
  (`HOST_CONCURRENCY`, pod-aware for Workday) took that to 8 errors while
  *raising* throughput, since domains now run in parallel. **Raising a global
  concurrency number would make rate limiting worse, not better.**
- 429/503 retry with backoff. Without it a throttled board is indistinguishable
  from a broken one, so `recordFailure` starts the `DROP_AFTER_FAILING_DAYS`
  clock and quietly evicts healthy companies three days after a bad burst.

**The email gate is `new_count`, and it must track whether the email was
actually written.** `out/` is gitignored, so it is empty on every fresh runner.
`index.ts` skips writing `email.html` on a cold start, but used to still report
`new_count > 0` — pointing the workflow's send step at a file that does not
exist. That is the "no email arrived even though roles were found" failure, and
it is invisible locally because a local run has an `out/` directory lying around.

## The recurring bug class — watch for this specifically

**`'\bfoo\b'` in a plain JS/TS string literal is `<backspace>foo<backspace>`,
not a regex word boundary.** It needs `'\\bfoo\\b'`. This shipped at least
three separate times in this project (the India/Indiana regex, the RME
exclusion, the HVAC/biopharma exclusions) — each one silently made the
pattern match nothing, and each one only surfaced because `npm test` was run
immediately after. **Any time you add a `\b`-containing pattern as a bare
string (not inside `/…/` regex literal syntax), double-escape it and run
`npm test` before considering the change done.**

## Git workflow — this is not optional context

The `hunt.yml` workflow's "Commit board list" step pushes to `main` on
**almost every hourly run** (board `failingSince` timestamps flip constantly).
Your local branch WILL be behind within an hour of any session start.

Standard sequence for every change in this project:
```bash
git add -A && git commit -m "..."
git fetch origin && git merge origin/main -m "Merge remote board-list updates"
npx tsc --noEmit && npm test
git push origin main
```
If push is rejected (`fetch first`), the bot committed again mid-session —
just repeat fetch/merge/push. This happened multiple times in one sitting and
is completely normal, not a sign of concurrent editing by a person.

`companies.json` merge conflicts are common and almost always trivial (both
sides only add/toggle `failingSince`) — a normal `git merge` resolves them
without intervention nearly every time.

## Known gaps, deliberately not fixed — see ADDING-COMPANIES.md for detail

- **Google, Meta, Uber, Walmart**: fully client-rendered, no reachable API even
  headless, for Uber/Walmart. (Google/Meta were solved via headless rendering —
  check ADDING-COMPANIES.md §1 for current status before assuming still blocked.)
- **SuccessFactors** — SOLVED (`src/fetchers/successfactors.ts`). The search
  *results page* is server-rendered HTML, but both SF variants publish a
  credential-free XML feed alongside it: Career Site Builder tenants (SAP,
  Volvo, ZF, Mahindra) serve `{host}/sitemal.xml`, a Google-Merchant RSS feed
  with a real `g:location` field; legacy Recruiting Management tenants (HSBC)
  serve `{host}/career?company={code}&career_ns=job_listing_summary&resultType=XML`
  but carry no location field at all, so location is recovered by regex-matching
  India city names against the title+description text — a job only gets a
  location when that actually hits, which is deliberately conservative (no
  location field → excluded, not guessed). Both feeds are unusually slow
  (30-170s per company, roughly proportional to total job count), hence the
  adapter's own 180s timeout instead of the shared 30s default. `detect.ts`
  can spot a SuccessFactors-powered careers page but still can't auto-derive
  the token/host — that part stays manual, see ADDING-COMPANIES.md.
- **iCIMS** (DocuSign, D.E. Shaw): still open. HTML with no JSON, though detail
  pages do carry a `schema.org/JobPosting` JSON-LD block — same shape of fix as
  SuccessFactors would take (a genuinely new code path), just not built yet.
- **~60 large enterprises named in top-college placement reports** (BlackRock,
  Deutsche Bank, PwC, McKinsey, Bain, Morgan Stanley, HSBC, Samsung, Qualcomm,
  IBM, VMware, Texas Instruments, Mahindra, L&T, Bosch, ...) — no detectable ATS
  on their careers domain at all. This is the honest floor of what
  unauthenticated public JSON endpoints reach; these build bespoke portals.

## Useful commands

```bash
npm test                          # regression suite — run after any regex change
npm run debug -- "Company Name"   # shows every role from one board + why it passed/failed
npm run detect -- domains.txt     # resolve careers pages to ATS boards, in bulk
npm run probe -- candidates.txt   # guess board tokens from company names, in bulk
npm run bulk-import -- --bar india   # import + validate ats-scrapers' tenant lists
npm run bulk-import -- --limit 200   # ...sample first; runs weekly in discover.yml
npm run preview                   # render out/matches.json as the actual email HTML
npm run discover                  # manual trigger of the weekly Common Crawl sweep
```

## If the user asks "is everything pushed"

Don't assume — verify:
```bash
git fetch origin -q
git rev-parse HEAD origin/main | uniq -c   # should print "2 <same-hash>"
```
