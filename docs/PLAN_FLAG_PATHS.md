# T4 — Flag paths: measured scenario weights at the moment a flag tightens

Last updated: 2026-09-24
Status: P0–P4 done 2026-09-24. P0 results `docs/FLAG_PATHS_BASE_RATES.md`; P1 `pathOutlook` (schema 1.19.0); P2 SCENARIO block; P3 tracker calibration (`#path-calibration-section`); P4 in **shadow mode** only (`breakoutEntry`, schema 1.20.0, never a trade instruction): replay says do not promote (`docs/BREAKOUT_ENTRY_SHADOW.md`).
Branch: `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker`.

## Problem (SOL, 2026-09-24 ~04:51Z)

SOL 5m long flag, breakout $114.95, invalidation $114.71 (1R = $0.24). The GPT correctly said WATCH: wait for a 5m close above $114.95, then a retest-hold. It also said "immediate chase into $115.05+ without retest = no chase". SOL then ran straight to $115.42 with no retest. The engine later showed the candidate confirmed, `flagTradePlan` rejected (chase), measured RR 2.17 < 3, counter-trend vs 4h, and 15m resistance at $115.48–$115.95.

- **The engine's decision was right.** Even a perfect entry at the breakout close had about 2R to the first resistance, counter-trend to the 4h. That is not a quality trade under the rules.
- **The communication failed.** The response did not separate direction (up was likely) from entry (no clean entry) from path (a runner was likely). So the run looked like a miss.
- **The GPT's after-the-fact weights (35/25/15/25) must not become the fix.** An LLM invented them after seeing the outcome. The four items also overlap: "5m close above" is a step on both the retest path and the runner path, not an outcome of its own.

Goal: every flag call carries direction lean, trade readiness, likely path, best entry, and chase risk. Any weights shown come from measured history with a sample size, never from the model. Separately, find out whether the runner path hides tradable opportunities (P4).

## Path outcomes (mutually exclusive, closed candles only)

Labelled from the **tightening point**: the first closed candle at which a candidate is `forming` or `proto` (flag complete, no post-flag candle yet). R = |breakoutLevel − invalidation|. Walk the candidate's own timeframe for closes and 1m for touches, no lookahead, within `N` candidate-timeframe candles (default 24; config).

| Path | Rule |
| --- | --- |
| `retest_go` | Breakout close (close beyond `breakoutLevel` on the candidate TF), then a 1m touch back to `breakoutLevel` (± `retestTolR`, default 0.15R) with a close that holds the level (same hold rule as `lib/flagTradePlan.js` retest readiness), then +1R from `breakoutLevel` before invalidation |
| `runner` | Breakout close, then +1R from `breakoutLevel` with no retest touch first |
| `false_break` | Breakout close, then a close back inside the flag, then an invalidation close before +1R |
| `fail_first` | Invalidation close before any breakout close |
| `chop` | None of the above within `N` (includes breakout close that neither reaches +1R nor invalidates) |

Also recorded per candidate: max favourable excursion in R before invalidation, R reached at `measuredTarget`, R to the nearest opposing geometry level (room), minutes to resolution.

Derived: **direction lean** = (`retest_go` + `runner`) vs (`false_break` + `fail_first`); **entry quality** = `retest_go`; **chase risk** = the `runner` share.

## Features at the tightening point (bucketed, no model library)

From the candidate and the same payload the engine already builds:
- how tight the flag is: `compressionScore`
- `durationCandles`, `impulseStrength`
- timeframe and direction
- level tests: count of flag candles whose high (long) / low (short) is within 0.1 ATR of `breakoutLevel`
- higher lows (long) / lower highs (short) inside the flag
- Stoch RSI side and slope on the candidate TF (`lib/modelEvidence.js`)
- 1m/3m/5m agreement (another TF has a same-direction live candidate)
- top-down side (`td:` token), `ema200Side`
- room to the next opposing level in R (geometry)
- hour UTC

A feature is kept only if it moves base rates beyond the sampling noise at the available n.

## P0 — Measure (approved; dev only, no production change)

