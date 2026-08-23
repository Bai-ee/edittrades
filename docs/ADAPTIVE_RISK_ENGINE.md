# Adaptive Risk Engine

`public/js/adaptiveRisk.js` — an adaptive layer built **on top of** `public/js/riskManager.js`.

| | |
|---|---|
| **Module** | `public/js/adaptiveRisk.js` (plain ESM, no build step, browser-loadable) |
| **Harness** | `scripts/validate-adaptive-risk.js` — `npm run validate:adaptive` |
| **Version** | `STRATEGY_VERSION = '1.0.0'` |
| **Depends on** | `riskManager.js` for `calculateStopDistance`, `calculatePositionSize`, `calculateRequiredMargin`, `estimateLiquidation`, `calculatePortfolioRisk`, `calculateExposure`, `detectCorrelatedExposure`, `DEFAULT_RISK_POLICY` |

---

## 1. What this layer is for

`riskManager.js` answers: *"I want to risk 1%. How big is the position?"*

This layer answers a different question: *"Given what this account has actually done, how much **should** it be risking right now — and should it be trading at all?"*

It does not rewrite or replace the base engine. It reuses its primitives and never re-derives its arithmetic.

### Non-negotiables

- **Pure.** No network, no clock, no randomness, no AI. `now` is always a parameter. Same inputs → same output, forever.
- **Decision support.** Nothing places, modifies or closes a trade.
- **Not a prediction.** Every output describes risk capacity, never where price is going.
- **Slow up, fast down.** Earning risk capacity takes many trades. Losing it takes one bad drawdown.

### The decision hierarchy

Hard constraints win. Implemented in this exact order inside `recommendTrade`:

```
1. LEVEL              what the account has earned                  (slow)
2. STRATEGY           which preset the user selected
3. CONFIDENCE         the slider — INSIDE the envelope only
4. WALLET PERFORMANCE recent results and drawdown — one-way DOWN
5. OPEN RISK          heat, exposure, concentration, margin clamps
6. NO-TRADE GATE      evaluated last, overrules everything above
```

Confidence can never raise risk above the envelope, never raise leverage above the cap, and never clear a `NO_TRADE`.

---

## 2. Exports

```js
export const STRATEGY_PRESETS      // { STANDARD, AGGRESSIVE }, each with a per-level table
export const LEVELS                // -2..5 definitions
export const STRATEGY_VERSION      // '1.0.0'
export const ADAPTIVE_CONSTANTS    // every tunable in one auditable block

export function calculateAdjustedEquity({ walletValue, cashFlows })
export function buildEquityCurve({ snapshots, cashFlows })
export function calculateDrawdown({ equityCurve })
export function calculateRecentPerformance({ trades, window = 10, now, includeInactivity })
export function calculateRiskLevel({ adjustedEquity, equityCurve, trades, openPositions, previousLevelState, now })
export function calculateLevelProgress(levelState)
export function calculateOpenRisk({ openPositions, adjustedEquity })
export function calculateDirectionalConcentration({ openPositions })
export function calculateStrategyEnvelope({ level, strategy, recentPerformance, drawdown })
export function calculateConfidenceMultiplier({ confidence, strategy, envelope })
export function evaluateNoTradeConstraints({ envelope, openRiskState, concentration, adjustedEquity, drawdown, level, direction })
export function recommendTrade({ account, request })          // PRIMARY ENTRY POINT
export function evaluatePosition({ account, position, strategy })
export function analyzeStrategyPerformance({ trades })        // proposals only
export function getLevelDefinition(level)
export function hashInputs(payload)
export default { ...all of the above }
```

`now`, `includeInactivity` and `direction` are optional additions to the required signatures. Every one of them defaults so that omitting it reproduces the contracted behaviour.

---

## 3. Accounting: equity, cash flows, performance

### `adjustedEquity` = `walletValue`

The wallet's marked value **is** the capital base. A $10,000 deposit gives you $10,000 more to risk the moment it lands. Adjusting the capital base for cash flows would size trades against money that is not there.

Cash flows matter for the **separate** question of how the account has *performed*.

### The performance curve

A cash flow at time *T* shifts the **baseline**, not performance. Between two consecutive snapshots:

```
growth = (v1 − v0 − netFlowsInInterval) / v0
```

and those growths chain multiplicatively into an index starting at `1.0`. A flow is attributed to the interval `(s0, s1]` — strictly after the earlier snapshot, up to and including the later one.

| Scenario | Wallet | Flow | Index | Reading |
|---|---|---|---|---|
| Deposit | 10,000 → 20,000 | +10,000 deposit | **1.000** | zero profit |
| Withdrawal | 20,000 → 15,000 | −5,000 withdrawal | **1.000** | zero loss |
| Growth alongside a deposit | 10,000 → 22,000 | +10,000 deposit | **1.200** | +20% on the pre-flow base |
| Unclassified change | 10,000 → 11,000 | none recorded | **1.100** | +10%, counted as performance |

