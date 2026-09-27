# Master prompt — Agent N (Sonnet): trade charts with entry marker + RSI panel on every trade touchpoint (T-16)

Owner (2026-09-27): "this is what I should receive when tracking trades I took" — the chart with entry / SL / TP1 / NF stop / EMA21 / EMA200, a vertical ENTRY marker with the timestamp, and an RSI(14) panel underneath. Reference implementation the owner approved visually: `/private/tmp/claude-501/-Users-bballi-Documents-Repos-snapshot-tradingview/c7e89feb-d336-450c-a00e-18e01a3f8b36/scratchpad/mock-trades-v2.mjs` (copy what you need into `lib/chartRender.js`; the sample PNGs are in `~/Desktop/mock-trades/`).

Worktree off `origin/upgrade-signal-engine`, branch `trade-charts-v2`, commit by file name, no push, no deploy. Read `CLAUDE.md`, `docs/AGENT_SESSION_RULES.md`, `lib/chartRender.js` (`buildChartSpec`, `tradeOverlay`, `computeLayout`, `renderChart`, `renderContextChart`, `CHART_HEIGHT`, `CHART_MAX_BYTES`), `services/scalpContext.js` (`chart.onSeries` / `chartWindow`), `api/telegram-webhook.js` (Took it, live FILLED result, `/chart … trade`, tracking updates), `api/telegram-cron.js` (GOOD alert photo, TRACK updates), `lib/telegram.js` (captions), `test-chart-render.js`, `test-telegram.js`.

## Deliverables
1. `lib/chartRender.js`: `tradeOverlay` gains `entryAt` (ISO) → a vertical dashed ENTRY marker through the price panel with the label `ENTRY LONG 09-26 09:07z`; `indicators: ['rsi14']` → an RSI(14) panel (height ~170 px) under the price panel with 30/50/70 guides, the RSI line, and `RSI at entry 51.1`; the entry marker continues through the panel. RSI computed from the same candle window (Wilder), no new library. `CHART_MAX_BYTES` respected (check the sample PNGs are ~35 KB).
2. Every trade touchpoint sends this chart: GOOD / GET IN NOW alerts (entry marker at the ready close), **Took it** and **live FILLED** (entry marker at the fill time, caption = the result card), TRACK updates for a taken trade (entry marker + current SL/TP after trailing), `/chart <SYM> <tf> trade`, and the journal-close card (**Closed here / Close** results: entry marker + an EXIT marker with the exit price/R). One `sendPhoto` each; captions ≤ 1000 chars; charts on the flag's own timeframe by default with `/chart … trade 15m` allowed.
3. Tracker: store the PNG for taken trades? No — too heavy. Instead, `data/journal-outcomes.jsonl` rows get `chart: { symbol, timeframe, entryAt }` so the site can re-render on demand later (describe; do not build the site part).
4. Tests: overlay geometry (marker x from `computeLayout`, RSI panel scale), RSI math on a synthetic series (mirrored), each touchpoint sends a photo with the right caption and marker time, byte cap. All `npm run test:*` green; `git diff --check`; guard scan 0/0/0.
5. Docs: `docs/PLAN_TELEGRAM.md` (charts on trades), CHANGELOG, how-to sentence (describe).

## Hard rules
No engine, rule, cap, or gate changes. Presentation only. Never stage files you did not change. No env, orders, deploy, secrets.
