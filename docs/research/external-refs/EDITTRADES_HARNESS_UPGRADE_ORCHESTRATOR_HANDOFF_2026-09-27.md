# EditTrades Harness Upgrade
## Master Research Handoff + Orchestrator Implementation-Planning Brief

**Date:** 2026-09-27  
**Status:** Research handoff. **No implementation authorization is implied by this document.**  
**Primary objective:** Improve the evidence quality, calibration, and forward accuracy of EditTrades trade signals by adding a small number of proven research/observability capabilities that the current system appears to lack or only partially implements.  
**Operating constraint:** **Do not rebuild EditTrades. Do not replace the current signal engine. Do not replatform the application.** Add only narrowly scoped capabilities that can produce immediate research or signal-quality value inside the existing system.

---

# 0. Executive directive to the orchestrator

You are receiving this document as a **research and planning handoff**.

Your job is **not to implement these recommendations immediately**.

Your job is to:

1. Independently inspect the current EditTrades repository and research packet.
2. Independently inspect every external repository referenced in this document.
3. Pin exact source commit SHAs for all evidence you rely on.
4. Verify the behavior described here against actual source code, not README claims alone.
5. Verify licenses before copying or adapting any source code.
6. Determine which capabilities EditTrades already has, partially has, or lacks.
7. Reject anything that is redundant, incompatible, too invasive, statistically weak, or not directly useful to signal accuracy / edge validation.
8. Produce a **final rollout plan** ordered by:
   - expected impact on signal quality / research validity;
   - implementation simplicity;
   - dependency order;
   - operational risk;
   - runtime cost;
   - reversibility.
9. Do not treat any recommendation in this document as approved until you independently confirm it is actionable.
10. Do not implement anything merely because another repository contains it.

The central requirement is:

> **Double-check everything before considering implementation.**

This document contains **candidate improvements and source observations**, not authoritative specifications.

A recommendation should survive only if it is:
- useful inside the existing EditTrades architecture;
- additive rather than duplicative;
- testable;
- reversible;
- causally correct;
- compatible with closed-candle research;
- likely to increase signal reliability, edge detection, or forward validation quality.

---

# 1. What we are trying to accomplish

EditTrades already has substantial signal-generation logic.

The next problem is not simply:

> “Add more indicators.”

The immediate problem is:

> **How do we know which signals actually have edge, which parts of the signal are contributing, which signals are being missed, which probability estimates are calibrated, and whether research performance survives forward paper/live observation?**

The near-term goal is to make EditTrades better at answering:

- Did this setup historically outperform comparable random opportunities?
- Did it remain robust when the historical path changed?
- Was the signal generated without lookahead or unfinished-candle contamination?
- What happened after every signal, including WAIT / DO NOT ENTER calls?
- Are 70% signals actually performing better than 55% signals?
- Which advisor / strategy component adds independent information?
- Are missed trades or false positives concentrated in identifiable conditions?
- Is a historically successful strategy drifting in forward paper observations?
- Does an external validator reproduce the same backtest?
- Are we measuring actual edge or artifacts of fills, costs, timeouts, data density, or execution assumptions?

The immediate recommendations below are designed to answer those questions **without replacing the current engine**.

---

# 2. Hard scope boundaries

## 2.1 In scope

Only narrow additions with immediate usefulness:

1. Closed-candle / causality / lookahead validation.
2. Signal observation ledger.
3. Automatic future-outcome backfill.
4. Strategy / model / data-version attribution for every recorded signal.
5. Matched-random rule significance testing.
6. Monte Carlo robustness testing.
7. Forward paper/live drift monitoring.
8. Standardized advisor-evidence interface.
9. Independent validation using Jesse and Freqtrade as external proving grounds.
10. A minimal deterministic risk-enforcement audit **only if the current system is still relying on prompt-level risk rules instead of code-level constraints**.
11. Append-only research decision/error/outcome logs where missing.

## 2.2 Explicitly out of scope for this rollout

Do **not** turn this into a platform rewrite.

Do not immediately add:

- a new general agent framework;
- ElizaOS;
- a replacement backtesting engine;
- NautilusTrader as the main engine;
- a new LightGBM predictor;
- reinforcement learning;
- auto-retraining;
- market making;
- funding arbitrage;
- cross-exchange execution;
- CCXT migration;
- Hummingbot integration;
- a multi-agent “committee” of LLMs;
- a new database stack;
- a new dashboard;
- a new execution venue;
- a live autonomous wallet agent;
- a wholesale feature-module refactor;
- broad hyperparameter optimization;
- new live trading behavior.

Those may be evaluated separately later.

This handoff is specifically about **improving the trustworthiness and usefulness of the signal engine we already have**.

---

# 3. Current EditTrades assumptions the orchestrator must verify

Do not assume these are still accurate.

Current project context indicates the system already includes or has discussed:

- BTC / ETH / SOL;
- multiple timeframes including 1m / 3m / 5m / 15m / 1h / 4h / daily;
- EMA21 / EMA200;
- Stoch RSI;
- structure;
- range highs/lows;
- support/resistance;
- flags / coils;
- divergence;
- breakout and retest concepts;
- strategy families such as scalp / trend / swing;
- closed-candle preference;
- actionable probability thresholds;
- entry / invalidation / stop / TP / risk-reward outputs;
- current research packet and research harness;
- existing tests;
- existing historical studies;
- current concerns around inconsistent fill, trailing-R, timeout, cost, and cohort semantics.

The orchestrator must inspect the real current code and produce:

```text
CAPABILITY
EXISTS
PARTIAL
MISSING
CONFLICTING
NOT NEEDED
```

for every recommendation in this document.

Do not add a second implementation of something that already exists correctly.

---

