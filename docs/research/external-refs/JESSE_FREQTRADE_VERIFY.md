# Jesse / Freqtrade edge-validation verification

Clones (shallow, `--depth 1`):
- `jesse-ai/jesse` @ `840beb9cddddc35706adaba60557c1ba8e69b964` (2026-09-27) — MIT (`LICENSE:1-3`)
- `freqtrade/freqtrade` @ `d6c736fc1797b453b88e6370a556d6a7cafa0220` (2026-09-27) — GPL-3.0 (`LICENSE:1-4`)

No separate `jesse-ai/docs` repo was needed — the Jesse repo ships its own MCP resource docs (`jesse/mcp/resources/*.md`) and README, which are current and sufficient.

---

## A. jesse-ai/jesse

### A1. Rule Significance Test — VERIFIED, open-source core (MIT)

Location: `jesse/research/rule_significance_testing/{simulator.py,rule_significance.py,bootstrap.py,common.py}` (Research API), wrapped by `jesse/modes/significance_test_mode/{__init__.py,SignificanceTestRunner.py}` and exposed over MCP by `jesse/mcp/tools/significance_test.py` + `jesse/mcp/resources/significance_test.md`. All plain Python/numpy, no license gate inside the algorithm itself.

Exact method:
- **Phase 1 (signal collection)**: `run_signal_only_backtest()` (`simulator.py:41-90`) runs Jesse's real candle-replay engine with the real strategy class initialized, but skips all order submission/execution (`simulator.py:163-177`, note at 175-177: `order_service.update_active_orders()` / `execute_simulated_market_orders()` intentionally never called). At every completed bar of the route's own timeframe it calls the strategy's `_execute_for_signal_test()` (internally `should_long()`/`should_short()`) and records `+1/-1/0`. **What's randomized: nothing here** — this phase is deterministic, using the actual entries the rule would generate; direction/timing are not shuffled.
- **Detrending & rule return** (`rule_significance.py:156-189`): next-bar log return `log(close[t+1]/close[t])` is computed, the *cross-sample mean* log return is subtracted (detrending — removes market drift so a no-edge rule has E[return]=0), then `rule_return[t] = signal[t] * detrended_return[t+1]`. `observed_mean` = mean of that series.
- **Phase 2 (bootstrap null)** (`bootstrap.py:1-85`): a **stationary block bootstrap** (Politis–Romano style, geometric block-length, mean length = `bootstrap_mean_block_length`, default 10 bars) resamples the *rule's own centered return series* (`rule_returns - observed_mean`, i.e. the null-shifted series) `n_simulations` times (default 2000) and records each resample's mean (`bootstrap.py:32-67`). **What's randomized: contiguous-block resampling of the rule's own return series under the null**, not a separate "random-entry" strategy — it is a one-sample test of "is `observed_mean` too far above 0 to be explained by serial-correlation noise in this return series," not literally "rule entries vs. random entries." **What's held fixed:** the actual entry signal, exit/hold logic is irrelevant (only 1-bar-forward return is scored — there is no exit/TP/SL simulated at all), and the underlying detrended-return series itself (only its assignment to the mean is what's bootstrapped).
- **p-value**: `p_value = mean(simulated_means >= observed_mean)` (`rule_significance.py:222-224`) — a one-sided upper-tail bootstrap p-value, not a percentile-rank formula variant.
- **n_simulations**: default 2000, configurable; MCP resource doc explicitly recommends `2000+` (`jesse/mcp/resources/significance_test.md:41-43`).
- Interpretation thresholds documented: p<0.05 significant, 0.05–0.10 borderline, >0.10 no edge (`jesse/mcp/resources/significance_test.md:23-27`).
- **Paid/free nuance**: the algorithm and Research-API function are unrestricted open source. Only the *MCP tool* wrapper meters heavy runs per day for non-premium accounts (`jesse/mcp/usage_limits.py:1-40,69-76`: guests get 0 free runs/day by default, free-plan 100/day, premium unlimited — this is a soft, Redis-based, user-bypassable local meter, "fail-open" if the license backend is unreachable). Calling `rule_significance_test()` directly from a script/Jupyter has no such gate.

### A2. Monte Carlo — VERIFIED, both variants, open-source core (MIT)

