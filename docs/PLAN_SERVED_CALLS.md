# T3 — Served calls: every call the GPT sees gets tracked

Last updated: 2026-09-24
Status: built 2026-09-24, phases 1-3 done (see CHANGELOG and `docs/EDITTRADES_MCP_CONNECTOR.md` work log). One implementer pass, three phases.
Branch: `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker` (GitHub `Bai-ee/edittrades-tracker`, Vercel `edittrades-tracker`).

## Problem

The tracker (`docs/PLAN_CALL_TRACKER.md`) only records the engine's call when its own job runs (GitHub Actions, :07/:37 UTC). A call the Custom GPT receives between runs — e.g. a GOOD call at 10:15 that is gone by 10:37 — is never scored. Goal: every call served to the GPT through the REST Action lands in the tracker and is scored exactly like a cron-captured call, marked `source: served`.

Owner fallback, if anything below proves much harder than planned: record only calls whose `flagRecommendation.class === 'GOOD'`. Do not fall back without saying why in the phase report.

## Constraints (hard)

- **No new `api/` file.** Vercel Hobby is at 12/12 functions. The hook lives inside `api/scalp-context.js`.
- **MCP untouched.** `services/editTradesMcp.js` and `lib/mcpHttp.js` keep importing only `buildScalpContext`/`filterPayload` from `services/scalpContext.js`. MCP-served calls are out of scope. `npm run test:mcp` must stay green.
- **The response never changes.** Recording is a side effect: same status, headers, body, and it can never turn a 200 into an error. Failures are logged (no secrets, no URLs with tokens) and swallowed.
- **Latency budget.** The write is awaited with a hard timeout of 1500 ms (`Promise.race`), then the response is sent. Do not rely on work after `res.end()` (serverless may freeze it). No new dependency (`@vercel/functions` etc. not approved); `@vercel/blob` is already installed.
- **No account data stored.** Served rows use the tracker's existing row shape and strip (`stripSensitive` + `findSensitiveKeys` guard: throw → nothing written). Never store `account`, wallet, margin, performance, bearer, RPC URL.
- **Kill switch.** `TRACK_SERVED_CALLS=false` disables recording. Missing `BLOB_READ_WRITE_TOKEN` → silently disabled.
- Do not touch Vercel secrets. Do not enable trading. Do not change engine logic, thresholds, or payload schema (no `schemaVersion` bump; this adds no payload field).
- Scalp stop guard, `strategies.*` contract, REST auth 401/401/405/200: unchanged.

## Design

### Storage (mirror the journal, `api/journal.js`)

Same public Vercel Blob store as the journal:

```
served/YYYY-MM-DD.jsonl   one row per (symbol, closedThrough, class, planStatus) per UTC day; appended by
                          read-modify-write guarded by the blob ETag (ifMatch), retried on precondition failure
served/manifest.json      {schemaVersion:'served-manifest-1', baseUrl, days[], updatedAt} so the tracker fetches with plain HTTP
```

Dedupe on write: skip a row whose key `symbol|closedThrough|class|planStatus` is already in today's file (the GPT often calls several times per chat; identical rows add nothing). If all rows are duplicates, no write and no manifest update.

### Shared code (no duplication)

1. **`lib/blobJsonl.js`** (new): move the journal's blob helpers out of `api/journal.js` unchanged in behaviour — `readBlob`, `writeBlob`, `updateBlob`, `baseUrlOf`, `isPreconditionFailed`, plus a generic `appendJsonlDay({get, put}, {dayPath, manifestPath, manifestSchema, rows, keyOf, nowIso})`. `api/journal.js` imports them. `npm run test:journal` must stay green (it is the regression gate for this refactor).
2. **`scripts/tracker/records.js`** (new): move `isSensitiveKey`, `stripSensitive`, `findSensitiveKeys`, `slimCandidate`, `recordsFromPayload` out of `scripts/tracker/collect.js` unchanged; `collect.js` re-exports them (existing imports and tests keep working). `api/scalp-context.js` imports from `../scripts/tracker/records.js` (pure module: no fs, no network). `scripts/tracker/sync.js` already copies every `scripts/tracker/*.js`, so the tracker repo gets it.

### Engine hook (`lib/servedCalls.js`, new)

```js
export async function recordServedCalls(payload, { now = Date.now(), env = process.env, store = defaultStore, timeoutMs = 1500 } = {})
// -> {recorded:n, skipped:reason|null}; never throws
```

- Skip when `env.TRACK_SERVED_CALLS === 'false'`, no `BLOB_READ_WRITE_TOKEN`, or `payload.dataStatus === 'unavailable'`.
- Rows = `recordsFromPayload(payload, now)` with `source: 'served'` and `servedAt` (ISO) added; drop rows without `flagRecommendation`.
- Append via `appendJsonlDay` under the timeout. Log one line: `[Served] recorded=n dup=m ms=t` or `[Served] skipped=<reason>`.

