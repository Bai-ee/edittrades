# Trading Model Decision Contract

Created: 2026-09-23  
Status: draft for owner review. This document records how schema 1.14.0 applies the owner-stated EMA21/EMA200 flag model from `docs/MASTER_PLAN_TRADING_MODEL.md`. It proves decision clarity, not trading profitability.

## Rule Table

| Rule | Owner Source | Inputs | Interpretation | Output | Veto? | Missing Data |
| --- | --- | --- | --- | --- | --- | --- |
| M-1 Top-down first | Owner stated | 1W derived from 1D, 1D, 4H, 1H leans | Read higher timeframes before timing entries. | `topDown.sentiment`, `aligned`, `score`; cited in `flagRecommendation`. | No | Unknown lean stays neutral/unknown; no invented weekly EMA200. |
| M-2 Alignment is confidence, not veto | Owner stated | 1W/1D/4H/1H agreement | Alignment raises/lowers quality only. | Support/Against reason and score contribution. | No | Missing alignment lowers confidence or becomes unknown. |
| M-3 Channels | Owner stated | `geometryContext` channels/ranges, S/R, confluence | Report channel/level context side by side; do not choose a single governing channel. | `model.channels`, first level ahead, breakout risk. | No | `unknown`; no fabricated channel. |
| M-4 Counter-sentiment breakout read | Owner stated | Top-down sentiment, channel edge, levels, pull/divergence when available | Counter-sentiment plays are allowed but must name breakout-vs-rejection risk. | Channel/level support or opposing reason. | No | Unknown edge/risk is unknown, not bearish/bullish. |
| M-5 Flag on EMA21 | Owner stated | Existing flag detector and lifecycle, EMA21 hold/reclaim, confirmed candidates | Flags are detected by the existing detector; confirmed directional flags feed the plan. | `flagTradePlan` and `model.flags`. | GOOD requires ready plan | No confirmed plan → WATCH, not legacy fallback. |
| M-5b Measured target | Owner stated | Candidate pole height, breakout, invalidation, geometry cap | Engine computes target and caps TP1 before measured move when a major level is first. | `flagTradePlan.tp1/tp2/grossRR/netRR`; cited verbatim. | <3 gross R is BAD (owner-approved 2026-09-23: gross; net R is information) | Missing/invalid levels reject plan. |
| M-6 EMA21/EMA200 direction, not targets | Owner stated | Per-timeframe EMA21/EMA200 value, side, slope, distance | EMA21 is flag/pull context; EMA200 is confluence, never a filter or TP. | `model.ma`; factor state says EMA200 is context. | No | Weekly EMA200 remains unknown. |
| M-6b Higher TFs dominate | Owner stated | Config weights in `model.topDownWeights` / `above200Weights` | Higher timeframes carry more direction weight; lower timeframes time entries. | Score contribution and top-down reason. | No | Missing HTF lowers confidence/unknown. |
| M-7 Stoch RSI divergence confirmation | Owner stated | Price pivots from `swingPivots`, existing Stoch RSI history | Standard and hidden divergence count as confirmation or conflict. | `model.divergence`, reason codes `divergence_agrees/conflicts/absent`. | No | Absent is unknown/neutral, not a veto. |
| M-8 Confluence | Owner stated | Plan, top-down, EMA map, channel/levels, divergence | Stack factors into a deterministic quality score. | `factorStates`, `qualityBand`. | No by itself | Unknown factors do not improve class. |
| M-9 Risk management edge | Owner stated | Engine-owned entry/stop/TP1/grossRR/netRR | Every ready/conditional plan must have at least 3 gross price R (`flagPlan.minRR`) to capped TP1 (owner-approved 2026-09-23: gross). Net R after fees is published as information. | `rr_ok` support or `rr_below_min` BAD; non-blocking `net_rr_low` oppose when net R < 3 (fees eat the edge). | Yes | Missing levels/data → rejected or DATA_UNAVAILABLE. |

Implementation choices not explicitly owner-approved:

| Choice | Current Implementation |
| --- | --- |
| Recommendation labels | `GOOD` means ready plan + hard risk checks pass; `WATCH` means plausible setup but missing readiness/plan; `BAD` means hard invalidation/risk rejection; `DATA_UNAVAILABLE` means stale/missing required data. |
| Quality score | Deterministic points from config `model.decisionWeights`; presented as quality, never win probability. |
| Pull threshold | `model.maPullDistancePct` = 0.75% from EMA21. |
| Divergence detector | Uses last pivots from existing geometry and Stoch RSI K values; lightweight, deterministic, no ML. |
| Higher timeframe model flags | Detected with the existing detector for `include=model`; default `candidateSetups[]` remains 1m/3m/5m. |

## Provenance Map

| Fact | Source | Timeframes | Published Where | Unavailable Behavior |
| --- | --- | --- | --- | --- |
| Closed candles | Provider envelope via `services/marketData.js`; replay fixtures via saved candles | 1m, 3m derived, 5m, 15m, 1h, 4h, 1d | `timeframes.*.candles`, `decisionTrace.window` | Missing/stale warnings; plan can reject as missing/stale. |
| EMA21/EMA200 | `services/indicators.js` from closed candles; weekly EMA21 in `lib/topDown.js` | 1m-1d plus derived 1w EMA21 | `timeframes`, `model.ma` | Null with reason; weekly EMA200 never guessed. |
| Flags | Existing `detectFlagLifecycle`, snapping, qualification | Default 1m/3m/5m; opt-in model 15m/1h/4h | `candidateSetups`, `model.flags` | No plan → WATCH; no invented flag. |
| Plan levels | `lib/flagTradePlan.js` | Candidate timeframe plus geometry freshness | `flagTradePlan` | Invalid/stale/missing produces reasonCode. |
| Channels/levels | `lib/geometry.js` | 15m/1h/4h | `geometryContext`, `model.channels` | Unknown; no drawn line. |
| Divergence | `lib/modelEvidence.js` using `swingPivots` + Stoch RSI history | Available fetched timeframes | `model.divergence` | `unknown`/`none`, not a veto. |
| Recommendation | `lib/flagRecommendation.js` | Consumes plan + model evidence | `flagRecommendation` | Missing required facts become WATCH/DATA_UNAVAILABLE. |

## Authority Contract

- The engine owns class, selected candidate, levels, net R:R, and calculations.
- GPT communicates `flagRecommendation` and `flagTradePlan`; it does not recompute the 21/200 model.
- Legacy `strategies.*` and `bestSignal` remain legacy evidence. They are not the 21/200 recommendation and cannot create a 21/200 `GO IN` when `flagTradePlan` is null, conditional, rejected, stale, or missing.
- This package does not enable execution, alter secrets, deploy, or prove profitability.