# 4. Existing project material that should be read before planning changes

Application repository:

```text
/Users/bballi/Documents/Repos/snapshot_tradingview
```

Research packet:

```text
/Users/bballi/Documents/ChatGPT/EditTrades
```

Read the current versions of the existing research packet before planning:

```text
EDGE_RESEARCH_PLAN_2026-09-27.md
EDGE_STATE_AUDIT_2026-09-27.md
EDGE_HARNESS_SPEC_2026-09-27.md
EDGE_AGENT_BRIEFS_2026-09-27.md
edge-research/experiment.template.json
edge-research/audit-snapshot.json
edge-research/VERIFICATION.md
```

Then inspect:

```text
CLAUDE.md
docs/AGENT_SESSION_RULES.md
all applicable AGENTS.md
current research harness
current strategy implementations
current alert/signal schema
current persistence / tracker schema
current tests
```

Do not trust old branch names or SHAs in earlier documents without checking the live working tree.

---

# 5. Candidate source repositories to independently verify

Only three external repositories are central to this immediate rollout.

---

## 5.1 jsacramento22/Hyperliquid-AI-trading-agent

Repository:

```text
https://github.com/jsacramento22/Hyperliquid-AI-trading-agent
```

### Why it matters

Not because its trading strategy is proven.

The useful ideas are its **prediction lifecycle and observability architecture**:

- prediction recorded before decision;
- model version recorded;
- original price recorded;
- horizon recorded;
- realized outcome backfilled later;
- accuracy / drift monitored;
- decisions / fills / equity / errors persisted;
- ML signal kept informational rather than authoritative;
- deterministic risk gate separated from the LLM.

### Files that were observed as relevant

The orchestrator should independently inspect at least:

```text
src/hl_agent/storage.py
src/hl_agent/tree_outcomes.py
scripts/drift_check.py
src/hl_agent/features.py
tests/test_features.py
scripts/train_tree.py
src/hl_agent/context.py
src/hl_agent/market_data.py
src/hl_agent/risk.py
README.md
```

### Important observations that MUST be independently checked

The current review observed:

1. `tree_predictions` stores probability, direction, confidence, model version, horizon, original price, and later realized outcome.
2. `tree_outcomes.py` performs deferred scoring after the prediction horizon.
3. `drift_check.py` compares forward prediction accuracy with a saved historical baseline.
4. Feature functions are designed as pure functions and have window/correctness tests.
5. The repo treats the LightGBM signal as an informational prior rather than allowing it to place orders.
6. Risk constraints are implemented in deterministic code before orders are accepted.
7. The repo persists decisions, fills, equity, errors, token use, and prediction outcomes.

### Known concerns from the current review

These are NOT conclusions. Reproduce them.

#### Concern A — candle finalization

`market_data.py` appears to fetch a time range through current wall-clock time and then take the last N returned candles.

The current review did not see an explicit finalization filter equivalent to:

```text
candle.close_ms <= now
AND candle is finalized
```

The orchestrator must determine actual Hyperliquid API semantics and whether a currently forming candle can enter the snapshot.

Do not copy this behavior into EditTrades.

#### Concern B — train/serve feature mismatch

The current review observed that the model metadata includes:

```text
funding_rate
funding_z_24h
oi_change_24h_pct
```

but historical tree training appeared to construct training snapshots with funding and open interest as NaN.

If true, this means the live feature distribution is not identical to training.

Do not copy the model.

#### Concern C — possible fold-boundary target leakage

The model predicts a future 45-minute direction.

The current training pipeline appeared to:
1. create labels using future bars;
2. then slice rows into rolling train/validation/test windows.

The review did not identify an explicit purge/embargo preventing a training row near the fold boundary from using a target that lands inside validation.

This must be reproduced and verified.

Do not accept the repo's 52% directional result as evidence for EditTrades.

#### Concern D — license

The current review did not identify an explicit root project license through code search.

Before copying code:
- confirm the license;
- if license remains unclear, copy **no code**;
- only reimplement general architectural ideas independently.

### Intended use for EditTrades

Use this repo as inspiration for:

```text
signal observation ledger
future outcome backfill
forward drift monitoring
version attribution
append-only research logs
advisor-mode separation
```

Do NOT import its model or prompt.

---

## 5.2 jesse-ai/jesse

Repository:

```text
https://github.com/jesse-ai/jesse
```

Current review observed an MIT license.

The orchestrator must verify the current license and source SHA.

### Why it matters

Jesse currently exposes research capabilities highly aligned with the EditTrades research problem:

- rule significance testing;
- bootstrap/random-entry comparison;
- Monte Carlo analysis;
- candle-based robustness simulations;
- trade-order shuffling;
- no-lookahead backtesting claims;
- multi-timeframe strategies;
- research API;
- MCP integration;
- detailed strategy metrics.

### Immediate ideas to validate

#### A. Rule significance testing

The current Jesse documentation states that an entry rule can be compared against a bootstrap distribution of random entries on the same market history.

This is directly useful.

We want to answer:

> Does `failed breakdown + reclaim` actually identify better opportunities than random entries under the same market conditions?

Not merely:

> Was the backtest profitable?

The orchestrator must inspect the actual implementation.

Determine:

- how random entries are sampled;
- whether direction is preserved;
- whether opportunity count is preserved;
- whether holding periods are preserved;
- whether exit logic is preserved;
- whether random entries are matched by regime / time / volatility;
- which statistic determines “significance”;
- number of bootstrap iterations;
- whether multiple testing is handled;
- whether seeds are controllable;
- whether output includes confidence intervals / effect sizes.

Do not simply adopt Jesse's definition if it is too weak for EditTrades.

We may need a **matched-random control inspired by Jesse but stricter**.

