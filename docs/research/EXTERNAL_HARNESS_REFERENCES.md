# External harness references — reviewed build bucket

Status: **research review, 2026-09-27. Nothing here is approved for implementation.**
Branch `edge-external-4h-sma200`, application base `bd01c2f`.

## Read this first (instructions to any agent picking this up)

1. **Double-check before considering anything for implementation.** Every claim below was verified by reading source at the pinned SHA (evidence files in [external-refs/](./external-refs/)), but no external tool was run except the `0xrikt/crypto-skills` smoke test. Re-open the cited file:line at the pinned SHA, confirm the behaviour, and record "re-verified by <agent>, <date>" next to the item. If upstream has moved, re-pin and note the diff.
2. **Borrow ideas, not platforms.** EditTrades is not being rebuilt. Each item is a small addition to the existing Node research harness (`scripts/research/`, `scripts/swing/`, `test-*.js`) that fills a gap we have. No framework swaps.
3. **Licences:** Freqtrade is GPL-3.0 and Nautilus is LGPL-3.0. Use them only as external tools and reimplement the concept in our own code; never copy code into the repo. Jesse, CCXT, Condor, ai-hedge-fund and Eliza are MIT, and Hummingbot and FinRL-Trading are Apache-2.0, but still prefer reimplementation over vendoring.
4. **Hard constraints that still apply:**
   - Research paths only; no changes to `api/`, `lib/`, `services/` or the live engine.
   - Engine rules are frozen until 2026-10-08.
   - No deploys, no trades, no alerts, no `.env` reads.
   - No new npm dependency without explicit owner approval (affects R5).
   - Follow `CLAUDE.md` and `docs/AGENT_SESSION_RULES.md`.
5. **Fit with the planned harness:** every approved item maps to a section of the planned edge-v1 harness spec (`~/Documents/ChatGPT/EditTrades/EDGE_HARNESS_SPEC_2026-09-27.md`). Build them as parts of that harness, not as a parallel system.
6. **Execution venue is Jupiter Perps (Solana)**, with hourly borrow and no order book. Neither Nautilus nor CCXT supports Jupiter, and no reviewed tool models Jupiter borrow. Any Hyperliquid-specific benefit in the source proposal does not apply unless the venue changes.

## Goal of this bucket

The aim is more accurate trade signals and a real, provable edge, reached through validation that catches false edges early.
Concretely:
- Prove each signal is causal (no look-ahead).
- Make sure live indicator values match research values.
- Measure whether a rule's signal is better than chance.
- Stress-test drawdowns.
- Confirm results do not depend on one data vendor.

---

## Corrections to the source proposal

The proposal that triggered this review contained claims that do not hold. The orchestrator must not plan from the original wording.

| # | Proposal said | Verified reality | Impact |
| --- | --- | --- | --- |
| C1 | Jesse's rule significance test compares rule entries against a bootstrap of **random entries** (“percentile vs random 96.8%”). | It is a **one-sample stationary block bootstrap of the rule's own centred returns**: `signal[t] × detrended next-bar log return`, 2000 resamples, geometric blocks with mean length 10, `p = share of resampled means ≥ observed mean`. No random entries. (`jesse/research/rule_significance_testing/{simulator,rule_significance,bootstrap}.py` @ `840beb9`) | Still useful, but it tests something different: per-bar directional information, not exits or costs. Our existing random controls remain a separate null. See R3. |
| C2 | Use Jesse as an independent validator (“EditTrades 1.08 vs Jesse 1.05”). | Jesse fills market orders at the **current candle's close** (`Strategy.py`, `broker.py`), not the next open. By default it will disagree with our next-open semantics. The 1.08/1.05/1.07 figures were illustrative, not measured. | Freqtrade (entry at next open, per `docs/backtesting.md` “Assumptions”) is the closer second implementation. See R6. |
| C3 | Jesse significance and Monte Carlo are exposed through MCP. | True, but the MCP wrapper is metered (free 100 runs/day, guest 0) in `jesse/mcp/usage_limits.py`. Direct Research-API calls are not gated. | Don't design around Jesse MCP. |
| C4 | CCXT and Nautilus are data/execution layers for our venue. | Neither supports Jupiter or any Solana perps. Nautilus has 18 adapters, none on Solana. CCXT has no Jupiter class. | CCXT is only useful for cross-venue **price and funding reference** data (R5). Nautilus only matters for concepts (R8). |
| C5 | A “Hyperliquid AI agent repo” provides a prediction ledger and forward scoring. | That repo was not identified or supplied, so it is unverified. EditTrades already has `scripts/paper-ledger.js` and tracker `score.js`, `calibration.js`, `shadow.js`, `v3-shadow.js` and `walk-outcome.js`. | The ledger stage of the proposed pipeline mostly exists. Only drift detection is possibly missing (R10, verify first). |
| C6 | Proposal named `freqtrade/freq` and `AI4Finance-Foundation/FinRL`. | Correct repos are `freqtrade/freqtrade` and, for new work, `AI4Finance-Foundation/FinRL-Trading` (the FinRL README redirects there). | Naming only. |

