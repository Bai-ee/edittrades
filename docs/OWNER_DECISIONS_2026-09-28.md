# Owner decisions — 2026-09-28

## Review effort moves to the new strategies; the freeze narrows to the legacy flag thresholds

**Context.** The flag engine's live record on the tracker: 17 scored GOOD calls since 2026-09-24 (6 wins / 11 losses, +0.51R gross, −3.10R net). Since the net stop floor went live (2026-09-27 midday) it has produced 0 GOOD calls. The Steady 30-trade evaluation has 0 evaluation trades. RETEST 1H and HTF_1M classes have 0 signals. T-20 HTF-anchored entries shipped live 2026-09-28 (schema 1.29.0, config 2026.09.27-3); its 2-year replay, run after release, is negative (1,776 signals, 27.7% wins, mean −0.18R net, median −1.15R) but beats its random-direction control (−0.34R).

**Decision (owner, 2026-09-28, chat: "the rule changes for the old set up can be changed at this point; we should be reviewing the new strategies").**

1. The engine freeze (to 2026-10-08) now covers only the legacy flag-engine thresholds (`config/engine.json` flagPlan / scalp / retest gates). Those stay as-is; no further tuning effort on the legacy flag rule.
2. New-strategy rule changes (HTF-anchored entries, spot EMA20 trend, RETEST 1H) are allowed before 2026-10-08, each with a replay study attached and recorded here.
3. Review order: (a) S5 HTF post-mortem on the saved 2-year replay (`docs/PROMPT_S5_HTF_POSTMORTEM.md`); (b) spot EMA20 paper-to-live plan P3 (`docs/PLAN_SPOT_LIVE_P3.md`, plan only). RETEST 1H and the SMA200/Quattro candidates stay parked.
4. HTF ENTRY keeps its Open button for now (owner's earlier release decision stands); revisit after S5.