**Deposits and withdrawals can never register as profit or loss.** This is the single property the whole level system rests on, and it is asserted directly in the harness.

**Unclassified movement counts as performance** — the default rule from the brief. If the user has not told us a movement was a transfer, we do not invent one. The cost is that an unrecorded deposit reads as a win; the alternative (guessing that large jumps are transfers) would silently erase real profits, which is worse.

The index is floored at `1e-9`: a −100% interval would annihilate it and make every later ratio meaningless.

### Drawdown

Peak-to-current on the **adjusted index**, never on raw wallet value — otherwise a withdrawal would read as a drawdown. Returns `currentDrawdownPct`, `maxDrawdownPct`, `peak`, `peakAt`, `currentIndex`, plus `currentDrawdown` / `maxDrawdown` aliases carrying the identical percent numbers.

A recovery past the old peak clears the current drawdown but not `maxDrawdownPct`.

---

## 4. Recent performance

The last **N = 10** closed trades, measured in **R** (`R = realizedPnl / riskAmount`). The window is a **strategy-level** setting (`preset.recentPerformanceWindow`), not a per-trade one.

Returned: `{ count, wins, losses, winRate, netRPct, avgRPct, streak, expectancy, consistency, sufficient, neutral, stale, returning, winsorisedNetR, winsorisedAvgR, ... }`.

`netRPct` / `avgRPct` express R in percent of 1R: `+2.5R → 250`.

### Consistency — the deterministic definition

A trade is **consistent** when its R lands in the normal band **`[-1R, +2R]`**:

- not worse than −1R → **the stop was respected**
- not better than +2R → **the result did not depend on an outlier**

`consistency` = share of the window inside that band, as a percent. It measures discipline, not profitability: ten disciplined −1R losses score 100% consistency and still fail every other gate.

### Insufficient sample

Below `MIN_SAMPLE_FOR_PERFORMANCE = 5` closed trades, `sufficient: false` and `neutral: true`. Callers **must treat it as NEUTRAL, never as positive**. Three winning trades is not evidence and must not buy size. Because recent performance is a one-way *downward* adjustment (§7), "neutral" and "insufficient" produce the same envelope — there is no upward path to withhold.

### Winsorisation

`WINSOR_R_CAP = +2R`. Every per-trade R is capped at +2R **before** it contributes to level progression. A single +50R trade is luck, size, or a gap — not evidence of skill.

**The downside is deliberately not winsorised.** Bad outcomes count in full. Good luck is capped; bad luck is not.

---

## 5. The risk level (−2 … 5)

| Level | Key | Posture | Meaning |
|---|---|---|---|
| **−2** | `LOCKDOWN` | Defensive | Severe drawdown. Minimal envelope, one position, no leverage. Past a drawdown threshold, no new trades at all. |
| **−1** | `DEFENSIVE` | Defensive | Meaningful drawdown or a losing run. Risk and leverage cut hard so recovery is not attempted with size. |
| **0** | `BASELINE` | Baseline | Starting, unproven state. **Anchored to `DEFAULT_RISK_POLICY`.** Every new account starts here. |
| **1** | `ESTABLISHED` | Earned | A first proven run. |
| **2** | `CONSISTENT` | Earned | Results hold up across a second window. |
| **3** | `PROVEN` | Earned | The sample starts to carry weight. |
| **4** | `SEASONED` | Earned | Sustained discipline over many trades. |
| **5** | `MAXIMUM` | Earned | The cap. The risk **percentage** stops expanding; dollar size still grows with the wallet. |

Levels are earned on **percentage** performance, drawdown, trade count and consistency. **No absolute dollar milestone appears anywhere in the engine.** A $2,000, a $20,000 and a $200,000 wallet with proportionally identical histories produce the identical level and the identical progress — asserted in the harness.

### Level up — ALL nine gates must pass

Promotion advances **at most one level per evaluation**, and only when no demotion fired in the same evaluation.

| Gate | Requirement |
|---|---|
| `TRADES_SINCE_LEVEL` | Closed trades since the last level change ≥ the requirement for the target level |
| `MIN_HISTORY` | ≥ 5 total closed trades |
| `SAMPLE_SUFFICIENT` | Recent window has ≥ 5 trades |
| `POSITIVE_GROWTH` | Winsorised average R ≥ **+0.10R** |
| `ADJUSTED_EQUITY_GROWTH` | Adjusted index ≥ its value at the last level change (skipped when not measurable) |
| `DRAWDOWN_CEILING` | Current drawdown below the target level's ceiling |
| `WIN_RATE_FLOOR` | Win rate ≥ **40%** |
| `CONSISTENCY_FLOOR` | Consistency ≥ **70%** |
| `ACTIVE` | Recent window is not stale |
| `NO_ACTIVE_LOSING_STREAK` | Trailing streak > −2 |

**Trades required, and the drawdown ceiling, per target level:**

| Target level | −1 | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|---|
| Additional closed trades since the last level change | 5 | 5 | **8** | **10** | **12** | **15** | **20** |
| Current drawdown must be below | 25% | 18% | **10%** | **9%** | **8%** | **7%** | **6%** |

