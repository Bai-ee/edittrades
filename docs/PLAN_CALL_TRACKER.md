# T1 — Call tracker: automatic collection, scoring, and a daily review page

Last updated: 2026-09-23
Status: built 2026-09-23. Page: https://edittrades-tracker.vercel.app (public URL, no account data). GitHub Pages and 10-min cadence dropped: GitHub Free bills private-repo Actions at 1 min per job, so one merged job every 30 min (1,440 min/month) with Kraken 1m backfill for candle continuity.
Goal: every engine call (flag plan + 21/200 recommendation) is recorded automatically, scored against later closed candles, and shown on one page the owner opens day to day. No self-tuning: the page shows numbers; threshold changes stay owner decisions.

## Shape

```
GitHub repo  edittrades-tracker  (new, private)
  .github/workflows/track.yml     every 30 min: collect (REST + Kraken 1m backfill) → score → aggregate → page
  vercel.json                     Vercel deploys docs/ on every push → https://edittrades-tracker.vercel.app
  data/calls/*.jsonl              one line per symbol per capture (no account/wallet fields ever)
  data/candles/*.jsonl            closed 1m/5m/15m candles lifted from the same payload (scoring source)
  data/outcomes.jsonl             one line per scored call
  docs/index.html                 the review page (GitHub Pages, private repo ⇒ owner-only)
```

Why a separate repo: no commit noise in the engine repo, Pages hosting for free, git history is the audit log. Why GitHub Actions: no new Vercel function (12-cap), no Vercel cron limits, no new storage service.

## Build (single implementer pass, Opus)