---

## What EditTrades already has (so we don't rebuild it)

| Capability | Where | Gap vs external |
| --- | --- | --- |
| Seeded random-direction controls | `scripts/swing/rules/ctl-random-4h.js`, `re-random-4h.js`, `test-swing-rules-controls.js` | Randomizes direction at every 4h close with the same stop/TP. It is not a returns-bootstrap significance test (R3), and timing is not matched to opportunities. |
| Bootstrap Monte Carlo of trade R | `scripts/research/risk-sim.js` (resample with replacement) | No shuffle mode (fixed trade set, reordered). Not wired to arbitrary `trades.jsonl` outputs (R4). |
| Look-ahead tests | Per-module, hand-written: `test-sma4h-trend.js`, `test-replay*.js`, `test-swing-rules*.js`, `test-flag-paths.js` | No **generic** auditor that runs every rule module through the same truncation check (R1). |
| Indicator warm-up handling | Research: first N bars excluded. Live: `services/marketData.js:769`, default `limit=500` | Nothing measures how much live EMA/RSI/ATR values depend on the history window vs research values (R2). |
| Forward paper ledger and scoring | `scripts/paper-ledger.js`, `scripts/tracker/{score,calibration,shadow,v3-shadow,walk-outcome}.js` | Exists. Drift detection unverified (R10). |
| Same-bar ambiguity rule | Harness spec §3: conservative stop-first | No second, optimistic-but-reasonable bound to bracket the result (R8). |
| Walk-forward / purging | Specified in the harness spec §6, not built | Reference only (R9). |

---

## Prioritized bucket (ease × effectiveness)

Size: S ≈ ≤ 1 day, M ≈ 2–3 days, L ≈ a week or more. Order is by value per effort for **signal accuracy and edge proof, now**.

### R1 — Generic causality auditor (Freqtrade `lookahead-analysis` concept) · S · HIGH · APPROVE for build consideration

- **Source:** `freqtrade/freqtrade` @ `d6c736f` (GPL-3.0; concept only). Behaviour per the evidence file: rerun the backtest on data truncated to signal time plus one candle; flag bias if the same trade isn't reproduced at the same timestamps, or if any indicator value differs between the full and truncated frames. Stated limits: signal types that never trigger give false negatives; FreqAI targets are always flagged.
- **Our version:** `scripts/research/harness/causality-audit.js` plus `test-causality-audit.js`.
  - For every rule module in `scripts/swing/rules/*.js` (`signalAt(ctx)`), and for `runSma4h`, sample K decision points: all signals plus an equal number of random non-signals.
  - At each point, recompute from bars sliced to `[0..i]` (and to the HTF bars closed by then) and compare the signal and feature values with the full-history run.
  - Any mismatch fails the audit, which prints the module, timestamp and field.
- **Why:** one tool covers every existing and future rule, replacing ad-hoc per-module tests. Look-ahead is the most common way backtests invent an edge.
- **Harness fit:** spec §8 (“appending future bars leaves past signals unchanged”).
- **Acceptance:** passes on all current swing rules and SMA200; catches a deliberately injected look-ahead (`close[i+1]`) in a fixture rule.
- **Double-check:** confirm the rule-module contract (`meta`, `signalAt(ctx)`, `ctx.i`) in `scripts/swing/run.js` before building.

