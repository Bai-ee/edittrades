# P1 — Pyth mark price beside the Kraken price (single implementer pass)

Last updated: 2026-09-23
Status: **unblocked 2026-09-23 17:10 CDT, owner decision 5 = (a)**. Owner supplied `PYTH_API_KEY` in local `.env` (verified: Hermes `/v2/updates/price/latest` returns 200 with `Authorization: Bearer $PYTH_API_KEY`; `X-API-Key` and `api-key` headers are rejected). The key is in the Vercel production env (added 2026-09-23); the engine reads it by name only and never logs it. Missing key → `mark.status: "unavailable"`, never an error. Feed ids: BTC `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`, ETH `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`, SOL `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`. Runs after the Phase 0 fix pass (same files). Schema target moves to 1.15.0 (1.13/1.14 taken by the model packages).
Branch: `upgrade-signal-engine`
Owner decision (2026-09-23): candles stay on Kraken (Bitfinex fallback). Jupiter perps mark, fill, stop and liquidate on the Pyth oracle, so the payload adds the live Pyth price as a reference next to the candle-close price. No candle-source change. Requires `PYTH_API_KEY` (Bearer) for Hermes; Benchmarks history is not used.

## Build

1. **`lib/pythMark.js` (new, read-only).** `fetchPythMarks(symbols)` → Hermes `GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<id>&...&parsed=true` with header `Authorization: Bearer ${process.env.PYTH_API_KEY}`, one request for all symbols, 4 s timeout, never throws; no key → `unavailable` without a request. Feed ids for BTC/ETH/SOL (`Crypto.BTC/USD`, `Crypto.ETH/USD`, `Crypto.SOL/USD`) resolved once at build time and stored as constants in `config/engine.json` under `mark.pyth.feedIds` (look them up via `https://hermes.pyth.network/v2/price_feeds?query=<sym>&asset_type=crypto`; BTC is `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`). Parse `parsed[].price` → `price * 10^expo`, `conf * 10^expo`, `publish_time`.
2. **Payload field** on every symbol, beside `price`: `mark = { price, conf, publishTime, source: "pyth", ageSec, driftBps, status }`. `driftBps = (mark.price − price) / price × 10000`, 1 decimal. `status`: `ok` | `stale` (ageSec > `mark.maxAgeSec`, default 30) | `unavailable` (fetch failed, fields null). Unavailable mark never changes `dataStatus`, never adds a warning above `info` level (same rule as wallet). `price` (closed 1m candle close) stays exactly as is.
3. **decisionTrace token.** Append `mark:<driftBps>` (or `mark:na`) to `decisionTrace.bias` so compact mode carries it. Keep under 12 chars.
4. **Config.** `config/engine.json` `mark: { pyth: { feedIds: {...}, maxAgeSec: 30, timeoutMs: 4000 } }`; bump `configVersion` `2026.09.23-1` → `-2`. Schema → `1.15.0` (from whatever is current at run time).
5. **Docs.** `openapi/scalp-context.yaml` (ChatGPT-safe constructs, follow existing `$ref` style), `docs/EDITTRADES_MCP_CONNECTOR.md` schema map + test counts, `CHANGELOG.md`, `docs/DOCUMENTATION_INDEX.md` (module + this plan).
6. **GPT instructions** (`docs/GPT_INSTRUCTIONS.md`, `npm run check:gpt` ≤ 7,990, budget-neutral): one rule in RISK: "Stops, Thesis Eliminated and liquidation are hit on mark (Jupiter/Pyth), not the candle close: check them against `mark.price`; `driftBps` beyond ±10 → say so." Also add `Mark:` line to the DATA section? No — do not touch FORMAT / TRACK FORMAT / NO TRADE LINE; fund the rule by trimming an equal amount elsewhere without removing a rule. If it cannot be funded, report and leave instructions untouched.
7. **Tests.** New `test-pyth-mark.js` + `npm run test:mark`: parse (expo handling, conf), stale/unavailable statuses, driftBps sign both directions (mark above and below price), fetch failure → `unavailable` with `dataStatus` untouched, one-request-for-all-symbols. Mock the HTTP layer; no live calls in tests. `test-scalp-context.js`: `mark` present on every symbol, filterPayload keeps it in default and compact (compact keeps only `price`, `driftBps`, `status`).

## Out of scope

Candle source, replay histories, strategies, MCP tool registration, REST auth, wallet, `public/index.html`, any Pyth Benchmarks (keyed) endpoint, any secret.

## Verification

- All 13 suites (12 existing + `test:mark`) green; report counts before/after. `git diff --check`. `npm run check:gpt`.
- Live: `buildScalpContext({})` → each symbol has `mark.status` and `driftBps`; report the three drift values and the payload bytes before/after (must stay ≤ 79,000 default).
- No commit, push, deploy, env change, or paid call.
