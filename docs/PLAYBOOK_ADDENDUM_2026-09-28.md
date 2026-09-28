# Playbook addendum — 2026-09-28 (appended to the GPT knowledge file)

Source for sections 10–12 of `EditTrades_Living_Scalp_Playbook_v2.docx` (the Custom GPT's knowledge file, built from the 2026-09-22 playbook + this addendum, nothing rewritten). Field lists in section 10 are the four moves from `docs/GPT_PLAYBOOK_ADDITIONS_2026-09-24.md`. Section 11 summarizes engine changes since 2026-09-22 from `CHANGELOG.md` and `openapi/scalp-context.yaml` (schema 1.29.0, configVersion 2026.09.27-3). Rebuild: `textutil -convert html` the old docx, append the HTML of this file's sections, `textutil -convert docx`.

## 10. Payload field reference (moved out of the Instructions box)

**geometryContext fields** (per timeframe, 15m/1h/4h): `structure`, `atrPct`, `higherLows`/`lowerHighs`, S/R zones, `room%`, `extensionRisk`, EMA slopes, diagonals, `channel` (with `positionPct`), `confluenceZones`. Full shapes: OpenAPI `GeometryContext`/`Diagonal`/`Channel`/`ConfluenceZone`; the live response carries these exact keys.

**candidateSetups[] fields** (1m/3m/5m flags): `timeframe`, `direction`, `state`, `breakoutLevel`, `invalidation`, `ema21Hold`, `chaseRisk`, `confidence`, `measuredTarget`, `measuredRR`, `ema200Side`, and `risk` (present only when `state` is `triggering` or `confirmed` and `chaseRisk` is false). Full shape: OpenAPI `CandidateSetup`.

**candidateSetups[].risk fields**: `maxLeverage`, `suggestedLeverage`, `lossAtStopUsd`, `lossAtStopPct` (of collateral), `lossAtStopPctOfWallet`, `collateralUsd`, `reason` (set when sizing could not be computed). Full shape: OpenAPI `Risk`.

**Estimating time to TP1/TP2:** derive from the candidate's own timeframe, the price distance to the target, ATR, momentum, and structure (a tighter timeframe + strong momentum + clean structure implies a shorter estimate than a wide-target/choppy setup on a slower timeframe). Always label it an estimate, and always pair it with a Time Stop: a point to reassess the thesis, never an instruction to auto-close.

**Fields moved from the Instructions box 2026-09-28 (T-22):** the engine reads candles, EMA21/200 and distance, Stoch, trend, S/R, swings and session/prev-day levels on 1m-1d. `decisionTrace.window` = `range(to, closedCandles)`. A failed candidate trace token's 4th field is `failReason` (e.g. `5m:short:failed:stale`); cite it verbatim if asked.

## 11. Engine changes since 2026-09-22 (what the payload now carries)

**Net stop floor, live since 2026-09-27 (configVersion 2026.09.27-2).** Every flag candidate's stop is widened to `max(0.5 × ATR15m, 3 × round-trip cost)` before any gate, then capped at 3% from entry (a candidate needing more than 3% is rejected, never widened past). `flagTradePlan` publishes `stop` (floored), `stopSource` (`structure` | `floor`) and `structureStop` (pre-floor invalidation); `flagRecommendation.setup.stopFloor = {applied, stopPct, netRR}`. Quote the floored `stop`, not `structureStop`, as the protective stop. A ready plan needs gross R:R ≥ the config minimum AND net R:R ≥ the floor's minimum; `net_rr_low` (net < 1.0) is non-blocking: say "thin after fees".

**Automatic +1R trailing stop (live positions).** Once a live position is ≥ +1R (R = entry to current on-chain stop), the desk trails the stop to the best mark since entry minus 1R (short: plus 1R), tighten-only, at most once per 5 minutes per position. Retest-1h paper positions are exempt. When discussing an open position, expect the on-chain stop to be tighter than the plan's original stop.

**RETEST 1H (paper, info-only).** A 1h flag-retest rule alerts on Telegram with Track/Plan/Thesis but no Open. Research: mean +0.27R, median −0.84R on 101 trades over 2 years; ships paper until 30 live signals with mean net R > 0 and bootstrap 90% lower bound > 0. Not in the REST payload; treat as context if the user mentions it.

**HTF-anchored entries, live since 2026-09-28 (schema 1.29.0, `symbols.<SYM>.htfEntry`).** Direction: EMA21 > EMA200 on both 4h and 1D and price above EMA21(4h) = long (short mirrored). Trigger: a 1m/3m/5m flag reaching `triggering` in that direction; entry = the trigger candle's close. Stop: the last confirmed 1h swing pivot ± 0.1 ATR(1h), net-floored, 3%-capped. Target: the last 1h impulse projected from that pivot; requires ≥ 2.5R gross and ≥ 1.0R net, else no trade. TP2: the next 1h/4h zone ahead of TP1, if any. Exits: stop, TP1, a 1h close beyond the structure stop, or a 72h hold cap. One trigger per symbol per 4h; max one open HTF trade per symbol. The +1R trail applies. Fields: `direction`, `since`, `state` (required); `stop`, `structureStop`, `tp1`, `tp2`, `grossRR`, `netRR`, `stopPct`, `candidateId` present only when `state = ready`. `htfEntry` is `null` when no HTF regime is active. Its 2-year replay is negative (1,776 signals, 27.7% wins, mean −0.18R net); say so when asked; the owner tracks it live regardless.

**Spot EMA20 trend (paper).** Daily EMA20 in/out state per coin with vol-target weighting, paper equity vs buy-and-hold on the tracker's spot page. Not in the REST payload.

**Public tracker.** https://bai-ee.github.io/edittrades-tracker/ scores every GOOD call, HTF entry, RETEST signal and served GPT call net of fees, each strategy from its own start date (flag net-floor 2026-09-27, HTF 2026-09-28, RETEST 2026-09-27, spot 2026-09-26). GPT-served calls appear as "Via: chat". When asked how a strategy is doing, point to the scoreboard; never quote a number the payload or the page does not show.

## 12. Change log (continued)

2026-09-28 — Appended sections 10–12. Section 10 restores the four field lists removed from the Instructions box on 2026-09-24/25. Section 11 documents the net stop floor, +1R trailing, RETEST 1H paper, HTF-anchored entries (schema 1.29.0) and the per-strategy tracker. No rule in sections 1–9 was changed. Known open contradictions with `docs/TRADING_MODEL` direction (shorts wording, timeframe frame, stop tightening) are deferred to Playbook v2 (`docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md`).
