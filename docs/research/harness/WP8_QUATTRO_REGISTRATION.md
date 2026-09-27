# WP8 — Quattro Donchian registration (frozen before results, 2026-09-27)

Research only. Registered before running `quattro.js` on the full data. Source: `EstebanSP23/crypto_systematic_research`
@ `5df0c43f6d48b7d8dbb74843d6747e5ddbb6819b` (verified via `git ls-remote` and `git checkout` to that exact SHA in scratch;
matches the SHA already recorded in `docs/research/external-refs/DEEP_RESEARCH_REPORT_STRATEGY_REPOS_2026-09-27.md`).
Files read at that SHA: `2_strategies/01_quattro_donchian/{README.md, backtest.py, backtest_trend.py, quattro_v2_engine.py,
backtest_multi_asset.py}` plus the committed `results/*.csv` and `backtest_*_results.csv`. Not executed locally (see
§0 below) — committed CSVs are used as source ground truth instead, which is stronger than a fresh run since they are
the artifacts the repo's own README numbers were computed from.

## 0. Repro decision: record committed results, not a fresh run

`git ls-remote`/`clone` to GitHub works from this environment, so the repo was cloned and pinned to the exact SHA.
Running the strategy fresh would require `ccxt` fetching multi-year Binance OHLCV (no local venv/pandas/ccxt
available here, and re-fetching risks a different data snapshot than what produced the committed numbers). The repo
already ships full per-trade CSVs for exactly the configurations this WP needs, so those are used as frozen
reference ground truth instead of a fresh Python run:

| Reference file (copied to `var/research/wp8-quattro/reference/`) | Source script | Symbol | Regime | Units | n trades |
| --- | --- | --- | --- | --- | --- |
| `source_BTC_1U_regimeA.csv` | `backtest_trend.py` | BTC | A (code) | 1 (no pyramid) | 89 |
| `source_BTC_PYR_regimeA.csv` | `backtest.py` | BTC | A (code) | ≤4, 20x cap | 94 |
| `source_BTC_PYR_regimeA_v2costs.csv` | `quattro_v2_engine.py` (`results/quattro_v2_costs.csv`) | BTC | A (code) | ≤4, 20x cap | 94, costed summary |
| `source_BTC_PYR_regimeB.csv` | `backtest_multi_asset.py` (locked) | BTC | B (doc/slope) | ≤4, 20x cap | 80 |
| `source_ETH_PYR_regimeB.csv` | `backtest_multi_asset.py` (locked) | ETH | B (doc/slope) | ≤4, 20x cap | 74 |
| `source_SOL_PYR_regimeB.csv` | `backtest_multi_asset.py` (locked) | SOL | B (doc/slope) | ≤4, 20x cap | 63 |

These give ground truth for **both** regime interpretations and all three symbols (contradicting Card 7's claim that
Quattro is BTC-only — `backtest_multi_asset.py` runs identical logic on BTC/ETH/SOL independently; the deep-research
report only read the single-asset `backtest.py`/README).

## 1. Exact rules confirmed at the pinned SHA (code, not prose)

**Entry** (`backtest.py:51,66-67,207`; identical in `backtest_trend.py`, `quattro_v2_engine.py`, `backtest_multi_asset.py`):
```
donch_high_20[i] = max(high[i-20..i-1])         # rolling(20).max().shift(1)
regime_A[i]      = close[i] > daily_ema200_avail[i]
signal[i]        = close[i] > donch_high_20[i] and regime[i]
fill             = open[i+1]                     # next 4h bar open
```
`daily_ema200_avail` = daily EMA200 (`close.ewm(span=200, adjust=False)`), index shifted **+1 calendar day**, then
ffilled onto the 4h grid (`backtest.py:61-66`). Net effect: the daily EMA200 value used for any 4h bar on calendar
day D is the EMA200 computed through day D−1's daily close — causal, no look-ahead.

**Regime discrepancy (confirmed, both sides now read in full):**
- Code (`regime_up = close > d_ema200`) never checks slope anywhere in `backtest.py`, `backtest_trend.py`, or
  `quattro_v2_engine.py`. → **QUATTRO_1U_A**.
