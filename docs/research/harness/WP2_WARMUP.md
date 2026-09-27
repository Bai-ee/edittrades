# WP2 — indicator warm-up audit (Freqtrade `recursive-analysis` concept)

Status: measurement only. Nothing in `api/`, `lib/`, `services/` or `config/` was changed.
Engine freeze in effect until 2026-10-08 (`docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md`).

Code: `scripts/research/harness/warmup-audit.js`, `test-warmup-audit.js`.
Run: `node scripts/research/harness/warmup-audit.js` (prints a table, writes
`var/research/wp2/warmup-audit-results.json`). Tests: `node test-warmup-audit.js` (15/15 pass).

## Question

Does the live engine compute different indicator values than research because it only
fetches a limited candle history?

## Live trace — actual per-timeframe fetch limit on `/api/scalp-context`

| File:line | What it shows |
| --- | --- |
| `services/scalpContext.js:112` | `const FETCH_LIMIT = 500;` |
| `services/scalpContext.js:1218` | `await fetchCandles(task.pair, task.tf, FETCH_LIMIT, { now: safeNow });` — **one constant, reused for every timeframe** (`TIMEFRAMES` = 1m,3m,5m,15m,1h,4h,1d, `services/scalpContext.js:29`). There is no per-timeframe override on this path. |
| `services/marketData.js:769` | `export async function getCandlesWithProvenance(symbol, interval, limit = 500, options = {})` — default matches; scalpContext always passes 500 explicitly. |
| `services/marketData.js:166` | `async function fetchFromKraken(symbol, interval, limit = 500)` |
| `services/marketData.js:~213` | `const candles = ohlcData.slice(-limit).map(...)` — Kraken's public `OHLC` endpoint returns up to ~720 raw points per call (no pagination used here); the code slices the **last** `limit` of those. Effective live window = `min(500, ~720) = 500` candles, for every timeframe, 1m through 1d. |
| `services/scalpContext.js:1308` | `indicators = indicatorService.calculateAllIndicators(closed);` — `closed` is the fetched, closed-only array (≤500 bars). The one call site for EMA21/EMA200/RSI/StochRSI on the live path. |
| `services/scalpContext.js:1316-1317` | `CANDLE_LIMITS[tf]` (20 intraday / 10 daily) trims `closed` → `trimmed` for the **published payload candles only**, after indicators are already computed on the full ≤500-bar `closed` array. **Does not affect warm-up.** |
| `services/scalpContext.js:1419,1572` | `buildGeometryContext({ candles: closed, ... })` — same ≤500-bar array feeds geometry/ATR. |
| `lib/geometry.js:53` | `export function atr(candles, n = ENGINE_CONFIG.geometry.atrPeriod)` wraps `lib/advancedIndicators.js:98 calculateATR`. `config/engine.json:49,80` → `atrPeriod: 14`. |
| `lib/advancedIndicators.js:14` | `calculateVWAP` — **not called anywhere on the scalp-context/MCP path** (only `api/indicators.js`, `api/analyze.js` — separate, non-MCP endpoints). |

**Answer to the double-check:** the live limit is a flat **500 bars for every timeframe**, not a per-timeframe value. `docs/research/EXTERNAL_HARNESS_REFERENCES.md`'s note ("`services/marketData.js:769`, default `limit=500`") is confirmed exactly.

## Indicator implementations exercised (same functions the live path calls)

| Indicator | File:line | Notes |
| --- | --- | --- |
| EMA21 | `services/indicators.js:16 calculateEMA21` | `EMA.calculate({period:21})` (`technicalindicators` npm lib), reached via `calculateAllIndicators` |
| EMA200 | `services/indicators.js:32 calculateEMA200` | `EMA.calculate({period:200})`, same lib |
| RSI(14) | `services/indicators.js:~168` (inline inside `calculateAllIndicators`, `services/indicators.js:75`) | No separately exported RSI function; inlined via `RSI.calculate({period:14})`. This audit calls `calculateAllIndicators` directly (not the three sub-functions individually) so the numbers read exactly what the live path produces. |
| Stoch RSI | `services/indicators.js:49 calculateStochasticRSI` | `StochasticRSI.calculate` — rsiPeriod 14 / stochasticPeriod 14 / k 3 / d 3 |
| ATR | `lib/advancedIndicators.js:98 calculateATR` | Hand-rolled Wilder smoothing, period 14, independent of `technicalindicators` |
| VWAP | `lib/advancedIndicators.js:14 calculateVWAP` | Not on the live decision path — see above. Non-recursive windowed average, so "warm-up bias" does not apply to it the way it does to EMA/RSI/ATR: a different lookback is a deliberate parameter choice, not a history-starvation artifact. Measured for completeness only, excluded from the verdict. |

