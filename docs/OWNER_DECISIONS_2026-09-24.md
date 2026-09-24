# Owner decisions — 2026-09-24

Source: `docs/PLAN_T6_COMPLETION_V2.md` (T6 completion plan, reviewer-consolidated).
Continues `docs/OWNER_DECISIONS_2026-09-23.md`'s numbering (item 4 there is now 4a).

| # | Question | Answer | Why it matters |
| --- | --- | --- | --- |
| 4b | **Scope of `room_at_entry` vs. the TP1 cap** (T6 completion plan A7, raised after Step A: should `lib/flagTradePlan.js`'s geometry-room checks read only the candidate's own mapped geometry timeframe, matching decision 4a's scope for the qualifier's `room:blocked`?) | **Split.** `room_at_entry` (a zone sitting directly on the entry price, which rejects the plan outright) now reads only the candidate's own mapped geometry timeframe (`geometryTimeframeFor(candidate.timeframe)`) — same scoping as 4a, so a zone on a farther timeframe can never reject a 1m/3m/5m flag's plan outright. The **TP1 cap** (`nearestEdge`, which caps `tp1` to the nearest zone edge ahead of entry) **keeps reading every geometry timeframe, unchanged** — a 4h level ahead is exactly the kind of major S/R the owner's "major S/R overrides" rule means to cap a target at; 4a only ever scoped the qualifier's noise-reduction check, not target capping. | Decision 4a's own text said "own timeframe only" but did not distinguish a plan's own hard rejection (`room_at_entry`) from where its target gets capped (`nearestEdge`) — two different geometry reads inside the same `nearestRoomAhead` helper, now scoped differently on purpose. |

## Implementation

`lib/flagTradePlan.js`'s `nearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry)`:
- `touchesEntry` (drives `reasonCode: 'room_at_entry'`) - computed from `ownGeometry` only, the single geometry-context entry at `geometryTimeframeFor(candidate.timeframe)`.
- `nearestEdge` (caps `tp1`/`tp2`) - unchanged, still scans every timeframe in `geometryContext`.

Mirrors `lib/candidateQualifier.js`'s `roomBlockedReasons` (decision 4a) exactly for the
timeframe-selection logic, applied to a different (but analogous) geometry read.
