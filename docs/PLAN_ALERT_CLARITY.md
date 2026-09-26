# Plan — Alert clarity, Phase A (communication only)

Status: approved 2026-09-25 by the owner. Source of truth for this phase.
Origin: `~/Downloads/SOL_flag_engine_feedback_2026-09-25.docx` (SOL failed-breakdown review) and the live BTC 3m TRIGGERING alert of 2026-09-25 (`meas 1.9R`, `BE READY`).

## Objective

Every call tells the trader four things the current alert does not: whether the flag can even
pass the plan gates, what kills the thesis before the void, where price goes if the breakout
fails, and the full context the qualifier already computed. No rule, threshold, or gate
changes. Two-week rule freeze (until 2026-10-08) is respected: this phase is additive
presentation on top of fields the engine already emits.

## Findings this phase fixes

| # | Finding | Where |
| --- | --- | --- |
| 1 | TRIGGERING alert always says `BE READY — close confirms`, regardless of `qual`. A flag with `rr:1.9` (floor 2.5), `room:blocked-*`, or `chase` is advertised as ready-to-enter, then STAND DOWN on the confirming close. | `lib/telegram.js:864` `alertVerdict`; `lib/candidateQualifier.js:127` already computes `decision: 'dont'` |
| 2 | `Divergence: agrees` and `Divergence: against the trade` print together when timeframes split; counts dropped. | `lib/telegram.js:781-782`; source `lib/flagRecommendation.js:517-518` |
| 3 | Context block prints only counter-trend and divergence. `room:blocked-<tf>`, `ema200:counter`, `chase`, `rr:<x>`, stoch codes never shown. `td:bull 2/4` reads as a lean. | `lib/telegram.js:772` `contextLines` |
| 4 | No "other side" price. If the breakout fails, the opposing zone on the candidate's geometry timeframe is computed but never surfaced. | `geometryContext[geometryTimeframeFor(tf)]` zones |
| 5 | No kill line before the void. `ema21Hold` reclaim/acceptance and "close back through brk after a probe" are the only pre-void signals available today. | `candidateSetups[].ema21Hold` |

## Changes

### Engine: `lib/flagRecommendation.js` (single source of truth)

Add to `flagRecommendation` (full and compact) a `clarity` object per symbol:

```
clarity: {
  gate:      { passable: boolean, blockers: string[], text: string|null },
  killIf:    { level: number|null, text: string },
  otherSide: { low: number|null, high: number|null, source: string|null, text: string|null },
  context:   string[]   // qual codes rendered in words, ordered: blocking first
}
```

- `gate`: from the subject candidate's `qual.reasons` (subject = plan candidate, else `setup`, else `watchCandidate`). `passable = !(qual.decision === 'dont')`. `blockers` = the codes the qualifier treats as blocking (`room:blocked*`, `chase`, `rr:*`). `text` example: `R 1.9 under 2.5 floor; needs TP beyond 83,700` where the needed TP is computed from `breakoutLevel`, `invalidation`, and `flagPlan.minRR` (mirrored long/short).
- `killIf`: level = `breakoutLevel`; text long: `close back below <brk> after a probe = defended, stand down`; short mirrored. If `ema21Hold` is `reclaim` or `acceptance_*`, prefix `EMA21 <word> already —`.
- `otherSide`: nearest zone on the *opposing* side of entry on `geometryContext[geometryTimeframeFor(candidate.timeframe)]`, plus nearest confluence zone if closer. Text: `if it fails, rotation to <low>–<high> (<tf> <source>)`. Null when no zone. Labeled scenario, never a target.
- `context`: every `qual.reasons` code in words. Use the existing word table in `lib/telegram.js:1409-1427` as the source of wording, moved or duplicated into `flagRecommendation` so both GPT and Telegram read one text. `td:*:2/4` renders `top-down split 2/4`, never `bull`/`bear`.
- Divergence: keep the two codes, add counts to the reason text (`1 tf agrees, 2 against`), and expose `divergence: { agree, conflict }` inside `clarity.context` rendering as one line.

Schema `1.26.0` → `1.27.0` (working tree is already at 1.26.0 from the uncommitted volume work; bump from there, do not touch the volume fields). `configVersion` unchanged: no config key changes.

### Telegram: `lib/telegram.js`

- `alertVerdict` (L860-880): for `WATCH` and `TRIGGERING` kinds, read `rec.clarity.gate` for the candidate. If `passable === false`: verdict becomes `WAIT (eta) — <gate.text>` when the blocker is `rr:*` (a later TP could fix it) and `STAND DOWN — <gate.text>` when it is `room:blocked*` or `chase`. `BE READY` only when passable. Plan-backed branches (conditional / setup / ready) unchanged.
- `contextLines` (L772): replace with `rec.clarity.context` lines plus `Kill if: …` and `Other side: …` lines, then Mark. Drop the two separate divergence lines (now one line with counts).
- `alertSignature` (L2368) and `signatureBlocked` must not include the new lines, so context churn does not re-alert.
- Card/plan sections untouched.

### GPT: `docs/GPT_INSTRUCTIONS.md`

One rule line under CANDIDATES: `flagRecommendation.clarity: gate.text before any BE READY; always print Kill if / Other side.` Budget: box is at 7,939 of 7,990 units. If the line does not fit, move an equal number of units to `docs/GPT_PLAYBOOK_ADDITIONS_2026-09-24.md` per the B3 pattern and note it. `npm run check:gpt` must pass.

### OpenAPI: `openapi/scalp-context.yaml`

`FlagRecommendation.clarity` schema, described as presentation derived from `qual`, `ema21Hold`, geometry; never a gate.

## Tests

- `test-flag-recommendation.js`: gate passable/not (rr, room, chase, none), killIf long/short mirror, otherSide with and without zone, context wording for every qual code, divergence counts, `td:*:2/4` wording.
- `test-flag-recommendation-fixtures.js`: 16 pinned fixtures gain `clarity`; re-pin deliberately, diff reviewed.
- `test-telegram.js`: TRIGGERING with blocking qual → WAIT/STAND DOWN not BE READY; passable → BE READY unchanged; one divergence line; signature unchanged by context lines.
- All 11 deploy-gate suites plus `test:telegram`, `test:flagrec`, `test:flagrec:fixtures` green. `git diff --check`.

## Hard constraints

- Do not stage or edit `lib/volumeContext.js`, `test-volume-context.js`, or the volume hunks in `services/scalpContext.js`, `config/engine.*`. They belong to another session.
- No change to `lib/flagTradePlan.js` gates, `lib/candidateQualifier.js` logic, `config/engine.json` thresholds, MCP tool surface, or `api/`.
- No commit, no deploy. Hand back for review.

## Out of scope (Phase B, separate thread)

Probe counts, defended extreme, defense score, `failed_breakdown` state: new detector telemetry, replay-gated, after the freeze.

## Docs to update in this phase

`CHANGELOG.md` entry, `docs/EDITTRADES_MCP_CONNECTOR.md` schema map + test counts, `docs/DOCUMENTATION_INDEX.md` (this doc), `openapi/scalp-context.yaml`.