- `2_strategies/01_quattro_donchian/README.md:17`: *"Trend filter: Daily 200 EMA must be rising
  (daily_EMA200[d] > daily_EMA200[d-20])"* — an exact, executable formula, not just prose. `backtest_multi_asset.py:73-74`
  is the one script that actually **implements** this: `ema200_up = ema200 > ema200.shift(20)`, ANDed with the
  code's own `close > ema200` gate (`backtest_multi_asset.py:163-165`). → **QUATTRO_1U_B** uses this exact formula
  (20 **daily** bars, not "slope over 1 day" — the WP brief's paraphrase was imprecise; the README's own formula is
  used as source of truth per the "read first" instruction).

**Exit** (single unit, `backtest_trend.py:139-161`):
```
donch_low_10[i] = min(low[i-10..i-1])            # rolling(10).min().shift(1)
atr_stop        = entry - 2*ATR14[entry_signal_bar]     # N fixed at signal bar, wick-based, fill AT the stop level
hard_stop       = entry - (0.05 * acct_at_entry / size) # = entry - 5N given 2%-risk/2N-stop sizing; wick-based
donchian_exit   : close[i] < donch_low_10[i] -> pending, fills at open[i+1]
```
Order each bar: (1) execute any pending exit at this bar's open, (2) if in a trade: hard stop check (wick) →
ATR stop check (wick) → Donchian close-exit check (sets pending for next bar's open); (3) if flat: entry check using
*this* bar's own close (so an exit-fill-at-open bar can also raise a fresh entry signal the same bar; a same-bar
wick-stop exit cannot, because of the `continue` in the source — replicated exactly, see `scripts/research/edge/quattro.js`).

**ATR(14):** Wilder-style, `tr.ewm(alpha=1/14, adjust=False).mean()`, seeded from the first bar (not lib.js's
SMA-seeded `atr()`). Reproduced pandas-exact in `quattro.js` (`atrEwm()`) rather than reusing `lib.js`'s `atr()`,
to remove any early-bar seeding mismatch — trivial to match exactly and removes an unforced source of drift.

**Sizing / pyramid** (`backtest.py:76-79,171-227`, unchanged in `quattro_v2_engine.py`):
```
RISK_PCT = 0.02, HARD_STOP_PCT = 0.05, PYRAMID_STEP = 0.5N, MAX_UNITS = 4, MAX_LEVERAGE = 20 (source)
unit k trigger = original_entry + 0.5*(k-1)*N        (k = 2,3,4; checked via bar HIGH, intrabar)
unit k size    = (acct_at_entry * 0.02) / (2*N)       (same $ risk basis for every unit — N and acct_at_entry fixed)
common_stop    = max(common_stop, newest_unit_entry - 2N)   (tightens only, never loosens)
leverage check = (existing notional + new unit notional) / CURRENT account ; reject/skip unit if > MAX_LEVERAGE
```
With 2%-risk sizing, a single unit is usually well under 1x notional (typically ~0.3–0.7x for BTC-like ATR/price
ratios) but **not always** — in a low-realized-vol regime, `2N/price` can shrink enough that a single unit exceeds
1x. The 4-unit pyramid routinely approaches or exceeds 1x and needs the source's 20x cap to avoid rejecting units.

## 2. Registered strategies for `quattro.js` (frozen before results)

All four use next-open fills, long only, real BTC/ETH/SOL 4h+daily OHLCV from `var/edge/{4h-long,daily-long}`
(2017/2020→2026-09-27), no shorts. Reported/official arms use **`maxLeverage = 1`** (no leverage, per the WP's
top-level rule) instead of the source's 20x — this is the only intentional deviation from source mechanics, applied
uniformly to every arm (including the two 1-unit arms, since 1-unit notional is not *always* ≤1x, see §1).

| ID | Regime | Units | maxLeverage (official) | Notes |
| --- | --- | --- | --- | --- |
| `QUATTRO_1U_A` | code: `close > daily EMA200` | 1 | 1 | Primary code-rule reproduction |
| `QUATTRO_1U_B` | doc: `close > daily EMA200` AND `EMA200[d] > EMA200[d-20]` | 1 | 1 | README's exact rising-EMA formula |
| `QUATTRO_PYR_A` | code (A) | ≤4, +0.5/1.0/1.5N | 1 | Pyramid arm, A regime, no leverage |
| `QUATTRO_PYR_B` | doc (B) | ≤4, +0.5/1.0/1.5N | 1 | Pyramid arm, B regime, no leverage — matches the "locked" source variant's regime |

