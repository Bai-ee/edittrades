# EditTrades — next steps master plan (decision clarity first)

Last updated: 2026-09-23 (16:45 CDT) for Phases 0–4 below (historical record, all done); "Where we are" refreshed 2026-09-27 (T-17 wrap-up pass).
Status: superseded as the sequencing source of truth. Phases 0–4 below all finished 2026-09-23/24; current sequencing lives in `docs/MASTER_PLAN_ENGINE_REFINEMENT.md` (engine phases) and `docs/PLAN_TELEGRAM_EXECUTION.md` (execution, Telegram, risk policy). Kept for history and the "Working rules" at the bottom.
Goal: the system faithfully communicates the owner's 21/200 flag strategy from the closed-candle data it has. Profitability is out of scope and stays labeled as such in every output.

## Where we are (2026-09-27, T-17 wrap-up pass)

**Live** (schema 1.28.0, configVersion 2026.09.27-2, per the owner's 2026-09-27 status - this pass did not itself re-verify the Vercel deploy): closed-candle 21/200 flag recommendation via REST/MCP; Telegram alerts, tracking, focus mode, Open (early)/Open @ plan; live Jupiter perps execution (bot wallet `JEAzPi…TjwT2`, caps $150 size / 100x leverage / $5 loss-per-trade / $25 daily / 1 open position); wallet risk policy + Steady/Aggressive profiles (Steady live at 0.5%/trade; the 30-trade Steady evaluation started 2026-09-26T22:08Z at $523.14 equity); the equity peak-drawdown kill and 0.1% min-stop-distance floor (G1/G2); the NF stop floor (every plan's stop widened to the fee-aware floor before any gate) and an automatic +1R trailing stop (T-15); trade charts with ENTRY/EXIT markers plus an RSI(14) panel on every touchpoint (T-13, upgraded T-16).

**Paper only**: the spot daily EMA20 trend filter (`spot.html`, P1/P2 built 2026-09-27) - long-or-cash on BTC/ETH/SOL against a Kraken daily close, no live execution; P3 (paper → live) not started.

**Research concluded, no rule change from most of it**: the 2-year perps rule search (76 configs, no net-positive edge, `docs/EDGE_SEARCH_2026-09-27.md` - the spot-trend filter above is what it found instead), swing-timeframe rules (`docs/SWING_STUDY_2026-09-26.md`), mean-reversion-at-zones (`docs/MEANREV_STUDY_2026-09-26.md`), and retest-entry on 2 years (`docs/RETEST_ENTRY_STUDY_2026-09-27.md`) all failed their own out-of-sample bar; the NF-stop-floor + trailing-stop combination (`docs/VARIANTS_STUDY_2026-09-26.md`, `docs/EXITS_STUDY_2026-09-26.md`) is the one exception that did change a rule (T-15). Full list with one-line conclusions each: `docs/DOCUMENTATION_INDEX.md`'s "Current" section and how-to.html's "Research so far".

**Open**: the management study (does the wider NF stop + trailing stop actually hold up net-positive over more live trades - the 30-trade Steady evaluation is the vehicle for that answer), spot-trend P3 (paper → live, a separate plan), a longer live-trading window before any further threshold change, T5 (the kill/arm live drill, owner-only), and 8c (journal) / 3b (positions), deferred as later enhancements.

## Phase 0 — Land the two packages safely — DONE 2026-09-23 (a556e2c on prod, schema 1.17.0)

1. Review-agent findings on packages 1+2 (hard rules, preflight items, determinism, mirror tests). Fix blockers only.
2. Payload back under 79,000 B default: shorten `flagRecommendation` (drop `refs[]` from default, keep under `include=model`; codes + one-line text only), keep `candidateSetups` intact. Add a byte-cap test on a saved fixture so this cannot regress silently.
3. Commit packages 1+2 + F1 follow-ups in one commit, push, owner deploys, verify prod (schema 1.14.0), owner pastes GPT instructions, fresh-chat `signals` / `trades` / `flags` / `why`.
Gate: 16 suites green, check:gpt ≤ 7,990, prod verified, no hard-rule drift.

