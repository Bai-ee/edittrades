# Plan — risk guardrails from the cost-gate / sizing studies (2026-09-27)

Plan only. No code. Evidence: `docs/COST_GATE_STUDY_2026-09-26.md` (incl. the 2026-09-27
addendum) and `docs/RISK_SIZING_STUDY_2026-09-26.md`.

## Objective

Keep losses small while the engine has no proven net edge. Sizing rules cannot create edge;
they decide how much a losing stretch costs. Observed losing streaks: 11 median, 17 p95.

## Current architecture (what already exists)

Two separate layers:

1. **Signal engine** (`config/engine.json` → `risk`, `scalp`; `lib/flagTradePlan.js`;
   `services/scalpContext.js` sizing block). Publishes plans and a suggested size.
   - `risk.maxWalletRiskPct: 2` drives the payload's suggested size.
   - Stop gate: only a max (`scalp.maxStopDistancePct: 3`). **No minimum.** Plans with
     stops under 0.02% reach `ready` and dominate the replay losses.
2. **Execution policy** (`lib/execution/riskPolicy.js`, `evaluateRiskPolicy`). Refuses
   trades. Profiles:
   - `steady` (default): 1% per trade before G1, 0.5% after (ceiling 2%), daily DD 3%, weekly DD 8%,
     `minStopPct` long 1.5 / short 1.0 (`stop_too_tight`), tier multipliers A 1.5 / B 1 / C 0.5.
   - `aggressive`: 2.5% per trade, daily 6%, weekly 15%, `minStopPct` long 1.0 / short 0.7.
   - Env fallback `RISK_DEFAULTS`: 0.5% per trade, daily 3%, weekly 8%.

## Gaps vs the study

| Rule from study | Status |
| --- | --- |
| Reject near-zero stops (≥ 0.1%) at the engine | Missing — engine has no min stop |
| 0.5% risk per trade | Execution env default is 0.5%, but `steady` is 1% (tier A 1.5%); engine payload uses 2% |
| Daily loss cap (~3R) | Covered: `dailyDrawdownPct` 3% (= 6R at 0.5%) |
| Peak-to-trough kill switch (15%) | Missing — only daily/weekly windows, no high-water mark |
| Pause after N consecutive losses | Missing (low value in sim; optional) |
| Min stop ≥ 0.8% for fee drag | Covered for execution: `steady` 1.5% long / 1.0% short |
| Shorts negative on every variant | Undecided — wait for the 2-year re-run |

## Proposed direction (smallest safe path)

- **Phase G1 — execution policy (not an engine rule, so not under the 2026-10-08 freeze):**
  1. `steady.riskPctPerTrade` 1 → 0.5; keep `riskPctCeiling` 2. Tier A becomes 0.75%.
  2. Add a high-water-mark kill switch: `maxDrawdownFromPeakPct` (steady 15, aggressive 25),
     refusal reason `peak_drawdown`. On breach, trip the executor's existing kill switch
     (`setKill`, env or Blob, `lib/execution/executor.js`) so the reset is the existing
     PIN-gated `clearKill`. Needs one new persisted value: peak equity (Blob, next to the kill state).
  3. Optional: `pauseAfterConsecutiveLosses` (steady 6), clears at the next UTC day.
  - Tests: `npm run test:riskpolicy` (extend); no MCP/payload change.
- **Phase G2 — engine (after the freeze, 2026-10-08):**
  1. Add `scalp.minStopDistancePct: 0.1`; `lib/flagTradePlan.js` rejects below it with a new
     `stop_distance_below_floor` reason (mirror of `stop_distance_exceeds_cap`). configVersion bump.
  2. `risk.maxWalletRiskPct` 2 → 0.5 so the payload's suggested size matches `steady`.
  3. Replay L0 before/after on deep60 to confirm the floor removes the outlier losses only.
- **Phase G3 — direction: dropped (2026-09-27).** The 2-year V6 re-run shows pre-July-2026
  shorts at breakeven-to-slightly-positive and longs no better
  (`docs/COST_GATE_STUDY_2026-09-26.md` addendum 2). No short suppression.

Status 2026-09-27: G1 built (`afb1470`, `upgrade-signal-engine`, not deployed). G2 built
(`79260a6`, branch `risk-guardrails-g2`, merge on/after 2026-10-08).

## Keep vs change

- Keep: the 3% scalp stop cap and the canonical `NO_TRADE` path, env caps in `gates.js` as
  hard floors, profile structure, tier multipliers, `minStopPct` values, the MCP read-only rule.
- Change: the values and additions above only.

## Files likely involved

- G1: `lib/execution/riskPolicy.js`, `lib/execution/executor.js` (peak persistence, trip
  `setKill`), `test-risk-policy.js`.
- G2: `config/engine.json`, `config/engine.js` (docs + configVersion), `lib/flagTradePlan.js`,
  `test:sltp`/`test:config` tests, `docs/EDITTRADES_MCP_CONNECTOR.md`, `openapi/scalp-context.yaml`
  if a reason code is published, `CHANGELOG.md`.

## Risks

- The high-water mark needs durable state; a lost or reset value silently disables the kill switch.
  Fail closed (refuse) when the peak is unreadable, and log it.
- Lower risk per trade also lowers the fixed-size minimums; check the exchange's minimum
  position size against small wallets.
- The G2 min-stop floor changes GOOD-call counts slightly (the removed calls were mostly noise).
- The Jupiter swap-fee-on-collateral reading is from the docs, not yet from a real fill.

## Phase order and approval

G1 → (freeze lifts) G2. G3 dropped. Each phase needs owner approval before coding.