`EMA.js` (`technicalindicators`) seeds each EMA with `SMA(period)` of the first `period`
values it's given, then applies the standard exponential recursion. That seed is the
mechanism this audit measures: a short window's SMA seed lands close to the decision
point T, leaving few recursive steps to forget it.

## Method

Freqtrade's `recursive-analysis` concept: for many sample points T per (symbol,
timeframe), compute each indicator using only the last **W** bars, `W ∈ {200, 300, 500,
1000, 2000}` (500 is the live limit), vs a **long-history reference** — as much prior
history as the fixture affords, capped at 6000 bars for performance (EMA200's per-step
decay factor `(1 - 2/201)^n` is already ~1e-25 by 5800 bars past the seed, so 6000 bars
is effectively "infinite history" for every indicator tested here).

Fixtures (oldest-first OHLCV, read-only):
- 4h: `var/edge/4h-long/{BTC,ETH,SOL}_4h.json` (19,955 / 19,955 / 13,431 bars)
- 1d: `var/edge/daily-long/{BTC,ETH,SOL}_1d.json` (3,328 / 3,328 / 2,238 bars)
- 5m/15m/1h: `test/fixtures/history/deep2y-2026-09-26/{BTC,ETH,SOL}_{5m,15m,1h}.json` (209,125 / 69,708 / 17,427 bars each)

15 (symbol, timeframe) series, ~120 sample points each (fewer where the series is
shorter than the sampling range). `W=2000` is skipped for the three daily fixtures
(insufficient total history — BTC/ETH daily has 3,328 bars, SOL daily only 2,238) and
flagged explicitly in the output rather than silently omitted.

