# Adding companies

## The short version

Open the company's careers page, **click through to their actual job listings**,
and copy the URL from the address bar. That URL is all I need.

The one thing that matters: the careers page on the company's own domain is
usually a marketing page. Keep clicking ("View all jobs", "Search openings",
"See openings") until the address bar changes to a *different domain* or a
`/careers/jobs`-style path that lists real roles. **That** is the URL to send.

```
❌ https://www.razorpay.com/careers/          marketing page, useless
✅ https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited
```

Guessing never works reliably — Razorpay's board token is
`razorpaysoftwareprivatelimited` (their registered entity) and PhysicsWallah's
Darwinbox tenant is `pwhr`. Neither is derivable from the brand name.

## Exactly what URL is wanted, per platform

If you can tell which platform it is, here's the shape. If you can't, just send
the URL — identifying it is my job.

| Platform | URL that works | What gets extracted |
|---|---|---|
| **Greenhouse** | `job-boards.greenhouse.io/`**`acme`** or `boards.greenhouse.io/`**`acme`** | token |
| **Lever** | `jobs.lever.co/`**`acme`** | token |
| **Ashby** | `jobs.ashbyhq.com/`**`acme`** | token |
| **SmartRecruiters** | `jobs.smartrecruiters.com/`**`Acme`** | token (case-sensitive) |
| **Workday** | **`acme`**`.`**`wd5`**`.myworkdayjobs.com/en-US/`**`Acme_Careers`** | tenant + pod + site — **all three**, so send the whole URL |
| **Oracle** | **`acme`**`.fa.`**`us2`**`.oraclecloud.com/hcmUI/CandidateExperience/en/sites/`**`CX_1001`** | tenant + pod + site number |
| **Phenom** | just the hostname: **`careers.acme.com`** | the hostname *is* the tenant |
| **Eightfold** | **`apply.careers.acme.com`** + the `domain=` value in its network calls | host + domain |
| **Darwinbox** | **`acme`**`.darwinbox.in/ms/candidatev2/`**`a62d7a6e288992`**`/careers` | tenant + companyId. Older tenants use `/ms/candidate/careers` with no hash — then the tenant alone is enough |
| **TurboHire** | **`acme`**`.turbohire.co/careerpage/`**`4d757ba0-3d57-448a-b82c-238ed87ac90f`** | subdomain + org GUID |
| **SuccessFactors (modern)** | just the hostname: **`jobs.acme.com`** | the hostname *is* the tenant, same as Phenom |
| **SuccessFactors (legacy)** | **`career2.successfactors.eu`**`/career?company=`**`acmecorp`** | legacy career host + company code — send both |

Workday and Oracle are the ones people truncate. `acme.wd5.myworkdayjobs.com`
alone is not enough — without the site path (`Acme_Careers`) there's nothing to
query.

## If clicking through doesn't leave the page

Some careers pages load jobs by background request and never change the URL
(Zomato, Swiggy, Flipkart, Dream11 are all like this). Then:

1. Press **F12** → **Network** tab
2. Click **Fetch/XHR**
3. Reload the page
4. Look for a request returning JSON with job titles in it
5. Right-click it → **Copy** → **Copy link address**

Send me that. It's exactly how Microsoft and Cisco got added.

## Where it goes

`companies.json`, at the repo root. One object per board:

```json
{
  "name": "Razorpay",
  "ats": "greenhouse",
  "token": "razorpaysoftwareprivatelimited",
  "industry": "fintech",
  "source": "curated"
}
```

Workday needs two extra fields:

```json
{
  "name": "Capital One",
  "ats": "workday",
  "token": "capitalone",
  "host": "wd12",
  "site": "Capital_One",
  "industry": "banking",
  "source": "curated"
}
```

Oracle needs the pod and site number:

```json
{
  "name": "Oracle",
  "ats": "oracle",
  "token": "eeho",
  "host": "fa.us2",
  "siteNumber": "CX_45001",
  "industry": "tech",
  "source": "curated"
}
```

SuccessFactors modern (Career Site Builder) takes the hostname as the token,
same as Phenom:

```json
{
  "name": "SAP",
  "ats": "successfactors",
  "token": "jobs.sap.com",
  "industry": "tech",
  "source": "curated"
}
```

SuccessFactors legacy needs the career host as well:

```json
{
  "name": "HSBC",
  "ats": "successfactors",
  "token": "hsbcholdin",
  "host": "career2.successfactors.eu",
  "industry": "banking",
  "source": "curated"
}
```

Phenom takes the hostname as the token:

```json
{
  "name": "Cisco",
  "ats": "phenom",
  "token": "careers.cisco.com",
  "industry": "tech",
  "source": "curated"
}
```