#### B. Monte Carlo

The current Jesse README describes:

```text
trade-order shuffling
candles-based simulations
```

The orchestrator must inspect actual implementation.

Determine:
- how candles are perturbed;
- whether OHLC relationships remain valid;
- whether temporal autocorrelation is preserved;
- whether the technique is appropriate for crypto;
- whether outcomes are recomputed from simulated price paths or only trades are shuffled;
- whether stops/targets are re-evaluated pathwise;
- what distribution outputs are available.

Use the concept only if statistically defensible.

#### C. External validator role

Jesse should initially remain a **standalone independent validator**, not a library dependency inside EditTrades.

A candidate EditTrades strategy can be recreated in Jesse and run over:
- identical symbol;
- identical dates;
- identical timeframe;
- identical signal definition;
- identical fill rule where possible;
- identical cost assumptions.

If results differ materially, promotion is blocked until reconciled.

---

## 5.3 freqtrade/freqtrade

Repository:

```text
https://github.com/freqtrade/freqtrade
```

The current review verified the project is GPLv3.

Treat the GPL license as a reason to avoid directly copying code into EditTrades unless the legal implications are intentionally accepted.

### Why it matters

Freqtrade exposes dedicated tools for:

```text
lookahead-analysis
recursive-analysis
backtesting-analysis
```

The project documentation explicitly warns about future-data usage during backtesting and provides tooling to detect common lookahead and recursive indicator problems.

### Immediate use

Do not install Freqtrade as the EditTrades engine.

Use it as:

1. an **independent validation environment**;
2. a design reference for automated leakage detection;
3. a design reference for recursive indicator consistency testing.

### Orchestrator questions

Inspect the real implementation and determine:

- how `lookahead-analysis` detects bias;
- which columns/signals it perturbs;
- whether the concept can be reproduced in EditTrades tests without copying GPL code;
- how `recursive-analysis` compares indicator stability as startup/history length changes;
- whether multi-timeframe informative data has special handling;
- whether Freqtrade's backtester uses candle close or next open for specific strategy events;
- whether Hyperliquid support matters for our validation use.

---

# 6. Priority matrix

The final rollout plan should optimize for both **ease** and **signal-quality impact**.

Initial recommended order:

| Priority | Candidate | Expected impact | Effort | Dependency | Immediate purpose |
|---|---|---:|---:|---|---|
| P0 | Closed-candle / causality / leakage test suite | Very High | Low-Medium | None | Stop false edge before more research |
| P0 | Signal Observation Ledger + version attribution | Very High | Medium | Schema/persistence | Record what system actually knew and said |
| P0 | Automatic future-outcome backfill | Very High | Medium | Signal ledger | Score every signal / wait call consistently |
| P1 | Matched-random rule significance test | Very High | Medium | Causal harness | Determine whether entry rules beat chance |
| P1 | Monte Carlo robustness suite | High | Medium | Stable candidate/backtest | Reject path-dependent / fragile edges |
| P1 | Forward drift monitoring | Very High | Medium | Ledger + outcomes | Detect research→paper degradation |
| P2 | Standard advisor-evidence interface | High | Medium | Ledger/versioning | Measure independent contribution of strategies |
| P2 | External validator workflow: Jesse + Freqtrade | High | Low-Medium operationally | Frozen candidate | Independently reproduce key results |
| Conditional | Deterministic code-level risk gate audit | Medium for edge, High for safety | Low-Medium | Current execution architecture | Only if risk rules are still prompt-only |

The orchestrator may change this ordering if the current codebase shows different dependencies.

Any reordered plan must explain why.

---

# 7. P0 — Closed-candle / causality / leakage validation

## 7.1 Objective

Create a reusable automated test layer that proves that research signals cannot change because of information unavailable at decision time.

This should be the first high-priority improvement because every later metric is meaningless if the timestamp semantics are wrong.

## 7.2 Do not rewrite the feature engine

Do not refactor every feature into a new architecture.

Instead:

- identify feature/signal computation boundaries already present;
- add a research validation wrapper;
- add tests around existing functions;
- apply stronger metadata contracts to new or modified features first.

## 7.3 Required tests

### Test A — future-bar invariance

At timestamp `t`:

1. compute feature/signal from all data available through `t`;
2. append bars strictly after `t`;
3. recompute the feature at `t`;
4. assert result is unchanged.

This detects direct lookahead contamination.

### Test B — closed-candle gate

For every timeframe used by a strategy:

```text
1m
3m
5m
15m
1h
4h
1d
```

prove that an unfinished candle cannot enter the strategy evaluation state unless a specific experiment explicitly permits intrabar data.

The default research contract should be:

```text
feature candle close <= decision timestamp
```

### Test C — higher-timeframe availability

Example:

A 4H candle ending at 12:00 UTC cannot influence a 10:30 UTC 5m decision.

When joining timeframes, use the most recently **completed** higher-timeframe observation.

### Test D — timestamp chain

For every research event, record:

```text
source bar close time
feature availability time
signal decision time
order eligibility time
assumed fill time
```

Tests should assert monotonic causality.

### Test E — recursive consistency

Inspired by Freqtrade's `recursive-analysis`.

Compute an indicator or signal:
- incrementally with only historical data available at each point;
- from the full dataset while requesting the same historical timestamp.

Values should match within declared tolerances.

This catches:
- warmup differences;
- recursive indicator instability;
- whole-series normalization leakage;
- inconsistent EMA startup behavior;
- accidental dependence on future dataset length.

### Test F — forward-label purge

Any experiment using a future horizon for labels must purge training observations whose outcome window overlaps validation/test.

Example:

If:

```text
label_horizon = 45 minutes
```

