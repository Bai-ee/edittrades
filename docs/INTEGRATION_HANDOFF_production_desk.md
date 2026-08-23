# Integration Handoff — Production Decision Desk

**For:** the agent integrating `claude/edittrades-adaptive-risk-manager-fgz3im`
**From:** the agent that wrote the production-desk change set
**Date:** 2026-08-23

---

## 0. Read this before you plan the merge

**My work is already on `main` and already deployed.** You are not pushing it.
It merged as PR #2 (`496716d`) and shipped to production at
`snapshottradingview.vercel.app`. `main` has since moved to `ccd80a6`.

So the task in front of you is: **merge the adaptive-risk/wallet branch on top
of a codebase whose data-integrity contracts changed underneath it.** That
branch was cut from `06cf3e1` — the *same* commit mine was cut from — so it has
never seen any of this.

The single most important thing in this document: **`git` reports the
`risk.html` merge as resolvable, and resolving it carelessly will silently
delete several hundred lines of safety code without a single conflict marker
left behind.** Details in §4.

---

## 1. What I changed, and the contract behind each change

The whole change set enforces one rule:

> Every value the system presents as market data is a real observation from a
> named provider, or it is an error. There is no third option.

If you preserve nothing else, preserve that. Each item below is a *contract*,
not a preference — code elsewhere now depends on it.

### 1.1 Market data (`services/marketData.js`, `services/dataProvenance.js`)

| Contract | Why it exists |
|---|---|
| `getCandles()` **throws** `DataUnavailableError` when no provider answers. It never returns candles it invented. | It used to answer a failed Kraken call with a `Math.random()` walk seeded from spot — or from a hardcoded `$50,000`. Measured: 8 identical `/api/analyze-full` requests produced **4 fully-specified tradeable signals at up to 75% confidence**, all HTTP 200 with `error: undefined`. |
| `getCandles()` **must be able to throw.** | `getCurrentPrice` used to swallow its own error and return a hardcoded default, so `getCandles` was structurally incapable of failing — which made **eight** downstream error branches unreachable dead code. If you make it infallible again, every one of those guards dies silently. |
| Unknown symbols **throw** `UnsupportedSymbolError`. Never resolve to a default pair. | `SYMBOL_MAP[symbol]?.kraken \|\| 'XBTUSD'` returned **real Bitcoin data under the requested symbol's name** at three sites. Worse than fabrication: internally consistent, passes every sanity check. |
| Every candle array carries provenance (`source`, `fetchedAt`, `ageSeconds`, `freshness`, `synthetic:false`, `lastBarAgeSeconds`). | Read it with `getProvenance()` from `services/dataProvenance.js`. It is a **non-enumerable** property — see §5. |
| `assertNotSynthetic()` guards the return path. | Tripwire. If someone reintroduces fabrication it fails at the source, not in a position size. |

**Null means unavailable. It does not mean zero, and it does not mean neutral.**
Fields that used to be fabricated are now `null`: `high24h`, `low24h`,
`volumeQuality`, `spread`, `bid`, `ask`, `bidAskImbalance`. §3 is about what
that already cost.

### 1.2 Risk engine (`public/js/riskManager.js`)

The sizing arithmetic was **already correct** — I re-derived every formula
independently and it held to <1e-12. I did not touch it. What I changed was the
verdicts and guards around it:

- **`notional-exposure` check added.** The aggregate cap was computed but never
  evaluated on the planned-trade path. A 0.4% stop at 20× sized to **250% of
  wallet and reported WITHIN PLAN with 7/7 checks passed.**
- **`riskPct` of `0` / `-1` / `NaN` / `"abc"` is now an error.** All of them
  used to silently become the 1% default and size a real position. Absent
  (`undefined`/`null`/`''`) still defaults, and reports `usedDefaultRisk: true`.
- **Cross margin returns no liquidation price**, only
  `LIQUIDATION DEPENDS ON ACCOUNT / EXCHANGE MARGIN STATE`. The function used to
  hardcode `marginMode: 'isolated'` and ignore the caller entirely. Spot is
  `notApplicable`.
- **Exact isolated liquidation solve**, replacing a first-order form that was
  anti-conservative for shorts. Leverage past `1/mmr` is refused — it used to
  return a price on the *wrong side of entry*.
- **`DIRECTIONAL … CONCENTRATION`**, not `CORRELATED … EXPOSURE`. The rule
  counts direction and never computes a correlation. BTC + gold + EUR all long
  were labelled "correlated".

Check objects use **`state`**, not `status`. (`{ id, label, state, detail }`.)
I got this wrong once myself and it cost a debugging round.

