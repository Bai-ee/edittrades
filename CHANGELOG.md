# Changelog

## 2026-09-22 — Scalp context engine (branch `upgrade-signal-engine`)

Payload schema 1.1.0 → 1.8.0, live in production. Details: `docs/MASTER_PLAN_ENGINE_REFINEMENT.md`, `docs/EDITTRADES_MCP_CONNECTOR.md`.

- **2026-09-21:** read-only MCP connector (`get_scalp_context`), tracked-wallet `account` block (schema 1.1.0), scalp stop-distance guard (3% max from entry mid for SCALP_1H and MICRO_SCALP), `stopSource`.
- **Phase 1:** `config/engine.json` + `configVersion`; engine constants (thresholds, R:R, stop buffers, scalp max stop) moved out of code.
- **Phase 2:** per-symbol `decisionTrace` (1.3.0).
- **Phase 3:** `lib/riskEngine.js` — leverage cap from stop distance, loss at stop, per-signal `risk` block (1.4.0).
- **Phase 4:** `lib/patternDetector.js` — 1m/3m/5m flag detector, long and short, `candidateSetups[]` (1.5.0).
- **Phase 5:** payload controls `symbols` / `include` / `compact`, config snapshot, `lossAtStopPctOfWallet` (1.6.0).
- **Phase 6:** compute-depth assertion, build-duration log.
- **Phase 7:** `lib/geometry.js` — pivots, horizontal zones, shared ATR, room to level, EMA slope, candidate risk (1.7.0).
- **Phase 8:** diagonals, channel, confluence zones (1.8.0).
- **Phase 10:** replay harness `scripts/replay.js` (production pipeline per closed candle, no lookahead, live capture with 1m trade backfill), `scripts/replay-metrics.js` (candidate counts, visual-gate rate, lifetime, label precision/recall), miss log `test/fixtures/misses/` (MISS_001, MISS_002). No payload change; configVersion 2026.09.22-8 (`replay.minComputeCandles`).
- **Phase 9b:** `lib/biasMatrix.js` — per-timeframe bias matrix, alignment (with/counter-trend, room to the nearest HTF zone), decisionInputs (scalp/swing directional triples), opt-in via `include: bias`; `decisionTrace.bias` summary; failed trace strings carry `failReason`; visual gate: `lifecycle.nearMissGate` (default false) and visualTarget prefers triggering/confirmed (replay gate rate 0.54 → 0.05). Schema 1.9.0 → 1.10.0, configVersion 2026.09.22-9.
- **Phase 11:** GPT instruction trim + payload headroom. `docs/GPT_INSTRUCTIONS.md` is now the Custom GPT instructions source of truth (7990 → 7836 UTF-16 units), gated by `scripts/check-gpt-instructions.js` / `npm run check:gpt`; trimmed rules the payload already carries (flag-pattern anatomy, stop-distance-driven leverage narrative, geometry field shapes) and added coverage for `decisionTrace.bias` grammar, the `failReason` trace token, and `include=bias` MCP-only gating. `decisionTrace.window` drops `from`; `decisionTrace.geometry` strings round to 2 decimals and drop `na` tokens. No schema/config bump; 729 bytes recovered on the default 3-symbol payload.
- **In progress:** Phase 8b, on-demand confirmation chart (`lib/chartRender.js`).

## 2026-09-23 — Trading-model quick pass Q1-Q5 (branch `upgrade-signal-engine`)

Owner's trading model (`docs/MASTER_PLAN_TRADING_MODEL.md`, M-1..M-9), quick-pass subset per `docs/PLAN_TRADING_MODEL_QUICK_PASS.md`. Additive only; no strategy decision, stop, target, confidence, or `bestSignal` changed. Schema 1.10.0 → 1.11.0, configVersion 2026.09.22-9 → -10.

