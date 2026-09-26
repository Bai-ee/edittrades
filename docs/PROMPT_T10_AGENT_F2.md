# Master prompt — Agent F2 (Sonnet): call-frequency study on the live rules (T-10, research only)

Work in a worktree: `cd /Users/bballi/Documents/Repos/snapshot_tradingview && git worktree add ../snapshot_tradingview-frequency -b frequency-study && cd ../snapshot_tradingview-frequency && ln -s ../snapshot_tradingview/node_modules node_modules`. Read `CLAUDE.md`, `docs/AGENT_SESSION_RULES.md`, `docs/GOOD_QUALITY_REPLAY.md` (the T6 phase-0 study: method, table, OOS rule), `scripts/replay-rules.js` (`VARIANTS`, `setConfigOverride`, `buildFrequencyMetrics`), `config/engine.json`, `docs/OWNER_DECISIONS_2026-09-24.md`, `test-replay-rules.js`.

Owner question (2026-09-26): the live rules produce ~1.3 GOOD calls/day (4 in 3 days; tracker report 2026-09-26). He wants ~10/day. Which rule relaxations get there, and what do they cost in expectancy? Research only: no live config change (rules are frozen until 2026-10-08), no deploy, no push.

## Deliverables
F2-1 **Baseline = the live config as deployed** (`configVersion 2026.09.24-5` semantics: gross minRR 2.5, net gate off, room-blocked on the candidate's own timeframe, retest-hold readiness, alert timeframes 3m/5m). Add it to `VARIANTS` as `L0` if not already representable; confirm with a one-line diff against the on-disk config.
F2-2 **Variants** (each a `VARIANTS` entry, labeled "owner rule change" where it touches a decided rule):
  - `L1a` minRR 2.25 · `L1b` minRR 2.0
  - `L2` room-blocked treated as WAIT (does not block readiness; TP1 capped at the blocking level instead)
  - `L3` readiness on breakout close (retest-hold off)
  - `L4` alert/plan timeframes 1m+3m+5m
  - `L5` = L1a + L2 · `L6` = L1a + L2 + L4 · `L7` = L1b + L2 + L3 + L4 (the "everything" bound)
F2-3 **Run** every variant over `test/fixtures/history/deep60-2026-09-24/` (if its manifest is missing, say so and use `deep-2026-09-24/` plus `2026-09-22/`, `2026-09-23/`) at `--step 1` where it fits in wall-clock, else `--step 5` and say so. Score with the existing outcome walker (first `ready` per candidate, gross R, net R at 0.34 % long / 0.14 % short per the owner's cost decision, and 0.20 % sensitivity).
F2-4 **Report** `docs/FREQUENCY_STUDY_2026-09-26.md`: one table, rows = variants, columns = n, resolved, win %, gross exp R, net exp R, max losing streak, **GOOD/day**, **days with ≥ 1**, **days with ≥ 5**, plus the OOS half-split pass/fail from the T6 method. Then a two-paragraph reading: which variants reach ≥ 5/day and ≥ 10/day, and what each costs. No recommendation to change rules; the owner decides.
F2-5 Tests: `test-replay-rules.js` covers each new variant's config override (fails, not skips, when the fixture is missing). `npm run test:replay` + `test:rules` green. `git diff --check`.
F2-6 Commit on branch `frequency-study` by file name (scripts/replay-rules.js, test-replay-rules.js, the report, CHANGELOG line). Do not push. Handback: the table, runtime per variant, and any variant you could not express through `setConfigOverride` without code changes (list the code change needed, do not make it).

## Hard rules
No change to `config/engine.json`, `services/`, `lib/` (research harness only). Never stage files you did not change. No network beyond reading local fixtures. No orders, no env, no deploy.
