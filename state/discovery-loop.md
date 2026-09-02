# Contact-discovery loop state

Checklist (from CONTACT-DISCOVERY.md "Open next steps"):

- [x] 1. DMARC pre-flight
- [x] 2. PyPI fallback source
- [x] 3. ApplyBolt retry adapter (env-flag off)
- [ ] 4. Role-address lane + template
- [ ] 5. Hunter.io cross-check prep (needs free account → likely NEEDS-HUMAN)
- [ ] 6. Pre-send wiring review

## Iteration log

### iter 1 — DMARC pre-flight (2026-08-26, commit after 4f4214a)
- `dmarcRua()` + pure `parseDmarcRua()` in contact-sources.ts; warn in outreach.ts finalize(); CLI prints status.
- Live: meesho.com → managed (rua dmarcreports@meesho.com); razorpay.com → not published warning. tsc clean, all checks pass.
- 3 new selftest cases (plain rua, vendor-hosted split records, absent).

### iter 2 — PyPI fallback (2026-08-26)
- pypiContacts(): slug-variant name probing, <addr> parsing, same guards. Second fallback in resolveRecipients after npm.
- Live: "Snowflake" -> snowflake-python-libraries-dl@snowflake.com. Razorpay/Zerodha nothing corporate (expected, documented).
- 2 new selftest cases (candidate expansion, tiny-slug reject).

### iter 3 — ApplyBolt adapter (2026-08-26)
- applyboltLookup(): APPLYBOLT_ENABLED=1 gate, 15s timeout, 1 retry, 30min cool-down on hard fail. parseApplyBolt() pure + selftested.
- CLI single-profile mode. Live: satyanadella -> satya@uchicago.edu (Satya Nadella, Member Board Of Trustees).
- Gap documented: needs LinkedIn-URL finder before it can join resolveRecipients.

(last merged origin/main: none yet this session)
