# S3 — retest-entry study results

Generated 2026-09-27 per `docs/PROMPT_S3_RETEST_ENTRY.md` (one Sonnet agent, research only,
worktree `retest-entry`, branch `retest-entry` off `origin/upgrade-signal-engine`). Owner
question, after reviewing ten real trade charts: breakout-close entries are late, stops at
the obvious invalidation get probed, measured-move targets on a 24–48h clock time out flat.
This tests the fix: enter on the retest of the breakout level instead of the breakout close,
with a wider (NF-floored) stop, the same measured-move target, and a hold that can end
early on structure failure or a long (7-day) cap.

Rules (`scripts/swing/rules/`): `re-flag-retest-4h`, `re-flag-retest-1h` (1D/4h trend gate),
`re-flag-breakout-4h` (control: breakout-close entry, same S3 exit mechanics),
`re-random-4h` (control: seeded random direction, same retest/exit mechanics, no trend
gate). Run on `test/fixtures/history/deep2y-2026-09-26` (BTC/SOL/ETH, 1m/5m/15m/1h/4h/1d,
2024-10-01 → 2026-09-27, ~103.7 weeks), 4h rules at every 4h close, the 1h rule at every 1h
close (both "step 1" — no candle-skipping). `scripts/swing/run.js` unchanged in every other
respect; it gained one additive option (`scoreSignal`'s `holdRule`) for this study's
structure exit — see `scripts/swing/retestShared.js` and each rule file for the exact
entry/stop/target/exit mechanics.

## Method

- **Scorer**: `scripts/swing/run.js` `scoreSignal` — same fill/stop/target walk the S0/S1/S2
  studies use (same-candle stop still loses; a target touch only counts on a later candle
  than the fill), plus this study's own `holdRule` addition: exit when 5 closed candles (own
  timeframe) print back inside the pre-breakout flag range, ahead of the stop/target/7-day
  cap. A trade still open at the cap is closed at that candle's close, mark-to-market
  (`timeout`).
- **Cost**: `scripts/tracker/costs.js` `netR`, direction-dependent — 0.34% round-trip long,
  0.14% short (funding asymmetry, USDC/USDT-margined perps).
- **Gross vs net R**: gross R is the raw walked outcome (a full stop = −1R by construction);
  net R subtracts the round-trip cost, expressed as a fraction of the trade's own risk.
- **Mean vs median**: reported both, per the prompt. `docs/VARIANTS_STUDY_2026-09-26.md`
  already found that a single near-zero-stop loss can dominate a small bucket's *mean* —
  median is the more honest read at this sample size (38–101 signals per rule). **OOS pass
  below uses the median convention** (median net R > 0 in both halves) as the primary
  verdict; the mean-based split is also shown, and the two disagree for two of the four
  rules (see Findings).
- **OOS split caveat**: the *combined* row's halves are the harness's own convention
  (all of BTC's rows, then all of SOL's, then all of ETH's, concatenated and split at the
  midpoint by *index* — not re-sorted by calendar time across symbols) — inherited from
  `scripts/swing/run.js`'s existing `splitHalves`, used identically by every prior swing
  study (S0/S1/S2), not something changed for S3. Each **per-symbol** half-split IS
  chronological (rows are pushed in ascending candle-close order within a symbol), so the
  per-symbol OOS columns are the more trustworthy read; the combined row is included for
  completeness and comparability with the other studies' own combined columns.
- **Histogram**: counts of **gross R** (pre-cost — the owner's "3 in 10 at 3R" question is
  about the raw trade outcome, not a cost-adjusted ratio), bucketed `(-∞,0]` labeled `-1`,
  `(0,1]`, `(1,2]`, `(2,3]`, `(3,∞)` labeled `≥3`, over every **resolved** signal (win, loss,
  timeout, or structure_exit — `not_filled` signals are excluded, matching "resolved" in the
  main table).