then a training sample at `11:45` cannot remain in train if its label requires price at `12:30` and validation begins at `12:00`.

The orchestrator should decide whether:
- purge alone;
- purge + embargo;
- blocked folds

are appropriate for each use.

### Test G — partial data status

If a required candle set is incomplete:

```text
complete
partial
unavailable
```

must propagate to the signal.

The strategy should not quietly substitute partial evidence and retain full confidence.

## 7.4 Feature metadata contract

For new/modified research features, add metadata conceptually equivalent to:

```json
{
  "feature_id": "stoch_rsi_15m",
  "version": "1",
  "timeframe": "15m",
  "lookback_bars": 14,
  "requires_closed_candle": true,
  "input_sources": ["OHLC"],
  "warmup_bars": 20,
  "output_type": "numeric"
}
```

Do not retrofit the entire engine in one pass if that creates churn.

## 7.5 Acceptance criteria

P0 causality work is successful when:

- a future candle cannot change a historical signal;
- partial 4H/1H/15m candles are excluded from closed-candle experiments;
- multi-timeframe joins have deterministic availability semantics;
- forward labels cannot cross train/test boundaries without purge;
- recursive indicator differences are surfaced;
- tests fail loudly when timestamp contracts are violated.

---

# 8. P0 — Signal Observation Ledger

## 8.1 Objective

Record what EditTrades actually believed at a point in time so every prediction can be scored later.

This is likely the single highest-value observability improvement.

The ledger must record **all evaluated opportunities**, not only trades that passed the final alert threshold.

If we only store executed/actionable trades, we cannot measure:

- missed opportunities;
- WAIT quality;
- false negatives;
- calibration below the alert threshold;
- threshold sensitivity;
- advisor disagreements.

## 8.2 Minimum observation schema

The orchestrator should adapt this to the existing storage layer rather than introducing a new database unnecessarily.

Suggested conceptual schema:

```text
observation_id
cycle_id
timestamp_utc

asset
market
venue_reference

strategy_id
strategy_version
engine_version
git_sha
config_version
data_snapshot_id

primary_timeframe
side_candidate

signal_state:
    GO_IN
    HOLD
    WAIT
    DO_NOT_ENTER
    NO_SETUP

p_long
p_short
p_wait

entry_candidate
confirmation_requirement
invalidation
stop
tp1
tp2
expected_rr

price_at_observation

4h_bias
1h_bias
15m_state
5m_state

pattern_tags
structure_tags
divergence_tags
regime_tags

cost_model_id
execution_model_id

data_status
feature_status

reason_codes
advisor_evidence_json

created_at
```

Use existing naming conventions where available.

## 8.3 Why probabilities must be stored

The system currently uses probability/confidence concepts.

We need historical calibration questions such as:

```text
Signals labeled 65-69%
Signals labeled 70-74%
Signals labeled 75-79%
Signals labeled 80%+
```

For each bucket:

- actual directional success;
- positive net R;
- TP hit rate;
- stop rate;
- MFE;
- MAE;
- average net R;
- confidence interval.

Without immutable probability snapshots, the system can never be objectively calibrated.

## 8.4 Store reason codes, not only prose

Keep human-readable reasoning if useful.

But also create structured reasons such as:

```text
HTF_TREND_ALIGNED
EMA21_PULLBACK
EMA200_SUPPORT
STOCH_5M_ALIGNED
STOCH_15M_ALIGNED
FAILED_BREAKDOWN
WICK_REJECTION
FLAG_FORMING
FLAG_FAILED
DIVERGENCE_BULLISH
DIVERGENCE_BEARISH
RESISTANCE_OVERHEAD
NO_ROOM_TO_TARGET
LATE_ENTRY
RETEST_REQUIRED
```

This allows later attribution:

> Which components actually improve outcomes?

## 8.5 Immutable version attribution

Every observation should identify:

```text
strategy version
config version
code SHA
data snapshot/source
research cost model
```

A forward result without version attribution is not useful for drift analysis.

---

# 9. P0 — Automatic Future-Outcome Backfill

## 9.1 Objective

Automatically evaluate what happened after each recorded observation.

This is conceptually inspired by the Hyperliquid AI repo's prediction-outcome backfill, but EditTrades needs a much richer outcome model than simple “up/down correct.”

## 9.2 Required horizons

Suggested starting horizons:

```text
15m
30m
1h
2h
4h
12h
```

Not every strategy needs every horizon.

Use strategy metadata to identify primary horizons.

## 9.3 Required path metrics

For each observation calculate:

```text
close_return_at_horizon
maximum_favorable_excursion (MFE)
maximum_adverse_excursion (MAE)
```

For candidate trade levels also calculate:

```text
entry_reached
confirmation_reached
invalidation_hit
stop_hit
tp1_hit
tp2_hit
```

Where possible record ordering:

```text
TP1 before stop
stop before TP1
invalidation before entry
entry never filled
```

This matters enormously.

A strategy can show a good end-of-horizon close and still have stopped out first.

## 9.4 R metrics

Where the observation defines a trade:

```text
gross_R
net_R
cost_drag_R
```

Use the registered original risk unit.

Do not recompute R from a changing trailing stop unless the experiment explicitly defines that convention.

## 9.5 Missed-trade scoring

WAIT / DO NOT ENTER calls also need outcomes.

Example:

```text
signal_state = WAIT
p_long = 42%
p_short = 38%
p_wait = 20%
```

Then 1h later:

```text
MFE long = +2.4R equivalent
MAE long = -0.2R
```

This may indicate a systematic false-negative problem.

Similarly, a correct `WAIT` during chop should be recognized as a good outcome.

Do not reduce WAIT quality to “direction was up/down.”

## 9.6 Outcome completeness

Track:

