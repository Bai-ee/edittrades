# External Repo Semantics — Research Notes

Scratch dir: `/private/tmp/claude-501/-Users-bballi-Documents-Repos-snapshot-tradingview/8bfa887c-5a15-4f6b-99e8-613225d0a1b5/scratchpad/ext`
(clones live at `crypto-skills/` and `crypto_systematic_research/`, both detached HEAD at the pinned SHAs below)

## 1. Repo A — `0xrikt/crypto-skills` (crypto-backtest)

Pinned SHA: `360c5e24d6ee689f21491771781dbd70ba2034e9`
Files read: `crypto-backtest/README.md`, `SKILL.md`, `requirements.txt`, `src/backtest.py` (2457 lines; the generated-strategy-code template at `src/backtest.py:2104-2313` is a duplicate/simplified copy of the same logic, not separately audited).

### Signal semantics

| Question | Answer | Citation |
|---|---|---|
| `price > sma200` uses which close? | Current bar's own closed candle. `indicator == 'price'` maps to `df['close']` at the *same row* the condition is evaluated on; `sma200` at that row is `ta.sma(df['close'], length=200)` at that row too. No shift applied to either side. | `src/backtest.py:569-570` (price→close), `:203-330` esp. `:256-258` (sma calc), `:592-599` (comparison ops) |
| SMA includes current candle? | Yes — plain trailing rolling mean, inclusive of the current bar (verified empirically: `ta.sma(s,3)` at index 2 = mean of rows 0-2, matches `s.rolling(3).mean()`). | `src/backtest.py:256-258`; confirmed via venv smoke check |
| SMA warm-up | First `period-1` rows are `NaN` (e.g. sma200 is NaN for the first 199 rows); no `dropna()` is called anywhere in the file, so warm-up rows flow into `generate_signals`/`simulate_portfolio` but produce `False` on any NaN comparison (no crash, no spurious signal). | `src/backtest.py:256-258` (calc); no `dropna(` hits in file |

### Execution / fills

