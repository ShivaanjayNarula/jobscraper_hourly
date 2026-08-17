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
  in the catalogue. **Runs hourly** — briefly moved to every 2 hours out of an
  unmeasured concern that 3,793 boards wouldn't fit in an hour, then reverted
  once a real dry run measured 23m59s at that board count. See the comment on
  `hunt.yml`'s cron line before touching the schedule again: measure first.
- **`main`** branch has the code. **`data`** branch (orphan, force-pushed,
  always 1 commit) has the catalogue the web UI reads.
- **The web UI (`web/`) is built but NOT deployed to Vercel yet.** This matters —
  it's why the email backlog section exists (see below). Deploying it is an
  outstanding step: `vercel.com/new` → import repo → Root Directory `web` →
  env var `NEXT_PUBLIC_REPO` = `smresponsibilities/jobscraper_hourly`.
- Regression suite (`npm test`) passes; treat a failing test as a real bug, not
  noise — every case in `src/selftest.ts` is a bug that actually shipped once.

## In progress — pick up here

Researching ATS credentials for ~45 well-known Indian unicorns/startups
(Zerodha, Zepto, Ola, Zoho, boAt, ...) that are real 15-40 LPA fresher
employers but weren't turned up by `detect`/`probe`/`bulk-import` — those
tools only reach Greenhouse/Lever/Ashby/SmartRecruiters/Workday/Oracle
automatically, and most of this list runs Darwinbox, TurboHire, or a
custom in-house ATS, none of which are derivable from a domain name.

**25 companies came back CONFIRMED with real job titles as evidence, and are
NOT YET in `companies.json`.** They still need one more pass — verifying each
against our own fetchers (same discipline as the KPMG/PwC/AMD finds:
resolved tenant ≠ real company, see the IBM-tenant note in ADDING-COMPANIES.md
§4d) — before being added. On Darwinbox: ClearTax (`clear`, old-style, no
hash), BigBasket (`bigbasket`, old-style — was previously tracked, then
auto-dropped by `DROP_AFTER_FAILING_DAYS`, worth checking why before
re-adding), Licious (`licious`, hash `a676187c5d262c`), Porter (`porter`,
old-style), Spinny (**tenant is `spinzone`, not `spinny`** — a naive guess
would miss it), BharatPe/Ather Energy/Rapido (tenants confirmed via matching
legal entity name, but 0 open roles right now — real boards, nothing to
alert on yet). On TurboHire: Lenskart (GUID `0e074ad4-7f98-4fea-b5d9-f3a59a156b07`),
Urban Company (GUID `4ea15045-6e8b-4edf-8274-899578e56a56`), Khatabook (GUID
not captured, only the public job-link path). The rest resolved to platforms
we don't have adapters for (CoinDCX/MakeMyTrip/ShareChat/Nykaa/Practo custom
in-house; Dream11/MobiKwik/PolicyBazaar on Trakstar Hire; CoinSwitch on
Recruiterflow) — **not worth building a new adapter for a single company**,
skip unless a pattern emerges across several.

**Still unresolved after two research passes**: Udaan and Vedantu have real
Darwinbox tenants but the public URL redirects to Microsoft SSO login rather
than showing listings. Upstox's old Lever board 404s (migrated off it).
Zepto, Myntra, Blinkit, Zerodha, Ola, Ola Electric, Oyo, and Darwinbox (the
company itself) all came back UNVERIFIED — no ATS found, or a client-rendered
SPA with no extractable titles, or (Oyo specifically) `oyo.darwinbox.in`
resolves but is a **different real company** ("MPOWER") — the exact
wildcard-domain trap this doc already warns about elsewhere.

**Third pass in flight now, on an external tool ("freebuff"), 5-hour budget.**
Full prompt saved at
`…\98fea03f-f366-420e-94f7-fd9e8295d247\scratchpad\freebuff-prompt.txt`,
output expected at `…\scratchpad\freebuff-report.txt` in the same folder —
read that file directly once it exists, don't ask the user to paste it. The
prompt is split Part 1 (retry the unresolved list above, ~3h) / Part 2
(deepen 8 already-confirmed finds with more evidence, ~1h) / Part 3 (23
fresh companies not yet touched — Jupiter, Cashfree, Juspay, Acko, upGrad,
PhysicsWallah, Tata 1mg, PharmEasy, and others, ~1h). **When it lands: verify
every claim against our own fetchers before touching `companies.json`** —
same discipline as every other addition this session, a resolved tenant is
not proof of the right company (see the IBM-tenant note in
ADDING-COMPANIES.md §4d).

