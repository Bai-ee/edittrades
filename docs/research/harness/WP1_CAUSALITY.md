# WP1 — R1 + R1+ causality auditor

Research only. Branch `edge/wp1-causality`, worktree `et-wp1-causality`. No changes to
`api/`, `lib/`, `services/`, `scripts/tracker/`, `public/`. Nothing here fixes a rule —
findings are reported, not patched, per the work package.

Script: `scripts/research/harness/causality-audit.js`. Tests: `test-causality-audit.js`
(26 assertions, all passing). Report/data: `var/research/wp1-causality/{summary.json,REPORT.md}`.

## Method

Freqtrade's `lookahead-analysis` concept (GPL-3.0, concept only, reimplemented from
scratch — `freqtrade/freqtrade` @ `d6c736f`, cited in
`docs/research/EXTERNAL_HARNESS_REFERENCES.md` R1): rerun a decision function with the
data truncated to what was closed at decision time and compare with the full-history
result. The auditor applies this three ways, matched to each interface actually in the
repo:

1. **Windowing regression** (`windowingRegressionCheck`, swing rules) — calls
   `scripts/swing/run.js`'s real `buildCtx` twice: once on the untouched fixture history,
   once on history pre-filtered to `closeTime <= cutMs` for every native timeframe.
   `buildCtx` re-windows internally (`closedWindow`/`firstIndexAfter`) regardless of
   input, so this is a regression test of that windowing logic itself, not of individual
   rule bodies — `buildCtx`'s own contract (`ctx.i === candlesByTf[ctx.tf].length - 1`,
   always) makes an own-timeframe-array leak structurally unreachable through this
   comparison. It gates the PASS/FAIL verdict; a failure here would be a P0 harness bug.
2. **HTF availability** (`htfAvailabilityCheck`) — asserts every candle in every
   `ctx.candlesByTf[*]` closed at or before `ctx.cutMs`. Also gates the verdict.
3. **Own-timeframe defensive-slice probe** (`ownTfProbeCheck`, advisory, does not gate
   the verdict) — appends real future candles onto the end of `ctx.candlesByTf[ctx.tf]`
   while leaving `ctx.i` unchanged, a state `buildCtx` itself can never produce. A rule
   that only ever reads `<= ctx.i` (directly, or by defensively re-slicing to `ctx.i`
   first — the documented pattern in most rules here) is unaffected. A rule that reads
   `array[array.length - 1]` or `array[ctx.i + 1]` without bounding to `ctx.i` sees a
   different candle. Reported separately because it tests a stricter, self-defense
   property than the harness's contract actually promises — a "differs" result here means
   *this rule trusts buildCtx's exactness rather than defending itself*, which is a real,
   worth-flagging pattern (see Finding 1), not proof of an active leak (Mechanism 1 and 2
   already prove no leak reaches this rule today).

The same tamper-and-compare idea, without `buildCtx`, for the other two interfaces:

- **`runSma4h`** (`auditSma4h`): "position at bar `i` unchanged when bars after `i+1`
  are removed" — literal, per the work package. Truncate the typed-array `bars` object to
  `[0, i+2)` and rerun; compare `position`/`sma` at every timestamp `<=` bar `i`.
