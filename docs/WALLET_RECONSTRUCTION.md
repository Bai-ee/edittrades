# Wallet Reading & Jupiter Trade Reconstruction

Read-only observation of **one** Solana wallet: balances, holdings, USD value,
and a trade history reconstructed from on-chain Jupiter activity.

**Status:** implemented and fixture-verified. **Not validated against live
mainnet** — see [Verification status](#verification-status) before trusting any
number in production.

---

## 1. Read-only guarantee

V1 accepts a wallet **address** and nothing else.

- No seed phrase, no private key, no keypair, no signing, no transaction
  submission anywhere in `services/solanaWalletReader.js`,
  `services/jupiterReconstruction.js`, `api/wallet-portfolio.js` or
  `api/wallet-trades.js`.
- These modules never import `getWallet()` from `services/walletManager.js`.
  They import only `getConnection()`, which reads `SOLANA_RPC_URL` and never
  touches `SOLANA_PRIVATE_KEY`.
- The hot-wallet trading path (`walletManager.getWallet` → `jupiterSwap` →
  `api/execute-trade.js`) is entirely separate and is not reachable from any
  endpoint documented here.

Adding a signing capability to these files is a product change, not a
refactor.

---

## 2. What was reused

This did not build a parallel Solana stack.

| Reused | From | Why |
|---|---|---|
| `getConnection()` | `services/walletManager.js` | One RPC endpoint convention (`SOLANA_RPC_URL`, else `clusterApiUrl('mainnet-beta')`) and one cached `Connection` for the whole repo |
| `getSupportedSymbols()`, `getTokenAddress()` | `services/tokenMapping.js` | Mint → symbol display labels |
| Jupiter public API base + no-key convention | `services/jupiterSwap.js` | That module already discovered `quote-api.jup.ag` is dead and moved to `lite-api.jup.ag`; the price client follows the same host family |
| Handler shape, CORS, `readQuery()` URL fallback, `s-maxage` caching | `api/bitcoin-economic-value.js`, `api/health.js` | Matches the existing dual Vercel + Express convention |
| Harness style (named assertions, final count, non-zero exit) | `scripts/validate-risk-manager.js` | Consistency |

New code: the read-only reader, the reconstruction engine, two handlers, and
the fixture harness.

---

## 3. Endpoints

Both are registered in **both** places, as this repo requires: `vercel.json`
routes and `server.js` Express handlers.

### `GET /api/wallet/portfolio`

| Param | Required | Default | Notes |
|---|---|---|---|
| `address` | yes | — | base58, must decode to 32 bytes |
| `refresh` | no | `false` | `true` bypasses the 30s in-memory cache |
| `includeZero` | no | `false` | `true` keeps zero-balance token accounts |

```jsonc
{
  "address": "…",
  "solBalance": 12.5,
  "tokens": [
    { "mint": "So111…112", "symbol": "SOL", "amount": 12.5, "decimals": 9,
      "usdValue": 1875.0, "priceSource": "JUPITER_PRICE_V3" }
  ],
  "totalUsdValue": 1875.0,
  "at": "2026-08-23T00:00:00.000Z",
  "complete": true,
  "warnings": []
}
```

| Status | Meaning |
|---|---|
| `200` | Balances were read. `complete` may still be `false` if some tokens are unpriced — the balances are real, the USD total is qualified. |
| `400` | Address missing or malformed. |
| `503` | RPC unreachable. **No balances were read.** This is what the UI renders as "WALLET DATA UNAVAILABLE". |

### `GET /api/wallet/trades`

| Param | Required | Default | Notes |
|---|---|---|---|
| `address` | yes | — | base58, 32 bytes |
| `maxTransactions` | no | `100` | 1–1000. Bounded so the first page returns before a public RPC rate-limits the walk |
| `before` | no | — | Signature cursor from a previous `window.nextBefore` |
| `perpsMode` | no | `FLAG` | `FLAG` emits `NEEDS_REVIEW` perp stubs; `OMIT` drops them and warns |
| `prices` | no | `true` | `false` disables the external price feed entirely |

Returns `{ trades, positions, cashFlows, stats, window, complete, warnings, methodology }`.
`window` reports exactly how much history was scanned and whether more exists.

---

## 4. Trade record shape

```js
{
  id, source: 'ONCHAIN'|'MANUAL'|'PLANNED',
  asset, assetMint, direction: 'LONG'|'SHORT'|null, kind: 'SPOT'|'PERP',
  openedAt, closedAt|null, status: 'OPEN'|'CLOSED',
  entry|null, exit|null, quantity|null, notional|null,
  leverage|null, collateral|null,
  realizedPnl|null, unrealizedPnl|null, fees|null,
  dataConfidence, confidenceReasons: [],
  signatures: [], legs: [ { at, kind:'OPEN'|'ADD'|'REDUCE'|'CLOSE', qty, price, signature } ],
  overrides: {},
  meta: { lotPolicy, pnlBasis, feeLamports, feeSol, totalBoughtQty, totalSoldQty, openQty }
}
```

`meta` is additive; the fields above it are the stable contract.

### `id` — deterministic and idempotent

`onchain-<kind>-<fnv1a hash of kind|assetMint|openingSignature>`.

Re-running reconstruction over the same history yields byte-identical trades,
so user corrections re-attach to the same record. The harness asserts this.

**Limitation, stated plainly:** the opening signature is the earliest one *in
the fetched window*. Widening the window backwards can pull in an earlier buy,
moving the episode start and therefore the id. Ids are stable for a fixed
window, not across a re-scan that reaches further back. If you persist
corrections, pin the window (`before`/`maxTransactions`) or re-key corrections
on `signatures[]` overlap.

---

## 5. Confidence levels

Every trade carries `dataConfidence` and `confidenceReasons: []`.

| Level | Meaning | When |
|---|---|---|
| `VERIFIED` | Every field derived directly from decoded on-chain data | Spot swap settled against a stablecoin. Quantity, entry, exit and P&L are arithmetic over `meta.pre/postTokenBalances`, which the validator itself produced |
| `PARTIAL` | Some fields inferred | Quote asset is SOL or another non-stable (USD conversion needs an external price feed); or extra balance legs forced a "largest delta is the real leg" choice |
| `NEEDS_REVIEW` | Material ambiguity | Perps; undecodable Jupiter transactions; token-to-token swaps with no quote asset; sells with no matching buy in the window |

**A missing number stays missing.** There is no estimation path. If entry
price cannot be derived, `entry` is `null` and a reason says why. `NEEDS_REVIEW`
trades never contribute to `stats.realizedPnl`.

---

## 6. Lot matching — FIFO

`LOT_MATCHING_POLICY = 'FIFO'` (exported constant; also on every trade as
`meta.lotPolicy`).

A sell consumes the **oldest** open lot first. This is labelled on every record
because the policy changes the reported number: the harness includes a case
where FIFO yields **+35** and LIFO would yield **+25** from identical on-chain
data. A realized P&L figure is only meaningful alongside its policy. LIFO and
HIFO are not implemented.

**Episodes.** One trade = one episode. It opens when a mint's position goes
from flat to non-zero and closes when it returns to flat. Buys inside an open
episode are `ADD` legs, sells are `REDUCE`, and the sell that flattens the
position is `CLOSE`. Re-entering the same asset after a flat close starts a new
trade record with a new id.

**`pnlBasis: 'GROSS_EXCLUDING_FEES'`.** Realized P&L is
`(exit price − lot entry price) × matched quantity`. Fees are reported
separately as `meta.feeLamports` / `meta.feeSol` (on-chain facts). The USD
`fees` field stays `null` because converting lamports to USD needs a historical
SOL price this system does not have.

---

## 7. Perpetuals — the honest answer

**Jupiter Perpetuals positions are NOT reconstructed.** Not "not yet" — not
from the data this system can reach. Three independent blockers:

1. **The instruction data is opaque.** The perps program
   (`PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`) is an Anchor program.
   `getParsedTransaction` only decodes *native* programs (System, SPL Token,
   Stake, Vote). For anything else the RPC returns raw base58. Side, size,
   leverage, entry price and collateral all live inside that blob, and decoding
   it requires the program IDL, which this repo does not carry.

2. **A trader signature is not a fill.** Jupiter Perps is request/fulfil: the
   trader submits an increase or decrease *request*, and a **keeper** executes
   it in a *separate transaction the trader never signs*. That transaction
   therefore never appears in `getSignaturesForAddress(trader)`. Reconstructing
   from the trader's signatures alone systematically misses the executions —
   this would produce wrong numbers, not merely incomplete ones.

3. **Position state is off-wallet.** Size, entry, collateral and accrued
   funding live in a program-owned Position account, not in the trader's token
   balances. Reading it needs `getAccountInfo` plus the account layout from the
   IDL — and reading it *now* says nothing about entry six weeks ago.

**What the engine does instead.** It detects that a transaction touched the
perps program (that much *is* an on-chain fact), records the collateral token
movement (also a fact), and emits a `NEEDS_REVIEW` stub with `direction`,
`entry`, `quantity`, `leverage` and `realizedPnl` all `null`. `meta.statusKnown`
is `false` because the schema's `status: 'OPEN'` is a required field, not an
observation. These stubs are excluded from `stats.realizedPnl`. Use
`perpsMode=OMIT` to drop them entirely.

**What full perps support would require** — none of it in V1's read-only scope:

- the Jupiter Perpetuals IDL, **plus** an indexer following keeper fulfilment
  transactions and correlating them back to the trader's requests; **or**
- a third-party position-history API (Jupiter's own, or a Solana indexer such
  as Helius/Birdeye with perps coverage), which means a key and a paid tier.

---

## 8. Deposits and withdrawals

Plain transfers in and out are surfaced as **candidates only**:

```js
{ id, type: 'DEPOSIT'|'WITHDRAWAL', classified: false, at, signature, movements: [...] }
```

`classified` is **always** `false` from the engine. Nothing is auto-classified,
because the engine cannot distinguish a genuine external deposit from a
transfer between two wallets the same person owns — and getting that wrong
silently corrupts every performance figure downstream.

**Only flows a human has confirmed (`classified: true`) are excluded from
performance.** Unconfirmed candidates never move a number on their own.

---

## 9. Overrides — on-chain stays authoritative

Corrections are **layered, never destructive**.

```js
const corrected = applyOverrides(trade, { entry: 0.000025 });
corrected.entry            // 0.00002  ← still the on-chain value
corrected.overrides.entry  // 0.000025 ← the correction, stored separately

const view = resolveTrade(corrected);
view.entry          // 0.000025  ← corrected view
view.onchain.entry  // 0.00002   ← original, always recoverable
view.hasConflicts   // true
view.conflicts      // [{ field:'entry', onchainValue, overrideValue, severity:'HIGH', message }]
```

- `applyOverrides` writes only to `trade.overrides` and returns a new object.
  The decoded value on the record is never touched, so one bad edit can never
  make it unrecoverable.
- `resolveTrade` is the explicit read-time view. Reading `trade.entry` directly
  always gives you the chain.
- Conflicts are **detectable and reportable**: overriding a field the chain
  decoded to a different non-null value is a conflict. Severity is `HIGH` when
  the trade is `VERIFIED` (the user is contradicting hard data) and `LOW`
  otherwise (the value was inferred, so the user may well be right).
- Overriding a field the chain left `null` is **not** a conflict — that is the
  user filling a gap, which is the intended workflow for `NEEDS_REVIEW` trades.
- Only `OVERRIDABLE_FIELDS` are accepted. Attempts to override `id`,
  `signatures` or `source` are rejected and listed in `meta.rejectedOverrides`.

---

## 10. Failure behaviour

**No fabricated data reaches output, ever.** `services/marketData.js` has a
`generateSyntheticData()` random-walk fallback; nothing in that family is used
by any module documented here.

| Failure | Result |
|---|---|
| RPC unreachable | `complete: false`, `solBalance: null`, `tokens: []`, `totalUsdValue: null`, warning `RPC_UNAVAILABLE: <reason>`. HTTP **503**. Never `0`. |
| Price provider down | Balances still returned (they are real). `usdValue: null` per token, `priceSource: 'UNAVAILABLE'`, `totalUsdValue: null`, `complete: false`. HTTP **200** — the data present is honest. |
| Some tokens unpriced | `complete: false` + `PARTIAL_PRICING` warning naming the count. `totalUsdValue` excludes them rather than guessing. |
| Transaction not decodable | Jupiter tx → `NEEDS_REVIEW` trade with all-null numbers. Non-Jupiter tx → a warning, not a phantom trade. |
| Sell with no matching buy | `realizedPnl: null` (**never** scored against a zero cost basis), `NEEDS_REVIEW`, `UNMATCHED_SELL` warning. |
| Price resolver throws | Caught. Reconstruction continues, `entry` stays `null`, `PRICE_RESOLVER_FAILED` warning. |
| Rate limiting | Bounded exponential backoff (3 attempts, 400ms base) on 429/5xx/timeouts. When attempts are spent it fails closed to `complete: false` — it does not retry forever inside a lambda. |

Caching: 30s in-memory (only helps a warm lambda) plus CDN `s-maxage` — 30s for
portfolio, 60s for trades, both with `stale-while-revalidate`.

---

## 11. Verification status

**Read this before trusting output in production.**

This feature was built in an environment whose egress policy **blocks all
Solana and Jupiter hosts**. Every host tried returned `403 Forbidden: Host not
in allowlist` at the proxy:

```
api.mainnet-beta.solana.com    solana-rpc.publicnode.com    rpc.ankr.com
api.jup.ag                     lite-api.jup.ag              price.jup.ag
public-api.solscan.io
```

Consequently:

- ✅ **Verified by fixtures** — all decoding, classification, FIFO matching,
  confidence assignment, override layering, cash-flow detection, idempotence
  and failure behaviour. 200 assertions, zero network.
- ❌ **NOT verified against live mainnet** — no real wallet, transaction,
  balance or price has been read.

Specifically unverified and worth checking first on a real deployment:

1. **Program IDs** in `JUPITER_SWAP_PROGRAM_IDS` and
   `JUPITER_PERPS_PROGRAM_ID` are compile-time constants that were never
   matched against a live transaction. If swaps come back as `TRANSFER` instead
   of `SWAP`, a wrong or missing program ID is the first thing to check.
2. **Jupiter Price API response shape.** The client parses both the v3
   (`{ mint: { usdPrice } }`) and v2 (`{ data: { mint: { price } } }`) shapes
   defensively and falls through v3 → v2, but neither was exercised live.
3. **Real swap topology.** Fixtures model clean one-in/one-out swaps plus an
   ambiguous-leg case. Real Jupiter routes involve ATA creation, wSOL
   wrap/unwrap and multi-hop legs. The engine folds native SOL into the wSOL
   mint and adds fees back for exactly this reason, but the first live run
   should be spot-checked against Solscan.
4. **Token-2022 holdings** — queried, never observed.

Symbols are cosmetic: `services/tokenMapping.js` carries
`TODO: Verify actual WBTC/WETH token address` on its BTC and ETH entries, so
those labels may be wrong. **The mint is always the authoritative identifier**
in every record.

---

## 12. Validation harness

```bash
npm run validate:wallet
# or: node scripts/validate-wallet-reconstruction.js
```

Deterministic, fixture-driven, **zero network**. Every fixture is hand-written
in the exact shape `getParsedTransactions()` returns, and every expected value
is worked out by hand in a comment above its assertion — never by calling the
function under test and blessing the result. Exits non-zero on failure.

Covers: address validation (accepts real mainnet addresses including the
all-zero System Program, rejects junk, Ethereum addresses, wrong lengths and
every non-alphabet character); delta decoding and owner isolation; a single buy
→ `OPEN` with correct entry; buy → full sell → `CLOSED` with correct realized
P&L (gains and losses); buy/buy/partial-sell FIFO with the discriminating
+35-vs-+25 assertion; adds and partial exits producing correct `legs`;
undecodable transactions → `NEEDS_REVIEW` with all-null numbers; perps flagged
and excluded; transfers → unclassified candidate cash flows, not trades;
idempotence including input-order independence; override layering and conflict
detection; a failing RPC → `complete: false` with null balances; and a 64-case
FIFO invariant sweep against an independently written longhand recomputation.

Two real bugs were caught by this harness during development and fixed: a
base58 decoder that produced 33 bytes for all-zero addresses, and fee handling
that made every swap appear to have a spurious extra SOL leg.

---

## 13. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | `clusterApiUrl('mainnet-beta')` | RPC endpoint. Shared with `walletManager.js`. A dedicated provider is strongly recommended — the public endpoint rate-limits well below what a full history walk needs. |
| `JUPITER_API_KEY` | — | Used by `jupiterSwap.js` for higher limits. The price client here works without a key. |

No key or secret is required to read a wallet.

## 14. Files

| File | Role |
|---|---|
| `services/solanaWalletReader.js` | Read-only RPC + pricing. Address validation, portfolio, signatures, transactions, retry/backoff, cache |
| `services/jupiterReconstruction.js` | Pure, dependency-free reconstruction: classification, FIFO matching, confidence, overrides, cash flows |
| `api/wallet-portfolio.js` | `GET /api/wallet/portfolio` |
| `api/wallet-trades.js` | `GET /api/wallet/trades` |
| `scripts/validate-wallet-reconstruction.js` | Fixture harness (`npm run validate:wallet`) |