- **Fill timing:** same-bar close, not next-bar open. `simulate_portfolio` iterates `df.iterrows()`; on the same row `i` where `entry_signal`/`exit_signal` were computed from `row['close']` (i.e. from indicators evaluated using that row's own close), it immediately transacts at `price = row['close']` (± slippage). There is no `.shift(1)` between signal and fill. `src/backtest.py:660-661, 710-750`.
  - This is not classic future-data look-ahead (indicators only use data through row `i`), but it is an optimistic assumption: it assumes the trader can transact at the exact closing print the instant the candle closes, with zero latency and zero next-bar gap risk. A realistic engine would fill at the next bar's open (see Repo B, which does this correctly).
- **Slippage:** hardcoded `slippage_pct = 0.05` (%) in `simulate_portfolio`'s default arg; **never exposed via CLI** — `main()` calls `simulate_portfolio(...)` at `:2382-2389` without passing `slippage_pct`, so every run silently eats 0.05% slippage on both entry and exit that the user cannot see or tune. `src/backtest.py:648, 713, 732`.

### Commission

- Per side (charged separately on entry and on exit) — `src/backtest.py:714-716` (entry, on `position_value`, i.e. capital-notional) and `:733-735` (exit, on `gross_proceeds`, i.e. position×price notional). Also charged on stop-loss/take-profit forced exits (`:670-673`, `:691-694`) and on the final forced close at end of backtest (`:764-767`).
- On notional, not on P&L. Two commission charges per round-trip trade.
- Default `--commission 0.1` (%) — `src/backtest.py:2327`.

### Position state

- Single position at a time, no re-buy/pyramiding. Entry only fires `if row['entry_signal']==1 and position==0` (`:710`); while `position>0`, further `entry_signal==1` bars are ignored. Staying above SMA200 does **not** re-buy each bar — it holds the one open position until an exit condition (signal / stop-loss / take-profit / end-of-data) closes it. `src/backtest.py:710-750`.

### Equity / metrics

- **Equity curve:** mark-to-market every bar — `equity = capital + (position * price if position > 0 else 0)`, appended each iteration. `src/backtest.py:753-759`.
- **Max drawdown:** running peak vs. each bar's mark-to-market equity, `%` terms. `src/backtest.py:822-834`.
- **Sharpe ratio — BUG:** annualization factor is **hardcoded** to `periods_per_year = 365 * 6` (comment: "Assume 4h default"), regardless of the actual `--timeframe` argument used. Running on 1h, 1d, 15m, etc. silently produces a mis-annualized, wrong Sharpe with no warning. `src/backtest.py:836-844`.
- Sharpe uses per-bar equity returns (not trade returns), 0% risk-free rate assumed.

### Data / exchange

- **Exchange default:** CLI default is **`binance`** (`src/backtest.py:2320`), and `fetch_ohlcv()`'s own default param is also `binance` (`:171`). This **contradicts** `README.md:140` and `SKILL.md:34/523` which both state the default is `okx`. Documentation/code mismatch.
- **Candle timestamp convention:** open time (standard CCXT `[ts, open, high, low, close, volume]`, `ts` = candle open). `src/backtest.py:191-193`.
- **Unfinished last candle:** not explicitly dropped. The pagination loop (`:182-189`) fetches until a batch returns `<1000` rows; if the exchange includes the currently-forming candle in its response, it is not filtered out, so the last row's OHLCV (and hence any signal on it) may reflect a not-yet-closed candle.
- **Pagination / depth limit:** no explicit cap in code; relies entirely on how much history the exchange's public REST endpoint will paginate through, matching the README's per-exchange table (`README.md:202-213`).
- **Look-ahead leakage:** none found in the indicator math itself (all pandas-ta calls and rolling windows are causal/backward-looking; crossover/turning/consecutive logic all use `.shift(1)` correctly). The one real timing issue is the same-bar-close fill described above, which is an unrealistic-fill assumption rather than use of future data.

### Smoke test (Repo A)

- Python 3.14 (system default) failed — `numba` (pandas-ta dep) requires `<3.14`. Used Homebrew `python3.13` for the venv; `pip install -r requirements.txt` succeeded (ccxt 4.5.84, pandas 3.0.6, pandas-ta 0.4.71b0, numpy 2.2.6, plotly 7.1.0).
- **Binance blocked**: `ccxt.base.errors.ExchangeNotAvailable: binance GET .../exchangeInfo 451` (geo-restricted). Fell back to `--exchange kucoin` per instructions; worked.
- Command run:
  ```
  python src/backtest.py --symbol BTC/USDT --timeframe 4h --days 1095 \
    --exchange kucoin --entry "price>sma200" --exit "price<sma200" \
    --output smoke_report.html --name "SMA200 Trend"
  ```
  (default commission 0.1%, default position size 10%, default stop-loss 5%, default take-profit 15%, default hardcoded slippage 0.05% all applied — none overridden.)
- Data returned: 1999 4h candles, **2023-09-28 → 2024-08-26 (333 days)** — kucoin capped well short of the requested 1095 days (consistent with README's "~200 days" ballpark, actually somewhat more).
- Results: **Total Return +5.21%**, **Max Drawdown -1.87%**, **Sharpe 1.52** (note: Sharpe annualization bug above still applies, but timeframe here actually was 4h so the hardcoded factor happens to be correct in this one run), **29 total trades** (1142 raw entry-condition-true bars, but only 29 actual trades fired because position must be flat to re-enter — confirms single-position semantics), win rate 27.6%, profit factor 2.33, final equity $10,520.84, Buy&Hold **+133.72%** (strategy underperformed B&H by 128.5 pts over this window — expected for a lagging trend filter in a strong BTC uptrend period).
- Report/code artifacts saved to `scratchpad/ext/smoke_report.html` and `smoke_report.py`.

---

## 2. Repo B — `EstebanSP23/crypto_systematic_research` (Quattro strategy)

Pinned SHA: `5df0c43f6d48b7d8dbb74843d6747e5ddbb6819b`
Files read: top-level `README.md`, `2_strategies/01_quattro_donchian/README.md`, `2_strategies/01_quattro_donchian/backtest.py` (original/headline engine), `2_strategies/01_quattro_donchian/quattro_v2_engine.py` (parametrized v2, costs+funding). Not run.

### Exact parameters (file:line)

- Entry: `close > donch_high_20` (20-bar high, **excludes current bar** via `.shift(1)`) AND `regime_up` — `backtest.py:51` (calc), `:207` (condition).
- Regime filter as **actually coded**: `regime_up = close > daily_EMA200` (ffilled, shifted +1 day to avoid look-ahead) — `backtest.py:61-66`, same in `quattro_v2_engine.py:83-87`. **This contradicts both READMEs**, which describe the filter as "daily 200 EMA must be **rising**" (`2_strategies/01_quattro_donchian/README.md:17`) / "a daily 200 EMA **rising** filter" (top-level `README.md:203`). The code never checks EMA slope anywhere in `backtest.py` or `quattro_v2_engine.py` — it's a simple price-above-EMA regime gate, not a rising-EMA gate. Doc/code mismatch.
- Execution: fills at **next bar's open** — `entry_px = open_[i+1]` at `backtest.py:208`; Donchian exit similarly deferred to next open via `pending_exit` flag (`backtest.py:147-148, 198-202`).
- ATR: `N = ATR(14)` via Wilder-style EWM (`alpha=1/14`), computed once from the signal bar and **fixed for the whole trade** — `backtest.py:59` (calc), `:209` (fixed at entry).
- Pyramid: `MAX_UNITS=4`; new unit added when bar high crosses `original_entry + PYRAMID_STEP(0.5) * unit_index * N` → units 2/3/4 trigger at +0.5N/+1.0N/+1.5N — `backtest.py:76-77, 171-172`.
- Sizing: each unit risks `RISK_PCT=0.02` (2%) of account-at-original-entry, sized off a `2*N` stop distance — `backtest.py:73, 178-179, 214-215`.
- Trailing stop: common stop ratchets to `newest_unit_entry - 2*N`, never down — `backtest.py:186-189`.
- Hard catastrophe stop: total unrealized (wick-based) loss ≥ `HARD_STOP_PCT=0.05` (5%) of account-at-entry closes everything — `backtest.py:74, 153-163`.
- Leverage cap: `MAX_LEVERAGE=20` on combined notional — `backtest.py:78, 180-182, 216-218`.
- Warm-up: first `WARMUP=250` bars skipped — `backtest.py:79, 144`.
- Data: Binance BTC/USDT spot, 4h since 2022-01-01 + daily since 2021-01-01 for the EMA200 — `backtest.py:29-37`. v2 costs add `TAKER_FEE=0.0006` (0.06%) per fill plus real Binance BTC/USDT perpetual funding at 00/08/16 UTC settlements — `quattro_v2_engine.py:31`.

### Headline results / cost assumptions

- **Quattro is BTC-only** — README explicitly states "Single asset (BTC) — no multi-asset complexity" (`2_strategies/01_quattro_donchian/README.md:34`) and the top-level README's strategy table lists "Quattro (live) | BTC" (`README.md:132`). **There are no ETH/SOL headline numbers for Quattro** — the multi-asset (BTC/ETH/SOL/LINK/ADA/ARB/SUI/SEI) coverage in this repo belongs to a different, separate strategy called "Apex" (`README.md:133`), which was out of scope for this task and not read in depth.
- Quattro headline (no costs, `backtest.py`, matches top-level `README.md:9` and strategy `README.md:44-51`): Jan 2022 – May 2026, $1,839 → $22,196, **+1,107% total return, +83% APY, -37.5% max DD, 94 trades, 26.6% win rate**, avg winner +13.4R / avg loser -2.0R.
- With realistic costs (taker fee 0.06%/fill + Binance perpetual funding, `backtest_quattro_v2_costs.py` / v2 engine, same 94 trades): return falls to **+610%** (APY 78.5%→57.8%), max DD deepens to **-41.7%**, Calmar 2.09→1.39. Fees ≈$2,428 (15.4R) + funding ≈$2,154 (14.4R) (`2_strategies/01_quattro_donchian/README.md:182`). Slippage is explicitly **not modeled** anywhere in this repo.
- Later "Round 2/3" experiments (an ensemble of 20/10 + 55/20 Donchian speeds) were validated out-of-sample and accepted as an improvement over the v2 baseline on Calmar, but that is a variant, not the live-deployed Quattro spec (`README.md:184-249`).

---

## Summary of discrepancies found (doc vs. code)

1. **Repo A:** README/SKILL.md claim default exchange is `okx`; code default (CLI and function) is `binance`.
2. **Repo A:** Sharpe ratio annualization is hardcoded to a 4h-bar factor (`365*6`) regardless of the `--timeframe` flag — wrong Sharpe on any non-4h run.
3. **Repo A:** Slippage (0.05%) is hardcoded and not CLI-configurable/visible.
4. **Repo B:** Both READMEs describe the regime filter as "daily 200 EMA must be rising"; the actual code in `backtest.py` and `quattro_v2_engine.py` implements a simple `close > daily_EMA200` gate with no slope/rising check at all.
5. **Task premise:** Quattro has no BTC/ETH/SOL comparison — it is BTC-only; multi-asset results in that repo belong to a different strategy (Apex).
