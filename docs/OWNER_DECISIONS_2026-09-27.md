# Owner decisions — 2026-09-27

Source: `docs/PROMPT_T15_AGENT_M.md` (T-15 master prompt, "NF stop floor goes LIVE +
automatic trailing stop after +1R"). Executed in worktree `nf-live` (branch `nf-live`,
off `origin/upgrade-signal-engine`).

| # | Question | Answer | Why it matters |
| --- | --- | --- | --- |
| T-15 freeze | **The engine rules are frozen until 2026-10-08 (`docs/AGENT_SESSION_RULES.md`) — does the NF net-floor change qualify for an exception?** Evidence: `docs/VARIANTS_STUDY_2026-09-26.md` (live rules median −2.45R net over the study window; NF-live −1.31R; NF-live + a 1R trailing stop −0.20R, positive on both halves of the split, 61% win rate), `docs/CONDITIONS_STUDY_2026-09-26.md` (95% of GOOD calls carry a stop under 0.5% of entry - inside or barely outside Jupiter's round-trip cost, so most winners were net losers before this change), `docs/EXITS_STUDY_2026-09-26.md` (the 1R trailing-stop exit variant was the only one that flipped the sign on both halves of the out-of-sample split). | **Approved, do all — the freeze is lifted for exactly this change.** Nothing else moves: no indicator swaps, no entry filters, no cap or gate changes beyond the net floor and the trailing stop described below. | The live rules were losing money net of fees on the median call; this is the one change the owner's own studies show reverses that, so it ships ahead of the 2026-10-08 window rather than waiting on it. |
| Part 1 | **How does the T-13 `NF` net-floor shadow (`docs/PLAN_TELEGRAM.md` "net floor", `lib/flagTradePlan.js` `netFloorStopDistance`) become the live rule?** | `config/engine.json` gains `flagPlan.stopFloor = {atrMult:0.5, costMult:3, minNetRR:1.0}` (new keys; `flagPlan.minRR` stays 2.5). Every candidate's stop is widened to `max(0.5 x ATR(15m), 3 x round-trip cost)` before every other gate (chase, room, 3% cap, gross/net R, retest-hold) - exactly what the shadow did, now applied instead of only compared. `ready`/`conditional` requires gross R:R ≥ `minRR` AND net R:R ≥ `stopFloor.minNetRR`. New fields `stopSource` (`'structure'|'floor'`) and `structureStop` (the pre-floor invalidation) are published on every plan so a floored stop is never silently indistinguishable from the candidate's own. The `NF` shadow variant is retired (it has nothing left to compare against); `v3` (the former 3R live rule, now the shadow) is untouched. `flagRecommendation.setup.shadowNF` is renamed `setup.stopFloor = {applied, stopPct, netRR}` (additive rename, same underlying attempt). | This is the rule the evidence above says actually pays; publishing `stopSource`/`structureStop` (rather than silently moving `stop`) keeps every downstream consumer (Telegram cards, the tracker, the GPT) able to say which stops were widened and by how much. |
| Part 2 | **Given the net floor now widens stops, should anything manage the trade AFTER entry, or does the wider initial stop stand alone?** | **Yes — an automatic trailing stop after +1R, safety-increasing only.** `lib/execution/executor.js` gains `trailStops(positionId, newStop, ctx)`: the only PIN-less write the executor exposes, and it can only tighten (refuses any stop that would move away from price; never touches TP; capped to one applied update per position per 5 minutes; still blocked by the kill switch and env kill). `api/telegram-cron.js` runs it every minute, only when `TRADE_EXECUTION_ENABLED==='true'` and `EXECUTION_MODE==='live'`, and only when the owner has not turned it off (`/exec trail off`, PIN required to turn off, not to turn on). | The wider net-floor stop is a larger initial risk; letting it ride the trade's own favorable movement (lock in R as price moves, never widen) is what turned the study's net numbers from negative to positive on both halves of the split, per `docs/EXITS_STUDY_2026-09-26.md`. |
| Trailing formula | **Exactly how is the trail computed, and why is it recomputed from the CURRENT stop rather than a fixed original R?** | R = `\|entry − the position's CURRENT on-chain stop\|`, recomputed fresh every tick (not fixed at open) - deliberately simpler than the offline research variant (`scripts/research/exits.js` `walkTrail1R`, which fixes R at the very first stop and never recalculates it), since the live cron only has entry + current stop available from `listPositions()` without an extra journal scan for the position's original opening stop. Once unrealized ≥ +1R (mark from the engine build, else Kraken close), `newStop = bestPriceSinceEntry − R` (long) or `+ R` (short); applied only when that is ≥0.05% of price better than the current stop. As the stop trails up (long) or down (short), R itself shrinks, so each further tightening step is proportionally tighter than the last - a ratchet, not a fixed-width trail. | A design choice worth naming explicitly: the live trail is not a literal reproduction of the backtested `walkTrail1R` variant, though it shares the same "arm at +1R, trail to best − 1R" shape and was validated against the same evidence. |

## Not built / deferred

- `scripts/tracker/nf-shadow.js` needed no code change: since the net floor is now baked
  into the live plan's own stop, its existing "backfill from entry/stop" path naturally
  produces a Live/NF comparison that converges going forward (only historical,
  pre-cutover rows stay genuinely divergent). Its labels were relabeled "NF (live since
  2026-09-27)" rather than rewritten.