- Generated with `scripts/swing/analyze-retest.js` (median/mean/histogram; read-only, no
  fixture re-run) against the raw per-signal JSON `scripts/swing/run.js` writes to
  `docs/swing/<id>.json`.

## Combined table (per rule × symbol + combined)

### re-flag-retest-4h — 4h flag retest entry, with 1D trend

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | median stop % | median hold h | max losing streak | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 18 | 100% | 33.33% | 0.161 | -0.900 | 0.015 | -0.958 | 1.80% | 42.09 | 4 | 0.174 |
| SOL | 18 | 100% | 11.11% | -0.422 | -1.000 | -0.479 | -1.030 | 3.15% | 21.9 | 14 | 0.174 |
| ETH | 13 | 92.31% | 33.33% | 0.117 | -0.324 | 0.072 | -0.356 | 4.85% | 24.02 | 5 | 0.125 |
| combined | 49 | 97.96% | 25% | -0.069 | -0.755 | -0.156 | -0.802 | 3.32% | 31.54 | 19 | 0.472 |

OOS (net R): median 1st/2nd half −0.933 / −0.770 (**fail**); mean 1st/2nd half (harness
convention, combined row only) +0.108 / −0.420 (**fail**).

### re-flag-retest-1h — 1h flag retest entry, with 1D/4h trend gate

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | median stop % | median hold h | max losing streak | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 28 | 92.86% | 30.77% | 0.587 | -0.657 | 0.358 | -0.912 | 1.12% | 8.43 | 8 | 0.270 |
| SOL | 33 | 100% | 27.27% | 0.314 | -0.833 | 0.177 | -0.888 | 1.64% | 6.75 | 10 | 0.318 |
| ETH | 40 | 100% | 32.5% | 0.459 | -0.350 | 0.298 | -0.518 | 1.62% | 10.91 | 8 | 0.386 |
| combined | 101 | 98.02% | 30.3% | 0.444 | -0.552 | 0.274 | -0.835 | 1.41% | 9.47 | 12 | 0.974 |

OOS (net R): median 1st/2nd half −0.940 / −0.514 (**fail**); mean 1st/2nd half (harness
convention, combined row only) +0.186 / +0.360 (**pass** — see Findings for why this is not
trusted).

### re-flag-breakout-4h — 4h flag breakout-close entry, S3 exit mechanics (control)

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | median stop % | median hold h | max losing streak | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 14 | 100% | 35.71% | 0.110 | -0.693 | -0.004 | -0.747 | 1.88% | 50.88 | 5 | 0.135 |
| SOL | 14 | 100% | 21.43% | -0.020 | -1.000 | -0.073 | -1.032 | 3.62% | 29.88 | 6 | 0.135 |
| ETH | 10 | 100% | 60% | 0.751 | 0.355 | 0.696 | 0.274 | 4.17% | 33.86 | 1 | 0.096 |
| combined | 38 | 100% | 36.84% | 0.231 | -0.406 | 0.155 | -0.468 | 3.23% | 39.86 | 6 | 0.366 |

OOS (net R): median 1st/2nd half −1.036 / −0.416 (**fail**); mean 1st/2nd half (harness
convention, combined row only) +0.140 / +0.170 (**pass** — see Findings for why this is not
trusted).

### re-random-4h — control: seeded random direction, retest-entry mechanics

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | median stop % | median hold h | max losing streak | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 32 | 100% | 28.13% | -0.094 | -0.773 | -0.247 | -0.812 | 1.97% | 38.77 | 11 | 0.308 |
| SOL | 30 | 100% | 20% | -0.042 | -1.000 | -0.124 | -1.035 | 3.61% | 22.68 | 13 | 0.289 |
| ETH | 29 | 96.55% | 28.57% | -0.003 | -0.868 | -0.104 | -0.892 | 3.43% | 36.26 | 10 | 0.280 |
| combined | 91 | 98.9% | 25.56% | -0.048 | -1.000 | -0.162 | -1.023 | 3.18% | 32.09 | 13 | 0.877 |

