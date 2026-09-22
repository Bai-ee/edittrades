# EditTrades Engine Refinement — Phased Master Plan

Last updated: 2026-09-22
Branch: `upgrade-signal-engine`
Source inputs: `~/Downloads/EditTrades_Master_Orchestration_Handoff_v1.md` (product/orchestration intent), this repo (current truth).
Companion docs: `docs/EDITTRADES_MCP_CONNECTOR.md`, `docs/SIGNAL_GENERATION_SPECIFICATION.md`, `CLAUDE.md`.

## Governing rules

1. Every phase is additive. New fields, new modules, new tests. Existing fields, contracts, and behavior stay byte-identical unless a phase says otherwise.
2. One phase per thread. Stop after each phase for review. Do not start the next.
3. Hard invariants, never relaxed:
   - `strategies.*` canonical contract: invalid → `direction: NO_TRADE`, all levels null, targets empty.
   - Scalp stop ≤ 3% from entry mid for SCALP_1H and MICRO_SCALP.
   - MCP: exactly one read-only tool, no auth, no execution or signing imports.
   - REST: Bearer `SCALP_CONTEXT_API_KEY`, 401/401/405/200.
   - Wallet unavailable ≠ zero. Wallet never changes `dataStatus`.
   - No secrets in code, logs, or payload.
4. Four suites must pass after every phase: `test:sltp`, `test:scalp`, `test:mcp`, `test:wallet`. Add a suite per new module.
5. Payload schema bumps are minor and additive: 1.1.0 → 1.2.0 → 1.3.0. Keep `openapi/scalp-context.yaml` in step.
6. Vercel Hobby: 12 functions, 10 s per invocation. No new `api/` files. Compute budgets matter.
7. Do not revive dead modules. `lib/signalEngine.js`, `services/strategy-refactored.js`, `lib/chartAnalysis.js`, `lib/advancedChartAnalysis.js` and `lib/levels.js` are unreachable from `buildScalpContext()`. No phase imports them without an explicit decision recorded here. `lib/advancedIndicators.js` is the one exception: phase 7 imports `calculateATR` from it.
8. Execution order is not phase number order: 0 → 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10 → 11. Phase 6 is a cheap precondition for the geometry phases; phase 5 sits directly before phase 7 so payload controls land right before the payload grows.

## Current architecture (what exists)

| Layer | Where | Notes |
| --- | --- | --- |
| Market data | `services/marketData.js`, `services/binance.js` | Closed candles per timeframe |
| Indicators | `services/indicators.js` (scalp path); `lib/advancedIndicators.js` (analyze endpoints only) | EMA21/200, Stoch RSI with slopes, trend. ATR lives in `advancedIndicators.js:98` and is unreachable from `buildScalpContext()` today. |
| Structure | `lib/structure.js` (direct), `lib/candleFeatures.js` (indirect, via `services/indicators.js:9`) | Symbol-level only, 1h-derived: swingHighs/Lows[5] (fractal lookback 3), support/resistance[3] nearest-first, session (1h, 15m fallback) + prev-day (1d) levels. `lib/levels.js` is NOT on this path. |
| Strategy engine | `services/strategy.js` | `evaluateAllStrategies` → SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP, `bestSignal`; `normalizeToCanonical` |
| Context builder | `services/scalpContext.js` `buildScalpContext()` | Payload schema 1.1.0; trims strategies; adds `account` |
| Wallet | `services/walletTracker.js` | Balances only. No positions, PnL, or trade history. |
| REST | `api/scalp-context.js` | Bearer |
| MCP | `lib/mcpHttp.js`, `services/editTradesMcp.js` | `get_scalp_context`, input `{}` |

Payload today per symbol: `price`, `source`, `structure`, `timeframes{1m,3m,5m,15m,1h,4h,1d}` (30 candles each, ema21, ema200, priceVs21Pct, priceVs200Pct, trend, stochRsi), `strategies`, `bestSignal`. Size ~60 KB.

