# Frequency study — 2026-09-26 (T-10, Agent F2, research only)

Owner question (2026-09-26): the live rules produce ~1.3 GOOD calls/day (4 in 3 days,
tracker report 2026-09-26). He wants ~10/day. Which rule relaxations get there, and what
do they cost in expectancy? **Research only** — no live config change (engine rules
frozen until 2026-10-08, `docs/AGENT_SESSION_RULES.md`), no deploy, no push. Everything
here runs in worktree `frequency-study`, branch `frequency-study`.

## Method

- **Runner:** `scripts/replay-rules.js` (`VARIANTS`, `setConfigOverride`, the new
  `gate: 'ruleVariant'`), same production pipeline (`scripts/replay.js`'s
  `buildAt`/`replaySymbol`, no lookahead) the T6 phase-0 study used
  (`docs/GOOD_QUALITY_REPLAY.md`).
- **Baseline (F2-1):** the live config as deployed, `configVersion 2026.09.24-5`. One-line
  diff against on-disk `config/engine.json`: `flagPlan: {minRR: 2.5, entryToleranceAtr:
  0.1, minNetRR: null}`, `flag.timeframes: ["1m","3m","5m"]` — matches the prompt's stated
  baseline ("gross minRR 2.5, net gate off, room-blocked on the candidate's own
  timeframe, retest-hold readiness") exactly, confirmed against
  `docs/OWNER_DECISIONS_2026-09-24.md`'s "D-variant revised" entry. **One correction**:
  the prompt's "alert timeframes 3m/5m" does not correspond to any engine gate on disk —
  `flag.timeframes` (what actually determines which candidates can ever reach `ready`) is
  already `1m/3m/5m`. "3m/5m" is `lib/telegram.js`'s `DEFAULT_ALERT_TIMEFRAMES`, a
  Telegram push-notification preference; reading `diffAlerts` shows the **GOOD** alert
  (line ~2742, the thing this harness scores) is **never** filtered by
  `prefs.alertTimeframes` — only `BREAKOUT`/`WATCH`/`TRIGGERING` are (`tfAllowed`, line
  ~2731). `L0` is therefore a byte-for-byte alias of the pre-existing `V0` (confirmed by a
  new test in `test-replay-rules.js`); `L4` ("alert/plan timeframes 1m+3m+5m") has no
  override to add and scores byte-identical to `L0` (also confirmed by test) — see the
  no-op note below.
- **Data:** `test/fixtures/history/deep60-2026-09-24/` (its `manifest.json` now exists —
  capture completed since `docs/GOOD_QUALITY_REPLAY.md` was written). Span
  2026-07-01T02:34Z → 2026-09-24T14:33Z, **85.5 days**, BTC/SOL/ETH, 1m backfilled from
  Kraken trades beyond the native OHLC window (same `--backfill-1m` method the original
  15-day `deep-2026-09-24` fixture used).
- **Clock: `--step 5`, not `--step 1`.** A single-symbol, single-day timing probe measured
  ~7.3–9.7 ms/close on this machine; step 1 over 85.5 days × 3 symbols extrapolates to
  ~45 minutes of wall-clock **per variant** (~6.75 hours for all 9) — does not fit this
  session. At step 5, each variant replayed 66,597 closes in ~625–650 seconds of CPU time
  (~9.4–9.7 ms/close, confirming the probe); running the 9 variants as parallel background
  processes (14 CPUs available) finished the full sweep in **~11 minutes wall-clock**.
  Per F2-3's own allowance ("else `--step 5` and say so") — said so.
- **Scoring:** first `ready` close per `(symbol, candidateId)`, walked 24h with the
  production fill rules (`walkOutcome`, `prefilled: true`). **Net R uses the owner's
  D-cost decision** (`docs/OWNER_DECISIONS_2026-09-24.md`): direction-dependent,
  0.34% round-trip for a long (USDC-funded), 0.14% for a short — `netR_sensDir` in the
  table below. The shipped flat 0.20% cost is reported as a sensitivity figure alongside
  it. Gross R:R gate (`flagPlan.minRR`) and the 3% scalp stop cap apply to every variant,
  as they do in production.

### Variants (F2-2)

| Id | Change | Mechanism |
| --- | --- | --- |
| L0 | Live baseline (alias of V0) | `override: null` — on-disk config verbatim |
| L1a | **Owner rule change**: gross minRR 2.25 (was 2.5) | `flagPlan.minRR` override |
| L1b | **Owner rule change**: gross minRR 2.0 (was 2.5) | `flagPlan.minRR` override |
| L2 | **Owner rule change**: room-blocked (`room_at_entry`) is WAIT, not a hard reject — TP1 capped at the blocking zone's far edge instead | new `gate: 'ruleVariant'`, `opts.roomWait` |
| L3 | **Owner rule change**: readiness on the breakout close itself, retest-hold off | new `gate: 'ruleVariant'`, `opts.breakoutClose` |
| L4 | **No-op** in this harness: alert/plan timeframes 1m+3m+5m | `flag.timeframes` already 1m/3m/5m; GOOD is not alertTimeframes-filtered (see above) |
| L5 | L1a + L2 | minRR 2.25 override + `opts.roomWait` |
| L6 | L1a + L2 + L4 (L4 is a no-op → scores identically to L5) | same as L5 |
| L7 | L1b + L2 + L3 + L4 — the "everything" bound | minRR 2.0 override + `opts.roomWait` + `opts.breakoutClose` |

`L2`/`L3`/`L5`/`L6`/`L7` needed a **new gate**, `gate: 'ruleVariant'`
(`buildRuleVariantPlan`/`evaluateRoom`/`observeBreakoutClose`/`makeRuleVariantCollector`
in `scripts/replay-rules.js`), because the room-block hard-reject and the retest-hold
readiness rule live inside `lib/flagTradePlan.js`'s private `buildPlanAttempt` —
`setConfigOverride` cannot reach either. This mirrors the exact precedent `V5`
(`buildStructurePlan`)/`V6` (`buildAtrFloorPlan`) already set: an alternative
construction over the same detected candidate pool, sharing `finalizePlan`'s gross/net/
stop-cap gates, never touching detection. **No variant was left unexpressed** — this is
the "code change" bucket F2-6 asks about, and the code change (a new script-only gate)
is already made, in the research harness only, not in `lib/`.

## Results — full 85.5-day sweep

| Variant | n | resolved | win % | gross exp R | **net exp R (dir-cost)** | 0.20% sens | max losing streak | **GOOD/day** | days ≥ 1 | days ≥ 5 | days ≥ 10 | OOS (first / second half, flat-cost) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | 425 | 421 | 30.9% | 0.563 | **−7.560** | −8.828 | 13 | **4.97** | 75 | 34 | 12 | −13.79 / −2.57 → fail |
| L1a | 522 | 518 | 32.1% | 0.498 | **−6.570** | −7.543 | 15 | **6.11** | 76 | 39 | 21 | −11.57 / −2.43 → fail |
| L1b | 685 | 681 | 34.7% | 0.458 | **−5.416** | −6.059 | 15 | **8.01** | 78 | 47 | 26 | −9.26 / −2.10 → fail |
| L2 | 368 | 366 | 29.8% | 0.521 | **−8.740** | −10.155 | 15 | **4.30** | 75 | 36 | 6 | −14.89 / −3.50 → fail |
| L3 | 912 | 908 | 32.9% | 2.433 | **−41.213** | −33.935 | 14 | **10.67** | 77 | 69 | 40 | −47.53 / −8.78 → fail |
| L4 | 425 | 421 | 30.9% | 0.563 | **−7.560** | −8.828 | 13 | **4.97** | 75 | 34 | 12 | −13.79 / −2.57 → fail (identical to L0) |
| L5 | 455 | 453 | 31.1% | 0.465 | **−7.558** | −8.631 | 17 | **5.32** | 77 | 41 | 13 | −12.85 / −3.15 → fail |
| L6 | 455 | 453 | 31.1% | 0.465 | **−7.558** | −8.631 | 17 | **5.32** | 77 | 41 | 13 | −12.85 / −3.15 → fail (identical to L5) |
| L7 | 1862 | 1858 | 35.3% | 1.760 | **−24.161** | −20.779 | 14 | **21.78** | 78 | 78 | 76 | −30.14 / −5.60 → fail |

Total distinct days in the span: 85.5. No variant passes the T6-method OOS rule (net > 0
in both halves) — every variant's second half is closer to breakeven than its first, but
none crosses zero.

## Data-quality flag: mean net expectancy is outlier-dominated

Every variant's mean net R is far more negative than its median, and far more negative
than the same fixture's own recent slice (below). All figures in this diagnostic use the
flat 0.20% cost convention (`netR`/`netExpectancyR`), for one consistent basis across the
with/without-outliers comparison. Diagnostic — removing calls with
`stopDistancePct < 0.02%` (a near-zero entry-to-stop distance, which explodes `costR`
since cost is fixed as a % of entry and risk is the denominator):

| Variant | outlier calls (of n) | mean net R with outliers | mean net R without | median net R (all) |
| --- | --- | --- | --- | --- |
| L0 | 23 / 425 | −8.83 | −1.86 | −2.10 |
| L1a | 25 / 522 | −7.54 | −1.81 | −2.07 |
| L1b | 26 / 685 | −6.06 | −1.67 | −1.90 |
| L2 | 26 / 368 | −10.16 | −2.30 | −2.54 |
| L3 | 125 / 912 | −33.93 | −2.45 | −2.89 |
| L5/L6 | 28 / 455 | −8.63 | −2.21 | −2.40 |
| L7 | 184 / 1862 | −20.78 | −2.49 | −2.70 |

The worst individual outliers are on BTC (near $85–90k, where a one-cent invalidation gap
rounds to `stopDistancePct: 0.000`), dated in the **July–August** portion of the 85.5-day
window (e.g. 2026-08-02, 2026-07-26, 2026-07-18) — outside the 15-day window the original
`docs/GOOD_QUALITY_REPLAY.md` study covered. `L3` (readiness on breakout close, no
retest-hold) is hit hardest — dropping the retest-hold filter roughly 5x's the outlier
count (125 vs ~25 elsewhere) because retest-hold's `stopBreached` check (T6 completion
plan A3) is exactly the mechanism that screens out a thin/degenerate stop before a plan
can go `ready`; `L3` deliberately turns that screen off. **Even with outliers excluded,
every variant's mean and median net R stay negative** (−1.7 to −2.9R) — this is not
purely an outlier artifact, it is a real, if smaller, negative-expectancy read on this
window that the original 15-day study (positive net expectancy) did not see. Whether this
reflects a genuinely different regime in the pre-September portion of the backfilled data
or a data-quality issue specific to `deep60`'s older backfilled candles was not
diagnosed further (out of scope for a frequency study, and fixing it — if it is a
detector or backfill issue — is a `lib/`/`scripts/replay.js` change this worktree's hard
rules do not permit). **Flag for the owner**: treat mean net-expectancy R on `deep60` as
directional only until this is checked; win rate, gross expectancy, and the frequency
columns are far more robust to it.

