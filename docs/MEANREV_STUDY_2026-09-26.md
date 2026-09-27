# S1 Agent D - mean-reversion-at-zones study

Owner question (docs/PROMPT_S1_EDGE_SEARCH.md, "D - mean-reversion at zones"): is there a
new signal family with an edge, distinct from the flag-entry family that showed none on
July-Sep 2026. Four rule modules on the shared `scripts/swing/rules/*.js` contract
(docs/PROMPT_S0_SWING_RESEARCH.md), run via `npm run swing:study` against
`test/fixtures/history/deep60-2026-09-24` (BTC/SOL/ETH, 85.5 days of 1m coverage).
Combined rows only, copied out of the harness's own run (see "Method" below) - the shared
`docs/SWING_STUDY_2026-09-26.md` and its reading section are untouched by this file.

## Combined rows (all three symbols)

| rule | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mr-zone-touch-1h | 114 | 108 | 58.33% | 0.4105 | -0.4727 | -0.1918 | 9 | 1.3 | 0.39% | 9.33 | -0.3341 | -0.6113 | fail |
| mr-channel-fade-4h | 0 | 0 | - | - | - | - | 0 | - | - | 0 | - | - | fail (no signals) |
| mr-rsi-extreme-1h | 47 | 45 | 22.22% | -0.1654 | -0.5206 | -0.5358 | 15 | 5.52 | 0.523% | 3.85 | -1.0762 | 0.0109 | fail |
| mr-random-1h (control) | 5476 | 5267 | 34.4% | 0.0019 | -0.4735 | -0.3913 | 29 | 3.85 | 0.58% | 448.33 | -0.5665 | -0.3804 | fail |

## Entry / stop / target, one line each

- **mr-zone-touch-1h**: entry = 1h close inside a 1h (or 15m) horizontal S/R zone with the 4h+1D lean opposing the move; stop = zone edge ∓ 0.5x ATR(1h); TP1 = midpoint of the nearest opposing zone, or 2R when none exists.
- **mr-channel-fade-4h**: entry = 4h close at the *counter-slope* edge of a detected channel (upper edge of a rising channel -> short, lower edge of a falling channel -> long); stop = edge ± 0.5x ATR(4h); TP1 = mid-channel (no TP2).
- **mr-rsi-extreme-1h**: entry = 1h close with RSI14(1h) < 25 (long) or > 75 (short) while price sits inside any horizontal S/R zone; stop = entry ∓ 1x ATR(1h); TP1 = EMA21(1h), only taken when it is on the profitable side of entry.
- **mr-random-1h (control)**: entry = every 1h close, seeded (RANDOM_SEED=1337) random long/short, no condition; stop = entry ∓ 1x ATR(1h); TP1 = entry ± 2R.

## Reading

None of the three real rules clears net-positive in both OOS halves; none beats the
seeded random control on net expectancy. Two findings worth flagging beyond the flat
"fail" column:

1. **mr-zone-touch-1h has a real gross edge that costs eat entirely.** 58% win rate and
   +0.41R gross (n=108) is the strongest raw signal quality of anything in this study -
   but its stops are tight (median 0.39% of entry, an ATR(1h)-scaled distance), so the
   fixed 0.34%/0.14% direction cost consumes most of a win's R. Net exp R (-0.4727) lands
   within 0.001R of the *random* control's net exp R (-0.4735) despite a completely
   different gross profile - the edge is real on paper and economically dead at this
   symbol/venue's cost structure. A rule with this gross/net gap is a management-and-cost
   question (S1 agents B/C), not a selection question this family can fix alone.