### `industry` is not cosmetic

It selects which seniority vocabulary applies. Tag it wrong and the filter
misreads the whole company — "Associate" is junior at a bank and mid-senior at a
tech firm.

| Value | Use for |
|---|---|
| `tech` | product and software companies, GCCs, SaaS |
| `fintech` | payments, lending, brokerages — uses the tech vocabulary |
| `banking` | investment banks, insurers, asset managers |
| `consulting` | MBB, Big Four |
| `quant` | trading firms and hedge funds |

## Check it worked

```bash
npm run debug -- "Capital One"
```

Prints every role the board returns, whether it passed, and the exact reason it
didn't — `5y minimum`, `seniority`, `role family`, `location`.

## Doing it in bulk

```bash
npm run detect -- domains.txt
```

Resolves careers pages to boards automatically. Put one domain per line
(`razorpay.com,fintech`). **Use this first** — it handles the token-isn't-the-brand-name
problem for you, and reports any company running a platform with no adapter yet.

```bash
npm run probe -- candidates.txt
```

Guesses board tokens from company names across Greenhouse, Lever, Ashby and
SmartRecruiters. Works for the many companies whose token *is* their name, and
tries both `acmecorp` and `acme-corp`. Only keeps boards that currently have an
India or remote role.

```bash
npm run discover
```

Common Crawl sweep. Runs weekly on its own; you shouldn't need to trigger it.

```bash
npm run import -- listings.md
```