### R2 — Indicator warm-up sensitivity (Freqtrade `recursive-analysis` concept) · S · HIGH · APPROVE for build consideration

- **Source:** Freqtrade sweeps the startup-candle count over {199, 399, 499, 999, 1999}, recomputes indicators only, and reports % variance of the last value against a long-history benchmark.
- **Our version:** `scripts/research/harness/warmup-audit.js`.
  - For the indicators the live engine uses (`services/indicators.js`: EMA21/EMA200, RSI, Stoch RSI, ATR, …), compute the value at T using the last {200, 300, 500, 1000, 2000} bars.
  - Compare against the full-history value and report the % gap per indicator and timeframe.
- **Why:** this directly improves **live signal accuracy**. The live engine fetches `limit=500` by default (`services/marketData.js:769`), while research uses years of history. A recursive indicator such as EMA200 seeded on 500 bars can differ from the research value, so live signals and researched signals may not be the same signal. The size of any gap is unmeasured.
- **Output:** a table of indicator × timeframe × window → max/median % gap and whether the sign of `close − EMA` flips. If the gap matters, the fix (raise the fetch limit or seed differently) is a later, separate, post-freeze proposal. This item only measures.
- **Acceptance:** runs read-only on local fixtures; no live calls required.
- **Double-check:** confirm the actual per-timeframe `limit` values used on the live `/api/scalp-context` path (not just the default) and which indicators are recursive.

### R3 — Rule significance test (Jesse method) · S–M · HIGH · APPROVE for build consideration

- **Source:** `jesse-ai/jesse` @ `840beb9` (MIT), `jesse/research/rule_significance_testing/`. The method is described in C1.
- **Our version:** `scripts/research/harness/significance.js`, a pure function plus a CLI.
  - Input: a per-bar signal series (+1 long / −1 short / 0 flat) and bars.
  - Output: observed mean of `signal × detrended next-bar return`, the bootstrap distribution (stationary block bootstrap, seeded, 2000 resamples, mean block length registered in advance and tested for sensitivity at 5/10/20), p-value and percentile.
  - Apply to: SMA200 (Card 1), each swing rule's entry series, and the random controls. Controls should come out insignificant, which sanity-checks the test.
- **Why:** it separates “the signal carries information” from “the backtest's exits and costs happened to work”. It is cheap because it needs no PnL simulation.
- **Limits:** it does not test exits, costs or sizing, and detrending removes drift, so a long-only rule gets no credit for simply being long in a bull market. That is the intent. Report it alongside, not instead of, net results and the existing random-direction controls.
- **Harness fit:** spec §6 (controls and statistical checks).
- **Acceptance:**
  - Seeded determinism.
  - A random ±1 series gives p ≈ uniform over 100 seeds.
  - A synthetic series with injected edge gives p < 0.01.
  - Output matches a hand-computed tiny case.
- **Double-check:** re-read Jesse's `bootstrap.py` for the block-length distribution and whether the null centres on zero (it detrends by subtracting the sample mean). Replicate that exactly first, then document any deviation.

### R4 — Trade-order Monte Carlo on any trades file · S · MEDIUM · APPROVE for build consideration

- **Source:** Jesse `monte_carlo_trades.py` (shuffles the realized trade order and rebuilds the equity curve). We already have resampling in `risk-sim.js`.
- **Our version:** add a `--shuffle` mode and a `--trades <trades.jsonl>` input to `scripts/research/risk-sim.js`. The input is any study's trade list (SMA200, swing, flags) with net return per trade. Report the p5/p50/p95 max drawdown, longest losing streak and time underwater.
- **Why:** SMA200's 13% win rate with long losing strings makes the path drawdown the real risk. One historical path understates it.
- **Double-check:** `risk-sim.js` input modes and R-vs-% units; shuffling % returns compounds differently from R, so state which.

### R5 — Cross-venue data check (CCXT) · M · MEDIUM-HIGH · APPROVE, pending dependency approval