- **Edge-search families** (`auditFamilyConfig`, `scripts/research/edge/families.js`):
  `signal(ctx, i)` takes an explicit absolute bar index into arrays that are **not**
  re-windowed by the interface itself, so truncating only the tail (removing rows after
  `i`, never touching index `i`'s own position) is a clean, zero-renumbering test of both
  the family's signal function and the shared indicator helpers in
  `scripts/research/edge/lib.js` (`ema`/`sma`/`atr`/`rsi`/`donchian` — all causal
  recurrences by inspection; this is the empirical proof).

Sampling (all three interfaces): every signal point found by a full forward scan, plus an
equal seeded-random count of non-signal points, capped at `--sample-cap` (default 200,
split across symbols then signal/non-signal — see `auditSwingRule`/`auditFamilyConfig`).
Seed 42, deterministic (`mulberry32` + FNV-1a hashing of rule id / symbol / tag).

## Commands

```bash
node scripts/research/harness/causality-audit.js --symbols BTC,SOL,ETH --sample-cap 200 --seed 42
node test-causality-audit.js
```

Fixture: `test/fixtures/history/deep60-2026-09-24` (swing rules; despite the name, native
OHLC depth is ~2 years — 719 1D / 718 4H / 2051 1H candles per symbol, plenty for the
200-candle warm-up gate on every timeframe used here). `runSma4h`: `var/edge/4h-long`
(~20k 4H candles/symbol, 2017–2026). Families: `test/fixtures/history/deep2y-2026-09-26`
(edge/lib.js's own default fixture).

Runtime: full CLI run **141.6s** (2m 22s wall, 17 rules × 3 symbols + `runSma4h` × 3
symbols + 4 family configs). Test suite: ~25s.

## Results — swing rules (all 17, `scripts/swing/rules/*.js`)

| rule | tf | verdict | n sampled | HTF fail | windowing fail | own-tf probe differs / checked |
| --- | --- | --- | --- | --- | --- | --- |
| ctl-4h-range-break | 4h | PASS | 198 | 0 | 0 | 0/197 |
| ctl-donchian-20d | 1d | PASS | 198 | 0 | 0 | 0/198 |
| ctl-ema-pullback-1d | 1d | PASS | 174 | 0 | 0 | 0/174 |
| ctl-random-4h | 4h | PASS | 198 | 0 | 0 | 0/198 |
| legacy-swing | 4h | PASS | 99 | 0 | 0 | 0/99 |
| **legacy-trend4h** | 4h | PASS | 198 | 0 | 0 | **113/198** |
| mr-channel-fade-4h | 4h | PASS | 99 | 0 | 0 | 0/99 |
| mr-random-1h | 1h | PASS | 99 | 0 | 0 | 0/99 |
| mr-rsi-extreme-1h | 1h | PASS | 98 | 0 | 0 | 0/98 |
| mr-zone-touch-1h | 1h | PASS | 198 | 0 | 0 | 0/198 |
| pb-4h-flag-continuation | 4h | PASS | 20 | 0 | 0 | 0/20 |
| pb-channel-edge-4h | 4h | PASS | 110 | 0 | 0 | 0/110 |
| pb-ema21-pullback-1d | 4h | PASS | 80 | 0 | 0 | 0/80 |
| re-flag-breakout-4h | 4h | PASS | 39 | 0 | 0 | 0/38 |
| re-flag-retest-1h | 1h | PASS | 26 | 0 | 0 | 0/26 |
| re-flag-retest-4h | 4h | PASS | 39 | 0 | 0 | 0/39 |
| re-random-4h | 4h | PASS | 28 | 0 | 0 | 0/28 |

**Every rule passes the gating checks** (HTF availability + windowing regression): no
rule, sampled across BTC/SOL/ETH, ever received a future candle through `buildCtx`, and
truncating the fixture to `closeTime <= cutMs` before calling `buildCtx` never changed a
single sampled decision. `n` is lower than the 200 cap for several rules simply because
`MIN_COMPUTE_CANDLES=200` + the fixture's length leaves fewer eligible decision points
than the cap for less-frequent setups (e.g. `pb-4h-flag-continuation`, only 20 eligible
BTC/SOL/ETH points fired the flag-detector combination at all).

## Finding 1 — `legacy-trend4h` does not defend its own timeframe against extra bars (advisory, not an active leak)

`scripts/swing/rules/legacy-trend4h.js:47-59` (`mtfEntry`):

```js
function mtfEntry(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const indicators = calculateAllIndicators(candles);
  return {
    indicators,
    structure: detectSwingPoints(candles, 20),
    candleCount: candles.length,
    lastCandle: candles[candles.length - 1]   // <-- "current" = whatever is last, not ctx.i
  };
}
```

Called as `mtfEntry(candlesByTf['4h'])` (`legacy-trend4h.js:85`, own timeframe) with no
slice to `ctx.i` anywhere in the file. It relies entirely on `buildCtx`'s contract that
`candlesByTf['4h']` is *already* exactly `ctx.i + 1` long. Under the probe (3 real future
4H candles appended, `ctx.i` held fixed), 113 of 198 sampled BTC/SOL/ETH points produced a
**different TREND_4H entry/stop/tp1/tp2** than the correctly-bounded reference — same
direction, different levels (evidence, BTC i=230, `cutMs=2026-07-03T00:00:00Z`):

| | direction | entry | stop | tp1 | tp2 |
| --- | --- | --- | --- | --- | --- |
| reference (bounded) | long | 61923.115 | 59351.01 | 69639.44 | 72211.55 |
| probe (+3 future 4H bars) | long | 62093.145 | 60897.56 | 65679.89 | 66875.48 |

At i=265 the *direction label inside the reason string* also flips ("4h flat" ->
"4h uptrend") — the underlying 4H trend read changes, not just price levels.

**Why this is NOT a live leak today:** Mechanism 1 (windowing regression, gating) passes
for this rule at every sampled point — `buildCtx` never actually hands it more than
`ctx.i + 1` candles in production or in replay, so the array's last element genuinely is
always the decision candle today. **Why it is still worth flagging:** the rule (and the
production code path it mirrors 1:1, `services/strategy.js`'s `TREND_4H` branch via
`evaluateAllStrategies`, per the file's own header) has *no internal defense* — it trusts
every caller to hand it a perfectly-bounded array. `legacy-swing.js` calls the exact same
`mtfEntry` helper on the same `candlesByTf['4h']` array (`legacy-swing.js:116`) and shows
**zero** probe differences (0/99): SWING's decision is dominated by the 1D/3D aggregates
it also builds, so a few stray 4H bars don't move its output, even though the *code
pattern* is identical. TREND_4H is the one strategy whose own decision is driven by that
un-bounded 4H array. Not a fix (out of scope for this WP) — a note that this class of
"trust the caller" pattern exists in a real, production-mirroring rule, and the harness
has no reason to expect it would remain harmless under a future `buildCtx` change.

## Results — `runSma4h` (`scripts/research/edge/sma4h-trend.js`)

| symbol | verdict | sampled | timestamps compared | timestamp-chain (decision→fill→exit) |
| --- | --- | --- | --- | --- |
| BTC | PASS | 200 | 1,931,461 | ok, n=277 trades, 0 violations |
| SOL | PASS | 200 | 1,293,770 | ok, n=217 trades, 0 violations |
| ETH | PASS | 200 | 1,931,461 | ok, n=242 trades, 0 violations |

`position` and `sma` at every bar `<=` the truncation point are byte-identical (float
tolerance 1e-9) whether or not later bars exist, across ~20k-candle BTC/ETH and ~13k-candle
SOL histories (2017/2020–2026). Confirms `sma()` in `scripts/research/edge/lib.js` and
`runSma4h`'s decision line (`bars.c[j-1] > smaArr[j-1]`, decided at close `j-1`, filled at
open `j`) are causal by construction, empirically, not just by code reading.

## Results — edge-search families (sample, `scripts/research/edge/families.js`)

One representative config per family (F1–F4), 200 sampled points each on real BTC bars
(1h/4h/1d, `test/fixtures/history/deep2y-2026-09-26`):

| config | family | tf | verdict | n |
| --- | --- | --- | --- | --- |
| F1-don-1h-N20-k2 | Donchian breakout + chandelier trail | 1h | PASS | 200 |
| F2-tsmom-1d-L20-k2 | Daily time-series momentum | 1d | PASS | 200 |
| F3-mr-1h-rsi2-k1.5 | 1h mean reversion (RSI2) | 1h | PASS | 200 |
| F4-squeeze-4h-k2 | 4h volatility squeeze breakout | 4h | PASS | 200 |

Zero mismatches: `signal(ctx, i)` gives the identical spec whether or not bars after `i`
exist in the array, for all four families and their shared indicator helpers
(`ema`/`sma`/`atr`/`rsi`/`donchian`, `ctx.regime()`'s `lastClosedIdx`-bounded daily read).

## Item 7 — injected leaky fixture (self-test of the auditor)

`test-causality-audit.js` defines two fixture rules directly (not placed under
`scripts/swing/rules/` — that directory is auto-loaded by `run.js`'s glob, so a fake rule
there would risk polluting the real study):

- **leaky**: `signalAt` reads `ctx.candlesByTf[ctx.tf][ctx.i + 1]` directly and bases
  direction on that future candle's close.
- **clean**: bounded strictly to `ctx.candlesByTf[ctx.tf][ctx.i]` / `[ctx.i - 1]`.

Result (`test-causality-audit.js`, section 3, 5 assertions, all passing):

- `ownTfProbeCheck` **catches** the leaky rule (`differs: true` at every sampled point —
  `auditSwingRule` reports `probeDiffer > 0`).
- `windowingRegressionCheck` **does not** catch the same leaky rule
  (`windowFail === 0`) — **by design**, not a gap discovered by accident: both the
  reference and truncated `buildCtx` calls always produce `ctx.i === array.length - 1`,
  so `array[ctx.i + 1]` is `undefined` in both, and `undefined === undefined`. This is
  documented in the code and asserted explicitly in the test, precisely so this known
  limit of Mechanism 1 isn't mistaken for "no leak" in isolation — Mechanism 3 (the
  probe) exists specifically to cover this gap.
- The clean control rule passes both mechanisms with zero differences.

This demonstrates the auditor has teeth for the one bug shape the work package names
("uses bar i+1"), and documents precisely which of its three checks would catch it.

## R1+ sub-items

**HTF availability** (item 2): folded into every swing-rule audit point above
(`htfAvailabilityCheck`, gates the verdict) — 0 violations across 1,675 sampled points
(sum of `n` across all 17 rules) plus the dedicated synthetic-injection test in
`test-causality-audit.js` section 2.

**Timestamp-chain helper** (item 3): `assertTimestampChain(records, stages)` — generic,
tested with a synthetic clean chain (passes), a synthetic out-of-order chain (caught,
evidence: `{from, to, fromMs, toMs}`), and a chain with a missing optional stage (skipped,
not failed). Concrete application: `sma4hTimestampChain(result)` asserts
`decision (prior bar close) <= fill (this bar's open) <= exit` for every `runSma4h` trade
— 736 trades across BTC/SOL/ETH, 0 violations (table above). Swing-rule JSON
(`docs/swing/*.json`) stores `closedThrough` (decision time) per signal but no separate
fill timestamp (fill is implicit in `walkOutcome`'s 1m scan, not persisted) — the helper
is generic enough to apply there once/if a fill timestamp is added to that output; it was
not retrofitted onto `docs/swing/*.json` today since the field doesn't exist to check.

**Label-purge helper** (item 4): `purge(trainRows, validStart, horizonMs, { getTime })` —
drops any training row whose label horizon `[t, t+horizonMs)` extends into or past
`validStart`. 3 tests: normal drop/keep split, inclusive boundary (`t+horizon===validStart`
kept), and a throw on non-finite `validStart`/`horizonMs`. For a future labelled/ML study
only — nothing in this repo trains on labelled rows today.

**Partial-data / dataStatus propagation** (item 5, read-only finding, no engine change):
`services/scalpContext.js:1791-1796` — `dataStatus` is `'unavailable'` only when
`usableSymbolCount === 0`, `'partial'` when `warnings.length > 0`, else `'complete'`.
Wallet reads are explicitly excluded from `warnings` (`scalpContext.js:1811-1823`, comment
at 1808-1810: *"an RPC hiccup on the wallet must not mark otherwise-complete market data
as 'partial'"*) — confirms the CLAUDE.md hard rule ("Unavailable wallet read ≠ zero
balance. Wallet status never changes dataStatus") is implemented exactly as documented, by
reading the code, not just the rule doc. Per-provider partial labels
(`'kraken-partial'`, `'<provider>-partial'`, `'mixed'`) are computed in
`resolveSymbolProvider` (`scalpContext.js:1130-1140`) from which providers actually
returned live data for a symbol, independent of and upstream from the top-level
`dataStatus` field. `lib/freshness.js`'s `assessFreshness` is a separate, narrower gate:
it checks a timeframe's `closedThrough` age against `now` (one interval + grace), fails
closed on missing/unparseable/future timestamps, and explicitly does **not** touch
`dataStatus` (its own header: *"does not change dataStatus... only feeds
lib/flagTradePlan.js's fail-closed gate"*) — it is a plan-eligibility gate, not a data-
completeness signal. No engine change proposed or made.

**External reference** (item 6): `0xpg/crypto-trend-following` @
`4aaa229f5bc9f1b762ba4f6ba5d83c9f5cfef294` (MIT, confirmed via `gh api`, not archived,
last push 2026-08-02). `tests/test_engine.py::TestSignalTiming.test_no_lookahead_in_signal`
tampers every value after a cut bar (`panels['close'].iloc[cut:] *= 3.0`) and asserts the
signal frame up to the cut is unchanged (`pd.testing.assert_frame_equal(..., atol=1e-12)`).
Same tamper-the-tail/diff-the-head pattern independently arrived at here (Mechanism 1/2 for
`runSma4h` and families); no code copied, concept only, worth citing as prior art for the
pattern rather than a new idea. Nothing else in that repo's test suite is future-tampering
specific — the rest is response-function/volatility/blend unit tests, out of scope here.

## Verdict summary

| area | verdict | notes |
| --- | --- | --- |
| 17 swing rules, HTF availability + windowing regression | **PASS**, all 17 | zero leaks reaching production through `buildCtx`, sampled 1,675 points across BTC/SOL/ETH |
| `legacy-trend4h` own-tf defensive-slice probe | **ADVISORY FINDING** | no active leak; undefended reliance on `buildCtx`'s contract for its own 4H array — see Finding 1 |
| `runSma4h`, 3 symbols | **PASS** | positions/SMA at bar `i` invariant to truncating bars after `i+1`, ~5.2M comparisons total |
| 4 edge-search family configs (F1–F4) | **PASS** | `signal(ctx,i)` and lib.js indicators invariant to tail truncation |
| Injected leaky fixture (item 7) | **CAUGHT** by the probe, **missed** (by design, documented) by the windowing check | proves the auditor's teeth and its documented blind spot in one test |
| HTF availability, timestamp chain, label-purge, partial-data finding, external reference | done | items 2–6 |

No engine code, rule code, or docs outside this WP's own report/tests were changed.
