# Owner decisions — 2026-09-24

Source: `docs/PLAN_T6_COMPLETION_V2.md` (T6 completion plan, reviewer-consolidated).
Continues `docs/OWNER_DECISIONS_2026-09-23.md`'s numbering (item 4 there is now 4a).

| # | Question | Answer | Why it matters |
| --- | --- | --- | --- |
| 4b | **Scope of `room_at_entry` vs. the TP1 cap** (T6 completion plan A7, raised after Step A: should `lib/flagTradePlan.js`'s geometry-room checks read only the candidate's own mapped geometry timeframe, matching decision 4a's scope for the qualifier's `room:blocked`?) | **Split.** `room_at_entry` (a zone sitting directly on the entry price, which rejects the plan outright) now reads only the candidate's own mapped geometry timeframe (`geometryTimeframeFor(candidate.timeframe)`) — same scoping as 4a, so a zone on a farther timeframe can never reject a 1m/3m/5m flag's plan outright. The **TP1 cap** (`nearestEdge`, which caps `tp1` to the nearest zone edge ahead of entry) **keeps reading every geometry timeframe, unchanged** — a 4h level ahead is exactly the kind of major S/R the owner's "major S/R overrides" rule means to cap a target at; 4a only ever scoped the qualifier's noise-reduction check, not target capping. | Decision 4a's own text said "own timeframe only" but did not distinguish a plan's own hard rejection (`room_at_entry`) from where its target gets capped (`nearestEdge`) — two different geometry reads inside the same `nearestRoomAhead` helper, now scoped differently on purpose. |
| D-cost | **Venue cost assumption to plan around** (T6 completion plan B2; D3 recorded the real Jupiter Perps fee research 2026-09-24). Options: **0.14%** (collateral matches the traded asset, holds under 1h) / **0.20%** (shipped default, `risk.feeBps`+`slippageBps`) / **0.34%** (a long funded with USDC - an extra swap in and out). Reviewer recommendation: 0.14% if you fund positions with the traded asset itself, else 0.20%. | **Direction-dependent: long 0.34%, short 0.14%** (positions are funded from USDC/USDT, so only a long pays the extra swap in and out). Fallback 0.20% for a call whose direction is unresolved. Modeled in `scripts/replay-rules.js` as `netR_sensDir` (per-call, using each call's own `direction`), reported as the `dir-cost` column in `docs/GOOD_QUALITY_REPLAY.md`'s Step B table, recomputed from the existing `var/replay-rules/*.calls.jsonl` raw output (no re-sweep needed - a pure post-hoc arithmetic pass over each call's own already-computed entry/stop/direction). Not added to production `risk` config - reporting only, as asked. | Every net-R number in this doc and `docs/GOOD_QUALITY_REPLAY.md` is reported at all three; which one is "real" for you decides which variant's net edge to trust. |
| D-variant | **Which rule variant to run live, and the frequency floor to judge it against** (T6 completion plan B2; results: `docs/GOOD_QUALITY_REPLAY.md` "Step B"). State a floor first (e.g. ≥ 0.5 GOOD/hour combined, or ≥ 3 conditional/day), then the best-expectancy variant that clears it ships. Data: V-A/V1c/V-D are net-identical (+0.84R, 0.047 GOOD/hr, 0.26 ready/hr) - **the net gate is currently redundant**, see `docs/GOOD_QUALITY_REPLAY.md`'s Step B headline finding. V-C (+15m/1h) is the only variant that meaningfully raises frequency (1.05 ready/hr, 1.68 conditional/hr, 0.069 GOOD/hr, 1.67/day) at the cost of a thinner net edge (+0.53R) and a negative OOS second half. V-B (gross minRR 2.5) has the best net edge of any variant (+1.10R) but needs a **separate, explicit sign-off** since it lowers the shipped 3R gross floor - a hard rule this plan does not lower without one. Reviewer recommendation: keep the net gate on (harmless, not currently binding, a real backstop if the regime shifts) rather than remove it for a code simplification that saves nothing today; the frequency vs. edge trade-off between staying at V1c-equivalent (+0.84R, thin volume) and V-C (+0.53R, ~4-12x the visibility) is the real decision - state your floor and I'll ship whichever clears it. | **Floor answered: ≥3 conditional/day combined; GOOD/hr reported, no GOOD floor.** Every variant tried already clears this floor - the mechanical best-expectancy pick was V-B (+1.010R dir-cost), but V-B's gross-floor change needed its own sign-off. **Final decision: stay on V1c live; run V-B as a shadow instead of shipping it.** Revisit 2026-10-07, n >= 20 scored plans each side (V1c live vs V-B shadow); if V-B still beats V1c on net expectancy out of sample, the owner signs the gross minRR 2.5 rule change then. | Sets what actually goes live in Phase 1's next deploy (or a follow-up config change if V1c's shipped config should change). |

## Implementation

`lib/flagTradePlan.js`'s `nearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry)`:
- `touchesEntry` (drives `reasonCode: 'room_at_entry'`) - computed from `ownGeometry` only, the single geometry-context entry at `geometryTimeframeFor(candidate.timeframe)`.
- `nearestEdge` (caps `tp1`/`tp2`) - unchanged, still scans every timeframe in `geometryContext`.

Mirrors `lib/candidateQualifier.js`'s `roomBlockedReasons` (decision 4a) exactly for the
timeframe-selection logic, applied to a different (but analogous) geometry read.

## D-variant implementation — V-B engine-side shadow

`lib/flagTradePlan.js`'s `buildFlagTradePlan` takes an optional `shadowVariants` list;
`services/scalpContext.js` passes `[{id: 'vB', minRR: 2.5}]`. Each variant re-attempts
the same candidate pool with `flagPlan.minRR` overridden - same ATR, same candles, same
retest-hold rule as the live plan, no tracker-side approximation - and publishes
`shadow.<id>` only when that variant's outcome differs from the live plan. Not in the
default payload (stripped by `filterSymbol` even when no `include` is given at all);
visible only with `include=model`; always captured in the served-call record
(`lib/servedCalls.js` records the pre-filter payload) for the tracker.
`scripts/tracker/vb-shadow.js` scores it (one row per candidateId, first `ready` close,
walked via `walkShadow`, same D-cost dir-cost model); `build-page.js` renders it as its
own tile beside the breakout-entry shadow tile. Schema 1.22.0 → 1.23.0 (additive).
Cannot backfill - only accrues from calls captured after this ships (code committed,
not yet synced to the tracker repo or deployed as of this write-up).

## MISS_004 — failed tracked flag → opposite-side scout (owner-approved 2026-09-24)

**Rule (owner, verbatim intent):** when a tracked long flag fails by acceptance below its execution-timeframe invalidation, the engine immediately opens a SHORT SCOUT on the same symbol: a conditional plan whose entry is the failed support retested from below and rejected (mirror of retest-hold), stop above the reclaim, TP1 = first real support below, gross ≥ 3R required to leave SCOUT; never GO IN without the rejection close. Mirror for failed shorts (LONG SCOUT). State ladder to publish: TRACKING → WARNING (first structural support lost) → FAILED (acceptance beyond invalidation) → SCOUT (opposite side, no entry) → CONFIRMATION (broken level fails to reclaim) → ACTIVE (room to next real support ≥ 3R) → TP INTO SUPPORT (no continuation assumption).

**Fixture:** BTC 2026-09-24, 1m/3m/5m/15m, window 13:30–18:00 UTC. Long flag rejected at 84,866.50, 84,600 lost, 84,375 lost, flush low 83,348.90 on the 14:45 UTC 15m candle, then recovery to ~84,900. Expected: long FAILED at the acceptance-below close; SHORT SCOUT opened the same close; CONFIRMATION on the failed reclaim of 84,600 from below; ACTIVE only with ≥ 3R to the next support; TP1 hit before the recovery; a fresh short at 17:49 UTC (3m confirmed, breakout 84,113.50, TP1 83,930.50, 0.535R) stays rejected `rr_below_min`. Candles: tracker repo `data/candles/{1m,5m,15m}.jsonl` (10-min captures cover the window); engine `test/fixtures/misses/MISS_004.json` follows the MISS_003 format. Mirrored short→long fixture required.

**Placement:** first fixture and acceptance gate of T6 Phase 2 (state model + reversal scouts). Not before Step C ships.
