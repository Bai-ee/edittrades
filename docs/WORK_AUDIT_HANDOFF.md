# EditTrades — Work Audit & Review Handoff

**Prepared for:** an independent reviewing agent, and the operator
**Author:** the implementing agent (Claude)
**Date:** 2026-08-23
**Repo:** `Bai-ee/edittrades`
**Branch:** `claude/edittrades-production-desk-k30mjg` (5 commits ahead of `main`)
**Production:** `https://snapshottradingview.vercel.app` running `main` @ `06cf3e1` — **none of the work below is deployed**

---

## 0. How to use this document

This is written to be checked, not believed. Every claim is tagged:

- **VERIFIED** — I ran it and observed the result. The command is given.
- **INFERRED** — read from code, not executed.
- **NOT VERIFIED** — I could not check it. Section 9 collects these.

The previous version of this document was written by the same agent lineage and
was, in two places, **wrong about its own work** (Section 8). Treat this one the
same way: look for what is absent, not only what is present.

---

## 1. Status

**NO-GO.** Two blockers, both requiring operator action rather than code:

| # | Blocker | Owner |
|---|---|---|
| **B-1** | Two live Solana private keys are committed to git history and still present at HEAD. | Operator — move funds, then purge history |
| **B-2** | Firestore/Storage rules are committed but **not deployed**. Until `firebase deploy` runs, the live database keeps whatever the console holds — which this repo's own guide prescribes as `allow read, write: if true`. | Operator — deploy and confirm |

Everything in the brief's own go/no-go list is otherwise met on this branch.
Details in Section 10.

---

## 2. What was done

Six independent audit agents ran first (market data, security/persistence,
Bitcoin Economic Value, risk manager, AI layer, production QA), forming findings
without sharing assumptions. Their findings were then verified centrally before
any fix. Where an agent's claim did not survive checking, that is recorded.

Five commits, in the brief's priority order:

| Commit | Subsystem |
|---|---|
| `651cb15` | P0 — synthetic market data removed from live paths |
| `f33172d` | P1 — persistence locked down, trade execution disarmed |
| `b1ff37b` | AI contract, risk-engine correctness, health + decision context |
| `1f85fd1` | Economic Value degradation, offline validation suites |
| `679e2f2` | Risk Manager UI, home health indicator, macro health into AI |

---

## 3. PRIORITY 0 — synthetic market data

### 3.1 What was there

`marketData.getCandles()` answered a failed Kraken call with
`generateSyntheticData()` — a `Math.random()` walk seeded from a spot price, or
from a hardcoded `$50,000` when even the spot lookup failed — and returned it
through the same code path as real candles. The objects were structurally
identical to Kraken's: same keys, plausible values, timestamps ending at
`Date.now()`. The only disclosure was a `console.log`.

**Agent A reproduced the consequence** (VERIFIED, in the egress-blocked audit
environment): 8 identical requests to the real `/api/analyze-full` handler
produced **4 fully-specified tradeable signals at up to 75% confidence**, built
entirely from `Math.random()`, each returned as HTTP 200 with `error:
undefined`. `currentPrice` varied by $8,915 across identical requests. A
separate call returned **Cardano at $52,310.92** stamped `source: "kraken"`.

The second, subtler half: because `getCurrentPrice` swallowed its own error and
returned a hardcoded default, **`getCandles` could never throw**. Every error
branch guarding candle data in the codebase — eight of them across
`api/analyze.js`, `api/indicators.js`, `api/analyze-full.js`, `scanner.js` and
`server.js` — was unreachable. The system read as defensive while being
structurally incapable of reporting a problem.

### 3.2 Production reality — an important correction

**VERIFIED in production, and it changes the severity framing.** Live:

```
/api/indicators/ADAUSDT?intervals=4h  ->  200, currentPrice 0.22
```

ADA prices correctly. Kraken is reachable from Vercel, so **the synthetic path
was latent in production, not actively firing.** Agent A's $52,310 ADA was
produced in the audit sandbox where egress is blocked — a faithful simulation of
a Kraken outage, not an observation of production.

That is a real distinction and I am not going to blur it. The correct
characterisation: **production was one Kraken outage away from serving
fabricated candles into live trade analysis**, not "production was serving
them". The defect was equally worth removing; the historical claim is narrower.