## Phase 1 — Owner decision sheet — DONE 2026-09-23 except chart screenshots (docs/OWNER_DECISIONS_2026-09-23.md)

Answers unblock Phases 2–4. Collected in `docs/OWNER_DECISIONS_2026-09-23.md` (to write in Phase 0 step 3 handoff).

1. **Net R vs gross R.** With `feeBps 5 + slippageBps 5` per leg, a 1m/3m flag stop 0.07% away makes net R ≈ 0 and every scalp flag BAD. Options: (a) 3R is gross price R, net shown as information; (b) fee assumption set to real Jupiter perps fees; (c) keep as is and accept that 1m/3m flags rarely qualify.
2. **`ready` definition.** Retest-hold observed at the breakout (n closes) vs close-within-tolerance.
3. **GOOD/WATCH thresholds and quality bands** (currently implementation choices, labeled).
4. **`room:blocked` scope**: any geometry timeframe (fires on nearly every flag) vs own timeframe / within 1R.
5. **Mark price source**: Pyth API key (new secret) / Jupiter keyless swap price / drop.
6. **Timeframe pairing** for direction vs entry; 6–10 annotated chart screenshots for the fixture set (M0 input, still open).

## Phase 2 — Recommendation completeness — DONE 2026-09-23 (schema 1.18.0; context codes on every record, best candidate + concrete change condition on WATCH, remedy on BAD, 16 pinned fixtures)

Owner goal is "supports / opposes / unknown / what changes it". Today WATCH `no_plan` carries none of it in the default payload.

1. WATCH/BAD/DATA_UNAVAILABLE records always cite the 21/200 context already computed: top-down (`td:`), EMA200 count, nearest forming/triggering candidate with its exact confirmation condition, first level ahead, divergence state (or `unknown`). Compact codes, no refs by default.
2. `changeConditions` name the concrete event: "3m close above 84,324.9 then hold 2 closes" not "a fresh plan must pass".
3. Apply Phase 1 answers 1–4 as config, not code, where possible.
4. Fixture set: one pinned-clock fixture per owner case in the decision-clarity plan's acceptance list; mirrored long/short; byte-stable record assertion.
Gate: each fixture has expected class + reasons; payload ≤ 79,000 B; check:gpt ≤ 7,990.

## Phase 3 — Docs and GPT alignment (Haiku for mechanical sync, Opus for the playbook text)

1. Run docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md (TRADING_MODEL.md SSOT, master-plan patch, Playbook v2 md + docx). Add Miss 004 from `BTC_trade_review_export_v2.docx`: HOLD/PROTECT/EXIT three-state consistency; on a failed breakout state exit-long and short-on-retest-rejection separately with target + invalidation.
2. Move GPT procedure text out of the instruction box into the playbook to free budget; instructions keep rules + formats only.
3. Owner uploads Playbook v2 to the GPT; fresh-chat test sheet (11 prompts) against fixed payloads for all four classes.
Gate: every GPT number matches the engine record on the four fixed payloads.

## Phase 4 — Forward paper record (no code, two weeks)

1. `npm run ledger:record` on a schedule (local cron or owner-run), `ledger:score` weekly. Exact entry condition, gross and net labeled.
2. No threshold tuning until ≥ 2 weeks / ≥ 30 plans. Then one calibration pass with the owner.
Gate: a report the owner reads: plans by status, rejection reasons, fills, outcome labeled gross/net, nothing called an edge.

## Later (not scheduled)

15m/1h/4h flags in the default payload; divergence strength; FLAG_21 second stop type + leverage derivation; Pyth mark if a key is approved; 8c journal; 3b positions.

## Working rules

One phase per thread. Additive only. Hard invariants never relax (read-only MCP, 3% scalp stop, no execution import, wallet read-only). No commit/push/deploy/secret/paid call without owner OK. Reviewer thread (this one) checks each phase against this file before the next starts.