### 1.3 Persistence (`public/js/riskStore.js`)

- **`sanitizePolicy()` on read.** A stored policy was accepted on
  `typeof === 'object'` and shallow-spread over the defaults, so anything on the
  origin could set `maxRiskPerTradePct: 9999` and every limit would read green
  while sizing arbitrarily.
- **`loadTradesWithRejects()`** coerces numeric strings and **quarantines** what
  it can't. A `plannedRisk` of `"1000"` or a lowercase `status` used to vanish
  from portfolio heat silently — measured effect: open risk **5.6% → 0%**, and
  the same planned trade flipping **ABOVE PLAN → WITHIN PLAN**.
- **Cloud sync is uid-scoped and auth-required**, with `cloudSyncStatus()`
  reporting why it's inactive. It used to be a silent no-op: neither page that
  imports riskStore loads the Firebase SDK, so enabling sync wrote nothing and
  said nothing.

**Your branch's `riskStore.js` changes auto-merge cleanly with all of this** —
verified: syntax OK, exactly one definition of each function, both sides'
features present. Don't hand-resolve it; let git do it.

### 1.4 AI (`services/aiContract.js`)

- Binding `DATA_CONTRACT` preamble; absence renders as literal `"MISSING"`
  rather than being dropped by `JSON.stringify`.
- **Client-supplied `systemPrompt` is rejected.** It used to be passed verbatim
  as the OpenAI system message with CORS `*` and no auth.
- No grade is scraped from prose. `.includes('B')` matched any capital B, so
  *"Bullish structure on BTC. Rating: A"* graded **B**, and an ungraded response
  defaulted to a **passing** grade that was persisted to Firebase.

### 1.5 Security (`api/execute-trade.js`, `firestore.rules`, `storage.rules`)

- Execution is **default-OFF** behind `TRADING_ENABLED` + `TRADE_EXECUTION_SECRET`
  + per-hour caps. It previously had **no authentication at all**; its only gate
  was `signal.valid`, a boolean the caller supplies in the request body.
- `firestore.rules` / `storage.rules` / `firebase.json` are committed —
  default-deny, per-uid isolation. **They are not deployed.** See §7.

### 1.6 New modules you can build on

| File | Purpose |
|---|---|
| `services/dataProvenance.js` | Freshness vocabulary, coverage/warmup requirements, typed errors |
| `services/systemHealth.js` | Per-layer derived status. `healthHeadline()` returns **null** when healthy — deliberately silent |
| `services/decisionContext.js` | market → setup → macro → risk → ai; each block carries its own `available`/`reason`. AI is output-only |
| `services/aiContract.js` | The AI data contract |

---

## 2. Your branch has never deployed successfully

Both Vercel builds for `claude/edittrades-adaptive-risk-manager-fgz3im` are in
**ERROR** state:

- `dpl_2DUPncpWVbJTTzu5SpDfpVi8RY7b` — `5393f01`
- `dpl_4Fg7o6wzv2pLgTw6XEHquwaan2zu` — `396ee35`

**Find out why before merging.** Pull the build logs. A branch that has never
built is not a branch you want to discover problems in *after* it is on `main`
and auto-deploying to production. I did not investigate this — it is not my
change set and I did not want to guess at its cause.

---

## 3. A regression I caused, and why it matters to you

After my merge, someone added `api/analyze-full-safe.js` and re-routed
`/api/analyze-full` to it. I read it. It is a correct fix: it delegates to my
hardened handler and deletes one `null` field so the legacy dashboard renderer
shows N/A instead of crashing on `.toFixed(null)`.

**The crash was caused by my change.** I made `bidAskImbalance` null instead of a
fabricated number; the client assumed a number. I never rendered a page in a
browser during that work, so I didn't catch it.

This matters to you for two reasons:

1. **There may be more of these.** Any renderer that assumed a fabricated
   numeric where the field is now `null` will throw. Grep the client for
   `.toFixed(`, `.toLocaleString(`, and arithmetic on `marketData.*`,
   `volumeQuality`, `high24h`, `low24h`. Guard with `Number.isFinite`.
2. **The correct fix is a guard, not a fabricated value.** `analyze-full-safe.js`
   omits the key so the renderer degrades. Do **not** "fix" a crash by putting
   a plausible number back — that reverts the entire point of the change set.
   If you need a fallback, make it visibly absent, not plausibly present.

---

## 4. The merge: exactly what conflicts and how to resolve it

Test-merged `orig/main` ← the adaptive branch. Result: **3 conflicted files.**

### 4.1 `package.json` — trivial, union