The requirement grows with the level and the drawdown ceiling tightens with it: level 5 costs 65 qualifying trades of cumulative history above level 0 and tolerates only a 6% drawdown at the moment of promotion.

`NO_ACTIVE_LOSING_STREAK` was added after the adversarial property test caught a real defect: an account could be promoted in the same evaluation in which the envelope started taking a losing-streak haircut. Being haircut and promoted simultaneously is incoherent. A *single* loss is not a run, so the threshold is −2 — the same point at which the haircut begins.

### Why one huge winner cannot buy a level

Three independent mechanisms, any one of which is sufficient:

1. **Trade count.** A single trade fails `TRADES_SINCE_LEVEL` and `MIN_HISTORY` outright.
2. **Winsorisation.** +50R contributes only +2R to `winsorisedAvgR`. Eight trades of `[+50R, −1R × 7]` give a winsorised average of `(2 − 7) / 8 = −0.625R`, failing `POSITIVE_GROWTH`.
3. **Win rate.** That same book has a 12.5% win rate, failing `WIN_RATE_FLOOR`.

Harness: a single +50R trade leaves the account at level 0 with 6.3% progress.

### Level down — immediate, and can drop several levels at once

Demotion is evaluated **before** promotion and has no grace period.

**Drawdown ceilings** (a hard cap on the level, applied in one evaluation):

| Current drawdown | Level capped at |
|---|---|
| ≥ 8% | 3 |
| ≥ 12% | 1 |
| ≥ 16% | 0 |
| ≥ 20% | −1 |
| ≥ 25% | −2 |

A level-5 account at 20% drawdown lands on −1 in a single evaluation — a six-level drop. Harness: a 14.5% drawdown takes level 5 → 1 in one step.

**Losing-streak demotions** (applied on top of the drawdown ceiling):

| Trailing streak | Levels dropped |
|---|---|
| ≤ −3 | 1 |
| ≤ −5 | 2 |

**Pressure demotions** (each drops one level):

| Trigger | Threshold |
|---|---|
| `OPEN_RISK_PRESSURE` | Consumed open risk > **10%** of adjusted equity |
| `UNREALIZED_LOSS_PRESSURE` | Unrealised losses > **8%** of adjusted equity |

Both thresholds are strategy-neutral on purpose: the level describes the trader, not the preset selected for one trade.

**Bootstrap cap.** Fewer than 5 total closed trades forces the level to at most 0, whatever the record.

### Inactivity never demotes

If no closed trade falls within `INACTIVITY_DAYS = 45` of `now`:

- the earned level is **preserved** — no demotion transition is recorded
- `staleRecentData: true`
- promotion is paused (`ACTIVE` gate fails)
- the envelope takes a **0.75×** conservatism haircut on the risk band

The haircut persists for the first `RETURN_TRADES = 3` trades after a *real* gap in the history. A brand-new account has not returned from anything, so `returning` requires an actual detected gap (`gapFound`) — otherwise STANDARD level 0 would drift out of step with `DEFAULT_RISK_POLICY`, which is the one number the two engines must share.

Drawdown and open-risk pressure demotions still apply while stale: those are live facts about capital, not stale evidence. Streak demotion is suppressed.

### Progress (0–100)

A weighted composite, so the bar reflects what actually has to happen:

| Weight | Component |
|---|---|
| **50%** | Trades since the last level change ÷ the requirement |
| **30%** | Winsorised average R ÷ `PROGRESS_TARGET_AVG_R` (+0.30R) |
| **20%** | Consistency ÷ 100 |

Clamped to 0–100. When every gate is met the bar reads **100**. At level 5 it reads 100 with `tradesToNext: null`.

Because R is winsorised at +2R before reaching this calculation, one outsized winner cannot fill the bar. Within a level, the trades component is non-decreasing as trades accumulate, which is what makes the bar readable — asserted in the harness.

`blockedBy` lists the codes of the gates still failing, so the UI can say *why* the bar is stuck.

---

## 6. Strategy presets and the per-level envelopes

Every number derives from four stated anchors, so the whole table is auditable:

1. **STANDARD level 0 IS `DEFAULT_RISK_POLICY`.** 1% base / 2% max / 6% heat / 4% directional / 200% notional / 30% margin / 3× leverage. This is the contract between the two engines. Asserted field-by-field in the harness.
2. **Earned levels widen the percentage envelope by 10% of the level-0 value per level:** level *n* ≥ 0 multiplies by `(1 + 0.10n)`. Level 5 sits at 1.5× the baseline and **stops**.
3. **Defensive levels are cut hard, not scaled.** −1 is roughly a third of baseline, −2 roughly a seventh, because a defensive level exists to make recovery-by-size *impossible*, not merely discouraged.
4. **AGGRESSIVE is 1.5× STANDARD** on the percentage envelope, with two hard clamps: heat never exceeds **12%** and margin utilisation never exceeds 90%.