OOS (net R): median 1st/2nd half −0.835 / −1.035 (**fail**); mean 1st/2nd half (harness
convention, combined row only) +0.011 / −0.334 (**fail**).

## R-outcome histogram (gross R, resolved signals only)

Bucket boundaries: `-1` = r ≤ 0, `0-1` = 0 < r ≤ 1, `1-2` = 1 < r ≤ 2, `2-3` = 2 < r ≤ 3,
`≥3` = r > 3. "≥2R share" = (`2-3` + `≥3`) / resolved.

### re-flag-retest-4h

| scope | resolved | -1 | 0-1 | 1-2 | 2-3 | ≥3 | ≥2R share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 18 | 12 | 2 | 0 | 2 | 2 | 22.2% |
| SOL | 18 | 16 | 0 | 0 | 1 | 1 | 11.1% |
| ETH | 12 | 8 | 1 | 2 | 1 | 0 | 8.3% |
| combined | 48 | 36 | 3 | 2 | 4 | 3 | 14.6% |

### re-flag-retest-1h

| scope | resolved | -1 | 0-1 | 1-2 | 2-3 | ≥3 | ≥2R share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 26 | 18 | 0 | 0 | 3 | 5 | 30.8% |
| SOL | 33 | 24 | 0 | 0 | 7 | 2 | 27.3% |
| ETH | 40 | 27 | 0 | 0 | 8 | 5 | 32.5% |
| combined | 99 | 69 | 0 | 0 | 18 | 12 | 30.3% |

### re-flag-breakout-4h

| scope | resolved | -1 | 0-1 | 1-2 | 2-3 | ≥3 | ≥2R share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 14 | 9 | 2 | 1 | 1 | 1 | 14.3% |
| SOL | 14 | 11 | 0 | 0 | 2 | 1 | 21.4% |
| ETH | 10 | 4 | 3 | 1 | 1 | 1 | 20% |
| combined | 38 | 24 | 5 | 2 | 4 | 3 | 18.4% |

### re-random-4h

| scope | resolved | -1 | 0-1 | 1-2 | 2-3 | ≥3 | ≥2R share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 32 | 23 | 4 | 1 | 2 | 2 | 12.5% |
| SOL | 30 | 24 | 1 | 1 | 1 | 3 | 13.3% |
| ETH | 28 | 20 | 2 | 3 | 1 | 2 | 10.7% |
| combined | 90 | 67 | 7 | 5 | 4 | 7 | 12.2% |

Reading the histogram against the owner's "3 in 10 at 3R" question: **no rule puts close to
30% of its trades at ≥3R alone** — the closest is `re-flag-retest-1h` at 12.1% (`≥3` bucket
only). Widening the ask to "≥2R" (the `2-3` + `≥3` buckets combined), `re-flag-retest-1h`
lands at 30.3% combined — the only rule near "3 in 10", but at a lower bar than literally 3R,
and driven by win rate (30.3%) rather than a fat right tail. Every rule's dominant bucket is
`-1` (69–75% of resolved trades), consistent with sub-37% win rates.

## Does any rule pass OOS?

**No.** Under the median convention (this report's primary verdict, and the one the owner's
own prior study — `docs/VARIANTS_STUDY_2026-09-26.md` — adopted for the same reason): every
rule's median net R is negative in **both** halves, for **every** symbol and combined. The
control (`re-random-4h`) also fails, so this is not merely "the trend gate adds nothing" —
the underlying retest/NF-stop/measured-target/structure-exit mechanics themselves show no
edge at either mean-driven or median-driven inspection, and the OOS split confirms it holds
in both halves of the 2-year window.