Both sides add validation scripts. Keep **all six**:

```json
"validate:market-data":  "node scripts/validate-market-data.js",
"validate:decision-desk":"node scripts/validate-decision-desk.js",
"validate:macro-core":   "node scripts/validate-macro-core.js",
"validate:all":          "node scripts/validate-all.js",
"validate:adaptive":     "node scripts/validate-adaptive-risk.js",
"validate:wallet":       "node scripts/validate-wallet-reconstruction.js"
```

Then **add the two new suites to `scripts/validate-all.js`** so they actually
run. A suite nobody invokes is not coverage.

### 4.2 `vercel.json` — union, with one thing to drop

Keep from mine: `/api/review-trade`, and the clean page routes `/risk`,
`/bitcoin-value`, `/scanner`, `/strategy`, `/tracker`. (`/risk` and
`/bitcoin-value` returned **404 in production** before I added them — verified
live.)

Keep from theirs: `/api/wallet/portfolio`, `/api/wallet/trades`.

**Do not keep `"/api/trade-status/(.*)" → "/api/trade-status.js"`.** I removed
it because that file does not exist. I checked their branch: it does not exist
there either. Re-adding it restores a route to nothing.

Also preserve the current `main` routing of `/api/analyze-full` →
`/api/analyze-full-safe.js` (§3).

### 4.3 `public/risk.html` — **this is the dangerous one**

4 conflict hunks. Two of them are enormous and lopsided:

| Hunk | Lines from `main` (mine) | Lines from their branch |
|---|---|---|
| 1 (~1046) | ~49 | ~10 |
| 2 (~1112) | ~72 | ~6 |
| **3 (~1436)** | **~660** | ~20 |
| **4 (~2122)** | **~206** | ~4 |

Hunks 3 and 4 are ~870 lines of my code against ~24 of theirs. **"Accept
theirs" on those hunks deletes almost the entire hardened Risk Manager page and
leaves no marker that it happened.** That is the failure mode to plan around.

Their branch also introduces `public/js/riskPage.js` (2,220 lines) which
restructures the page around the adaptive engine, so a straight "keep mine"
doesn't work either. **This hunk needs deliberate reconciliation, not a
resolution strategy.**

What must survive from my side, whatever page structure you land on:

- `fMarginMode` and `fInstrument` controls (isolated/cross, perpetual/margin/spot)
- `liqCaveats` container + the `.rm-caveats` styles — the five liquidation
  caveats existed in the engine for weeks and never reached the page
- Cross-margin copy: `LIQUIDATION DEPENDS ON ACCOUNT / EXCHANGE MARGIN STATE`
  with **no price shown**
- `mergePolicy()` — deep-merge, because a shallow spread let a partial nested
  object replace a default wholesale and throw inside `planTrade`
- `recalculate()` / `recalculateInner()` error boundary — a throw used to leave
  stale numbers on screen beside new inputs, and Save persisted them
- Form clears after save — otherwise the saved trade is counted twice
  (open risk 250 → 500, margin 3600 → 7200, "2 positions" for one save)
- `Max Same-Direction Risk` label, and copy saying correlation is **assumed**,
  not measured

### 4.4 Auto-merged, verified coherent — leave alone

`public/js/riskStore.js`, `public/index.html`, `server.js`.
`public/js/riskManager.js` is untouched by their branch, so every engine
correctness fix survives intact.

---

## 5. Design decision you should know about before you trip on it

Provenance rides on candle arrays as a **non-enumerable property**
(`services/dataProvenance.js`).

Why: wrapping in `{ candles, provenance }` would have meant changing every
indexing, slicing and `Object.entries` call site in live trading paths, each one
a chance to break something. Non-enumerable keeps `Array.isArray`, `.length`,
iteration and `Object.entries` over a multi-timeframe bundle all unchanged.

**Cost, and it will bite you if you don't know:** it does **not** survive
`JSON.stringify` or a spread. If you need provenance in a response body, read it
with `getProvenance()` and place it explicitly. If you find provenance
"missing" after serialising, this is why.

---

## 6. Tripwires — run these after your merge

All offline. If any fails, the merge dropped something.