- **Trade-order shuffle** — `jesse/research/monte_carlo/monte_carlo_trades.py`: runs one real backtest to get `original_trades` + `original_equity_curve` (`_run_original_backtest`, line ~220), then per scenario (`_ray_run_scenario_monte_carlo`, lines 98-131) does `random.shuffle(shuffled_trades)` on the **realized trade list only** (same trades, same PnL per trade) and reconstructs the equity curve / recomputes drawdown, Sharpe, Calmar, volatility from the new order (`_reconstruct_equity_curve_from_trades`, `_calculate_metrics_from_equity_curve` — same file). Default `num_scenarios=1000`. Confirms user's guess exactly: entry **timing/sequence** is what's randomized; each trade's own return/outcome is fixed.
- **Candle-based Monte Carlo** — `jesse/research/monte_carlo/monte_carlo_candles.py`: re-runs the **full backtest** (real strategy, real order logic) `num_scenarios` times against **perturbed synthetic 1-minute candles**, produced by a pluggable `candles_pipeline_class` (`jesse/candle_pipelines/`):
  - `GaussianNoiseCandlesPipeline` (`gaussian_noise.py`): adds i.i.d. Gaussian noise to close (as a cumulative random walk `cumsum`) and independent Gaussian jitter to high/low, then re-clamps OHLC ordering.
  - `GaussianResamplerCandlesPipeline` (`gaussian_resampler.py`): regenerates the close path as a Gaussian random walk whose per-step mean/std are estimated from the *historical* delta-close distribution (optionally auto-scaled from realized relative-return volatility), then rebuilds high/low from the historical high-close / close-low offset distributions.
  - `MovingBlockBootstrapCandlesPipeline` (`moving_block_bootstrap.py`): a genuine **moving-block bootstrap** over multivariate tuples of `(delta_close, delta_high, delta_low)`, block length derived from batch size (`max(10, batch_size // 10)`).
  So: yes to both noise-injection and block-bootstrap synthetic-candle generation, selectable per run.

### A3. Look-ahead protection in multi-timeframe engine — VERIFIED

- Higher-timeframe candles are built bottom-up from 1-minute data only, via an explicit **event-driven replay plan**: `_build_timestamp_replay_plan()` (`jesse/modes/backtest_mode.py:632-671`) merges all 1m streams and schedules "aggregate" events only at the index where enough 1m rows have actually arrived to complete a higher-timeframe bucket (`_timestamp_bucket_generation_schedule`); a route's `should_long()`/`should_short()` only fire on its own timeframe's close event.
- The still-open ("forming") higher-timeframe bar, when exposed to a strategy via `self.get_candles(...)`, is synthesized purely from the 1-minute rows already observed up to the simulated clock (`generate_candle_from_observed_minutes` / `_get_timestamp_bucket_candles`, `jesse/services/candle_service.py:46-58,779-816`) — so it can never contain future 1m data. In live mode the non-timestamp-bucket code path deliberately *omits* the forming bar and returns only completed candles (`candle_service.py:764-776`).
- Explicitly documented: "a higher-timeframe candle's close is never future data" and the strategy's `self.price`/`self.close` is "the closing price of the current (already closed) candle — lookahead bias is handled internally" (`jesse/mcp/resources/backtest_management.md:416-420`, `jesse/mcp/resources/strategy.md:96`).

### A4. Research API / ML feature-label pipeline / MCP server — VERIFIED, open-source (MIT)

- Research API: `jesse/research/{backtest.py,candles.py,ml.py,monte_carlo/,optimize/,rule_significance_testing/}` — all plain importable Python, no license check found in any of these modules (grepped for `license`/`JESSE_API_URL`, zero hits outside `jesse/mcp/usage_limits.py`).
- ML pipeline: `jesse/research/ml.py` — `gather_ml_data()` (line 52) extracts feature/label rows from backtests, `train_model()` (line 141) trains a model, plus feature-importance (`_compute_feature_importance`, 690), calibration (`_compute_calibration`, 762), threshold sweep (`_print_threshold_sweep`, 968), binary/multiclass/regression metrics helpers.
- MCP server: `jesse/mcp/server.py` + `jesse/mcp/tools/*` (backtest, candles, config, credentials, indicator, monte_carlo, optimization, significance_test, strategy, general) + Markdown resources under `jesse/mcp/resources/`. README confirms: "Jesse includes a local MCP server... Connect Claude, Codex, Cursor..." (`README.md:46,104-118`). Same free/premium daily-credit metering as A1 applies to the *MCP tool wrappers* for backtest/optimize/monte-carlo/significance-test only (`jesse/mcp/usage_limits.py`); the underlying code and direct Research-API calls are unrestricted.