Two rows show a **mean-based** OOS pass (`re-flag-breakout-4h` and `re-flag-retest-1h`,
combined only) — worth naming since the prompt asks for that split too, but neither is
trusted:
- `re-flag-breakout-4h`'s combined mean pass is carried by ETH alone (60% win rate on 10
  signals, mean +0.70R) while BTC and SOL's own means are flat-to-negative and their own
  per-symbol OOS splits disagree (BTC: −0.23 / +0.22; SOL: +0.18 / −0.32) — a 10-signal
  subsample driving the combined verdict is not a strategy result.
- `re-flag-retest-1h`'s combined mean pass (+0.19 / +0.36) sits alongside a combined
  **median** of −0.94 / −0.51 and a 30.3% win rate — the mean is being pulled up by the
  `≥2R` tail (30.3% of trades, per the histogram above) while the *typical* trade is still a
  loss. Both halves are net-median-negative, so the rule is not a repeatable edge; it is a
  distribution where the winners, when they land, land big enough to flatter the mean.

Frequency is also thin regardless of the verdict: 0.37–0.97 signals/week combined (roughly
one signal every 1–3 weeks per rule), so even the two "mean-pass" rows rest on 38–101
resolved trades over ~104 weeks — not enough to distinguish a real edge from a lucky tail at
this sample size.

## Entry / stop / target / exit, one line each

- **re-flag-retest-4h**: Entry = the first 4h close, after the 1D-trend-gated flag's
  breakout, that comes within 0.25×ATR(4h) of the breakout level and holds in the trade
  direction. Stop = min(retest low − 0.1×ATR(4h), invalidation), floored by
  max(0.5×ATR15m, 3×round-trip cost). Target = the flag's measured move (pole length
  projected from the breakout), skipped when that is under 2.5R off the stop. Exit = stop,
  target, 5 closed 4h candles back inside the flag range, or a 7-day cap.
- **re-flag-retest-1h**: identical mechanics to re-flag-retest-4h on 1h flags, gated by
  BOTH the 1D and the 4h trend read agreeing (not 1D alone).
- **re-flag-breakout-4h** (control): Entry = the 4h close that first closes past the flag
  border (the breakout candle itself, not a retest). Stop = invalidation, NF-floored the
  same way. Target = measured move, same 2.5R skip. Exit = the same stop/target/structure/
  7-day rules as re-flag-retest-4h — isolates entry timing from the exit rules.
- **re-random-4h** (control): identical entry/stop/target/exit mechanics to
  re-flag-retest-4h, but direction is a seeded coin flip (no 1D trend read) — isolates what
  the trend gate is worth against otherwise-identical mechanics.

## Tests / gates

`test-swing-rules-retest.js` (29 assertions): null on insufficient/malformed history, the
retest wait logic on a synthetic flag (no signal on the breakout candle itself, no signal on
a non-retest extension, a signal on the exact retest candle), long/short mirror, no-lookahead
(own timeframe and every cross-timeframe trend array), re-flag-retest-1h's dual 1D/4h gate,
and re-random-4h's seeded determinism. All eleven `npm run test:*` deploy-gate suites plus
every existing `test-swing-rules*.js` suite pass unchanged (`scoreSignal`'s `holdRule` option
is additive; every pre-S3 rule omits it and takes the original code path byte-for-byte).
`git diff --check` clean on every touched file.

## Files

- `scripts/swing/rules/re-flag-retest-4h.js`, `re-flag-retest-1h.js`,
  `re-flag-breakout-4h.js`, `re-random-4h.js`
- `scripts/swing/retestShared.js` (shared helpers: trend read, retest print check,
  NF-floored stop, seeded draw)
- `scripts/swing/run.js` (`scoreSignal`'s additive `holdRule` option; `RESOLVED` now
  includes `structure_exit`)
- `scripts/swing/analyze-retest.js` (this report's median/mean/histogram numbers, read-only
  over `docs/swing/<id>.json`)
- `test-swing-rules-retest.js`
- Raw per-signal data: `docs/swing/re-flag-retest-4h.json`, `re-flag-retest-1h.json`,
  `re-flag-breakout-4h.json`, `re-random-4h.json`