- `scripts/research/conditions.js` / `test-conditions-study.js` (S1 Agent B, already
  complete, already used as evidence for this exact change) were left untouched: their
  `shadowNfBucket` degrades gracefully to `'absent'` once `setup.shadowNF` no longer
  exists, and touching an already-shipped, already-cited research script was out of
  scope for this change.
- A cron-side pre-check duplicate of the executor's own 5-minute cooldown was not added;
  the executor's own `trailStops` cooldown is authoritative (defense in depth would only
  save one avoidable network round trip per minute while a position is armed).

## Implementation

See `CHANGELOG.md`'s 2026-09-27 T-15 entry for the full file-by-file list, and
`docs/EDITTRADES_MCP_CONNECTOR.md`'s schema-map rows for `flagTradePlan.stop`/
`.stopSource`/`.structureStop` and `flagRecommendation.setup.stopFloor` (schema 1.28.0,
configVersion 2026.09.27-1).

## T-18 — retest-1h ships paper, not tradable

Source: `docs/PROMPT_T18_LIVE_RELEASE_MODIFIED.md` (T-18 master prompt, "ship the
`live-release` branch in a MODIFIED form"). Executed in worktree `et-live-release` (branch
`live-release`, off `origin/upgrade-signal-engine`).

| # | Question | Answer | Why it matters |
| --- | --- | --- | --- |
| T-18 | **`live-release` (a69608c) shipped the retest-1h signal with a live Open button and disabled the flag engine's own Open button in the same change (`d284a5b`). Does the research support either of those two calls?** Evidence: `docs/RETEST_ENTRY_STUDY_2026-09-27.md` (re-flag-retest-1h: gross R mean +0.44 / net mean +0.27, gross R median −0.55 / net median −0.84 on 101 trades over ~2 years, both OOS halves net-median-negative, the seeded random-direction control also fails - not a repeatable edge, a fat right tail flattering the mean) and `docs/VARIANTS_STUDY_2026-09-26.md` (NF-live + the +1R trailing stop: median −0.20R, 61% wins, the only variant close to breakeven - this is the flag engine's own live rule, unrelated to the retest-1h finding). | **Ship modified: keep the flag engine's Open button live (revert `d284a5b`'s disable), ship retest-1h info-only/paper (Track + Plan/Thesis, no Open) instead of live.** The flag engine's disable-Open change was not supported by any study of the flag engine itself; the retest-1h Open button was not supported by the retest-1h study, which the SAME branch had just finished writing. | Neither the flag-Open removal nor the retest-1h Open addition had evidence behind it at the moment `d284a5b` shipped; this decision aligns what trades with what the branch's own research actually supports. |
| Promotion rule | **Under what condition does retest-1h graduate from paper to a live Open button?** | retest-1h ships paper; promotion rule: ≥ 30 live signals, mean net R > 0 with the bootstrap 90 % lower bound > 0, and max drawdown within the active profile's daily/weekly limits. Median is reported but is not the gate: a 30 %-win / 2.5R+ rule has a negative typical trade by design. Control note: the other thread's matched controls (same symbol, side, hour, conditions; p≈0.01–0.05) supersede the retest study's random-direction 4h control as the reference test. | The 101-trade study's own median is reliably negative by construction (win rate 30.3%, per `docs/RETEST_ENTRY_STUDY_2026-09-27.md`'s histogram) - gating on mean + a bootstrap lower bound (rewards a real, resample-stable positive edge) instead of median is the only promotion rule this rule could ever pass on its own shape, while still refusing a lucky-mean fluke (the lower bound must also clear zero). |

## Not built / deferred (T-18)

- The retest-1h rule's own exit mechanics (structure exit, 7-day hold cap) are not
  reproduced inside the live tracker's 24h tp1/stop/expired walk (`scripts/tracker/score.js`
  `scoreRetestCalls`) - they stay a separate, parallel info-only `RETEST_1H_EXIT` alert
  (`lib/retest1hLive.js`), same as the flag engine's own live walk never models a manual
  close either.
- A page-level enforcement of the promotion rule (auto-flipping retest-1h to tradable once
  it clears) was not built; `scripts/tracker/aggregate.js` `retestStats` reports `promoted`
  as a boolean for a human to act on, nothing reads it back into
  `OFFER_OPEN_ON_FLAG_ALERTS`-style live gating.

## Implementation (T-18)

See `CHANGELOG.md`'s 2026-09-27 T-18 entry for the full file-by-file list.
