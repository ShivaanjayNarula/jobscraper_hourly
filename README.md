# jobscraper-next

Hourly email alerts for fresher / entry-level roles in India and genuinely-remote,
pulled straight from company ATS boards. No database, no paid services, no proxies.

**Picking this project up in a new session? Read [HANDOFF.md](HANDOFF.md) first** —
it has the decisions and gotchas that aren't obvious from the code alone (the
git-merge workflow you need every time, a regex bug class that's shipped three
times, why the email has a "backlog" section, what's deliberately unfinished).

Verified working against 1,381 boards: **153,596 live postings → ~2,350 open matches
across 400+ companies**, in about eleven minutes.

The board list grows on its own: a weekly Common Crawl sweep walks the CDX index
one block per run, keeping any board that currently has an India or remote role.

## How it works

```
GitHub Actions (hourly)
  └─ poll 1381 ATS boards ─► diff against seen state ──► classify ──► filter
                                                                      │
                                                                      │
                                          new matches? ──► email via Gmail SMTP
                                                    └────► data/jobs.json ──► web UI
```

Roles are matched by requisition ID, so a posting that disappears from a board
that answered normally is marked `closedAt` rather than deleted. Duplicate
requisitions for the same role are collapsed — Amazon lists one job under three
IDs, but it's still one application.

There is no scraping in the HTML sense. Every source is a public JSON endpoint the
company already publishes to power its own careers page:

| ATS | Endpoint | Notes |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | Descriptions fetched per-job, only for new roles |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | Descriptions and salary inline |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` | Always ships full descriptions (~10 MB for large boards) |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | Returns 200 + `totalFound: 0` for unknown companies, never 404 |
| Workday | `{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | POST, paginated, relative dates only. Reports `total` **only on the first page** — later pages say `0` while still returning results, so trusting it per page caps every board at 40 jobs |
| Oracle HCM | `{tenant}.fa.oraclecloud.com/hcmRestApi/…/recruitingCEJobRequisitions` | Powers JPMorgan and many banks |
| Amazon | `amazon.jobs/en/search.json` | Own search API; queried for India directly |
| Atlassian | `atlassian.com/endpoint/careers/listings` | Custom. Fronts iCIMS but publishes plain JSON with descriptions and compensation |
| Phenom | `POST {careers-host}/widgets` | Undocumented but identical across every deployment — Cisco, HPE, Mastercard, eBay, BCG, Fiserv, GSK, Lilly. The careers hostname *is* the tenant; queried against the India facet directly |
| Eightfold | `{careers-host}/api/pcsx/search?domain=…` | Powers Microsoft. Returns 10 per call and ignores any page-size parameter you pass |
| Darwinbox | `POST {tenant}.darwinbox.in/ms/candidateapi/job/alljobs` | Eight large Indian employers. `companyId` must be in the **body**, not just the query string, or you get a successful-looking empty result. Behind Cloudflare, which fingerprints the TLS handshake — so this adapter shells out to `curl` |
| TurboHire | `POST thapi.azurewebsites.net/api/careerpagev2/filteredjobs` | Flipkart, Purplle, Navi. Needs an anonymous bearer from `/api/token/noauth`, which only issues one when `Origin` and `Referer` are set. `pageType=2` is the live-openings set — `0` returns a 10-row teaser and `1` the full historical corpus |
| Rendered (Playwright) | headless Chromium reads the DOM | **Google, Meta, Uber, Vanguard, DAZN.** They expose no API at all — Google runs an internal batchexecute RPC. Anchored on the job-URL pattern rather than obfuscated class names, so a restyle doesn't break it. Degrades to returning nothing if Playwright is absent |

New roles are detected by **requisition ID**, never by date. Workday only exposes
relative dates ("Posted Today") and companies routinely bump timestamps when they
repost, so IDs are the only reliable signal.

## Setup

1. Push this repo to GitHub (public — needed later so the UI can read the data).
2. Google Account → 2-Step Verification **on** → App Passwords → generate one.
3. Repo Settings → Secrets and variables → Actions → add:
   - `GMAIL_USER` — the sending Gmail address
   - `GMAIL_APP_PASSWORD` — the 16-character app password (**not** your Gmail password)
   - `ALERT_TO` — where alerts should land
4. Actions tab → **hunt** → Run workflow, to confirm it works.

The first real run marks everything currently posted as seen and emails nothing.
That's deliberate — otherwise run one would send you 1,139 roles at once. To see
them once, run **hunt** manually with the test-email box ticked.

## The web UI

`web/` is a static Next.js site. It fetches `data/jobs.json` from GitHub at
runtime, so the hourly workflow's commit updates the live site **without a
redeploy** — Vercel only rebuilds when you change the UI code itself.

Deploy:

1. Go to [vercel.com/new](https://vercel.com/new) and import the repo.
2. Set **Root Directory** to `web`.
3. Add environment variable `NEXT_PUBLIC_REPO` = `yourname/jobscraper-next`.
4. Deploy.

Without `NEXT_PUBLIC_REPO` the page reads same-origin files instead, so you can
preview locally by copying `data/jobs.json` into `web/public/data/`:

```bash
npm run dev --prefix web
```

The **Add a company** box takes a pasted careers URL, resolves the board, and
counts its open jobs **in your browser** — Greenhouse, Lever, Ashby and
SmartRecruiters all send `Access-Control-Allow-Origin: *`, so no backend is
needed to validate a board before you add it. Workday is parsed but not counted;
it blocks cross-origin reads.

## Tuning

Everything adjustable lives in [`src/config.ts`](src/config.ts): `MAX_YEARS`,
`INCLUDE_INTERNSHIPS`, city list, remote handling, role families, the
IT-services exclusion list, and `EMAIL_FRESHNESS_DAYS`.

### "New" means new to the tracker, not newly posted

A role's requisition ID being unseen and its posting date being recent are
different claims. Add a company, or have a board recover after days of
errors, and its entire current listing looks "new" even if much of it is
months old — 573 of 1,101 dated roles in the catalog were 30+ days old on one
sample day, including a role alerted as "new" that had been open 111 days.

There's no early-mover edge left on a role like that, so **the email only
surfaces postings within `EMAIL_FRESHNESS_DAYS` (21)** of their real posting
date. Nothing is dropped — every match still enters `data/jobs.json`
regardless of age, so the catalogue/UI stays complete; only the alert email is
gated. Roles with no parseable posting date (most Workday boards never expose
one) are always treated as fresh, since absence of a date isn't evidence of
staleness. The manual test-email run (`workflow_dispatch` with the checkbox
ticked) skips this gate entirely — it's a diagnostic meant to show everything
currently matching, not a preview of normal alerts.

Seniority rules are per-industry in [`src/classify.ts`](src/classify.ts), because
title vocabulary is not portable across sectors:

- **"Associate"** — junior at JPMorgan, mid-senior at Stripe
- **"Analyst"** — entry-level in banking and consulting, often mid-level in tech
- **"Engineer II"** — never entry level, in any industry

If JPMorgan's ~60 controller/associate roles are more than you want, narrow
`FINANCE.junior` to `analyst|graduate|trainee|summer` and the associate tier drops out.

## Growing the company list

`companies.json` ships with 309 boards — 188 added deliberately, 121 harvested. The weekly `discover`
workflow harvests more from the Common Crawl index — Greenhouse, Lever and Ashby
tokens plus Workday tenants — then keeps only boards that currently have at least
one India or remote role. Without that gate the harvest adds thousands of
companies that can never produce a single alert.

**Best method — resolve the careers page.** Put company domains in `domains.txt`:

```bash
npm run detect -- domains.txt
```

It fetches each careers page, extracts the linked ATS board, validates it, and
appends it. Use this in preference to slug guessing, because the token often
isn't the brand name — Razorpay's Greenhouse token is
`razorpaysoftwareprivatelimited`, and PhysicsWallah's Darwinbox tenant is `pwhr`.
It also reports companies running platforms with no adapter yet, so gaps stay visible.

**Slug guessing** still works for the many companies whose token *is* their name.
Put candidates in `candidates.txt` and run:

```bash
npm run probe -- candidates.txt
```

It tries each name against Greenhouse, Lever, Ashby and SmartRecruiters (both
`acmecorp` and `acme-corp` spellings), keeps only boards with at least one
India/remote role, and appends them. Pass `--all` to keep every live board.

This works because those four derive the token from the company name. It cannot
work for Workday or Oracle — those tenants are opaque.

To add one by hand, take it from the careers URL:

| URL | Entry |
|---|---|
| `jobs.lever.co/acme` | `{ "ats": "lever", "token": "acme" }` |
| `boards.greenhouse.io/acme` | `{ "ats": "greenhouse", "token": "acme" }` |
| `jobs.ashbyhq.com/acme` | `{ "ats": "ashby", "token": "acme" }` |
| `acme.wd5.myworkdayjobs.com/en-US/Careers` | `{ "ats": "workday", "token": "acme", "host": "wd5", "site": "Careers" }` |

Workday and Oracle tenants can't be guessed from the company name — JPMorgan is
`jpmc`, not `jpmorgan`. Read them off the URL or let Common Crawl find them.

Boards that fail continuously for three days are dropped automatically; tokens rot
when companies rename or migrate ATS.

## State without a database

Seen IDs live in the **Actions cache** between hourly runs, with a committed
snapshot once a day. Committing state every hour would write a fresh copy of the
file into git history 24 times a day; the daily snapshot also keeps the repo
active so GitHub doesn't auto-disable the schedule after 60 days.

## Local use

```bash
npm install
npm run dry      # poll everything, classify, write out/matches.json, persist nothing
npm run preview  # render the last dry run to out/preview.html
npm run hunt     # the real thing
npm run probe -- candidates.txt   # bulk-test candidate board slugs
npm run discover # Common Crawl harvest
```

Descriptions are fetched **after** title/location screening, not before. Skipping
that ordering makes the first run ~10x slower for no extra matches, since it
enriches every one of the ~14,000 previously-unseen postings instead of the ~870
that could plausibly survive.

## Known limits

- **Salary is almost always absent.** The field is wired up for Lever and Ashby,
  but most boards don't opt into publishing it — all 178 matches came back empty.
- **Workday is capped** at ~300 newest roles per board. Results are newest-first,
  so new postings are caught; the full back catalogue is not enumerated.
- **Classification is regex, not an LLM.** Expect roughly 85% accuracy. Every
  mistake is one line in `classify.ts`.
- **Darwinbox companies are not covered.** Licious, CleverTap, LeadSquared,
  Unacademy, upGrad, PharmEasy, Tata 1mg, Porter and PhysicsWallah all run it.
  Its documented job API needs Basic Auth with a key issued by Darwinbox, so it
  is not a public feed like the others. The public careers widget must call
  something unauthenticated, but that needs browser network tracing to find.
- **TurboHire** (Flipkart, Purplle, Navi) is unmapped for the same reason.
- **Many careers pages render client-side**, so `detect` finds no link in the
  raw HTML — Zomato, Swiggy, Flipkart, Dream11, Zerodha and others. Their public
  job pages do publish `schema.org/JobPosting` JSON-LD for Google for Jobs, which
  is the most promising route in without per-company reverse engineering.