```text
pending
complete
partial
unscorable
```

Never silently discard unscored signals.

Report the unscored fraction.

---

# 10. P1 — Matched-Random Rule Significance

## 10.1 Objective

Determine whether an entry rule identifies opportunities better than comparable chance entries.

This is inspired by Jesse's rule-significance concept but should be adapted to EditTrades.

## 10.2 Why plain random is not enough

If we compare:

```text
bullish divergence entries
```

against totally random timestamps across all regimes, we may create a fake edge because the rule happens mostly during high-volatility sessions.

The random control should be **matched where practical**.

## 10.3 Proposed control construction

For a frozen entry rule:

1. Identify all eligible signal opportunities.
2. Record:
   - asset;
   - side;
   - timeframe;
   - time-of-day bucket;
   - volatility regime;
   - broad HTF trend regime;
   - holding/exit rule;
   - cost model.
3. Generate seeded random/control entry sets with:
   - same number of opportunities;
   - same side distribution;
   - same asset;
   - same date eligibility;
   - same exit rules;
   - same risk definition.
4. Prefer matching regime/time buckets where sample size allows.
5. Compute strategy result relative to the control distribution.

## 10.4 Required outputs

At minimum:

```text
observed expectancy
random mean expectancy
delta expectancy

observed median R
random median R

observed TP1 rate
random TP1 rate

observed MFE
random MFE

observed MAE
random MAE

percentile vs control
bootstrap confidence interval
empirical p-value or equivalent tail probability
number of opportunities
number of random simulations
seed
```

## 10.5 Do not use p-value alone

A rule with:

```text
p = 0.03
delta expectancy = +0.01R
```

may be economically useless.

Require both:

```text
statistical separation
+
economically meaningful effect
```

## 10.6 Multiple testing

The existing research program already cares about multiple testing.

The orchestrator must propose:
- family definitions;
- corrected thresholds;
- preregistration;
- maximum variant count.

Do not run hundreds of rules until one achieves `p < 0.05`.

## 10.7 Initial candidates

This framework should eventually be usable for existing EditTrades concepts such as:

```text
divergence
failed flag
failed breakdown/reclaim
breakout
breakout + retest
EMA21 pullback
wick rejection
range-edge reversal
```

Do not test all at once.

Start with one or two known high-value problem areas.

---

# 11. P1 — Monte Carlo Robustness

## 11.1 Objective

Determine whether strategy performance is dependent on one fortunate historical ordering/path.

Inspired by Jesse's Monte Carlo features.

The orchestrator must verify Jesse's implementation before deciding whether to:
- use Jesse directly;
- recreate similar tests in EditTrades;
- do both.

## 11.2 Minimum method A — trade-order shuffle

For a fixed list of realized trade outcomes:

- shuffle trade ordering;
- preserve individual trade R;
- run many seeded simulations.

Measure:

```text
max drawdown distribution
longest losing streak distribution
equity path dispersion
risk-of-ruin proxy
ending equity distribution
```

This tests sequence risk.

It does not prove the underlying entries have edge.

## 11.3 Minimum method B — path / candle robustness

Only implement if a statistically defensible method can be verified.

Possible approaches include:
- block bootstrap of returns;
- regime-aware resampling;
- candle-path perturbation while preserving OHLC validity;
- sampling from matched historical local paths.

The orchestrator must reject any method that produces unrealistic market structure.

## 11.4 Required outputs

For each candidate:

```text
median outcome
5th percentile
25th percentile
75th percentile
95th percentile

max drawdown percentiles
profit factor distribution
expectancy distribution
probability of positive net expectancy
probability of exceeding specified drawdown
```

## 11.5 Stop condition

If strategy success disappears under mild, defensible perturbation:

```text
REJECT or INCONCLUSIVE
```

Do not retune until it survives.

---

# 12. P1 — Forward Paper / Live Drift Monitor

## 12.1 Objective

Measure whether historical research behavior survives after the candidate is frozen.

Conceptually inspired by the Hyperliquid AI repo's `drift_check.py`.

Do not copy its accuracy-only logic.

## 12.2 Baseline

When a strategy becomes `PAPER CANDIDATE`, freeze:

```text
strategy version
code SHA
configuration
expected opportunity frequency
historical expectancy
historical median R
historical MFE
historical MAE
TP / stop rates
cost drag
probability calibration
regime mix
```

## 12.3 Forward metrics

Compare rolling paper observations against research baseline.

Recommended metrics:

```text
net expectancy
median net R
profit factor
MFE
MAE
TP1 rate
stop rate
false-trigger rate
missed-opportunity rate
signal frequency
probability calibration
cost drag
```

## 12.4 Drift states

Suggested:

```text
INSUFFICIENT
OK
WATCH
ALERT
```

Do not define final statistical thresholds until the orchestrator evaluates sample sizes and dependence.

`INSUFFICIENT` is important.

Ten trades are not enough to declare a strategy stable or broken.

## 12.5 No automatic strategy changes

Drift must never automatically:

- retrain;
- retune;
- lower thresholds;
- change leverage;
- change stops;
- promote a strategy.

It should create evidence for a human/research decision.

---

# 13. P2 — Standard Advisor-Evidence Interface

## 13.1 Objective

Keep independent strategy evidence separate long enough to measure whether each source actually contributes.

This is inspired by the useful “informational advisor” pattern observed in the Hyperliquid AI repo.

Do NOT create multiple LLM agents.

The advisor should be a deterministic/statistical output contract.

## 13.2 Suggested contract

Each strategy/advisor can emit:

```json
{
  "advisor_id": "trend_4h",
  "version": "2026.09.27-1",
  "asset": "BTC",
  "timestamp": "...",
  "horizon": "4h",
  "state": "LONG",
  "probability": 0.72,
  "expected_r": 0.31,
  "invalidation": 84250,
  "data_status": "complete",
  "evidence_class": "historical_validated",
  "reason_codes": [
    "HTF_TREND_ALIGNED"
  ]
}
```

Example independent advisors may eventually include:

```text
trend
structure
divergence
breakout/retest
failed-breakout / failed-breakdown
external SMA trend research candidate
external Donchian research candidate
```

Do not add all of these now.

The interface is the improvement.

## 13.3 Why this helps accuracy

The current system can later measure:

```text
Trend LONG + Structure LONG
Trend LONG + Divergence SHORT
Trend LONG + Retest WAIT
```

and ask:

> Does the second advisor improve outcomes or merely duplicate the first?

## 13.4 Disagreement analysis

The ledger should support cohorts such as:

```text
advisor A agrees with final signal
advisor A disagrees with final signal
advisor A only source of bullish evidence
advisor A only source of bearish evidence
```

Compare future outcomes.

This is how we prevent indicator stacking from becoming fake confidence.

## 13.5 Initial mode

The advisor interface should initially be:

```text
INFORMATIONAL / RESEARCH ONLY
```

Do not immediately let a new advisor:
- size positions;
- override stops;
- auto-execute;
- override core strategy state.

---

# 14. P2 — External independent validation workflow

External validation is a process, not a new production dependency.

---

## 14.1 Jesse validator

For simple/frozen candidates:

1. reproduce the strategy in Jesse;
2. use identical date range;
3. use identical candles;
4. use identical fees;
5. use identical fill semantics where possible;
6. compare event timestamps and trades;
7. run Jesse significance / Monte Carlo features only after verifying their actual implementation.

### Blocking discrepancies

If the strategy produces substantially different:
- trade count;
- timestamps;
- PnL;
- drawdown;
- expectancy

then do not choose the better result.

Reconcile the difference first.

---

## 14.2 Freqtrade validator

Use Freqtrade for:

```text
lookahead-analysis
recursive-analysis
simple independent backtests
```

Because Freqtrade is GPLv3:

- use it as an external tool;
- do not casually copy implementation code into EditTrades.

## 14.3 Reproduction standard

For deterministic strategies, the ideal is:

```text
same candles
same signal timestamps
same side
same entry rule
same exit rule
same fees
```

Then trades should match exactly or have an explained implementation difference.

## 14.4 Validation result schema

Each candidate should eventually carry:

```text
EditTrades native: PASS/FAIL
Jesse reproduction: PASS/FAIL/NOT_RUN
Freqtrade leakage check: PASS/FAIL/NOT_APPLICABLE
Freqtrade recursive check: PASS/FAIL/NOT_APPLICABLE
```

No single third-party tool is authoritative.

Agreement increases confidence.

---

# 15. Conditional — deterministic risk gate audit

This recommendation should only survive if the current codebase lacks hard enforcement.

## 15.1 Why conditional

The main goal of this document is **edge and signal accuracy**, not execution redesign.

If EditTrades already enforces risk in code, do nothing.

If risk rules exist only in prompts/output text, evaluate a minimal code-level gate.

## 15.2 Possible hard constraints

Examples:

```text
max wallet risk per trade
max daily drawdown
max notional
max leverage
minimum stop distance
no new trade after configured consecutive-loss threshold
no order if invalidation/stop missing
```

The research engine may recommend a trade.

The risk layer decides whether the action is allowable.

Do not merge signal confidence and risk permission into one score.

---

# 16. Append-only evidence principle

Research history should not be rewritten when results are inconvenient.

For each trial preserve:

```text
experiment ID
strategy version
hypothesis
registration
commands
inputs
outputs
metrics
decision
failure reason
```

For forward signals preserve:

```text
original probability
original levels
original reasoning codes
original data status
eventual outcomes
```

Never replace the original signal after seeing the market.

Corrections should create a new version/event.

---

# 17. How these improvements are expected to improve edge / accuracy

These features do not magically create edge.

They improve the probability that the system **finds real edge and removes fake edge**.

### Causality tests

Remove falsely strong signals caused by:
- partial candles;
- future data;
- label leakage;
- recursive instability.

### Signal ledger

Makes missed calls and false positives measurable.

### Outcome backfill

Turns subjective post-trade review into a dataset.

### Rule significance

Tests whether pattern recognition is better than chance.

### Monte Carlo

Tests whether performance survives alternate paths.

### Drift

Stops stale research edges from being trusted indefinitely.

### Advisor interface

Allows independent contribution analysis rather than stacking correlated indicators.

### External validators

Reduce the probability that a bug in our own harness is responsible for “edge.”

The goal is not necessarily to increase the number of `GO IN` signals.

A successful rollout may produce:

```text
fewer signals
higher calibration
better net expectancy
fewer obvious missed flips
less false confidence
clearer thesis invalidation
```

That is a good outcome.

---

# 18. Required implementation philosophy

## 18.1 Add, do not replace

Prefer:

```text
existing harness
+ validation layer
+ observation layer
```

over:

```text
new framework
```

## 18.2 Pure research before production

All new research capabilities should initially run:

```text
offline
shadow
paper
```

before they affect signal recommendations.

## 18.3 Reuse existing persistence

If EditTrades already has:
- JSON research outputs;
- tracker storage;
- SQLite;
- a database;
- event logs;

extend those where reasonable.

Do not add a database because another repo uses SQLite.

## 18.4 Reuse existing strategy interfaces

Do not force all strategies into a new base class unless the current architecture genuinely requires it.

## 18.5 Performance budgets

The orchestrator must benchmark runtime.

Signal calls should not become unusably slow because every request launches 1,000 bootstrap simulations.