Leverage does **not** follow the 1.5× rule. It is set explicitly per level against the liquidation-distance argument in `riskManager.js`: at 3× estimated liquidation sits ~33% away, at 5× ~19.5%, at 6× ~16%.

### STANDARD

| Level | min % | base % | max % | Leverage | Heat % | Notional % | Directional % | Margin util. % | Max open |
|---|---|---|---|---|---|---|---|---|---|
| **−2** | 0.10 | 0.15 | 0.25 | 1.0× | 0.50 | 25 | 0.50 | 10 | 1 |
| **−1** | 0.20 | 0.35 | 0.50 | 1.5× | 1.50 | 50 | 1.00 | 15 | 2 |
| **0** | 0.50 | **1.00** | **2.00** | **3.0×** | **6.00** | **200** | **4.00** | **30** | 4 |
| **1** | 0.55 | 1.10 | 2.20 | 3.0× | 6.60 | 220 | 4.40 | 33 | 5 |
| **2** | 0.60 | 1.20 | 2.40 | 3.5× | 7.20 | 240 | 4.80 | 36 | 5 |
| **3** | 0.65 | 1.30 | 2.60 | 3.5× | 7.80 | 260 | 5.20 | 39 | 6 |
| **4** | 0.70 | 1.40 | 2.80 | 4.0× | 8.40 | 280 | 5.60 | 42 | 6 |
| **5** | 0.75 | 1.50 | **3.00** | 4.0× | 9.00 | 300 | 6.00 | 45 | 6 |

Bold row 0 = `DEFAULT_RISK_POLICY` exactly.

### AGGRESSIVE

| Level | min % | base % | max % | Leverage | Heat % | Notional % | Directional % | Margin util. % | Max open |
|---|---|---|---|---|---|---|---|---|---|
| **−2** | 0.15 | 0.25 | 0.40 | 1.0× | 0.80 | 40 | 0.80 | 15 | 1 |
| **−1** | 0.30 | 0.60 | 0.90 | 2.0× | 2.40 | 80 | 1.80 | 25 | 2 |
| **0** | 0.75 | 1.50 | 3.00 | 5.0× | 9.00 | 300 | 6.00 | 45 | 5 |
| **1** | 0.83 | 1.65 | 3.30 | 5.0× | 9.90 | 330 | 6.60 | 50 | 6 |
| **2** | 0.90 | 1.80 | 3.60 | 5.5× | 10.80 | 360 | 7.20 | 54 | 6 |
| **3** | 0.98 | 1.95 | 3.90 | 5.5× | 11.70 | 390 | 7.80 | 59 | 7 |
| **4** | 1.05 | 2.10 | 4.20 | 6.0× | **12.00** | 420 | 8.40 | 63 | 7 |
| **5** | 1.13 | 2.25 | 4.50 | 6.0× | **12.00** | 450 | 9.00 | 68 | 8 |

Heat at levels 4 and 5 is **clamped at 12%** — the upper end of the honest 6–12% range in the literature (the Turtle lineage permits ~12 units in one direction). Without the clamp the 1.5× rule would produce 12.6% and 13.5%, past anything citable.

**AGGRESSIVE deliberately exceeds the ESMA/FSA-anchored 3× leverage cap that `riskManager.js` uses.** That is the substance of choosing it. It is stated rather than hidden, and the liquidation-distance consequence is stated with it.

### Preset-level differences

| Field | STANDARD | AGGRESSIVE |
|---|---|---|
| `recentPerformanceSensitivity` | **1.0** | **0.6** |
| `confidenceRange` | `{ min: 0, max: 90, neutral: 50 }` | `{ min: 0, max: 100, neutral: 50 }` |
| `recentPerformanceWindow` | 10 | 10 |
| `derivedStop` | `{ basePct: 5.0, minPct: 2.0, maxPct: 12.0 }` | `{ basePct: 7.0, minPct: 2.5, maxPct: 15.0 }` |

`recentPerformanceSensitivity` scales the **severity of the downward haircut**. STANDARD takes it at full strength; AGGRESSIVE at 0.6, which is what "permits more variance" means concretely — it tolerates a bad run without cutting as hard.

`confidenceRange.max = 90` under STANDARD means the top decile of the envelope is **unreachable by confidence alone**. The 2% ceiling at level 0 stays a *ceiling* (max attainable 1.8%) rather than becoming a routine setting. AGGRESSIVE exposes its full band.

---

## 7. Performance haircuts — one-way, downward only

**Recent performance in this engine can only reduce the envelope.** A good run buys nothing immediately; it earns levels, slowly, and the level is what widens the envelope.

This is the design decision that makes the adversarial property (§12) hold: a worsening history can never produce a larger recommended risk percentage, because there is no upward mechanism for it to travel through.

### Performance haircut (multiplicative, applied only when the sample is sufficient)

| Condition | Factor |
|---|---|
| Trailing streak ≤ −2 | ×0.85 |
| Trailing streak ≤ −3 | ×0.70 |
| Trailing streak ≤ −4 | ×0.55 |
| Win rate < 30% | ×0.80 |
| Winsorised average R < 0 | ×0.85 |
| Consistency < 50% | ×0.85 |

