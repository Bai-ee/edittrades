# Home Risk Card + Live Wallet Validation — Findings

Branch `claude/home-risk-wallet-validation-yn76o9`, based on `origin/main` **95fce60**.

This records what was checked, what was fixed, and — more importantly — what was
found and deliberately **not** fixed. Everything below is marked with how it was
established, because "an audit said so" is not evidence.

| Mark | Meaning |
|---|---|
| **VERIFIED** | Reproduced by executing the code in this repo, or established by direct reading of the exact lines named. |
| **REPORTED** | Raised by a review pass and consistent with the code, but not independently reproduced here. |

---

## 0. The live-validation gap — read this first

**The live wallet pipeline was NOT validated.** The environment this work was
done in blocks outbound HTTPS to `api.mainnet-beta.solana.com`, the Jupiter
price API, and `snapshottradingview.vercel.app` (403 at CONNECT, an egress
policy). Every attempt is recorded; none was routed around.

So, plainly:

- No live wallet was read.
- No live transaction was reconstructed.
- No VERIFIED / PARTIAL / NEEDS_REVIEW counts from real data exist.
- Latency, transaction volume and pricing-failure rates are unmeasured.

Everything asserted here is from fixture-driven execution and source reading.

`scripts/probe-live-wallet.js` (`npm run probe:wallet -- <public-address>`) is
the runnable substitute. It walks
`portfolio -> trades -> reconstruction -> account state -> level ->
recommendation`, checks the invariants that must hold whatever a wallet
contains, and prints the counts this validation could not produce. It takes a
**public address only**, refuses anything that looks like a seed phrase or a
secret key, writes nothing, signs nothing, and truncates the address in its
output. It exits `3` — distinct from a failure — when it cannot reach the
application, so a blocked network can never be mistaken for a green run.

**Jupiter Perpetuals are not reconstructed.** This is not a limitation
discovered here; it is the deployed design, stated by
`api/wallet-trades.js` (`perpsSupported: false`) and implemented as
`NEEDS_REVIEW` stubs with null numbers, excluded from realized P&L. No claim to
the contrary should be made about this release. **VERIFIED** by reading
`services/jupiterReconstruction.js:331-341, 928-953`.

---

## 1. Fixed in this change

### 1.1 The home card showed "Open Risk 0.00%" beside "Wallet Unavailable"

**VERIFIED** — reproduced, then fixed, and pinned by
`scripts/validate-home-risk-card.js` §5b and by a browser check.

`calculateOpenRisk` returns `0` for every percentage when it has no equity to
divide by, and marks the result `valid: false`
(`public/js/adaptiveRisk.js:1464-1474`). Those zeroes are written to the display
cache like any other number. Rendering them produced the single most misleading
state this card can reach:

```
Wallet  Unavailable     Open Risk  0.00%     Positions  3
```

Three open positions and, apparently, nothing at risk.

Fixed in `public/js/riskHomeCard.js`: a percentage whose denominator is missing
renders as a dash. The position **count** survives — it is counted from position
records, not divided by equity, so it is still a fact when the balance is not.

### 1.2 A live wallet read never went stale

**VERIFIED** by reading `public/js/riskPage.js` (pre-change `isWalletStale`),
now pinned by `validate-home-risk-card.js` §8b.

`isWalletStale()` returned `false` unless the status was `CACHED`. A `LIVE` read
therefore never expired, however long the tab stayed open. That is exactly the
case the freshness rule exists for: `evaluate()` re-runs on every
confidence-slider move and strategy toggle, so a tab open for hours kept sizing
positions against the balance fetched at page load, and `STALE_WALLET_DATA` —
the blocker the engine raises for precisely this — could never fire on a live
read.

Now `isReadStale()` (exported, pure) ages any reading that has a value,
regardless of how it was obtained.

**Economic consequence of the fix:** after `STALE_WALLET_MS` (10 minutes) with
no refresh, the Risk Manager reports `INCOMPLETE` instead of sizing a position.
That is the intended engine behaviour, and it is the conservative direction.
Nothing here re-reads the balance automatically; the refresh control does.

### 1.3 A truncated transaction history reported itself as complete

**VERIFIED** — reproduced against a fixture RPC with 5,000 signatures and a cap
of 100 (`complete: true, hasMore: true, warnings: []`), now pinned by
`scripts/validate-wallet-reconstruction.js` §17.

`getSignatures` returned `complete: true` for a walk that stopped at its cap.
`getWalletActivity` passes the same `maxTransactions` to both the signature walk
and the transaction fetch, which made `getTransactions`' own `TRUNCATED` warning
**unreachable**. `api/wallet-trades.js` therefore returned `complete: true` for a
partial history, and `riskPage.js` read neither `complete` nor `window.hasMore`.