## Cross-check: last ~15.3 days of the same fixture (2026-09-09 06:22Z onward)

The window the original `docs/GOOD_QUALITY_REPLAY.md` study covered, re-cut from the same
`deep60` raw output (no re-run needed) as a same-fixture sanity check against the
outlier-heavy full period:

| Variant | n | GOOD/day | win % | net exp R (dir-cost) | 0.20% sens | days ≥ 1 (of 16) | days ≥ 5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | 110 | 7.17 | 34.6% | −2.40 | −1.88 | 16 | 8 |
| L1a | 133 | 8.67 | 34.6% | −2.27 | −1.84 | 16 | 9 |
| L1b | 184 | 11.99 | 36.5% | −1.96 | −1.60 | 16 | 10 |
| L2 | 90 | 5.87 | 31.5% | −3.61 | −2.88 | 15 | 8 |
| L3 | 189 | 12.32 | 33.2% | −3.12 | −2.56 | 16 | 13 |
| L5/L6 | 116 | 7.56 | 32.2% | −3.28 | −2.66 | 16 | 10 |
| L7 | 413 | 26.92 | 36.3% | −3.25 | −2.55 | 16 | 16 |

Two things worth naming plainly: **(1)** even the baseline `L0` already replays at
~5–7 GOOD/day on this fixture — well above the ~1.3/day the tracker reports live, and
above the original 15-day study's own ~1.1/day (which was measured under the *old*,
stricter `minRR 3.0`; the live config dropped to `2.5` on 2026-09-24, per
`docs/OWNER_DECISIONS_2026-09-24.md`'s "D-variant revised" entry — a real, dated rule
change, not a replay artifact). That gap (replay ≈5–7/day vs. observed live ≈1.3/day
under the same nominal config) is itself worth the owner's attention, separately from
which further relaxation to pick — this study cannot diagnose it further (no network
access to check what `configVersion` is actually live right now, no access to production
logs). **(2)** the outlier-driven mean net R swings are much smaller here (the worst
outliers are concentrated in July–August, mostly outside this window) but every variant
is still net-negative.