1. **`scripts/tracker/flag-paths.js`** (new, pure: no fs, no network). `labelPath(candidate, candlesTf, candles1m, opts)` → `{path, mfeR, targetR, roomR, minutes}`; `featuresAt(candidate, context)` → bucketed features. Pure so both the replay script and the tracker use one implementation (`sync.js` already copies `scripts/tracker/*.js`).
2. **`scripts/replay-paths.js`** (new): reads a `scripts/replay.js` JSONL + its history dir. For every distinct `candidateId`, it takes the first tightening point, labels the path and writes one row per candidate. `--report` prints base-rate tables: overall, per timeframe × direction, per single feature bucket, and the top 2-feature combos with n ≥ `minN` (default 100; below that the bucket is printed `uncalibrated`).
3. **History depth** (the blocker): saved history is 2 captures of about 12 h of 1m candles, and the tracker's 1m store is about 17 h. Owner picks one:
   - **(a) Kraken trades backfill (recommended).** Extend `scripts/replay.js --capture` to build weeks of 1m candles from Kraken's public Trades endpoint (paginated, no key). It is already used for the 1m trade backfill, so there is no new provider or dependency. Slow but one-off; store under `test/fixtures/history/<date>/` (gitignored if large).
   - **(b) Forward only.** Rely on the tracker accumulating 1m candles. It takes weeks to reach n ≥ 100 per bucket.
4. **Tracker path label (live data):** new `data/paths.jsonl`, one row per engine candidate seen in a capture (cron or served) once it resolves, from the same `labelPath`. Written by a new step after scoring. **`outcomes.jsonl` and every scored number stay untouched** (testing window: no threshold tuning, no scoring change). Page: one tile `#flag-paths-section` with the path mix for the last 7/30 days and n. PROVISIONAL tag, bento rules.
5. **Tests:** `test-flag-paths.js` (`npm run test:paths`) with hand-built candle sequences for each path (long and short mirrored): the SOL runner case, a retest-go, a false break, fail-first, chop, a no-lookahead check, and the feature-bucket edges. `test:tracker` covers the paths tile and that `outcomes.jsonl` is byte-identical with and without the step.

Gate: `test:paths`, `test:tracker`, the deploy-gate four pass; `replay-paths --report` runs on the saved history; no file under `api/`, `lib/` or `services/` changes.

Deliverable: a short report (`docs/FLAG_PATHS_BASE_RATES.md`) with the tables, the n per bucket, which features moved rates, and the SOL case's bucket.

## P1 — `pathOutlook` in the payload (not approved)

`lib/pathOutlook.js` (pure) per symbol for the leading forming/triggering candidate:
- `directionLean`
- `readiness` (from `flagTradePlan.status`)
- `mostLikelyPath`
- `bestEntry` (`flagTradePlan.entryCondition`)
- `chaseRisk` (engine `chaseRisk` plus the `runner` share)
- `weights {retest_go, runner, false_break, fail_first, chop}` with `n` and `calibrated: bool`
- `nextSetup` (after a runner: watch for the re-flag above the old level)

Weights are a frozen table from P0 in `config/engine.json` (configVersion bump), and the schema gets an additive bump. Info only: class logic, plan gates, the 3R minimum and the 3% scalp stop guard are unchanged.

## P2 — GPT renders it (not approved)

One rule in `docs/GPT_INSTRUCTIONS.md`: render `pathOutlook` as the fixed "Scenario" block (the five fields + weights, or "uncalibrated"). Never invent percentages; a runner without a retest is a missed entry, not confirmation. Budget: 8 units of headroom now, so the rule must be paid for by trimming; `npm run check:gpt` gates it.

## P3 — Calibration check (not approved)

The tracker compares each call's `pathOutlook.weights` to the realised path: a reliability table per weight decile, and a Brier score on the page. Weights that don't calibrate are withdrawn (the flag goes back to `calibrated:false`).

## P4 — More opportunities (not approved; after data + owner decision)

1. If P0/P3 show `runner` is common and profitable in specific buckets (e.g. 3+ level tests, td supports, room ≥ 3R), consider a second entry type: breakout-close entry, reduced size, stop at the flag low/high, same 3R minimum, net of fees. It changes how trades are decided, so it waits for the testing window to end and for owner approval.
2. `nextSetup` re-flag after a runner is a measurable second chance with no rule change.

## Out of scope

Threshold or scoring changes during the testing window; LLM-generated probabilities; new dependencies; MCP changes; trading execution.

## Risks

- Too few samples: most buckets will read `uncalibrated` at first. That is the honest output.
- The path rule has to match the engine's own retest-hold definition exactly, or the labels will disagree with `flagTradePlan`. Reuse its hold check rather than re-implementing it.
- Kraken trades backfill is rate-limited and slow; the capture needs resume support.
- Kraken prices vs the owner's TradingView SOLUSDT chart differ slightly; paths are labelled on Kraken candles, the same source the engine uses.