### 3.3 What replaced it

Market data is now a real observation from a named provider, or an error.

- `generateSyntheticData` deleted. Hardcoded price defaults deleted.
- Providers: **Kraken → Bitfinex**, both genuine exchange feeds, so failing over
  changes the venue but not the meaning. On total failure, a cached real
  observation is served **labelled STALE**; with no cache, `getCandles` throws
  `DataUnavailableError`.
- `services/dataProvenance.js` — every result carries `source`, `fetchedAt`,
  `ageSeconds`, `freshness` (LIVE / CACHED / STALE / UNAVAILABLE),
  `synthetic: false`, and `lastBarAgeSeconds`. That last one matters
  independently: a provider can answer instantly with a series that stopped
  updating hours ago.
- `assertNotSynthetic()` guards the return path as a tripwire, so a regression
  fails at the point of fabrication rather than in a position size.

Provenance rides on the candle array as a **non-enumerable property**. This was
a deliberate tradeoff: wrapping in `{ candles, provenance }` would have required
touching every indexing, slicing and `Object.entries` call site in live trading
paths. The cost is that it does not survive `JSON.stringify`; anything needing
provenance in a response body reads it via `getProvenance()`. **Reviewer: this
is the design decision here most worth challenging.**

### 3.4 Silent asset substitution — worse than synthetic

`SYMBOL_MAP[symbol]?.kraken || 'XBTUSD'` appeared at three call sites in
`marketData.js`. An unrecognised ticker did not fail — it returned **real
Bitcoin data under the requested symbol's name**. Worse than fabrication,
because it is internally consistent and passes every sanity check.

Two further instances, both found by Agent A and both confirmed:

- `api/analyze-full.js` declared a **shadowing three-entry `SYMBOL_MAP`**, so
  every asset outside BTC/ETH/SOL received Bitcoin's spread, order book and
  trade flow under its own ticker — and that microstructure feeds the strategy
  engine's confidence filter, not just the display.
- `server.js:426` read `marketData.SYMBOL_MAP`, **which was never exported**. The
  optional chain collapsed to `'XBTUSD'` for *every* symbol, including BTCUSDT.

All three now route through one exported `resolveKrakenPair()` that throws.

### 3.5 Other fabrication removed

| Site | Was | Now |
|---|---|---|
| `getTickerPrice` CoinGecko branch | `high24h: price*1.02`, `low24h: price*0.98` — a fabricated 4% range in the same fields as Kraken's measured values | `null` |
| same | `priceChange` assigned the *percentage* | absolute amount, derived from the real 24h change |
| `analyze-full` ticker failure | `volumeQuality: 'MEDIUM'` — a fabricated **passing** grade, plus `spread: 0` and `bid == ask == price` | `available: false`, all fields null |
| `api/indicators.js` | hardcoded `source: 'kraken'` — the only provenance field in the codebase, and a false one | real per-timeframe provenance |
| `coingecko.fetchMultiTimeframe` | one 30-day daily series returned for **every** interval, `high`/`low` invented as ±1% of close, `open === close` | throws; cannot be made honest |
| `coingecko.fetchKlines` | claimed 1m/3m/5m/15m/1h/4h, all served as daily or 30-min candles under the requested label | rejects intervals CoinGecko cannot serve |

### 3.6 A behaviour change you should know about

Removing the fabricated `volumeQuality: 'MEDIUM'` does not by itself restore the
safety filter, because `strategy.js` tested `volumeQuality !== 'LOW'` — which
`null` also satisfies. So I changed the gate to require a **measured** reading
before the 95%-confidence AGGRESSIVE tier unlocks.

**This alters trading-strategy behaviour, and the brief says not to do that
silently. So: stated loudly.** Before, the gate always passed (fabricated
`'MEDIUM'`); after my null change alone it would still always pass. Requiring a
measurement is what makes it a filter rather than a formality. If you disagree,
the change is one boolean in `services/strategy.js` (`volumeMeasuredAcceptable`).

### 3.7 Aggregation and the dead scanner

- **3d / 1w / 1M candles** were chunked in fixed groups from index 0 of whatever
  rolling window Kraken returned, so a "weekly" candle silently covered
  different seven days between calls and matched no real weekly bar. Now
  calendar-aligned (ISO weeks, calendar months, epoch-anchored 3-day).