## Reading

**Reaching ≥5/day and ≥10/day (full 85.5-day sweep):** every variant beats 5/day in
`daysWithGoodAtLeast5` terms only partially — `L0`/`L4` clear 5+ on 34 of 85.5 days (40%),
`L1a` on 39, `L2` on 36, `L1b`/`L5`/`L6` on 41–47, `L3` on 69, `L7` on 78 (of 85.5, i.e.
nearly every day). By the simpler "average GOOD/day" framing the owner asked in: `L1b`
(8.01/day) is the first single-rule change to clear ~8/day; only `L3` (10.67/day, retest-
hold off) and `L7` (21.78/day, the everything bound) clear the owner's stated ~10/day on
average. `L2` alone (room-wait) is the weakest lever here — it *lowers* frequency
slightly versus baseline (4.30 vs 4.97/day) because removing the hard room-block reject
does not on its own unlock new candidates as often as it re-caps existing ones tighter
(a tighter TP1 more often fails the gross-RR gate than the old hard reject removed);
its combos (`L5`/`L6`) only reach ~5.3/day, riding on `L1a`'s minRR relaxation, not on the
room change itself. `L1a`/`L1b` (pure minRR relaxations) are the most linear levers:
each 0.25 step down in minRR adds roughly 1–1.5 GOOD/day.

