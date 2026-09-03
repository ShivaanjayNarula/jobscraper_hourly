# Build phases — post-survey plan (2026-08-23)

Clubs the ~20 MISS features from `docs/FEATURE-SURVEY.md` into six phases,
ordered by value-per-effort and dependency. Each phase is one sitting's work,
ends green (`npx tsc --noEmit && npm test`), and ships alone. Numbering
continues the mental model of ROADMAP.md's old 12 stages; stages 2/4
(Telegram/Discord) stay deferred per user decision.

## Phase A — Signal quality (deterministic classification)

The three features that make every future alert smarter. All regex/
bookkeeping — no new surfaces, all covered in `selftest.ts`.

1. **Salary extraction** (#38) — parse ₹ LPA / CTC / stipend / K-monthly
   formats out of title+description into normalized `salaryMin`/`salaryMax`
   (₹ LPA). Put on email cards + web UI cards. Extend `HARD_EXCLUDE` for
   unpaid/ commission-only junk this surfaces.
2. **Repost detection** (#28) — track ids that leave `liveIds` then return;
   alert again flagged "reposted". Bounded memory: only remember ids for a
   rolling window (e.g. 30 days) in the existing state-file pattern.
3. **Visa-sponsorship + work-mode normalization** (#42/#43) — deterministic
   keyword pass ("visa sponsorship", "remote" scope) into typed fields so the
   email/UI can filter on them later.

Why first: pure signal gain, zero infra risk, directly improves every email.

## Phase B — Silent-failure defenses (self-healing) — DONE 2026-08-23

The autopsy's #1 lesson: projects die of unnoticed breakage. This phase makes
quiet rot loud.

4. **Per-board volume anomaly detection** (#96) — SHIPPED (`src/volume-stats.ts`,
   `state/board-volumes.json` + `state/volume-drops.json`, auto-issues via
   hunt.yml's "Report suspected board volume drop" step, label `board-drop`).
5. **Expected-vs-actual reconciliation** (#98) — SHIPPED as a loud
   reconciliation warning in `index.ts` when selected boards outnumber results.
6. **Cross-board content dedup** (#6) — SHIPPED as normalized-company-name
   dedup key. The originally imagined stronger version (collapsing identical
   titles across *different* companies) was deliberately NOT built while here:
   two companies posting "SDE 1, Bengaluru" are two distinct opportunities,
   and collapsing them would hide real leads. The real multi-board case is one
   employer under differently-normalized names, which the key now covers.

## Phase C — Web UI depth (client-side only, no backend) — DONE 2026-08-23

7. **Faceted filters** (#64) — SHIPPED: work-mode chips, ₹ LPA salary-band
   select (reads off the band's top — a 10–14 LPA posting clears a 12 floor),
   visa-sponsorship chip. Fed by the new catalogue fields.
8. **URL-state sync** (#65) — SHIPPED: every filter round-trips through
   URLSearchParams with replaceState; read on mount (build-time safe).
9. **Exclude keywords + saved/applied marks** (#45/#80 thin) — SHIPPED:
   localStorage-only personal junk words and per-job ★/✓ marks with a
   hide-applied toggle. Client-side by design, same carve-out philosophy as
   HARD_EXCLUDE but personal.
10. **Company view** (#69) — SHIPPED as an inline stats strip (open count +
    first-seen-last-30-days when a company is selected) rather than generated
    pages: a static export can't cheaply produce ~1,000 per-company routes,
    and the strip answers the actual question (is this employer actively
    hiring?) without them. Revisit only if traffic ever justifies it.
11. **Recency sort** (#53) was already client-side (crawledTime desc within
    groups). **CSV export** (#76) — SHIPPED as `npm run query -- --csv`.

Catalogue change enabling the facets: `CatalogEntry` gained `salaryMin/`
`salaryMax/workMode/visa` (a few bytes/entry; `isRepost` deliberately excluded
as alert-time state, not a property of the posting).

## Phase D — Trend intelligence — DONE 2026-08-23

Needs no new state: the catalogue's own `firstSeen` is the only clock hiring
velocity needs, and Phase A's salary fields feed the medians directly.

12. **Hiring-velocity trending** (#54) — SHIPPED: `companyVelocity()`/
    `rampingCompanies()` in `src/trends.ts` (open count, new-in-30d, churn-in
    ratio; floors of 8 open / 3 new keep one-posting companies out). Surfaced
    two ways: `npm run trends` CLI report, and a quiet "Ramping" strip in the
    email computed from the pre-update catalogue (aggregate view lags one run
    by design, zero extra state).
13. **Salary trend aggregates** (#39 partial) — SHIPPED as the second half of
    `npm run trends`: median offered band per role family per calendar month,
    bucketed by firstSeen; postings without an extracted band are skipped so
    unparsed salaries never dilute a median.
14. **Cert/skill demand analytics** (#47) — NOT BUILT, deliberately: fun but
    answers no question this single-user tool actually asks. Revisit only if
    that changes.

## Phase E — Interfaces — partially SHIPPED 2026-08-23 (deployed cold-emailer)

**Deployed outreach — reworked 2026-08-24 after review found four real bugs**
(none had shipped: the workflow had never been run, so no address was ever
published). What was wrong, because each is a trap worth not re-entering:

1. The state restore curled the Contents API without an accept header, writing
   the base64 *envelope* into `state/contacted.json`. That parses as valid JSON
   of the wrong shape, so dedup silently found no ids and re-offered everyone
   already mailed — then committed the envelope back over the real state.
   `src/publish-outreach.ts` now decodes properly.
2. The page and draft map were written to `web/public/`, which Vercel serves at
   a guessable URL, in a **public** repo. The draft map is keyed by real
   engineers' work addresses. Both now live in a private data repo
   (`OUTREACH_DATA_REPO`); nothing personal is committed here.
3. The click-API computed follow-up gaps as `GAPS[touch - 1]` while the source
   of truth uses `GAPS[touch]`, so every follow-up fell due one slot early and
   the first one was due immediately. Now shares the clamp.
4. `putJson`'s failure was ignored and the redirect to Gmail happened anyway —
   a lost write means a follow-up later goes out as a first touch. Writes now
   retry on a fresh sha and hard-fail the request rather than redirect.

Also added: every route requires `?k=<OUTREACH_KEY>`, since the ids are
addresses and an ungated API let anyone mark the campaign skipped.

**Deployed outreach:** the cold-email batch builder runs in GitHub Actions,
triggered either by the green `workflow_dispatch` button or automatically on a
**daily 09:00 IST cron** (`.github/workflows/outreach.yml`, `30 3 * * *` UTC —
change to `30 3 * * 1-5` for weekdays-only, matching the sending plan). It
publishes the batch to a private data repo, which the Vercel site serves at
`/api/outreach/page?k=<key>`. The site header (`web/app/page.tsx`) has an
"Outreach batch" button that opens that page — the key is prompted once and
kept in `localStorage`, never in the bundle, since the batch is keyed by real
people's addresses and this repo is public. Card buttons point at serverless
routes (`/api/outreach/open|mailapp|replied|skip|bounce/[id]`,
`web/app/api/outreach/...`) which record clicks into the private repo's
`contacted.json` through the GitHub Contents API — identical bookkeeping to the
localhost server, hosted.

**Fully configured and verified live as of 2026-08-24**: `OUTREACH_GH_TOKEN`,
`OUTREACH_KEY` set as GitHub Actions secrets; `OUTREACH_DATA_REPO`,
`OUTREACH_LINK_BASE` set as Actions variables; the same three set as Vercel
env vars (confirmed indirectly — the deployed route returned 403 on a wrong
key rather than 500 "not configured"); the private `outreach-data` repo's
`main` branch initialized (it had zero commits, which would have failed the
workflow's first push — fixed by creating a README via the Contents API
directly, since GitHub's create-file-contents endpoint can bootstrap an empty
repo's default branch on its own).

Caveats documented in the workflow: Actions runners block port 25, so SMTP
verdicts degrade to `unknown` there; verdicts cached in `contacted.json` last
14 days, so a periodic local `npm run outreach` run is what keeps a
CI-built batch mostly verified rather than all-`unknown`. This forced one
config change: web dropped `output: 'export'` so the route could exist — the
job page is still client-fetching and needs no redeploy for hourly data.

See `HANDOFF.md`'s "Cold outreach" section and `COLDMAIL-PLAN.md` for the full
design, the four review-caught bugs this rework fixed, and what's still not
built (actually sending the first real email, the domain-age/warmup ramp).

Still open from E:

15. **MCP server over the catalogue** (#73) — wrap `query.ts`'s filtering in
    read-only MCP tools; makes the corpus usable from any AI client.
16. **Public REST API** (#74) — same core behind HTTP if ever hosted beyond
    Vercel-static.
17. **Dataset publication** (#105) — the `data` branch already exists; add a
    daily Parquet/JSON snapshot job only if external users become real.

Trigger for starting E: the user asks for agent access or an audience forms.
Not before.

## Phase F — Deferred by user decision

Telegram bot channel, Discord/Slack webhooks (old stages 2/4). Code stays a
small, isolated sender module whenever activated; nothing else depends on it.

## Explicitly not phased (rejected classes, unchanged)

Proxies/CAPTCHA solving, login-based scraping (LinkedIn/Indeed/Upwork),
auto-apply bots, resume generation, Airtable/Sheets service backends, curated
list maintenance. See FEATURE-SURVEY rejected items and ROADMAP's rejected
section.

## Sequencing logic

A → B because extracted fields make anomaly baselines richer; B → C/D because
UI facets and trends both consume histories/fields; E and F are opt-in. A and
B together are roughly two sessions; C is the biggest single chunk and can be
split (7–8 then 9–11) without harm.