Measured 2026-09-22 (`docs/RULE_OWNER_MATRIX.md`): 61 KB total, ~20 KB per symbol, 88% of it candles. Compute already runs on 499 closed candles per timeframe (3m: 239, derived from 1m); only the published slice is 30/24/20/10. Build takes 749 ms locally, 0.7-1.7 s in prod against a 10 s limit.

Already present that the handoff doc lists as missing: swings, S/R, session/prev-day levels, EMA relationships, Stoch RSI slopes and cross.

Genuinely missing: ATR, EMA slopes, higher-low/lower-high flags, room to next level, diagonal lines, horizontal zones, pattern lifecycle, confluence, decision trace, config version, leverage math, candidate channel independent of strategies, 1m/3m consumers.

## Phase map

| Phase | Deliverable | Size | Risk | Status |
| --- | --- | --- | --- | --- |
| 0 | Field inventory + rule-to-owner matrix | 30 min | none | ✅ done 2026-09-22 → `docs/RULE_OWNER_MATRIX.md` |
| 1 | `config/engine.json` + `configVersion` | 1 h | low |
| 2 | `decisionTrace` per symbol | 1–2 h | low |
| 3 | Risk engine: leverage cap from stop distance | 1–2 h | low |
| 4 | `candidateSetups[]` + 1m/5m flag detector + BTC fixtures | 3–4 h | medium |
| 6 | Assert compute depth (already fetching 500; test + duration log) | 15 min | none |
| 5 | Payload controls: tool args `symbols`, `include`; compact mode | 1–2 h | low |
| 7 | Geometry A: pivots, horizontal zones, ATR, room-to-level | 1 day | medium |
| 8 | Geometry B: diagonal lines, confluence scoring | 1–2 days | high |
| 9 | Pattern lifecycle + `needsVisualConfirmation` | 1 day | medium |
| 10 | Replay harness + miss-log fixtures | 1 day | low |
| 11 | GPT instruction trim | 1 h | low |

Phases 1–4 are the "five things" from review. 6 then 5 are the prerequisites for geometry, in that order (see governing rule 8). 7–10 are the geometry engine. 11 is last on purpose: instructions shrink only after code carries the rules.

---

## Phase 0 — Inventory and rule-to-owner matrix

Objective: ground every rule in the handoff doc against actual payload fields and code paths. No code.

Output: `docs/RULE_OWNER_MATRIX.md` with one row per handoff-doc rule: rule, owner (API / GPT / CONFIG / VISUAL / TEST), exists today (yes/partial/no), where, phase that delivers it.

Also record: candle count per timeframe at fetch vs publish; function duration today; payload bytes per symbol.

Acceptance: matrix complete; no "unknown" cells.

---

## Phase 1 — Config and `configVersion`

Objective: move tunable constants out of `services/strategy.js` prose into one versioned file.

Files:
- new `config/engine.json` (or `.js` for comments): `maxScalpStopDistancePct: 3`, RR targets per strategy, EMA distance thresholds used in scalp/micro gating, breakout tolerance, `configVersion: "2026.09.22-1"`.
- `services/strategy.js`: read constants from config. `MAX_SCALP_STOP_DISTANCE_PCT` stays exported, sourced from config.
- `services/scalpContext.js`: add top-level `configVersion`. Schema → 1.2.0.
- `openapi/scalp-context.yaml`: add field.

Keep: every current numeric value identical. This phase changes zero behavior.

Tests: existing four suites unchanged and green. Add one test: config values load and match documented defaults; `configVersion` present in payload.

Acceptance: `git diff` shows constants moved, not changed. Payload has `configVersion`.

---

## Phase 2 — `decisionTrace`

Objective: make every recommendation explainable from the payload, not from console logs.