1. **Collector** `scripts/tracker/collect.js` (lives in the engine repo, copied into the tracker repo's workflow): calls the REST endpoint with `SCALP_CONTEXT_API_KEY` from a GitHub secret, writes per symbol: `capturedAt, closedThrough, schemaVersion, configVersion, symbol, price, mark{price,driftBps,status}, flagTradePlan (full), flagRecommendation (default record), candidateSetups (slim: id, tf, dir, state, breakout, invalidation, measuredRR, qual), decisionTrace.bias`. **Strips `account`, `wallet`, `performance`, `margin` before writing. A test asserts no such key can reach disk.** Dedupes on `closedThrough` per symbol (a 5-min cron sees the same close twice sometimes).
2. **Candle store**: from each capture, append the payload's closed 1m/5m/15m candles not yet stored (keyed by timestamp). 5-minute captures with 20 published 1m candles give contiguous 1m coverage; 15m gives a long tail. Scoring never needs a live exchange call.
3. **Scorer** `scripts/tracker/score.js`: reuses `scripts/replay-outcomes.js` `walkOutcome` (exact published entry condition, ready fills at the ready close, R labeled gross; net shown from the plan's own `netRR`). Scores: every `ready` plan; every `conditional` plan that later became ready (linked by candidateId); every GOOD/WATCH/BAD recommendation as a "call" with its class. Outcome per call: `not_filled | tp1 | stop | open | expired` + R + minutes to resolution. Window: 24 h after entry, then `expired`. Idempotent: a call is scored once, re-scored only while `open`.
4. **Aggregates** (by day, by symbol, by timeframe, by class, by plan status, by reason code): calls, fills, win rate at TP1, avg R, expectancy, max losing streak, median time to TP1, chase/rr_below_min/room counts, GOOD count per day, mark drift stats, DATA_UNAVAILABLE count, capture gaps.
5. **Page** `docs/index.html` (static, rebuilt hourly, dark/light, phone-width): top row = last capture time, calls today, GOOD today, fills 7d, win rate 7d, expectancy 7d, losing streak; then "open calls right now" table; then 7d / 30d tables by class and by reason code; then a daily log (each call, its class, levels, outcome). Plus `report.md` with the same numbers for pasting into a chat. Provisional labels carried through: nothing on the page says "edge".
6. **Alerts (optional, later)**: none in this pass.

## Owner does once

- Create the private repo `edittrades-tracker` (or let me create it via `gh` on your say-so), enable Pages from `docs/`.
- Add repo secret `SCALP_CONTEXT_API_KEY` (same value as Vercel). I can set it via `gh secret set` if you say so; otherwise paste it in GitHub settings.
- Nothing else. The page URL is `https://<your-github-user>.github.io/edittrades-tracker/`.

## Costs and limits

- GitHub Actions: ~288 runs/day × ~20 s ≈ 1.6 h/day, inside the free 2,000 min/month for a private repo? No: 1.6 h × 30 = 48 h/month = 2,880 min > 2,000. **Use a 10-minute cadence (1,440 min/month) or make the repo public with no secret data on the page.** Recommend 10 min; the payload carries 20 1m candles so 1m coverage stays contiguous.
- Cron delay: GitHub can run scheduled jobs a few minutes late; captures are keyed by `closedThrough`, so gaps are visible, not silent.
- Engine load: one extra REST call per 10 min.

## Out of scope

Tier 2 (trades you tell the GPT; needs a write endpoint + key), real positions (3b), any threshold change, any MCP change, any engine change beyond adding the two scripts and their tests.

## Verification

- `test:tracker`: collector strips account fields (fails closed), dedupe, candle store, scorer on a synthetic day (long + short, tp1 / stop / not_filled / open / expired), aggregate math, page renders from an empty store.
- Dry run locally against prod for 30 min, then one Actions run, then the page loads on the phone.

## Decisions needed before code

1. Cadence: 10 min (recommended) or 5 min with a public repo.
2. Repo: I create it with `gh`, or you do.
3. Secret: I set it with `gh secret set`, or you paste it.

## Charts (added 2026-09-23)

Two inline-SVG charts after the Testing phase block, drawn in Node for the first paint and redrawn in the browser by the page's one inline script (no dependencies, no network) from two inline JSON blocks (`#tracker-calls-data`, `#tracker-wallet-data`). Code: `scripts/tracker/charts.js` (`chartKit` is self-contained and inlined into the page so both paths draw the same SVG). Monochrome: series separated by opacity and dash pattern; status color only on values. Everything labeled PROVISIONAL once per section.

**Chart 1: engine-call equity curve** (`#equity-chart-section`). Cumulative gross R of scored ready flag plans, 1R per call: TP1 = +R to TP1 as walked by the scorer, stop = −1R; `not_filled` and `expired` excluded; open calls are one hollow last point. Readout: n (TP1 + stop), win rate, expectancy, cumulative R, open count. Filters (segmented controls; OR within a dimension, AND across): class, reason code, symbol, timeframe, direction, plan status at call, top-down (`td:*` token side: supports / opposes / unknowns), EMA200 side (the call timeframe's `ema200:*` token), divergence (agrees / conflicts / mixed / none), mark drift bucket (|bps| ≤ 5 / 5–10 / > 10), hour of day (UTC, 4-hour buckets). Below it a by-filter table: n / win rate / expectancy / max losing streak for all scored calls, the selection, and each selected value. Empty state `[NO SCORED CALLS YET]` inside the chart frame. The dimensions come from `dims` on every scored row in `outcomes.jsonl` (`score.js callDims`: rec class and reason, supports/opposes/unknowns codes, plan status at the capture, candidate timeframe/direction/state, derived td/EMA200/divergence, closedThrough); rows scored before `dims` existed get them once, keeping their outcome and `scoredAt`.

**Chart 2: wallet value** (`#wallet-chart-section`). Total USD over time (solid), margin (dashed, lighter) and holdings (dotted, lighter); unavailable samples are gaps; a baseline rule when `baselineUsd` exists; the current total in Space Mono, colored by the sign of `pnlUsd`; range control 24H / 7D / 30D / ALL; small ticks on the curve at GOOD calls, captioned as coincidence only (attribution needs the trade journal, Tier 2, not built). Empty state `[NO WALLET SAMPLES YET]`.

**Wallet whitelist.** Owner decision 2026-09-23: the wallet value may be public; the address and the holdings breakdown never reach disk. `collect.js walletRowFromPayload` builds each `data/wallet.jsonl` row key by key: `{ t: closedThrough, status, marginUsd, holdingsUsd, totalUsd, baselineUsd, pnlUsd, pnlPct }` from `account.status`, `account.margin.usd`, `account.holdingsUsd` and `account.performance.{baselineUsd, netPnlUsd, returnPct}`. Numbers only; status must be a short lowercase word (else `unknown`; `absent` when there is no account block); any status other than `available` writes nulls; the write is refused if the key set is not exactly the whitelist. Call rows keep the full account strip. Tests: nothing from the address, holdings array, `byAsset`, gas, unpriced, reason or other account fields appears anywhere on disk (wallet.jsonl included), and wallet rows carry exactly the whitelisted keys.

## Journal (T2, added 2026-09-24)

The trade journal (`docs/PLAN_TRADE_JOURNAL.md`) now feeds this page. What the owner tells the GPT (`log ...`) is stored by `POST /api/journal` in Vercel Blob; `collect.js` pulls `journal/manifest.json` and the listed `journal/YYYY-MM-DD.jsonl` files over plain HTTP into `data/journal/` (dedupe by id; same sensitive-key strip as call rows). `score.js` scores each journal `open` like a ready plan (fill at entry, stop vs TP1, 24 h) unless a later `close` for the same symbol reports `resultR` or `exitPrice`, and copies `dims` from the engine call named by `engineRef.candidateId` → `data/journal-outcomes.jsonl`. Page additions: a dashed "your trades" line beside the engine-call line on the equity chart (same filters, `#equity-you-readout`), entry/exit ticks on the wallet chart (open = up, close = down, green/red by R, grey while unknown), `#engine-vs-you-section` (GOOD calls taken / skipped / not logged; WATCH/BAD taken as overrides, with outcomes), and `#journal-log-section` (last 50). Empty states: `[NO JOURNAL RECORDS YET]`, `[NO JOURNAL TRADES YET]`, `[NO OVERRIDES YET]`. The GOOD-tick caption no longer says the journal is unbuilt. Tracker secret added: `BLOB_READ_WRITE_TOKEN` (only its store id is used).

## Served calls (T3, added 2026-09-24)

`docs/PLAN_SERVED_CALLS.md`. The cron job only sees the engine's call at :07/:37; a call the Custom GPT receives between runs was never scored. Now `GET /api/scalp-context` records every JSON 200's calls to Blob `served/YYYY-MM-DD.jsonl` (+ `served/manifest.json`), and `collect.js` `pullServed` appends them to `data/calls/` as capture rows with `source: 'served'` (`--no-served` skips; same Blob base and strip as the journal). A served row at a close cron already captured is dropped; two served rows at one close are both kept only if class or plan status differ. Rows written before T3 read as `source: 'cron'`. `score.js` is unchanged except `dims.source`, so a served GOOD on a ready plan is scored `ready_prefilled` exactly like a cron one. Served rows never count as runs, last capture or capture health. Page: `#activity-served-row` ("Seen in chat · 24 h", GOOD count), a Via column (`cron` / `chat`) in the call log, and a `Via` equity filter. Note: the collector's own GET also records served rows; they are dropped at pull as cron duplicates.

## Flag paths (T4 P0, added 2026-09-24)

`docs/PLAN_FLAG_PATHS.md`. New step `scripts/paths.js` (after score, before aggregate) labels each engine flag candidate from its first `forming`/`proto` capture with `flag-paths.js` (retest_go / runner / false_break / fail_first / chop) into `data/paths.jsonl`; resolved rows are frozen, pending ones recomputed. `outcomes.jsonl` and `aggregates.json` are untouched (test asserts byte-identical). Stored candidates gain additive fields (`measuredTarget`, `compressionScore`, `durationCandles`, `impulseStrength`, `flagHigh`, `flagLow`). Page: `#flag-paths-section` (7d/30d path mix, UNCALIBRATED under n=100). ATR, Stoch and geometry features are not in capture rows, so they read `unknown` live; the replay report measures them.
