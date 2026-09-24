# edittrades-tracker

Automatic record of every EditTrades engine call, scored against later closed candles, with one review page.

- Every 10 minutes, `collect` reads `GET /api/scalp-context` (BTC, SOL, ETH) and stores one row per symbol in `data/calls/YYYY-MM-DD.jsonl`, plus the closed 1m/5m/15m candles from the same response in `data/candles/<tf>.jsonl`. Account, wallet, balance, margin and holdings fields are stripped before anything is written.
- Every hour, `score` walks each call forward over the stored 1m candles and writes `data/outcomes.jsonl`; `aggregate` writes `data/aggregates.json`; `build-page` writes `docs/index.html` and `docs/report.md`.
- The page and report show numbers only. Nothing here changes an engine threshold.

The scripts are synced from the engine repo (`snapshot_tradingview/scripts/tracker`, `npm run tracker:sync`). Edit them there, not here.

## Reading the page

Everything is **provisional; not evidence of an edge**. Sample sizes are small and R is gross (before fees and slippage); each plan's own net R:R is shown beside it.

- **Summary tiles**: last capture time; calls today (each change of recommendation class counts as one call); GOOD calls today; and, for ready flag plans over the last 7 days, fills, win rate (TP1 / (TP1 + stop)), expectancy (mean gross R per decided trade) and the longest losing streak.
- **Open calls right now**: calls still inside their 24 h window. `pending` = waiting for a fill or for a conditional plan to become ready; `open` = filled, neither stop nor TP1 touched yet.
- **Last 7 / 30 days**: recommendation calls by class and by primary reason code; ready plans by symbol and timeframe; plans by status; counts of chase, rr_below_min and room rejections.
- **By day** and **Call log**: each call with its class, levels (entry / stop / TP1), outcome, R and minutes to resolution.
- **Data health**: capture gaps, DATA_UNAVAILABLE captures, Pyth mark drift, 1m candle coverage.

How calls are scored:

- A **ready** plan is filled at the ready close at its entry level, then walked on 1m candles: stop first means -1R, TP1 first means +R to TP1. A same-candle stop and target counts as a stop.
- A **conditional** plan counts only if it becomes ready (same candidate) within 24 h, and takes that ready plan's outcome. Otherwise it is `not_filled`.
- A **rejected** plan is counted by reason code and not walked.
- A **recommendation** takes the walk of the plan it points at: GOOD on a ready plan is scored like a ready plan. WATCH and BAD with levels get a counterfactual walk (the entry has to be touched within 15 one-minute candles). No levels means `no_levels`.
- Anything unresolved 24 h after the call is `expired`.

## Running locally

Node 20 or later. No dependencies.

```bash
export SCALP_CONTEXT_API_KEY=...   # never commit this
node scripts/collect.js --data data
node scripts/score.js --data data
node scripts/aggregate.js --data data
node scripts/build-page.js --data data --out docs
open docs/index.html
```

Every script takes `--data <dir>` (default `./data`); `build-page` also takes `--out <dir>` (default `./docs`). `score`, `aggregate` and `build-page` accept `--now <iso>` for replays.

## Secrets

Two repo Actions secrets, read from the environment by `collect`, never logged or written to disk; nothing in this repo holds a key:

- `SCALP_CONTEXT_API_KEY` - the bearer for `GET /api/scalp-context`.
- `BLOB_READ_WRITE_TOKEN` - only the store id inside it is used, to find the trade journal's public Blob files (`journal/manifest.json`, then `journal/YYYY-MM-DD.jsonl`). The token itself is never sent anywhere. `JOURNAL_BLOB_BASE` (the public base URL) or `--journal-base <url>` replaces it; `--no-journal` skips the pull.

## Trade journal

What you tell the GPT (`log took BTC long 84600 stop 84390 tp 85100`, `log closed BTC +1.2R`, `log skipped SOL`) is stored by the engine's `POST /api/journal` and pulled here into `data/journal/YYYY-MM-DD.jsonl` on every run (deduped by id). `score` scores each `open` like a ready plan (filled at your entry, stop vs TP1, 24 h), or takes your reported R / exit price when you logged a matching `close`; results go to `data/journal-outcomes.jsonl`. The page shows them as the dashed "your trades" line on the equity chart (same filters), entry/exit ticks on the wallet chart, an "Engine vs you" block and a journal log.