- **Q1 — measured-move flag targets (M-5b):** `lib/patternDetector.js` publishes `poleHeight`, `measuredTarget`, `measuredRR` on every flag candidate (not coils); `measuredMoveFor()` is called again after geometry snapping so a moved `breakoutLevel` keeps a consistent target. Never a target from a moving average.
- **Q2 — `ema200Side` on flag candidates (M-6):** `above` / `below` / `null` (EMA200 unavailable), computed in `services/scalpContext.js` from the candidate's own timeframe. Never filters - a short above the 200 or a long below it still publishes.
- **Q3 — top-down sentiment (M-1, M-2, M-6, M-6b):** new `lib/topDown.js` (pure, no I/O) - `weeklyFromDaily()`/`buildWeeklyLean()` (1W from the already-fetched 1D candles, Monday-aligned weeks; weekly EMA200 always null, not enough history), `buildTopDown()` (weighted vote over 1W/1D/4H/1H, config `model.topDownWeights`), `buildAboveBelow200()` (config `model.above200Weights`). Default payload: `decisionTrace.bias` gets two more tokens, `|td:<bull|bear|mixed>:<n>/4|a200:<count>/<of>`. Full `symbols.X.topDown` object opt-in via `include=bias`. Never gates or changes a strategy, candidate, or confidence.
- **Q4 — replay outcome scoring (M-9, master plan M1):** new `scripts/replay-outcomes.js` / `npm run replay:outcomes` - walks a replay JSONL forward on 1m candles with no lookahead, scoring every valid strategy signal and every confirmed flag candidate (using Q1's `measuredTarget` as TP1): fill rate, win rate, average win R, expectancy, max consecutive losses, median time to TP1. Dev-only script, no production code path.
- **Q5 — GPT instructions (budget-neutral):** `docs/GPT_INSTRUCTIONS.md` teaches `measuredTarget`/`measuredRR`/`ema200Side` and the `td:`/`a200:` trace tokens; trimmed an equal amount elsewhere (duplicated field lists, redundant phrasing) to hold 7990 → 7990 UTF-16 units.
- New config: `config/engine.json` `model` key (`topDownWeights`, `above200Weights`, `weeklyMinWeeksForEma21`, `weeklySlopeLookbackWeeks`) and `replay.outcomes` (`fillWindowCandles`, `maxHoldCandles`).
- New tests: `test-top-down.js` / `npm run test:topdown` (14). Additions to `test-pattern-detector.js`, `test-scalp-context.js`, `test-bias-matrix.js`, `test-replay.js`. All twelve suites green (412 passing); `npm run check:gpt` OK (0 headroom); `git diff --check` clean.
- **Payload budget (2026-09-23):** published candles on 1m/3m/5m 30 → 24 and candle volume rounded to 2 decimals; `poleHeight` no longer published (equals |measuredTarget − breakoutLevel|); EMA values rounded to 2 decimals in the payload. Live default 3-symbol payload 81.3 KB → 74.3 KB.

## 2026-09-23 — F1: Flag Detection Coverage (branch `upgrade-signal-engine`)

Single implementer pass per `docs/PLAN_FLAG_DETECTION_COVERAGE.md`, fixing the incident where BTC/SOL/ETH 1m longs went silent or vanished around a real flag's lifecycle (`test/fixtures/history/2026-09-23`; see `test/fixtures/misses/MISS_003.json`). Detection and trade qualification stay separate: a flag is reported because its geometry exists, not because a strategy wants to trade it. Additive only; long and short share the one oriented code path throughout. Schema 1.11.0 → 1.12.0, configVersion 2026.09.22-10 → 2026.09.23-1.

- **Item 1 — `proto` state:** an impulse that qualifies with 1 to `minCandles - 1` pullback candles (no new extreme past the impulse peak) publishes as `state: "proto"`, no entry call. Lifecycle order: proto → forming → triggering → confirmed → failed / expired.
- **Item 2 — wider impulse lookback:** `flag.maxImpulseCandles` 8 → 20, verified against both replay histories (gate rate stayed under 0.15; see Verification below).
- **Item 3 — EMA21 reclaim:** a flag whose first candle is off-side of EMA21 but closes back on-side within `flag.reclaimCandles` (default 2) is valid; `ema21Hold: "reclaim"` (scores like `wick`). The acceptance-fail rule is unchanged.
- **Item 4 — failed stays visible:** a failed candidate stays in the default `candidateSetups` for `flag.failedTtlCandles` (default 10) candles of its own timeframe past failure, carrying `failReason` and the new `failedAt`; older failures still follow `config.flag.includeFailed`. The search window itself now reaches `flag.maxBreakoutAge + max(failedTtlCandles, expiredTtlCandles)` candles back so a failure this old is still findable.
- **Item 5 — `expired` state:** a flag that would still read `confirmed` more than `flag.maxBreakoutAge` candles past its break instead reads `state: "expired"`, `chaseRisk: true`, for `flag.expiredTtlCandles` more candles, then is no longer found - replacing the old silent drop at exactly `maxBreakoutAge` candles (the incident's SOL 14:57 miss).
- **Item 6 — stable identity:** `candidateId` (`"<SYMBOL>:<tf>:<direction>:<impulseStart ISO>"`) and `firstDetectedAt`, derived from this request's own candle window (`lib/patternLifecycle.js` `identifyCandidate`), so the same flag run keeps the same id across forming → triggering → confirmed. `impulseStart`/`impulseEnd` are not separately published (byte budget - both are mechanically derivable from fields already kept: `impulseStart` is `candidateId`'s own last segment, `impulseEnd` is `firstDetectedAt` minus one candle).
- **Item 7 — cheap geometry:** `flagSlope` (least-squares slope of the flag's own closes, % per candle, real price space), `breakoutDistancePct`, `invalidationDistancePct` (signed % from the last close), rounded to 2-4 decimals.
- **Item 8 — trade qualification:** new `lib/candidateQualifier.js`. Every candidate (flag or coil) gets `qual: { quality: low|med|high, decision: watch|wait|dont|actionable, reasons: [] }`, built only from data already in the payload (the symbol's other candidates, its geometryContext, Stoch RSI, the 4h bias lean, and the candidate's own ema200Side/chaseRisk/measuredRR) - never a new detection signal, never a probability of profit.
- **Item 9 — payload:** default 3-symbol payload settled at ~75.3 KB (77068 B measured) after `CANDLE_LIMITS` on 1m/3m/5m went 24 → 20 (F1's new per-candidate fields, plus more candidates surviving longer via items 1/4/5, had pushed a busy-market default to ~79.3-83.3 KB). Build time ~840 ms (unchanged order of magnitude). `decisionTrace.candidateSetups` trace strings gained the `proto`/`expired` states.
- **Item 10 — GPT instructions:** `docs/GPT_INSTRUCTIONS.md` - `flags` now covers every state including proto/failed/expired plus `qual.decision`+`reasons`; `forming` includes proto; a data-freshness note that closed candles may trail the live chart by one candle; `confidence=pattern evidence only` disambiguates it from the new `qual.quality`. Funded by tightening existing wording (no rule removed); FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7988 → 7988 UTF-16 units (net zero); schema marker bumped to 1.12.x.
- **Item 11 — MISS_003:** `test/fixtures/misses/MISS_003.json`, `status: validated` - replaying `test/fixtures/history/2026-09-23` now shows a 1m long candidate at every close 14:45-15:03 for BTC/ETH/SOL (nothing reads "none"), SOL triggers at 14:52 exactly as the incident predicted, and SOL's confirmed flag reads `expired` at 14:57 instead of vanishing.
- **Verification:** all twelve suites green (423 passing, up from 412); `npm run check:gpt` OK (2 units headroom, same as before); `git diff --check` clean. Replay gate rate: 2026-09-22 history 0.0509 → 0.1353; 2026-09-23 history 0.0504 → 0.1485 (both under the 0.15 stop threshold). Flag-candidate expectancy moved in both directions across the six (symbol × direction) groups with materially more signals per group (more detection, the plan's intent); no group flipped from healthy to broken. Full before/after numbers: `docs/EDITTRADES_MCP_CONNECTOR.md`, implementer report.
- New config: `config/engine.json` `flag.reclaimCandles` (2), `flag.failedTtlCandles` (10), `flag.expiredTtlCandles` (10), `flag.quality` (`highConfidence` 75, `medConfidence` 50), `flag.maxImpulseCandles` 8 → 20.
- New module: `lib/candidateQualifier.js`.
- New tests: additions to `test-pattern-detector.js` (26 → 32), `test-replay.js` (30 → 31, incl. MISS_003), `test-scalp-context.js` (CANDLE_LIMITS 20), `scripts/replay-metrics.js` STATES list extended (proto, expired).

## 2025-11-27

### 📊 Professional Trading Indicators - VWAP, ATR, Bollinger, MA Stack

- **VWAP (Volume Weighted Average Price)** - Intraday timeframes (5m, 15m, 1h):
  - Value and distance percentage
  - Above/below detection and bias direction
  - AtVWAP flag (within 0.2%)
  - Reversion zone detection (> 2% away)
  - Trapped longs/shorts positioning logic
  
- **ATR (Average True Range)** - All timeframes:
  - ATR value and percentage of price
  - Volatility state classification (LOW/NORMAL/HIGH)
  - Guides position sizing and stop-loss placement
  
- **Bollinger Bands** - 4h, 1h, 15m:
  - Upper, middle, lower bands
  - Band width percentage
  - Squeeze detection (bandwidth < 2%)
  - Price position percentage (0-100 scale)
  - Overbought/oversold zones
  
- **MA Stack Analysis** - 4h & 1h:
  - EMA 50 added to existing 21 & 200
  - Bull/Bear/Flat stack detection
  - Trend structure confirmation
  
- **New Module**: `lib/advancedIndicators.js` with all calculations
- **Documentation**: `ADVANCED_INDICATORS_GUIDE.md` - Complete usage guide with thresholds

### 🎯 Advanced Candle Analysis & Price Action
- **Candle Metrics** (all timeframes):
  - Direction: bull/bear/doji
  - Body percentage (0-100%)
  - Upper/lower wick percentages
  - Close position within range
  - EMA21 relationship (above/below)
  - Full OHLC range

- **Price Action Patterns** (all timeframes):
  - Rejection Up/Down (wick-based reversals)
  - Engulfing Bull/Bear patterns
  - Inside Bar detection
  - Pattern detection from last 2 candles

- **Support & Resistance Levels** (4h & 1h only):
  - Nearest resistance/support prices
  - Distance to levels (percentage)
  - At level detection (within 0.5%)
  - Break detection (closed through level)

- **Recent Candles** (5m only):
  - Last 5 candles for LLM context
  - OHLC for each candle
  - Ordered oldest → newest

- **UI Updates**:
  - Removed colors from prices (EMAs, Swing High/Low)
  - Only trend indicators keep colors (UPTREND/DOWNTREND/FLAT)
  - Cleaner, more minimal appearance

- **New Modules**:
  - `lib/candleFeatures.js` - Candle analysis and pattern detection
  - `lib/levels.js` - Support/resistance calculation
  
- **Documentation**: `ENRICHED_SCHEMA.md` - Complete field reference and examples

### 📊 Expandable Detailed Timeframe Analysis
- **Show/Hide Details**: Click "Show" button on any coin to expand full timeframe breakdown
- **4 Detailed Cards**: Each timeframe (4h, 1h, 15m, 5m) displays:
  - Current Price
  - 21 EMA & 200 EMA
  - Stoch RSI (%K, %D, condition)
  - Pullback State (with distance from 21 EMA)
  - Swing High & Swing Low
  - Trend badge (color-coded border)
- **Responsive Grid**: 1 column on mobile, 2 on tablet, 4 on desktop
- **Color Indicators**: Green border for uptrend, red for downtrend, gray for flat
- **Collapsible**: Click "Hide" to collapse details and keep table compact

### 🚀 Auto-Run Homepage + Detailed Table View
- **Auto-Scan on Load**: Homepage automatically scans BTC, ETH, SOL on page load (no button click needed)
- **Detailed Table View**: Shows full trading info (price, signal, confidence, entry, stop loss, targets, timeframes)
- **Responsive Columns**: Hide less important columns on mobile (Entry on SM, Stop on MD, Targets on LG)
- **Click Row for Details**: Click any row to see full analysis in popup
- **Individual Copy**: Copy button for each coin in table
- **Copy All**: Export all 3 coins together
- **Unified UI**: Scanner page now matches homepage styling
- **Parallel Fetching**: All 3 coins fetched simultaneously (~3-4 seconds total)
- **Timeframe Badges**: Compact indicators showing trend for 4h, 1h, 15m, 5m

### 🎨 Major UI Redesign - Mobile-First Dark Theme
- **New Homepage**: Single-button scan for BTC, ETH, SOL
- **Dark Theme**: Pure black/off-white color scheme, no gradients or glows
- **Mobile-First**: Optimized for phone screens, minimal scrolling
- **Multi-Coin View**: Display all 3 coins in compact cards
- **Trade Opportunities Summary**: Quick overview of valid setups
- **Individual Copy Buttons**: Copy each coin separately
- **Copy All**: Export all 3 coins in single JSON
- **Compact Timeframe Display**: 2x2 grid on mobile, 4x1 on desktop
- **Visual Indicators**: Green/red left borders on cards with valid trades
- **Documentation**: `NEW_UI_GUIDE.md` with full design specs

### 📊 Added - Dashboard View JSON Copy Button
- **New Button**: 📊 View - Copies exactly what's displayed on dashboard as compact JSON
- **Auto-syncs**: Automatically includes any new fields we add to the dashboard
- **Size**: ~2-3KB (smaller than full API, includes all timeframes unlike LLM compact)
- **Use Cases**: Sharing analysis, trading journals, documentation, historical review
- **Documentation**: `DASHBOARD_VIEW_JSON.md` with examples and field reference

## [Previous] - 2025-11-27

### 🤖 Added - Compact API for LLM/ChatGPT Integration
- **New Endpoint**: `/api/analyze-compact/{symbol}` - Streamlined API response optimized for LLM ingestion
- **Size Reduction**: 99.75% smaller (470 bytes vs 192KB) - perfect for ChatGPT token limits
- **UI Integration**: Added 🤖 LLM button to dashboard and scanner for one-click copy to clipboard
- **Documentation**: 
  - `COMPACT_SCHEMA.md` - Complete JSON schema and field reference
  - `LLM_QUICK_START.md` - Quick start guide with ChatGPT prompt templates

### 🐛 Fixed - Mobile Error
- Added defensive null checks for `data.analysis` to prevent `Object.entries` error on mobile devices
- Enhanced error logging for better debugging across devices

### 📊 Features
- Compact response includes all essential trading data:
  - Trade signal (valid/invalid)
  - Direction (long/short/NO_TRADE)
  - Confidence score (0-100%)
  - Entry zone, stop loss, targets
  - Risk/reward ratio
  - 4H and 1H trend analysis
  - Key indicators (EMA21, EMA200, Stoch RSI)
  - Market structure (swing high/low)

### 📝 What's Removed (for size optimization)
- Raw candlestick OHLCV data
- 15m and 5m timeframe data
- Verbose nested indicator objects
- Debug information
- Redundant metadata

---

## Previous Updates

### 2025-11-26 - Copy Buttons for API Data
- Added copy-to-clipboard functionality for API endpoints
- Added copy buttons for full JSON responses
- Visual feedback for successful copies

### 2025-11-25 - Vercel Deployment
- Migrated from Express server to Vercel serverless functions
- Created `/api/analyze`, `/api/indicators`, `/api/scan` endpoints
- Added deployment protection configuration
- Fixed routing issues for path parameters

### Initial Release
- 4H Set & Forget trading strategy automation
- Multi-timeframe analysis (4h, 1h, 15m, 5m)
- Market scanner for finding opportunities
- Technical indicators: EMA, Stoch RSI, market structure
- Confidence scoring system

