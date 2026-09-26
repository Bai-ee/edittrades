# S0 — Swing-trade research (24–72 h holds), three parallel Sonnet agents + one harness owner

Owner question (2026-09-26): can the system identify daily / 24-hour swing trades with an edge? Research only. No product change, no deploy, no orders, no engine rule change. Every agent works in its own worktree off `origin/upgrade-signal-engine`, commits by file name, does not push. The orchestrator merges and writes the final comparison.

## Shared contract (all agents)
- **Rule module interface** — each candidate strategy is one file `scripts/swing/rules/<id>.js` exporting:
  ```js
  export const meta = { id, label, source, tf: '4h'|'1d', holdMaxHours, stopKind: 'atr'|'structure'|'pct', notes };
  /** Called once per closed candle of `meta.tf`, no lookahead. `ctx` = { symbol, tf, i, candlesByTf, indicatorsByTf, topDown, geometry } where every array is sliced to closes <= this candle. Return null or { direction:'long'|'short', entry, stop, tp1, tp2?, reason:string[] }. */
  export function signalAt(ctx) {}
  ```
  Signals are scored by the tracker's `walkOutcome` on 1m candles from the signal's close time: fill window = the next `meta.tf` candle, stop/TP1 first-touch, hold cap `holdMaxHours` (24 / 48 / 72). Net R uses the owner's direction costs (0.34 % long / 0.14 % short) plus 0.20 % sensitivity.
- **Data**: `test/fixtures/history/deep60-2026-09-24/` (BTC/SOL/ETH; 1m backfilled 85.5 days; 15m/1h/4h/1d reach further back natively; manifest.json). Symlink it from the main checkout if your worktree lacks it. Use `scripts/replay.js` `buildAt` for indicators/geometry/topDown at each close if you need them (it is the production pipeline, no lookahead) — or compute EMA/ATR/Donchian directly from the candle arrays for speed; say which.
- **Output table** (same columns for every rule, per symbol and combined): n · resolved · win % · gross exp R · net exp R (dir-cost) · 0.20 % sens · max losing streak · median hold h · signals/week · OOS first/second half net R · pass/fail (net > 0 in both halves).
- **Tests**: `test-swing-rules.js` (or extend `test-replay-rules.js`): every rule module returns null on insufficient history, mirrors long/short, never uses candles after `i`. `npm run test:*` unchanged and green; `git diff --check`.

## Agent S0-A — harness owner (branch `swing-harness`)
1. `scripts/swing/run.js`: loads every `scripts/swing/rules/*.js`, replays each over the fixture at its `meta.tf` closes (no lookahead), scores with `walkOutcome` (extend `maxHoldCandles` per rule; 1m candles), writes `docs/swing/<id>.json` + the table to `docs/SWING_STUDY_2026-09-26.md` (one section per rule; the orchestrator merges sections from the other agents' rule files by re-running you).
2. Two rules from the existing code: `legacy-swing` (the `SWING` strategy in `services/strategy.js`, spec §1) and `legacy-trend4h` (`TREND_4H`, spec §2), called through the real evaluator at each 4h close, mapped onto the rule interface (entry/stop/TP from its signal). If the evaluator needs inputs the fixture cannot supply (dflow/marketData), document what you nulled.
3. `npm run swing:study` script; `test:swing` script; CHANGELOG line. Handback: table for the two legacy rules, runtime per rule, and the exact interface other agents must match (paste it).

## Agent S0-B — playbook rules (branch `swing-playbook`), rule files only
Source: `docs/MASTER_PLAN_TRADING_MODEL.md` (M-1..M-4), `docs/PLAN_STRATEGY_DOCS_ALIGNMENT.md`, `docs/GPT_INSTRUCTIONS.md`, `lib/topDown.js`, `lib/geometry.js`, `lib/patternDetector.js`. Implement three rules with the contract above, each with a 3-line rationale in `meta.notes`:
- `pb-ema21-pullback-1d`: 1D trend by EMA21/EMA200 stack and slope; entry on the first 4h close back above (long) / below (short) EMA21(4h) after a pullback to it; stop beyond the pullback extreme (or 1.5×ATR(4h) if tighter); TP1 = 2R, TP2 = prior 1D swing.
- `pb-4h-flag-continuation`: 4h flag (use `lib/patternDetector.js` on 4h candles if it supports the timeframe; else the same pole/consolidation rule in 4h terms) in the direction of the 1D trend; entry breakout close; stop invalidation; TP1 measured move.
- `pb-channel-edge-4h`: 4h/1D channel from `lib/geometry.js` `channel()`; long at lower edge in an up channel (positionPct ≤ 15) / short at upper edge in a down channel; stop outside the channel by 0.5×ATR; TP1 mid-channel, TP2 far edge.
Tests per rule. Handback: rule files, tests, what each rule needs from the harness that the contract does not provide.

## Agent S0-C — standard controls (branch `swing-controls`), rule files only
Textbook rules as controls, same contract:
- `ctl-donchian-20d`: 20-day Donchian breakout on 1D closes in the 1D EMA200 direction; stop = 10-day opposite channel; TP1 = 2R; hold 72 h.
- `ctl-ema-pullback-1d`: 1D close pulls back to EMA21(1D) in an EMA21>EMA200 uptrend (mirror short), enters on the next 1D close reclaiming; stop 1.5×ATR(1D); TP1 2R.
- `ctl-4h-range-break`: 4h close outside the prior 24 h range (6 × 4h) in the 1D bias direction; stop = range midpoint; TP1 = range height; hold 24 h.
- `ctl-random-4h`: seeded random long/short at 4h closes with the same stop/TP mechanics as `ctl-4h-range-break` — the null baseline every real rule must beat.
Tests per rule. Handback: rule files, tests, any contract gaps.

## Hard rules (all)
No changes under `lib/`, `services/`, `config/`, `api/`, `scripts/tracker/`. Stage by name. No network except reading local fixtures. No orders, env, deploy, secrets. If a rule cannot be expressed under the contract, say so instead of bending the contract.