- **The scanner could never return an opportunity.** It read `result.valid`
  where the canonical shape is `result.signal.valid`, so `!undefined` was always
  true and every symbol counted as `noSetup`. `api/scan.js` then mapped
  `entry_zone` / `stop_loss` / `reason_summary`, fields the scanner has never
  produced — so a surviving opportunity would have thrown a `TypeError`. **Both
  halves had to be broken for the endpoint to look healthy.** Both fixed.

---

## 4. PRIORITY 1 — security and persistence

### 4.1 B-1 — private keys in git (CRITICAL, operator action)

**VERIFIED.** `scripts/transfer-funds.js:14,18` contains two base58 Solana
private keys with their matching addresses written beside them. Agent B decoded
all three offline; two derive to exactly the addresses in source:

| Key | Address | Note |
|---|---|---|
| `CWT1QG…7Ns9` | `2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy` | "old wallet" |
| `7UqH8e…tJCq` | `JEAzPiuEheUQkK5Q1TLgm7VzuuZHDTzFu1oUwQgTjwT2` | **described in-source as the current trading wallet** |
| `DNPp5G…WivC` | (in `docs/SOLANA_WALLET_SETUP.md:22`, labelled "example output") | real key |

All entered history in commit `ba21b3b` and are present at HEAD.

**Not fixed by me, deliberately.** Purging requires rewriting shared history and
force-pushing; that is the operator's call, and rotating the files without
purging history achieves nothing. **Move the funds first** — the keys require no
application access at all.

Not web-exposed: `vercel.json` builds only `public/**` and `api/**/*.js`, so
`scripts/` is not served. Exposure is via the repository.

### 4.2 B-2 — Firestore rules committed but not deployed

No `firestore.rules`, `storage.rules`, `firebase.json` or `.firebaserc` existed
anywhere in the tree or in git history (VERIFIED). The live rules were readable
only in the console. Two committed artifacts assert they are wide open:
`FIREBASE_SETUP_GUIDE.md:76-90` prescribes `allow read, write: if true`, and
`public/js/riskStore.js` stated it as settled fact in its own header.

Added: `firestore.rules`, `storage.rules`, `firebase.json`. Default-deny;
per-uid isolation under `/users/{uid}/`; document size cap; Storage restricted
to images ≤8 MB (without a contentType check the bucket accepts HTML, and a
stored HTML file served from a Firebase download URL is a stored-XSS vector).
The legacy root `trades` collection is closed rather than left readable for
migration — everything written there was world-writable for its whole life, so
importing it would launder untrusted data into the record the Risk Manager
reasons over.

**Committing rules is not deploying them.** Until
`firebase deploy --only firestore:rules,storage` runs against
`edittrades-fd451`, nothing has changed for the live database. **This is B-2 and
I cannot close it from here.**

### 4.3 `/api/execute-trade` — unauthenticated mainnet execution

**VERIFIED by reading:** no key, no session, no origin check, CORS `*`. The only
gate was `validateSignal(signal)`, whose first test is `signal.valid` — **a
boolean the caller supplies in the request body**. The endpoint validated
attacker-controlled data against itself, then signed a real Jupiter swap.
`MAX_TRADE_SIZE_USD` caps one request; there was no rate limit and no daily cap.

`AUTO_EXECUTION_ENABLED` and `MAX_TRADES_PER_HOUR` are documented in
`docs/SOLANA_WALLET_SETUP.md` and appear in **zero lines of code** (VERIFIED by
grep). Documented controls that do not exist are worse than none.

Now, all default-closed: `TRADING_ENABLED` must be exactly `'true'`;
`TRADE_EXECUTION_SECRET` must match the `x-trading-secret` header via
constant-time compare; per-hour trade-count and cumulative-notional caps; amount
must be a positive finite number (`if (amount && amount > max)` admitted
negatives and let a missing amount default to $1); origin no longer `*`; the
request-header dump removed, since it would now log the secret.

**Two honest limitations.** The ledger is in-memory, so on Vercel it is
per-lambda-instance — it raises the cost of a drain attempt rather than bounding
it. And a shared secret authenticates the *caller* but does not bind a signal to
a real strategy run: **the server still trusts the client's `signal` object.**
Closing that means re-running the strategy server-side and executing only the
signal the server computed. Not done; see Section 11.

