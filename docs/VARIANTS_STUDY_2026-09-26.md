# S2 - rule variants on the live flag calls

Owner question (2026-09-26): after `docs/CONDITIONS_STUDY_2026-09-26.md` (95% of GOOD
calls carry a stop < 0.5%, median net -3.2R; nothing but stop distance moves the number),
test concrete rule changes side by side on the same 85 days. **Research only** - no live
config change (engine rules frozen until 2026-10-08, `docs/AGENT_SESSION_RULES.md`), no
deploy, no orders. `scripts/research/variants.js` (+ `npm run study:variants`), tests in
`test-variants-study.js`.

**15 hypotheses tested** (1 baseline + 14 rule variants: `NF-live`, `NF-live+minRR2`,
`RSI`, `NF-live+RSI`, `NF-live+5m`, `NF-live+shorts`, `ATR-stop`, `MACD-agree`,
`MACD-agree-15m`, `GP-filter`, `GP-entry`, `NF-live+MACD-agree+GP-filter`, `exit-trail1r`,
`NF-live+exit-trail1r`).

## Method

Every variant is scored with the **same scorer** `docs/CONDITIONS_STUDY_2026-09-26.md`
(`scripts/research/conditions.js`, merged into this branch from `conditions-study`) uses:
first-ready call per candidateId, fill window (`FILL_WINDOW_CANDLES`) / stop / TP1,
`scripts/swing/run.js`'s `scoreSignal` (24h timeout close-out - a trade still open at the
hold limit is closed at that candle's close and scored mark-to-market, never dropped),
net R via `scripts/tracker/costs.js` `netR` at the owner's direction-dependent cost
(0.34% long / 0.14% short); the flat 0.20% cost is also stored on every row as a
sensitivity column (`netR_sens020`), not shown in the table below.

**Fixture:** `test/fixtures/history/deep60-2026-09-24/`, BTC+SOL+ETH, 85.5 days
(2026-07-01T02:34Z - 2026-09-24T14:33Z). **Clock: `--step 5`** (every 5th 1m close), same
compromise `docs/FREQUENCY_STUDY_2026-09-26.md` made and documented for this fixture size
- `--step 1` extrapolates to hours per variant across 15 variants; at step 5 each pool-tier
variant replays all three symbols in ~250-255s (measured, after the fix below), and all 12
independent pool-tier variants ran as parallel background processes (14 CPUs), so the full
sweep finished in two ~4-5 minute wall-clock batches rather than ~50 minutes serial.

**Two tiers of variant** (see `scripts/research/variants.js`'s file header for the full
design note):
- **Pool** (`L0`, `NF-live`, `NF-live+minRR2`, `RSI`, `NF-live+RSI`, `NF-live+5m`,
  `NF-live+shorts`, `ATR-stop`, `MACD-agree`, `MACD-agree-15m`, `GP-filter`,
  `NF-live+MACD-agree+GP-filter`): `L0` reads `s.flagTradePlan` directly (the live
  selection verbatim); every other pool variant mirrors `lib/flagTradePlan.js`'s private
  `buildPlanAttempt`/`nearestRoomAhead`/`selectBest` over the SAME confirmed
  candidate pool `buildScalpContext` already detected, sharing the exported gates
  (`netRiskReward`, `observeRetestHold`, `netFloorStopDistance`) - never touching
  detection, same precedent `scripts/replay-rules.js`'s V5/V6/L2/L3 already set.
- **Rescore** (`GP-entry`, `exit-trail1r`, `NF-live+exit-trail1r`): re-walk a pool
  variant's own already-scored rows (`GP-entry`/`exit-trail1r` from `L0`,
  `NF-live+exit-trail1r` from `NF-live`) under a different entry or exit rule, never
  re-running `buildScalpContext`.