### A5. Fill model — VERIFIED

- **Market orders** fill at `self.position.current_price`, which is `self.price` = "the current trading candle's current (close) price" (`jesse/strategies/Strategy.py:1478-1490`); the broker passes this straight through as the execution price (`jesse/services/broker.py:28-65`, `sell_at_market`/`buy_at_market` call `self.api.market_order(..., self.position.current_price, ...)`). I.e. market fills happen at the just-closed decision-bar's close, not next-bar open.
- **Resting limit/stop orders**: filled when `low <= order.price <= high` for the candle (`jesse/modes/backtest_mode.py:1579-1593` `_get_opening_gap_and_executing_orders`), with two refinements:
  1. **Opening-gap handling**: if the next bar's open jumps past a resting order's price without the previous close having crossed it, the order fills at the open price of that bar (`_execute_opening_gap_orders`, `backtest_mode.py:1517-1566`), and multiple gap-crossed orders are executed in price order matching the gap direction (`_get_opening_gap_orders`, `1492-1514`).
  2. **Intrabar ordering when >1 order (e.g. stop AND take-profit) both fall inside one candle's [low, high]**: `_sort_execution_orders()` (`backtest_mode.py:2265-2301`) first tries to disambiguate using **shorter-timeframe sub-candles** (drilling down toward 1-minute resolution) and only falls back to a same-bar heuristic when several orders sit inside one indivisible short candle: if that candle is red (open>close) it assumes price went **up then down** (orders above open execute in ascending order, then below-open orders in descending order); if green, **down then up** (mirror). This is the explicit answer to "intrabar stop/TP ordering" — Jesse uses real sub-timeframe candles where available, and a documented open/high/low-based path heuristic only as last resort, rather than a fixed "stop always wins" rule.

---

## B. freqtrade/freqtrade

### B1. `lookahead-analysis` — VERIFIED

Docs: `docs/lookahead-analysis.md`. Code: `freqtrade/optimize/analysis/{lookahead.py,lookahead_helpers.py}`.

Exact algorithm (`lookahead.py`):
1. Run one full-range backtest per strategy to get a baseline trade list + baseline indicator dataframe (`fill_full_varholder`, referenced `lookahead.py:203-204`).
2. For each closed trade (up to `targeted_trade_amount`, default in table shows `total_signals` default 20; skips forced-exits), build two **truncated** re-runs on a single-pair whitelist: an "entry" run whose data window ends exactly 1 candle after that trade's `open_date`, and an "exit" run ending 1 candle after `close_date` (`fill_entry_and_exit_varHolders`, `lookahead.py:139-160`).
3. **Signal check**: `report_signal()` (`lookahead.py:53-63`) checks whether the truncated run's result table still contains a trade opening/closing at the *exact same timestamp* as the baseline. If not → biased entry/exit.
4. **Indicator check**: `analyze_indicators()` (`lookahead.py:66-95`) slices the baseline indicator dataframe down to the truncated run's index range and does `full_df.loc[cut_df.index].compare(cut_df)` — any column whose value differs between the full-history and truncated computation at that shared index is reported as a biased indicator.
5. Forces `--cache none`, `max_open_trades >= #pairs`, huge dry-run wallet, static 10k stake, protections off, and market orders only (unless `--lookahead-allow-limit-orders`) to avoid confounds (`docs/lookahead-analysis.md:18-27`).

Inputs: strategy + timerange + historic OHLCV. Outputs: per-strategy table (`has_bias`, `total_signals`, `biased_entry_signals`, `biased_exit_signals`, `biased_indicators`). Stated limitations (`docs/lookahead-analysis.md:98-115`): only verifies signals that actually triggered (untriggered signal types → false negative); assumes single-pair backtest behaves like full-pairlist backtest (methods using `len(current_whitelist())` or cross-pair ranking → false positives); limit orders + custom entry/exit price callbacks can cause false positives (hence market-order forcing); FreqAI target indicators are always flagged but are known-safe false positives.

### B2. `recursive-analysis` — VERIFIED

Docs: `docs/recursive-analysis.md`. Code: `freqtrade/optimize/analysis/recursive.py`.

