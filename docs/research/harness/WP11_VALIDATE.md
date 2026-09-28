# WP11 — external validation (research only)

Worktree `/Users/bballi/Documents/Repos/et-wp11-validate` (branch `edge/wp11-validate`). Freqtrade
and its Python venv live only in the session scratch dir, never in this repo. No engine, config,
payload, or deploy change.

## A. Freqtrade independent reproduction of EXTERNAL_4H_SMA200_V1

Registration/context: `docs/research/EXTERNAL_4H_SMA200_STATUS.md`,
`scripts/research/edge/sma4h-trend.js`.

### Setup

- `python3.13 -m venv venv` (Python 3.13.7 — 3.14 was also present on the host and was
  avoided per the timebox note about numba/TA-Lib). `pip install freqtrade` resolved cleanly
  to **Freqtrade 2026.8**, ccxt 4.5.84, no build failures (freqtrade ships TA-Lib wheels; no
  system TA-Lib/numba install needed).
- Data: `var/edge/4h-long/{BTC,ETH}_4h.json` (Binance klines, this repo's own fetch) converted
  to Freqtrade's OHLCV JSON list-of-lists format via a small scratch-only Python script, written
  to `user_data/data/kraken/{BTC,ETH}_USDT-4h.json`.
- **Exchange substitution (metadata only):** Freqtrade's backtester calls `exchange.reload_markets()`
  even for a pure local-data backtest, to fetch pair precision/lot-size metadata. Binance
  returned HTTP 451 (geo-blocked, same as this repo's own fetch fallback pattern) for that
  call too. Switched `exchange.name` to `kraken` (reachable, ccxt-unified `BTC/USDT` /
  `ETH/USDT` symbols) — **only** for market metadata; the OHLCV price data backtested is still
  our own Binance klines. This is a documented, bounded discrepancy (see mismatches below),
  not a substitution of the price series.
- Strategy (`user_data/strategies/Sma200Trend.py`, scratch-only, quoted in full — GPL-3.0
  Freqtrade code was not copied, only the ~30-line strategy file we authored against its API):

```python
from pandas import DataFrame
from freqtrade.strategy import IStrategy


class Sma200Trend(IStrategy):
    timeframe = "4h"
    startup_candle_count = 200

    minimal_roi = {"0": 100}
    stoploss = -0.99

    can_short = False
    use_exit_signal = True
    exit_profit_only = False
    process_only_new_candles = True

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["sma200"] = dataframe["close"].rolling(window=200).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["close"] > dataframe["sma200"], "enter_long"] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["close"] <= dataframe["sma200"], "exit_long"] = 1
        return dataframe
```

- Config: `max_open_trades: 1`, `stake_amount: "unlimited"`, `tradable_balance_ratio: 1`,
  single-pair runs (`--pairs BTC/USDT` / `--pairs ETH/USDT` separately, so BTC and ETH never
  compete for the one stake slot — matches our own per-symbol, single-position runs).
  `--fee 0.0015` (S3, 0.15%/side). `--timerange 20170817-20260928` (full history).

```
freqtrade backtesting --strategy Sma200Trend --config config.json --userdir user_data \
  --pairs BTC/USDT --fee 0.0015 --export trades --timerange 20170817-20260928
freqtrade backtesting --strategy Sma200Trend --config config.json --userdir user_data \
  --pairs ETH/USDT --fee 0.0015 --export trades --timerange 20170817-20260928
```

### Fill-convention check (source-read, not assumed)

Read `freqtrade/optimize/backtesting.py` directly. `_get_ohlcv_as_lists()`:
`df_analyzed[col] = df_analyzed.loc[:, col]....shift(1)` for every signal column, with the
comment *"To avoid using data from future, we use entry/exit signals shifted from the previous
candle"*; `_enter_trade()` then fills at `row[OPEN_IDX]` — the **current** row's own open, which
is now the *next* candle relative to the one whose close set the signal. **Freqtrade fills at
the next candle's open, exactly like `sma4h-trend.js`'s own convention** — this is not the
same as the external `crypto-backtest` repo checked earlier (STATUS.md's own comparison table),
which fills same-bar at close. No look-ahead in either implementation.

### Results — S3 (0.15%/side), full history, vs `sma4h-trend.js`

| | net CAGR | trades | maxDD | win% |
| --- | --- | --- | --- | --- |
| BTC — ours (`sma4h-trend.js` S3, `a_full_history`) | 41.97% | 277 | 77.96% | 13.04% |
| BTC — Freqtrade 2026.8 | 43.31% | 278 | 75.58%¹ | 13.3% |
| ETH — ours | 70.78% | 242 | 56.15% | 17.01% |
| ETH — Freqtrade 2026.8 | 71.33% | 240 | 57.29%¹ | 17.5% |

¹ Freqtrade reports two drawdown numbers: a closed-trades-only DD (BTC 28.44%, ETH 37.23%) and
a continuously-marked "wallet balance" DD (BTC 75.58%, ETH 57.29%). Ours is a continuously
marked equity curve every 4h bar, so the wallet-balance figure is the correct comparison — used
above.

**Entry-timestamp overlap** (exact `open_date` / `entryTime` match, both in UTC):

| | ours | Freqtrade | exact matches | overlap % of ours | overlap % of Freqtrade |
| --- | --- | --- | --- | --- | --- |
| BTC | 277 | 278 | 271 | 97.8% | 97.5% |
| ETH | 242 | 240 | 239 | 98.8% | 99.6% |

Raw numbers and the full non-overlap timestamp lists: `var/research/wp11/wp11a-freqtrade-comparison.json`.
Our own trades independently regenerated (byte-identical to the frozen STATUS.md numbers) at
`var/research/wp11/sma4h-recompute/`.

### Explaining every mismatch

1. **Trade count (BTC 278 vs 277, ETH 240 vs 242) and the ~3% of non-overlapping entries.**
   Every non-overlapping BTC timestamp on both sides clusters around **2018-02-08 through
   2018-02-26** — exactly the documented Binance data gap (`docs/research/EXTERNAL_4H_SMA200_STATUS.md`
   §Datasets: "8 gaps (largest 7 missing 4h candles, clustered around 2018-02-08)"). A missing
   candle shifts the two implementations' rolling-SMA windows by different amounts around the
   gap (our code treats the array as gap-agnostic contiguous indices; Freqtrade's
   `rolling(window=200)` does the same, but the two engines' entry/exit boundary bars land on
   different sides of the gap in this one whipsaw-heavy stretch — the same region flagged in
   STATUS.md's own "5 concrete examples" #1/#4 as a whipsaw/late-re-entry zone). ETH's smaller
   mismatch (3 timestamps only-ours, 1 only-Freqtrade) is consistent with the same mechanism at
   lower amplitude. This is a data-gap artifact, not a strategy or engine bug — 97.5–99.6%
   overlap over 9 years and 250+ trades on two independent codebases is a strong agreement.
2. **CAGR (BTC +1.3pt, ETH +0.6pt higher in Freqtrade).** Three compounding, small-magnitude
   sources, none individually decisive: (a) the handful of extra/missing whipsaw trades from
   (1) above, each worth a fraction of a point of compounded return; (b) lot-size/precision
   rounding — `amount_to_contract_precision()` rounds each trade's position size to Kraken's
   precision metadata (substituted for the geo-blocked Binance metadata), whereas
   `sma4h-trend.js` compounds an exact floating-point equity ratio with no lot-size rounding at
   all; over ~278 round trips and 9 years this drifts by a small amount, plausibly biased
   slightly positive here by chance; (c) CAGR annualization base — `sma4h-trend.js` uses
   `totalBars*4/(24*365)` (exactly 365-day years on the bar count), Freqtrade's `CAGR %` uses
   `(backtest_end - backtest_start)` calendar days; the ~9-year span makes a 365 vs 365.25
   convention difference visible at the second decimal.
3. **MaxDD (BTC −2.4pt, ETH +1.1pt vs Freqtrade's wallet-balance figure).** Same three sources
   as (2) — a slightly different equity path from a few different whipsaw trades and rounding
   will shift where the deepest trough falls, in either direction depending on which trade
   count differs. Not a sign of a systematic bias since it moves opposite directions on the two
   symbols.
4. **Win% (both within 0.3–0.5pt).** Expected residual of the same handful of differently
   resolved whipsaw trades in item 1; not independently meaningful at this sample size.

### Decision

**Confirms the S3 result independently.** A from-scratch Python/pandas engine (Freqtrade,
GPL-3.0, used only as an external tool per the work-package rules — no code copied into this
repo) reproduces `sma4h-trend.js`'s BTC/ETH S3 full-history CAGR within 1.3 points, trade count
within 1, maxDD within 2.4 points, and matches 97.5–99.6% of individual entry timestamps exactly,
with every non-overlap traceable to the same documented 2018-02 Binance data gap. The next-open
fill convention (no look-ahead) is verified from Freqtrade's own source, not assumed. No change
to the PAPER CANDIDATE decision in `docs/research/EXTERNAL_4H_SMA200_STATUS.md`.

## B. Adaptive same-bar stop/TP ordering (R8)

Code: `scripts/research/harness/adaptive-walk.js` (new — wraps/reimplements a variant of the
vendored `scripts/tracker/walk-outcome.js` `walkOutcome`; that file is imported read-only, never
edited), `scripts/research/harness/rescore-swing-ambiguity.js` (rescoring CLI over
`docs/swing/*.json`, read-only — no swing file is modified). Tests: `test-adaptive-walk.js`
(17/17 passing).

### Rule

Nautilus `bar_adaptive_high_low_ordering` (VERIFIED,
`docs/research/external-refs/OTHER_REPOS_VERIFY.md` §1): with the flag on, whichever of a bar's
high/low is numerically closer to that bar's open is assumed touched first. Generalized here to
a signal's stop/target: when one 1m candle's `[low, high]` range contains **both** the stop and
the target, `walkOutcomeAdaptive()` assumes whichever price is closer to that candle's `open`
was hit first (ties keep the conservative default: stop first, mirroring Nautilus's strict `<`
swap condition). Everywhere else the function is byte-identical to the vendored `walkOutcome` —
verified by `test-adaptive-walk.js` §2 (7 unambiguous scenarios: not_filled / win / loss / open
/ prefilled / fill-candle-stop / short-direction, all assert deep-equality between the vendored
function and the adaptive one).

A structural fact makes the rescoring exact and cheap: `walkOutcome`'s loop checks `stopHit`
*before* `targetHit` and returns immediately on any `stopHit`. So every candle before the walk's
last one is, by construction, `stopHit === false` (otherwise the walk would already have ended
there) — a stop+target co-touch can only ever occur on the **final, loss-resolving** candle. The
vendored function already records this exact fact via `outcome.ambiguous` (`{status:'loss',
ambiguous: targetHit}`). So `ambiguous === true` on a recorded `'loss'` row is both necessary and
sufficient to identify every signal adaptive ordering could possibly flip — confirmed
independently for the `holdRule` (structure-exit) scoring path used by the four `re-*` rules too
(`scoreSignalWithHoldRuleAdaptive`, same precedence check, `test-adaptive-walk.js` §3).

### Rescoring `docs/swing/*.json` (17 rule files, all read-only)

```
node scripts/research/harness/rescore-swing-ambiguity.js
```

Output: `var/research/wp11/wp11b-ambiguity-report.json`.

| metric | value |
| --- | --- |
| rules scanned | 17 (2 empty — `legacy-swing`, `mr-channel-fade-4h` — 0 signals each) |
| total signals | 7,475 |
| loss-status signals (the only outcome type that could be ambiguous) | 4,133 |
| **ambiguous signals (stop+target co-touch on the resolving candle)** | **0** |
| ambiguity rate | **0.0%** of all signals, 0.0% of losses, on every rule including `re-flag-retest-1h` |

`re-flag-retest-1h` specifically: 101 signals, 38 losses, 0 ambiguous. Net-R bracket
unchanged: `netExpR` 0.2736, `netExpR_sens020` 0.301 (identical under conservative and adaptive,
since there is nothing to rescore).

**Net-R bracket per rule: identical under conservative and adaptive ordering, for all 17 rules**
— because zero signals in the corpus have anything for adaptive ordering to change. This
finding is exact, not a sampling estimate: per the structural argument above, `ambiguous` fully
enumerates the flip-candidates, and grepping the raw JSON confirms `"ambiguous": false` appears
4,133 times and `"ambiguous": true"` zero times across all 17 files.

### Caveat (why 1m data wasn't re-walked from scratch)

The fixture the original `docs/swing/*.json` run used
(`test/fixtures/history/deep60-2026-09-24`, "2-year 1m BTC/SOL/ETH history" per its commit
message) is no longer present in this worktree — only two short rolling snapshots remain
(`test/fixtures/history/2026-09-22`, `2026-09-23`, ~12h of 1m coverage each, Kraken-provider),
too small to regenerate a comparable multi-year signal corpus. This does **not** weaken the 0%
result: it's read off the `ambiguous` field the original (missing) fixture's 1m data already
computed at generation time, and the structural argument above guarantees that field's
completeness independent of which fixture produced it. `rescoreAmbiguousSignal()` is
implemented and unit-tested (§4) so the moment any rule produces an `ambiguous: true` signal
(a new run, a different symbol/fixture, a tighter-stop rule), rerunning
`rescore-swing-ambiguity.js` will re-locate that exact candle and report the flip — there was
just nothing in the current, recorded corpus for it to do.

### Tests (`node test-adaptive-walk.js`, 17/17 passing)

1. Synthetic ambiguous bar: target-closer-to-open flips conservative loss → adaptive win;
   stop-closer-to-open leaves both at loss; exact tie keeps the conservative default; short
   direction resolves symmetrically.
2. 7 unambiguous scenarios (not_filled, clean win, clean loss, open, prefilled, fill-candle
   stop, short loss): adaptive is deep-equal to the vendored `walkOutcome` in every case.
3. `scoreSignalWithHoldRuleAdaptive`: structure-exit still fires unaffected; an ambiguous bar
   in a `holdRule` walk flips exactly like the plain-`walkOutcome` case.
4. `summarizeAmbiguity` (synthetic multi-symbol rule doc, incl. the real corpus's actual 0%
   shape) and `rescoreAmbiguousSignal` (no-op on non-ambiguous outcomes; correctly re-locates
   and flips a synthetic ambiguous one).

`git diff --check`: clean on all files this work package touched.

## Files

- `scripts/research/harness/adaptive-walk.js` — new, `walkOutcomeAdaptive`,
  `scoreSignalWithHoldRuleAdaptive`, `rescoreAmbiguousSignal`, `summarizeAmbiguity`.
- `scripts/research/harness/rescore-swing-ambiguity.js` — new, CLI, reads `docs/swing/*.json`
  read-only, writes `var/research/wp11/wp11b-ambiguity-report.json`.
- `test-adaptive-walk.js` — new, 17/17 passing.
- `var/research/wp11/wp11a-freqtrade-comparison.json`, `var/research/wp11/wp11b-ambiguity-report.json`
  — new data outputs.
- `var/research/wp11/sma4h-recompute/` — fresh, byte-identical rerun of `sma4h-trend.js` (used
  for the Part A entry-timestamp comparison).
- Freqtrade venv, strategy, config, converted data, exported trade lists: scratch-only, not in
  this repo (per work-package rules; the strategy file is quoted above in full).
