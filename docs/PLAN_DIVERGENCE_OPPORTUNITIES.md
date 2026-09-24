# T5 — Divergence opportunities: an early OPPORTUNITY / WATCH tier, measured before shown

Last updated: 2026-09-24
Status: P0 done 2026-09-24 on 15 days (`docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`): no early-entry combination is net-positive after fees, so P1–P3 are not justified yet. S1 (net R on the tracker) done. S2 (60-day history) capture in progress. P1–P3 not approved.
Branch: `upgrade-signal-engine`. Builds on T4 (`docs/PLAN_FLAG_PATHS.md`).

## Problem

A mentor went long BTC early on bullish divergence at $83,700–$83,900 support. The engine said HOLD / NO TRADE:
- the 3m long candidate was still forming
- confirmation was at $84,113.50
- thesis elimination was at $83,709.90
- the first target zone was $84,375–$84,650
- measured RR was 2.26 (below the 3R minimum)
- it was counter-trend to the 4h

That is right for GO IN, but the setup was never surfaced as an opportunity. The owner wants to see these setups before the mentor does.

What exists today:
- `flagRecommendation` WATCH already carries `changeConditions` (the trigger), the candidate invalidation, and counter-trend in `opposes`.
- `lib/modelEvidence.js` detects Stoch RSI divergence (`divergence_agrees` / `divergence_conflicts`), but only lists it.
- `flagTradePlan` caps TP1 at the nearest level ahead.
- T4 P0 found Stoch side and slope have no effect on flag paths. Divergence and "at a level" were never measured, so there is no evidence yet either way.

## Principles

- GO IN, minRR, the 3% scalp stop guard, `flagTradePlan` and the recommendation class logic are not loosened.
- An opportunity is shown only for conditions that measurably beat the base rate, net of fees.
- The engine writes the opportunity headline and reasons. The GPT prints them (the instruction budget has 6 units left).

## Side work (in parallel with P0)

- **S1 — Net R on the tracker.** Ready plans and shadow entries get net-R stats (fees + slippage from `config/engine.json` `risk`) beside gross R. Aggregates get additive fields; `outcomes.jsonl` is untouched.
- **S2 — 60-day history.** Extend the resumable Kraken-trades backfill to about 60 days (1m, with 5m/15m/1h built from 1m where OHLC doesn't reach). Re-run the T4 path report on it and propose (not install) a rebuilt `pathOutlook` table. Goal: data from more than one market regime.

## P0 — Measure (approved)

1. **New features** in `scripts/tracker/flag-paths.js` `featuresAt`, computed by `scripts/replay-paths.js`:
   - `divergence`: Stoch RSI divergence on the candidate timeframe in the flag's direction: `agrees` / `conflicts` / `none` (reuse `lib/modelEvidence.js` output).
   - `atLevel`: the flag's invalidation (long) or its mirror (short) sits within 0.5 ATR of a support zone (long) / resistance zone (short) from geometry: `yes` / `no`.
   - `sweepReclaim`: in the last N candles, a wick beyond the level, then a close back inside: `yes` / `no`.
   - `counterTrend`: 4h lean against the flag direction.
2. **Early-entry simulation** (`scripts/replay-early-entry.js`):
   - Entry at the tightening point's close, before confirmation.
   - Stop at thesis elimination (invalidation); TP1 at the nearest opposing level (as `flagTradePlan` caps it), else measured target.
   - 24 h walk on 1m, gross and net of fees.
   - Report for all flags and for each combination of divergence × atLevel × sweepReclaim × counterTrend. Include the confirmed retest entry on the same flags for comparison.
3. **Report** `docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`, on 15 days now and 60 days when S2 lands:
   - Does divergence at a level beat the base rate on fail_first and on early-entry net expectancy?
   - Which combination, if any, qualifies for an opportunity tier?
   - Where the mentor's BTC case falls, if it is in the data.

Gate: every test suite passes; nothing under `api/`, `services/` or `config/` changes; payload unchanged.

## P1 — Engine `opportunity` field (not approved)

`symbols.<SYM>.opportunity = null | {headline, dir, counterTrend, reasons[], trigger, invalidation, tp1, rrToTp1, weights, n}`. Example headline: "BTC — POSSIBLE LONG OPPORTUNITY — counter-trend vs 4h". Published only for the P0-qualified combination. It never changes GO IN.

## P2 — GPT decision scale (not approved)

GO IN / OPPORTUNITY–WATCH / NO TRADE. The GPT prints the engine headline and reasons, and keeps setup quality, readiness, confirmation, risk and the call separate. The owner's acceptance criteria 1–9 become GPT test-sheet prompts.

## P3 — Track + alert (not approved)

- The tracker scores opportunity calls as their own class: how often an opportunity came before a GOOD/ready call or a runner, and the early entry's net expectancy.
- Email alert on new opportunities, next to the existing GOOD-call alerts.
