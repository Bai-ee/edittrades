# Breakout-close shadow entry — replay results (T4 P4)

**Status: PROVISIONAL.** Measured on the same development-only dataset as
`docs/FLAG_PATHS_BASE_RATES.md` (`test/fixtures/history/deep-2026-09-24/`, 15 days,
BTC/SOL/ETH). Nothing here changes a threshold, gate, `minRR`, the 3% scalp stop guard,
`flagTradePlan`, or `flagRecommendation` class. Definitions: `docs/PLAN_FLAG_PATHS.md`
"P4 - More opportunities". Shadow-mode contract: `docs/PLAN_FLAG_PATHS.md`, this thread's
task, `symbols.<SYM>.breakoutEntry`.

Last updated: 2026-09-24.

## What was measured

For every one of the **5,558** flags in the P0 dataset that broke out (a closed candle
beyond `breakoutLevel`), taking the breakout candle's own close as a candidate entry:

- **shadow entry** (`lib/breakoutEntry.js` / `scripts/tracker/breakout-entry.js`): entry
  = breakout close, stop = invalidation, tp1 = measuredTarget, gated on `grossRR >=
  flagPlan.minRR` (3.0) and stop distance `<= scalp.maxStopDistancePct` (3%) — the exact
  production rule. Run twice: **gated** (only rows whose approximated `pathOutlook.chase`
  is `elevated`/`high` — what production would actually publish) and **ungated** (every
  breakout that clears the RR/stop gates, chase filter removed, to see what the filter
  itself is buying).
- **retest-hold comparison entry** on the *same rows*: entry = `breakoutLevel` (not the
  breakout close), stop = invalidation, tp1 = measuredTarget, same RR/stop gates,
  published only when the row's own `retestAt` shows a retest touch actually occurred —
  the shape `flagTradePlan.js`'s `ready` retest-hold entry approximates on this dataset.

Both walked forward on 1m candles for 24h (`walkShadow`, prefilled at the known entry
price — no fill-window search, same convention as `scripts/tracker/walk-outcome.js`'s
`ready_prefilled`). `chase` is approximated from `config/engine.json`'s
`pathOutlook.broken` table using the row's own already-computed features — the same
backoff/classification `lib/pathOutlook.js` applies (see `scripts/replay-breakout-entry.js`'s
header for why this is a documented duplication, not an import).

**Net expectancy** substitutes each win's fee/slippage-adjusted reward (`netRR`, fixed at
entry from `config/engine.json`'s `risk.feeBps`/`slippageBps`, same formula
`flagTradePlan.js` uses) for its gross `r`; a loss is still counted as `-1`. This
understates the true net cost on a stop-out (round-trip fees are paid on a loss too, not
only a win) — net numbers below are, if anything, optimistic.

Reproduce:

```
node scripts/replay-paths.js --history test/fixtures/history/deep-2026-09-24 --out /tmp/paths.jsonl
node scripts/replay-breakout-entry.js --rows /tmp/paths.jsonl --history test/fixtures/history/deep-2026-09-24 --json /tmp/breakout-entry-report.json
```

## Results

5,558 breakout rows evaluated, 24h window. `fill` is always 100% for both entry types —
both are prefilled at a known price, never a zone search.

| Entry | n published | % of breakouts | resolved | win rate | gross expectancy | net expectancy | max losing streak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shadow, chase-gated (production rule) | 772 | 13.9% | 770 | 19.35% | **+0.156R** | **-0.653R** | 25 |
| Shadow, ungated (chase filter removed) | 1,237 | 22.3% | 1,201 | 22.48% | **+0.217R** | **-0.495R** | 28 |
| Retest-hold comparison (same rows) | 1,206 | 21.7% | 1,167 | 28.88% | **+0.525R** | **-0.354R** | 26 |

By timeframe:

| Entry | tf | n | win rate | gross | net |
| --- | --- | --- | --- | --- | --- |
| Shadow, gated | 1m | 652 | 19.69% | +0.200R | -0.660R |
| Shadow, gated | 3m | 87 | 17.24% | -0.087R | -0.662R |
| Shadow, gated | 5m | 33 | 18.18% | -0.078R | -0.489R |
| Shadow, ungated | 1m | 899 | 21.64% | +0.219R | -0.572R |
| Shadow, ungated | 3m | 209 | 24.24% | +0.168R | -0.390R |
| Shadow, ungated | 5m | 129 | 26.13% | +0.280R | -0.134R |
| Retest | 1m | 793 | 30.32% | +0.629R | -0.412R |
| Retest | 3m | 239 | 26.32% | +0.345R | -0.307R |
| Retest | 5m | 174 | 25.32% | +0.302R | -0.156R |

By chase bucket (shadow entry only; `chase=low` never appears in the gated table by
construction — the production rule excludes it):

