# Other-repos verification — EditTrades edge-validation research

All repos shallow-cloned (`--depth 1`) into this directory on 2026-09-27. Read-only research; nothing outside this directory was modified.

| Repo | HEAD SHA (shallow) |
| --- | --- |
| nautechsystems/nautilus_trader | f73a6acb2d9dcdbad2c801fb8067646908558792 |
| ccxt/ccxt | 5f238fafbee5db47bd5a6a301b9aa0417996cf81 |
| hummingbot/hummingbot | 9af100d6822da7d2d0291a906c730ef172284ee2 |
| hummingbot/condor | d89e74f2e3e273bea102c64e4977118e6a88084f |
| hummingbot/gateway (not cloned; checked via `gh api search/code`, live default branch) | n/a — GitHub code search only |
| AI4Finance-Foundation/FinRL | adde5daf937701ffb476f65735de8ece0e494517 |
| AI4Finance-Foundation/FinRL-Trading | 4409abe925c904e570be78ebfb5e77ac3491dff8 |
| virattt/ai-hedge-fund | 5d2c7ca2d02c6501692a58bb363dfab1916890ba |
| elizaOS/eliza | not cloned (large monorepo); metadata + README via `gh api` |

---

## 1. nautechsystems/nautilus_trader (LGPL-3.0)

**Adaptive bar ordering (VERIFIED).** Config flag `bar_adaptive_high_low_ordering: bool` (`crates/execution/src/matching_engine/config.rs:31`, mirrored in `crates/backtest/src/exchange.rs:178`). Decision function:

```rust
// crates/execution/src/matching_engine/mod.rs:2281-2283
fn bar_high_first(&self, bar: &Bar) -> bool {
    !self.config.bar_adaptive_high_low_ordering || bar.high - bar.open < bar.open - bar.low
}
```

Synthetic-tick sequencing comment (`crates/execution/src/matching_engine/mod.rs:1994-1995`): "Determine high/low processing order. Default: O > H > L > C. With adaptive ordering, swap if low is closer to open." So default (flag off) is always Open→High→Low→Close; with the flag on, it picks whichever of H/L is numerically closer to the open price and assumes that one was touched first, then processes O→(H or L)→(the other)→C, feeding synthetic trade/quote ticks into an L1 order book for stop/limit matching (`process_bar_trade_tick`/`process_bar_quote_tick`, same file ~2068–2280).

**Fill probability / slippage model (VERIFIED).** `crates/execution/src/models/fill.rs:167-168` — `ProbabilisticFillState` holds `prob_fill_on_limit: f64` and `prob_slippage: f64` (validated to `[0,1]`, `fill.rs:184-192`); methods `is_limit_filled()` / `is_slipped()` (`fill.rs:198-203`) roll a seeded RNG against these probabilities. A `DefaultFillModel` and several variants wrap this state (`fill.rs:275`, `350`, `439`, `526`, `630`).

**Latency model (VERIFIED).** `crates/execution/src/models/latency.rs:26-35` — `LatencyModel` trait with `get_insert_latency`, `get_update_latency`, `get_delete_latency`, `get_base_latency`, all returning `DurationNanos`; doc comment: "Latency models simulate network delays for order operations during backtesting... static or dynamic (jittered) latency values."

**Usable as an outside validator without heavy setup (PARTIAL).** `pip install -U nautilus_trader --pre` installs prebuilt wheels — no Rust toolchain needed for normal use (`README.md:269`). But `python/pyproject.toml:25` pins `requires-python = ">=3.12,<3.15"` — narrow window, will reject older/newer interpreters. Beyond install, there is no one-liner backtest API: minimal example scripts that set up venue/instrument/strategy/data plumbing for a single bar-based EMA-cross backtest run ~100–104 lines (`examples/backtest/fx_ema_cross_audusd_ticks.py`, `crypto_ema_cross_ethusdt_trade_ticks.py`). So: cheap to install, moderate (not "heavy," not "trivial") to wire up for a simple 4H long/flat validator.