Separate:

```text
online signal generation
```

from:

```text
offline research validation
```

Significance and Monte Carlo can be offline.

Ledger writing and outcome scoring must be lightweight.

---

# 19. Anti-patterns to explicitly avoid

Do not:

### 19.1 Optimize until green

```text
test
fails
change parameter
test
fails
change parameter
test
wins
ship
```

Not allowed.

### 19.2 Convert every indicator into confidence points

This risks double counting correlated evidence.

### 19.3 Judge accuracy only

52% directional accuracy can still lose money.

48% can still be profitable with asymmetric payoff.

### 19.4 Evaluate only taken trades

We need rejected/missed opportunities.

### 19.5 Automatically learn from every new trade

Forward validation must remain stable long enough to test a fixed hypothesis.

### 19.6 Let AI prose become ground truth

Persist structured inputs/outputs.

### 19.7 Copy third-party code without license review

Especially Freqtrade GPL code and any repo with unclear licensing.

### 19.8 Trust README performance claims

Reproduce.

### 19.9 Use a single historical split

Use blocked/walk-forward methods appropriate to the strategy.

### 19.10 Treat passing unit tests as edge

Tests prove implementation behavior, not profitability.

---

# 20. Recommended orchestrator research sequence

The orchestrator should execute this sequence before writing the final rollout plan.

---

## Step 0 — Freeze current baseline

Record:

```text
repo path
current branch
current SHA
dirty state
worktrees
current config version
current tests
current research datasets
```

Do not modify production paths.

---

## Step 1 — Current capability gap audit

For each recommendation:

```text
feature
already exists?
where?
quality?
gaps?
duplicate risk?
expected modification size?
```

Output:

```text
ADOPT
ADAPT
DEFER
REJECT
ALREADY EXISTS
```

---

## Step 2 — External source verification

For every referenced repo:

```text
repo resolves
default branch
current SHA
license
files inspected
actual behavior
README claim confirmed?
known limitations
```

No source may be used based only on this document.

---

## Step 3 — Minimal architecture proposal

For every `ADOPT` / `ADAPT` capability specify:

```text
new files
modified files
schema changes
interfaces
tests
dependencies
runtime path
offline path
migration
rollback
```

Minimize touched code.

---

## Step 4 — Dependency graph

Expected logical dependency:

```text
CAUSALITY TESTS
      ↓
SIGNAL LEDGER
      ↓
OUTCOME BACKFILL
      ↓
SIGNIFICANCE / MONTE CARLO
      ↓
PAPER BASELINES
      ↓
DRIFT MONITOR

ADVISOR INTERFACE
      ↘ ledger / outcomes

EXTERNAL VALIDATION
      ↘ all frozen candidates
```

Adjust after code inspection.

---

## Step 5 — Propose rollout increments

Each increment should:
- have one goal;
- be independently testable;
- have rollback;
- avoid production behavior change;
- create a measurable artifact.

Suggested increments:

```text
R1 Causality guardrails
R2 Signal ledger
R3 Outcome backfill
R4 Rule significance
R5 Monte Carlo
R6 Forward drift
R7 Advisor evidence schema
R8 External validator protocol
```

---

## Step 6 — Produce a test plan

Tests must include:

### Unit
Feature correctness, schemas, scoring.

### Causality
Future-bar, closed-candle, HTF join, label purge.

### Integration
Signal → ledger → outcome.

### Regression
Old signal output must remain unchanged unless explicitly approved.

### Performance
Signal generation latency and storage overhead.

### Reproducibility
Seeded significance/Monte Carlo.

### Data migration
Old records still readable where applicable.

---

## Step 7 — Define success metrics for the rollout itself

The rollout should not be judged on “more PnL” immediately.

Near-term success means:

```text
100% of research signals versioned
100% of evaluated signals can receive outcomes
0 known closed-candle leaks
0 known fold-boundary leakage
significance controls available
Monte Carlo available
paper candidates have drift state
external reproduction available for finalists
```

Then measure later:

```text
probability calibration error
false positive rate
false negative / missed move rate
net expectancy by confidence bucket
net expectancy by reason code
advisor incremental value
```

---

# 21. Detailed final rollout-plan deliverables required from the orchestrator

The orchestrator's final response should contain all of the following.

## Deliverable A — Source verification matrix

Columns:

```text
repo
SHA
license
files inspected
claimed capability
confirmed?
limitations
safe reuse type
```

Safe reuse type:

```text
COPY PERMITTED
REIMPLEMENT CONCEPT
EXTERNAL TOOL ONLY
DO NOT USE
```

---

## Deliverable B — EditTrades gap matrix

Columns:

```text
candidate capability
current equivalent
missing behavior
recommended action
files affected
effort
risk
impact
```

---

## Deliverable C — Priority score

Score each on:

```text
signal accuracy impact     1-5
edge-validation impact     1-5
implementation ease       1-5
runtime cost              1-5 lower-is-better
architectural risk        1-5 lower-is-better
reversibility             1-5
dependency urgency        1-5
```

Explain the final order.

---

## Deliverable D — Exact architecture changes

For each accepted feature include:

```text
data structures
function/module boundaries
API changes
schema changes
new tests
changed tests
performance impact
failure modes
fallback
rollback
```

---

## Deliverable E — Migration / compatibility

State explicitly:

```text
Does current `signals` behavior change?
Does tracker output change?
Do existing clients break?
Does MCP schema change?
Does historical data need migration?
Can new fields be optional initially?
```

Favor additive optional fields.

---

## Deliverable F — Research validity plan

Define:

```text
closed candle rules
time alignment
fill model
cost model
purge rules
random-control rules
Monte Carlo rules
multiple-testing policy
forward validation rules
```