Streak tiers are exclusive (deepest applies); the other three combine multiplicatively. The combined raw factor is then scaled by sensitivity:

```
haircut = 1 − (1 − rawHaircut) × recentPerformanceSensitivity
```

### Drawdown haircut (deepest tier only, never scaled by sensitivity)

| Current drawdown | Factor |
|---|---|
| ≥ 5% | ×0.90 |
| ≥ 10% | ×0.75 |
| ≥ 15% | ×0.60 |

Drawdown is capital, not opinion, so the strategy's sensitivity does not soften it.

### Return-from-inactivity haircut

×0.75 while `returning` (see §5).

### What the haircuts touch

**The risk-percent band only** (`minRiskPct`, `baseRiskPct`, `maxRiskPct`). Leverage, heat, notional, directional and margin caps are **structural** and move only with the level — a demotion is what tightens them, which is the point of demotion.

---

## 8. Confidence

The 0–100 slider maps to a risk percentage **inside the envelope**, piecewise linear, anchored so the neutral point maps exactly to `baseRiskPct`:

```
c ≤ neutral :  min  + (base − min) × (c / neutral)
c >  neutral:  base + (max − base) × ((c − neutral) / (100 − neutral))
```

The slider is first clamped to `[0, 100]`, then to the strategy's usable range, then the result is hard-clamped at `envelope.maxRiskPct`.

STANDARD, level 0, no haircuts:

| Confidence | 0 | 25 | 50 | 75 | 100 |
|---|---|---|---|---|---|
| Risk % | 0.50 | 0.75 | **1.00** | 1.50 | **1.80** (clamped at slider 90) |

AGGRESSIVE, level 0: `0.75 / 1.125 / 1.50 / 2.25 / 3.00`.

**Confidence can never:** exceed `envelope.maxRiskPct`, raise leverage, or clear a `NO_TRADE`. The harness asserts that confidence 100 against an exhausted heat budget still returns `NO_TRADE`.

---

## 9. Sizing

### With a technical stop

```
notional = riskBudget / stopDistanceFraction        (riskManager.calculatePositionSize)
maxLoss  = notional × stopDistanceFraction          (equal by construction)
```

**The user's stop is never moved to fit a percentage.** If the resulting notional breaches a cap, the **notional** is reduced and the reduction is reported as a factor. `stop.source: 'TECHNICAL'`.

### Without a technical stop

`maxLossPct` (the risk budget as a share of equity) is already set by level + strategy + confidence. The derived stop distance converts it to a size:

```
derivedStopDistancePct =
  clamp( preset.derivedStop.basePct
         × (1 + 0.05 × max(0, level))
         × (1 + 0.40 × max(0, neutral − confidence) / neutral),
         preset.derivedStop.minPct, preset.derivedStop.maxPct )
```

- **Level widens it 5% per earned level.** A proven account is assumed to be working structure rather than noise. A wider assumed stop means a *smaller* notional for the same dollar risk — a conservative direction of travel.
- **Confidence can only widen it,** never tighten it. Tightening would inflate notional, which is exactly the failure mode confidence must not be able to cause.

`stop.source: 'DERIVED'`, the implied stop price is returned when an entry is known, and a warning states plainly that the distance is an assumption, not a level.

### Leverage

The engine recommends the **lowest leverage that satisfies margin availability** within the cap:

```
marginBudget = min( equity × maxMarginUtilizationPct − marginUsed,  equity − marginUsed )
leverage     = clamp( ceil(notional / marginBudget × 100) / 100,  1,  envelope.maxLeverage )
```

If the required leverage exceeds the cap → `LEVERAGE_CAP` blocker → `NO_TRADE`. If margin is short of the budget within the cap → `MARGIN_INSUFFICIENT` → `NO_TRADE`. **Notional is never reduced to fit margin**, which is what keeps `maxLoss.amount` strictly independent of leverage. Asserted: changing leverage alone (via `request.override.leverage`) leaves max loss and notional unchanged while margin falls monotonically.

---

## 10. Open positions and risk recycling

Two rules most sizing tools get wrong.

### 1. An open position consumes capacity until it is CLOSED

Moving the stop to breakeven does **not** hand the risk budget back. A floor applies:

```
consumedStopRisk = max( riskToStop,  CLOSURE_RESERVE × notional )
CLOSURE_RESERVE = 0.005   (0.5% of notional)
```

A stop is not a guarantee: gaps, thin books and venue outages all price through it. 0.5% matches the maintenance-margin order of magnitude used by `riskManager.js`. Only closing the position frees the capacity fully.

`riskToStop` is direction-aware: a stop beyond breakeven is **zero** risk to the stop, not negative risk, and then the floor applies.

### 2. Unrealised P&L is asymmetric

| | Weight | Funds new risk? |
|---|---|---|
| Unrealised **loss** | **100%**, immediately | — (it *reduces* capacity) |
| Unrealised **gain** | **25%** (`UNREALIZED_GAIN_CREDIT`) toward account health and level progression | **No** |