This is not a cosmetic inaccuracy. `reconstructTrades` matches sells against buys
**inside the window**, so a window that cuts the opening buys does not merely
omit trades — it manufactures unmatched sells, which arrive as `NEEDS_REVIEW`
records with null P&L that `calculateRecentPerformance` counts as scratches and
`calculateRiskLevel` counts toward its promotion gates. **A truncated read moves
the level.**

Fixed in `services/solanaWalletReader.js`: `complete: !hasMore`, plus an explicit
`TRUNCATED:` warning. Conservative edge, deliberate and tested: a history exactly
the size of the cap reports incomplete, because proving otherwise needs one more
page.

### 1.4 Duplicate signatures doubled a position, silently

**VERIFIED** — reproduced against a fixture RPC that repeats 3 rows at each page
boundary (2000 collected, 1997 unique, no warning). Now pinned by §17.

Several public RPC providers re-serve the `before` cursor row at the head of the
next page. Nothing de-duplicated. A repeated swap is summed twice — double
quantity, double notional, still `VERIFIED` — and the trade record
de-duplicates its own `signatures` array, so the evidence of the double was
erased on the way out.

Fixed with a `Set` in `getSignatures`, a `DUPLICATE_SIGNATURES:` warning, and a
guard against a non-advancing cursor (which the de-duplication would otherwise
have turned into an infinite loop — caught during development, and now a test).

### 1.5 An incomplete read produced a confident account verdict

**VERIFIED** by reading `buildAccount` (pre-change) and the engine's account
contract; pinned by `validate-home-risk-card.js` §8c.

`solanaWalletReader` sets `complete: false` when the price feed cannot value
every holding, and the endpoint returns that as **HTTP 200** with an understated
total. `buildAccount` dropped it, and the engine has no completeness input at
all — it knows only `walletAvailable` and `dataStale`.

`resolveAccountDecision()` (new, exported, pure) now returns `INCOMPLETE` when
either the wallet read or the transaction window was partial. This is the
**account-level** verdict the home card renders; see §2.1 for what it does not
cover.

### 1.6 Reconstruction warnings were collected and never shown

**VERIFIED** — pre-change, `state.history.warnings` had three assignments and
zero reads.

`UNMATCHED_SELL`, `MISSING_TRANSACTIONS`, `BATCH_FAILED`, `PRICE_RESOLVER_FAILED`,
`UNCLASSIFIED_TX` — every signal that a number below it rests on less than it
appears to — was discarded. `renderHealth` now surfaces them in a collapsed
"Data warnings" block, along with a `PARTIAL HISTORY` marker beside the
closed-trade count.

### 1.7 A comment that contradicted its own code

**VERIFIED, and NON-BEHAVIOURAL.** `openPositionsForEngine` said unrealised P&L
"stays null unless a human has entered a mark" and then wrote `: 0`. It now
passes `null`. **This changes no number today** — `calculateOpenRisk` applies the
same `isFiniteNumber(...) ? ... : 0` default internally — but it stops the page
asserting a mark it does not have, and puts the remaining gap where it belongs
(§2.2).

---

## 2. Found and NOT fixed

Each of these is real. None is fixed here, and the reason is the same in every
case: the fix changes what counts as a trade or what consumes risk, and **none
of it can be validated against live data from this environment**. Bundling
unvalidatable behaviour changes into a PR that already touches the wallet reader
would make it harder to review, not safer.

### 2.1 HIGH — a plain transfer can be reconstructed as a VERIFIED trade

**VERIFIED by reading** `services/jupiterReconstruction.js:348-366`, and
consistent with a reproduction reported by the reconstruction audit.

The `SWAP` branch requires only "at least one inbound leg and at least one
outbound leg **for the observed owner**". It does **not** require the transaction
to have touched a Jupiter or any other DEX program — `viaJupiter` is computed
(`:311`) and used for the `UNDECODABLE` case (`:918`) but never gates `SWAP`.

A token withdrawal that also closes the token account — a rent refund, an
extremely common shape — has exactly one outbound token leg and one inbound SOL
leg. With one leg per side, `incidental` is empty, so `ambiguousLegs` is false
and **no confidence downgrade is applied**. If the outbound leg is a stablecoin,
`priceBasis` resolves to `QUOTE_STABLE` and the record is emitted as
**VERIFIED**, at an absurd derived price, and is removed from the cash-flow
review queue it should have been in.

Consequence: a phantom closed trade in the account's record, contributing to
level progression and R statistics, with top confidence and no warning.

