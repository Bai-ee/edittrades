# Plan — spot trend filter, phase 1: paper tracking (2026-09-27)

Plan only. No code yet. Evidence: `docs/EDGE_SEARCH_2026-09-27.md`.

## Objective

Run the daily EMA20 spot trend filter live on paper for BTC/ETH/SOL: one state per coin per
UTC day (IN = hold the coin, OUT = hold USDC), flip alerts, and a paper equity curve against
buy & hold. No orders, no wallet access. The goal is proving the plumbing and the signal
match the research, not proving the edge (3–4 weeks gives ~1–3 flips per coin; the edge
evidence is the 2017–2026 backtest).

## Current architecture (relevant parts)

- **Tracker** (`scripts/tracker/*`, synced to the tracker repo by `scripts/tracker/sync.js`):
  GitHub Actions `track.yml` every 10 min runs `collect → score → … → build-page`, commits
  `data/`, publishes `docs/index.html`. `collect.js` already fetches Kraken public OHLC.
  `alerts.js` opens a GitHub issue per GOOD call, which emails the owner (no secret needed).
  Extra pages follow the `strategies-page.js` / `risk-page.js` pattern.
- **Engine / Telegram** (Vercel): frozen for rule changes until 2026-10-08; `lib/telegram.js`
  is a shared file. Phase 1 does not touch either.
- **Research** (`scripts/research/edge/lib.js` `ema`, `spot-trend.js`, `spot-portfolio.js`):
  the reference implementation the tracker must match.

## Proposed direction

All in the tracker, read-only market data only:

1. `scripts/tracker/spot-trend.js` (new), run from `track.yml` after `collect.js`:
   - Fetch Kraken public 1d OHLC for BTC/ETH/SOL (same host and pattern as `collect.js`'s 1m
     backfill); keep closed candles only (closeTime ≤ now).
   - On each new daily close: EMA20 of closes → state IN if close > EMA20 else OUT; weight =
     min(1, 40% / 20-day realized vol) when IN (the vol-target variant), 0 when OUT.
   - Append one row per coin per day to `data/spot-trend/days.jsonl`
     (`{date, symbol, close, ema20, state, weight, vol20}`); a flip also appends to
     `data/spot-trend/flips.jsonl`. Idempotent: a day already written is skipped, so the
     10-minute cadence is harmless.
   - Paper ledger: equal-thirds portfolio, next-day application, 0.15% per switch (same rules as
     `spot-portfolio.js`), plus buy & hold from the same start date.
2. **Flip alerts:** reuse the `alerts.js` GitHub-issue path (a `SPOT` kind), one issue per flip:
   coin, IN→OUT or OUT→IN, close vs EMA20, suggested weight. No Telegram change in phase 1.
3. **Page:** `spot-page.js` (new) → `docs/spot.html`, linked from the main page nav, with
   element ids per repo rules (`id="spot-trend-state-row"`, `id="spot-trend-equity-panel"`,
   `id="spot-trend-flips-table"`): today's state per coin, % distance to EMA20, last flip,
   paper equity vs buy & hold, and a static backtest summary with the caveats.
4. **Parity check:** a test that runs the tracker's EMA/state code and the research
   `spot-trend.js` logic on the same candle file and asserts identical states and switches.

## Keep vs change

- Keep: engine, payload, MCP, Telegram, executor, Vercel functions and env — untouched.
- Change: tracker scripts, `repo-template/.github/workflows/track.yml` (one step + the alert
  kind), tracker page nav, tests.

## Files likely involved

`scripts/tracker/spot-trend.js` (new), `scripts/tracker/spot-page.js` (new),
`scripts/tracker/alerts.js`, `scripts/tracker/build-page.js` (nav link only),
`scripts/tracker/repo-template/.github/workflows/track.yml`, `test-tracker.js`,
`CHANGELOG.md`, `docs/DOCUMENTATION_INDEX.md`.

## Risks

- **Data source:** the backtest used Binance 1d; the tracker uses Kraken 1d (both UTC 00:00
  closes). Small close differences can move a flip by a day near the EMA. Record both the
  close and the EMA so any disagreement is visible.
- **Schedule:** GitHub schedules are unreliable (the keeper exists for this). A late run still
  records the right day because it reads closed candles; a flip alert can arrive late.
- **Public repo:** states and paper equity are public. No wallet or account data is used.
- **Expectations:** the filter lags buy & hold in strong rallies and has long flat stretches;
  a few weeks of paper results say nothing about the edge either way.

## Phase order

1. **P1 (this plan):** tracker signal + ledger + parity test. Stop for review.
2. **P2:** flip alerts + `spot.html` page. Stop for review.
3. **Run 3–4 weeks.** Exit criteria: no missed daily closes, states match the research code,
   alerts delivered.
4. **Later, separate plan and owner sign-off (after 2026-10-08):** execution through
   `services/jupiterSwap.js` with PIN confirm, vol-target sizing inside the G1 guardrails,
   Telegram `/spot` status. Never an MCP tool.

## Approval

Approve P1 to start. P1 touches only tracker code and tests; nothing deploys until the
tracker repo is synced.
