# Elevations — 2026-09-28 (owner list, plan only)

Items the owner wants the product to carry itself, so the GPT and the site state facts instead of interpreting them. None approved for build yet; each becomes its own T-number prompt when approved. Engine rules, stops, execution and MCP tool registration stay untouched by every item here.

## E1 — Price provenance in the payload (T-23 candidate, ~1 h)

Why: asked "what's BTC price", the GPT quoted the Kraken close first and the Pyth mark second, and the mark trailed the live chart by ~14 USD because the engine reads Pyth once per closed-candle build. The payload should say all of that.

Schema 1.30.0 additive; compact mode included (the GPT only calls compact).

1. `mark.asOf` in compact: Pyth publish time (ISO). Full mode already has `publishTime`.
2. `mark.ageSec` in compact: seconds from publish to build. Already computed.
3. `mark.source: "pyth"` and top-level `priceSource: "kraken_close"` in compact.
4. `servedAt` stamped by the REST/MCP handler at request time plus `markAgeAtServeSec`.
5. `priceNote` per symbol, engine-authored, printed verbatim by the GPT: `mark 83,660.60 (Pyth, 19:22:05Z, 23 s before close) · candle 83,678.40 (Kraken 1m close 19:22Z) · drift −2.1 bps`.
6. `mark.statusReason` text when stale/unavailable (`age 41 s > 30 s`, `Hermes read failed`).
7. Instructions box: T-22 price wording → `print priceNote verbatim first`.

Touches: `services/scalpContext.js`, `lib/pythMark.js`, `filterPayload`, `openapi/scalp-context.yaml`, byte caps + schemaVersion asserts in `test-scalp-context.js` (known trap), `docs/EDITTRADES_MCP_CONNECTOR.md`, `CHANGELOG.md`, `docs/GPT_INSTRUCTIONS.md`. Item 4 touches the MCP rewrite path: `test:mcp` one-tool guard must stay green. Cost ~250 B per symbol compact.

## E2 — Chat on the tracker site (T-24 candidate, medium, ~2–3 h agent time)

Why: the owner wants to ask questions of the tracker's data on the site itself.

Shape:
- `docs/chat.html` on the tracker (GitHub Pages, static, no secrets) + nav link; `scripts/tracker/chat-page.js`. Input, message list, PIN prompt (localStorage), fetch to the function.
- `api/tracker-chat.js` + `lib/trackerChat.js` in the engine repo (Vercel): takes the question, pulls the tracker's live JSON from GitHub raw (`data/aggregates.json`, today's `data/calls/<day>.jsonl`, `htf-call-outcomes.jsonl`, `retest-call-outcomes.jsonl`, scoreboard epochs), trims to a context budget, one Claude API call (model per the claude-api skill at build time), returns the answer. Read-only. Imports nothing from execution, wallet, or MCP modules.
- Gate: owner-only `TRACKER_CHAT_PIN` (env). Daily request cap in Blob, same pattern as the served-calls ledger. Without both, any visitor burns tokens.
- v1 scope of answers: scoreboard per strategy, a call by id, streaks, drawdown, "why was this GOOD", config boundaries, archive. v1 context = today + scoreboard, not full history.

Not in scope: orders, prefs, the GPT, the engine payload.

Owner supplies: `ANTHROPIC_API_KEY`, `TRACKER_CHAT_PIN` in Vercel env; one prod deploy via `!`; tracker publish flow.

Risks: token spend if the PIN leaks (cap bounds it); answer quality limited by what fits in context; Vercel function count (Pro, fine).

## E3 — Prediction tracker — SHIPPED 2026-09-28 (T-24)

Next-candle over/under on 5m/15m/1h/4h for BTC/ETH/SOL at every close, scored at the next close vs coin flip and same-as-last, per cell / timeframe / coin / overall / during-GOOD. Homepage `zone-predictions` grid + `predictions.html`. Info-only. 2-year replay 48.2% (no edge; the tracker is the point). See `docs/PROMPT_T24_PREDICTION_TRACKER.md`, `docs/PREDICTION_STUDY_2026-09-28.md`.

## E4 — Live numbers without a page rebuild (not started)

Engine cron writes `live/summary.json` to public Blob every minute; the page polls it every 30–60 s and swaps numbers in place. Fixes the STALLED tile for good. Medium, one phase.

## Order

E1 first (small, unblocks the GPT wording), then E2.