Harvests boards from **any file containing job URLs** — a curated listings repo, a
bookmarks export, a pasted set of links. Community job-listing repos are the best
seam here: their tables link straight to Greenhouse, Workday and Ashby boards, so
one file yields hundreds of companies at once. Importing
[DereC4/internships-and-newgrad](https://github.com/DereC4/internships-and-newgrad)
added 74 boards in a single pass, including Johnson Controls (219 India roles),
Cadence (156) and Eurofins (75).

Every board is still validated before being kept, so a dead or irrelevant link
costs nothing.

---

# What's still missing

~5 companies sit behind three walls. Each needs a different fix, and none yields
to the techniques that got the other 317 boards.

## 1. ~~Google and Meta~~ — SOLVED, Uber and Walmart still open

**Google (100 postings) and Meta (10)** now run through a Playwright adapter that
reads the rendered DOM. They expose no API — Google runs `boq-hiring`, an internal
batchexecute RPC.

The design decision worth keeping: it anchors on the **job-URL pattern**, not CSS
classes. Google's class names are obfuscated and rotate (`div.sMn82b`), so a
selector-based scraper would break within weeks; `/jobs/results/{id}` does not.
Meta needed a second fix — it renders every card inside one shared container, so
the title has to come from the anchor's own text and be split from the location
it's glued to.

To add another rendered site, find its link shape first:

```bash
npx tsx src/render-probe.ts "https://careers.example.com/jobs?location=India"
```

then add an entry to `SITES` in `src/fetchers/rendered.ts`.

**Uber** is in too (400 postings). Its list lives at `jobs.uber.com/en/jobs`, not
the `uber.com/careers` URL the site links to, and its own location filter values
return zero results for every format tried — so it pulls unfiltered and lets the
India filter decide. That needed one more option: Uber's anchor holds *only* the
title, with the location four levels up the DOM, hence `cardUp`.

Watch for that trap when adding a site: if a listing isn't India-filtered by URL,
leave `indiaOnly` false. Setting it true made 399 of Uber's 400 global roles
inherit "India" and sail straight through the filter.

**Walmart is still open**, and it is not a selector problem — under headless
Chromium its results page renders no job links, no card containers and no result
count at all. That signature means bot detection, which a stealth plugin might
beat but nothing in this codebase will.

## 2. ~~Darwinbox~~ — SOLVED

**PhysicsWallah · Porter · LeadSquared · Tata 1mg · Licious · PharmEasy ·
Unacademy · Subex** are all polling now.

The documented API needs a key from Darwinbox's integration team, but the public
careers widget calls an unauthenticated endpoint:
`POST {tenant}.darwinbox.in/ms/candidateapi/job/alljobs`.

Two traps cost real time to find, both recorded in `src/fetchers/darwinbox.ts`:
`companyId` must be in the POST **body** (query string alone returns a
successful-looking empty result), and Cloudflare fingerprints the TLS handshake,
so Node's fetch is 403'd regardless of headers while `curl` passes.

Still missing on this platform: **upGrad** (tenant unresponsive) and **CleverTap**
(tenant resolves but reports zero open jobs).

Note: subdomain probing is useless here — `*.darwinbox.in` is a wildcard, so
`zzqqxxnotreal9999.darwinbox.in` responds exactly like a real tenant.

## 3. ~~TurboHire~~ — SOLVED

**Flipkart (61) · Purplle (55) · Navi (45)** are all polling now.

`POST thapi.azurewebsites.net/api/careerpagev2/filteredjobs?orgId={GUID}&pageType=2`,
with an anonymous bearer from `/api/token/noauth` — which only issues a token when
the request carries `Origin` and `Referer` for the tenant's careers domain.

The trap worth recording: **`pageType` selects the result set and the default is
wrong.** `0` returns a fixed 10-row teaser, `1` returns 6,862 rows (the full
historical corpus), and `2` returns the genuinely-open roles. Every pagination
parameter is ignored.

## 4. iCIMS — HTML only

**DocuSign** (and it fronts Atlassian, though they publish JSON separately)

Serves HTML with no JSON or RSS feed. DocuSign's APJ portal is
`apjcareers-docusign.icims.com`, so India roles exist — reading them needs an
HTML parser, which is a real adapter rather than a quick add.

## 4b. SuccessFactors — SOLVED

**SAP · Volvo Cars · ZF · Mahindra · HSBC** are all polling now.

The search *results page* really is server-rendered HTML with no backing JSON
endpoint, same as originally found — but both SuccessFactors variants also
publish a credential-free XML feed that the results page itself pulls from,
which sidesteps the HTML-scraper detour entirely:

- **Career Site Builder** (the modern frontend — SAP, Volvo, ZF, Mahindra):
  `GET {careers-host}/sitemal.xml` — yes, `sitemal.xml`, not a typo. A
  Google-Merchant-namespaced RSS 2.0 feed (`<item><g:id>`, `<g:location>`,
  `<g:employer>`). `token` is the full careers hostname (e.g. `jobs.sap.com`).
- **Legacy Recruiting Management** (career{N}.successfactors.{eu,com,cn} —
  HSBC): `GET {host}/career?company={code}&career_ns=job_listing_summary&resultType=XML`.
  No location field at all — only `JobTitle`, `Job-Description`, `ReqId`,
  `Posted-Date`. Location is recovered by testing the title+description text
  against the same India-city regex the rest of the project uses; a job is
  only kept once that match actually fires, which trades recall for zero false
  positives. `token` is the company code, `host` is the legacy career subdomain.

Both feeds are slow — 30s to ~170s for one company, roughly proportional to
its total job count worldwide — so the adapter uses its own 180s timeout
instead of the 30s default in `getJson`. `KPMG.de` and `careers.pwc.com`
resolve to the same XML format but returned zero India postings on the
regional tenant tested; worth re-probing with a properly-targeted APAC/India
tenant if either comes up again.

**Trap worth recording for Mahindra specifically**: it's an automotive
conglomerate, so its board is full of `Engineer - <vehicle part>` reqs
(Engines, Chassis, Transaxle, Powertrain, Body Systems) that bare-match the
`swe` family's `\bengineer\b` — same leak class as Thermo Fisher/GE Vernova,
fixed the same way (`classify.ts`'s `HARD_EXCLUDE`, not by narrowing the
family regex).

`detect.ts` can now recognize a SuccessFactors-powered careers page (it
already could) and says so explicitly, but still can't auto-derive the
token/host pair — extract those by hand per the technique above.

## 4c. Giants that placement reports keep naming, still unreachable

Cross-referencing 2025-26 placement reports from IIT Bombay, Delhi, Madras,
Kanpur, Kharagpur, NIT Trichy, BITS Pilani, IIIT Hyderabad/Bangalore/Delhi, DTU
and VIT Vellore turned up ~70 distinct recruiters. Most were already covered.
The ones that weren't, and why `detect` found nothing on their careers domain:

**Deutsche Bank, PwC, American Express, McKinsey, Bain, Alvarez & Marsal, EXL,
Axis Bank, ICICI Bank, HDFC Bank, KPMG, DE Shaw, VMware, Analog Devices,
Microchip, AMD, Arista, Infineon, Sony, Asian Paints, L&T, Tata Steel, BHEL,
Bosch, Bajaj Auto, Maruti Suzuki, Jaguar Land Rover, ExxonMobil, Lupin, ITC,
Eternal (Zomato), Myntra** — every one of these resolved to "no ATS link
found." At this scale, that's not a detection failure; it's the honest floor
of what unauthenticated public JSON endpoints can reach. These are exactly the
class of employer that builds (or buys) a bespoke careers portal rather than
adopting an off-the-shelf ATS. **Arm** confirmed running iCIMS (see §4); no
others revealed a platform at all, meaning they're either fully custom or
entirely client-rendered. (**IBM** belongs in this bucket too — a later pass
found three Oracle Cloud HCM tenants that *looked* plausible from the "ibm"
prefix alone, `ibmdjb`/`ibmxjb`/`ibmljb`; all three turned out to be unrelated
small orgs — a Guatemalan retail chain, an Iowa college and a Syracuse school
district — that happen to sit on tenants with those names. Verify every
resolved tenant against its actual job titles before trusting it, not just
against the HTTP status code.)

Several since resolved: **Bank of America** and **Rakuten** (Workday) were
already polled at 0 India/remote roles. Since added, all now live: **BlackRock**
(Workday), **Samsung** (Workday), **Qualcomm** (Eightfold — 300+ India roles,
by far the largest single addition from this pass), **Morgan Stanley**
(Eightfold), **Wells Fargo** (Workday), **Texas Instruments** (Oracle),
**Bloomberg** (Workday, 0 India roles currently but a real 58-job board),
**HSBC** and **Mahindra** (SuccessFactors, see §4b), **Intuit** (SmartRecruiters,
token `intuit2`), and — via `npm run probe` rather than `detect` — the quant
firms **Graviton Research Capital**, **Squarepoint Capital**, **NK Securities
Research** and **Da Vinci Derivatives** (all Greenhouse). **Optiver** also
resolved on Greenhouse (`optiverprivate`) but currently posts zero India
roles and wasn't added — Optiver has no visible India office, unlike the four
quant firms above.

## 4d. Platform parity check against github.com/kalil0321/ats-scrapers

That project publishes `ats-companies/*.csv` — crawled tenant lists per
platform, name+slug+URL, no India/relevance filtering applied. Diffing their
platform set against ours, then grepping their CSVs for names on *our* still-
unreachable list, is a much higher-signal move than re-deriving tenants from
scratch: **a company already resolved to a working URL by someone else's
crawler is a free answer**, it just needs a) the technique translated into
this project's `Company` shape and b) its actual returned job titles checked
before being trusted — see the IBM note above for why step (b) is not optional
even when the tenant slug looks right.