A gain is a quote; a loss is a fact. Harness: the same position with −$500 open consumes $700 of budget; with +$500 open it consumes $200 and credits $125 of health.

### Directional concentration

Reuses `detectCorrelatedExposure` from `riskManager.js`, fed with **consumed** risk so the closure-reserve floor is respected. Detects the obvious case — several positions pointing the same way (3 longs) or a couple carrying ≥80% of one-way risk.

The label is deliberately **`DIRECTIONAL CONCENTRATION — 3 LONG`**, not "correlated". This engine measures no correlation at all; it counts positions pointing the same way. Claiming a measured correlation would be a false statement about the method, and every returned object carries `note: 'Direction-only. This is a count of same-way positions, NOT a measured correlation.'`

The one-way cap blocks a trade that **adds** to the concentrated side. A trade pointing the other way is not blocked — it reduces the concentration. When the direction is unknown the blocker applies, which is the conservative read.

---

## 11. NO_TRADE — a first-class result

Every blocker carries `{ code, label, current, limit, remedy }` so the UI can render a sentence a person can act on:

> **Open risk over the portfolio heat limit** 6.4% · limit 6% · Available again below 6% — close or reduce an open position.

| Code | Fires when |
|---|---|
| `NO_CAPITAL` | Adjusted equity ≤ 0 |
| `DEFENSIVE_DRAWDOWN` | Current drawdown ≥ **25%** — at every level |
| `LOCKDOWN` | Level −2 **and** drawdown ≥ **20%** |
| `OPEN_RISK_LIMIT` | Consumed open risk ≥ `envelope.maxPortfolioHeatPct` |
| `MAX_OPEN_POSITIONS` | Open count ≥ `envelope.maxOpenPositions` |
| `EXPOSURE_LIMIT` | Notional exposure ≥ `envelope.maxNotionalExposurePct` |
| `DIRECTIONAL_LIMIT` | One-way risk ≥ `envelope.maxDirectionalRiskPct` **and** the trade adds to that side |
| `HEAT_BUDGET_EXHAUSTED` | Clamped risk < `MIN_VIABLE_RISK_PCT` (0.05%) |
| `LEVERAGE_CAP` | Required leverage > `envelope.maxLeverage` |
| `MARGIN_INSUFFICIENT` | Required margin > the margin budget within the cap |
| `STALE_WALLET_DATA` | `account.dataStale === true` → decision becomes `INCOMPLETE` |
| `INCOMPLETE_INPUT` | Wallet unavailable, no positive wallet value, or a wrong-side stop |

**Level −2 without a drawdown trigger is not a block** — it is a *minimal envelope* (0.25% max risk, 1× leverage, one position). Only the 20%/25% drawdown thresholds turn it into an outright refusal.

**Stale or unavailable wallet data returns `INCOMPLETE`, not a confident number.** Unavailable data returns nulls with an explanation; merely stale data still computes the workings but is labelled `INCOMPLETE` with a prominent warning, because the numbers are useful for reference and dangerous as a recommendation.

---

## 12. `recommendTrade` output contract

```js
{
  decision: 'TRADE' | 'NO_TRADE' | 'INCOMPLETE',
  asset, strategy, confidence, level, levelProgress,
  position: { notional, leverage, margin, units|null, entry|null },
  maxLoss: { pct, amount },                                    // pct = % of adjusted equity
  stop:    { price|null, distancePct|null, source: 'TECHNICAL'|'DERIVED'|'NONE' },
  blockers: [ { code, label, current, limit, remedy } ],
  factors:  [ { code, label, direction: 'UP'|'DOWN'|'NEUTRAL', detail } ],
  envelope,
  warnings: [],
  strategyVersion,
  inputsHash,
  detail: { ... }        // full workings: equity curve, drawdown, level state, open risk, liquidation
}
```

`factors` carries **only materially-influencing** entries. A haircut must move the band by more than `FACTOR_MATERIALITY = 2%` before it is reported; a level of exactly 0 with no transitions and no clamps produces an empty `factors` array.

`inputsHash` is an FNV-1a 32-bit fingerprint over a canonical (recursively key-sorted) serialisation of every deterministic input, prefixed `ar1-`. Not cryptographic — an audit fingerprint so a stored recommendation can be tied back to the inputs that produced it.

`now` is taken from `request.now` or `account.now`; when neither is supplied it is **inferred as the latest timestamp anywhere in the account data**. The engine never reads the clock — asserted by a source scan for `Date.now` and `Math.random` in the harness.

---

## 13. Worked example — computed by hand

**Inputs**

| | |
|---|---|
| Wallet | $25,000, no cash flows, one snapshot |
| History | none (brand-new account) |
| Strategy | STANDARD |
| Confidence | 70 |
| Asset | BTC, entry $72,000, stop $69,500 (LONG inferred) |

**Step 1 — level.** 0 closed trades → bootstrap cap → **level 0**. No inactivity gap exists, so no returning haircut.