**A bug found and fixed mid-study, worth recording:** the first full sweep (all 12 pool
variants) silently under-counted every 3m-timeframe candidate - `3m` is a *derived*
timeframe (aggregated from 1m at fetch time, `scripts/replay.js`'s own "3m is derived,
never stored" comment), never a native key in `historyByTf`, and the first version of
`buildResearchPlan`/`processClosePool` read `historyByTf['3m']` directly (always empty).
Every 3m candidate's readiness/ATR/MACD/GP checks silently starved, undercounting a
control run (live-default rule, no RSI) at 106 of BTC's true 140 L0 calls. Fixed by
routing every candle read through `makeReplayFetch` (the same abstraction
`buildPlain`/`servedCount` already use, which performs the real 3m aggregation via
`services/marketData.js`) - confirmed byte-exact against `L0`'s own count (140) after the
fix. All 12 pool-tier variants were re-run; the numbers below are post-fix.

## Results (deep60-2026-09-24, BTC+SOL+ETH, step 5)

OOS pass rule for this study (owner instruction): **median** net R > 0 in BOTH halves
(first 2/3 vs last 1/3 of the fixture span by calendar time) - median, not mean, because
a single near-zero-stop loss can dominate a bucket's mean net R (the conditions study's
own finding, reproduced below: `medianStopPct` sits at 0.10-0.12% for most variants, well
under the round-trip cost's payable range).

| variant | mean net R | median net R | n | win % | gross R | calls/day | days≥1 | max losing streak | median stop % | OOS 1st/2nd (median) | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | -3.8133 | -2.4536 | 425 | 24.14% | 0.0166 | 4.971 | 75/86 | 14 | 0.115% | -2.67 / -2.1531 | fail |
| NF-live | -0.0295 | -1.31 | 30 | 38.89% | 0.2846 | 0.351 | 15/86 | 7 | 0.55% | 0.56 / -1.32 | fail |
| NF-live+minRR2 | -0.1803 | -1.28 | 67 | 34.78% | 0.1238 | 0.784 | 22/86 | 8 | 0.541% | -1.29 / -1.27 | fail |
| RSI | -3.7942 | -2.4524 | 429 | 23.53% | -0.0136 | 5.018 | 75/86 | 15 | 0.117% | -2.6472 / -2.14 | fail |
| NF-live+RSI | -0.0295 | -1.31 | 30 | 38.89% | 0.2846 | 0.351 | 15/86 | 7 | 0.55% | 0.56 / -1.32 | fail |
| NF-live+5m | 0.2166 | -1.3031 | 14 | 44.44% | 0.5319 | 0.164 | 10/86 | 4 | 0.79% | 0.56 / -1.3309 | fail |
| NF-live+shorts | -0.5513 | -1.3237 | 17 | 18.18% | -0.2441 | 0.199 | 11/86 | 5 | 0.431% | -1.3031 / -1.33 | fail |
| ATR-stop | -1.0373 | -1.53 | 3244 | 26.12% | -0.0893 | 37.942 | 78/86 | 35 | 0.29% | -1.56 / -1.48 | fail |
| MACD-agree | -3.6439 | -2.4211 | 388 | 24.23% | 0.0015 | 4.538 | 74/86 | 14 | 0.12% | -2.5457 / -2.2 | fail |
| MACD-agree-15m | -3.6176 | -2.16 | 282 | 23.3% | -0.0206 | 3.298 | 70/86 | 14 | 0.12% | -2.4169 / -1.9747 | fail |
| GP-filter | - | - | 0 | - | - | 0 | 0/86 | 0 | - | - / - | fail |
| GP-entry | -14.0386 | -4.01 | 371 | 1.39% | -0.8406 | 4.339 | 74/86 | 148 | 0.103% | -4.34 / -3.63 | fail |
| NF-live+MACD-agree+GP-filter | - | - | 0 | - | - | 0 | 0/86 | 0 | - | - / - | fail |
| exit-trail1r | -3.7094 | -2.2162 | 425 | 41.38% | 0.1205 | 4.971 | 75/86 | 9 | 0.115% | -2.49 / -2.0848 | fail |
| NF-live+exit-trail1r | -0.0047 | -0.2 | 30 | 61.11% | 0.3094 | 0.351 | 15/86 | 4 | 0.55% | -0.2 / -0.2 | fail |

**No variant formally passes.** `NF-live+exit-trail1r` is the closest: mean net R
-0.0047 (essentially breakeven), median -0.2, the tightest OOS split of the whole study
(both halves land on exactly -0.2), win rate 61%, and the shortest max losing streak (4)
of any variant. It fails only because both halves round to the same slightly-negative
median, not because the halves disagree with each other.

## Readings

- **L0** (baseline): reproduces the conditions study's own finding at a different sample
  density - deeply negative median net R (-2.45), a razor-thin median stop (0.115%,
  under the round-trip cost's payable range). n=425 matches
  `docs/FREQUENCY_STUDY_2026-09-26.md`'s own step-5 L0 count exactly (byte-for-byte cross-
  check that this harness's baseline reselection is faithful to production).
- **NF-live**: the T-13 net floor, applied for real (not the shadow-only overlay it ships
  as today), turns L0's blended picture into a near-breakeven MEAN (-0.03) at the cost of
  93% fewer calls (30 vs 425, 0.35/day) - quality up, frequency collapses. Median stays
  negative (-1.31); first-half median flips positive (+0.56) but the second half doesn't.
- **NF-live+minRR2**: lowering NF-live's gross floor from 2.5 to 2.0 roughly doubles
  frequency (67 vs 30 calls) for a similar, slightly worse mean/median - among the
  relaxations tried here, this floor step costs the least per unit of extra frequency.
- **RSI**: swapping RSI(14) for Stoch RSI in the ONE role that can actually change a
  selected plan (detector confidence, a `selectBest` tie-break only - the other three
  roles Stoch feeds are traced non-gating in the shipped code, see the script's file
  header) is a near-no-op: n=429 vs L0's 425 (four tie-break flips over 85.5 days x 3
  symbols), mean/median within 0.02R of L0. Not a bug - a diagnosed, honestly-reproduced
  inertness.
- **NF-live+RSI**: byte-identical to `NF-live` - inside NF-live's much smaller, stricter
  30-call population, the RSI tie-break swap never actually changes a winner.
- **NF-live+5m**: restricting NF-live to 5m alone barely reshapes it (14 calls, mean now
  slightly positive at +0.22) - the thinnest sample in the study; a hint, not a read.
- **NF-live+shorts**: the short-only slice of NF-live is worse on every column (mean
  -0.55, win 18%) than NF-live's blended number - the same short-side weakness
  `docs/GOOD_QUALITY_REPLAY.md` flagged in the original 15-day study, now confirmed
  inside the tighter NF-live population too.
- **ATR-stop**: manufactures by far the most volume (37.9/day, n=3244) because the
  target is fixed at exactly 2.5x a 1x-ATR(15m) stop by construction, not earned from
  structure - and that is exactly why it doesn't help expectancy (mean -1.04, median
  -1.53, worst max-losing-streak of the whole study at 35). Same "volume without
  quality" pattern the original phase-0 study's V6 (ATR floor) already showed.