```bash
npm run validate:all
# Expect 4 PASS (304 assertions) + your 2 new suites, 1 SKIPPED (no network).
# The SKIPPED line is deliberate: a network suite that could not reach its
# providers verified NOTHING and must never be counted as a pass.

# No fabrication anywhere in production paths. Expect NO output.
grep -rn "Math\.random\|generateSyntheticData" services/ api/ lib/ server.js \
  | grep -v "^\S*:[0-9]*: *[/*]"

# Unknown symbols refused, not served Bitcoin. Expect UNSUPPORTED_SYMBOL.
node -e "import('./services/marketData.js').then(m=>m.getCandles('NOTREAL','4h',10))
  .then(()=>console.log('FAIL')).catch(e=>console.log('PASS -',e.code))"

# The risk.html fixes survived the merge. Every count must be > 0.
for m in fMarginMode fInstrument liqCaveats mergePolicy recalculateInner \
         "Max Same-Direction Risk"; do
  printf "%-28s %s\n" "$m" "$(grep -c "$m" public/risk.html)"
done

# Engine guards intact. Every count must be > 0.
for m in "notional-exposure" usedDefaultRisk "ACCOUNT / EXCHANGE MARGIN STATE"; do
  printf "%-34s %s\n" "$m" "$(grep -c "$m" public/js/riskManager.js)"
done

# Persistence validation intact.
grep -c "sanitizePolicy\|loadTradesWithRejects" public/js/riskStore.js
```

And because of §3 — **actually load `/risk` in a browser before pushing.** I
didn't, and that is precisely how the `.toFixed(null)` crash reached production.

---

## 7. Still open, and not yours to close in code

| # | Item | Status |
|---|---|---|
| **B-1** | Two live Solana private keys in git history and at HEAD (`scripts/transfer-funds.js:14,18`; a third in `docs/SOLANA_WALLET_SETUP.md:22`). One is described in-source as the *current trading wallet*. **The repo is public** — confirmed via Vercel deployment metadata (`githubRepoVisibility: "public"`). | **OPEN.** Operator must move funds, rotate, purge history. Do not force-push history on your own initiative. |
| **B-2** | `firestore.rules` / `storage.rules` committed but **not deployed**. Until `firebase deploy --only firestore:rules,storage` runs against `edittrades-fd451`, the live DB keeps whatever the console holds — which this repo's own `FIREBASE_SETUP_GUIDE.md:76-90` prescribes as `allow read, write: if true`. | **OPEN.** Operator action. |
| — | `CRYPTOPANIC_API_KEY` hardcoded fallback removed; the endpoint now fails loudly. The old key is in history and should be rotated. | Operator action. |

Trade execution is **default-disabled** by the deployed change set, which
reduces exposure from B-1 while it remains open. **Do not enable
`TRADING_ENABLED` as part of this integration.**

---

## 8. Known limitations I did not fix

Ranked. None blocks your merge; all are real, and #1 is worth knowing if you
touch the wallet/execution path.

1. **`/api/execute-trade` still trusts the client's `signal` object.** The
   shared secret authenticates the *caller*, not the signal. The proper fix is
   re-running the strategy server-side and executing only what the server
   computed. If your wallet work touches execution, this is the thing to close.
2. Rate ledger is in-memory, so per-lambda-instance on Vercel. Raises the cost
   of a drain attempt; does not bound it.
3. EMAs and stochastics still compute on the unclosed bar, so they repaint. The
   *dishonest* part is fixed — `brokeResistanceOnClose` returns `null` rather
   than `false` while the bar is forming, and `barClosed` / `lastBarClosed` are
   exposed — but the indicators themselves still include the in-progress bar.
4. The `CapMVRVCur` dependency has visibility now, but no mitigation. Production
   confirms `realizedCapDerivedRows: 5880/5880` — the MVRV derivation is the
   *only* working path, not a fallback.
5. `strategy_logic_export/` is a stale duplicate of `services/`, `api/`, `lib/`
   — **including a full copy of the deleted synthetic generator.** Vercel does
   not build it, but do not copy from it.
6. The *live* Economic Value validator still contains three tautological
   identity checks. They are superseded by `scripts/validate-macro-core.js`
   (mutation-tested, 67 assertions) but not deleted.

---

## 9. Where the detail lives

| Document | Contents |
|---|---|
| `docs/WORK_AUDIT_HANDOFF.md` | Full audit. Every claim tagged VERIFIED / INFERRED / NOT VERIFIED with the command that produced it |
| `docs/PR_REVIEW_production_desk.md` | The review packet for PR #2 — deliberate behaviour changes, changed test assertions, tripwires |
| `.claude/skills/pr/SKILL.md` | The `/pr` skill that produced that packet |

Three things in `WORK_AUDIT_HANDOFF.md` worth reading before you touch the risk
or macro layers: §3.6 (a deliberate strategy-behaviour change, stated loudly),
§5.2 (the notional cap the *previous* handoff wrongly claimed was fixed), and
§8 (three places that handoff was wrong about its own work).
