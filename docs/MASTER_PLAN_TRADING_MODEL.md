# EditTrades Trading Model — Phased Master Plan

Last updated: 2026-09-23
Status: plan only. No phase started.
Branch: `upgrade-signal-engine`
Baseline: production schema 1.10.0, configVersion 2026.09.22-9 (engine refinement Phases 0–11, 8b, 9b live; 8c and 3b deferred).
Predecessor: `docs/MASTER_PLAN_ENGINE_REFINEMENT.md` (its governing rules still apply; this plan adds to them).
Companion docs: `docs/SIGNAL_GENERATION_SPECIFICATION.md`, `docs/EDITTRADES_MCP_CONNECTOR.md`, `docs/GPT_INSTRUCTIONS.md`, `CLAUDE.md`.

Purpose: align the engine with the owner's trading model. Today the engine's scalp logic (SCALP_1H) uses EMA21 proximity and a 15m Stoch condition, ignores the EMA200 and flags, and sets targets as 3R/4.5R multiples of a structural stop. That produced a "scalp" on 2026-09-23 with TP1 3.9% away and a multi-hour-to-a-day hold. This plan builds the owner's model as a new strategy, `FLAG_21`, alongside the existing ones, and proves it on replay before the GPT prefers it.

---

## The trading model (owner-stated 2026-09-23, source of truth)

M-1. **Top-down first.** Read 1W → 1D → 4H → 1H for the overarching sentiment (bull or bear), then dig down through lower timeframes to find the entry.

M-2. **Alignment is the major confidence input, never a veto.** All four of 1W/1D/4H/1H aligned is the strongest single input to confidence. Misalignment lowers confidence; it does not cancel a trade. Requiring full alignment would allow a trade roughly 10% of the time, which is not the model.

M-3. **Channels.** Identify the channels price is trading in. Trades aim at a channel's top (longs) or bottom (shorts). Both sides are playable while the overarching sentiment stays in view. No single channel "governs" a trade: channels on every timeframe are context, and the engine reports them side by side rather than picking one.

M-4. **Counter-sentiment plays need a breakout read.** Shorting the top of a channel in an overall-bullish market (or longing the bottom in a bearish one) is allowed, but the engine must say how likely the edge breaks instead of rejecting. The trader must know whether they are about to miss a breakout or fade one correctly.

M-5. **The setup is a flag on the EMA21.** A flag is compressed or coiled price action coming off a longer pump (or dump). Bull flag: impulse up, flag compresses on / rides the EMA21. Bear flag: the same picture inverted (the owner thinks of it as flipping the chart). Two entries are valid: (a) the breakout from the top of the flag (bottom for a bear flag), or (b) catching the bottom of the flag's own channel (top for a bear flag), following the flag's borders and levels. Flags are hunted on all timeframes; the top-down read decides which ones matter.

M-5b. **Flag targets are measured moves.** A big pump (or dump) that flags out projects its next target by the length of the pole: from the base of the first move to the point where the flag starts, projected from the flag's breakout. That target usually sits around 3:1 reward to risk. A major support/resistance level or channel line in the way comes before it.

M-6. **EMA21 and EMA200 set direction, not targets.** On every timeframe, price above its 21/200 leans bullish and below leans bearish; the more timeframes above the 200, the stronger the bull case (mirror for bears). Price gets pulled up or down toward these averages, but they are not take-profit levels. Major support/resistance levels and channel lines generally override the moving-average pull. The EMA200 is never a filter: a short can exist above the 200 (price coming down from a channel top toward the bottom) and a long below it (a channel-bottom bounce).

M-6b. **Overall direction comes from all factors together, and small timeframes lie.** Timeframes push and pull each other; sentiment, the moving averages, channels, and major levels combine into one overall direction. The smaller the timeframe, the more price action tries to confuse, so lower timeframes carry less weight and are used for timing, not direction.

