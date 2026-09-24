# EditTrades — T6 completion plan v2 (reviewer-consolidated, 2026-09-24)

Repo `/Users/bballi/Documents/Repos/snapshot_tradingview`, branch `upgrade-signal-engine`, HEAD 885f405.
Read in order: `CLAUDE.md`; `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`; `docs/REVIEW_PACKET_2026-09-24.md`; `docs/OWNER_DECISIONS_2026-09-23.md`; `docs/GOOD_QUALITY_REPLAY.md`. This plan overrides sequencing.

## Owner goal for this plan

Opportunities visible more than once a day, GOOD calls as often as the rules honestly allow. Do not manufacture calls by lowering costs or thresholds. Make frequency measurable, then let the owner choose with the numbers in front of him.

## Working rules

- One step per pass. Commit before any deploy; deploy only from a clean tree. Three sessions share this branch and `vercel --prod` ships the working tree.
- Additive only. Hard invariants: MCP one read-only tool; no execution/signing import on the context or journal path; walletTracker read-only; scalp stop cap 3%; gross minRR 3 unless the owner changes it in writing; unavailable wallet/mark/journal never changes dataStatus; `api/` = 12 functions.
- Never print or commit secrets. No paid calls. No Vercel env changes.
- Do NOT restart the testing window (`PHASE_START` 2026-09-23). Config changes are boundaries on the page, not resets.
- GPT: edit the EXISTING Action's schema in place with `openapi/scalp-context.yaml`, keep auth, paste instructions. Never create a new Action or GPT.
- Before every commit: all suites (`npm run test:*` incl. tracker, journal, served, paths, rules), `npm run check:gpt`, `git diff --check`. Report counts before/after.

## Step A — Fix pass (no change to what calls say; deploy at end)

- **A1 Payload cap** (live 79,863 B > 79,000). Remove `breakoutEntry` from the served payload (tracker derives it from candidates); trim `pathOutlook` to codes + numbers, texts under `include=model`. Replace the frozen-fixture cap test with a synthetic worst case (3 symbols × max candidates incl. 6 failed-in-TTL each, plans + recommendations + pathOutlook): default ≤ 79,000 B, compact ≤ 45,000 B.
- **A2** `net_rr_below_min` → `hardBad` in `lib/flagRecommendation.js` with remedy text; openapi enum; flagrec test, long + short.
- **A3 Retest-hold respects the stop:** in `lib/flagTradePlan.js` `isRetestHold`, low ≤ stop (high ≥ stop for shorts) is not a hold → `awaiting_retest`. Same in `scripts/tracker/flag-paths.js`; parity test.
- **A4** `lib/blobJsonl.js` first-write race: `allowOverwrite:false` on create, re-read + retry on conflict (max 3). Test with an injected racing put.
- **A5** `api/scalp-context.js`: respond first, then record the served call (1.5 s cap, reason string on failure) or shard served files by hour. Test that a slow recorder never delays the response.
- **A6 Docs:** connector test table (served 20, paths 26, flagplan 47, config 18, add `test:rules`); `config/engine.js` `entryToleranceAtr` comment; CHANGELOG entry; add "payload over cap" to the review packet risks as fixed.
- **A7 Low items:** `setConfigOverride` refreshes `CONFIG_VERSION` and `strategy.js` `THRESHOLDS` or throws when a variant touches them; ask the owner whether the TP1 cap / `room_at_entry` should read only the candidate's own geometry timeframe (decision 4a scope) and leave as is until answered; `test-replay-rules.js` fails, not skips, when its fixture is missing off this machine.

**Gate:** suites green; live default ≤ 79,000 B; commit `fix: review pass A1–A7`; owner deploys; prod checks: REST 401/401/405/200, journal 401/201/GET, MCP one tool, bytes, marks ok.

## Step B — Frequency study + decisions gate (research, no deploy; STOP for owner answers)