**Jupiter/Solana (FALSE — no support).** `grep -ril "jupiter\|solana"` across the repo returns nothing under `nautilus_trader/adapters/` or `ADAPTERS.md`. No Solana-related adapter exists.

**Hyperliquid adapter (VERIFIED).** `python/nautilus_trader/adapters/hyperliquid/` exists as a package; `ADAPTERS.md:92` lists "Hyperliquid | Data/Execution".

---

## 2. ccxt/ccxt (MIT)

**npm package with fetchOHLCV for binance/bybit/okx/hyperliquid (VERIFIED).** `package.json` name `ccxt`, v4.5.84. All four exchanges implement `fetchOHLCV`:
- `ts/src/binance.ts:5136`, `ts/src/bybit.ts:2819`, `ts/src/okx.ts:2713`, `ts/src/hyperliquid.ts:1505`.

**Jupiter/Solana DEX perps support (FALSE — not an exchange class).** No `jupiter.ts`/`solana*.ts` exchange file under `ts/src/`. ccxt only wraps centralized-style/API-based exchanges (incl. Hyperliquid's API); it does not implement a Jupiter Perps or generic Solana DEX connector.

**fetchFundingRateHistory (VERIFIED, all four).** `ts/src/binance.ts:10895`, `ts/src/bybit.ts:3078`, `ts/src/okx.ts:2821`, `ts/src/hyperliquid.ts:3065` all override `fetchFundingRateHistory(symbol, since, limit, params)`.

**Pagination limits for 4h history (VERIFIED, binance example).** `ts/src/binance.ts:5141-5158`: default `limit` 500, `maxLimit` 1000 per request (comment: "binance docs say... max 1500 for futures, max 1000 for spot... reality is that the time range wider than 500 candles won't work right"); ccxt exposes a built-in `paginate` option that calls `fetchPaginatedCallDeterministic(...)` to auto-loop past the per-call cap (`binance.ts:5142-5144`). So multi-month 4h history is retrievable but requires either manual `since` paging or the `paginate: true` param — not a single unbounded call.

---

## 3. hummingbot/hummingbot + hummingbot/condor

**Condor architecture (VERIFIED).** `condor/README.md`: "A Telegram bot for monitoring and trading with Hummingbot via the **Hummingbot API**." `condor/agents/README.md` (top of file) explicitly names the split: "**Deterministic layer (Python routines, providers, executors).** Pulls market data, computes indicators, fetches positions, runs the order lifecycle... **Reasoning layer (LLM tick).** Looks at the pre-computed snapshot... decides *what to do next*... The LLM does not place individual orders — it manipulates executors." This matches "agent → Hummingbot API → deterministic execution" almost exactly (agent reasons, deterministic Python executors + Hummingbot API do the mechanical order work).

**Jupiter connector in hummingbot (VERIFIED, via the separate Gateway repo, not hummingbot/hummingbot's Python code).** `hummingbot/hummingbot`'s own README lists Jupiter as a supported DEX router reached through Gateway: `README.md:183` "`[Jupiter](https://hummingbot.org/exchanges/gateway/jupiter/) | AMM DEX | Router | jupiter | -`", and `README.md:200` "[Gateway](https://github.com/hummingbot/gateway): Typescript based API client for DEX connectors." A `gh api search/code` search of `hummingbot/gateway` (not cloned locally) confirms the connector exists: `src/connectors/jupiter/jupiter.ts`, `jupiter.config.ts`, `router-routes/{quoteSwap,executeSwap,executeQuote}.ts`. `hummingbot/hummingbot` itself only has the generic `hummingbot/connector/gateway/` client that talks to this middleware — no Jupiter-specific code lives in the main repo.

**Relevance to a directional signal engine (one line):** Both are execution/automation stacks for placing and managing orders (grid/PMM/LP bots, or LLM-driven executor management) — useful only if/when EditTrades starts sending live orders through Jupiter via Gateway; neither adds anything to signal generation or backtest validation itself.

---

## 4. AI4Finance-Foundation/FinRL & FinRL-Trading

**README redirects new work to FinRL-Trading/FinRL-X (VERIFIED).** `FinRL/README.md:5` "# FinRL: Financial Reinforcement Learning → FinRL-X"; `:26` "**FinRL-X** is the next-generation evolution of FinRL, designed for AI-native, modular, and production-oriented quantitative trading."; `:29` "please use [`FinRL-X / FinRL-Trading`]..."; `:44` "**Recommended for new users:** Start with **[FinRL-X / FinRL-Trading]**..." (also lines 34, 43, 103, 117, 332, 336).

**Module pipeline + weight-vector contract (VERIFIED).** `FinRL-Trading/README.md:44`: pipeline is Selection (S) → Allocation (A) → Timing (T) → Risk overlay (R), "contract-preserving — you can swap any module... without touching the rest of the pipeline, and the same weights flow identically through backtesting and live execution." Line 109: "All methods output the same weight vector, making them directly composable with timing and risk overlays." Directory structure matches: `src/strategies/{universe_manager.py, fundamental_portfolio_drl.py, base_strategy.py, tsmomsignal.py, adaptive_rotation/}`, `src/backtest/backtest_engine.py`, `src/trading/{trade_executor.py, performance_analyzer.py}`.

**Walk-forward implemented (VERIFIED).** `src/strategies/adaptive_rotation/walk_forward.py:2-5` "Walk-Forward Analysis Framework... core walk-forward testing infrastructure for backtesting," with `WalkForwardPeriod` (line 34), `WalkForwardResult` (line 64), `WalkForwardAnalyzer` (line 135). Also referenced in `README.md:121` and `src/strategies/adaptive_rotation/__init__.py:5`.

---

## 5. virattt/ai-hedge-fund

**"Proof of concept / does not actually trade" (VERIFIED).** `README.md`: "This is a proof of concept for an AI-powered hedge fund. The goal of this project is to explore the use of AI to make trading decisions. This project is for **educational** purposes only and is not intended for real trading or investment." and, directly under the screenshot: "Note: the system does not actually make any trades."

**Backtest hides ticker/date identity from the LLM (VERIFIED — claim text and code both confirmed).** README states the mechanism: "An LLM trained after your backtest window may remember how those companies did, and that memory would score as skill. So a backtest withholds the ticker, industry and calendar dates from the investor agents' prompts; the personas see the fundamentals with periods labelled t-0, t-1, ... instead." Code path: `hedge_fund/features/snapshot.py:79` `def render(self, blind: bool = False) -> str:` — docstring (`:87-94`) "`blind=True` goes one step further, and is what backtests use: the ticker and industry are withheld (the sector stays) and the periods are labelled t-0 (latest), t-1, ... instead of report and filing [dates]... Live runs render unblinded." Implementation: `:97` `f"Company: {'(withheld)' if blind else self.ticker}"`; `:121` `when = f"t-{i}" if blind else f"{p.report_period} | {p.filing_date or '?'}"`. Wired into the LLM agent at `hedge_fund/signals/llm_agent.py:46,53,130` (`blind: bool = False` param → `self._blind` → `snapshot.render(blind=self._blind)`).

---

## 6. elizaOS/eliza

**One-liner (VERIFIED).** GitHub repo description: "Open source agentic operating system." README (`README.md`, top): "elizaOS is an open-source TypeScript framework and product stack for autonomous AI agents. This monorepo contains the core runtime, the Eliza app, the CLI, cloud services, native bridges, and first-party plugins." Not cloned locally (large monorepo); confirmed via `gh api repos/elizaOS/eliza` and `gh api repos/elizaOS/eliza/readme`.
