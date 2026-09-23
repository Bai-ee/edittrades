# ChatGPT Action Setup: Scalp Context

## 1. What this is

`openapi/scalp-context.yaml` defines a single read-only action, `getScalpContext`, that a ChatGPT Custom GPT can call to pull the latest closed-candle BTC, SOL and ETH market context from this deployment before answering trading questions.

## 2. Prerequisites

- A deployed production URL for this project (e.g. `https://snapshottradingview.vercel.app`).
- A generated API key for `SCALP_CONTEXT_API_KEY`. Generate one with:

```
openssl rand -hex 32
```

## 2b. Status of this deployment (updated 2026-09-22)

- Production is live: `https://snapshottradingview.vercel.app/api/scalp-context`
  (401 without auth, 401 on a bad key, 405 on POST, 200 authed).
- Payload `schemaVersion` 1.10.0, `configVersion` 2026.09.22-9. Full response ~79 KB,
  ~31 KB with `compact=1`. Build ~0.7–1.7 s.
- The schema grew from 1.1.0 to 1.10.0 on 2026-09-22 (decisionTrace, risk, candidateSetups,
  geometryContext, config snapshot, query options). If the GPT Action was imported before
  that, re-paste `openapi/scalp-context.yaml` into the Action (step 5) so ChatGPT sees the
  new fields and parameters. Field reference: `docs/EDITTRADES_MCP_CONNECTOR.md`.
- `SCALP_CONTEXT_API_KEY` is already set in Vercel for Production, Preview and
  Development. The value is stored locally in the git-ignored `.env.local`.
- To copy the key to your clipboard without displaying it:

```
grep '^SCALP_CONTEXT_API_KEY=' .env.local | cut -d= -f2 | tr -d '\n' | pbcopy
```

- The `servers` entry in `openapi/scalp-context.yaml` already points at production.
  Nothing in the schema needs editing before import.

## 3. Set the key in Vercel

CLI:

```
vercel env add SCALP_CONTEXT_API_KEY production
vercel env add SCALP_CONTEXT_API_KEY preview
```

Paste the key value when prompted for each command.

Dashboard alternative: Project → Settings → Environment Variables → Add → name `SCALP_CONTEXT_API_KEY`, value = your key, environments = Production and Preview.

**Warning:** do not paste or print the key value directly in a shell command (e.g. `vercel env add SCALP_CONTEXT_API_KEY production <<< "abc123..."` or `echo "abc123..." | vercel env add ...`) — that puts the secret in your shell history. Use the interactive prompt or the dashboard.

## 4. Verify the endpoint

No auth (expect 401):

```
curl -s -o /dev/null -w "%{http_code}\n" https://snapshottradingview.vercel.app/api/scalp-context
```

With auth (expect 200):

```
curl -s -H "Authorization: Bearer $KEY" https://snapshottradingview.vercel.app/api/scalp-context | head -c 400
```

## 5. Create the Custom GPT Action

One-time setup in the ChatGPT UI:

1. Create or edit a Custom GPT.
2. Go to **Configure**.
3. Click **Create new action**.
4. Paste the full contents of `openapi/scalp-context.yaml` into the schema editor.
5. Set **Authentication** = API Key, **Auth Type** = Bearer, and paste the same key value.
6. Click **Save**.

## 5b. Optional query parameters

All optional; with none the full payload is returned.

| Param | Example | Effect |
|---|---|---|
| `symbols` | `symbols=BTC,SOL` | Only these symbols |
| `include` | `include=strategies,geometry,account` | Only these sections: `timeframes`, `strategies`, `candidates`, `geometry`, `account`, `trace`, `config`. `price`, `source`, `structure`, `bestSignal` always stay. |
| `compact` | `compact=1` | Drop candle arrays, keep indicator summaries |

Unknown values are ignored and noted in `warnings`; they do not change `dataStatus`.

## 6. GPT instructions

Paste this into the GPT's instructions:

```
When the user asks about current BTC, SOL, ETH, market conditions, or trade setups,
call getScalpContext before answering. Analyze only the returned data. Clearly state
the generatedAt and closedThrough times. Treat warnings and missing data as reasons
to reduce confidence. Never claim that a trade was executed. Present analysis as
decision support, not guaranteed financial advice.
```

## 7. Test in Preview

Ask:

```
Load my latest market context and compare BTC, SOL, and ETH.
```

A healthy response calls `getScalpContext`, then states the `generatedAt` and `closedThrough` timestamps, summarizes each symbol's structure/trend and best signal (if any), and flags any `warnings` or `dataStatus: partial`/`unavailable` as reduced-confidence conditions — without claiming any trade was placed.

## 7b. Wallet tracking (since schemaVersion 1.1.0)

The payload carries an `account` block for the dedicated trading wallet
`F48Q...KeCi`. Read-only: `services/walletTracker.js` reads a **public** address over
Solana JSON-RPC and holds no signing key.

### The one rule that matters

`account.margin.usd` is risk capital **and** the P&L meter. `account.holdings` is not
capital.

Perps on this stack are stablecoin-collateralized (`services/jupiterPerps.js`), so only
USDC/USDT can back a position. More importantly, margin moves *only when a trade settles*
— so "margin before vs margin after" is a clean trade result. Folding SOL/BTC/ETH into
the total would make every market move look like a trade outcome and destroy the
win-rate measurement that sizing depends on.

Holdings are reported for one purpose: to notice you are already long SOL spot before
recommending a third correlated long on top.

### Blocks

| field | meaning |
|---|---|
| `margin.usd` | stablecoin total. **Size against this.** |
| `margin.byAsset` | `{ USDC, USDT }` |
| `holdings` | priced SOL/BTC/ETH positions. Exposure, not capital. |
| `holdingsUsd` | their total. Never add to margin. |
| `unpriced` | positions excluded from every total (memecoins, unknown mints). Disclosed, never valued. |
| `gas.sufficient` | false = cannot pay fees, whatever the margin says |
| `performance` | `baselineUsd`, `netPnlUsd`, `returnPct` — margin vs starting value |

Statuses: `available` (read and priced) · `partial` (a tracked asset lacked a price, so
`holdingsUsd` is incomplete — margin is still exact) · `unavailable` (no figures at all;
never read as zero) · `disabled` (no wallet tracked).

### Config

```
vercel env add TRACKED_WALLET_ADDRESS production
vercel env add ACCOUNT_BASELINE_USD production
```
Repeat for `preview`. Both are already in the local git-ignored `.env`.

`ACCOUNT_BASELINE_USD` is the wallet's margin when tracking began (currently `817.14`).
Change it **only** on a real deposit or withdrawal — otherwise a transfer reads as a
huge win and rewrites your performance history.

### Notes

- Unrecognized mints do not degrade `status`. A real wallet holds dust; it is disclosed
  in `unpriced` and excluded by design, which is not a data problem.
- A wallet read failure does **not** set `dataStatus: partial`. `dataStatus` describes
  market data only, so an RPC hiccup cannot discredit good candles.
- Only a masked address is emitted, and the RPC url never enters the payload, since a
  paid endpoint embeds its API key there.
- Balances become visible to OpenAI. Fine for a private GPT; reconsider before publishing.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 | Missing/wrong bearer token, or key mismatch between Vercel env and GPT action auth | Confirm `SCALP_CONTEXT_API_KEY` in Vercel matches the key pasted into the GPT action's Bearer auth field |
| 404 | Wrong `servers` URL in the schema, or route not deployed | Update `servers.url` in `openapi/scalp-context.yaml` to the real production domain and redeploy |
| 503 | Upstream market data source unavailable | Retry shortly; check server logs for the upstream provider error |
| Timeout | Cold start or slow upstream fetch on the backing function | Retry; consider increasing the function's timeout/region or warming it |
| "Action not called" | GPT instructions not saved, or action not enabled in this conversation | Re-check step 6 was saved, confirm the action shows as enabled in Configure, and rephrase the prompt to match the trigger conditions |
