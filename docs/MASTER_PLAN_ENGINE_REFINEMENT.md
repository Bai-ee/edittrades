# EditTrades Engine Refinement — Phased Master Plan

Last updated: 2026-09-22 (amended: Phase 3 position risk, 3b positions, 4 short mirrors, 8 channel, 9b bias matrix; docs sync after Phase 8, 8b in progress)
Status: phases 0–8 and 8b done, schema 1.8.0 / configVersion 2026.09.22-6 live in production. Phase 9 done locally (schema 1.9.0 / configVersion 2026.09.22-7), not deployed. Phase 10 done locally (replay harness, no payload change; configVersion 2026.09.22-8 for the `replay` config key), not deployed. Phase 9b done locally (schema 1.10.0 / configVersion 2026.09.22-9), not deployed. Phase 11 done locally (GPT instruction trim + payload headroom, no schema/config bump), not deployed.
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
8. Direction symmetry is a requirement, not a nice-to-have. Every detector, geometry feature, risk function, and fixture handles short and long through one parameterised path, with mirrored tests. A long-only implementation fails the phase.
9. Execution order is not phase number order. Done: 0 → 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8. Remaining: 8b → 9 → 9b → 10 → 11 → 8c → 3b (see the note under the phase map). Phase 6 was a cheap precondition for the geometry phases; phase 5 sat directly before phase 7 so payload controls landed right before the payload grew.
10. When any phase edits `services/strategy.js`, emit a stable `rejectionCode` from the engine and demote the regex classifier in `services/scalpContext.js` to a fallback. Until then, classifier patterns must be tested through the real `evaluateAllStrategies` path.

## Current architecture (baseline at Phase 0, schema 1.1.0)

