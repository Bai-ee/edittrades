# S5 — HTF-entry post-mortem on the saved 2-year replay (research only, no live change)

Owner decision 2026-09-28 (`docs/OWNER_DECISIONS_2026-09-28.md`): review effort moves to the new strategies. The legacy flag thresholds stay frozen; new-strategy rule changes are allowed with a replay study attached. This study is the first one.

## Question

The HTF-anchored entry rule (`lib/htfEntryRule.js`, T-20) replayed on 2 years as 1,776 signals, 27.7% wins, net R mean −0.18 (90% LB −0.25), median −1.15, better than its random-direction control (−0.34) but negative. Most signals stop out. Is there a subset or an exit that turns the mean positive with a positive bootstrap 90% lower bound? Answer with numbers, and either one concrete rule tweak or a clear "no".

## Inputs (already on disk, do NOT rerun scripts/swing/run.js — 3.5 h per rule)

- `docs/swing/htf-entry-1m.json`, `docs/swing/ctl-htf-random-1m.json`, `docs/swing/ctl-htf-15mstop-1m.json` — per-signal rows under `perSymbol.<SYM>` (`closedThrough, symbol, direction, entry, stop, tp1, tp2, reason[], outcome{status,r,holdCandles}, netDir, netSens`).
- `test/fixtures/history/deep2y-2026-09-26` — 1m/5m/15m/1h/4h/1d candles (machine-local, gitignored; symlink it into your worktree from the main checkout).
- `scripts/swing/analyze-htf.js` — the standard table; reuse `bootstrapMeanLowerBound90` from `scripts/tracker/aggregate.js`.
- `docs/HTF_ENTRY_STUDY_2026-09-27.md` — the baseline; `docs/RETEST_ENTRY_STUDY_2026-09-27.md` and `docs/EXITS_STUDY_2026-09-26.md` for method precedent.

## Deliverables

1. `scripts/research/htf-postmortem.js`: re-walks every saved signal on the 1m fixture from its `closedThrough` (max 72 h hold, same as the replay), recording MFE/MAE in R and the candle path, then scores alternative exits on the SAME signals: baseline; trail at +1R / +0.5R (tighten-only, like T-15); partial 50% at +1R then trail; time stops 6 h / 12 h / 24 h; TP at 2R instead of measured move. Net R uses the same cost model as the harness (`netDir`).
2. Slices, each with n, mean net R, 90% LB, median, win %: by symbol; by 4h/1D regime strength (distance of price to EMA21(4h) in ATR, EMA21–EMA200 spread); by stop width bucket (<1%, 1–1.5%, 1.5–2%, >2%); by trigger timeframe (1m vs 5m); by UTC hour block (0–8, 8–16, 16–24); by breakout vs retest trigger (`reason[1]`); by prior 1h impulse size in ATR.
3. Out-of-sample discipline: every winning slice or exit must hold in both halves of the window and beat the random control on the same slice. State plainly if nothing does.
4. `docs/HTF_POSTMORTEM_2026-09-28.md`: method, tables, one recommendation (a single tweak with its exact numbers, or "no change"), and the caveats (selection over many slices, hourly hold-rule approximation noted in the baseline study).
5. `npm run test:htfpost` — a small test on synthetic paths (trail math, partial math, MFE/MAE).

## Hard rules

No changes under `lib/`, `api/`, `services/`, `config/`. No orders, no deploys, no env, no Vercel. Work in your own worktree (`git worktree add ../snapshot_tradingview-s5 -b s5-htf-postmortem`), stage by name, commit on the branch, do not push, hand back with the doc, the numbers and the recommendation. Keep every printed number reproducible from the script with a fixed seed.