- **Source:** `ccxt/ccxt` @ `5f238fa` (MIT, npm `ccxt` v4.5.84). `fetchOHLCV` and `fetchFundingRateHistory` are verified for binance, bybit, okx and hyperliquid. `paginate: true` loops automatically; binance caps at 1000 rows per call.
- **Our version:** `scripts/research/edge/fetch-venue.js` pulls 4h/1d OHLCV for BTC/ETH/SOL from Bybit and OKX into `var/edge/venues/<venue>/`. Rerun SMA200 and the top swing rules on each venue, and diff the candles against Binance (close gap %, missing bars).
- **Why:**
  - It checks that a result isn't produced by one vendor's data.
  - It works around the Binance main-API geo-block on this machine (HTTP 451).
  - Funding history gives a **reference** band for the perp-cost sensitivity. It is labelled as CEX funding, not Jupiter borrow, which is a different mechanism.
- **Option without the dependency:** call the Bybit/OKX public kline REST endpoints directly, as `capture-binance-1m.js` does. Prefer this if the owner declines the npm dependency.
- **Double-check:** each venue's history depth (OKX and Bybit may start later than 2017) and symbol mapping (e.g. `SOL/USDT` spot vs `SOL/USDT:USDT` perp).

### R6 — Independent second implementation for finalists (Freqtrade) · M · MEDIUM · APPROVE for finalists only

- **Source:** Freqtrade enters at the next candle's open and evaluates exit signals at the next open, which matches our convention. Run it as an external tool in a scratch Python venv, never installed into the repo.
- **Scope:** only for strategies classified PAPER CANDIDATE, currently SMA200. Write a ~30-line Freqtrade strategy for `close > sma(200)` on 4h, with the same data window and 0.15%-per-side fees, and compare CAGR, maxDD, trade count and entry timestamps. Mismatches must be explained (warm-up, fee model, dataset).
- **Why:** it independently confirms our harness isn't manufacturing the edge. Our Python recompute (Card 1) was same-author; this one is not.
- **Jesse** is an optional third implementation. It needs its fill-at-close convention accounted for (C2).
- **Double-check:** Freqtrade can ingest our Binance data, or download its own, and the `startup_candle_count` handling matches our 200-bar warm-up exclusion.

### R7 — Candle Monte Carlo (moving-block bootstrap of price paths) · M · MEDIUM · PARK until R3 exists

- **Source:** Jesse `monte_carlo_candles.py` and `jesse/candle_pipelines/`: a genuine moving-block bootstrap of (Δclose, Δhigh, Δlow) tuples. Gaussian noise and resampler variants also exist.
- **Our version:** generate N synthetic 4h paths by block-resampling log-return tuples, rerun a frozen strategy, and report the distribution of CAGR and maxDD.
- **Why:** it shows whether a trend rule's result depends on the one realized history. It is useful but second-order to R1–R4.
- **Double-check:** block length vs trend persistence. Short blocks destroy trends by construction and bias trend-following rules toward failure, so register the block length and show sensitivity.

### R8 — Adaptive same-bar ordering as a second bound (Nautilus concept) · S · MEDIUM · APPROVE for build consideration (when stop/TP strategies are replayed)

- **Source:** `nautechsystems/nautilus_trader` @ `f73a6ac`, `bar_adaptive_high_low_ordering`: whichever of the high and low is closer to the open is assumed to have traded first. The docs call it “a deterministic heuristic, not a reconstruction” (`docs/concepts/backtesting/bar-execution.md:57-67`).
- **Our version:** in the replay path for stop/TP strategies (swing, flags), add a mode that resolves same-bar stop+TP by adaptive ordering. Report it next to the conservative stop-first result as an upper/lower bracket, which the harness spec §3 already asks for.
- **Why:** it puts a bound on how much the same-bar ambiguity moves expectancy. If the bracket is wide, 1m paths are required.
- **Not:** adopting Nautilus itself (no Jupiter adapter; multi-day integration).

### R9 — Walk-forward reference (FinRL-X) · reference only

- `AI4Finance-Foundation/FinRL-Trading` @ `4409abe`, `src/strategies/adaptive_rotation/walk_forward.py` (`WalkForwardPeriod`, `WalkForwardAnalyzer`). It is scoped to one strategy and equities-oriented. Use it as a pattern reference when building harness spec §6 folds. No separate item.

### R10 — Drift detection on the forward ledger · S · verify first