This section records the starting point the plan was written against. For the current payload see `docs/EDITTRADES_MCP_CONNECTOR.md` (schema 1.8.0) and `openapi/scalp-context.yaml`.

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
| 1 | `config/engine.json` + `configVersion` | 1 h | low | ✅ done 2026-09-22 → `config/engine.json`, `config/engine.js`, `npm run test:config` |
| 2 | `decisionTrace` per symbol | 1–2 h | low | ✅ done 2026-09-22 → `services/scalpContext.js` (`buildDecisionTrace`, `buildStrategyTrace`, `buildTimeframeWindow`, `classifyRejection`), `openapi/scalp-context.yaml`, `npm run test:scalp` |
| 3 | Risk engine: leverage cap from stop distance, position risk, stop hierarchy, Miss 002 fixture | 2–3 h | low | ✅ done 2026-09-22 → `lib/riskEngine.js`, `config/engine.json` (`risk`), `services/scalpContext.js` (`attachRisk`), `npm run test:risk` |
| 3b | Read-only `account.positions[]` via throwaway-wallet SDK reads (existing provider path is signer-bound; see section) | 4–6 h | medium | ⏸ deferred 2026-09-22 (later enhancement; see section) |
| 4 | `candidateSetups[]` + 1m/5m flag detector, long AND short, mirrored fixtures | 3–4 h | medium | ✅ done 2026-09-22 → `lib/patternDetector.js`, `config/engine.json` (`flag`), `services/scalpContext.js` (`candidateSetups`), `test/fixtures/flagFixtures.js`, `npm run test:pattern` |
| 6 | Assert compute depth (already fetching 500; test + duration log) | 15 min | none | ✅ done 2026-09-22 (item F deferred to Phase 7) | ✅ done 2026-09-22 → `test-scalp-context.js` (compute-window assertion, production-sized fixture), `services/scalpContext.js` (build-duration log), `config/engine.json` (`configVersion` 2026.09.22-3 → -4, correcting Phase 5's unbumped `flag.includeFailed` addition) |
| 5 | Payload controls + payload hygiene: tool args `symbols`, `include`, `compact`; config snapshot; `lossAtStopPctOfWallet`; no-setup classifier; `flag.includeFailed` | 1–2 h | low | ✅ done 2026-09-22 → `services/scalpContext.js` (`filterPayload`, `buildConfigSnapshot`, `filterFailedCandidateSetups`), `services/editTradesMcp.js` (`TOOL_INPUT_SCHEMA`), `api/scalp-context.js` (query parse), `config/engine.json` (`flag.includeFailed`), `openapi/scalp-context.yaml`, schema 1.5.0 → 1.6.0, `npm run test:scalp` / `npm run test:mcp` |
| 7 | Geometry A: pivots, horizontal zones, ATR, room-to-level | 1 day | medium | ✅ done 2026-09-22 → `lib/geometry.js`, `lib/patternDetector.js` (`wilderAtr` → shared `calculateATR`, `flag.wickTolerancePct` → `flag.wickToleranceAtr`), `config/engine.json` (`geometry`, configVersion -4 → -5), `services/scalpContext.js` (`geometryContext`, `decisionTrace.geometry`, `attachCandidateRisk` = Phase 6 item F), `openapi/scalp-context.yaml`, schema 1.6.0 → 1.7.0, `npm run test:geometry` |
| 8 | Geometry B: diagonal lines, confluence scoring | 1–2 days | high | ✅ done 2026-09-22 → `lib/geometry.js` (`fitDiagonal`, `channel`, `confluenceZones`, `buildGeometryB`), `config/engine.json` (geometry B keys, `geometry.timeframes` drops 5m, configVersion -5 → -6), `services/scalpContext.js` (B fields on `geometryContext`), `openapi/scalp-context.yaml` (Diagonal, Channel, ConfluenceZone), schema 1.7.0 → 1.8.0, `test/fixtures/geometryPhase7Snapshot.json`, `npm run test:geometry` |
| 8c | Trade journal, minimal: Blob file, one write op with its own key, account.journal with basic stats | 1 h | low | ⏸ deferred 2026-09-22 (later enhancement; see section) |
| 8b | Confirmation chart: one server-rendered PNG, on demand only | 1 day | medium | ✅ done 2026-09-22 → `lib/chartRender.js`, `pureimage` 0.4.20, `assets/fonts/IBMPlexMono-Regular.ttf` + `OFL.txt`, `services/editTradesMcp.js` (`chart` arg, image block), `api/scalp-context.js` (`?chart`, image/png), `services/scalpContext.js` (`chart.onSeries` EMA hook, payload unchanged), `openapi/scalp-context.yaml`, no schema bump, `npm run test:chart` |
| 9 | Pattern lifecycle + `needsVisualConfirmation` | 1 day | medium | ✅ done 2026-09-22 → `lib/patternLifecycle.js` (snap, coil, visual gate), `lib/patternDetector.js` (`detectFlagLifecycle`), `lib/geometry.js` (`nearMissDiagonals`), `config/engine.json` (`lifecycle`, configVersion -6 → -7), `services/scalpContext.js`, `openapi/scalp-context.yaml` (CandidateSetup coil fields, LevelSource, DecisionTrace gate), schema 1.8.0 → 1.9.0, `test/fixtures/flagFixtures.js` (`invalidationClose`, `staleBreak`), `npm run test:pattern` / `npm run test:scalp` |
| 9b | Direction and multi-timeframe bias matrix; counter-trend classification | 1 day | medium | ✅ done 2026-09-22 → `lib/biasMatrix.js`, `lib/patternLifecycle.js` (`nearMissGate`, visualTarget preference), `services/scalpContext.js` (`includeBias`, `wantsBias`, `decisionTrace.bias`, failed trace token), `api/scalp-context.js` + `services/editTradesMcp.js` (include `bias` → `includeBias`), `config/engine.json` (`bias`, `lifecycle.nearMissGate`, configVersion -8 → -9), `openapi/scalp-context.yaml` (BiasEntry, Alignment, DecisionInputs, DirectionalTriple), schema 1.9.0 → 1.10.0, `npm run test:bias` |
| 10 | Replay harness + miss-log fixtures | 1 day | low | ✅ done 2026-09-22 → `scripts/replay.js`, `scripts/replay-metrics.js`, `test/fixtures/misses/` (MISS_001, MISS_002), `test/fixtures/replayHistories.js`, `test/fixtures/geometryFixtures.js` (moved from `test-geometry.js`), `config/engine.json` (`replay.minComputeCandles`, configVersion -7 → -8), no schema bump, `npm run test:replay` |
| 11 | GPT instruction trim + payload headroom | 1 h | low | ✅ done 2026-09-22 → `docs/GPT_INSTRUCTIONS.md` (source of truth, field table, GPT test sheet, change log; 7990 → 7836 UTF-16 units), `scripts/check-gpt-instructions.js`, `npm run check:gpt`, `lib/geometry.js` (`geometryTraceSummary`: 2-decimal rounding, dropped `na` tokens), `services/scalpContext.js` (`buildTimeframeWindow` drops `from`), `openapi/scalp-context.yaml`, no schema bump, 729 bytes recovered on the default 3-symbol payload (target ≥ 600), `npm run test:geometry` / `npm run test:scalp` |

Execution order (updated 2026-09-22): 0–11, 8b and 9b done. 8c (journal) and 3b (positions) are deferred as later enhancements by the user's decision; no phase is active. Next step is deploying Phase 11.

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

Existing-position risk (from playbook Miss 002). Same module, pure functions, no provider dependency:
- `positionRisk(position, stopPrice, { feeBps, slippageBps })` where `position = { side, entry, notional, collateral, leverage, liquidationPrice }` → `{ stopDistancePct, lossAtStopUsd, lossAtStopPctOfCollateral, distanceToLiquidationPct, stopBeforeLiquidation: bool, executable: "intrabar" | "gap_risk" }`. `executable` is `"intrabar"` when the stop sits before liquidation with room beyond the fee/slippage buffer, `"gap_risk"` otherwise (implementation detail beyond this plan's original single-value example, kept because it makes the fee/slippage config actually load-bearing).
- `maxStopDistanceForBudget(position, lossBudgetUsd, { feeBps, slippageBps })` → price distance the budget allows.
- `stopHierarchy(position, structuralInvalidation, lossBudgetUsd, cfg)` → `{ protectiveStop, thesisInvalidation, compatible: bool, reason, recommendedLeverage, recommendedNotional }`. `protectiveStop` is always an executable price before liquidation with fee and slippage allowance. `thesisInvalidation` is the structural level. When structure needs more room than the budget permits, `compatible: false` and the recommendation reduces leverage or size; the thesis level is never tightened to fit.

Payload: when `account.positions[]` exists (Phase 3b), each position carries `risk: stopHierarchy(...)` using the nearest structural level from `structure` (Phase 7 upgrades this to per-timeframe zones). Until 3b lands, functions ship and are tested; nothing is attached.

Config additions: `feeBps`, `slippageBps`, `defaultLossBudgetPctOfCollateral`.

Tests: new `test-risk-engine.js`. Cases: 3% stop → max leverage well under 100x; 0.5% stop → higher cap; margin unavailable → nulls; requested leverage above cap → capped with reason; wallet-risk cap binds before leverage cap when appropriate.
MISS_002 fixture with the playbook's exact numbers: long entry 86,289.01, 99.77x, notional 931.73, collateral 9.34, liquidation 85,657.61, proposed stop 86,250 → stopDistancePct ≈ 0.045, lossAtStopUsd ≈ 0.42, ≈ 4.5% of collateral, `stopBeforeLiquidation: true`, and with any structural invalidation more than ~0.7% away, `compatible: false` with a recommended leverage. Short mirror of the same fixture.

Acceptance: at 100x request with a 3% stop, payload shows capped leverage and the reason. MISS_002 reproduces from the fixture. GPT no longer needs to compute any of this.

---

## Phase 3b — Read-only `account.positions[]`

> **Deferred 2026-09-22 (later enhancement).** User is not tracking wallet positions for now. Finding to carry forward: the tracked wallet trades Jupiter perps, which this section skips, so the Drift/Mango design below would return nothing useful. When revived, build Jupiter first: derive the Position PDAs (seeds `position`, owner, pool, custody, collateralCustody, side; long SOL/ETH/BTC with same-asset collateral, short with USDC and USDT) and fetch all nine in one `getMultipleAccountsInfo` call, decoding with `services/jup-perps-wrapper.cjs`. Copy the derivation; never import `services/jupiterPerps.js` (it imports `walletManager.js`).

Objective: the risk engine works on real positions, not user-typed numbers. Miss 002 came from the GPT reasoning about a position the API never saw.

Source: NOT the existing provider read path. Blocker found 2026-09-22: `perpsProvider.getPerpPositions` → Drift/Mango/Jupiter all call `walletManager.getWallet()` (Keypair from `SOLANA_PRIVATE_KEY`) and query the signer's own account; the `walletAddress` argument is dead. Jupiter's query is unimplemented (returns []). None is usable.

Revised source: a new read-only client per venue built with a THROWAWAY wallet (fresh random `Keypair.generate()`, never funded, never signs, not a secret), querying the tracked address directly:
- Drift: `DriftClient` with the throwaway wallet → `getUserAccountPublicKey(programId, trackedAuthority, subAccountId)` → `program.account.user.fetch(pda)` → decode `perpPositions` (market index → symbol, baseAssetAmount sign = side, quoteEntryAmount / baseAssetAmount = entry, leverage from margin, liquidation via `driftClient.getUser(...)` liquidation price helper if it accepts an arbitrary user account, else null).
- Mango: `MangoClient.connect` with a throwaway-wallet provider → `getMangoAccountsForOwner(group, trackedOwner)` → `perpActive()` → entry, notional, liquidation via the account's health helpers.
- Jupiter: skipped (upstream stub). `status: disabled, reason: "provider unsupported"` when `PERPS_PROVIDER=jupiter`.
Only `TRACKED_WALLET_ADDRESS` and `SOLANA_RPC_URL` are read. Any import of `walletManager.js`, `tradeExecution.js`, `positionManager.js`, or any read of `SOLANA_PRIVATE_KEY` is a phase failure. Estimate raised to 4–6 h.

Isolation rules, identical to `walletTracker.js`:
- New `services/positionTracker.js`. Imports the provider's read functions only. Never imports `walletManager.js`, `tradeExecution.js`, `positionManager.js`, or any keypair-capable module. Lazy import inside the function so a failed read cannot load more than needed.
- Reads by public `TRACKED_WALLET_ADDRESS`. No signing secret read.
- Timeout and fail-closed like the wallet: `positions.status: available | partial | unavailable | disabled`. Unavailable is never an empty list presented as "no positions". Never affects `dataStatus`.

Payload: `account.positions: { status, fetchedAt, items: [{ market, side, entry, notional, collateral, leverage, liquidationPrice, unrealizedPnlUsd, openedAt }] }`. Schema minor bump.

Tests: new `test-position-tracker.js` (mocked provider): shape, status semantics, timeout → unavailable, no-secrets grep. `test:mcp` must still prove no execution or signing import is reachable from the MCP path. `test:wallet` unchanged.

Acceptance: with one open position on the tracked wallet, payload shows it with `risk` attached (Phase 3). With none, `items: []` and `status: available`. With RPC down, `status: unavailable`, items null.

---

## Phase 4 — `candidateSetups[]` and 1m/5m flag detector

Objective: a price-action flag is visible even when the strategy engine says NO_TRADE. Regression 001.

New module `lib/patternDetector.js`:
- Input: closed candles, ema21, stochRsi for one timeframe.
- Detects: impulse (N candles, range > k×ATR) → contraction (range shrinking, closes holding ≥ ema21 with wick tolerance) → local flag high.
- Output: `{ type: "flag", direction, state: forming|triggering|confirmed|failed, impulseStrength, compressionScore, flagHigh, flagLow, breakoutLevel, invalidation, ema21Hold: "hold"|"wick"|"acceptance_below", confidence }`.
- Deterministic per request. No cross-request state (stateless serverless). "State" is derived from the last candles each call.
- Direction-symmetric by construction: one code path parameterised by `direction`, never a long path with a short afterthought. Bear flag = impulse down → contraction holding ≤ ema21 → local flag-low break. `ema21Hold` for shorts reads `hold_below | wick_above | acceptance_above`.

Files:
- `lib/patternDetector.js` new.
- `services/scalpContext.js`: run on 1m, 3m, 5m per symbol. Attach `candidateSetups: [{ timeframe, ...detector output }]` per symbol. Keep separate from `strategies`. Add to `decisionTrace.candidateSetups`.
- Config: `flag.minImpulseAtr`, `flag.maxContractionRatio`, `flag.wickTolerancePct`, `flag.minCandles`.
- Schema → 1.3.0. OpenAPI updated. (As built: 1.4.0 → 1.5.0, since phases 2 and 3 each bumped first. `decisionTrace.candidateSetups` carries compact `"timeframe:direction:state"` string references so the ~2KB per-symbol trace budget from phase 2 holds; full candidates live on `symbols.<SYM>.candidateSetups`.)

Do NOT: change `strategies.*`, `bestSignal`, or any guard.

Tests: new `test-pattern-detector.js` with fixtures:
- REGRESSION_001_BTC_1M_FLAG: impulse → EMA21 hold → compression → break. Expect `confirmed`, and `strategies.SCALP_1H.valid === false` still.
- Wick below EMA21 then reclaim → `ema21Hold: "wick"`, candidate survives.
- Close and hold below EMA21 → `acceptance_below`, state `failed`.
- Extended breakout (price > k×ATR above flag high) → `chaseRisk: true`.
- No impulse → empty array.
- Every fixture above has a short mirror (price series negated around a pivot, same assertions with direction flipped). A test that exists only for longs is incomplete.

Acceptance: BTC 1m fixture yields a candidate while engine remains NO_TRADE. Short mirrors pass with identical structure. Fixtures live in `test/fixtures/` and are the seed of the miss log (phase 10).

---

## Phase 6 — Assert compute depth

Objective: prove the geometry phases already have the history they need, and put a guard on it. Phase 0 measured the fetch path: `FETCH_LIMIT = 500` (`services/scalpContext.js:48`) yields 499 closed candles per timeframe, and indicators plus the strategy engine already run on that full array — only the published slice is trimmed. 3m is the exception at 239 (derived from 1m under Kraken's 720-row cap).

Change: no fetch change. Add a test asserting the compute window is ≥ 200 closed candles per timeframe (≥ 200 for 3m too, which 239 satisfies), and log build duration and payload bytes once per build.

3m is the shallowest window at 239 candles (derived from 1m, capped by Kraken's 720-row limit on the base fetch — `services/marketData.js` `getCandlesWithProvenance`: `baseLimit = min(720, (limit + 2) * 3)`). This is acceptable for EMA200: 239 still clears the 200-candle floor a 200-period EMA needs to be fully warmed up, with 39 candles of margin. It is the tightest margin of any timeframe and is documented here so a future change to the 720-row cap or to `FETCH_LIMIT` is evaluated against it explicitly, not discovered later as a silently-degraded EMA200.

Files: `services/scalpContext.js` (one duration/bytes log line), `test-scalp-context.js` (compute-window assertion).

Tests: `test:scalp` — published candle counts unchanged (30/30/30/24/24/20/10); compute window ≥ 200 per timeframe; 3m documented as the shallowest at 239.

Acceptance: duration and bytes logged; payload byte-identical; the assertion fails loudly if anyone lowers `FETCH_LIMIT`.

Added 2026-09-22 after GPT testing (Phase 6 item F; if Phase 6 has already started, this moves to Phase 7):
- F. Risk block on candidates. Each `candidateSetups[]` entry with `state` in {triggering, confirmed} and `chaseRisk: false` gets `risk` computed exactly as `attachRisk` does for strategies, with entry = `breakoutLevel` and stop = `invalidation` (direction-aware). Same shape: `{ maxLeverage, suggestedLeverage, lossAtStopUsd, lossAtStopPct, lossAtStopPctOfWallet, collateralUsd, reason }`; null-shaped with a reason when margin is unavailable. `forming` and `failed` entries get no `risk` key. Tests: long and short candidate through the real build path; forming has no key; margin unavailable → nulls. OpenAPI CandidateSetup gains `risk` (ref Risk). Schema bump 1.6.0 → 1.7.0. Reason: the GPT reports "risk not supplied for candidate setup" on every confirmed flag.

Done 2026-09-22. The compute-window test injects a production-sized fixture (candle count derived from the `limit` argument `buildScalpContext` actually passes, not a hardcoded number) through the real `buildScalpContext` path, reading depth from `decisionTrace.window[tf].closedCandles`, so it fails if `FETCH_LIMIT` is ever lowered below the 200-candle floor. `configVersion` bumped 2026.09.22-3 → 2026.09.22-4 in the same phase — Phase 5 added `flag.includeFailed` to `config/engine.json` without a version bump; corrected here per governing rule 1 (config is versioned data, and `flag.includeFailed` changed the configured surface even though the schema didn't move).

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

Merged into Phase 5 (payload hygiene items from the Phase 1–3 reviews and GPT tests, 2026-09-22):

- G. Top-level `config` snapshot next to `configVersion`: `{ scalp: { maxStopDistancePct }, riskReward: { bySetupType, byStrategy }, risk: { maxLeverage, maxWalletRiskPct, defaultMarginUsd, liquidationBufferPct, maintenanceMarginPct, feeBps, slippageBps }, flag: { includeFailed } }`. Values from `ENGINE_CONFIG` only, ≤ 600 bytes, included by default, droppable via `include`. Reason: the GPT could cite `configVersion` but not the stop cap or risk caps.
- H. `risk.lossAtStopPctOfWallet` beside `risk.lossAtStopPct` in `attachRisk`, measured against `account.margin.usd`; null when margin unavailable. OpenAPI Risk schema updated. Reason: `lossAtStopPct` is percent of collateral and reads as wallet risk.
- I. Classifier: the engine's final fallback text beginning "No clean SWING / 4H Trend" classifies as `no-setup`, ordered before the generic catch; test through the real `evaluateAllStrategies` path.
- J. Config `flag.includeFailed` (default false): when false, `candidateSetups[]` omits `state: failed`; `decisionTrace.candidateSetups` strings keep them. Test both settings.
- Schema bump stays one step, 1.5.0 → 1.6.0.

---

## Phase 7 — Geometry A: pivots, zones, ATR, room

ATR decision (taken in phase 0): import `calculateATR` from `lib/advancedIndicators.js:98` and use it. Do not write a second ATR. Phase 4 shipped a local `wilderAtr` in `lib/patternDetector.js` under the rule-7 reading; Phase 7 replaces it with the shared import and adds a test asserting both agree on the same candles, so exactly one ATR remains. Phase 7 also switches `flag.wickTolerancePct` (percent of price) to an ATR multiple now that ATR per timeframe exists. `lib/advancedIndicators.js` is the one otherwise-dormant module a phase may import (governing rule 7); importing one named function does not pull the rest of that file onto the scalp path.

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

Done 2026-09-22. As built:
- One ATR: `lib/geometry.js atr` and the flag detector both call `calculateATR`; `wilderAtr` is deleted. Before deletion the two agreed at every index of every phase 4 fixture (842 points) within 0.005 - `calculateATR` rounds to 2 decimals, so that half-step is the only difference. The old Wilder code survives only as a test oracle in `test-geometry.js`.
- `flag.wickToleranceAtr` = 0.2 ATR of the prior candle. A percent-of-price band and an ATR band coincide at only one volatility: the phase 4 flag fixtures read identically for 0.1-0.6, the `test:scalp` synthetic symbols (price 100, ATR ~0.5% of price) for 0.1-0.25; 0.2 sits in both. One numeric drift: `acceptanceBelow` impulseStrength 10.16 → 10.15 (ATR rounding), state and labels unchanged.
- Payload: `symbols.<SYM>.geometryContext[tf]` (behind `include: geometry`), `decisionTrace.geometry` = one `"tf:structure:roomUp:roomDown:extension"` string per timeframe (≤ ~110 bytes per symbol measured). `side` on a zone is which pivots formed it (support/resistance/both); its position relative to price is the list it is in.
- Budget (G): all seven timeframes measured 84,975 bytes full against the 80 KB guard, so `geometry.timeframes` defaults to 5m/15m/1h/4h - 76,203 bytes full, 30,004 compact, build 458 ms locally (live data, 2026-09-22). 1m/3m are covered by the flag detector, 1d by `structure`.
- Phase 6 item F landed here: `attachCandidateRisk` shares `riskBlock` with `attachRisk`, so a triggering/confirmed non-chase candidate carries the strategy Risk shape (entry = breakoutLevel, stop = invalidation).

---

## Phase 8 — Geometry B: diagonals and confluence

Extend `lib/geometry.js`:
- `fitDiagonal(pivots, side)`: candidate lines through pivot pairs; score by touches within ATR tolerance and fit residual; require `minTouches` (config, default 3). Return `{ detected, slope, touches, currentLevel, currentDistancePct, lastTouchAt, fitError, confidence }` or `detected: false`. Never expose a line with fewer than `minTouches`.
- `confluenceZones`: overlap of diagonal level, horizontal zone, EMA21/200, session/prev-day levels → `{ low, high, components[], score }`.

- `channel`: when both a diagonal support and a diagonal resistance are detected with compatible slopes → `{ detected, upper, lower, widthPct, positionPct (0 = at lower, 100 = at upper), slope: rising|falling|flat }`. This is the object that answers "are we at the bottom or top of the channel on this timeframe".

Payload: add `diagonalSupport`, `diagonalResistance`, `channel`, `confluenceZones[]` to `geometryContext`.

Tests: synthetic rising channel → diagonal support with 3+ touches; noisy data → `detected: false`. REGRESSION_002 full: 4h fixture exposes rising support + horizontal demand as one confluence zone with current distance.

Acceptance: fixture passes. Precision over recall: false lines are worse than missed lines.

Done 2026-09-22. As built:
- Include option: **B default-included** (no `geometryB` token). Budget steps, live BTC/SOL/ETH, bytes: baseline 77,448 full → drop 5m geometry 74,022 → add B on 15m/1h/4h 76,781 (re-measured at close: 74,553 → 77,312; compact 31,143). Under the 78 KB switch line, so `decisionTrace.geometry` strings are unchanged. Measured B cost 2,759 bytes for 9 timeframe blocks. Theoretical worst case (every block with both lines, a channel, two five-component zones) is ~827 bytes a block, ~82.0 KB full - over 80 KB. Very unlikely under the precision gates (2 of 18 live lines survive), but if the 80 KB guard ever warns, the fallback is the `geometryB` include token.
- `diagonalMinTouches` (3) is its own key: `minTouches` (2) drives phase 7 zones, and changing it would have changed zone output.
- Precision gates beyond the spec's touch count: span ≥ `diagonalMinSpanCandles` (20), bounce ≥ `diagonalMinBounceAtr` (3 ATR) between touches, no close or pivot beyond the line since the first touch. Without the bounce rule, iid noise produced lines on 60 of 60 fixture sides and live data on 18 of 18. With it: 0 of 60 and 2 of 18.
- `confluenceZones` entries carry `distancePct` beside `{ low, high, components[], score }`: the REGRESSION_002 acceptance needs current distance. `score` = number of distinct components.
- Phase 7 outputs byte-identical: `buildGeometryContext` is unchanged and B is merged on after it. A snapshot produced by commit 19cce68 on 10 fixtures (long + mirror) is asserted in `test-geometry.js`.
- Build 1.09-1.52 s locally (live), per-symbol compute 9-35 ms.

---

## Phase 8c — Trade journal (minimal, four items)

> **Deferred 2026-09-22 (later enhancement).** Parked because it adds the first write path, a Blob store and an Action schema re-paste to a working GPT. If revived: keep the default payload to open trades + performance (closed list only under include "journal"; ~1.2 KB headroom fits about 4–5 closed records), and settle how the GPT sends a separate journal key (one API key per Action).

Objective: the user takes a position, it is written to a ledger, the GPT reads it back. Nothing confirms it, nothing reasons about it.

Facts that shape this: the repo has no database. `services/positionManager.js` is an in-memory Map with browser `localStorage` calls that do nothing on Vercel. The dashboard's `pendingTradeToTrack` is browser-only. A serverless function has no durable state, so one store is unavoidable.

Decision recorded 2026-09-22: this is the one write path allowed. User-asserted records only. MCP stays read-only; only the Custom GPT Action gets the write op. `JOURNAL_API_KEY` is separate from the read key and any trading key.

1. Store: Vercel Blob, one JSON file `journal.json` (array of records). `lib/journalStore.js`: `readJournal()`, `writeJournal(records)`, 5 s timeout, on error → `{ status: "unavailable", records: null }`. Only new dependency: `@vercel/blob`.
2. Write op: `POST /api/trade-log` via `vercel.json` → `api/scalp-context.js?__journal=1` (same dispatch pattern as `__mcp`). Bearer `JOURNAL_API_KEY`, timing-safe, 401 otherwise. Body `{ action: "open", trade: { symbol, side, entry, sizeUsd, leverage, stop, tp1?, tp2?, note? } }` → appends `{ id, ...trade, openedAt, status: "open" }`; or `{ action: "close", id, exit }` → sets `exit, closedAt, status: "closed", pnlUsd = (exit − entry) / entry × sizeUsd × (long ? 1 : −1)`. Minimal validation: symbol in tracked set, side long|short, numbers finite and > 0. Cap 200 records, oldest closed dropped. Returns the record.
3. Read: `account.journal = { status, open: [...], recentClosed: [last 20], performance: { trades, wins, losses, winRate, realizedPnlUsd } }` in `buildScalpContext` (closed trades only; never affects `dataStatus`; droppable via include "account"). OpenAPI: `logTrade` op with `journalAuth` scheme, Journal + TradeRecord schemas, ChatGPT-safe constructs. Schema minor bump, configVersion bump.
4. Tests: `test-journal.js` (`test:journal`), mocked Blob: open/close round trip, PnL long and short, cap, stats, store error → unavailable. Auth: read key rejected on the write op and journal key rejected on the read op. `test:mcp`: tool list unchanged, nothing writable via MCP.

Not in scope: confirmation of any kind, risk hooks, R-multiples, streaks, positions (3b).

Acceptance: log a trade, close it, `balance` shows the stats, `signals` sees the open one.

## Phase 8b — Confirmation chart (on demand, never bulk)

Objective: when the data says a flag may be forming, the GPT or the scheduled run can pull ONE image of THAT symbol and timeframe to confirm. The image is a confirmation layer, not a data source. Detection stays in Phase 4/9 from candles.

Rules:
- Never included in the default payload. Never all symbols. Never all timeframes.
- Triggered only by an explicit request: MCP tool arg `chart: "BTC:1m"` or REST `?chart=BTC:1m`. The GPT requests it when `needsVisualConfirmation` (Phase 9) names that symbol/timeframe, or when the user asks.
- One chart per request. A request for more than one is rejected with a clear error.
- Rendered server-side inside the existing function (no new `api/` file), pure-JS canvas, no native binaries. Draw: closed candles for the timeframe's publish window, EMA21/EMA200, detected zones, diagonals, channel, and the candidate flag's high/low/breakout/invalidation from Phases 4/7/8. Label the timeframe and `closedThrough`.
- Size budget: ≤ 150 KB PNG. Duration budget: ≤ 1.5 s added.
- Delivery: MCP returns an `image` content block beside the summary text and `structuredContent`. REST returns `image/png` when `chart` is set, JSON otherwise. Auth on REST unchanged.

Files: new `lib/chartRender.js`; `services/editTradesMcp.js` (arg + image block); `api/scalp-context.js` (query parse, content type; auth untouched); `services/scalpContext.js` (pass geometry to renderer).

Renderer decision (2026-09-22): pure-JS only, no native binaries (Vercel Hobby, no build step for node-gyp). Use `pureimage` (pure-JS canvas + PNG encoder) with one bundled TTF under `assets/fonts/` for labels, or an equivalent pure-JS PNG encoder. `canvas` / `@napi-rs/canvas` / `sharp` are not allowed. Chart size 900×500, dark background, candles for the timeframe's published window (30 for 1m/3m/5m, 24 for 15m/1h, 20 for 4h), EMA21/EMA200 lines, horizontal zones as bands, diagonals as lines, channel as two lines, candidate flag high/low/breakout/invalidation as dashed lines with labels, title = symbol · timeframe · closedThrough. 1m/3m/5m draw candles + EMAs + candidate only (no geometry exists for them). Timeframe must be one the payload carries.

Tests: `test-chart-render.js` — renders a fixture without throwing, PNG magic bytes, size under budget, overlays present at expected pixel rows for a synthetic series. `test:mcp` — tool still single and read-only; `chart` absent → no image block; two charts requested → error; image block only for the named symbol/timeframe.

Acceptance: hourly MCP run with no `chart` arg is byte-identical to before. With `chart: "BTC:1m"` the response carries exactly one image that shows the lines the payload describes.

`chart` — done 2026-09-22. Measured on a live build: BTC:1m 25.9 KB, render 45 ms cold / 24 ms warm; BTC:4h 25.4 KB, 36 ms cold / 27 ms warm (budgets 150 KB, 1.5 s). `vercel build` confirms the font and `pureimage/dist/index.cjs` (self-contained, Node builtins only) ship in the `scalp-context` function bundle, and a render from inside the bundle succeeds. Zones are coloured by role relative to price (the payload list they sit in). Sample: `test/fixtures/chart-sample-btc-4h.png`. Rejections (two charts, unknown symbol/timeframe, malformed) happen before the build: MCP `isError`, REST 400; no candles for the timeframe: MCP `isError`, REST 503.

---

## Phase 9 — Pattern lifecycle and visual gate

Objective: unify phase 4 flags with phase 7–8 geometry into one pattern object with lifecycle, and tell the GPT when it should ask for a screenshot.

- Extend `lib/patternDetector.js` to use zones/diagonals for `breakoutLevel` and `invalidation`.
- Lifecycle `none → forming → triggering → confirmed → failed`, derived per request from the candle window (no store).
- `needsVisualConfirmation: boolean`, `visualTarget: { symbol, timeframe }`, `unresolvedGeometry: []` set when: candidate present but `geometryContext.confidence` below config threshold, or diagonal candidates exist with touches = minTouches − 1.

Tests: state transitions on a scripted candle sequence; visual flag set exactly under the documented conditions.

Acceptance: the GPT rule is "if needsVisualConfirmation, request chart visualTarget via MCP or ask the user for that screenshot".

Done 2026-09-22. As built:
- Levels: `snapCandidateLevels` moves `invalidation` and `breakoutLevel` only outward (never into the flag), to the nearest zone edge, detected diagonal, or confluence edge within `lifecycle.snapTolAtr` ATRs of the candidate timeframe. 1m/3m/5m read 15m geometry. `levelSource` records `flag|zone|diagonal|confluence` per level. State stays the flag's own read, so a triggering candidate can carry a snapped breakout above the last close.
- Coil: overlapping (≥ `coilOverlapPct` of the narrower range) bull + bear flags, both forming → one `{ type: "coil", direction: "neutral", state: "forming" }` with `breakoutLevelUp/Down`; forming + triggering → the triggering flag only. Trace ref reads `"1m:neutral:forming"`.
- Lifecycle: `durationCandles` (since the first flag candle), `ageCandles` (triggering/confirmed, since the break candle), `failReason` (`acceptance_below|acceptance_above|invalidation_close|stale`). `stale` is new: a break unconfirmed after `flag.maxBreakoutAge` candles reads failed instead of triggering. `detectFlag` output is unchanged; the lifecycle read is `detectFlagLifecycle`.
- Gate: `decisionTrace.needsVisualConfirmation / visualTarget / unresolvedGeometry`, codes `<tf>:low_confidence`, `<gtf>:near_miss_support|resistance`, `<tf>:coil_near_break`, `<gtf>:low_geometry`. Failed candidates never raise it. `nearMissDiagonals` is a geometry export only; `geometryContext` is unchanged (phase 7/8 snapshot tests pass).
- Budget, live 2026-09-22: 76,687 → 77,123 bytes full, 30,564 → 30,992 compact. +~100 bytes per flag candidate, +76 bytes per symbol trace with the gate off, ~+175 on.
- Live observation: two-touch near-miss diagonals exist on 7 of 9 BTC/SOL/ETH geometry timeframes, so `near_miss_*` is the gate's most common reason. The chart renderer (8b) draws flag levels only; a coil target renders candles + EMAs without its breakout lines.

---

## Phase 9b — Direction and multi-timeframe bias matrix

Objective: shorts get the same machinery as longs, and the system can say "short the top of the 1m channel while the 4h support thesis stays long" as one structured statement instead of two contradictory signals.

Engine audit first: `services/strategy.js` already has short paths in every strategy (mirrored `isLong ?` branches throughout, SHORT micro-scalp block). Phase 9b does not change them. It adds a layer above.

New module `lib/biasMatrix.js`:
- Per timeframe, from existing fields: `bias: long | short | neutral`, `strength 0–100`, `basis[]` (trend, EMA21/200 relationship and slope, higher-lows/lower-highs, channel position, stoch state). Pure function of `timeframes[tf]` + `geometryContext[tf]`.
- `biasMatrix: { "1m": {...}, "3m": {...}, ..., "1d": {...} }`.
- `alignment`: for each candidate setup (Phase 4/9) and each valid strategy signal: `{ direction, executionTf, contextTfs, withTrend: bool, counterTrend: bool, htfBias, htfSupportDistancePct | htfResistanceDistancePct, room }`.
- Counter-trend classification: a short candidate on 1m/3m/5m while 1h/4h bias is long is tagged `counterTrend: true` with the distance to the nearest higher-timeframe support zone. A counter-trend scalp with the HTF zone inside `minRoomAtr` is flagged `roomTooSmall: true`. Symmetric for longs against a bearish HTF.
- `decisionInputs` per symbol: `{ directionalBias: { long: pct, short: pct, neutral: pct }, byHorizon: { scalp: {...}, swing: {...} } }`. These are named API components the GPT turns into its GO_IN / HOLD_WAIT / DONT_DO_IT allocation. The API does not emit the allocation itself; that stays GPT-owned (Phase 11 confirms it is derived from these fields).

Config: timeframe weights per horizon, `minRoomAtr`, counter-trend strength penalty.

Also in 9b (from the Phase 10 replay baseline, 2026-09-22, 1,434 closes): the visual gate fired on 54 % of closes, and `15m:near_miss_*` codes made up ~65 % of that. Tune in 9b: `lifecycle.nearMissGate` config (default false) so near-miss diagonals no longer raise `needsVisualConfirmation` on their own; they still appear in `unresolvedGeometry` only when another code raised the gate. Also `visualTarget` must prefer a triggering/confirmed candidate over a forming one when both raised the gate. Re-run `npm run replay` + `replay:metrics` on `test/fixtures/history/2026-09-22` and report the new gate rate; target under 15 %.

Also in 9b (found in GPT testing 2026-09-22): `decisionTrace.candidateSetups` strings for failed candidates carry the reason as a fourth token, e.g. `5m:short:failed:stale`, so "why did it fail" is answerable while `flag.includeFailed` stays false. Test: a failed candidate's trace string ends with its `failReason`.

Payload: `biasMatrix`, `alignment[]`, `decisionInputs` per symbol, behind `include: bias`.

Tests: `test-bias-matrix.js`:
- 4h uptrend + 1m at channel top with lower-high forming → short candidate `counterTrend: true`, `htfSupportDistancePct` populated, long bias on swing horizon unchanged.
- 4h uptrend + 1m at channel bottom on HTF support → long candidate `withTrend: true`, `room` large.
- Full mirror: 4h downtrend cases.
- HTF zone within `minRoomAtr` of a counter-trend entry → `roomTooSmall: true`.
- `directionalBias` percentages sum to 100 per horizon.

Acceptance: the two-sided scenario the user described is representable in one payload and both tests pass in both directions.

Done 2026-09-22. As built:
- Shape follows the 9b implementer prompt where it differs from the text above: `decisionInputs = { directionalBias: { scalp, swing } }` (no top-level triple), and alignment carries one `nearestHtfZoneDistancePct` (the zone ahead of the trade: resistance for a long, support for a short) plus `room` in that zone's timeframe ATR, instead of `htfSupportDistancePct | htfResistanceDistancePct`. `roomTooSmall` applies to any alignment entry, not only counter-trend ones.
- Bias per timeframe: weighted sign vote of trend, EMA21/200 stack, price vs EMA21, EMA slopes (agreeing), higher lows / lower highs, channel edge, Stoch state; under `bias.neutralBelow` reads neutral. 1m/3m/5m/1d have no published geometry, so the bias layer runs the same geometry functions on them internally; `geometryContext` is unchanged. Mirrored markets give mirrored numbers (500 seeded random markets in `test:bias`); rounding ties between long and short go to neutral.
- Opt-in: `include: bias` makes REST/MCP build with `includeBias: true`; without it `build()` is called exactly as before and the only bias field is `decisionTrace.bias`. `filterPayload(payload, {})` stays the identity.
- Bytes (replay capture 2026-09-22 22:18, identical data for HEAD and 9b): default 76,528 → 76,792 (+264); compact 30,399 → 30,663; default + bias 79,563; compact + bias 33,434; `include=bias` alone 5,388. Live full + bias 81,897 bytes, at the 80 KB soft guard: use `compact` with `bias`.
- Gate: `lifecycle.nearMissGate: false`. Replay on `test/fixtures/history/2026-09-22` (1,434 closes): gate rate 0.5377 → 0.0509 (BTC 0.046, SOL 0.027, ETH 0.080). Candidate counts identical. Near-miss codes now appear on 65 closes (0.045), always beside another code.
- Changed expectations in existing suites: schemaVersion 1.9.0 → 1.10.0 in `test-scalp-context.js`, `test-engine-config.js`, `test-geometry.js`, `test-pattern-detector.js`; `test-scalp-context.js` "condition 2" now asserts a near miss alone does not gate by default and keeps the phase 9 expectation under `nearMissGate: true`.
- Live sample 2026-09-22: BTC 1m short triggering, `counterTrend: true` against a 72-strength long HTF bias, price inside an HTF support zone (`room: 0`, `roomTooSmall: true`), swing horizon L74/S0/N26.

---

## Phase 10 — Replay harness and miss log

- `scripts/replay.js`: run the full feature pipeline over stored historical candles, one close at a time, no lookahead. Emit per-close `decisionTrace`, candidates, geometry.
- `test/fixtures/misses/`: one JSON per logged miss: pre-image read, missing feature, post-image read, miss class, proposed feature, status. Each miss becomes a regression test when implemented.
- Metrics: candidate precision/recall against hand-labelled fixtures; rate of `needsVisualConfirmation`. Track over time; it should fall.

Acceptance: REGRESSION_001 and 002 reproduce from replay, not only from unit fixtures.

Done 2026-09-22. As built:
- Harness: `scripts/replay.js` imports `buildScalpContext` and `getCandlesWithProvenance` and re-implements nothing. At each close it builds with `now = cut` and an injected Kraken reader that holds only candles with `closeTime <= cut`, returning `limit - 1` closed rows (Kraken's `limit` rows minus the forming one). The pipeline sees production's windows: 499 closed per timeframe, 3m derived from 719 closed 1m (239). Wallet is stubbed unavailable; `includeFailed: true` so failed candidates carry `failReason`. It starts at the first close where every timeframe has `replay.minComputeCandles` (200) closed candles.
- Proofs: scrambling every candle after the cut leaves payload and line byte-identical; scrambling the cut candle changes them (control). The same Kraken pull fed through production and through the replay gives an identical symbol payload, checked live on BTC and in `test:replay` on fixtures.
- Line: `{ closedThrough, symbol, dataStatus, strategies{name:{valid,rejectedAt}}, candidates["tf:dir:state:conf"], candidateLifecycle[{ref,startedAt,state,failReason}], geometry, confluence["tf:components:distancePct"], gate{needsVisualConfirmation,codes} }`. `dataStatus`, `candidateLifecycle` and `confluence` are additions: the metrics need candidate identity and failReason, and the REGRESSION_002 proof needs confluence components.
- Capture: `--capture BTC,SOL,ETH --out <dir>` saves the production fetch (Kraken, strict, closed only). Kraken OHLC serves only the newest 720 rows, so 3m ≥ 200 leaves ~120 replayable 1m closes. `--backfill-1m <minutes>` buckets Kraken public trades into older 1m candles; on the 2026-09-22 capture (360 min) the 60-minute overlap matched OHLC on 60/60 candles for all three symbols.
- Regressions via the harness (synthetic, `test/fixtures/replayHistories.js`; real history for those dates is not retrievable): REGRESSION_001 steps forming → triggering → confirmed on the 1m clock with SCALP_1H NO_TRADE on every close. REGRESSION_002's 4h diagonal + horizontal confluence appears on the exact close the third touch pivots, not the close before. Both directions pass.
- Timing: 300 closes of one symbol in 1.2 s on fixtures, 478 live BTC closes in 2.2 s (4.5 ms/close; M-series laptop).
- First live measurement (capture 2026-09-22, 14:21–22:18 UTC, 478 closes per symbol, 1m clock): gate rate 0.54 overall (BTC 0.64, SOL 0.29, ETH 0.68). `15m:near_miss_resistance` 0.38, `15m:near_miss_support` 0.27, each `*:low_confidence` ≤ 0.02, `1m:coil_near_break` 0.01. The near-miss diagonal is the gate's dominant reason, as the phase 9 live observation predicted. Candidate appearances: forming 1,029, triggering 162, confirmed 265, failed 284; 240 distinct candidates, average lifetime 4.1 candles; 4 of 53 confirmed candidates later failed. No labels yet.

---

## Phase 11 — GPT instruction trim + payload headroom

Source text: `docs/GPT_INSTRUCTIONS.md` (baseline saved 2026-09-22, 7,990 UTF-16 units; ChatGPT caps at 8,000).

Deliverables (2026-09-22 spec; supersedes the older paragraph below):
- A. `docs/GPT_INSTRUCTIONS.md` stays the source of truth: full text in one fenced block, a "payload field → instruction rule" table, and a change log. Add `scripts/check-gpt-instructions.js` printing the fenced block's UTF-16 length and failing above 7,900; npm script `check:gpt`.
- B. Trim: remove every rule the payload now carries as a number or code (stop-distance math, leverage math, flag-detection heuristics, visual-gate heuristics, coil logic, bias weighing) and replace each with a one-line "read field X" rule. Keep: evidence weighing, uncertainty language, the user's line-by-line output format, TRACK format, NO TRADE line, COMMANDS, "engine output is input", direction symmetry, existing-position hierarchy (until 3b), never-invent rules.
- C. Teach the new fields: `decisionTrace.bias` string grammar (`scalp:L14,S4,N82|swing:L74,S0,N26|tf:1m=S,…|ct:1`); `failReason` fourth token in failed trace strings; `alignment` / `decisionInputs` / `biasMatrix` exist only with include "bias" (MCP-only), so the Action must not claim them; `needsVisualConfirmation` / `visualTarget`; `type: coil`.
- D. A "GPT test sheet" section: 10 prompts with the exact expected response shape (data check, signals, flags, forming, track, balance, bias question, why-rejected, coil question, position).
- E. Payload headroom (small code change, string formats only): shorten `decisionTrace` strings without losing information — geometry strings drop "na" tokens and round to 2 decimals; candidate strings stay `tf:dir:state[:failReason]`; window entries keep `to` and `closedCandles` and may drop `from`. Target ≥ 600 bytes recovered on the live default payload (currently ~79.5 KB of 80). No schema bump for string-format changes; bump `configVersion` only if a config key changes. Update tests that assert string formats.
- F. Mark this row done with the date, the final instruction length, and bytes recovered.

Do NOT touch engine behavior, MCP tool, REST auth, chart, replay, or geometry/pattern/lifecycle/bias logic.

Original paragraph:

Only after 1–10. Remove from GPT instructions anything the payload now carries: stop-distance math, leverage math, flag detection rules, visual-gate heuristics. Keep: evidence weighing, uncertainty language, output format, no-trade watch format, "engine output is input".

Acceptance: instruction length drops; behavior on the two BTC fixtures unchanged or better.

---

## Out of scope, needs separate decision

- Realized PnL, trade history, win rate. Requires a trade log that does not exist. Own workstream. (Open positions and liquidation moved into scope as Phase 3b.)
- Any write path from MCP. The single GPT-facing write op is the trade journal (Phase 8c) with its own key; the miss log stays repo fixtures.
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
- Direction symmetry is a requirement, not a nice-to-have: every detector, geometry feature, risk function, and fixture must handle short and long through one parameterised path, with mirrored tests. A long-only implementation fails the phase.
- Do not refactor adjacent code. Do not rename existing fields. Do not "clean up" strategy.js beyond the phase.

After the phase:
- Report: files changed, behavior added, what stayed untouched, test results by suite with counts, manual verification steps left, risks.
- Update the phase's row in this plan with status and date.
- Stop. Wait for review before the next phase.

If a phase's acceptance criteria cannot be met as written, stop and say exactly which criterion blocks and why. Do not narrow the criterion silently.

Deliverables per phase are in the plan. Phase 0 is complete; its output is docs/RULE_OWNER_MATRIX.md, which corrects several assumptions in the handoff doc and pins the measured baseline (61 KB payload, 499-candle compute window, sub-2 s builds).
```