Proposed fix (for its own reviewed change): gate the `SWAP` branch on
`viaJupiter` — the module's program list is Jupiter-only and the file is named
for it — and route non-DEX two-sided movements to the transfer/cash-flow path.
Add a sanity check on the derived price. This needs live validation against real
wallets before merge, because it changes what counts as a trade for everyone.

### 2.2 MEDIUM — an unmarked losing position consumes no risk budget

**VERIFIED by reading** `public/js/adaptiveRisk.js:1425`.

`calculateOpenRisk` does `isFiniteNumber(p.unrealizedPnl) ? p.unrealizedPnl : 0`.
The reconstruction never estimates unrealised P&L (by design), so for every
on-chain open position "unknown" becomes "flat". The documented rule that
unrealised losses count at 100% toward consumed heat therefore never fires for
reconstructed positions; only the 0.5% closure-reserve floor does.

This is an **engine** change (the engine cannot currently distinguish "no mark"
from "flat"), so it is out of scope here under the rule that risk-math changes
need a demonstrated failing invariant plus live evidence. §1.7 makes the page
stop asserting the zero; the engine still applies it.

### 2.3 MEDIUM — a truncated history still persists a level

Partially mitigated: §1.3 makes truncation visible and §1.5 makes the
account-level decision `INCOMPLETE`. But `historyIsAuthoritative` in
`evaluate()` still treats any 2xx as authoritative, so a level computed from a
partial window is still written to carry-forward state.

Deliberately not changed: refusing to persist would mean any wallet with more
than ~200 transactions never progresses a level at all. That is a product
decision about whether to raise the window or paginate it, not a defect fix, and
it is Bryan's call. **REPORTED**, with the mechanism VERIFIED in §1.3.

### 2.4 MEDIUM — PARTIAL trades priced at *current* spot are summed into realized P&L

**REPORTED** by the reconstruction audit. `summarise` excludes only
`NEEDS_REVIEW` from `stats.realizedPnl`; `createCurrentPriceResolver` resolves
current spot rather than the price at the block, and memoises per mint. A whole
history of SOL-quoted swaps can therefore be priced with one SOL price and added
to the same total as arithmetic-exact VERIFIED trades, with no split field.

### 2.5 MEDIUM — reconstructed and manual trades can duplicate

**REPORTED** by the risk-engine audit. Trade ids derive from the opening
signature *in the fetched window*, so a sliding window can re-id a long-running
episode; `mergeTradeRecords` then emits the orphaned local record as a standalone
trade. Separately, marking a VERIFIED record "not a trade" creates a classified
cash flow without cancelling the trade, so the same dollars are both a deposit
removed from the curve and a closed trade feeding R statistics.
`mergeTradeRecords` and `upsertTradeRecord` have no test coverage.

### 2.6 LOW — manually entered cash flows can land outside the equity curve

**REPORTED** by the risk-engine audit. `addManualCashFlow` stamps `now` when no
`at` is supplied, and both call sites do. `buildEquityCurve` applies a flow only
inside `(s0, s1]`, so a flow stamped after the last snapshot is never applied and
the transfer reads as performance. On-chain candidates keep their real chain
timestamp and are unaffected.

### 2.7 LOW — `request.override.leverage` is not clamped

**REPORTED**. Not reachable from `riskPage.js` today (no `override` is ever
passed), so it is a latent hole rather than a live violation.

### 2.8 LOW — decimal-blind leg selection

**REPORTED**. Leg selection sorts by raw integer units, which are not comparable
across mints with different decimals, so a small stable leg can lose to a rent
leg. Flagged `PARTIAL` when it happens, so this is a wrongness problem rather
than a false-certainty one.

---

## 3. Invariants checked and holding

Established by execution against the engine, and by the 221-assertion wallet
suite and 247-assertion adaptive suite:

- `adjustedEquity` is the capital base and is not reduced by deposits.
- Unclassified cash flows never reach the engine; nothing auto-classifies.
- Level progression is percentage-based; a single large winner cannot buy a
  level (R is winsorised at +2R before progression).
- Demotion is faster than promotion.
- Confidence can never exceed the envelope — swept across strategies, levels,
  streaks, drawdowns and confidences with zero overshoot.
- `NO_TRADE` blockers override confidence; the gate runs last.
- An unavailable wallet, a null wallet value and a `NaN` wallet value all
  produce `INCOMPLETE`.
- A stale balance produces `STALE_WALLET_DATA` and `INCOMPLETE`.
- Simulation cannot write real state: every store-mutating call site in
  `riskPage.js` is inside `persist()`.
- The `display` cache cannot become an engine input: `loadLevelState()` returns
  only the five carry-forward fields, and `riskHomeCard.js` has no imports at
  all, so it cannot reach the engine even by accident.
- The home page derives no risk number of its own, asserted structurally by
  `validate-home-risk-card.js` §9.