### 4.4 Other

- Hardcoded CryptoPanic key removed from its `||` fallback in two files
  (`api/crypto-news.js:43`, `server.js:698`). **Rotate it** — it is in history.
- `riskStore` cloud sync was **silently dead**: `getCloudDb()` returned null
  whenever the Firebase SDK was absent, and neither page that imports riskStore
  loads the SDK. A user enabling sync got no error and no writes. Now uid-scoped,
  auth-required, and `cloudSyncStatus()` reports why it is inactive.
- **Validation on read.** A stored policy was accepted on `typeof === 'object'`
  and shallow-spread over the defaults, so any write to the origin could set
  `maxRiskPerTradePct: 9999` and every limit would read green while sizing
  arbitrarily. Trades are now coerced-then-quarantined: a `plannedRisk` of
  `"1000"` or a lowercase `status` previously vanished from portfolio heat with
  no error — measured effect, open risk **5.6% → 0%**, and the same planned trade
  flipping **ABOVE PLAN → WITHIN PLAN**.

---

## 5. PRIORITY 2 — Risk Manager

### 5.1 The core arithmetic was correct

Agent D re-derived every formula from scratch — including a from-first-principles
solve of the isolated liquidation price — and compared against the engine over
20 cases plus edge probes. **The sizing math holds:**

| Relationship | Result |
|---|---|
| `allowedRisk = wallet × riskPct` | exact |
| `notional = allowedRisk / stopDistance` | rel. error < 1e-12 |
| `lossAtStop == allowedRisk` | bit-identical in 19/20; worst drift 5.7e-14 |
| `margin × leverage == notional` | holds to 1e-9 |
| **leverage never changes `lossAtStop`** | bit-identical across 1×…125× |

Short sign handling is correct; the `Math.abs()` is reached only after the side
check, so it is a safe simplification rather than a mask. Wrong-side stops are
rejected with an explanatory error. No `===` float comparison in the math path.

### 5.2 What was wrong — verdicts and guards, not arithmetic

**The notional cap was computed but never evaluated.** `exceedsNotionalPolicy`
appeared only in `summarizeAccount`, which runs on the *saved* book and excludes
the trade being planned. Reproduced: a 0.4% stop at 20× sized to **$62,500 on a
$25,000 wallet — 250% — and reported WITHIN PLAN with 7/7 checks passed.** The
previous version of this document claimed this fix was already shipped (R3). **It
was not.** Now an eighth check.

**Invalid `riskPct` silently sized a real position.** `0`, `-1`, `NaN` and
`"abc"` all became the 1% default and produced a $7,200 notional with nothing
saying a substitution occurred. `risk.html` feeds this from a free-text field, so
clearing the box or typing a lone `-` mid-entry sized a trade. Absent still
defaults (and reports `usedDefaultRisk`); present-but-invalid is now an error.
**The harness asserted the old behaviour, locking in the hazard** — I changed the
test, and say so here rather than burying it.

**Cross margin was shown an isolated estimate.** `estimateLiquidation` hardcoded
`marginMode: 'isolated'` and ignored any caller value; there was no margin-mode
input anywhere in the repo. Per the brief, cross now returns **LIQUIDATION
DEPENDS ON ACCOUNT / EXCHANGE MARGIN STATE** and no price. Spot is marked not
applicable. Isolated is labelled **EST.**

**The liquidation formula was a first-order approximation**, conservative for
longs and **anti-conservative for shorts** — it reported more room than the model
implies, by about `entry × mmr / L`. Replaced with the exact solve. Above
`1/mmr` (200× at the default 0.5%) the old form returned a price on the **wrong
side of entry** — 72,288 for a long entered at 72,000, plausible-looking at 201×.
Now refused.

**A clean 1× trade graded worse than a leveraged one.** "No liquidation
possible" scored `unknown`, so the safest configuration on the page read CAUTION
while the same trade at 2× read WITHIN PLAN. Now a pass.

**"CORRELATED … EXPOSURE" claimed a measurement never made.** The rule counts
same-direction positions and risk share; it never sees a price series. BTC, gold
and EUR all long produced "CORRELATED LONG EXPOSURE". Renamed **DIRECTIONAL …
CONCENTRATION** throughout, policy field renamed **Max Same-Direction Risk**, and
the explanatory copy now says correlation is assumed, not measured. The engine's
comments were always honest about this; the UI copy was not.