**What it costs:** every variant, including the live baseline, is net-negative on this
window at every cost convention tried (dir-cost, flat 0.20%, with or without the
near-zero-stop outliers) — there is no free relaxation here, only degrees of already-
negative expectancy getting more negative as frequency rises. Ranked by dir-cost net
expectancy (least negative to most): `L1b` (−5.42) > `L1a` (−6.57) > `L0`/`L4` (−7.56) ≈
`L5`/`L6` (−7.56) > `L2` (−8.74) > `L7` (−24.16) > `L3` (−41.21, worst of all — the
retest-hold screen it removes is doing real work filtering out thin, cost-unpayable
stops, per the outlier table above). Concretely: `L1b` alone is both the cheapest
relaxation tried (least negative net R, tied for best win rate at 34.7%) and gets to
8/day — closer to the 10/day target than `L2`'s room change, at a lower expectancy cost
than either retest-hold change. Reaching the full ~10–22/day range requires `L3` or `L7`,
both of which turn off the retest-hold screen and pay for it heavily in exactly the
failure mode `docs/GOOD_QUALITY_REPLAY.md` originally built the net gate to catch (thin
stops relative to fixed round-trip costs) — `L3` alone has 125 of 912 calls (14%) in the
near-zero-stop-distance outlier bucket, nearly 5x every other variant's rate. No
recommendation to change rules is made here; the owner decides.