In `api/scalp-context.js`: after a successful build and before sending the JSON 200, call `await recordServedCalls(payload)` on the **unfiltered** payload (so `compact`/`include`/`symbols` filters don't hide the plan). Only for the JSON response path; skip the `?chart` PNG path and all error paths. `handleScalpContext` gains an injectable `record` dep (default `recordServedCalls`) for tests.

### Tracker (`scripts/tracker/collect.js` + page)

- `pullServed(dataDir, base)`: fetch `served/manifest.json` from the same base as the journal (`resolveJournalBase`), then each day file for days ≥ the newest stored served day minus 1; convert lines to capture rows (already in row shape), keep `source:'served'`, stamp nothing else. Append into `data/calls/YYYY-MM-DD.jsonl` through the existing ingest/dedupe path. Existing cron rows get `source:'cron'` when read if absent (do not rewrite old files).
- Dedupe: a served row whose `(symbol, closedThrough)` already exists from cron is dropped (already tracked). Two served rows at the same `(symbol, closedThrough)` with different class keep both only if the class differs.
- Scorer (`score.js`): no rule change — calls are still created on class change per symbol. Add `source` to `callDims` so filters and aggregates can split it. Scoring of a served call is identical to a cron call.
- Aggregates: `activity.served24h` (served rows in the last 24 h) and `activity.servedGood24h`.
- Page: activity tile row "Seen in chat · 24 h" (id `activity-served-row`); call log gets a "Via" column (`cron` / `chat`); `source` added to the equity filter dims (`FILTER_DIMS`) if that list is data-driven, else skip.
- Workflow: no change needed if `collect.js` main runs `pullServed` next to `pullJournal` (it runs in the existing collect step). `--no-served` flag mirrors `--no-journal`.

## Phases

### Phase 1 — shared modules + engine hook (engine repo)

Files: `lib/blobJsonl.js`, `lib/servedCalls.js`, `scripts/tracker/records.js`, `api/journal.js` (import refactor only), `api/scalp-context.js`, `scripts/tracker/collect.js` (re-export only), `test-served.js` (new), `package.json` (`"test:served": "node test-served.js"`).

Tests (`test-served.js`, injected fake store — no network):
- rows stripped: a payload with `account`, wallet and a bearer-looking key → none stored; guard throws → nothing written, handler still 200.
- dedupe: same payload twice → second call writes nothing.
- manifest gains the day once.
- timeout: a store that never resolves → returns within ~1500 ms, handler still 200 with identical body.
- kill switch and missing token → `skipped`.
- handler: JSON 200 path calls `record` once with the unfiltered payload even when `?compact=1&symbols=BTC`; chart path, 401, 405, build error → `record` not called; response body byte-identical with and without the hook.
- `test:mcp` still asserts MCP imports only `services/scalpContext.js`.

Gate: `npm run test:served`, `test:journal`, and all eleven suites in `CLAUDE.md` pass; `git diff --check` clean.

### Phase 2 — tracker ingest, scoring dims, page (engine repo `scripts/tracker/*` + `test-tracker.js`)

Tests: `pullServed` with a stubbed fetch (manifest + day file) → rows land in `data/calls/`, `source:'served'`; cron duplicate dropped; `callDims.source` present; a served GOOD call on a ready plan is scored `ready_prefilled` exactly like cron; activity counts; page shows `activity-served-row` and the Via column; still exactly one inline script, one PROVISIONAL tag per `<section>`.

Gate: `npm run test:tracker` + the four deploy-gate suites pass.

### Phase 3 — docs, deploy, verify

Docs: `CHANGELOG.md`, `docs/EDITTRADES_MCP_CONNECTOR.md` (REST side effect, kill switch, test counts), `docs/PLAN_CALL_TRACKER.md` (served source), `docs/DOCUMENTATION_INDEX.md` (this plan + new modules), `openapi/scalp-context.yaml` description line only (note the side effect; no schema change).

Deploy (owner has approved deploy for this plan):
1. Run all eleven suites + `test:journal` + `test:served` + `test:tracker`.
2. Commit on `upgrade-signal-engine`, push.
3. `npx vercel --prod --yes`, then verify per `docs/EDITTRADES_MCP_CONNECTOR.md` → "Verify after any redeploy".
4. One authenticated `GET /api/scalp-context` (key from the local env the owner already uses; never print it) → then fetch `served/manifest.json` from the blob base and confirm today's day file has 3 rows (BTC/ETH/SOL).
5. `npm run tracker:sync`; in `../edittrades-tracker`: `git pull --rebase`, commit, push; `gh workflow run track -R Bai-ee/edittrades-tracker`; confirm the next commit's `data/calls/*.jsonl` contains `"source":"served"` rows.
6. Do not poll `https://edittrades-tracker.vercel.app` in a loop (Vercel bot protection returns 403 to scripted traffic). Verify from git (`git show origin/main:docs/index.html`) and at most one browser load.

## Out of scope

MCP-served calls; recording the GPT's own text; any change to how calls are scored; any threshold or engine change; alerts.

## Risks

- Blob writes per GPT request: small (≤3 rows, dedupe keeps day files small). Rate of GPT calls is human-paced.
- Public blob: rows hold market data and engine levels only (same as the public tracker page); account data is stripped with a hard guard.
- Latency: +≤1.5 s worst case on the Action call, typically ~100–300 ms.
- ETag races with concurrent GPT calls: handled by the retry loop copied from the journal.