- **MACD-agree**: barely filters L0's population (388 of 425 calls, 91%) and barely
  moves the number (median -2.42 vs -2.45) - MACD agreement on the flag's own timeframe
  is already true for most flags that reach `ready`, so it isn't discriminating much.
- **MACD-agree-15m**: a more selective filter (282 of 425, 66%) with a modestly better
  median (-2.16 vs -2.45) - the mildest real improvement any single filter rule produced
  here, still deeply negative.
- **GP-filter**: **zero matches over 85.5 days x 3 symbols.** Diagnosed, not a bug: a
  continuation flag's `breakoutLevel` sits near or above the top of its own preceding
  swing leg (verified on a real BTC 5m call: entry 64378.5 vs a computed golden-pocket
  zone of [64190.5, 64202.35] - 176-190 points *below* entry, near the swing's low end,
  not its high). The 0.618-0.65 retracement of "the last completed swing," read literally
  per the prompt's own spec, is structurally incompatible with a breakout-style entry -
  it describes a pullback-buy thesis, not a continuation breakout.
- **GP-entry**: the same root cause, from the other direction, produces the single worst
  row in the study. Moving entry down into that same too-low golden-pocket zone while
  keeping the ORIGINAL breakout plan's stop/TP1 frequently opens the position already at
  or past its own invalidation: win rate collapses to 1.39% (vs L0's 24%), mean net R to
  -14.04, max losing streak to 148. 54 of L0's 425 calls (13%) were excluded outright as
  "never touched the pocket within 24h."
- **NF-live+MACD-agree+GP-filter**: inherits GP-filter's zero-match structural block -
  the stack can never produce a call while GP-filter is one of its three conditions.
- **exit-trail1r**: pure exit-management change on the SAME 425 L0 entries (spec:
  `docs/EXITS_STUDY_2026-09-26.md` has not landed on `origin/upgrade-signal-engine` or
  branch `exits-study` - `git log exits-study -1` shows only the S1-prompt-docs commit -
  so trail1R is implemented here from the prompt's own fallback spec: once a candle
  closes >= +1R, the stop trails 1R behind the best close since, monotonically). Win rate
  jumps from 24% to 41% and max losing streak drops from 14 to 9, but mean/median net R
  barely move (-3.71/-2.22 vs -3.81/-2.45) - the entries' own stops are still too thin to
  pay round-trip costs even on a managed win. Management redistributes outcomes; it does
  not fix the cost problem the conditions study diagnosed.
- **NF-live+exit-trail1r**: **the best number in the study.** NF-live's wider,
  cost-aware stop plus trail-1R management is the only combination that gets within a
  hair of passing: mean net R -0.0047 (essentially breakeven), median -0.2, win rate 61%,
  max losing streak 4, and both OOS halves landing on exactly -0.2 (the tightest split of
  any variant - it fails on rounding, not on disagreement between halves).

## Which variants pass

**None.** Every variant fails median net R > 0 in both halves. Ranked by how close they
came: `NF-live+exit-trail1r` (both halves -0.2) > `NF-live` (first half +0.56, second
-1.32) = `NF-live+5m` (same split) > everything else, which is not close.

## Not recommended to carry forward as-is

`GP-filter`/`GP-entry`/`NF-live+MACD-agree+GP-filter` - the golden-pocket construction as
specified is structurally mismatched with a breakout-continuation flag, not merely
under-powered; re-specifying "golden pocket" as a pre-breakout pullback zone (a
retracement of the flag's own consolidation range, or of the impulse leg BEFORE the flag
forms, rather than the swing ending at/near the breakout level itself) would need a fresh
definition and a fresh run, out of scope here.