---

## Deliverable G — Rollout phases

Each phase must specify:

```text
objective
files
owner
dependencies
test command
artifact
acceptance
rollback
stop condition
```

---

## Deliverable H — Explicit rejection list

Anything reviewed but not recommended should be documented with a reason.

Do not let rejected ideas re-enter the plan silently.

---

# 22. Specific questions the orchestrator must answer

The final rollout plan is incomplete unless it answers:

1. Does EditTrades already have a durable immutable signal/outcome ledger?
2. Does it record WAIT / DO NOT ENTER observations or only actionable trades?
3. Can historical probabilities be calibrated today?
4. Can we compute MFE/MAE for every signal?
5. Can we distinguish `entry never filled` from `trade lost`?
6. Are 4H and 1H candles guaranteed closed at decision time?
7. Are multi-timeframe joins causal?
8. Do any existing ML/forward-label tests need purging?
9. Can a future candle alter an older feature value?
10. Can startup/history length alter current indicator values?
11. Is there already a matched-random control?
12. Is there already Monte Carlo?
13. Can paper performance be compared against frozen research expectations?
14. Are strategy/config/code versions attached to forward observations?
15. Are current confidence percentages empirically calibrated?
16. Can we identify which reason codes add positive incremental expectancy?
17. Can we measure advisor disagreement?
18. Does current risk enforcement exist in deterministic code?
19. What parts of Jesse can be used externally without integrating it into production?
20. What parts of Freqtrade's leakage testing should be recreated as native tests?
21. Is the Hyperliquid AI repository licensed for code reuse?
22. Which recommendations can be delivered with zero live signal behavior change?
23. Which change provides the highest signal-quality benefit for the least code?
24. Which change has the highest risk of contaminating the existing engine?
25. What is the smallest first rollout that creates measurable value?

---

# 23. Recommended smallest first release

This is a recommendation only. Verify it.

If the current codebase supports it cleanly, the smallest high-value release is likely:

```text
1. Closed-candle / future-bar causality tests
2. Immutable signal observation record
3. Automatic 15m / 1h / 4h outcome backfill
4. MFE / MAE / target-stop-path scoring
5. Strategy + code + config version attribution
```

Why this first?

Because it creates the dataset required to evaluate everything else.

After this exists, we can objectively answer:

```text
What did EditTrades say?
What was its confidence?
Why did it say it?
What happened?
Was it right for the right reason?
```

Then significance, Monte Carlo, drift, and advisor attribution become much more useful.

---

# 24. Recommended second release

After the observation pipeline is trusted:

```text
1. matched-random significance
2. trade-order Monte Carlo
3. validated candle/path robustness method
4. external Jesse reproduction
5. Freqtrade lookahead / recursive validation
```

No production signal behavior needs to change.

---

# 25. Recommended third release

After frozen paper candidates exist:

```text
1. forward drift dashboard/report
2. calibration by confidence bucket
3. advisor incremental-value analysis
4. research vs paper cohort comparison
```

Only after this evidence exists should the team consider changing how final trade confidence is composed.

---

# 26. What NOT to roll out from the reviewed repositories

Do not import from the Hyperliquid AI repo:

```text
its LightGBM model
its 52% accuracy gate
its training pipeline as-is
its funding/OI feature behavior
its LLM trading prompt
its auto-TP/SL system
its mainnet execution
```

Do not import Jesse wholesale.

Do not replace the EditTrades backtester with Jesse.

Do not embed Freqtrade.

Do not copy GPL code into EditTrades casually.

Do not add FinRL/RL.

Do not add Eliza.

Do not add Hummingbot.

Do not add Nautilus in this rollout.

Do not add CCXT in this rollout unless a concrete current data-normalization problem is proven and cannot be solved locally.

---

# 27. Final principle for every agent receiving this document

You must treat this document as a **research hypothesis about improving the harness**.

You must independently verify:

- the external repositories;
- their current behavior;
- their current licenses;
- the EditTrades current architecture;
- the claimed gaps;
- the expected benefit;
- the statistical validity;
- the implementation cost.

You are explicitly instructed:

> **Do not implement any recommendation simply because it appears in this document.**

For each item, return one of:

```text
CONFIRMED — IMPLEMENTATION CANDIDATE
CONFIRMED — ALREADY EXISTS
PARTIAL — ADAPT
NOT ACTIONABLE — DEFER
INVALID / UNSUPPORTED — REJECT
```

The final rollout plan should include **only confirmed implementation candidates**.

The standard is not:

> “This repo does something cool.”

The standard is:

> “This specific capability is missing or inadequate in EditTrades, can be added with low disruption, improves our ability to detect or preserve genuine edge, and has been independently verified.”

---

# 28. Desired final state

The desired EditTrades research loop is:

```text
MARKET DATA
    ↓
closed-candle / causal feature state
    ↓
strategy / pattern opportunity
    ↓
independent advisor evidence
    ↓
probability + levels + reason codes
    ↓
immutable signal observation ledger
    ↓
future outcome backfill
    ↓
MFE / MAE / R / target-stop ordering
    ↓
historical significance vs matched controls
    ↓
Monte Carlo robustness
    ↓
walk-forward / external reproduction
    ↓
PAPER CANDIDATE
    ↓
forward observation
    ↓
drift / calibration
    ↓
retain / revise / reject
```

This should sit **around the existing EditTrades engine**, not replace it.

The long-term effect we are trying to achieve is:

```text
less guessing
less hindsight
less false confidence
fewer fake edges
more measurable misses
better calibrated probabilities
clearer strategy contribution
more trustworthy GO IN signals
```

That is the implementation strategy this research handoff is asking the orchestrator to validate and convert into a final rollout plan.
