# EditTrades — next steps master plan (decision clarity first)

Last updated: 2026-09-23 (16:45 CDT)
Status: current sequencing source of truth. Phase plans it points to keep their own detail.
Goal: the system faithfully communicates the owner's 21/200 flag strategy from the closed-candle data it has. Profitability is out of scope and stays labeled as such in every output.

## Where we are (verified live 2026-09-23 16:40 CDT, working tree uncommitted)

| Piece | State | Proof |
| --- | --- | --- |
| F1 flag detection coverage (schema 1.12.0) | committed 7119ab1, deployed, verified | prod REST/MCP checks |
| Package 1: freshness gate, engine-owned `flagTradePlan`, paper ledger, exact-condition replay scoring (schema 1.13.0) | **uncommitted** | test:freshness 10, test:flagplan 35, test:ledger 10 |
| Package 2: `modelEvidence` (EMA map, 15m/1h/4h flags, channels, divergence, opt-in `include=model`), `flagRecommendation` GOOD/WATCH/BAD/DATA_UNAVAILABLE in default payload, decision contract + review sheet (schema 1.14.0, config 2026.09.23-3) | **uncommitted** | test:flagrec 12; 16 suites 495 green; check:gpt 7,978 |
| Live default payload | **84,484 B — over the 79,000 B cap** | `buildScalpContext({})` + `filterPayload` |
| Live recommendation | BTC BAD `net_rr_below_3` (netRR 0.023 on a 0.065% stop); ETH/SOL WATCH `no_plan` with empty supports/opposes/unknowns | same probe |
| Pyth mark price (P1) | blocked: every Pyth price endpoint keyed | docs/PLAN_PYTH_MARK_PRICE.md |
| Docs alignment (playbook v2, TRADING_MODEL.md) | plan only | docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md |
| Sonnet implementer | weekly limit until 2026-09-25 12:00 CT | use Opus for code, Haiku for mechanical doc sync |

## Phase 0 — Land the two packages safely (this thread, now)

1. Review-agent findings on packages 1+2 (hard rules, preflight items, determinism, mirror tests). Fix blockers only.
2. Payload back under 79,000 B default: shorten `flagRecommendation` (drop `refs[]` from default, keep under `include=model`; codes + one-line text only), keep `candidateSetups` intact. Add a byte-cap test on a saved fixture so this cannot regress silently.
3. Commit packages 1+2 + F1 follow-ups in one commit, push, owner deploys, verify prod (schema 1.14.0), owner pastes GPT instructions, fresh-chat `signals` / `trades` / `flags` / `why`.
Gate: 16 suites green, check:gpt ≤ 7,990, prod verified, no hard-rule drift.

## Phase 1 — Owner decision sheet (one sitting, yes/no answers)

Answers unblock Phases 2–4. Collected in `docs/OWNER_DECISIONS_2026-09-23.md` (to write in Phase 0 step 3 handoff).

1. **Net R vs gross R.** With `feeBps 5 + slippageBps 5` per leg, a 1m/3m flag stop 0.07% away makes net R ≈ 0 and every scalp flag BAD. Options: (a) 3R is gross price R, net shown as information; (b) fee assumption set to real Jupiter perps fees; (c) keep as is and accept that 1m/3m flags rarely qualify.
2. **`ready` definition.** Retest-hold observed at the breakout (n closes) vs close-within-tolerance.
3. **GOOD/WATCH thresholds and quality bands** (currently implementation choices, labeled).
4. **`room:blocked` scope**: any geometry timeframe (fires on nearly every flag) vs own timeframe / within 1R.
5. **Mark price source**: Pyth API key (new secret) / Jupiter keyless swap price / drop.
6. **Timeframe pairing** for direction vs entry; 6–10 annotated chart screenshots for the fixture set (M0 input, still open).

## Phase 2 — Recommendation completeness (Opus implementer, one pass)

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