**Why BigBasket — and it turns out PhysicsWallah, Porter, Licious, Tata 1mg,
PharmEasy, Subex, LeadSquared too — got auto-dropped: solved, don't
re-investigate.** All eight were on Darwinbox, all evicted by
`DROP_AFTER_FAILING_DAYS` within days of each other. Tested the exact same
adapter and tenant by hand afterward — PhysicsWallah returned 106 live jobs
immediately. The boards were never dead, only unreachable from GitHub
Actions (almost certainly a Cloudflare block on the runners' shared IP
ranges). Fixed: `src/outage.ts`'s `detectOutage()` now recognizes "most of
one platform failed this run" as a suspected outage and withholds eviction
for boards on that platform, rather than treating each as an independent
per-company death. Covered by the `outage detection` block in
`src/selftest.ts`. **This means it's now safe to re-add all eight** — the
mechanism that ate them is fixed, not just the individual boards.

**Correction to carry forward**: an early draft of the research prompt
claimed a working Keka adapter. **There isn't one** — `src/fetchers/` has no
`keka.ts`. If a company resolves to Keka, record the credentials but treat
it as a new-adapter candidate, not a drop-in add.

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

**A missing role family is invisible, and it looks exactly like "there's
nothing to send."** The user reported sparse emails and specifically Target
(already tracked) not showing an obviously-real job they'd seen on LinkedIn.
`npm run debug` looked clean because it hardcoded `.slice(0, 25)` — it was
quietly hiding 58 of Target's 83 India roles, including the fact that 48 of
them were being dropped on `role family`, not seniority. Removed the slice;
`debug` now prints every role plus a reason tally. Measuring the same drop
across the 12 highest-India-volume boards found 830 of 1,969 India roles
(42%) had no family at all — not senior, not irrelevant, just uncategorized.
`ROLE_FAMILIES` gained `product`, `design`, `security`, and `swe`/`finance`
both widened (VLSI/embedded terms for the semiconductor GCCs; `advisory`,
which alone was 235 of the dropped titles at KPMG/PwC). Widening a family
only makes a role *visible* — `classify.ts`'s per-industry seniority rules
still gate it, which is why `product` doesn't flood the inbox with "Product
Manager." The widening did pull in consulting back-office work through
finance's junior "Analyst"/"Executive" titles (`HARD_EXCLUDE` gained
`employee vetting`, `executive assistant`, `accounts payable`, etc.) — **if
you widen a family again, re-run the same kind of `role family` tally on a
few high-volume boards before shipping, because the junk always slips in
through the industry's own junior-seniority words, not through the family
regex.**

**A subagent tried to open a Cloudflare bot-check page in the in-app browser
pane and the pane's Chromium process crashed** (GPU/canvas-heavy Turnstile
rendering, ~380MB memory spike in 3s, per the crash's own account when
resumed and asked). This happened specifically while researching Darwinbox
tenant credentials for Indian unicorns — Darwinbox is Cloudflare-fronted
(see the TurboHire/Darwinbox note below), so any future agent doing this kind
of research should be told up front: **no in-app browser tool for this kind
of lookup, text-fetch only, and mark a bot-gated page `UNVERIFIED` rather
than trying to push through the challenge.** Cost two agent runs before the
guardrail was added to the prompt.

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
- **Large enterprises with no detectable ATS on their careers domain** — the
  honest floor of what unauthenticated public JSON endpoints reach; these
  build bespoke portals. Most of the original ~60-name list from placement
  reports (BlackRock, PwC, Morgan Stanley, HSBC, Samsung, Qualcomm, Texas
  Instruments, Mahindra, ...) turned out to be reachable after all — see
  ADDING-COMPANIES.md §4c/§4d for how (mostly: their real tenant just wasn't
  linked from an obvious `/careers` page, so `detect` never found it).
  Still genuinely unreachable: Deutsche Bank, McKinsey, Bain & Company
  (Bain Capital is a different entity, don't confuse them), IBM (three
  Oracle tenants that *looked* like IBM turned out to be unrelated orgs —
  see the evidence-requirement note in ADDING-COMPANIES.md §4d), VMware,
  Walmart, L&T (the core conglomerate — L&T Technology Services is separate
  and does resolve, on SuccessFactors), Bosch (the group entity is tracked;
  most subsidiaries aren't).

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
