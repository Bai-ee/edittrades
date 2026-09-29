# T-23 prompt — homepage says what the engine sees right now

Owner decision 2026-09-28 (evening): the homepage must explain the product with data the engine already produces, not wait for rare GOOD calls. Presentation only. One phase, target ~1 hour. No engine, payload, schema, rule, Telegram or execution change. The prediction engine (E3), live Blob numbers (E4), price provenance (E1) and chat (E2) are NOT this task.

Repo: `/Users/bballi/Documents/Repos/snapshot_tradingview`, branch `upgrade-signal-engine`. Tracker page source lives here in `scripts/tracker/` and is synced to `~/Documents/Repos/edittrades-tracker` (publish flow below). Read `docs/AGENT_SESSION_RULES.md` first. Files you may edit: `scripts/tracker/home-hero.js`, `scripts/tracker/build-page.js` (only the hero call if a new argument is needed), `test-tracker.js`, `CHANGELOG.md`. Nothing else.

## Data you already have (no new source)

`data/calls/<day>.jsonl` in the tracker repo, one row per symbol per 10-min capture (`data.liveRows` in build-page.js already holds the latest rows). Each row carries per symbol: `price` (Kraken close), `mark {price, driftBps, status}` (Pyth), `bias` string like `scalp:L48,S8,N44|swing:L80,S0,N20|tf:1m=S,3m=N,5m=N,15m=L,1h=L,4h=L,1d=L|ct:2|td:bull:4/4|a200:4/7|mark:-4.4`, `flagRecommendation {class, action.call, primaryReason.text, candidate{timeframe,direction,state,breakout,invalidation,measuredRR}, readiness, asOf}`, `candidateSetups[]`, `closedThrough`, `dataStatus`. Parse `bias` with a small pure helper (`parseBiasString`), unit-tested.

## Build

1. **Headline + subhead from data** (replaces the rotating EditTrax lines in `HOME_HERO_TITLES` as the h1; keep the array exported and the rotation script harmless or remove it cleanly, no dead code). `id="home-hero-title"` stays. The headline is one sentence built from the latest rows, e.g. `BTC, ETH and SOL: 1h and 4h trend up, no flag ready.` or `2 of 3 coins trending up on 4h · ETH 1m short flag forming.` Rules: name what is aligned (count of coins with 1h and 4h same side), name any candidate in `triggering`/`confirmed` state, else say no flag ready. Never claim a call that `flagRecommendation.class` does not show. Subhead (`id="home-hero-lede"`, replaces `HOME_HERO_LEDE`): `Closed-candle read of BTC, ETH and SOL every 10 minutes, scored net of fees. Data as of HH:MMZ.` Keep the two action links.
2. **"Right now" cards**, new block `id="home-hero-right-now"` directly under the headline panel, one card per symbol `id="home-hero-now-<btc|eth|sol>"`, same bento styles as the existing hero blocks (HOME_HERO_CSS). Each card, top to bottom:
   - symbol, `mark.price` labelled `Pyth mark`, and `price` labelled `Kraken close`, drift in bps.
   - a 7-cell trend strip from `bias.tf` (1m 3m 5m 15m 1h 4h 1d), each cell L/S/N as ▲ ▼ · with the timeframe under it. `id="home-hero-now-<sym>-trend"`.
   - one line: `EMA200 above on a200 x/7 · top-down td` from the bias tokens.
   - engine stance: `flagRecommendation.class` + `action.call` (e.g. `WATCH · WAIT`) and `primaryReason.text` verbatim, one line, ellipsis at ~140 chars. `id="home-hero-now-<sym>-stance"`.
   - if `candidate` exists: `1m short flag forming · break 2,677.48 · void 2,681.03 · 4.6R`.
   - if `dataStatus !== 'complete'` or `mark.status !== 'ok'`: a small grey `data: <status>` tag, never hide the card.
3. **The net-R result card stays** (right column) but moves below the right-now block on phones. Do not change its numbers.
4. Phone width first: cards stack, trend strip stays on one line (7 cells, monospace), no horizontal page scroll.
5. Tests in `test-tracker.js`: `parseBiasString` (full string, missing tokens, garbage → nulls); headline for aligned-up / mixed / candidate-triggering / no-rows cases; card ids present for all three symbols; card renders with `dataStatus:'partial'`; no claim of GOOD when class is WATCH. Existing test count 168 must not drop.

## Verify and publish

- `npm run test:tracker`, `git diff --check`.
- Build locally: `npm run tracker:sync -- --target ~/Documents/Repos/edittrades-tracker`, then in the tracker repo `git checkout -- data/aggregates.json docs/*.html docs/report.md`, `git pull --ff-only`, `npm run page`, open `docs/index.html` and check the three cards and headline against the latest `data/calls/<today>.jsonl` rows by hand (numbers match, no NaN, no `undefined`).
- Commit in the engine repo by file name: `site(T-23): homepage headline, subhead and Right-now cards from the latest engine rows`. Commit in the tracker repo: `git add scripts docs/*.html docs/report.md data/aggregates.json`, same message, push both. The site shows the change within ~10 minutes (the cron rebuild carries it if your Pages deploy is cancelled).
- Report: headline text as rendered, one card's rendered text, test count before/after, both commit hashes, the live URL https://bai-ee.github.io/edittrades-tracker/ once it shows the cards.

## Do not

- Do not touch `product.html`, `how-to`, scoreboard, archive, status tile, `epochs.js`, `aggregate.js`, `collect.js`, `score.js`.
- Do not fetch anything live from the engine or Blob; rows only.
- Do not `git add -A`. Do not deploy Vercel. Do not edit files outside the list.