| chase | n (ungated) | win rate | gross | net |
| --- | --- | --- | --- | --- |
| low | 465 | 28.07% | **+0.317R** | -0.234R |
| elevated | 277 | 19.57% | +0.021R | -0.614R |
| high | 495 | 19.23% | +0.231R | -0.674R |

## Findings

1. **Net expectancy is negative for every variant, including the established
   retest-hold comparison entry.** At the current fee/slippage config (5 bps + 5 bps
   round trip) and this dataset's typically tight scalp stops, fees eat most or all of
   gross edge. This is not new — `docs/GPT_INSTRUCTIONS.md` already opposes a call on
   `net_rr_low` for the same reason — but it applies with full force to a breakout-close
   entry, which has no better gross edge to spend against it (see next point).
2. **The breakout-close shadow entry is strictly worse than the existing retest-hold
   entry on gross expectancy, win rate, and max losing streak, on the same rows.**
   Gross: 0.156R/0.217R (shadow) vs 0.525R (retest). Win rate: ~19-22% vs 28.88%. This
   is consistent with the P0 base rates (`docs/FLAG_PATHS_BASE_RATES.md`): retest_go is
   the *entry-quality* path by definition, and a breakout-close entry gives that up in
   exchange for not missing runners — but runners resolving fast and big (median 3.1R,
   ~2 min) does not by itself make the *entry price* (the breakout close, already extended
   past the level) a good one once fees and the 3% stop cap are applied.
3. **The chase filter, as approximated here, is not selecting for better shadow-entry
   economics — the opposite.** `chase=low` rows (excluded from the gated/production rule
   by design) have the *best* gross expectancy of the three buckets (+0.317R), while
   `chase=elevated` (included) has the *worst* (+0.021R, barely positive) and
   `chase=high` (included) sits in between (+0.231R). The chase field was designed to
   flag *missed-entry risk* (a runner without a retest), not to price a breakout-close
   entry's own edge, and this result shows those are two different questions — the
   current gate should not be read as a quality filter for this entry type.
4. **Max losing streaks are long (19-29 losses in a row) for every variant** on a single
   15-day, one-regime window (same caveat `docs/FLAG_PATHS_BASE_RATES.md` already
   states: one top-down regime, three correlated symbols, not independent trials).
5. Fill is trivially 100% for both entry types (both are prefilled at a known price) —
   this is a property of the walk, not a finding about entry quality.

## Recommendation

**Do not promote the breakout-close entry to a real, executable entry type.** Net
expectancy is negative under the current fee model, gross expectancy is materially worse
than the retest-hold entry already in production, and the chase-based gate does not
correlate with better economics for this specific entry type. Shadow mode is the correct
call the plan already made (`docs/PLAN_FLAG_PATHS.md` P4: "It changes how trades are
decided, so it waits for the testing window to end and for owner approval") — this
result is a reason to keep waiting, not a reason to accelerate.

Suggested next steps, all measurement, no execution change:

- Keep `symbols.<SYM>.breakoutEntry` live in shadow mode and let the tracker accumulate
  real (not replayed) outcomes across more than one regime before revisiting.
- If a second entry type is reconsidered later, `chase=low` breakouts merit their own
  look — they have the best gross expectancy here specifically *because* they are the
  breakouts least likely to run away without a retest, i.e. the ones closest to a normal
  retest-hold entry already. That is a different, narrower idea than "publish an entry
  for the flags most likely to run," which this rule currently does.
- Net expectancy is negative across the board partly because these are tight scalp
  stops relative to a 5+5 bps round-trip cost; re-examine the fee/slippage assumptions
  or minimum stop distance for this entry type specifically before any future promotion
  discussion — not by lowering `minRR` or the stop cap globally (CLAUDE.md hard rules).

## Caveats

- Same dataset caveats as `docs/FLAG_PATHS_BASE_RATES.md`: one 15-day window, one
  top-down regime, three correlated symbols, Kraken candles (not TradingView).
- `chase` here is *approximated* from the row's own bucketed features against the
  `pathOutlook.broken` table — the same classification `lib/pathOutlook.js` applies, but
  reimplemented in the replay script rather than reconstructing a full production
  payload per row (see `scripts/replay-breakout-entry.js`'s header).
- The shadow and retest-hold trial pools are *not* an identical row set (772/1,237
  shadow vs 1,206 retest) — both are drawn from the same 5,558-row universe but gated
  differently (shadow: RR/stop from the breakout close; retest: RR/stop from
  `breakoutLevel`, requires an observed retest). The comparison is directional, not a
  matched-pairs test.
- Net expectancy understates true net cost on a stop-out (see "What was measured").
- No geometry-based TP1 capping (`lib/flagTradePlan.js`'s `nearestRoomAhead`) is applied
  to either entry here — both use `measuredTarget` as-is, per the shadow-mode contract.
