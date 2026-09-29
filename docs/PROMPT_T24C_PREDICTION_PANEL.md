# T-24c — Homepage prediction panel: big overall hit rate on top, one table of token · timeframe · current call · hit rate

Owner, 2026-09-28 night: "a single table on the right hand side showing the token, tf and prediction, with the larger winning percentage on top that averages them all together." Presentation + one tracker aggregate field. No engine change. Worktree `pred-panel` from `origin/upgrade-signal-engine` (≥ eb595cb, which has T-24 merged). Files: `scripts/tracker/predictions.js`, `scripts/tracker/build-page.js`, `scripts/tracker/home-hero.js` (placement only), `scripts/tracker/page-style.js` or the module's own CSS const, `test-tracker.js`, `CHANGELOG.md`. Read `docs/AGENT_SESSION_RULES.md`. Commit by file name, no push, no deploy, no tracker:sync.

## Aggregate
`computePredictionsAggregate` adds `current`: for each `<SYM>:<tf>` the latest `PREDICTION` row (by `closedAt`) that has no `PREDICTION_RESULT` yet → `{ direction, confidence, closedAt, refClose }`, else the latest prediction with its result → `{ ..., resolved: true, hit }`. Keep every existing field.

## Panel (`id="home-hero-prediction-panel"`)
- Sits in the hero's right column where the live board / net-R card is (the grid `grid-template-areas` in HOME_HERO_CSS: headline · now · board); on phones it stacks under Right-now. The live board (`live-board.js`) moves directly below the hero, full width, unchanged inside. The old `zone-predictions` block is removed from the body list (its renderer stays exported for `predictions.html`).
- Top: `id="pred-overall-rate"` oversized figure = `overall.hitRate` as a percent, one decimal, with `n` and `since` in small type under it, and one line `coin flip 50% · same-as-last <x>%`. Empty state: `—` with `[NO PREDICTIONS YET]`, panel never hidden.
- Under it one table `id="pred-current-table"`, 12 rows ordered BTC, ETH, SOL × 5m, 15m, 1h, 4h, row ids `pred-row-<sym>-<tf>`. Columns: token · tf · **next candle** (▲ over / ▼ under / · no call, from `current`) · hit rate (`cells[key].hitRate` as percent, `n` small) · last (✓/✗/– from the latest resolved result). Colour only when n ≥ 30 and hitRate beats both baselines; no colour otherwise.
- Footer line links `predictions.html` ("every call, every close →").
- Monospace numbers, same bento tokens, fits 40vh on desktop, table scrolls inside the panel if taller.

## Tests (`test-tracker.js`, count ≥ 189 + 6)
`current` picks the unresolved latest per cell and falls back to the resolved one; panel ids present for all 12 rows in order; overall figure formatting; empty state text; live board rendered below the hero; `zone-predictions` absent from index, present in predictions page.

## Report
Rendered panel text for one populated cell and the overall line (synthetic rows), test counts before/after, commit hash.
