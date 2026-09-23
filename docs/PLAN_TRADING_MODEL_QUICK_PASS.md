# Trading Model — Quick Pass (single implementer pass)

Last updated: 2026-09-23
Status: plan only. Not started.
Branch: `upgrade-signal-engine`
Parent plan: `docs/MASTER_PLAN_TRADING_MODEL.md` (the owner's model M-1…M-9 and the full phased plan). This file pulls out the pieces that are straightforward, low risk, and reuse data the engine already computes, so one agent (Sonnet) can deliver them start to finish in one thread.

Baseline: production schema 1.10.0, configVersion 2026.09.22-9, default 3-symbol payload ~77.9 KB of an 80 KB cap, GPT instructions 7,990 of 7,990 units.

---

## What this pass delivers

| # | Item | Model rule | Master-plan phase it pre-builds | Where it shows |
| --- | --- | --- | --- | --- |
| Q1 | Measured-move target on flag candidates | M-5b | M4 (part) | `candidateSetups[]` (default payload) |
| Q2 | EMA200 side on flag candidates | M-6 | M4 (part) | `candidateSetups[]` (default payload) |
| Q3 | Top-down sentiment 1W/1D/4H/1H + timeframes-above-200 count | M-1, M-2, M-6, M-6b | M2 + M2b (part) | compact token in `decisionTrace.bias` (default); full object with `include=bias` |
| Q4 | Replay outcome scoring (win rate, avg R, expectancy, losing streak, time to TP1) | M-9 | M1 (full) | `scripts/`, no payload change |
| Q5 | GPT instructions teach Q1–Q3, budget-neutral | — | M10 (part) | `docs/GPT_INSTRUCTIONS.md` |

Not in this pass (stay in the master plan): Stoch RSI divergence (M5), channels per timeframe and breakout read (M3), flags on 15m/1h/4h (rest of M4), MA pull read (rest of M2b), composite confidence (M6), `FLAG_21` strategy (M7), survival sizing (M8), replay comparison (M9).

Nothing in this pass changes a strategy decision, `bestSignal`, a stop, a target, or confidence. Everything is additive information.

---

## Rules for this pass

1. Additive only. Existing fields and strategy outputs stay byte-identical; only new fields and one extended trace string.
2. Hard invariants, never relaxed: canonical NO_TRADE contract; SCALP_1H/MICRO_SCALP 3% stop cap; MCP exactly one read-only tool, no auth, no execution or signing imports; REST Bearer 401/401/405/200; wallet unavailable ≠ zero and never changes `dataStatus`; no secrets in code, logs, or payload.
3. Direction symmetry: long and short through one code path, mirrored tests with identical numbers.
4. Moving averages are never targets (M-6). Alignment never gates anything (M-2). EMA200 side never filters (M-6).
5. Constants in `config/engine.json` under a new `model` key; bump `configVersion` 2026.09.22-9 → 2026.09.22-10. Schema 1.10.0 → 1.11.0; keep `openapi/scalp-context.yaml` in step with ChatGPT-safe constructs (`[object, "null"]`, `items: {type: object}`, no `type: "null"` scalars).
6. Budgets: default payload stays ≥ 0.5 KB under 80 KB (report exact bytes before and after); build time +≤ 0.5 s (report); `npm run check:gpt` ≤ 7,990.
7. No new files under `api/`. No new dependencies. Do not import dead or legacy modules (`lib/signalEngine.js`, `lib/momentumAlignment.js`, `lib/tradeReadiness.js`, `lib/advancedChartAnalysis.js`, `services/strategy-refactored.js`).
8. Do not touch: `services/strategy.js`, MCP tool registration (`services/editTradesMcp.js`, `lib/mcpHttp.js`), REST auth, `services/walletTracker.js`, `public/index.html`.
9. No commit, push, deploy, Vercel env change, or paid call. Stop after the report.

---

## Q1 — Measured-move target on flag candidates (M-5b)

The owner's rule: after a big pump (or dump) flags out, the next target is the pole length (base of the first move to the point where the flag starts) projected from the flag's breakout. It usually lands near 3:1.

Build (`lib/patternDetector.js`):
- `measureImpulse()` (~line 131) already finds the pole's trough and peak on oriented candles (shorts are mirrored). Return the trough price too.
- Carry `poleBase` (trough) and `poleHeight` (`range`) through `findOrientedFlag()` and de-orient them for shorts the same way `breakoutLevel`/`invalidation` are de-oriented.
- Publish on each flag candidate (not on coils):
  - `poleHeight`: absolute price distance.
  - `measuredTarget`: `breakoutLevel + poleHeight` for longs, `breakoutLevel − poleHeight` for shorts.
  - `measuredRR`: `|measuredTarget − breakoutLevel| / |breakoutLevel − invalidation|`, rounded to 2 decimals; null if the denominator is 0.
- Round prices the same way the existing candidate prices are rounded.
- `attachCandidateRisk` and lifecycle snapping stay unchanged. If snapping moves `breakoutLevel`, compute `measuredTarget` from the snapped level and state that in the JSDoc.

Tests (`test:pattern`): long flag with a known pole → exact `measuredTarget` and `measuredRR`; mirrored short → mirrored target, identical `measuredRR`; coil → fields absent.

## Q2 — EMA200 side on flag candidates (M-6)

Build: on each flag candidate, `ema200Side: "above" | "below" | null` (price vs that timeframe's EMA200; null when EMA200 is unavailable). The EMA200 value is already computed per timeframe in `services/scalpContext.js` (~line 1108). No filtering, no confidence change.

Tests (`test:scalp` or `test:pattern`): above, below, null; a short above the EMA200 is still published (the M-6 case).

## Q3 — Top-down sentiment and timeframes above the 200 (M-1, M-2, M-6, M-6b)

Build `lib/topDown.js`, pure, no I/O:
1. `weeklyFromDaily(dailyCandles)`: aggregate closed 1D candles into ISO weeks (Monday 00:00 UTC). Drop the current incomplete week. Reuse the idea in `services/marketData.js` (~line 100) but write a pure helper here; do not import `marketData.js` into the scalp-context path if it pulls network code.
2. Weekly lean: last weekly close vs weekly EMA21 (compute from weekly closes), plus the EMA21 slope over the last 3 weeks. Weekly EMA200 is not computable (~71 weeks of history) → `null` with reason `"insufficient history"`.
3. `topDown`: leans for 1W, 1D, 4H, 1H (1D/4H/1H come from the existing bias matrix `timeframeBias()` output, already built per symbol at ~line 1300). `sentiment: bull | bear | mixed` from a weighted vote (config `model.topDownWeights`, default `{ "1w": 4, "1d": 3, "4h": 2, "1h": 1 }`; higher timeframes dominate per M-6b). `aligned`: how many of the four agree with the sentiment (0–4). `score`: weighted agreement 0–1.
4. `above200`: over the timeframes with an EMA200 (1m–1D), `{ count, of, weighted }`, where `weighted` uses config `model.above200Weights` (higher timeframes weigh more, lower timeframes discounted). Mirror `below200` is `of − count`.
5. Wiring (`services/scalpContext.js`): compute inside the existing bias `try` block so a failure only logs and never breaks the build.
   - Default payload: append two tokens to the `decisionTrace.bias` string: `|td:<bull|bear|mixed>:<aligned>/4|a200:<count>/<of>`. Example: `...|ct:1|td:bull:3/4|a200:5/7`.
   - With `include=bias` (REST and MCP, existing gate): full object at `symbols.X.topDown = { sentiment, aligned, score, leans: {1w,1d,4h,1h}, weekly: { close, ema21, ema21Slope, ema200: null, reason }, above200 }`.
6. Never gates or changes a strategy, candidate, or confidence.

Tests: `test-top-down.js` + npm script `test:topdown`: weekly aggregation (week boundaries, incomplete week dropped), full bull, full bear (mirror → identical score), mixed, higher-timeframe weighting beats a lower-timeframe majority, missing weekly history → weekly lean `neutral` with reason, `above200` counts and weights. `test:bias`: the extended trace string grammar. `test:scalp`: default payload carries the tokens; `topDown` object only with `include=bias`.

## Q4 — Replay outcome scoring (M-9, master plan M1)

Build: `scripts/replay-outcomes.js` (import helpers from `scripts/replay-metrics.js`; no production code change). Input: the replay JSONL from `scripts/replay.js` plus the stored candle history directory. For each valid strategy signal per symbol (dedupe: a signal counts once until it changes), walk forward on the 1m history with no lookahead:
- Entry filled when price touches the entry zone within `replay.outcomes.fillWindowCandles` (config); else "not filled".
- Exit on first touch of stop (loss, −1R) or TP1 (win, R = |TP1 − entry| / |entry − stop|). Stop and TP1 touched in the same candle count as a loss.
- Record hold time to exit and time to TP1.
- Aggregate per strategy and direction: signals, fills, win rate, average win R, expectancy (R per trade), max consecutive losses, median time to TP1.

Also run the same scoring for flag candidates that reached `confirmed`, using `breakoutLevel` as entry, `invalidation` as stop, and Q1's `measuredTarget` as TP1, so the owner sees how the measured-move target performs.

Tests (`test:replay` additions): long win, long loss, mirrored short win/loss, not filled, same-candle ambiguity → loss, streak counting, expectancy arithmetic.

Acceptance: run it on the existing captured history under `test/fixtures/history/` (whatever is present) and paste the baseline table into the report. If no history is present, say so; do not capture (network) without the owner's OK.

## Q5 — GPT instructions (budget-neutral)

Edit `docs/GPT_INSTRUCTIONS.md` fenced block only:
- Flags: `measuredTarget` is the flag's TP1 (a major level or channel line in front of it comes first); `measuredRR` ≥ 3 supports the call.
- `ema200Side` is context, never a filter.
- `decisionTrace.bias` tokens `td:<sentiment>:<n>/4` and `a200:<count>/<of>`: state sentiment and alignment; alignment raises or lowers confidence, never vetoes. Moving averages are never targets.
- Trim an equal amount elsewhere (look for duplicated wording first). `npm run check:gpt` must pass (≤ 7,990).
- Add one row per new field to the doc's "payload field → instruction rule" table and a change-log line with the before/after unit count.

---

## Docs to update

`docs/MASTER_PLAN_TRADING_MODEL.md`: note under the phase map that the quick pass delivered M1 in full and parts of M2, M2b, M4, M10 (list which). `docs/EDITTRADES_MCP_CONNECTOR.md` (schema map 1.11.0, new fields, test counts). `openapi/scalp-context.yaml`. `CHANGELOG.md`. `docs/DOCUMENTATION_INDEX.md` (new module `lib/topDown.js`, new script, this plan).

## Verification before reporting

- All suites: `test:sltp`, `test:scalp`, `test:mcp`, `test:wallet`, `test:config`, `test:risk`, `test:pattern`, `test:geometry`, `test:chart`, `test:replay`, `test:bias`, `test:topdown`. Report counts.
- `npm run check:gpt`.
- `git diff --check` on touched files.
- Local build of one real payload (`buildScalpContext` for BTC/ETH/SOL): default bytes before/after, build ms before/after, one example candidate with `measuredTarget`/`measuredRR`/`ema200Side`, one example bias string with the new tokens.

---

## Implementer prompt (paste into a fresh Sonnet thread)

```
Implement docs/PLAN_TRADING_MODEL_QUICK_PASS.md in one pass: Q1 -> Q2 -> Q3 -> Q4 -> Q5, then docs,
then verification, then report and stop.

Repo: /Users/bballi/Documents/Repos/snapshot_tradingview, branch upgrade-signal-engine.

Read first, in order:
1. docs/PLAN_TRADING_MODEL_QUICK_PASS.md (this pass; the source of truth for scope)
2. docs/MASTER_PLAN_TRADING_MODEL.md (the owner's model M-1..M-9; context only, do not build its other phases)
3. CLAUDE.md
4. lib/patternDetector.js, lib/biasMatrix.js, services/scalpContext.js (bias block ~line 1290), config/engine.json,
   scripts/replay.js, scripts/replay-metrics.js, docs/GPT_INSTRUCTIONS.md

Before editing: run git status and all suites; record counts and the default payload bytes and build ms.
Then state in 3 lines: files you will touch, files that stay untouched, budgets.

Rules (from the plan): additive only; long/short through one code path with mirrored tests; moving averages
are never targets; alignment never gates; EMA200 never filters; constants in config/engine.json (configVersion
-9 -> -10); schema 1.10.0 -> 1.11.0 with openapi in step; default payload stays >= 0.5 KB under 80 KB; build
+<= 0.5 s; check:gpt <= 7,990. Do not touch services/strategy.js, MCP tool registration, REST auth,
walletTracker.js, public/index.html. No new api/ files, no new dependencies, no legacy/dead-module imports.
No commit, push, deploy, env change, network capture, or paid call.

If a step cannot meet its acceptance as written, finish the other steps, then report exactly which
criterion blocked and why. Do not narrow a criterion silently.

Report (compact): files changed; behavior added per Q1-Q5; what stayed untouched; suites with counts before
and after; payload bytes and build ms before and after; the Q4 baseline table; GPT instruction units before
and after; risks and anything not verified. Then stop.
```
