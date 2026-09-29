# T-24 — Prediction tracker: next-candle over/under on 5m/15m/1h/4h, BTC/ETH/SOL, scored and shown on the homepage

Owner confirmed 2026-09-28 (night). Ship start to finish with three parallel Sonnet agents in their own worktrees; the orchestrator merges. Info-only. No Telegram cards, no Open button, no change to any existing rule, threshold, stop, execution path, MCP tool, or payload field (schema stays 1.29.0, configVersion stays 2026.09.27-3). Read `docs/AGENT_SESSION_RULES.md` first. Commit by file name only. Never `git add -A`. Do not deploy. Do not push (the orchestrator pushes after merge).

Each agent: `git worktree add ../snapshot_tradingview-<slug> -b <slug>` from `origin/upgrade-signal-engine`, `ln -s <main checkout>/node_modules node_modules` in the worktree, and for fixtures `ln -s /Users/bballi/Documents/Repos/snapshot_tradingview/test/fixtures/history test/fixtures/history` (only if the path is missing). Work only in your worktree.

## Shared contract (all agents code against this; do not change it)

**Rule** (`lib/predictionRule.js`, pure, no I/O, agent A owns):
```
predictNextCandle({ symbol, timeframe, candles, higherCandles })
  -> { direction: 'over'|'under'|'no_call', confidence: 0..1, inputs: { ema21Side, ema200Side, higherEma21Side, stoch, lastSwing }, reason }
```
`candles` = closed candles of `timeframe` (oldest→newest, ≥ 210), `higherCandles` = the next timeframe up (5m→15m, 15m→1h, 1h→4h, 4h→1d), same shape `{t,o,h,l,c,v}` as `lib/geometry.js` consumers use. Deterministic. `PREDICTION_TIMEFRAMES = ['5m','15m','1h','4h']`, `PREDICTION_SYMBOLS = ['BTC','ETH','SOL']`, `HIGHER_TF = {5m:'15m',15m:'1h',1h:'4h',4h:'1d'}` exported from the rule file.

**Prediction row** (one JSONL object; appended by the engine to Blob `predictions/YYYY-MM-DD.jsonl` with manifest `predictions/manifest.json`, schema `predictions-manifest-1`, via `lib/blobJsonl.js` `appendJsonlDay`, same pattern as `lib/telegramLog.js`):
```
{ id: "<SYM>:<tf>:<closeIso>", kind: "PREDICTION", symbol, timeframe, closedAt: closeIso, refClose: number,
  direction, confidence, inputs, reason, configVersion, ruleVersion: "pred-1", writtenAt: iso }
```
**Result row** (appended at the next close of that timeframe, same file/day of the result):
```
{ id: "<same id>", kind: "PREDICTION_RESULT", symbol, timeframe, closedAt: nextCloseIso, refClose, nextClose: number,
  moveBps: (nextClose-refClose)/refClose*1e4 (1 decimal), hit: true|false|null (null when direction was no_call or nextClose===refClose),
  lastCandleDir: 'over'|'under'|'flat' (previous candle vs its own open, the "same as last" baseline), writtenAt }
```
Dedupe key = `id + kind`. Day file = UTC day of `closedAt`.

**Tracker aggregate** (`aggregates.json.predictions`, agent B owns):
```
{ since: iso|null, cells: { "<SYM>:<tf>": { n, hits, misses, noCalls, hitRate, coinFlip: 0.5, sameAsLastRate, meanMoveBpsHit, meanMoveBpsMiss } },
  byTimeframe: { "<tf>": {...same} }, bySymbol: { "<SYM>": {...} }, overall: {...}, duringGood: {...}, last: [ ≤50 latest result rows ] }
```

## Agent A — rule + replay (worktree `pred-rule`)
1. `lib/predictionRule.js` per the contract. v1 rule, simple and stated in the file header: score = +1 per bullish input (close > EMA21 on tf, EMA21 > EMA200 on tf, close > EMA21 on higher tf, stochRSI rising and < 80, last swing higher-high), −1 per bearish mirror; `over` if score ≥ +2, `under` if ≤ −2, else `no_call`; confidence = |score|/5. Reuse EMA/stoch/swing helpers already in `lib/` (`geometry.js`, `strategy.js` exports, `patternDetector.js`) — do not reimplement indicators.
2. `test-prediction-rule.js` (≥ 15 checks: determinism, both directions, no_call, short history, higher-tf tie-break) + `npm run test:predrule`.
3. Replay `scripts/swing/rules/pred-next-candle.js` re-exporting the rule (precedent `htf-entry-1m.js`), runner `scripts/predictions/replay.js` over `test/fixtures/history/deep2y-2026-09-26` for all 3 symbols × 4 tfs: hit rate, n, coin flip, same-as-last baseline, mean move bps on hits/misses, per cell and overall. Write `docs/PREDICTION_STUDY_2026-09-28.md` with the table and one honest paragraph. Minutes, not hours; if a run exceeds 15 min, cut symbols and say so.
4. Commit: `T-24a: prediction rule + 2y replay`. Report the overall hit rate and the worst/best cell.