**Platforms both projects cover**: Greenhouse, Lever, Ashby, SmartRecruiters,
Workday, Oracle, Eightfold, Darwinbox, Phenom, SuccessFactors, plus
company-specific rendered-DOM scrapers (their `google.py`/`meta.py`/`uber.py`
≈ our `rendered.ts`). TurboHire is ours alone — not in their platform list.

**Real gap that paid off immediately**: their CSVs contain plenty of
already-covered companies alongside genuine misses, but grepping them for
names from §4c's "still unreachable" list surfaced tenants that a plain
careers-page crawl (`detect.ts`) never would, because these companies don't
link the board from an obvious `/careers` path. All confirmed against live
job titles, not just HTTP 200, and now polling: **KPMG India** (Oracle,
`ejgk`/`fa.em2`/`CX_1` — 496 India roles, easily the best single find of this
whole pass), **PwC** (Workday, `pwc`/`wd3`/`global_experienced_careers` — 328
India roles; note `global_campus_careers` on the same tenant returns 300 jobs
but zero India, so it's not interchangeable), **AMD** (SuccessFactors legacy,
`performancemanager4.successfactors.com`, company code `AMD`), **ExxonMobil**
and **BASF** (SuccessFactors modern, `jobs.exxonmobil.com` /
`basf.jobs` — 198 and 111 India roles respectively), **Infineon** (Eightfold),
**Microchip** (Workday), **Arista Networks** and **Continental**
(SmartRecruiters), **Lupin** and **Bajaj Auto** (SuccessFactors modern, on
vanity domains `careers.lupin.com` / `careers.bajajauto.com` — the modern
format's "hostname is the tenant" rule still holds even on a custom domain).

Bajaj Auto needed the same automotive-leak fix as Mahindra before shipping —
27 of its 406 India-relevant hits initially passed the `swe` family filter
purely on the automotive parts vocabulary (`vehicle testing`, `lighting
systems`, `plastic parts`, `casting & forging`, `steering systems`); added to
`HARD_EXCLUDE` the same way, bringing it down to 19 genuine software/embedded
hits (Full Stack Developer, Firmware Developer, Embedded Software Integration
Engineer, Android Developer — a real connected-vehicle engineering org, not
noise).

**Tried and dead**: **Walmart** (Workday `walmart`/`wd5`/`walmartexternal`
returns an HTML error page, not JSON — consistent with the bot-detection
finding in §1, this isn't a new way in). **Deutsche Bank**'s SmartRecruiters
token (`deutschebank`) 200s with `totalFound: 0` — dead, not just quiet; their
CSV also lists a `dbgroup` tenant on **Avature**, a platform neither project's
adapter set here covers. **HSBC** also has an Eightfold tenant
(`hsbc.eightfold.ai`) beyond the SuccessFactors one already polled, but it
403s outright — not worth chasing since HSBC's existing board already yields
165 India roles.

**Platforms they cover that we genuinely don't, assessed for ROI, not just
existence**:
- **iCIMS** — already a known, real gap (DocuSign, D.E. Shaw). Worth building.
- **Avature** — one real lead surfaced (`dbgroup` for Deutsche Bank,
  `jobs.siemens-healthineers.com`), not worth a new adapter for two companies.
- **Taleo, UKG, Dayforce, ADP, Paycom, Paylocity, JobVite** — grepped their
  CSVs against every name on our unreachable-giants list and every major
  German/European industrial we track elsewhere; came back essentially empty.
  These four are dominated by small US franchises and local nonprofits (Boys &
  Girls Clubs chapters, single car dealerships) in the crowdsourced data — not
  the employer tier this project targets. Not worth building.
- **Cornerstone, Workable, Rippling** — a handful of real names surfaced
  (Henkel, Nestlé Waters North America) but nothing from the target list; same
  call as above.
- **Keka** — the one platform worth a second look on principle (it's an
  Indian-built HR suite, so it's structurally more likely to carry Indian
  employers than a US-centric ATS) — but their `keka.csv` (186 companies) was
  checked by name against every Indian unicorn/startup this project has
  chased (Meesho, Groww, Zerodha, Razorpay, Swiggy, CRED, Zepto, Udaan,
  Unacademy, ...) and none appeared; the listed companies are small, mostly
  unrecognizable SMEs. Genuinely low-ROI right now, not "we didn't check."
- **Single-company rendered scrapers** (Apple, Tesla, TikTok, ByteDance,
  YCombinator, Mercor) — same technique as our `rendered.ts`, just for
  different companies; would need the same per-site `render-probe.ts`
  treatment as Google/Meta/Uber got. Not attempted this pass.
- **Everything else in their platform list** (Arbetsformedlingen, Bundesagentur,
  EURES, Jobs.cz, Jobs.ch, InfoJobs.es, JobBankCA, HRMOS, HERP, Moka, Beisen,
  Gupy, GetOnBrd, Programathor, TheHub, WelcomeToTheJungle, Manfred, Wanted,
  USAJobs, Seek, RemoteOK, WeWorkRemotely, Wellfound) is either a
  country-specific government job portal or a general job-board aggregator —
  a fundamentally different sourcing strategy (scrape a public board) than
  this project's design (poll each company's own ATS), and none are
  India-relevant. Out of scope by design, not an oversight.

**TCS, Infosys, Wipro, Cognizant, HCL, Hexaware, LTIMindtree, Genpact** all
appeared repeatedly across every campus's recruiter list — correctly excluded
by `SERVICE_COMPANIES` regardless of platform, per your standing instruction.

## 5. Newly announced GCCs — two solved, three genuinely empty

The first sweep for these used `curl` on static HTML and found nothing. Re-probing
with headless Chromium — which sees content that only exists after JS runs —
turned up two of the five:

- **Vanguard** ✅ — `vanguardjobs.com/job-search-results/?country=India`, 458 jobs,
  with the city encoded in the URL slug (`…-hyderabad-in/`). That prompted a
  general improvement: location is now matched against the href as well as the
  card text, since slugs routinely carry a city the rendered card omits.
- **DAZN** ✅ — `careers.dazn.com/en`, 123 postings on its own platform (the
  `/postings/{uuid}` shape looks like Lever or Ashby but is neither; both APIs
  return zero for every token spelling).

**McDonald's, T-Mobile and Best Buy render no job links at all**, even headless.
T-Mobile reports 2,087 jobs on the page yet exposes no per-job link shape; Best
Buy times out. All three are US-centric sites whose India centres were announced
but are not yet posting requisitions — there is nothing to read until they do.

Both Vanguard and DAZN currently return **0 matches**, which is the correct
answer, not a broken adapter: their live India roles are senior, and their new
centres haven't opened entry-level requisitions. Both are polled hourly, so the
first fresher role either posts will reach you within the hour.

---

## Fastest way to help

For any company you actually care about from the lists above:

1. Open their careers page
2. F12 → **Network** → **Fetch/XHR** → reload
3. Find the JSON response containing job titles
4. Copy the link address and send it to me

That single step is what turned Cisco into 247 India jobs and Microsoft into 160.
