# S2 — Rule variants on the live flag calls (one Sonnet agent, research only)

Owner (2026-09-26): after the conditions study (`docs/CONDITIONS_STUDY_2026-09-26.md`: 95 % of GOOD calls carry a stop < 0.5 %, median net −3.2R; nothing but stop distance moves the number), test concrete rule changes side by side on the same 85 days. Research only: no live config change (frozen until 2026-10-08), no deploy, no orders. Worktree off `origin/upgrade-signal-engine`, commit by file name, no push. Read `CLAUDE.md`, `docs/AGENT_SESSION_RULES.md`, `docs/GOOD_QUALITY_REPLAY.md`, `docs/FREQUENCY_STUDY_2026-09-26.md`, `docs/CONDITIONS_STUDY_2026-09-26.md`, `scripts/replay-rules.js` (`VARIANTS`, `gate: 'ruleVariant'`, `setConfigOverride`), `scripts/research/conditions.js` (how it scores first-ready calls with `scripts/swing/run.js` `scoreSignal`: fill window, stop, TP1, 24 h timeout close-out, net of `scripts/tracker/costs.js`), `lib/flagTradePlan.js` (`netFloorStopDistance`, NF shadow), `lib/candidateQualifier.js`, `lib/patternDetector.js` (stoch weight), `lib/biasMatrix.js`, `services/indicators.js` (RSI already computed), `lib/geometry.js` (swing pivots).

## Baseline and scorer
`L0` = live config verbatim. Score every variant with the SAME scorer as the conditions study (first-ready call per candidate, fill window, stop/TP1, 24 h timeout close-out, net R at 0.34 % long / 0.14 % short, 0.20 % sensitivity), over `test/fixtures/history/deep60-2026-09-24/`, all three symbols, step 1. Report mean AND median net R (single tiny-stop rows dominate means), n, win %, gross R, calls/day, days with ≥ 1, max losing streak, median stop %, OOS first/second half (median net R), pass = median net R > 0 in both halves. One table, rows = variants. Each variant labeled "owner rule change" where it touches a decided rule.

## Variants (add to `VARIANTS` / `ruleVariant` opts; new code only in `scripts/`)
1. `NF-live` — the T-13 net-floor rule applied for real: stop distance ≥ max(0.5 × ATR(15m), 3 × directionCost), TP1 unchanged, plan ready only when net R:R ≥ 1.0 and gross ≥ 2.5.
2. `NF-live+minRR2` — NF-live with gross floor 2.0.
3. `RSI` — RSI(14) replaces StochRSI in its four live roles: detector score term (`patternDetector` stoch weight → RSI slope/level term with the same weight), qualifier exhaustion reason (`stoch:ob-cross` → `rsi:ob` when RSI > 70 on a long / < 30 on a short), bias-matrix basis (`stoch` → RSI > 50 bullish / < 50 bearish, same 0.5 weight), divergence evidence (RSI divergence in place of Stoch). Implement as replay-time overrides/injection; do not edit `lib/` (wrap or monkey-patch inside the research script and say exactly how).
4. `NF-live+RSI`.
5. `NF-live+5m` — flag timeframes 5m only.
6. `NF-live+shorts` — shorts only.
7. `ATR-stop` — stop = 1 × ATR(15m) from entry instead of the flag invalidation (TP1 recomputed to keep the plan's R:R rule).
8. `MACD-agree` — take the call only when MACD(12,26,9) histogram on the flag's own timeframe has the trade's sign at the ready close.
9. `MACD-agree-15m` — same test on 15m.
10. `GP-filter` — take the call only when the breakout level lies inside the 0.618–0.65 retracement of the last completed swing (pivots from `lib/geometry.js` on the flag's timeframe) in the trend direction.
11. `GP-entry` — enter at the first touch of the golden-pocket zone after the ready close instead of at the breakout; stop/TP1 unchanged; not filled if untouched within 24 h.
12. `NF-live+MACD-agree+GP-filter` — the stack.
13. `exit-trail1r` — L0 entries with the best exit from `docs/EXITS_STUDY_2026-09-26.md` if that doc exists on `origin/upgrade-signal-engine` or branch `exits-study` (else trail 1R behind best price after +1R). Also `NF-live+exit-trail1r`.

## Deliverables
`scripts/research/variants.js` (+ `npm run study:variants`), tests in `test-variants-study.js` for each filter/entry rule on synthetic paths (mirrored long/short, no lookahead), `docs/VARIANTS_STUDY_2026-09-26.md` with the table and a short reading per variant (one line each) plus the count of hypotheses tested. All existing `npm run test:*` green; `git diff --check`. Commit on branch `variants-study`; do not push.

## Hard rules
Nothing under `lib/`, `services/`, `config/`, `api/`, `scripts/tracker/` changes. Stage by name. No network. No orders, env, deploy, secrets.