## Agent D — live writer + cron wiring (worktree `pred-live`)
1. `lib/predictionLive.js`: `evaluatePredictions({ payload, candlesByTf, prevState, nowMs, store })` → `{ state, rows }`. Per symbol × tf: detect a newly closed candle (compare `closedThrough` for that tf vs `state.predictions.lastClose[sym][tf]`), first append the RESULT row for the previous prediction of that (sym,tf) if one is pending (read from state, not Blob), then call `predictNextCandle` and append the PREDICTION row; store `{ pending: {id, direction, refClose, prevCandleDir}, lastClose }` in `state.predictions`. Until agent A lands, code against the contract with a local stub import and a TODO the orchestrator resolves on merge (`import { predictNextCandle, PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF } from './predictionRule.js'`).
2. Candles: use what the cron already fetched for the payload build (`services/scalpContext.js` exposes per-tf closed candles to the build; find the existing accessor the HTF live wiring uses in `lib/htfEntryLive.js` — `latestClosedHtfCandle` and friends — and reuse; do not add a second exchange fetch per tick). 1d candles for the 4h higher-tf come the same way.
3. `api/telegram-cron.js`: call it inside the existing state transaction after the HTF evaluation, with the same env gate pattern (`PREDICTIONS_ENABLED !== 'false'`), failures logged `[Pred] skipped=<reason>` and swallowed; never changes any alert, never sends a message. `state.predictions` added to `lib/telegram.js` `emptyState`/`migrateRaw` (additive).
4. Tests `test-prediction-live.js` (≥ 15: first tick writes a prediction only, next close writes result + new prediction, no_call result has hit null, dedupe on repeated tick, Blob failure swallowed, state shape) + `npm run test:predlive`. The `test:telegram` guard tests must stay green (no forbidden imports; you import nothing from execution/wallet/jupiter).
5. Commit: `T-24d: prediction live writer + cron wiring`. Report the exact hook line in the cron and the state shape.

## Agent B — tracker + homepage + page (worktree `pred-site`)
1. `scripts/tracker/predictions.js`: pull `predictions/manifest.json` + day files from the Blob base exactly like the served-calls pull in `scripts/tracker/collect.js` (`blobBaseFromToken`, manifest → days), append to `data/predictions/<day>.jsonl` (dedupe id+kind), join PREDICTION↔RESULT, compute the aggregate per the contract (`duringGood` = result rows whose window overlaps a scored GOOD call for that symbol from `good-call-outcomes.jsonl`). Wire into the existing collect → aggregate chain and `aggregates.json.predictions`. Epoch `since` = first PREDICTION row.
2. Homepage block `id="zone-predictions"` directly under `home-hero-right-now` (T-23) and above the strategy scoreboard: title "Next-candle calls · every close, every coin", a 3×4 grid (`id="pred-grid"`, cells `id="pred-cell-<sym>-<tf>"`) showing hit rate and n, coloured only when n ≥ 30 and the rate beats both baselines; a line `Overall x% of n · coin flip 50% · same-as-last y% · since <date>`; empty state `[NO PREDICTIONS YET]` never hides the block. Phone: grid scrolls inside its tile.
3. `docs/predictions.html` via `scripts/tracker/predictions-page.js` (+ nav link `id="tracker-predictions-link"`): full table by cell, by tf, by coin, during-GOOD row, last 50 results with move bps, method paragraph, link to `docs/PREDICTION_STUDY_2026-09-28.md` on GitHub (agent A writes it; link may 404 until merge).
4. Tests in `test-tracker.js` (≥ 12: join, hitRate math, no_call excluded from n but counted, baselines, duringGood, empty state, ids present) — count must not drop from 173.
5. Commit: `T-24b: prediction tracker, homepage grid, predictions page`. Do NOT run `tracker:sync` or touch the tracker repo; the orchestrator publishes.

## Orchestrator (after all three report)
Merge `pred-rule` → `pred-live` → `pred-site` into the scratch `merge-wave` worktree from `origin/upgrade-signal-engine`; resolve the stub import in `predictionLive.js`; run every `npm run test:*` + `check:gpt` + `git diff --check`; update `docs/EDITTRADES_MCP_CONNECTOR.md` (module table + test counts), `docs/ELEVATIONS_2026-09-28.md` (E3 shipped), `CHANGELOG.md`, `docs/DOCUMENTATION_INDEX.md`; push; owner deploys with `!`; verify prod per the connector doc; publish the tracker; confirm the first PREDICTION rows in Blob within 5 minutes and the grid on the homepage within 20.
