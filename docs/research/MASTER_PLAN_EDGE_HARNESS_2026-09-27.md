# Master plan — edge harness + strategy evidence build (2026-09-27)

Owner instruction (2026-09-27): build every research recommendation in `RESEARCH_BACKLOG.md` (Cards 1–7) and `EXTERNAL_HARNESS_REFERENCES.md` that can meaningfully improve our chances of finding and implementing an edge. Order by effectiveness and effort, and run as many parallel Sonnet agents as possible.

**Governing rule:** an edge must survive fees, slippage, borrow and execution. Every output reports net results under actual costs, as defined below, plus the break-even cost.
- Perps: 0.20% long / 0.14% short round trip, plus ≈ 0.02–0.024%/h Jupiter borrow.
- Spot: 0.15% per side.

## Scope boundary (non-negotiable)

- **Research code only:** `scripts/research/**`, new `test-*.js`, `docs/research/**`, and `var/` outputs.
- **Engine freeze until 2026-10-08:** no changes to `api/`, `lib/`, `services/`, `scripts/tracker/` or `public/`.
- No deploys, trades, alerts or `.env` reads (`docs/AGENT_SESSION_RULES.md`).
- The tracker data in `../edittrades-tracker/data` is read-only.
- **Deferred until after the freeze, and only with an owner go:**
  - R13 (code SHA in `lib/servedCalls.js`).
  - Card 5.3 (MACD/OBV in the engine payload).
  - Card 1.3 (paper arm in the tracker; the tracker files are dirty in another session).
  - Any live-signal change suggested by the outputs.

## Work packages (priority = impact ÷ effort; all run in parallel)

| WP | Items | Priority | Effort | Branch / worktree | Output |
| --- | --- | --- | --- | --- | --- |
| WP1 | R1 + R1+ causality auditor (all swing rules, `runSma4h`, edge families; closed-candle gate, HTF availability, timestamp chain, label-purge helper, partial-data) + Trend Atlas tamper-test reference (7.2) | 1 | S–M | `edge/wp1-causality` | `scripts/research/harness/causality-audit.js`, `test-causality-audit.js` |
| WP2 | R2 indicator warm-up audit (live `limit=500` vs long history, per indicator × timeframe) | 1 | S | `edge/wp2-warmup` | `scripts/research/harness/warmup-audit.js` + report |
| WP3 | R3 Jesse-method significance, R4 trade-order shuffle, R7 candle block-bootstrap MC, 4.2 global trial ledger + deflated Sharpe | 1 | M | `edge/wp3-stats` | `scripts/research/harness/{significance,montecarlo,trial-ledger}.js` + tests |
| WP4 | R3b matched-random controls + 6.3 per-trade evidence for `re-flag-retest-1h` | 1 | M | `edge/wp4-matched` | `scripts/research/harness/matched-controls.js` + report |
| WP5 | R5 cross-venue OHLCV + funding history via direct REST (Bybit/OKX; no new deps) + 6.2 re-cost the “borrow kills” group with real funding carry | 2 | M | `edge/wp5-venues` | `scripts/research/edge/fetch-venue.js`, `carry-rerun.js` + report |
| WP6 | 6.1 real Jupiter borrow rates (read-only public data; current + any available history) | 2 | S–M | `edge/wp6-borrow` | `scripts/research/edge/jupiter-borrow.js` + report |
| WP7 | 4.1 DCA benchmark, 7.1 Trend Atlas vol-target + no-trade buffer overlay, 1.7 BTC/ETH/SOL portfolio, 1.6/4.4 registered slow-trend variants (20-week SMA, 4-week Donchian) — spot | 2 | M | `edge/wp7-spot` | `scripts/research/edge/spot-overlays.js` + registration + report |
| WP8 | 2.1/2.2 Quattro: both EMA200 interpretations, single unit first, then pyramid arm; spot costs + perps borrow break-even; BTC/ETH/SOL | 2 | M | `edge/wp8-quattro` | `scripts/research/edge/quattro.js` + report |
| WP9 | 5.1/5.2 MACD + OBV research indicators + evidence (MACD-cross entries; OBV-confirmed vs unconfirmed breakouts), net of costs | 3 | M | `edge/wp9-indicators` | `lib.js` additions + `scripts/research/edge/indicator-evidence.js` |
| WP10 | R12 horizon backfill, R11 WAIT scoring, R15 confidence calibration, R14 reason-code attribution, R10 drift-baseline report, 4.3 side-mix audit (tracker data, read-only) | 1 | M–L | `edge/wp10-tracker-evidence` | `scripts/research/tracker-evidence/*.js` + report |
| WP11 | R6 Freqtrade independent SMA200 reproduction (external venv) + R8 adaptive same-bar ordering bound on swing signals | 3 | M | `edge/wp11-validate` | scratch Freqtrade strategy + `scripts/research/harness/adaptive-walk.js` + report |

## Integration (orchestrator)

1. Each WP commits on its own branch from `edge-external-4h-sma200`. It must not edit `package.json`, `RESEARCH_BACKLOG.md`, `DOCUMENTATION_INDEX.md`, or another WP's files.
2. The orchestrator merges each branch into `edge-external-4h-sma200`, adds `package.json` test scripts, reruns every new test and `git diff --check`, and **independently spot-checks headline numbers**.
3. Backlog cards are updated with results. Each result is classified REJECT / INCONCLUSIVE / PAPER CANDIDATE. Negative results are kept.
4. Nothing is pushed or merged to main without an owner go.

## Definition of done

- Every WP has code, tests passing, a report `docs/research/harness/<WP>.md` with commands and pinned inputs, and results net of costs.
- The backlog is updated.
- A single consolidated summary lists what the evidence says about where an edge can survive costs.