**Step 2 — envelope.** STANDARD level 0: min 0.50%, base 1.00%, max 2.00%, leverage 3×, heat 6%, notional 200%, margin utilisation 30%. Recent performance is insufficient → NEUTRAL → no haircut. Drawdown 0% → no haircut.

**Step 3 — confidence.** 70 > neutral 50, and 70 ≤ the STANDARD slider cap of 90, so it is used as given:

```
riskPct = 1.00 + (2.00 − 1.00) × (70 − 50) / (100 − 50)
        = 1.00 + 1.00 × 0.4
        = 1.40%
```

**Step 4 — risk budget.** `25,000 × 1.40% = $350`.

**Step 5 — portfolio clamps.** No open positions: remaining heat 6.00%, remaining directional 4.00%. No clamp.

**Step 6 — stop.** Both entry and stop supplied → `TECHNICAL`.

```
stopDistance = (72,000 − 69,500) / 72,000 = 0.0347222 = 3.4722%
```

**Step 7 — size.**

```
notional = 350 / 0.0347222 = $10,080
units    = 10,080 / 72,000  = 0.14 BTC
maxLoss  = 10,080 × 0.0347222 = $350          ✓ equals the budget by construction
```

**Step 8 — notional cap.** 200% × 25,000 = $50,000 headroom. $10,080 fits.

**Step 9 — leverage.** Margin budget = `min(30% × 25,000 − 0, 25,000 − 0)` = **$7,500**.

```
needed   = 10,080 / 7,500 = 1.344
leverage = ceil(1.344 × 100) / 100 = 1.35        (≤ 3× cap)
margin   = 10,080 / 1.35 = $7,466.67             ✓ ≤ 7,500
```

**Step 10 — no-trade gate.** No blockers.

**Result, verified against the code:**

```json
{ "decision": "TRADE",
  "maxLoss":  { "pct": 1.4, "amount": 350 },
  "position": { "notional": 10080, "units": 0.14, "leverage": 1.35, "margin": 7466.67 },
  "stop":     { "price": 69500, "distancePct": 3.4722, "source": "TECHNICAL" } }
```

**Cross-check against the base engine.** At level 0, STANDARD, confidence **50** (risk 1.00%), the same inputs reproduce `riskManager.js`'s own worked example exactly: **$250 risk, $7,200 notional, 0.1 BTC**. That equality is asserted in the harness and is the contract between the two engines.

---

## 14. `evaluatePosition`

**Only ever called explicitly**, on a position the user asks about. It never runs in the background and never volunteers an opinion.

Returns `ADD | HOLD | REDUCE | EXIT`, plus an optional `PROTECT_PROFIT`. Priority, highest severity first:

| Action | Trigger |
|---|---|
| `EXIT` | Stop on the wrong side of entry (no defined risk); or open loss ≤ **−1.5R**; or level −2 lockdown |
| `REDUCE` | Position risk > `maxRiskPct`, or open risk > heat cap, or notional > exposure cap, or leverage > cap |
| `ADD` | Open profit ≥ **+1.0R**, level ≥ 1, open count < `maxOpenPositions`, heat remaining |
| `HOLD` | Everything inside every limit |

**ADD is conservative by construction.** The existing position's risk is treated as **not freed**, so the addition is sized only from the heat that remains, and is further capped at **50%** of the existing notional and at the notional headroom. If any of those leaves nothing, the action degrades to `HOLD`.

### `PROTECT_PROFIT`

Offered at open profit ≥ **+1.0R**. Returns `{ proposedStop, lockedProfit, remainingRisk, source }`.

1. **`TECHNICAL`** — a level supplied on the position (`position.technicalLevel`) always wins, *if* it is behind the current mark and improves on the existing stop. **A technical level is never invented.**
2. **`RULE`** — otherwise, a deterministic profit-locking rule:
   - ≥ **+1.0R** → stop to **entry** (breakeven)
   - ≥ **+2.0R** → lock **half** the open gain

`lockedProfit` is measured from entry to the proposed stop; `remainingRisk` is the give-back from the current mark to the proposed stop.

Every returned `rationale` begins with: *"This is a risk-management output, not a price prediction."* REDUCE does not mean the trade is wrong; it means the position is larger than the account's current risk capacity supports.

---

## 15. `analyzeStrategyPerformance` — proposals only

Groups closed trades along five dimensions — `strategy`, `confidenceBand` (LOW ≤ 33 / MEDIUM ≤ 66 / HIGH), `level`, `leverageBand` (1× / 1–2× / 2–3× / 3–5× / 5×+), `drawdownState` (NORMAL / DRAWDOWN at ≥ 8%) — and computes win rate, winsorised average R, Tharp expectancy, and a drawdown-adjusted average:

```
worstRun               = deepest consecutive losing run inside the group, in R
drawdownAdjustedAvgR   = avgR / (1 + worstRun / 10)
```

Two groups with the same average R are not equally good if one got there through a deeper losing run — that run is what actually forces a demotion.