A separate **validation-only** pass (not reported as an official arm) reruns each engine with `maxLeverage = 20`
matching the source exactly, on BTC/ETH/SOL, purely to check `quattro.js` against the six reference CSVs in §0
(entry/exit dates, exit reasons, R-multiples). This is a reproduction check, not a strategy recommendation.

**Windows** (all engines computed over full available history first; window is a report-time filter/rebase, same
convention as `sma4h-trend.js`'s `runSma4h`):
- `source_window`: 2022-01-01 → now (matches the source's own study period)
- `full_history`: first eligible signal bar (donchian+ATR+regime all defined) → now
- `2020_2023`, `2024_2026`: split at 2024-01-01 (SOL only has data from 2020-08-11)

**Costs** (per COMMON RULES / master plan): gross; spot 0.15%/side; perps 0.20% round-trip long + borrow 0.02%/h and
0.024%/h on hours held; source's own 0.06%/fill (no funding modeled, flagged as an undercount vs. the source's real
Binance funding settlements). Fees/borrow are charged on **traded notional** (fill size × price), not on whole
account equity, since Quattro's units are risk-sized fractions of equity, not always-100%-invested like
`runSma4h`.

## 3. Deviations from source (declared before running)

1. **`maxLeverage = 1`** instead of 20, all four official arms (§1) — the WP's explicit "no leverage" rule.
2. **ATR seeding**: pandas-exact EWM (`atrEwm`), not `lib.js`'s SMA-seeded `atr()`. Economically immaterial after
   warm-up but removes an unforced discrepancy.
3. **EMA200 seeding**: reuses `lib.js`'s SMA-seeded `ema()` rather than a 0-seeded EWM. Our daily history starts
   2017-08-17 (BTC/ETH) / 2020-08-11 (SOL), 3–4 years earlier than the source's 2021-01-01 daily fetch — both
   seeding schemes fully converge (residual seed weight `(1-2/201)^n` is negligible after >1,500 daily bars) well
   before the 2022 trading window, so this is a non-issue in practice and, if anything, more accurate than source.
4. **No literal `WARMUP=250`-bar buffer.** Bars are only skipped while any of {donchian-20, ATR14, regime} is
   genuinely undefined (`Number.isFinite` gating). Source's 250-bar constant is a safety margin on top of that, not
   a tighter causal requirement — dropping it only affects the very first ~40 days of the *source_window*/2022 start
   and is disclosed in the report if it changes trade count there.
5. **Hard 5%-of-account stop**: kept for both 1-unit and pyramid arms (matches source), even though it is a
   distance-5N stop for 1-unit (below the closer 2N ATR stop) and so essentially never binds for 1-unit — noted, not
   removed, since keeping it is truer to source and it is a legitimate (rare) tail-gap protection either way.
6. **Trade-in-window convention**: a trade counts toward a window's trade-level stats (win%, avg R, etc.) if its
   entry fill time falls in `[fromMs, toMs)`; the equity/CAGR/Sharpe/maxDD series is continuous and rebased to 1.0 at
   the window's first bar (same convention as `runSma4h`), so a trade open across a window boundary still affects
   the equity curve even if excluded from the trade list.

## 4. What "reproduction" will and won't claim

- Signal-level fields (entry/exit dates, exit reason, R-multiple) are compared bar-for-bar against the six reference
  CSVs in §0. Small floating-point drift in ATR/EMA is possible but should not flip any entry/exit decision given
  Donchian breakouts are not knife-edge on ATR value (ATR only sets stop distance, not the entry trigger, which is
  purely `close` vs `high.rolling(20).max()`).
- Dollar/equity-curve levels will **not** match source 1:1 even at `maxLeverage=20`, because source starts from
  `$1839.17` real dollars with real BTC notional; `quattro.js` uses a unit-less `account = 1.0` start (scale-free,
  standard for this harness). Trade **dates, exit reasons, and R-multiples** are the comparison, not dollar amounts.