Shape (per symbol):
```
decisionTrace: {
  configVersion,
  evaluatedAt,
  strategies: [
    { name, ran: true, valid: false, rejectedAt: "stop-distance", reason },
    ...
  ],
  bestSignal, bestSignalReason,
  window: { "1m": { from, to, closedCandles }, ... },   // compute window actually used, per timeframe
  candidateSetups: []        // filled in phase 4
  geometry: null             // filled in phase 7+
}
```

Files:
- `services/strategy.js`: `evaluateAllStrategies` already logs why each strategy failed. Collect those reasons into a returned trace object instead of console only. Do not change the decisions.
- `services/scalpContext.js`: attach `decisionTrace` per symbol. Trim to strings and short arrays; budget ≤ 2 KB per symbol.
- `services/scalpContext.js`: fill `window` from the closed array per timeframe — first and last candle timestamp plus count. `closedThrough` and `candleCount` alone do not pin the window, and handoff §19 asks for the exact candle range used.
- Decide `dataQualityConfidence` here: `dataStatus` + `warnings[]` is the field. Do not add a second scored one.

Tests: `test-scalp-context.js`: trace present for all three symbols; every strategy name appears once; rejected strategies carry a non-empty reason; a rejected scalp stop shows `rejectedAt: "stop-distance"`; `window` covers every requested timeframe with `to` equal to that timeframe's `closedThrough`.

Acceptance: BTC's earlier "6.18% stop" rejection is readable from the payload alone.

---

## Phase 3 — Risk engine: leverage from stop distance

Objective: code enforces "structural stop first, leverage second". Eliminates the 100x-vs-3%-stop contradiction.

New module `lib/riskEngine.js`, pure functions:
- `maxLeverageForStop(stopDistancePct, { liquidationBufferPct, maintenanceMarginPct })` → integer leverage where liquidation sits beyond the stop plus buffer.
- `positionPlan({ marginUsd, stopDistancePct, leverageRequested, maxWalletRiskPct })` → `{ leverage, notionalUsd, lossAtStopUsd, lossAtStopPct, capped: bool, capReason }`.

Config (phase 1 file): `liquidationBufferPct`, `maintenanceMarginPct`, `maxWalletRiskPct`, `defaultMarginUsd: 10`, `maxLeverage: 100`.

Payload: per valid strategy signal, add `risk: { maxLeverage, suggestedLeverage, lossAtStopUsd, lossAtStopPct }` computed from `account.margin.usd` when available, else null with `reason: "account unavailable"`. Never invent margin.

Tests: new `test-risk-engine.js`. Cases: 3% stop → max leverage well under 100x; 0.5% stop → higher cap; margin unavailable → nulls; requested leverage above cap → capped with reason; wallet-risk cap binds before leverage cap when appropriate.

Acceptance: at 100x request with a 3% stop, payload shows capped leverage and the reason. GPT no longer needs to compute this.

---

## Phase 4 — `candidateSetups[]` and 1m/5m flag detector

Objective: a price-action flag is visible even when the strategy engine says NO_TRADE. Regression 001.

New module `lib/patternDetector.js`:
- Input: closed candles, ema21, stochRsi for one timeframe.
- Detects: impulse (N candles, range > k×ATR) → contraction (range shrinking, closes holding ≥ ema21 with wick tolerance) → local flag high.
- Output: `{ type: "flag", direction, state: forming|triggering|confirmed|failed, impulseStrength, compressionScore, flagHigh, flagLow, breakoutLevel, invalidation, ema21Hold: "hold"|"wick"|"acceptance_below", confidence }`.
- Deterministic per request. No cross-request state (stateless serverless). "State" is derived from the last candles each call.

Files:
- `lib/patternDetector.js` new.
- `services/scalpContext.js`: run on 1m, 3m, 5m per symbol. Attach `candidateSetups: [{ timeframe, ...detector output }]` per symbol. Keep separate from `strategies`. Add to `decisionTrace.candidateSetups`.
- Config: `flag.minImpulseAtr`, `flag.maxContractionRatio`, `flag.wickTolerancePct`, `flag.minCandles`.
- Schema → 1.3.0. OpenAPI updated.