**Saving a trade double-counted it.** `refreshAfterMutation` reloaded positions
(including PLANNED) while the form still held the same trade, so `planTrade`
appended a second prospective copy: open risk **250 → 500**, margin **3600 →
7200**, two positions for one save — and every later sizing decision was made
against inflated heat. The form now clears on save.

Also: stop-distance epsilon instead of `entry === stop` (a 1e-10 stop sized to
**$2.5e14** on a $25,000 wallet); an error boundary around `recalculate` (a throw
left stale numbers beside new inputs, and Save persisted them); deep-merged
policy; and the five liquidation caveats — which have always existed in the
engine and **never reached the page** — are now rendered.

Trade history now also persists `marginMode`, `instrument`, the specific
failed/warned checks, and modelled costs. Previously only the single status
string was kept, so a trade saved as ABOVE PLAN carried no record of *what* was
breached — which is most of the value of a planned-vs-actual history.

---

## 6. PRIORITY 3 — Bitcoin Economic Value

### 6.1 A1 confirmed live

**VERIFIED against production**, 2026-08-23:

```
realizedCapDerivedRows: 5880   (of 5880 rows)
realizedCapSource: "derived from CapMrktCurUSD / CapMVRVCur"
metrics: [PriceUSD, SplyCur, HashRate, IssTotNtv, CapMVRVCur, CapMrktCurUSD]
```

`CapRealUSD` is absent from the served metric list. **The MVRV derivation is not
a fallback; it is the only path that works.** If Coin Metrics drops
`CapMVRVCur` from community access, the heaviest-weighted anchor dies.

### 6.2 The failure mode that mattered was partial, not total

Anchor availability was a **whole-history** property (`present > 0` across ~5,900
rows) while "which anchors drove today's number" is **per-day** — and the page
bound its UNAVAILABLE tiles to the history-wide flag. So an anchor could vanish
for the current day, the composite would silently renormalise over the rest, and
**nothing surfaced**: the tile stayed "available" and rendered an em-dash, the
chart toggle stayed enabled, the notice banner stayed hidden, source status
stayed `ok`.

Agent C measured it: dropping realized cap for the last 30 days moved Economic
Value **−35%** and the premium from **+582% to +949%**, with every honesty
affordance green. The state label is then a percentile of that premium against a
distribution built almost entirely from *three-anchor* readings — comparing
across models.

Fixed: `current.anchorsUsed / anchorsExpected / degraded` describe **this**
reading, and the page raises the brief's wording —
**ECONOMIC VALUE DEGRADED — N / 3 CORE ANCHORS AVAILABLE** — plus an explanation
that the state is scored against a full-anchor distribution.

### 6.3 The tripwire inverted under its own failure

`realizedCapSource` read `derivedRows === 0 ? 'CapRealUSD (direct)'`. But
`deriveRealizedCap` returns `derived: false` when **both** `CapRealUSD` and
`CapMVRVCur` are missing. So in exactly the scenario this field exists to
detect — the anchor dying entirely — it affirmatively reported **"CapRealUSD
(direct)"** while realized cap was null on every row. Now reports UNAVAILABLE.

### 6.4 `dataAgeDays` could not measure what it claimed

Both operands came from the same series, and the series spans only *observed*
dates — so when the feed stops publishing, the series simply ends earlier and the
value stays 0. Agent C demonstrated a feed **13 days behind reporting zero
staleness**, while the headline paired a live spot price against a 13-day-old
Economic Value. Split into `anchorGapDays` (the old quantity, correctly named)
and a wall-clock `dataAgeDays`, with `asOf` injected to keep the core pure.

### 6.5 Miner cost

Agent C's verdict, which I accept: the 2014–2025 efficiency curve and the
electricity curve **look materially better than "constructed estimates"** when
checked against hardware history (S9 ~98 J/TH, S17 ~45, S19 ~30, S21 ~15). Two
corrections made:

- **2013 anchor was wrong**: 8,000 J/TH, when January 2013 was still
  overwhelmingly GPU/FPGA at 50,000–300,000 J/TH and the first Avalon ASICs
  (~9,400 J/TH) shipped late that month. Moved to 30,000 with a transitional
  anchor at 2013-07.
- **`overheadMultiplier` 1.25 → 1.40.** 1.25 implied energy at ~80% of cash
  cost; public miner disclosures put it at 60–75%. The bias was systematic in one
  direction: low overhead → low miner cost → low EV → **high reported premium**.

Per-anchor sourcing is now documented in-code, along with the honest limit: fleet
average efficiency **is not observable**, only the implied network draw is
externally checkable, so the output cannot be validated better than roughly
±30%. It is labelled EST. and carries 0.20 weight. `minerAssumptions.extrapolated`
now flags that the electricity curve's last anchor is 2025-01-01 — **it has been
a frozen constant, not a curve, for months.**

Also fixed: convergence could report **MODERATE AGREEMENT with zero anchors in
band** ("0/2 anchors · MODERATE AGREEMENT"); stale cache had no age bound.

### 6.6 Independent recomputation (VERIFIED)

Against the live production response:

```
EV (geometric, from published anchors) = 56,135.21   API: 56,045.93   +0.159%
Premium ((price-EV)/EV)                = 37.39%      API: 37.39%      exact
MVRV (price/realizedPrice)             = 1.4575      API: 1.4575      exact
(arithmetic mean would be 56,403.51 — geometric confirmed)
```

The 0.159% EV gap is expected and explained: the published composite is a 14-day
trailing smooth (`compositeDays: 14`), while the anchors shown are today's.

**Caveat, and Agent C is right about this:** the MVRV identity check is
**circular** when realized cap is derived — `price/realizedPrice ≡ CapMVRVCur`
algebraically. Agent C corrupted upstream MVRV by 100×, moving realized price two
orders of magnitude and the state from EUPHORIC to NEAR VALUE, and **every
internal identity check still passed.** Three of the existing validator's checks
are tautologies. I have not rewritten that harness; see Section 11.

---

## 7. PRIORITIES 4–7 — health, decision context, AI, observability, tests

**`services/systemHealth.js`** — status per layer, derived from provenance and
error objects, never asserted. Absence is `UNKNOWN`, distinct from `OK` and
`FAILED`. `healthHeadline()` returns **null when healthy**: a badge that is always
lit is one the operator learns to stop reading.

**`services/decisionContext.js`** — the five layers in order, each block carrying
its own `available`/`reason`. `decisionReady` is false whenever market data is
unavailable. The AI block is populated last and read by nothing.

**`services/aiContract.js`** — the binding DATA CONTRACT. Agent E's central
finding was not that the model misbehaved but that **it was handed almost nothing
and told to be specific**: `essentialSnapshot` read `currentPrice` /
`priceChange24h` / `analysis` where the client sends `price` / `change24h` /
`signal.confluence`, and never copied `timeframes` — so those arrived
`undefined`, `JSON.stringify` dropped them, and the model could not even see they
were meant to exist. The prompt then asked for "actual numbers from the data" and
"exact percentage from data". Inventing was the only way to comply.

Fixed: the field names, plus `serializeDataBlock` (renders absence as literal
`"MISSING"`), `collectMissingFields` (computed deterministically and stated in
the prompt), and a contract forbidding invented prices, indicators, macro
anchors, wallet balances, position sizes, risk, liquidation, ratings and
timelines.

Also: **client-supplied `systemPrompt` is rejected** — it was passed verbatim as
the OpenAI system message with CORS `*` and no auth, so anyone could replace
every guardrail on the operator's key. Temperature was caller-controlled with a
cap that applied only when `isDev`, and `isDev` was true unless
`VERCEL_ENV === 'production'` — **so production had no cap.** Models pinned to
dated snapshots.

**Grades no longer scraped from prose.** `.includes('B')` matched any capital B,
so *"Bullish structure on BTC. Rating: A"* graded **B**; the initial value was
`'A'`, so an ungraded response was emitted as a **passing** grade — then coloured
the trade panel and was persisted to Firebase. `server.js` separately returned
`success: true, priority: 'A'` when no API key was configured: a passing grade
with no analysis at all. Both fail closed now.

