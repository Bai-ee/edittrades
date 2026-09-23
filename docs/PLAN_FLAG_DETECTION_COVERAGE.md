# F1 — Flag Detection Coverage (single implementer pass)

Last updated: 2026-09-23
Status: plan only. Not started.
Branch: `upgrade-signal-engine`
Parent: `docs/MASTER_PLAN_TRADING_MODEL.md` (pre-builds part of M4 and a light version of M6's decision layer).
Source: owner's incident write-up `/Users/bballi/Downloads/flag_detection_problem_and_requirements.docx` ("detect first, decide second").

## Principle

A flag is reported because its price geometry exists, not because a strategy wants to trade it. Detection and trade qualification are separate. Absence of a candidate must mean "no geometry found".

## Incident (replayed on real data, 2026-09-23, 1m longs)

History saved at `test/fixtures/history/2026-09-23/` (captured 15:13 UTC; Kraken keeps only ~12 h of 1m data).

| closedThrough (UTC) | BTC | ETH | SOL |
| --- | --- | --- | --- |
| 14:45–14:47 | forming | forming | forming |
| 14:48–14:57 | failed at 14:48 → hidden | failed → hidden | failed → hidden |
| 14:58–15:00 | new flag forming | nothing | nothing |
| 15:01–15:02 | forming → triggering | forming → triggering | forming → triggering |
| 15:03 | confirmed | confirmed | confirmed |

Root causes, each confirmed by rerunning `detectFlag` with one config change:

1. Failed candidates vanish (`flag.includeFailed: false`): 10+ minutes of silence instead of "failed at 14:48, reason".
2. `flag.maxImpulseCandles: 8` is too short for "a longer pump". With 20, SOL shows a flag triggering 14:52 and confirmed 14:53 that production never showed; ETH/BTC show their failed flags instead of nothing.
3. `flag.maxBreakoutAge: 5` silently drops a confirmed flag 5 candles after its break (SOL at 14:57).
4. `flag.minCandles: 3` closed candles plus the live chart's unclosed candle put detection 1–3 minutes behind the eye.

Not causes (already correct, keep): both directions are already returned per timeframe; EMA200, HTF bias, Stoch, and strategy validity already do not gate detection (Stoch only weights confidence). EMA21 is the one real gate (flag starts on its side; `acceptanceCloses` closes through it = failed). It stays (owner's model: flags on the 21), loosened only as in item 3 below.

## Build

All constants in `config/engine.json` (`flag.*`, bump `configVersion`). Long and short through the existing oriented single code path; every test mirrored.

1. **`proto` state.** Impulse qualifies and 1 to `minCandles − 1` closed candles have pulled back without a new extreme beyond the impulse peak. Published with `state: "proto"`, no entry call. Order: proto → forming → triggering → confirmed → failed / expired.
2. **Longer impulse lookback.** `flag.maxImpulseCandles` 8 → 20. Accept only after the replay checks in Verification.
3. **EMA21 reclaim allowed.** A flag whose first candle is on the wrong side of EMA21 but reclaims it (close back on-side) within the first `flag.reclaimCandles` (default 2) candles is valid; `ema21Hold` gets the value `reclaim`. Acceptance-fail rule unchanged.
4. **Failed stays visible.** A failed candidate stays in the default `candidateSetups` for `flag.failedTtlCandles` (default 10) candles of its timeframe after failure, with `failReason` and `failedAt`. Older failures follow `includeFailed`.
5. **`expired` state.** A confirmed flag past `maxBreakoutAge` is published as `state: "expired"` for `flag.expiredTtlCandles` (default 10), `chaseRisk: true`, instead of disappearing.
6. **Stable identity (stateless).** `candidateId = "<SYMBOL>:<tf>:<direction>:<impulseStart ISO>"`. `firstDetectedAt` = close time of the candle at which the flag first met the proto rule (derivable from `impulseEnd` + 1 candle, no stored state). Also `impulseStart`, `impulseEnd` (ISO).
7. **Cheap geometry fields.** `flagSlope` (least-squares slope of flag closes, % per candle, sign in real price space), `breakoutDistancePct`, `invalidationDistancePct` (from last close, 2 decimals).
8. **Trade qualification (compact, separate from detection).** On every candidate: `qual = { quality: low|med|high, decision: watch|wait|dont|actionable, reasons: [codes] }`, built from data already in the payload, never changing the candidate:
   - `conflict:<tf>-<dir>`: an opposite-direction candidate forming+ on another 1m/3m/5m timeframe.
   - `stoch:ob-cross` / `stoch:os-cross`: that timeframe's Stoch overbought with bearish cross for a long (mirror for a short).
   - `room:blocked-<tf>`: a geometry resistance (support for shorts) zone sits between `breakoutLevel` and `measuredTarget`.
   - `ema200:counter`: `ema200Side` against the direction. `ct:4h`: against the 4h lean.
   - `chase`: `chaseRisk` true. `rr:<x>`: `measuredRR` below 3.
   - `decision`: proto/forming → `watch`; triggering → `wait`; failed/expired → `dont`; confirmed with no blocking reason (`room:blocked`, `chase`, `rr` < 3) → `actionable`, else `wait`. Never probability of profit.
9. **Payload.** New fields go in the default `candidateSetups`. Report exact byte cost on live data; the default payload must stay ≤ 79,000 bytes. Schema 1.11.0 → 1.12.0; update `openapi/scalp-context.yaml` (ChatGPT-safe constructs). Trace strings: `decisionTrace.candidateSetups` gains the new states (`1m:long:proto`, `:expired`).
10. **GPT instructions** (`docs/GPT_INSTRUCTIONS.md`, budget-neutral, `npm run check:gpt` ≤ 7,990): `flags` lists every candidate incl. proto/failed/expired with `qual.decision` and top reasons; `forming` includes proto; "latest closed candle may trail your live chart by one candle"; confidence = pattern evidence only. Trim an equal amount elsewhere; never remove a rule or touch FORMAT / TRACK FORMAT / NO TRADE LINE.
11. **MISS_003 fixture** in `test/fixtures/misses/` (follow MISS_001/002 format) from the 2026-09-23 history, with the expected post-fix timeline as the assertion.

## Out of scope

Flags on 15m/1h/4h, divergence, channels, FLAG_21, any strategy decision, `services/strategy.js`, MCP tool registration, REST auth, wallet, `public/index.html`.

## Verification

- All 12 suites + a new/extended `test:pattern` (proto, reclaim, failed TTL, expired, candidateId stability across states, qual codes, all mirrored). Report counts before/after.
- MISS_003: after the change, ETH and SOL 1m longs are visible (proto/forming or failed-with-reason) at every close 14:45–15:03; SOL's 14:52 flag appears; nothing vanishes without a state.
- Replay both histories (`2026-09-22`, `2026-09-23`) before/after with `npm run replay:metrics` and `npm run replay:outcomes`: report candidate counts by state, visual-gate rate, and flag-candidate win rate/expectancy. If the visual-gate rate rises above 0.15 or flag expectancy drops materially, report it before tuning anything.
- Live payload bytes before/after (`buildScalpContext({})` → `filterPayload(p, {})`), build ms before/after.
- `npm run check:gpt`, `git diff --check`.
- No commit, push, deploy, env change, or paid call.

## Implementer prompt (paste into a fresh Sonnet thread)

```
You are the implementer for EditTrades F1 — Flag Detection Coverage.

Repo: /Users/bballi/Documents/Repos/snapshot_tradingview (branch upgrade-signal-engine).

Your source of truth is docs/PLAN_FLAG_DETECTION_COVERAGE.md. Read it in full, then read, in order:
1. CLAUDE.md (hard rules, test commands)
2. lib/patternDetector.js, config/engine.json, config/engine.js (flag.* constants, configVersion)
3. services/scalpContext.js (candidateSetups publish path, decisionTrace, schemaVersion, filterPayload)
4. test-pattern-detector.js (or the file `npm run test:pattern` runs) and test/fixtures/misses/README.md,
   MISS_001.json, MISS_002.json (fixture format)
5. docs/EDITTRADES_MCP_CONNECTOR.md (schema map), openapi/scalp-context.yaml, docs/GPT_INSTRUCTIONS.md
6. scripts/replay.js, scripts/replay-outcomes.js; histories under test/fixtures/history/2026-09-22 and
   2026-09-23

Deliver Build items 1 -> 11 in one pass exactly as the plan specifies, then run Verification, then
report and stop.

Non-negotiables:
- Additive only. Long and short through the one oriented code path; every new test mirrored long/short.
- Do not touch services/strategy.js, MCP tool registration (services/editTradesMcp.js, lib/mcpHttp.js),
  REST auth, services/walletTracker.js, public/index.html, CLAUDE.md. Scalp stop 3% rule untouched.
- All new constants in config/engine.json (flag.*); bump configVersion. Schema 1.11.0 -> 1.12.0.
- Default payload <= 79,000 bytes on live data; report exact bytes before/after and build ms before/after.
- docs/GPT_INSTRUCTIONS.md budget-neutral: npm run check:gpt <= 7,990; never remove a rule or touch
  FORMAT / TRACK FORMAT / NO TRADE LINE.
- Update docs/EDITTRADES_MCP_CONNECTOR.md (schema map + test counts), openapi/scalp-context.yaml,
  CHANGELOG.md, docs/DOCUMENTATION_INDEX.md if a file is added.
- Run all 12 suites (sltp scalp mcp wallet config risk pattern geometry chart replay bias topdown) and
  git diff --check. No commit, push, deploy, env change, or paid call.
- If the replay visual-gate rate rises above 0.15 or flag expectancy drops materially, stop and report
  before tuning anything.

Report (compact): files changed; per Build item what was done; test counts before/after per suite;
MISS_003 timeline result; replay metrics before/after for both histories; payload bytes and build ms
before/after; check:gpt result; anything deferred and why. Then stop.
```