- The tracker already scores forward outcomes. **Verify** whether any rolling check compares live hit rate/expectancy against the research baseline (e.g. a CUSUM or rolling-window z-score) in `scripts/tracker/calibration.js` or `aggregate.js`. If absent, a small alert-free report is the item.
- Needed once a paper arm (Card 1 item 1.3) is running.

---

## Not recommended now (reviewed, rejected for immediate impact)

| Repo | Pinned | Why not now |
| --- | --- | --- |
| `jesse-ai/jesse` as a platform | `840beb9` | Its methods are borrowed in R3/R4/R7. Migrating strategies or running its MCP (metered) adds nothing our harness can't. |
| `nautechsystems/nautilus_trader` adoption | `f73a6ac` | No Solana/Jupiter adapter; 100–300 lines per strategy; Python ≥ 3.12 with a Rust core. Revisit only for a finalist moving toward size, and only if the venue has an adapter. |
| `hummingbot/hummingbot`, `hummingbot/condor` | `9af100d`, `d89e74f` | Execution and market-making tooling. Jupiter lives in the separate `hummingbot/gateway`. Condor's split between LLM reasoning and deterministic execution is a sound pattern, but execution is outside this bucket. Hold for future non-directional strategy families (carry, market making). |
| `AI4Finance-Foundation/FinRL`, `FinRL-Trading` | `adde5da`, `4409abe` | Equities and RL allocation stack. Pattern reference only (R9). |
| `virattt/ai-hedge-fund` | `5d2c7ca` | README says “proof of concept… does not actually make trades”. One reusable idea: if EditTrades ever backtests **LLM reasoning** over history, hide the ticker and dates from the model (`hedge_fund/features/snapshot.py:79-121`) to stop training-data recall. Note it; don't build it. |
| `elizaOS/eliza` | not cloned | General agent framework; no effect on signal validation. |
| Freqtrade Protections / FreqAI | `d6c736f` | Protections (StoplossGuard, MaxDrawdown, Cooldown) overlap `PLAN_RISK_GUARDRAILS_2026-09-27.md` G1. FreqAI is out of scope. |

---

## Suggested rollout order (for the orchestrator to confirm)

The order is based on dependencies. Each phase is a separate approval and a separate thread.

1. **Phase H1 (S+S):** R1 causality auditor and R2 warm-up audit. They are pure research code with no dependencies and could reveal existing bugs, so they are highest value. R2's result decides whether a live-accuracy fix proposal is needed after 2026-10-08.
2. **Phase H2 (S–M + S):** R3 significance test and R4 trade shuffle. Run both on SMA200 and all existing swing rules, and record the results on each backlog card.
3. **Phase H3 (M):** R5 cross-venue data. Needs the dependency decision first; the direct-REST fallback needs none.
4. **Phase H4 (M, finalists only):** R6 Freqtrade cross-check of SMA200.
5. **Later:** R8 when stop/TP strategies are replayed again, R7 after R3, R10 when a paper arm starts.

Per phase: implement in a worktree off the latest `main`, stage files by name, run the phase tests, run `git diff --check`, commit, and don't push unless told. Update this doc's item status and [RESEARCH_BACKLOG.md](./RESEARCH_BACKLOG.md).

## Evidence

- [external-refs/JESSE_FREQTRADE_VERIFY.md](./external-refs/JESSE_FREQTRADE_VERIFY.md): Jesse @ `840beb9cddddc35706adaba60557c1ba8e69b964`, Freqtrade @ `d6c736fc1797b453b88e6370a556d6a7cafa0220`
- [external-refs/OTHER_REPOS_VERIFY.md](./external-refs/OTHER_REPOS_VERIFY.md): Nautilus, CCXT, Hummingbot, Condor, FinRL, FinRL-Trading, ai-hedge-fund, Eliza (SHAs inside)
- [external-refs/EXTERNAL_SEMANTICS.md](./external-refs/EXTERNAL_SEMANTICS.md): `0xrikt/crypto-skills` @ `360c5e2` and Quattro @ `5df0c43`
- Repo metadata checked 2026-09-27 via `gh api`. All ten repos exist, are active (pushed within the last week) and are not archived. Licences are as stated above.

Verified by read-only source inspection (Sonnet subagents, orchestrator spot review). Treat every item as **needs re-verification before implementation**.