**Observability** — structured `provider_transition` events on every fallback,
per-timeframe provenance in `dataSources`, and macro source health travelling
with the values into the AI payload. No secrets, no candle payloads.

**Tests** — `npm run validate:all`, **232 offline assertions**:

| Suite | Assertions |
|---|---|
| Market data integrity | 58 |
| Risk Manager | 114 (was 96) |
| Decision desk integration | 60 |
| Bitcoin Economic Value | network-dependent — **SKIPPED here** |

`validate-all.js` reports a network suite that could not reach its providers as
**SKIPPED (no network)**, never as a pass. A suite that verified nothing must not
read as coverage — that is the same failure this whole effort is about.

The five brief integration cases are covered. Case 3 asserts a deep-discount
macro does **not** make an invalid setup valid; case 4 that a dead feed yields
`decisionReady: false` and no invented price; case 5 that absent risk sizing is
**stated**, not implied.

---

## 8. Where the previous handoff was wrong

Recorded because it bears on how much weight to give this one:

1. **"R3 — aggregate notional cap … Solution: enabled `maxNotionalExposurePct`.
   Verified: 1000% exposure breaches."** The cap was verified at the
   `calculateExposure` level only and **never wired into the checklist**. A 250%
   notional reported WITHIN PLAN, 7/7 passed.
2. **"Risk Manager — engine + storage only; no UI yet."** `public/risk.html`
   (59 KB) existed on the branch at the time of writing. The doc was a commit
   behind its own repo.
3. Assertion count stated as 93; actual was 96.

---

## 9. What I could NOT verify

1. **Live Firestore and Storage rules.** The single biggest open question. B-2's
   severity rests on `FIREBASE_SETUP_GUIDE.md` and a code comment, both of which
   assert `allow read, write: if true`. **Read the console.** If someone
   tightened them, B-2 drops in severity — though document paths are still
   unscoped, so any authenticated user would read everyone's trades.
2. **Whether `Bai-ee/edittrades` is public.** Determines whether B-1 is "the
   internet has these keys" or "collaborators and clones do". Rotate either way.
3. **Whether the exposed wallets hold funds.** Needs a mainnet RPC query.
4. **My changes in production.** Nothing on this branch is deployed. Everything
   verified live was against `main` @ `06cf3e1`.
5. **Any page rendered in a browser.** No browser was available. Pages were
   verified by extracting every inline `<script>` from `risk.html`,
   `index.html`, `bitcoin-value.html` and `tracker.html` and syntax-checking
   each — **all parse clean** — which proves they load, not that they lay out
   correctly. **Mobile layout is NOT VERIFIED.**
6. **`npm run validate:btc-value` against live APIs.** Egress to Coin Metrics,
   Kraken, CoinGecko and Bitfinex is blocked here (403 at the proxy gateway).
   It has still never run green against live providers.
7. **The AI's actual output** under the new contract. The payload fix is
   verified; the model's behaviour given it is inferred.
8. **Kraken's 720-row cap**, reasoned from the API contract, not measured.
9. **The Solana mint addresses** in `tokenMapping.js`, which carry self-declared
   `TODO: verify` comments and sit on the execution path.

---

## 10. Go / no-go against the brief's own standard

| Criterion | Status |
|---|---|
| No synthetic data can enter live decisions | **MET** — generator deleted, tripwire added, 58 assertions |
| Market data provenance explicit | **MET** |
| Firestore not world-writable | **NOT MET — B-2.** Rules written, not deployed |
| Risk math passes independent tests | **MET** — re-derived independently; 114 assertions |
| Risk UI works desktop and mobile | **PARTIAL** — scripts parse; layout not verified in a browser |
| Cross-margin correctly modelled or explicitly unsupported | **MET** — explicitly unsupported |
| Economic Value degradation visible | **MET** |
| Provider failures don't silently change model semantics | **MET** |
| AI cannot invent numeric inputs | **MET** in the contract and payload; model behaviour inferred |
| Stale/unavailable surfaced | **MET** |
| Validation scripts pass | **MET** for 232 offline; macro suite skipped, not passed |
| Deployed pages actually checked | **MET for `main`** — and `main` is not this work |
| Unresolved critical findings zero | **NOT MET — B-1** |

**NO-GO.** Blockers B-1 and B-2, both operator actions.

---

## 11. Known limitations if the blockers clear