**It returns proposals. It mutates nothing** — no constant, no preset, no level, no envelope. There is deliberately no function in this module that applies a proposal; that is a human decision made outside it. The harness snapshots `STRATEGY_PRESETS` and `ADAPTIVE_CONSTANTS` before and after an analysis and asserts they are byte-identical.

| Threshold | Value | Why |
|---|---|---|
| `MIN_SAMPLE_FOR_PROPOSAL` | **20** | Below this, trading results are indistinguishable from noise |
| `MIN_SAMPLE_FOR_UPWARD_PROPOSAL` | **30** | Loosening a rule needs more evidence than tightening one |
| `PROPOSAL_BAD_EXPECTANCY_R` | **−0.15R** | Materially a net cost |
| `PROPOSAL_GOOD_EXPECTANCY_R` | **+0.35R** | Materially better than the rest |

Downward proposals suggest a **0.75×** multiplier; upward proposals suggest **1.15×** and always state that they remain capped by the level envelope. Output is sorted by sample size descending, then id, so the order is deterministic.

`confidence` on a proposal is a sample-size label: LOW (20–39), MEDIUM (40–79), HIGH (80+).

---

## 16. Validation

```bash
npm run validate:adaptive     # 247 assertions
npm run validate:risk         #  96 assertions (the base engine, unchanged)
```

Twenty-one sections covering: cash-flow exclusion (deposits, withdrawals, mixed, unclassified); curve chaining and drawdown; recent performance and the consistency band; trade corrections re-deriving history; slow level up; the single-huge-winner case; monotonic progress; multi-level demotion; the level-5 cap; negative levels and lockdown; inactivity; scale invariance; both presets against `DEFAULT_RISK_POLICY`; the confidence map and its clamps; technical / derived / tight / wide stops; open-risk recycling and the unrealised asymmetry; directional concentration; NO_TRADE blockers; leverage invariance; `evaluatePosition` reaching every verdict; learning proposals; determinism and hashing.

**Invariant sweep** — 180 combinations across 3 wallet sizes × 6 levels × 2 strategies × 5 confidences, asserting on every tradeable result:

1. `maxLoss.amount ≤ envelope.maxRiskPct × equity`
2. `notional × stopDistance == maxLoss.amount`
3. `margin × leverage == notional`
4. `leverage ≤ envelope.maxLeverage`

plus a scale-invariance pass asserting every cell produces the identical decision and the identical risk **percentage** at $2k, $25k and $200k.

**Adversarial property test** — across 18 worsening histories (2 strategies × 3 confidences × 3 starting levels), appending losses one at a time and asserting the recommended risk percentage is **never increased**, at any step:

```
STANDARD, level 2, confidence 50, as losses accumulate:
1.200 → 1.200 → 1.020 → 0.770 → 0.605 → 0.550 → 0.421 → 0.421
      → 0.337 → 0.337 → 0.337 → 0.281 → 0.281 → 0.098 → 0.098
```

A second variant with −2R losses drives the drawdown past the defensive threshold and reaches `NO_TRADE`.

**This test found a real defect.** The original implementation allowed an account to be *promoted* on the evaluation where a losing streak first bit — 6 wins then 2 losses crossed the 8-trade requirement while the streak haircut was already applying, and the net effect nudged risk up 0.7%. The `NO_ACTIVE_LOSING_STREAK` gate exists because of it.

---

## 17. Known limitations

| # | Limitation |
|---|---|
| **A1** | **Concentration is direction-only.** It does not know BTC and ETH are correlated but BTC and gold are not. Any two same-direction positions count equally. Inherited from `riskManager.js` and labelled honestly everywhere it surfaces. |
| **A2** | **Unclassified wallet movement counts as performance.** An unrecorded deposit reads as a win and can contribute to a promotion. The default rule from the brief; the alternative silently erases real profits. |
| **A3** | **The level thresholds are not backtested.** They are internally consistent and conservative, but no claim is made that 8/10/12/15/20 trades or a 40% win-rate floor are optimal. They are a survival ladder, not an optimisation. |
| **A4** | **`consistency` conflates discipline with mediocrity.** Ten disciplined −1R losses score 100%. That is intentional — it measures stop obedience, not profitability — but the name invites misreading in a UI. |
| **A5** | **The derived stop is an assumption, not a level.** 5%/7% base distances are plausible for crypto majors on a 4H frame and are not derived from measured volatility. Surfaced as a warning on every derived recommendation. |
| **A6** | **`closureReserve` at 0.5% is an order-of-magnitude choice**, borrowed from the maintenance-margin rate. There is no literature figure for "risk that remains after a breakeven stop". |
| **A7** | **AGGRESSIVE exceeds the ESMA/FSA leverage anchors** that justify `riskManager.js`'s 3× cap. Deliberate and documented, but it means the two presets are not equally well sourced. |
| **A8** | **`analyzeStrategyPerformance` groups one dimension at a time.** It cannot say "AGGRESSIVE at high confidence in a drawdown" — only each factor separately. Cross-tabs would need far larger samples than a single operator will produce. |