Do NOT: change `strategies.*`, `bestSignal`, or any guard.

Tests: new `test-pattern-detector.js` with fixtures:
- REGRESSION_001_BTC_1M_FLAG: impulse → EMA21 hold → compression → break. Expect `confirmed`, and `strategies.SCALP_1H.valid === false` still.
- Wick below EMA21 then reclaim → `ema21Hold: "wick"`, candidate survives.
- Close and hold below EMA21 → `acceptance_below`, state `failed`.
- Extended breakout (price > k×ATR above flag high) → `chaseRisk: true`.
- No impulse → empty array.

Acceptance: BTC 1m fixture yields a candidate while engine remains NO_TRADE. Fixtures live in `test/fixtures/` and are the seed of the miss log (phase 10).

---

## Phase 6 — Assert compute depth

Objective: prove the geometry phases already have the history they need, and put a guard on it. Phase 0 measured the fetch path: `FETCH_LIMIT = 500` (`services/scalpContext.js:48`) yields 499 closed candles per timeframe, and indicators plus the strategy engine already run on that full array — only the published slice is trimmed. 3m is the exception at 239 (derived from 1m under Kraken's 720-row cap).

Change: no fetch change. Add a test asserting the compute window is ≥ 200 closed candles per timeframe (≥ 200 for 3m too, which 239 satisfies), and log build duration and payload bytes once per build.

Files: `services/scalpContext.js` (one duration/bytes log line), `test-scalp-context.js` (compute-window assertion).

Tests: `test:scalp` — published candle counts unchanged (30/30/30/24/24/20/10); compute window ≥ 200 per timeframe; 3m documented as the shallowest at 239.

Acceptance: duration and bytes logged; payload byte-identical; the assertion fails loudly if anyone lowers `FETCH_LIMIT`.

---

## Phase 5 — Payload controls

Objective: stop payload growth from breaking ChatGPT Actions and MCP clients before geometry adds bulk.

Changes:
- MCP tool input schema: `{ symbols?: ["BTC","SOL","ETH"], include?: ["timeframes","strategies","candidates","geometry","account","trace"], compact?: boolean }`. Default = today's full payload. Tool stays read-only; annotations unchanged.
- REST: same as query params `?symbols=BTC,SOL&include=…&compact=1`.
- `compact: true` → candles omitted, last-N indicator values only.
- Enforce a size guard: log payload bytes; warn over 80 KB.

Files: `services/editTradesMcp.js` (input schema + pass-through), `api/scalp-context.js` (query parse only, auth untouched), `services/scalpContext.js` (filtering after build).

Tests: `test:mcp` — tool still single, read-only; `symbols: ["BTC"]` returns one symbol; unknown include ignored; `{}` unchanged. `test:scalp` — REST filtering. Auth matrix unchanged.

Acceptance: hourly MCP run can request `compact` and stay small. Full payload byte-identical when no args.

---

## Phase 7 — Geometry A: pivots, zones, ATR, room

ATR decision (taken in phase 0): import `calculateATR` from `lib/advancedIndicators.js:98` and use it. Do not write a second ATR. `lib/advancedIndicators.js` is the one otherwise-dormant module a phase may import (governing rule 7); importing one named function does not pull the rest of that file onto the scalp path.

New module `lib/geometry.js`:
- `atr(candles, n)` — thin wrapper over `calculateATR`, returning `{ atr, atrPct }`.
- `swingPivots(candles, left, right)` → pivot highs/lows with indices. Deliberately a third name: `lib/structure.js findSwings` (fractal, lookback 3, feeds the payload) and `services/indicators.js detectSwingPoints(closed, 20)` (rolling max/min, feeds the strategy engine) both stay as they are.
- `higherLows / lowerHighs` booleans and counts from pivots.
- `horizontalZones(pivots, atrTolerance)` → clustered zones `{ low, high, touches, lastTouchAt, side }`.
- `roomTo(price, zones)` → `{ nextSupport, nextResistance, roomUpPct, roomDownPct }`.
- `extensionRisk(price, ema21, atr)`.
- `emaSlope(history, n)` → slope of EMA21 and EMA200 over the last n values, as % per candle. The histories already exist (`services/indicators.js` returns `ema.ema21History` / `ema200History`) and are dropped today. Handoff §3 "prefer a flag riding a **rising** EMA21" cannot be evaluated without this.
- `stochAcceleration(history)` → change in `slopeK` between the last two closes, so "reset then reaccelerate" (handoff §3, §4) is measurable. One extra derivative from the history `deriveStochRsi` already reads.

Payload per symbol per timeframe (behind `include: geometry`):
```
geometryContext: { timeframe, atr, atrPct, structure, higherLows, lowerHighs,
  horizontalSupportZones[], horizontalResistanceZones[], roomToNextSupport, roomToNextResistance,
  extensionRisk, ema21Slope, ema200Slope, stochAccelK, confidence }
```

Config: pivot left/right, ATR period, zone tolerance in ATR multiples, min touches.

Tests: `test-geometry.js` synthetic candles with known pivots and zones. REGRESSION_002 partial: 4h fixture shows horizontal demand zone with ≥ 2 touches. Rising-EMA fixture → positive `ema21Slope`; flat fixture → ~0. Stoch reset-then-reaccelerate fixture → positive `stochAccelK`. ATR matches `calculateATR` on the same candles exactly (one ATR, no drift).

Acceptance: zones match hand-marked fixture within tolerance. Compute time per symbol logged.

---

## Phase 8 — Geometry B: diagonals and confluence

Extend `lib/geometry.js`:
- `fitDiagonal(pivots, side)`: candidate lines through pivot pairs; score by touches within ATR tolerance and fit residual; require `minTouches` (config, default 3). Return `{ detected, slope, touches, currentLevel, currentDistancePct, lastTouchAt, fitError, confidence }` or `detected: false`. Never expose a line with fewer than `minTouches`.
- `confluenceZones`: overlap of diagonal level, horizontal zone, EMA21/200, session/prev-day levels → `{ low, high, components[], score }`.

Payload: add `diagonalSupport`, `diagonalResistance`, `confluenceZones[]` to `geometryContext`.

Tests: synthetic rising channel → diagonal support with 3+ touches; noisy data → `detected: false`. REGRESSION_002 full: 4h fixture exposes rising support + horizontal demand as one confluence zone with current distance.

Acceptance: fixture passes. Precision over recall: false lines are worse than missed lines.

---

## Phase 9 — Pattern lifecycle and visual gate

Objective: unify phase 4 flags with phase 7–8 geometry into one pattern object with lifecycle, and tell the GPT when it should ask for a screenshot.

- Extend `lib/patternDetector.js` to use zones/diagonals for `breakoutLevel` and `invalidation`.
- Lifecycle `none → forming → triggering → confirmed → failed`, derived per request from the candle window (no store).
- `needsVisualConfirmation: boolean`, `unresolvedGeometry: []` set when: candidate present but `geometryContext.confidence` below config threshold, or diagonal candidates exist with touches = minTouches − 1.

Tests: state transitions on a scripted candle sequence; visual flag set exactly under the documented conditions.

Acceptance: GPT instruction for the visual gate can be reduced to "if `needsVisualConfirmation`, ask for the named timeframe".

---

## Phase 10 — Replay harness and miss log

- `scripts/replay.js`: run the full feature pipeline over stored historical candles, one close at a time, no lookahead. Emit per-close `decisionTrace`, candidates, geometry.
- `test/fixtures/misses/`: one JSON per logged miss: pre-image read, missing feature, post-image read, miss class, proposed feature, status. Each miss becomes a regression test when implemented.
- Metrics: candidate precision/recall against hand-labelled fixtures; rate of `needsVisualConfirmation`. Track over time; it should fall.

Acceptance: REGRESSION_001 and 002 reproduce from replay, not only from unit fixtures.

---

## Phase 11 — GPT instruction trim

Only after 1–10. Remove from GPT instructions anything the payload now carries: stop-distance math, leverage math, flag detection rules, visual-gate heuristics. Keep: evidence weighing, uncertainty language, output format, no-trade watch format, "engine output is input".

Acceptance: instruction length drops; behavior on the two BTC fixtures unchanged or better.

---

## Out of scope, needs separate decision

- Open positions, liquidation prices, PnL, trade history in `account`. Requires perps-provider reads and a trade log. Trading-sensitive modules. Own workstream.
- Any write path from GPT or MCP. Miss log is repo fixtures, not an API.
- Cross-request pattern state store (KV). Revisit only if per-request derivation proves insufficient after phase 9.

---

## Master prompt for the orchestrating agent

Copy from here.

```
You are the orchestration lead for the EditTrades engine refinement.

Source of truth, in order:
1. docs/MASTER_PLAN_ENGINE_REFINEMENT.md (this plan). Phases, invariants, acceptance criteria.
2. The repository on branch upgrade-signal-engine. Current behavior is the baseline.
3. docs/EDITTRADES_MCP_CONNECTOR.md and CLAUDE.md for connector and security rules.
4. ~/Downloads/EditTrades_Master_Orchestration_Handoff_v1.md for product intent only. Where it conflicts with the repo or this plan, the plan wins.

Working rules:
- Execute exactly one phase per thread. Start with the phase the user names. If none is named, start with Phase 0.
- Execution order is 0 → 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10 → 11, not phase-number order. Phase 0 is done: read `docs/RULE_OWNER_MATRIX.md` before touching code.
- Before coding: restate the phase objective in two sentences, list files you will touch, list what stays untouched. Then proceed.
- Every change is additive. Do not modify existing payload fields, strategy decisions, guards, MCP tool registration, REST auth, or wallet tracking unless the phase text says so explicitly.
- Hard invariants (never relax): canonical NO_TRADE contract; 3% scalp stop cap; one read-only MCP tool with no auth and no execution imports; REST Bearer 401/401/405/200; wallet unavailable is never zero; no secrets in code, logs, or payload.
- Constants come from config/engine.json once Phase 1 lands. Do not add new magic numbers.
- Every new module ships with its own test file and npm script. The four existing suites (test:sltp, test:scalp, test:mcp, test:wallet) must pass after every phase. Run them and report exact counts.
- Schema changes bump schemaVersion (minor) and update openapi/scalp-context.yaml in the same phase.
- Payload size and function duration are budgets. Log both. Do not exceed 80 KB default payload or approach the 10 s Vercel limit.
- No new files under api/. Vercel Hobby is at the 12-function cap.
- Do not commit, push, deploy, rotate secrets, or enable trading unless the user explicitly asks in that thread.
- Do not refactor adjacent code. Do not rename existing fields. Do not "clean up" strategy.js beyond the phase.

After the phase:
- Report: files changed, behavior added, what stayed untouched, test results by suite with counts, manual verification steps left, risks.
- Update the phase's row in this plan with status and date.
- Stop. Wait for review before the next phase.

If a phase's acceptance criteria cannot be met as written, stop and say exactly which criterion blocks and why. Do not narrow the criterion silently.

Deliverables per phase are in the plan. Phase 0 is complete; its output is docs/RULE_OWNER_MATRIX.md, which corrects several assumptions in the handoff doc and pins the measured baseline (61 KB payload, 499-candle compute window, sub-2 s builds).
```