Exact algorithm: compute indicators once as a benchmark on a long timerange, then recompute indicators (only `populate_indicators` + `@informative` — NOT `populate_entry/exit_trend`) using progressively shorter warm-up windows via a swept `startup_candle_count` list, default `[199, 399, 499, 999, 1999]` plus the strategy's own configured value inserted and sorted (`recursive.py:31-32,158-169`). Compares each indicator's value at the **last row only** across all sweep points vs. the benchmark and reports % variance in a table; `nan%` = insufficient data, `-` = zero variance. Also runs a lookahead check on indicator values only as a byproduct (full lookahead check still needs `lookahead-analysis`). Limitation stated: only checks the last-row value, doesn't verify actual entry/exit impact; goal is "low enough variance," not zero, since recursive indicators (EMA etc.) inherently never fully converge (`docs/recursive-analysis.md:70-74`).

### B3. Backtest fill semantics — VERIFIED

Documented exhaustively at `docs/backtesting.md` (section "Assumptions made by backtesting", ~lines 553-575):
- "Entries happen at open-price unless a custom price logic has been specified."
- "All orders are filled at the requested price (no slippage) as long as the price is within the candle's high/low range."
- "Exit-signal exits happen at open-price of the consecutive candle."
- ROI: intrabar exits compared against candle high but capped at the configured ROI value; force-exits from negative ROI entries use low.
- "Stoploss exits happen exactly at stoploss price, even if low was lower, but the loss will be `2 * fees` higher."
- **"Stoploss is evaluated before ROI within one candle."** ("Low happens before high for stoploss, protecting capital first.")
- Trailing stoploss: high adjusts the stop first, then low is checked against the adjusted stop; ROI is applied before trailing-stop.
- **Same-candle evaluation order given explicitly**: Exit-signal → Stoploss → ROI → Trailing stoploss.

### B4. Other edge-validation-relevant tooling — VERIFIED

- `backtesting-analysis` command (`docs/advanced-backtesting.md`, `docs/commands/backtesting-analysis.md`) — requires backtest run with `--export=signals`; then `--analysis-groups 0..5` breaks profit/winrate down by enter-tag/exit-tag/pair combinations, `--indicator-list` dumps signal-candle indicator values per trade. Useful for post-hoc "which sub-rule is actually carrying the edge" analysis.
- Protections (`docs/includes/protections.md`): `StoplossGuard`, `MaxDrawdown`, `LowProfitPairs`, `CooldownPeriod` — runtime circuit breakers usable in backtest too (`--enable-protections`), not edge-significance tests per se but relevant risk-control patterns (e.g. StoplossGuard = "N stoplosses within lookback window → pause trading M candles").

---

## Cheapest ideas to port into the Node harness

**From Jesse (rule significance test, A1)**: One-sample stationary-bootstrap significance test on the strategy's own next-bar rule-return series. (1) For each closed candle where the strategy would have entered, compute `signal[t] ∈ {+1,-1,0}` and `return[t+1] = log(close[t+1]/close[t])`. (2) Detrend by subtracting the sample mean return. (3) `rule_return[t] = signal[t] * detrended_return[t+1]`, `observed_mean = mean(rule_return)`. (4) Stationary-bootstrap resample `rule_return - observed_mean` ~2000 times with geometric block length ~10 (restart with prob 1/10, else advance+wrap) and take each resample's mean. (5) `p = fraction(resampled_means >= observed_mean)`. No backtest exits/PnL needed — just entries vs. next-bar return, cheap to compute in plain JS/Node with an RNG and a returns array.

**From Freqtrade (lookahead-analysis, B1)**: Detect look-ahead by re-running the signal computation on a *truncated* candle series ending exactly 1 bar after each historical signal, and diffing against the full-history computation. (1) Run indicators/signals once over full history, record every entry timestamp. (2) For a sample of those timestamps, recompute indicators/signals using only candles up to `timestamp + 1 bar`. (3) Compare: does the truncated run still emit the identical signal at the identical timestamp, and do the indicator values at that timestamp match bit-for-bit? (4) Any mismatch = a formula referencing data not yet available at decision time (e.g., unguarded `rolling`/global aggregate/off-by-one shift). Cheap because it reuses the existing indicator/signal functions with a shorter input array — no separate simulator needed.
