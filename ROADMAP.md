# Roadmap

Plain-text version of the roadmap for agents that can't render the HTML
artifact — same content, checklist format. Human-readable version with the
comparable-project tables lives at the published artifact (ask the user for
the link, or see `HANDOFF.md` for where it's linked from).

Survey basis: 38 comparable open-source job-alert / ATS-scraping projects
researched across two rounds (18 + 20), plus this repo's own open gaps in
`HANDOFF.md` and `ADDING-COMPANIES.md`.

## How to read this if you're an agent picking up one stage

Each stage below is meant to be handed to an agent (Claude or freebuff) on
its own. If it's tagged `freebuff: yes`, the prompt handed to freebuff must
still restate full context — freebuff has no memory of this file — per
`.claude/skills/freebuff-delegate/SKILL.md`. If it's tagged `freebuff: no`,
it touches regex correctness, dedup/rate-limit logic, or a bug class this
repo has already shipped once (see `HANDOFF.md`'s "recurring bug class"
section) — do it directly, run `npx tsc --noEmit && npm test` before calling
it done.

## Phases (priority buckets)

| Phase | What | Status |
|---|---|---|
| 0 | Ship what's already built (deploy `web/` to Vercel) | now |
| 1 | Cheap reach & observability (Telegram, outage surfacing, Discord/Slack) | now |
| 2 | Coverage expansion — freebuff-heavy research rounds | next |
| 3 | New adapters (iCIMS, Uber/Walmart) | later |
| 4 | Query surface over the catalogue (CLI) | later |
| 5 | Parked trade-offs (LLM enrichment, multi-user filtering) | parked, revisit only if priorities shift |
| — | Explicitly rejected: LinkedIn/Indeed scraping, browser-extension tracking | not on the roadmap |

## Build order — 12 stages, in sequence

- [ ] **1. Deploy `web/` to Vercel** — `freebuff: no` (needs the user's own account). Root directory `web`, env var `NEXT_PUBLIC_REPO`. No dependencies.
- [ ] **2. Telegram bot channel alongside email** — `freebuff: partial` (freebuff drafts the send boilerplate; Claude wires it into `email.ts`'s freshness/backlog gating — that gate broke once before, see `HANDOFF.md`). Blocks stage 4.
- [x] **3. Surface outage detection as an issue/comment** — ALREADY DONE (commit `65ba33b`, predates this roadmap). `hunt.yml`'s "Report suspected ATS outage" step already opens/closes a GitHub issue per platform on `outage_started`/`outage_recovered`. This roadmap line was wrong — written from `HANDOFF.md`'s prose without checking the actual workflow file.
- [ ] **4. Discord/Slack via the same webhook shape** — `freebuff: partial`. Depends on stage 2.
- [ ] **5. freebuff round — close out the 25 CONFIRMED-but-unadded companies** — `freebuff: yes`. ClearTax, Licious, Porter, Spinny, Lenskart, Urban Company, etc. — credentials already in `HANDOFF.md`, need fetcher-verify pass before `companies.json`.
- [x] **6. Re-add the 8 auto-dropped Darwinbox companies** — ALREADY DONE, predates this roadmap (commit `97876f4`, 2026-08-17, one day before this roadmap existed). All 8 confirmed present in `companies.json` with real tenant tokens (PhysicsWallah `pwhr`, PharmEasy `myhr`, Tata 1mg `1mg`, etc.) — verified directly via `git log`, not freebuff. All 8 currently share one `failingSince` timestamp (a platform-wide Darwinbox block, same shape as before) — correctly *not* evicted, `outage.ts` holding as designed.
- [x] **7. Platform-parity diff vs kalil0321/ats-scrapers** — MOSTLY ALREADY DONE. `ADDING-COMPANIES.md` §4d is this exact diff, already run, already paid off: KPMG (496 India roles), PwC (328), AMD, ExxonMobil, BASF, Infineon, Microchip, Arista, Continental, Lupin, Bajaj Auto all added from it. This roadmap line was written from `HANDOFF.md`'s summary without checking `ADDING-COMPANIES.md`'s fuller detail — same staleness pattern as 3/6/10/11. Real remaining work is a periodic *refresh* (their CSVs update over time), not a first pass — ran `npm run bulk-import` fresh on 2026-08-18 to check for anything new since §4d.
- [ ] **8. Zwayam retry + CIBC Workday site-slug recovery** — genuinely blocked, not just undone. Zwayam: connection failures from this exact machine/network before (`HANDOFF.md`), needs a different network to even test. CIBC: 406s without real browser headers, needs a rendered-fetch approach like `rendered.ts`, not a plain lookup. Freebuff can't fix either — infra gap, not a research gap.
- [x] **9. Re-check "unreachable" giants** — MOSTLY ALREADY DONE. `ADDING-COMPANIES.md` §4c already re-checked this exact list with real findings, not just "still unreachable": Deutsche Bank's SmartRecruiters tenant confirmed dead (`totalFound: 0`), Walmart's Workday returns an HTML bot-block page not JSON, HSBC's second (Eightfold) tenant 403s, IBM's three lookalike Oracle tenants confirmed to be unrelated orgs. Genuinely still open, never explained this thoroughly: **McKinsey, Bain, VMware** — only "no ATS link found," no confirmed reason. Worth one more real look at those three specifically, not the whole list again.
- [x] **10. iCIMS adapter** — MOSTLY ALREADY DONE, doc was stale again. `icims.ts` already reads iCIMS's real `/api/jobs` JSON endpoint (no JSON-LD parsing needed — that was a leftover premise from before the adapter existed), live-confirmed against DocuSign. D.E. Shaw checked 2026-08-18: their public careers page shows no iCIMS link at all, so the "D.E. Shaw runs iCIMS" assumption is unconfirmed — needs real research to find their actual ATS before any code gets written, not a code task.
- [x] **11. Uber / Walmart via headless render** — ALREADY DONE, doc stale a third time. `companies.json` has Uber on `ats: rendered` with `lastIndiaAt` set (live, finding roles), and Walmart tracked twice already (SmartRecruiters `Walmart30` + Workday `wd504/WalmartExternal`), both polling. Checked 2026-08-18 before starting — do not rebuild.
- [x] **12. Query CLI over `data/jobs.json`** — DONE (`src/query.ts`). `npm run query -- --role swe --company X`, reuses `filter.ts`'s `roleFamily()` — no new backend. Verified working against the live catalogue.

Stages 5–9 are five separate freebuff sessions. freebuff is single-instance
with no cross-session memory — one stage per session, prompt fully restated
each time, per the freebuff-delegate skill.

## Parked — deliberate trade-offs, not oversights

- **LLM enrichment as an opt-in secondary pass** (salary/skills only, never
  replacing `classify.ts`'s deterministic regex core — "every mistake is one
  line in `classify.ts`" is a real, load-bearing property). No comparable
  project found does per-industry seniority vocabulary the way this repo
  does; the closest thing (`rootstrap/ai-job-title-level-classification`) is
  title-only ML with no industry awareness. Confirms the regex approach is
  unusual by design, not by neglect.
- **Per-user / multi-profile filtering** — every comparable project surveyed
  except one small Telegram-bot toy hardcodes a single filter config, same as
  this repo. Only worth building if this project's audience changes from
  "for me."

## Explicitly rejected — don't re-propose without new information

- **LinkedIn/Indeed/meta-search scraping** (the JobSpy/most-Discord-bot
  approach) — breaks this repo's zero-cost, no-scraping, no-proxy identity.
  Batch 2 confirmed this is *also* the fragile path in practice: nearly every
  Discord-bot job-alert repo found scrapes LinkedIn/Glassdoor with
  Cloudflare-bypass hacks rather than reading a public JSON endpoint.
- **Browser-extension application tracking** (Huntr/Simplify-style,
  confirmed as a whole healthy genre in batch 2 — 5+ local-first extensions
  found) — a different product, the "after you found the job" half of the
  funnel, not a discovery-pipeline feature.

## Research addendum (batch 2 — 20 more projects)

Findings that update or sharpen the original 18-project survey:

- **`ever-jobs/ever-jobs`** is a stronger "what this could grow into"
  reference than `freehire` (batch 1) — 160+ sources, 38 ATS platforms,
  ships REST + GraphQL + CLI + MCP server simultaneously. Worth a closer look
  specifically for stage 12.
- **India-specific job tooling in the wild is Internshala clones or dead
  markdown lists** — nothing does ATS-board polling for this audience the
  way this repo does. Genuine differentiation, not one-of-many.
- **RSS-as-delivery-channel isn't a real gap.** Even RSSHub (45.8k stars, the
  category leader) has zero job-board routes. Safe to leave off the roadmap.
- **No comparable project does per-industry seniority classification** —
  confirms this repo's regex-vocabulary-per-industry design is genuinely
  unusual, reinforcing the "parked, not missing" framing on LLM enrichment.

Full per-repo detail for both survey rounds is in the published HTML
roadmap artifact (ask the user for the link if picking this up fresh).