Ranked. None of these is a reason to hold a deploy; all are real.

1. **`/api/execute-trade` still trusts the client's `signal`.** The secret
   authenticates the caller, not the signal. Fix: re-run the strategy
   server-side and execute only the signal the server computed.
2. **The rate ledger is per-lambda-instance.** Raises the cost of a drain
   attempt; does not bound it. Needs a datastore.
3. **Economic Value's identity checks are tautologies.** A 100× upstream MVRV
   corruption passes every one. Replace with a non-circular check and more
   external reference rows.
4. **A1 has no mitigation, only visibility.** No free alternative realized-cap
   source was found. If `CapMVRVCur` disappears, the anchor dies — loudly now,
   but it still dies.
5. **Miner cost is modelled.** Fleet efficiency is not observable; ±30% at best.
6. **Concentration is direction-only.** BTC and gold both long count the same.
   Now labelled honestly rather than fixed.
7. **Indicators compute on the unclosed candle.** `brokeResistanceOnClose` is
   evaluated against a bar that has not closed. Found by Agent A; not fixed.
8. **`priceChangePercent` from Kraken is since-UTC-midnight**, not 24h. At 00:30
   UTC it reports ~0%.
9. **The 2013 miner anchor** is still the least trustworthy point on the curve,
   and it sits exactly at `startDate`.
10. **`strategy_logic_export/`** is a stale duplicate of `services/`, `api/` and
    `lib/` — including a full copy of the synthetic generator. Not built by
    Vercel, but it will drift and someone will read it.

---

## 12. Verification commands

```bash
# Everything offline. 232 assertions.
npm run validate:all

# Individually
npm run validate:market-data     # 58 — no synthetic data can reach a decision
npm run validate:risk            # 114 — sizing, liquidation, policy checks
npm run validate:decision-desk   # 60 — the brief's five integration cases
npm run validate:btc-value       # needs network; fails closed without it

# P0 tripwire: must throw, never return candles
node -e "import('./services/marketData.js').then(m=>m.getCandles('BTCUSDT','4h',300))
  .then(c=>console.log('FAIL - returned',c.length))
  .catch(e=>console.log('PASS -',e.code))"

# No fabrication left in production paths (expect no output)
grep -rn "Math\.random\|generateSyntheticData" services/ api/ lib/ server.js \
  | grep -v "^\S*: *[/*]"

# B-1: must return empty after the history purge. Currently returns ba21b3b.
git log --all -S'CWT1QGDPSS5jhgZuuZkYCVKD32AxzT6cnLxy38xQ7Ns9' --oneline

# B-2: 403 PERMISSION_DENIED means the rules are deployed. Document data means they are not.
curl -s 'https://firestore.googleapis.com/v1/projects/edittrades-fd451/databases/(default)/documents/trades'

# Production (currently main @ 06cf3e1, not this branch)
curl -s ".../api/bitcoin/economic-value?view=summary" | jq '{
  weights:.current.weightsApplied, rcSource:.meta.sources.coinmetrics.realizedCapSource }'
# tripwire: weightsApplied must have 3 keys; rcSource must never say "direct"
# while anchors.realizedPrice is null
```

---

## 13. Review checklist

**Challenge these specifically:**

- [ ] Non-enumerable provenance on candle arrays (3.3) — is the JSON-invisibility
      tradeoff acceptable, or should every call site have been changed?
- [ ] The `volumeMeasuredAcceptable` strategy change (3.6) — a deliberate
      behaviour change to a trading gate.
- [ ] Closing the legacy `trades` collection rather than migrating it (4.2).
- [ ] `overheadMultiplier` 1.25 → 1.40 and the 2013 anchor (6.5) — both move the
      headline premium.
- [ ] Requiring a *measured* volume reading, and rejecting `riskPct: 0` — both
      changed tests that previously asserted the old behaviour.
- [ ] Whether a shared secret is sufficient for `/api/execute-trade`, or whether
      it should stay hard-disabled until server-side signal binding exists.

**Do before trusting any of it:**

- [ ] Move the funds (B-1).
- [ ] Read the live Firestore rules (B-2).
- [ ] Load `/risk` and `/bitcoin-value` on a real phone after deploying.
- [ ] Run `npm run validate:btc-value` somewhere with network access.
