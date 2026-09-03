# Feature survey — 130 comparable repos, 100+ features inventoried

Companion to the batch-3 research addendum in `ROADMAP.md`. Every feature
below was observed in a real repository README during the 2026-08-23 sweep
(580 repos collected, 130 relevant, all 130 READMEs read). Features are
grouped by pipeline stage; each carries its source repo(s) and this repo's
status: **HAVE**, **MISS** (worth considering), or **PARKED**
(deliberately not built — see ROADMAP's parked/rejected sections).

## A. Source coverage & ingestion

1. Multi-ATS JSON API polling (Greenhouse/Lever/Ashby/Workday/SmartRecruiters) — kalil0321/ats-scrapers, adgramigna/job-board-scraper, Feashliaa/job-board-aggregator, MabudAlam/JobsScraper. **HAVE** (20+ platforms).
2. India-only ATS adapters (Darwinbox, TurboHire, Keka, Zoho Recruit, Freshteam, Recruiterflow, iCIMS-legacy, Trakstar, Zwayam…) — nobody else has these. **HAVE** (unique).
3. First-party career APIs (Amazon, Apple, Google, TikTok, Uber, Meta GraphQL) — kalil0321/ats-scrapers, Flare. **PARTIAL** (rendered-board entries for Google/Meta/Uber; no Meta GraphQL).
4. Aggregator boards beyond per-company ATS (RemoteOK, Remotive, WeWorkRemotely, WorkingNomads as sources) — Fighter90/career-ops-ui, Hiring-Radar. **MISS** (rejected class per identity? These are public JSON feeds, actually compatible — reconsider).
5. National job boards (104.tw, Cake, Jobindex.dk, MyNavi.jp, HRMOS, MokaHR) — amikai/openings-mcp. **PARKED** (out of region).
6. Telegram channels as job sources — spichkinevgeniy/JobMonitor. **PARKED** (needs Telethon login).
7. Upwork/freelance feeds — asaniczka, sudhamjayanthi, roperi. **REJECTED** (not the user's market).
8. Company registry with hiring-country metadata derived from postings — outscal/OpenJobs `countries` array. **MISS** (would automate wrong-company token-collision checks).
9. Community company-submission flow (one-line PR adds a company) — open-jobs `contributed-slugs.txt`. **MISS** (single-user tool today; relevant only if audience grows).
10. Paste-a-careers-URL → auto-detect ATS → preview jobs → save flow — Flare v1.10. **PARTIAL** (`detect.ts` does detection + probe; no interactive preview/save loop).
11. Weekly Common Crawl / referral-site discovery sweeps — (our own design). **HAVE**.
12. RSS feed monitoring for source health — our discover-news.ts. **HAVE**.

## B. Fetching hygiene & anti-blocking

13. Per-rate-limit-domain concurrency scheduling (pod-aware for Workday) — ours. **HAVE** (nobody else does this; MabudAlam caps at flat 15 concurrent).
14. 429/503 retry with backoff — common (llorenspujol "handles 429"). **HAVE**.
15. Response body bot-wall classification (rate_limit/challenge/waf_block/structural) — ported from fastCRW. **HAVE** (unique).
16. Block-aware eviction hold (don't evict during platform-wide outage) — ours. **HAVE**.
17. TLS-fingerprint matching to defeat Cloudflare (curl_cffi / curl-impersonate) — asaniczka/Upwork-Job-Scraper ("Chrome TLS fingerprint matching bypasses Cloudflare"), documented in our curlJson() escalation path. **HAVE as documented path** (deliberately not installed).
18. Cookie-export reuse for authenticated scraping — ifqygazhar/jobscraper-api (`sample_cookie.json`). **REJECTED** (login-based).
19. Proxy rotation — arshka, luminati-io, oxylabs tutorials. **REJECTED** (identity: zero-cost, no proxies).
20. CAPTCHA solving services — proxidize/reddit-scraper pattern. **REJECTED**.
21. Adaptive scrape-interval per site — roperi/UpworkScraper customizable interval. **HAVE better** (hot/cold rotation on measured runtime budget).
22. Scrape-once-per-day dedup against re-fetching same HTML — adgramigna (S3 HTML cache). **PARTIAL** (seen.json dedups postings, not raw fetches; hot boards refetch hourly by design).

## C. Identity, dedup & history

23. Posting dedup by external id — universal. **HAVE**.
24. Dedup by content hash rather than platform id — MabudAlam/JobsScraper (`job_id` content hash), asaniczka (Upwork cipher). **PARTIAL** (we key on ats+token+externalId; no cross-board content hashing).
25. Cross-board collapse of the same role posted to multiple boards — freehire ("same role posted to three boards collapses into one"). **MISS**.
26. Canonicalized source-URL identity — colophon-group/jobseek. **EQUIVALENT** (our id scheme serves this).
27. One-alert-per-lifetime seen-state — ours. **HAVE**.
28. Repost detection with new/reposted labels — Flare v1.10. **MISS** (top-ranked gap).
29. Snapshot vs history decision, documented — open-jobs (daily overwrite, "yesterday's is gone"). **HAVE** (data branch force-push single commit; deliberate).
30. Append-only daily trend log (JSONL) — Feashliaa (`trends/daily.jsonl`). **MISS** (needed for gap #5 volume anomaly + hiring velocity).

## D. Screening, classification & enrichment

31. Location screening (include/exclude regex) — universal. **HAVE**.
32. Role-family classification via broad family regexes — ours. **HAVE better** than anyone surveyed.
33. Per-industry seniority vocabulary (Associate ≠ Associate at banks) — ours. **HAVE** (unique; confirmed again across all 130).
34. Hard-exclude carve-outs instead of narrowing family regex — ours. **HAVE**.
35. Experience-range parsing (min/max years) — spinlud/py-linkedin-jobs-scraper outputs it; PyjamaHR board exposes it natively. **HAVE** (from API fields where present).
36. Internship/fresher flagging — ours (isIntern). **HAVE**.
37. LLM-extracted structured fields (~34 fields: level, function, salary_min/max_k, work_mode, remote_scope, visa_sponsorship, skills, alt_titles, years_experience_min) — elliottdehn/open-jobs. **PARKED** (documented trade-off; deterministic core stays).
38. Salary extraction from JD text → salary_min_k/salary_max_k — open-jobs. **MISS** (ranked #1 actionable gap; deterministic regex version fits our philosophy).
39. Salary normalization across currencies/FX for regional comparison — golang-cafe/job-board FX API. **MISS** (extension of #38; ₹ LPA normalize).
40. Skills extraction/tagging — open-jobs `skills`. **PARKED** (LLM).
41. Alternate-title embeddings (each title variant embedded separately) — open-jobs. **PARKED**.
42. Visa-sponsorship field — open-jobs. **PARKED/MISS** (regex-detectable keyword; could be deterministic — worth adding to classify.ts eventually).
43. Work-mode field (remote/hybrid/onsite + scope) — open-jobs `work_mode`/`remote_scope`; jobseek facets. **PARTIAL** (remote matching in locationMatches; no normalized field).
44. Job tier tagging intern/entry/mid/senior via weighted keyword scoring — Feashliaa. **HAVE equivalent** (seniority classifier, industry-aware).
45. Exclude-keyword filtering in UI — Feashliaa, UmaisZahid ("keywords to exclude render rating void"). **PARTIAL** (HARD_EXCLUDE server-side; no user-facing exclude).
46. Keyword-weighted relevance rating of titles+descriptions — UmaisZahid/Indeed-Job-Scraper scoring model. **MISS** (we binary-classify; a score could order the email).
47. Certification-demand analytics over posting corpus (which certs appear in how many JDs) — CarterPerez-dev/exs-cyberjob-scraper (278K postings scanned). **MISS** (fun aggregate; low priority).

## E. Matching & ranking

48. Convex-hull recall filter then LLM judgment inside it — open-jobs hull.py. **PARKED**.
49. Pairwise Bradley-Terry ranking distilled into a linear model — open-jobs btrank.py. **PARKED** (methodologically interesting; noted for later).
50. Embedding-only recall ranker (lexical seed → ridge ranker) — open-jobs rank.py. **PARKED**.
51. Resume-vs-JD match scoring (ATS compatibility score 0–100) — espin086/GPT-Jobhunter, Rayyan9477/AutoApply. **PARKED** (resume-side product).
52. Semantic search over JDs via pgvector — strelov1/freehire. **PARKED**.
53. Freshness ordering ("just posted" first) — ours puts freshness on cards; email orders tech/finance not recency. **PARTIAL** (recency sort within sections would be cheap).
54. Hiring-velocity trending per company (month-over-month posting-count delta) — Hiring-Radar `--recent-days` + monthly diff. **MISS**.

## F. Delivery & alerting

55. Email digest with subject-line counts — ours. **HAVE**.
56. Fresh vs backlog demotion in one email (nothing gated to invisible) — ours. **HAVE** (unique lesson-earned design).
57. Telegram delivery — Liopleurodon roadmap, JobMonitor, golang-cafe. **DEFERRED** (user declined stages 2/4 for now).
58. Discord/Slack webhooks — Liopleurodon, tramcar ecosystem. **DEFERRED**.
59. Desktop push notifications — Flare (macOS). **PARKED** (email suffices single-user).
60. Browser-extension delivery — richardadonnell/Upwork-Job-Scraper extension. **REJECTED**.
61. Weekly digest variant alongside instant alerts — tramcar (Mailchimp weekly). **MISS** (trivial cron variant of existing email if ever wanted).
62. Auto-email job owners/admins on events — tramcar. N/A (no posters here).

## G. Surfaces & UI

63. Static web catalogue over the data branch — ours (Vercel). **HAVE**.
64. Faceted search (occupation, seniority, technology, location, work mode, employment type, salary, language) — jobseek Typesense. **MISS** (client-side version feasible over jobs.json).
65. URL-state-synced filters (shareable/bookmarkable search state) — Feashliaa. **MISS** (pairs with #64).
66. Progressive loading of chunked gzip data via Web Workers — Feashliaa. **MISS** (relevant when catalogue grows; current size fine).
67. Map/heatmap view of job density by location — Feashliaa geolocation heatmap. **MISS** (nice-to-have).
68. Interactive map listings (Leaflet) — NuxtMint/recruiterre-mint. **MISS** (same class as #67).
69. Company pages (active + last-year counts, similar employers) — jobseek. **MISS** (jobs.json has per-company data; static page generation cheap).
70. Job desk with kept/applied states + refresh sidebar showing what each poll found — Flare v1.10. **PARTIAL** (debug.ts shows per-board results CLI-side; no persistent UI surface).
71. Dashboard terminal UI over pipeline — OpenJobs fork dashboard/. **PARKED**.
72. CLI query tool over catalogue — ours query.ts. **HAVE**.
73. MCP server exposing search/posting/company tools — jobseek hosted MCP, openings-mcp, JobSync, ever-jobs. **MISS** (parked unless agent access wanted).
74. Public REST API over corpus — jobseek, ever-jobs. **MISS** (same trigger as #73).
75. GraphQL interface — ever-jobs. **PARKED** (REST/MCP first if ever).
76. Excel/CSV export of results — DEENUU1/job-scraper, umur957 (chunked Excel). **PARTIAL** (query.ts prints; no file export flag).
77. Google Sheets export — DEENUU1, aminsadidi (GSHEET_CREDENTIALS). **REJECTED** (service dependency).
78. Airtable as storage/display backend — olindgallet/jobscraperv2, adgramigna. **REJECTED** (service dependency; also died-of-rot exemplar).
79. i18n/multi-language first-class UI — jobseek (DE/FR/IT). **PARKED** (single-user English).

## H. Application tracking & workspace (post-discovery)

80. Saved → applied → interviewing → offered/rejected stage tracking — jobseek, Gsync/jobsync, zacspa. **PARKED** (single-user; localStorage trivial if wanted).
81. Interview-round logging with interviewers/notes/calendar links — zacspa/JobApplicationWizard. **PARKED**.
82. Contacts/recruiter CRM (name, title, email, referrals) — zacspa, AkbarDevop/ai-job-agent. **PARKED**.
83. Evidence library (prior resumes/KSC answers indexed for reuse) — Keljian/JSE. **PARKED**.
84. Response-rate stats per board/source ("what needs action") — dear-hiring-manager `/board`, jobseek pipeline stats. **PARKED**.
85. CSV import/export round-trip + JSON backup of tracker — zacspa. **PARKED**.
86. Referral-chain outreach tracking (cold-email funnels) — AkbarDevop/ai-job-agent. **REJECTED** (outreach automation is a different product; our outreach.ts is research-contact discovery only).

## I. AI-agent surfaces

87. Evaluate-posting skill (A–F/A–G graded reports: background match, comp, tailoring plan, interview prep) — santifer/career-ops, RajjjAryan/career-copilot. **PARKED** (LLM; different lane than discovery).
88. Auto-pipeline: paste job URL → validate → fetch → evaluate → save report — career-ops-ui `#/auto`. **PARKED**.
89. Cover-letter/resume generation from JD — many (AIHawk forks, Magic-Resume, claude plugins). **REJECTED** (application-side product).
90. Auto-apply form filling — srikar-kodakandla, AutoApply*, jmopr/job-hunter. **REJECTED** (explicitly off-roadmap).
91. Company deep-research via live LLM SDK calls — career-ops-ui. **PARKED**.
92. AGENTS.md-as-manual so an LLM can drive the whole pipeline — open-jobs. **HAVE** (AGENTS.md/HANDOFF.md pattern predates and matches).
93. Local-model fallback for parsing when cheap paths fail — Flare (optional local AI for unknown sites). **PARKED**.

## J. Ops, reliability & observability

94. Scheduled GitHub Actions runs — universal (adgramigna, Feashliaa, ours). **HAVE** (hourly — fastest cadence surveyed; next-fastest Liopleurodon's 10-min web/1h API split, self-hosted).
95. Platform-wide outage detection with auto-issue open/close — ours. **HAVE** (unique; Feashliaa's anomaly check is the closest cousin).
96. Per-platform volume anomaly detection opening issues — Feashliaa check_anomalies.py. **MISS** (gap #5; covers silent partial loss ours doesn't).
97. Host latency/error percentile logging with rolling worst-N persistence — ours host-stats.ts. **HAVE** (unique at this scale).
98. Expected-vs-actual scrape-count reconciliation per run — adgramigna compare_workflow_success.py. **PARTIAL** (run logs counts; no assert/alert on shortfall — overlaps #96).
99. Cold-start correctness (never report/send from empty cache) — ours (out/-empty guard). **HAVE** (bug-born; nobody else even faces it since they don't run on ephemeral runners).
100. State-file persistence via Actions cache with eviction-safe sizing — ours (seen.json screening-before-recording discipline). **HAVE** (unique).
101. Self-healing eviction with block holds and day-clocks — ours. **HAVE**.
102. Dead-source naming in health logs (which feed failed, not just count) — ours discover-news.ts. **HAVE**.
103. Regression suite where every case is a bug that shipped — ours selftest.ts. **HAVE** (unique discipline among the 130).
104. Typecheck gate before ship — ours. **HAVE**.

## K. Data publication

105. Whole-corpus public dataset release (21GB Parquet, CC0, daily in-place refresh) — open-jobs. **MISS/PARKED** (data branch already exists; matters only with external users).
106. Dual licensing code/data (MIT code, CC BY-NC data) — jobseek. **N/A** (private single-user).
107. slugs.json coverage index so contributors can check inclusion before submitting — open-jobs. **PARTIAL** (companies.json is that index; not published as a friendly artifact).

## Tally

- HAVE: ~45 (including several confirmed unique: per-industry seniority vocab, Indian ATS coverage, pod-aware scheduling, outage-aware eviction, block classification, cold-start guard, regression-suite discipline)
- MISS worth building: ~20, of which ranked top-5 = salary extraction (#38), repost detection (#28), volume-anomaly issues (#96), faceted UI search (#64/#65), hiring-country metadata (#8)
- PARKED (deliberate): ~25
- REJECTED (identity conflicts): ~10
