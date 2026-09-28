# T-21 — Tracker starts from zero per strategy: strategy scoreboard + archive (site only)

Owner decision 2026-09-28 (chat: "i want the website to start from zero and track each strategy's success separately"; "GO" on the archive option). Presentation + aggregation change in the tracker scripts only. No engine change, no deploy, no data deleted.

## Objective

`index.html` leads with one scoreboard card per strategy, each counting from zero at the moment that strategy went live in its current form. Everything captured before a strategy's epoch stays on the site in a collapsed archive section, never deleted.

## Strategies and epochs

| key | label | epoch (counts from) | rows |
|---|---|---|---|
| `flag` | Flag engine · net floor (live, tradable) | first capture row with `configVersion` `2026.09.27-2` (the NF stop floor deploy, 2026-09-27) | GOOD calls from the 1-minute alert log (`good-call-outcomes.jsonl`) with `calledAt >= epoch` |
| `htf` | HTF-anchored entries (live, tradable) | first capture row with `configVersion` `2026.09.27-3` (2026-09-28) | `HTF_1M` class rows |
| `retest1h` | RETEST 1H (paper) | first `RETEST_1H` alert-log line, else same as `flag` | `RETEST_1H` class rows |
| `spot` | Spot EMA20 trend (paper) | `data/spot-trend/meta.json` `startDate` | spot ledger |
| `wallet` | Live wallet · Steady profile | `2026-09-26T22:08:00Z` (evaluation start, `docs/PLAN_LIVE_PERPS_TEST.md`), constant | journal fills / wallet equity |

Put the table in a new `scripts/tracker/epochs.js`: `deriveEpochs(dataDir)` returns `{key: {label, epochIso, source: 'capture'|'alert'|'meta'|'constant'}}`, with documented constant fallbacks if a derivation finds nothing (log which was used). Epochs are computed at build time and written into `aggregates.json` so the page and the markdown report agree.

## Scoreboard (top of index.html, after the status tile, before Performance)

One `zone` "Strategy scoreboard · each from its own start", one `tile` per strategy, id `scoreboard-<key>-tile`, same columns in the same order for every card: status word (LIVE · tradable / PAPER / WALLET), days live, signals, resolved, wins, win %, net R mean, net R median, net R 90% lower bound, max DD (R), toward-30 count, one "how it exits" line. Spot card shows paper equity vs buy & hold and flips instead of R columns; wallet card shows equity now vs start, trades, realized net, kill/arm state. Empty state per card: `[NO SIGNALS SINCE <epoch date>]`, never a blank.

The home hero headline number and the 7d/30d Performance windows switch to the epoch-filtered flag rows; label them "since 2026-09-27 (net floor)". `report.md` mirrors the scoreboard table.

## Archive

New collapsed section at the bottom, id `archive-section`, title "Archive · before the strategy epochs": the old blended totals, config-boundary table, the pre-epoch GOOD-call table and the old 7d/30d windows exactly as they render today, unchanged, inside a `<details>`. Nothing is removed from `data/`.

## Other pages

`product.html` "Tracking how-tos": one row explaining epochs and the archive. `how-to.html` tracker tiles: one line. `strategies.html`: unchanged (wallet profiles already have their own start).

## Tests

`test-tracker.js`: epochs derive from fixtures and fall back to constants; per-strategy stats exclude pre-epoch rows; scoreboard renders every card with stable ids and the empty state; archive contains the pre-epoch rows; hero reads the epoch-filtered numbers; `report.md` parity. Keep `npm run test:tracker` and `test:archmap` green (add `epochs.js` to `docs/ARCHITECTURE_MAP.json`).

## Hard rules

Tracker scripts under `scripts/tracker/` and their tests only; no `lib/`, `api/`, `services/`, `config/`. Stable kebab-case ids on every new container. No new libraries. Work in a worktree (`git worktree add ../snapshot_tradingview-t21 -b t21-scoreboard`), stage by name, commit on the branch, do not push, do not run `tracker:sync`. Hand back with files changed, test counts, a rendered `index.html` from `npm run tracker:page` on the tracker repo's data (`/Users/bballi/Documents/Repos/edittrades-tracker/data`, read-only copy into your scratch dir) and any epoch that fell back to a constant.