2. **mr-channel-fade-4h never fired.** Zero signals across all three symbols over the
   full 60-day window, not a small-n result - the harness never found a detected channel
   (`lib/geometry.js` `channel()`) whose live edge disagreed with its own slope
   (`positionPct` >= 85 while rising, or <= 15 while falling) at the same instant. Every
   channel this fixture's real data produced had price sitting at the *with-trend* edge
   (the case `pb-channel-edge-4h`, S0-B, already covers) whenever one was detected at all
   - confirmed by direct inspection of `channel()` output across all three symbols'
   full 4h history (32-104 detections per symbol, all at positionPct consistent with the
   channel's own slope, none at the counter-slope edge). This is itself evidence against
   M-4's fade setup as stated, at least in this window: the condition it describes is not
   just unprofitable here, it is close to non-existent. A longer history (S1 agent H,
   `deep2y-2026-09-26`) is the natural next check before concluding the setup does not
   exist at all.
3. **mr-rsi-extreme-1h is both small-n and net-negative.** 47 signals combined (3.85/week)
   is too thin to trust the OOS split (2nd half reads net-positive at +0.01R but on very
   few trades); the RSI-extreme condition alone, even filtered to a zone touch, is rare
   and did not show a usable edge here.

Overall: the mean-reversion-at-zones family does not show a deployable edge on this
60-day window either, but for a different reason than the flag family - not "no gross
edge exists" (mr-zone-touch-1h clearly has one), but "the gross edge does not survive
this venue's direction costs at the stop distances the zone geometry naturally produces."
That is a distinct, actionable finding from "no edge anywhere."

## Method

`npm run swing:study -- --rules mr-zone-touch-1h,mr-channel-fade-4h,mr-rsi-extreme-1h,mr-random-1h --out-md <scratch path>`
was used to avoid rewriting the shared `docs/SWING_STUDY_2026-09-26.md` (which the full,
all-rules run - `npm run swing:study` with no `--rules` filter - regenerates for every
rule file present under `scripts/swing/rules/`, per that file's own header). The four
per-rule JSON outputs (`docs/swing/mr-*.json`) are committed as usual; the combined rows
above are copied verbatim from that run's own table, not recomputed.

## Contract notes (docs/PROMPT_S0_SWING_RESEARCH.md)

- `meta.tf` enum is documented as `'4h'|'1d'`; three of these four rules are 1h. Checked
  `scripts/swing/run.js` end to end for `'1h'`: `INTERVAL_MS['1h']` (services/scalpContext.js),
  `NATIVE_TIMEFRAMES` (derived from `TIMEFRAMES` minus `DERIVED_INTERVALS`, which is only
  `{'3m'}` - `'1h'` is native), and `GEOMETRY_TIMEFRAMES` (`['15m','1h','4h']`) all already
  include `'1h'`; the fixture ships `<SYM>_1h.json`. `npm run swing:study` ran all four
  rules (including the two 1h ones) with no errors and produced correct per-symbol/
  combined stats (see table above) - **no changes to `scripts/swing/run.js` were needed.**
- Every rule module in `scripts/swing/rules/` (including this study's four) is
  self-contained on `ctx.candlesByTf` (+ `ctx.i`/`ctx.symbol`) - none read
  `ctx.geometry`/`ctx.topDown`/`ctx.indicatorsByTf`, which the harness builds from the
  real pipeline but which no rule module actually depends on (confirmed by inspection of
  every existing `scripts/swing/rules/*.js` file before writing these four). `ctx.geometry`
  also only carries Geometry A (horizontal zones, ATR, EMA slope) for its three
  timeframes, not Geometry B (diagonals/channel/confluence) - `pb-channel-edge-4h`
  computes channel geometry directly from `lib/geometry.js` for the same reason. This
  study's rules follow the same pattern: `mr-zone-touch-1h`/`mr-rsi-extreme-1h` compute
  zones via `lib/geometry.js` `swingPivots`/`horizontalZones`/`atr` (read-only import,
  plus one `config/engine.js` constant - `geometry.zoneToleranceAtr` - also read-only);
  `mr-channel-fade-4h` reuses `pb-channel-edge-4h`'s exact geometry call shape
  (`swingPivots`/`fitDiagonal`/`channel`/`atr`); the 4h/1D "lean" `mr-zone-touch-1h` needs
  is a documented local re-derivation of `lib/topDown.js` `buildWeeklyLean`'s own method,
  matching `scripts/swing/run.js`'s own harness-local `leanFrom()` for the identical
  reason (`topDown.js` exports no non-weekly lean). Nothing else in the contract was
  missing for this family.
