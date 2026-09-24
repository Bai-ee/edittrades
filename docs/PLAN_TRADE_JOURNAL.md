# T2 — Trade journal: trades you tell the GPT, tracked beside the engine's calls

Last updated: 2026-09-24
Status: plan only. Not started. Owner approval needed before code.
Goal: you tell the GPT what you did ("took BTC long 84,600 stop 84,390", "closed BTC +1.2R", "skipped"), it records one line through a new write endpoint, the tracker pulls those lines and shows your trades beside the engine's calls: on the wallet chart, on the equity curve as a second line, and through every existing filter. This is the deferred 8c.

## Hard boundaries

- MCP stays read-only. The journal endpoint is REST only, never an MCP tool. `services/editTradesMcp.js` and `lib/mcpHttp.js` untouched.
- The endpoint records text you said. It never executes, never reads or signs with a key, never touches `services/walletTracker.js` or `api/execute-trade.js`.
- Separate bearer `JOURNAL_API_KEY` (new secret). Rejects without it. Rate-limited (10/min) and body-capped (4 KB).
- Vercel Hobby cap is 12 functions and the project is at 12. `api/crypto-news.js` retires (unused: referenced only by local `server.js`; last touched 2025-11-28). Its `vercel.json` route goes too.

## Shape

```
GPT (Action: postJournal)  →  POST /api/journal  (Bearer JOURNAL_API_KEY)
                                   │  validates, stamps server time + requestId
                                   ▼
                              Vercel Blob  journal/YYYY-MM-DD.jsonl  (append = read-modify-write, ETag guarded)
                                   │
tracker track.yml (every 30 min) ──┘  GET the day files → data/journal/*.jsonl → score → page
```

Why Vercel Blob: no new vendor account, no GitHub PAT, one store in the existing project; the token is injected automatically once the store is linked. Owner step: create the Blob store in the Vercel dashboard (Storage → Create → Blob) and link it to `snapshot_tradingview`; or say "go" and I try `vercel blob` from the CLI first. Blob URLs are unguessable but public; the owner accepted a public wallet/journal.

## Journal record (what the GPT sends)

```json
{ "kind": "open|close|adjust|skip|note",
  "symbol": "BTC", "direction": "long|short|null",
  "entry": 84600, "stop": 84390, "tp1": 85100, "sizeUsd": 1011.67, "leverage": 10.2,
  "exitPrice": null, "resultR": null, "resultUsd": null,
  "engineRef": { "candidateId": "...", "planId": "...", "recClass": "GOOD|WATCH|BAD", "reasonCode": "..." },
  "saidAt": "2026-09-24T14:05:00Z", "text": "took BTC long 84600 stop 84390" }
```
Server adds `id`, `receivedAt`, `schemaVersion`. `engineRef` is filled by the GPT from the payload it just read, so every trade is linked to the call it came from. Numbers optional; `text` required. Idempotent on `id` when the GPT resends.

## Build (one implementer pass, Opus)

1. `api/journal.js`: POST only; bearer check; JSON schema validation (`lib/journalSchema.js`, pure, tested); append to Blob with `@vercel/blob` (already an allowed dep? no → add `@vercel/blob`, one package, owner approval implied by this plan); GET with the same bearer returns the last N lines for the GPT's `journal` command. Remove `api/crypto-news.js` + its route.
2. `openapi/scalp-context.yaml`: add `postJournal` (POST /api/journal) and `getJournal` (GET) with ChatGPT-safe schemas; a second security scheme for the journal key. The GPT Action needs a re-import (owner does it; the old import trap: paste the schema, do not replace the Action).
3. `docs/GPT_INSTRUCTIONS.md` (≤ 7,990, now 7,976; fund by moving one procedure line into the playbook if needed): COMMANDS `log <text>` → parse into a journal record, attach `engineRef` from the latest payload, POST, confirm with one line `[LOGGED id]`; `journal` → GET last 10, list them; never invent a trade; `closed`/`skipped` phrasing maps to `kind`.
4. Tracker: `collect.js` pulls the journal day files (Blob public URLs listed via the store's `list` with the read token as a tracker secret `BLOB_READ_WRITE_TOKEN`, or a fixed manifest file the API maintains) into `data/journal/`; `score.js` scores each `open` record against later candles exactly like a ready plan (fill at entry, stop, tp1, 24 h) and, when a matching `close` exists, uses the reported `resultR`/`exitPrice` instead; `dims` copied from the linked engine call.
5. Page: wallet chart gets entry/exit markers (open = tick up, close = tick down, colored by resultR sign); equity chart gets a second line "your trades" beside "engine calls", same filters; a "Engine vs you" block: GOODs taken / skipped, WATCH/BAD taken (overrides) with their outcomes; the journal log table.
6. Tests: `test-journal.js` (schema, auth, rate limit, idempotency, GET) + tracker tests for pull/score/markers. `test:mcp` proves MCP still has one tool and no journal import.

## Owner does

1. Create/link the Blob store (or let me try via CLI).
2. Set `JOURNAL_API_KEY` in Vercel: I can generate and set it (`openssl rand`), and put it on your clipboard for the GPT Action auth once.
3. Re-import the Action schema in the GPT and paste the updated instructions.
4. Use it: "log took BTC long 84600 stop 84390 tp 85100 size 1000", "log closed BTC +1.2R", "log skipped SOL".

## Verification

All suites + `test:journal` + `test:tracker`; `check:gpt`; prod: POST without key 401, bad body 400, good 201, GET 200, MCP tools/list still one tool; a fresh-chat `log …` then `journal` round trip; tracker run shows the record on the page.

## Out of scope

Reading your real positions (3b), execution, editing past records (append-only; corrections are new `adjust` lines).