Decision-relevant flips measured per window: `sign(close−EMA200)`, `sign(close−EMA21)`,
Stoch RSI `condition` (the engine's own OVERBOUGHT/OVERSOLD/BULLISH/BEARISH/NEUTRAL
classification, `services/indicators.js:~139-150`), Stoch RSI K/D cross, RSI zone
(engine's own `>70`/`<30` thresholds, `services/indicators.js:283-284`), and — bonus,
since it's the literal decision output fed downstream — the `UPTREND/DOWNTREND/FLAT`
`trend` label.

## Results

### Aggregated across all 15 series (range across series; EMA200 is the only indicator with a nonzero reading)

| W | EMA200 median % gap | EMA200 max % gap | `ema200Sign` flip % | `trend` flip % | `stochCross` flip % |
| --- | --- | --- | --- | --- | --- |
| 200 | 0.10 – 5.30 | 0.67 – 15.01 | 1.67 – 12.50 | 0.83 – 10.00 | 0.00 – 1.67 |
| 300 | 0.05 – 2.18 | 0.52 – 6.89 | 0.83 – 7.50 | 0.00 – 8.33 | 0.00 – 1.67 |
| **500 (live)** | **0.01 – 0.26** | **0.05 – 1.09** | **0.00 – 1.67** | **0.00 – 2.50** | 0.00 – 1.67 |
| 1000 | 0.00 – 0.00 | 0.00 – 0.01 | 0.00 – 0.00 | 0.00 – 1.67 | 0.00 – 1.67 |
| 2000 | 0.00 – 0.00 | 0.00 – 0.00 | 0.00 – 0.00 | 0.00 – 0.00 | 0.00 – 0.83 |

EMA21, RSI, Stoch RSI K/D value, and ATR: **0.00% median and max gap at every window,
including W=200**, on all 15 series — these periods (21, 14, 14) converge fully within
a couple hundred bars, so live's 500-bar fetch gives research-identical values. Full
per-series numbers for every field are in `var/research/wp2/warmup-audit-results.json`.

### At the live limit (W=500), per series — EMA200 gap and flip rates

| Series | EMA200 median % / max % | `ema200Sign` flip % | `trend` flip % |
| --- | --- | --- | --- |
| BTC/4h | 0.073 / 0.406 | 0.00 | 1.67 |
| ETH/4h | 0.093 / 0.645 | 0.00 | 0.00 |
| SOL/4h | 0.108 / 0.467 | 0.83 | 0.00 |
| BTC/1d | 0.174 / 0.868 | 0.00 | 0.00 |
| ETH/1d | 0.260 / 1.087 | 0.00 | 0.83 |
| SOL/1d | 0.201 / 0.860 | 0.00 | 0.00 |
| BTC/5m | 0.007 / 0.050 | 0.00 | 0.83 |
| ETH/5m | 0.012 / 0.061 | 1.67 | 0.83 |
| SOL/5m | 0.012 / 0.076 | 0.83 | 0.83 |
| BTC/15m | 0.014 / 0.100 | 0.00 | 1.67 |
| ETH/15m | 0.022 / 0.132 | 0.83 | 2.50 |
| SOL/15m | 0.025 / 0.156 | 1.67 | 0.83 |
| BTC/1h | 0.025 / 0.104 | 1.67 | 2.50 |
| ETH/1h | 0.038 / 0.168 | 0.00 | 0.83 |
| SOL/1h | 0.042 / 0.184 | 0.00 | 0.00 |

### VWAP (reference only, not on the live path)

Median % gap between windows runs 48–60% and max gaps exceed 150% (e.g. BTC/4h:
W=200 vs long-history median 59.2%, max 287.6%). This is expected and **not a warm-up
bug**: VWAP has no recursive memory, so a different window is a different, deliberately
scoped average, not an artifact of insufficient history. Excluded from the verdict below.

## Deterministic test (`test-warmup-audit.js`)

A synthetic series `closes[i] = 1000 + 0.5*i + 200*sin(i/50)` (trend + bounded
oscillation, no randomness) gives, at a fixed decision point, `EMA200` gaps vs. a
6000-bar reference of **73.12 (W=200) → 20.17 (W=300) → 3.87 (W=500) → 0.0209 (W=1000) →
2.6e-7 (W=2000)** — strictly decreasing, W=2000 numerically negligible, W=200 five orders
of magnitude worse than W=2000. (A pure straight-line ramp was tried first and gives an
exact-zero gap at every window — a genuine algebraic coincidence, `SMA(period)` of a
line and the EMA steady-state lag for a line are identical for any period — so it's
documented as a non-useful fixture rather than used for the assertion.) 15/15 tests pass,
including flip-rate range checks, a determinism (repeat-run) check, and one check against
the real BTC/4h fixture.

## Verdict

**Does live warm-up change signals? Rarely, and only through EMA200.**

- EMA21, RSI(14), Stoch RSI, and ATR(14) are fully converged by 500 bars on every
  symbol/timeframe tested (0.00% gap, 0 flips, even at W=200). Live and research values
  for these four are effectively identical regardless of history depth, so the fetch
  limit is a non-issue for them.
- EMA200 carries a real but small residual warm-up bias at the live limit (W=500):
  median gap 0.01–0.26%, max 0.05–1.09% depending on series. This occasionally (0–1.67%
  of sampled decision points) flips `sign(close−EMA200)`, and slightly more often
  (0–2.5%) flips the composite `trend` label (which also depends on the EMA21-vs-EMA200
  ordering, so it can flip even when neither raw sign does). No `rsiZone` or
  `stochCondition` flips were observed at any window on any series.
- The effect is small at 500 bars specifically **because** 500 already gives EMA200 300
  post-seed recursion steps (`(1 - 2/201)^300 ≈ 5%` residual seed weight). It is **not**
  small in general: at W=200 (the bare minimum EMA200 will even compute — zero decay
  steps, literally just `SMA(200)`), median gaps reach 0.10–5.30% (max up to 15%) and
  `ema200Sign`/`trend` flip 1.67–12.50% / 0.83–10.00% of sampled points. If the live
  fetch limit were ever lowered toward 200–300, EMA200-driven decisions would diverge
  from long-history research meaningfully often; at the current 500 they diverge rarely.
- No evidence the live path uses a different limit per timeframe — it's the same 500
  everywhere, confirmed by direct trace (`services/scalpContext.js:112,1218`).

## Recommended minimum history (post-freeze proposal only — nothing changed)

No change is required for correctness today; live's 500-bar limit already keeps
EMA200's residual bias under ~0.3% median / ~1.1% max, with sub-3% decision-flip rates
against a long-history reference. If a future phase wants EMA200 to be flip-rate-clean
against research at the ~0.1–1% level rather than a straightforward accept:

| Indicator | Minimum bars for negligible warm-up bias (this audit's data) | Live gets |
| --- | --- | --- |
| EMA21 | ≤200 (already 0.00% gap at the minimum tested) | 500 |
| RSI(14) / Stoch RSI | ≤200 (already 0.00% gap at the minimum tested) | 500 |
| ATR(14, Wilder) | ≤200 (already 0.00% gap at the minimum tested) | 500 |
| EMA200 | 1000 (gap and flips both round to 0.00% at W=1000 on every series tested) | 500 |

Raising `FETCH_LIMIT` (`services/scalpContext.js:112`) from 500 to 1000 for every
timeframe would fully close the observed EMA200 gap at the cost of double the per-request
candle fetch (still one Kraken call per symbol/timeframe; Kraken's raw OHLC response is
already ~720 candles, so 1000 would need either a second paginated call or accepting
Kraken's native cap, whichever is smaller — an implementation detail for whoever picks
this up, not decided here). This is a proposal only; no code was touched.