- **B1** Extend `scripts/replay-rules.js` with per-variant columns: ready plans/hour, conditional plans (≥3R gross, awaiting retest)/hour, GOOD/hour, per symbol and combined, over every history available (deep60 if its manifest exists). Variants that only change frequency-relevant rules, each labeled "owner rule change" where it touches a decided rule:

  | Variant | Change |
  | --- | --- |
  | V-A | baseline (minRR 3 gross, net gate off) |
  | V-B | minRR 2.5 gross **[owner rule change]** |
  | V-C | V-A + 15m flags in default |
  | V-D | V-A + retest tolerance 0.2 ATR |
  | V-E | V-A + TP1 cap / room on own timeframe only |
  | V1c | net gate as in phase 0 (shadow candidate) |

  Costs: report each at 0.14% / 0.20% / 0.34%.
- **B2 Owner decisions**, written into `docs/OWNER_DECISIONS_2026-09-24.md`:
  - **D-cost:** 0.14% (matching collateral, < 1 h holds) / 0.20% / 0.34% (USDC-funded). Reviewer recommendation: 0.14% if the owner funds positions with the traded asset, else 0.20%.
  - **D-variant:** pick with a frequency floor first (owner states it, e.g. ≥ 0.5 GOOD/hour combined or ≥ 3 conditional/day), then best expectancy among variants above the floor. Reviewer recommendation: net gate OFF live, V1c shadow only; the live variant is whichever of V-A/V-C/V-D clears the floor with non-negative expectancy on ≥ 20 scored plans; V-B only with the owner's explicit rule change.
- **B3** Free ≥ 150 instruction units by moving procedure lines into the playbook doc; list what moved.

**Gate:** B2 answered in writing.

## Step C — Ship (engine + tracker; deploy)

- **C1** Apply D-cost and D-variant as config (configVersion bump; schema bump only if a published field changes). Net gate stays null unless D-variant says otherwise; V1c recorded in shadow.
- **C2 SETUP tier:** the recommendation publishes `setup` = the best conditional plan (≥3R gross, awaiting retest/breakout) with its exact trigger sentence, distinct from GOOD. GPT `signals` lists SETUP lines under the GOOD/NO TRADE lines; never called GO IN. Tracker scores SETUPs as what-if (did the trigger occur, then TP1/stop) and shows SETUPs/day and GOOD/hour tiles.
- **C3 Tracker:** config boundary marker + before/after segments; shadow-variant tiles; net and gross R labeled side by side everywhere.
- **C4** `FLAG_TF_RANK` / `FLAG_TF_ORDER` rank higher timeframes first if 15m/1h flags are published; else keep them out of the default and say so.
- **C5 GPT:** instructions for SETUP tier + new reason codes; owner edits the existing Action schema in place, pastes instructions; fresh-chat sheet (`signals`, `trades`, `flags`, `why <sym>`, `log`, `journal`). Hand back exact paste text + steps.

**Gate:** suites green; prod verified; fresh-chat outputs match the engine record; page shows GOOD/hour and SETUPs/day.

## Step D — Later, only with owner OK

T6 Phase 2 state model + reversal scouts; Phase 3 playbook v2 (`docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md` + Miss 004); Phase 4 60-day recalibration; Phase 5 path gating.

## Known risks (repeat in every handback)

- One 15-day bullish window; every number provisional; `pathOutlook` unproven live.
- 1 GOOD/hour is ~10× the observed rate under current rules; reaching it requires owner rule changes (minRR, entry type), which this plan surfaces as labeled variants, never applies silently.
- Net expectancy negative for all 1m–5m entry styles at 0.20%; that is information, not a bug.
- Sonnet weekly limit resets 2026-09-25 12:00 CT; use Opus until then.

## Handback format (each step)

Files changed; per item what changed; test counts before/after; live bytes; prod checks; the variant table (Step B); decisions needed; risks. Under 400 words.