M-7. **Confirmation is Stoch RSI divergence across timeframes.** Bullish or bearish divergence between price and Stoch RSI confirms momentum ("volume" in the owner's words). Both standard (regular) and hidden divergence count. The closer a divergence is to live price (recent candles, and the timeframe being traded), the stronger it is. More timeframes agreeing = more confluence = more confidence.

M-8. **Confluence as much as possible.** Sentiment, channel position, flag, the cross-timeframe EMA21/200 map, divergence, confluence zones all stack.

M-9. **Risk management is the edge.** Expected win rate when following the model is about 3 in 10. At a 30% win rate the break-even average win is (1 − 0.3) / 0.3 = 2.33R, so every trade needs ≥ 3R available to the target, and sizing must survive the losing streaks a 30% win rate produces (the longest expected losing run in 100 trades is about 13).

---

## Owner decisions (do not reopen)

- `FLAG_21` is added **alongside** SCALP_1H and the other strategies. Nothing is retired until replay proves `FLAG_21` better and the owner approves.
- EMA200 side never filters a flag or a trade (M-6).
- No "governing channel" selection. Channels are reported per timeframe (M-3).
- EMA21 and EMA200 feed direction and pull only; they are never take-profit targets. Major support/resistance and channel lines override the moving-average pull (M-6).
- Higher timeframes outweigh lower ones for direction; lower timeframes time the entry (M-6b).
- TP1 for a flag is the measured move (pole length projected from the breakout), capped by a major level or channel line in the way (M-5b).
- Alignment never vetoes a trade (M-2).
- Flags are detected on all timeframes, not only 1m/3m/5m (M-5).
- Minimum 3R to TP1 stays (M-9); the target is now the measured move or the major level in front of it, not a stop multiple.
- Wallet position tracking (engine plan 3b) and the trade journal (8c) stay deferred. This plan does not depend on them.

---

## Governing rules (in addition to the engine refinement plan's rules 1–10)

1. One phase per thread. Stop after each phase for review. Do not start the next.
2. Additive only. Existing strategies, fields, and decisions stay byte-identical. `FLAG_21` is a new strategy key; every new analysis block is a new field.
3. Hard invariants, never relaxed: canonical NO_TRADE contract; SCALP_1H/MICRO_SCALP 3% stop cap; MCP one read-only tool, no auth, no execution or signing imports; REST Bearer 401/401/405/200; wallet unavailable ≠ zero, never changes `dataStatus`; no secrets in code, logs, or payload.
4. Direction symmetry: every detector, score, and fixture handles long and short through one parameterised path, with mirrored tests. Inverted-chart fixtures (price series reflected) must produce the mirrored result with identical scores.
5. Constants in `config/engine.json`; bump `configVersion` when a key changes. Schema bumps are minor and additive; keep `openapi/scalp-context.yaml` in step (ChatGPT-safe constructs: `[object, "null"]`, `items: {type: object}`, no `type: "null"` scalars).
6. **Payload budget.** Default 3-symbol payload is ~77.9 KB of an 80 KB cap (~2.1 KB headroom). New analysis blocks go behind a new `include` token `model` (REST and MCP). Only the `FLAG_21` strategy entry and one compact trace string may enter the default payload, and the phase that adds them reports the exact byte cost. If headroom falls under 0.5 KB, stop and report.
7. **GPT instruction budget.** `docs/GPT_INSTRUCTIONS.md` is at 7,990 of 7,990 units (`npm run check:gpt`). Any phase that adds instruction text must trim an equal amount in the same phase. Do not re-paste the Action schema; the GPT reads the raw response body.
8. **Compute budget.** Vercel Hobby, 10 s per invocation, no new `api/` files (12-function cap). Report build duration before and after each phase; flag any phase adding > 1 s.
9. Reuse, do not duplicate: `lib/geometry.js` (pivots, zones, diagonals, channel, confluence, ATR), `lib/patternDetector.js` (flags), `lib/patternLifecycle.js` (lifecycle, snapping), `lib/biasMatrix.js` (per-timeframe lean), `lib/riskEngine.js` (leverage, sizing), `scripts/replay.js` (no-lookahead replay). Dead modules stay dead (`lib/signalEngine.js`, `lib/advancedChartAnalysis.js`, `services/strategy-refactored.js`, and the others listed in the engine plan's rule 7). `lib/momentumAlignment.js` and `lib/tradeReadiness.js` serve the legacy `api/analyze*.js` endpoints and are not reachable from `buildScalpContext()`; do not import them or their divergence code into the scalp-context path. Write a new detector.
10. Replay before live preference: the GPT is not told to prefer `FLAG_21` until Phase M9's replay comparison passes and the owner approves.
11. Suites: all existing suites pass after every phase (`test:sltp`, `test:scalp`, `test:mcp`, `test:wallet`, `test:config`, `test:risk`, `test:pattern`, `test:geometry`, `test:chart`, `test:replay`, `test:bias`). Each new module ships its own suite and npm script. `git diff --check` on touched files.
12. No commits, pushes, deploys, secret changes, or paid calls without the owner's OK in that thread.

---

## Current architecture to build on

| Model piece | Exists today | Gap |
| --- | --- | --- |
| Top-down 1W/1D/4H/1H (M-1, M-2) | `lib/biasMatrix.js` scores 1m–1d lean (trend, EMA stack, price vs EMA21, slopes, geometry). `services/marketData.js` can aggregate 1D → 1W. | No 1W in `TIMEFRAMES`; no single sentiment/alignment score for 1W/1D/4H/1H. ~499 daily candles ≈ 71 weeks, so a weekly EMA200 is not computable (weekly EMA21 and structure are). |
| Channel (M-3) | `lib/geometry.js` `channel()` with `positionPct` on 15m/1h/4h; diagonals, horizontal zones, confluence zones, room-to-level. | Not on 1D; nothing uses channels to set targets or direction. |
| Breakout read (M-4) | Extension risk, room-to-level, Stoch acceleration exist per timeframe. | No breakout-vs-rejection assessment at a channel edge. |
| Flag on EMA21 (M-5) | `lib/patternDetector.js` flags on 1m/3m/5m with `ema21Hold`, lifecycle, snapping, coil. | Timeframes limited to 1m/3m/5m; no EMA200 side, no channel position on the flag. |
| EMA21/200 direction and pull (M-6, M-6b) | EMA21/EMA200 values and histories per timeframe; `biasMatrix` uses the EMA stack as a lean signal. | No count of timeframes above the 200; no pull read; no weighting that discounts lower timeframes; not attached to flags. |
| Measured-move target (M-5b) | The flag detector measures the impulse (`measureImpulse`, range and peak) internally. | Pole base and height are not published; no measured-move target. |
| Stoch RSI divergence (M-7) | Stoch RSI history per timeframe (`indicators.stochRSI.history`). | No live divergence detector. |
| Confluence score (M-8) | Pieces exist separately. | No composite, explained score. |
| Risk (M-9) | `lib/riskEngine.js`: leverage from stop distance, 2% wallet cap, `risk` block per strategy. | No survival/streak check; targets are stop multiples, not channel levels. |
| Validation | `scripts/replay.js` + `scripts/replay-metrics.js`: candidate states, gate rate, lifetimes, label precision/recall. | No trade outcome scoring (TP vs SL first touch, R, win rate, expectancy, streaks, hold time). |

---

## Phase map

| Phase | Deliverable | Size | Risk | Status |
| --- | --- | --- | --- | --- |
| M0 | Model spec + gap matrix + owner-labeled fixtures | 1–2 h | none | |
| M1 | Replay outcome scoring: TP/SL first touch, R, win rate, expectancy, streaks, hold time | 3–4 h | low | done (quick pass) |
| M2 | Top-down sentiment: 1W derived from 1D, alignment score over 1W/1D/4H/1H | 3–4 h | low | partial (quick pass) |
| M2b | Cross-timeframe EMA21/200 direction and pull: count above 200, pull read, higher-timeframe weighting | 3–4 h | low | partial (quick pass) |
| M3 | Channels per timeframe + edge targets + breakout read | 1 day | medium | |
| M4 | Flags on all timeframes with EMA200 side, channel position, and measured-move target | 1 day | medium | partial (quick pass) |
| M5 | Stoch RSI divergence detector, cross-timeframe confluence count | 1 day | medium | |
| M6 | Composite confidence model with explained breakdown | 3–4 h | medium | |
| M7 | `FLAG_21` strategy (alongside), channel/confluence targets, ≥ 3R gate | 1 day | medium | |
| M8 | Survival sizing: losing-streak drawdown check at the model's win rate | 2–3 h | low | |
| M9 | Replay comparison `FLAG_21` vs SCALP_1H, owner go/no-go | 3–4 h | low | |
| M10 | GPT instructions teach `FLAG_21` (budget-neutral) + deploy | 1–2 h | low | partial (quick pass) |

Quick pass delivered (2026-09-23), schema 1.11.0: `docs/PLAN_TRADING_MODEL_QUICK_PASS.md` shipped M1 in full (`scripts/replay-outcomes.js`, `test:replay` additions) and early parts of four phases in one implementer thread:
- M2: `lib/topDown.js` `buildTopDown()` — weighted 1W/1D/4H/1H sentiment/alignment/score. Not yet done: nothing else in M2 (it was already scoped narrowly).
- M2b: `lib/topDown.js` `buildAboveBelow200()` — above/below-200 counts and weights only. Not yet done: the pull read, `lib/maMap.js`, `config.model.maWeights`.
- M4: `lib/patternDetector.js` `measuredMoveFor()` (poleHeight/measuredTarget/measuredRR) and `ema200Side` on the existing 1m/3m/5m `candidateSetups[]`. Not yet done: flags on 15m/1h/4h, channel position on the flag.
- M10: `docs/GPT_INSTRUCTIONS.md` teaches `measuredTarget`/`measuredRR`/`ema200Side` and the `td:`/`a200:` trace tokens, budget-neutral (7990 → 7990). Not yet done: `FLAG_21` itself (M10's actual scope; nothing to teach until M7 exists).

Run the quick pass before M0's later phases; the phases below build on it.

Execution order is M0 → M1 → M2 → M2b → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10. M1 comes early on purpose: every later phase reports its effect on replay outcomes.

Deploy points: M2–M8 (including M2b) are additive behind `include=model` and may deploy individually after review (owner's call). The default payload changes only at M7 (the `FLAG_21` entry) and the GPT changes only at M10.

---

## Phase M0 — Model spec and fixtures

Objective: turn the model above into testable rules and ground truth before any code.

Build:
1. `docs/TRADING_MODEL.md`: each principle M-1…M-9 (including M-5b and M-6b) as numbered, testable rules (inputs, output, long and short wording), plus the gap matrix above with file/function pointers.
2. Owner-labeled fixtures: `test/fixtures/model/` with at least 6 historical moments (3 long, 3 short; at least one counter-sentiment channel-edge trade, one flag whose measured-move target was hit, one where a major level stopped it short, and one full-alignment trade) captured with `scripts/replay.js --capture`. Each label: symbol, closedThrough, sentiment, channels per timeframe, major levels, expected flag with its pole base and measured target (tf, direction), expected divergence, expected entry/stop/TP1 region, expected outcome if known. The owner supplies or approves every label.
3. Open-decision list (see "Open decisions") answered or defaulted in the doc.

Not in scope: code.

Acceptance: the owner signs off `docs/TRADING_MODEL.md` and the labels.

## Phase M1 — Replay outcome scoring

Objective: measure what matters for this model (win rate, average R, expectancy, losing streaks, hold time) for any strategy on replay.

Build: extend `scripts/replay-metrics.js` (or a sibling `scripts/replay-outcomes.js`) to take each valid strategy signal from the replay JSONL, walk forward over stored candles without lookahead, and record first touch of stop vs TP1 vs TP2 (entry = first touch of the entry zone within a config window, else "not filled"), R achieved, hold time to exit, and time-to-TP1. Aggregate per strategy: signals, fills, win rate, average win R, average loss R, expectancy, max consecutive losses, median hold time. Same-candle stop and target touch counts as a loss (conservative). Config keys under `replay.outcomes`.

Tests: `test:replay` additions with synthetic candles: long win, long loss, short win, short loss (mirrored), not filled, same-candle ambiguity → loss, streak counting.

Acceptance: a baseline outcome table for SCALP_1H, TREND_RIDER, and MICRO_SCALP on the captured history, written into this plan's M1 row.

## Phase M2 — Top-down sentiment

Objective: one explained sentiment read over 1W/1D/4H/1H that drives confidence (M-1, M-2).

Build:
1. 1W candles derived from the 1D series already fetched (reuse the 1D → 1W aggregation logic from `services/marketData.js` by extracting a pure helper; no new network call). Weekly indicators: EMA21, structure, Stoch RSI. Weekly EMA200 is `null` with a reason (not enough history).
2. `lib/topDown.js`: per-timeframe lean for 1W/1D/4H/1H (reuse `timeframeBias()` from `lib/biasMatrix.js`), then `sentiment: bull | bear | mixed`, `alignment: 0–4` (count of the four agreeing with the sentiment), `alignmentScore` 0–1 with weights in config (higher timeframes weigh more), and the per-timeframe leans.
3. Payload: `symbols.X.model.topDown` behind `include=model`. One compact token in the default trace string only if ≤ 40 bytes per symbol (for example `td:bull:4/4`).

Rules: alignment never gates a strategy. Mirrored inputs → mirrored sentiment, identical score.

Tests: `test-top-down.js` (`test:topdown`): full bull, full bear (mirror), mixed, missing weekly history, weekly EMA200 null.

Acceptance: live payload shows `model.topDown` for BTC/ETH/SOL with include=model; default payload bytes reported.

## Phase M2b — Cross-timeframe EMA21/200 direction and pull

Objective: turn every timeframe's EMA21 and EMA200 into a direction input and a pull read, weighted so higher timeframes dominate (M-6, M-6b). Moving averages are never targets.

Build:
1. `lib/maMap.js`, pure: for each timeframe 1m–1W, price side of the EMA21 and EMA200 (above/below) and distance %. Weekly EMA200 is null (M2).
2. `above200: { count, of, timeframes }` and the mirror `below200`, plus a weighted score where higher timeframes weigh more and lower timeframes are discounted (config `model.maWeights`).
3. Pull read: per timeframe, whether price is stretched away from its 21/200 and likely to be pulled back toward them (distance in ATR, slope from existing EMA histories), summarised as `pull: up | down | none` with the timeframe driving it. A major support/resistance zone or channel line between price and the average marks the pull as `overridden` (M-6).
4. Output feeds M2's sentiment and M6's confidence. It never produces a price target.
5. Payload: `symbols.X.model.maMap` behind `include=model`, compact tokens.

Rules: no filtering; direction symmetry (mirrored series → mirrored map, identical scores).

Tests: `test-ma-map.js` (`test:mamap`): all timeframes above 200 vs mirror, mixed counts, higher-timeframe weighting beats a lower-timeframe majority, stretched price → pull toward the average, major level in between → `overridden`, weekly EMA200 null.

Acceptance: live payload shows `model.maMap` with include=model; build duration reported.

## Phase M3 — Channels per timeframe, edge targets, breakout read

Objective: report the channels price is in on each timeframe, where each direction's target sits, and how likely an edge breaks (M-3, M-4). No channel is chosen as "governing".

Build:
1. Add 1D to the geometry timeframes only inside the model block (the default `geometryContext` set stays 15m/1h/4h to protect the payload).
2. `lib/channelModel.js`: for each of 15m/1h/4h/1D, the detected channel (fallback: horizontal range from that timeframe's strongest support/resistance zones) as `{ timeframe, kind: channel|range, top, bottom, positionPct }`. Per direction, `levelsAhead`: the channel lines, major support/resistance zones, and confluence zones in front of price across these timeframes, ordered by distance. Moving averages are not included (M-6). No selection of one channel.
3. Breakout read at each nearby edge: `breakoutRisk: low | medium | high` with its basis tokens (momentum into the edge from Stoch acceleration, prior rejections at the edge, extension risk, sentiment agreement with a break, moving-average pull toward or away from the edge from M2b, divergence at the edge once M5 lands). Counter-sentiment trades toward an edge get this read attached (M-4).
4. Payload: `symbols.X.model.channels` behind `include=model`.

Tests: `test-channel-model.js` (`test:channel`): ascending channel long/short edges, mirrored descending channel, range fallback, channels on two timeframes reported side by side, no channel → null with reason, `levelsAhead` ordering (no moving averages), breakout read ordering (more rejections → lower breakout risk), mirrored scores.

Acceptance: labeled fixtures from M0 produce the labeled channels and edges.

## Phase M4 — Flags on all timeframes, EMA200 side, channel position, measured move

Objective: find EMA21 flags wherever they form and describe them in model terms, including the measured-move target (M-5, M-5b, M-6).

Build:
1. Extend flag detection to 15m/1h/4h inside the model block (`config.model.flagTimeframes`); the default `candidateSetups` stays 1m/3m/5m. Reuse `detectFlagLifecycle()`; no second detector.
2. Per flag: `ema200Side: above | below`, `ema200DistancePct`, `above200Count` (from M2b), `poleBase`, `poleHeight`, `measuredTarget` (pole length projected from `breakoutLevel` in the flag's direction; publish the impulse the detector already measures), `channelPositionPct` per timeframe (from M3), `withSentiment: true|false` (from M2). No filtering on any of them.
3. Payload: `symbols.X.model.flags[]` behind `include=model`, compact fields only.

Tests: extend `test:pattern` fixtures: bull flag above EMA200, bear flag above EMA200 (the M-6 case), bull flag below EMA200 (channel-bottom bounce), mirrored pairs, higher-timeframe flag on 1h, measured target long and mirrored short from a known pole.

Acceptance: build duration reported; ≤ +1 s.

## Phase M5 — Stoch RSI divergence

Objective: detect bullish and bearish divergence per timeframe and count cross-timeframe confluence (M-7).

Build:
1. `lib/divergence.js`: from price swing pivots (`swingPivots()` in `lib/geometry.js`) and Stoch RSI history, detect standard (regular) bullish (price lower low, Stoch higher low), standard bearish (price higher high, Stoch lower high), hidden bullish (price higher low, Stoch lower low), and hidden bearish (price lower high, Stoch higher high) divergence over a config lookback. Strength rises the closer the divergence's latest pivot is to the last closed candle, and for the timeframe being traded (config recency decay and timeframe weights). Output per timeframe `{ type: bullish|bearish|none, kind: standard|hidden, pivots, ageCandles, strength }`.
2. Cross-timeframe: `divergence.confluence = { bullish: n, bearish: n, timeframes: [...] }`.
3. Feed the breakout read in M3 (divergence at an edge lowers breakout risk for a fade).
4. Payload: `symbols.X.model.divergence` behind `include=model`.

Tests: `test-divergence.js` (`test:divergence`): synthetic standard bullish, standard bearish (mirror), hidden bullish, hidden bearish (mirror), none, noisy near-miss rejected, recent divergence stronger than an older one, multi-timeframe count.

Acceptance: labeled fixtures from M0 produce the labeled divergence.

## Phase M6 — Composite confidence

Objective: one explained confidence number for a flag trade, driven mostly by top-down alignment (M-2, M-8).

Build: `lib/modelConfidence.js`, pure, weights in `config.model.confidence`: alignment (largest weight), channel position vs direction and room to target, flag quality/state, divergence confluence, weighted EMA21/200 direction and pull with or against the trade (M2b; higher timeframes dominate), breakout read (counter-sentiment penalty scaled by breakout risk). Output `{ confidence 0–100, breakdown: [{ factor, value, points }] }`. Full alignment with confluence should reach the high band; misaligned counter-sentiment with high breakout risk should land low (near 10%) but never be forced to zero by alignment alone.

Tests: `test-model-confidence.js` (`test:modelconf`): monotonic in each factor, mirrored inputs → equal confidence, breakdown sums to the total, full alignment vs 1-of-4 alignment ordering.

Acceptance: labeled fixtures rank in the owner's expected order.

## Phase M7 — `FLAG_21` strategy

Objective: a new strategy that trades the model, alongside the existing ones.

Build:
1. `strategies.FLAG_21` from the best qualifying model flag per symbol (highest M6 confidence; ties → higher timeframe):
   - Entry, two types (M-5), published as `entryType`:
     - `breakout`: the flag breakout level (snapped, from the lifecycle).
     - `flag-border`: the flag's lower border for a bull flag (upper for a bear flag) while the flag is still forming, following the flag's channel lines; stop just beyond that border, target the opposite border first.
     Both go through the same ≥ 3R gate to TP1. Direction from the flag.
   - Stop, two types (owner 2026-09-23), published as `stopType`: `structure` = beyond the nearest major support/resistance level behind the entry (wider); `tight` = just beyond the flag channel's bottom (top for a bear flag). Publish both prices when they exist; the default `stopLoss` is the one that passes the ≥ 3R gate, preferring `structure`.
   - Stop: flag invalidation with ATR buffer. If the entry timeframe is ≤ 1h, apply the same ≤ 3% stop cap as the scalps (see Open decisions).
   - TP1: the flag's measured move (M4 `measuredTarget`). If a major level from M3's `levelsAhead` (channel line or major support/resistance zone) sits before it, that level becomes TP1 and the measured move becomes TP2; otherwise TP2 is the next major level beyond, or null. Moving averages are never targets.
   - Gate: R to TP1 < `config.model.minRR` (default 3.0) → canonical NO_TRADE with a stable `rejectionCode`.
   - Confidence from M6; `risk` block from the existing `attachRisk`.
   - Canonical NO_TRADE contract identical to the other strategies.
2. `decisionTrace.strategies[]` gets FLAG_21 with `rejectedAt` codes (engine plan rule 10: stable codes, not regex).
3. `bestSignal` selection is unchanged (FLAG_21 is not preferred until M9/M10).
4. Default payload: the FLAG_21 strategy entry is added; report bytes. OpenAPI: FLAG_21 in the strategies map. Schema minor bump.

Tests: `test-flag21.js` (`test:flag21`): valid long and mirrored short, counter-sentiment short above EMA200 valid with lower confidence, < 3R rejected, stop cap rejection, canonical NO_TRADE shape, existing strategies byte-identical on the same fixtures.

Acceptance: live payload shows FLAG_21; no existing strategy changed on replay fixtures.

## Phase M8 — Survival sizing

Objective: make sizing survive the losing streaks a ~30% win rate produces (M-9).

Build: `lib/riskEngine.js` addition, `survivalCheck({ winRate, trades, riskPerTradePct })` → expected longest losing run and drawdown at that run (compounded). Config: `model.expectedWinRate` (0.30), `model.maxStreakDrawdownPct` (owner decides; default proposal 15%). Attach `risk.survival = { expectedLosingRun, drawdownAtRunPct, withinLimit }` to FLAG_21 only. `withinLimit=false` never changes validity; the GPT uses it to size down.

Tests: `test:risk` additions: known values (p=0.3, n=100 → run ≈ 13), monotonic in risk %, mirrored directions identical.

## Phase M9 — Replay comparison and go/no-go

Objective: evidence that FLAG_21 is better before the GPT prefers it.

Build: run M1 outcome scoring over the captured history for FLAG_21 vs SCALP_1H (and TREND_RIDER, MICRO_SCALP for context). Report per strategy and direction: signals, fills, win rate, average R, expectancy, max losing streak, median time-to-TP1, and FLAG_21 by alignment band (4/4, 3/4, ≤ 2/4) and with/against sentiment.

Acceptance (owner decides): FLAG_21 expectancy > 0 and ≥ SCALP_1H's; win rate ≥ ~30% or average R compensating; median time-to-TP1 recorded for the GPT's time estimates. Write the table into this plan. No-go → iterate on M3–M7 thresholds (config only) in a new thread; never tune on the M0 labels alone.

## Phase M10 — GPT instructions and deploy

Objective: the GPT uses FLAG_21 and the model fields, within the instruction budget.

Build: `docs/GPT_INSTRUCTIONS.md`: read FLAG_21 first when valid; state alignment (n/4) and sentiment; counter-sentiment trades must cite the breakout read; time estimates from M9's median time-to-TP1. Trim an equal amount elsewhere; `npm run check:gpt` ≤ 7,990. Update the GPT test sheet (add a FLAG_21 long, a counter-sentiment short above EMA200, and a misaligned low-confidence case). Deploy after review; verify per `docs/EDITTRADES_MCP_CONNECTOR.md`.

Acceptance: owner runs the test sheet in a fresh GPT chat.

---

## Open decisions (answer in M0; defaults apply if unanswered)

1. FLAG_21 stop cap: apply the ≤ 3% scalp cap to entries on ≤ 1h timeframes? Default: yes.
2. Per-trade wallet risk for FLAG_21 and the streak drawdown limit. Default: existing 2% cap, limit 15% (at 2% risk a 13-loss run is ~23%, so `withinLimit` would read false and the GPT sizes down).
3. Flag timeframes for entries: default 1m, 3m, 5m, 15m, 1h, 4h.
4. Hidden divergence: resolved 2026-09-23 — included, with standard; recency and traded-timeframe weighting (M-7).
5. Weekly EMA200: default null (insufficient history); weekly lean uses EMA21, structure, Stoch.

---

## Docs to update after each phase

This plan's phase row (status, date, files, test counts, payload bytes, build ms), `docs/TRADING_MODEL.md` when a rule's implementation lands, `docs/EDITTRADES_MCP_CONNECTOR.md` (schema map, `include=model`, test counts), `openapi/scalp-context.yaml`, `CHANGELOG.md`, `docs/DOCUMENTATION_INDEX.md` when a doc or module is added.

---

## Master prompt for the orchestrating agent

Copy from here.

```
You are the orchestration lead for the EditTrades trading-model workstream.

Repo: /Users/bballi/Documents/Repos/snapshot_tradingview, branch upgrade-signal-engine.

Source of truth, in order:
1. docs/MASTER_PLAN_TRADING_MODEL.md (this plan): the owner's model, decisions, rules, phases, acceptance.
2. docs/TRADING_MODEL.md once Phase M0 writes it.
3. docs/MASTER_PLAN_ENGINE_REFINEMENT.md governing rules 1-10 (still binding).
4. CLAUDE.md, docs/EDITTRADES_MCP_CONNECTOR.md, docs/GPT_INSTRUCTIONS.md.
5. The code on the branch. Current behavior is the baseline.

Your job: run one phase per implementer thread in the order M0 -> M1 -> M2 -> M2b -> M3 ... -> M10, review each result against
the plan, and report to the owner. You do not implement phases yourself.

Before each phase:
- Check git status, git log --oneline -8, and run all suites; report counts and whether the tree is clean.
- Write the implementer prompt for exactly that phase: objective, files to touch, files that stay
  untouched, tests, acceptance, budgets (payload bytes, build ms, GPT instruction units), and
  "stop after the phase".

Reviewing a phase:
- Verify against the phase's acceptance criteria and the governing rules: additive only, direction
  symmetry with mirrored tests, config constants, schema/openapi in step, include=model for new
  blocks, payload headroom >= 0.5 KB, build +<= 1 s, GPT instructions <= 7,990 units, no dead-module
  imports, no MCP or REST auth changes, all suites green, git diff --check clean.
- Output: Verdict, Findings, Risks, Recommended next step. Findings first.
- Update the phase row in the plan only after the owner accepts.

Never: commit, push, deploy, change Vercel env or secrets, enable trading, or make paid calls without
the owner's OK in this session. Never print secrets. Never register an execution tool in MCP.
Never let alignment veto a trade, or the EMA200 side filter a flag (owner decisions).
If an acceptance criterion cannot be met as written, stop and say which one and why.

Start with Phase M0.
```
