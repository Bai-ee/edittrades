# PR Review Packet — Production Decision Desk

**Branch:** `claude/edittrades-production-desk-k30mjg` → `main`
**Commits:** 8 · **Diff:** 39 files, ~+5,400 / −1,040
**Author:** implementing agent (Claude) · **Date:** 2026-08-23

---

## READ THIS FIRST

**This PR is safe to merge. It is NOT safe to treat as "production ready".**

Those are different claims and the distinction is the whole point of the change
set. The code removes several ways the system could present fabricated or
misattributed data as real. It does **not** clear two blockers that live outside
the diff and that only a human operator can close:

| # | Blocker | Why the diff cannot close it |
|---|---|---|
| **B-1** | Two live Solana private keys are in git history and present at HEAD (`scripts/transfer-funds.js:14,18`, plus one in `docs/SOLANA_WALLET_SETUP.md:22`). One is described in-source as the *current trading wallet*. | Purging requires rewriting shared history and force-pushing. That is an operator decision, and rotating the file without purging history achieves nothing. **Move the funds first.** |
| **B-2** | `firestore.rules` / `storage.rules` are **added by this PR but not deployed**. | Committing rules is not deploying them. Until `firebase deploy --only firestore:rules,storage` runs against `edittrades-fd451`, the live database keeps whatever the console holds — which this repo's own `FIREBASE_SETUP_GUIDE.md:76-90` prescribes as `allow read, write: if true`. |

**Merging improves the code. It does not make the deployment safe.** If you
approve, say so in terms of the diff, and leave B-1 and B-2 open.

---

## 1. What a reviewer is being asked to decide

Approve, request changes, or reject **the diff**. Specifically:

1. Is the removal of synthetic market data complete and correct?
2. Are the three deliberate behaviour changes (§4) acceptable?
3. Are the three test changes (§5) legitimate corrections rather than
   weakened tests?
4. Is the provenance mechanism (§6) an acceptable design tradeoff?

Everything else in the diff is either additive (new modules, new tests) or a
straightforward defect fix.

---

## 2. How to verify, in order

Each command is fast and offline unless marked.

```bash
git fetch origin && git checkout claude/edittrades-production-desk-k30mjg
npm install

# 1. Whole suite. Expect: 4 PASS (304 assertions), 1 SKIPPED (no network), exit 0.
npm run validate:all
```

Expected tail:

```
  PASS                   Market data integrity          (63 assertions)
  PASS                   Risk Manager                   (114 assertions)
  PASS                   Decision desk integration      (60 assertions)
  PASS                   Bitcoin macro core             (67 assertions)
  SKIPPED (no network)   Bitcoin Economic Value
```

**The SKIPPED line is deliberate and load-bearing.** A network suite that could
not reach its providers verified *nothing*. `scripts/validate-all.js` refuses to
count it as a pass. If you have network access, run it and report the result —
it has still never run green against live providers.

```bash
# 2. P0 tripwire. MUST throw. If it returns candles, reject the PR.
node -e "import('./services/marketData.js').then(m=>m.getCandles('BTCUSDT','4h',300))
  .then(c=>console.log('FAIL - returned',c.length,'candles'))
  .catch(e=>console.log('PASS -',e.code))"
# (Only meaningful without network access. With network it will legitimately
#  return real Kraken candles — check provenance instead, see #4.)

# 3. No fabrication left in production paths. Expect NO output.
grep -rn "Math\.random\|generateSyntheticData" services/ api/ lib/ server.js \
  | grep -v "^\S*:[0-9]*: *[/*]"

# 4. Provenance is present and honest (needs network).
node -e "import('./services/marketData.js').then(async m=>{
  const c = await m.getCandles('BTCUSDT','4h',300);
  const p = (await import('./services/dataProvenance.js')).getProvenance(c);
  console.log(p);
})"
# Expect: source is 'kraken' or 'bitfinex', synthetic:false,
# freshness one of LIVE/CACHED/STALE, a real ageSeconds.

# 5. Unknown symbols must be refused, not served Bitcoin.
node -e "import('./services/marketData.js').then(m=>m.getCandles('DEFINITELYNOTREAL','4h',10))
  .then(()=>console.log('FAIL - returned data'))
  .catch(e=>console.log('PASS -',e.code))"
# Expect: PASS - UNSUPPORTED_SYMBOL

# 6. B-1 tripwire. Currently returns ba21b3b. Must be empty after the purge.
git log --all -S'CWT1QGDPSS5jhgZuuZkYCVKD32AxzT6cnLxy38xQ7Ns9' --oneline

# 7. B-2 tripwire (needs network). 403 PERMISSION_DENIED = rules deployed.
#    Returning document data = still world-readable.
curl -s 'https://firestore.googleapis.com/v1/projects/edittrades-fd451/databases/(default)/documents/trades'
```

---

## 3. The defects this fixes

Each was found by an independent audit agent and then re-verified centrally.
Full detail and file:line references in `docs/WORK_AUDIT_HANDOFF.md`.

### Fabrication reaching live decisions

- `getCandles()` answered a failed Kraken call with a `Math.random()` walk,
  returned through the same path as real candles. Reproduced: 8 identical
  `/api/analyze-full` requests → **4 fully-specified tradeable signals at up to
  75% confidence**, all HTTP 200, `error: undefined`, `currentPrice` varying by
  $8,915.
- Because `getCurrentPrice` swallowed its own error and returned a hardcoded
  default, **`getCandles` could never throw** — so eight downstream error
  branches were unreachable. The system read as defensive while being
  structurally unable to report a problem.
- **Scope correction, stated plainly:** production prices ADA correctly at
  $0.22 today, so this path was **latent, not firing**. The reproduction above
  came from an egress-blocked sandbox — a faithful simulation of a Kraken
  outage. The honest claim is "one outage away from fabricated candles", not
  "was serving them".

### Silent asset substitution — arguably worse

`SYMBOL_MAP[symbol]?.kraken || 'XBTUSD'` at three sites returned **real Bitcoin
data under the requested symbol's name**. Internally consistent, so it passes
every sanity check a reviewer would apply. Two more instances: a shadowing
three-entry map in `api/analyze-full.js`, and `server.js:426` reading a
`SYMBOL_MAP` that **was never exported** — so every symbol, including BTCUSDT,
got Bitcoin's microstructure.

### Other fabrication removed

Fabricated 24h high/low (`price*1.02` / `price*0.98`); `priceChange` assigned a
percentage; `volumeQuality: 'MEDIUM'` — a fabricated **passing** grade — on a
ticker outage; a hardcoded `source: 'kraken'` that was the codebase's only
provenance field and a false one; CoinGecko returning one daily series for
*every* requested interval with invented ±1% wicks.

### Security

`/api/execute-trade` signed real mainnet swaps with **no authentication**. Its
only gate was `validateSignal(signal)`, whose first test is `signal.valid` — a
boolean the caller supplies. It validated attacker data against itself.
`MAX_TRADES_PER_HOUR` and `AUTO_EXECUTION_ENABLED` were documented and existed
in **zero lines of code**.

### Risk engine

The sizing arithmetic was **correct** and was independently re-derived. The
verdicts around it were not: the notional cap was computed but never evaluated,
so a 0.4% stop at 20× sized to **250% of wallet and reported WITHIN PLAN with
7/7 checks passed**. `riskPct` of `0`/`-1`/`NaN`/`"abc"` silently sized a real
position at the 1% default.

### Macro

Partial anchor dropout silently re-specified the composite: **−35% Economic
Value, premium +582% → +949%**, with every honesty affordance on the page still
green. `realizedCapSource` reported `"CapRealUSD (direct)"` in exactly the
scenario where the anchor had died entirely.

### AI

The model was handed a payload whose field names did not match the client's
(`currentPrice` vs `price`, `analysis` vs `signal.confluence`, `timeframes`
never copied) and then asked for "exact percentage from data". Inventing was the
only way to comply. Separately: client-supplied `systemPrompt` was passed
verbatim as the system message with CORS `*`; production had **no temperature
cap**; and trade grades were scraped from prose by substring, so *"Bullish
structure on BTC. Rating: A"* graded **B**, and an ungraded response defaulted to
a **passing** grade that was persisted to Firebase.

---

## 4. Deliberate behaviour changes — review these specifically

Three changes alter behaviour rather than fixing an unambiguous defect. Each is
called out because the brief for this work said not to change strategy
behaviour silently.

**4.1 — The 95%-confidence gate now requires a measured volume reading.**
`services/strategy.js`. The gate tested `volumeQuality !== 'LOW'`, which `null`
also satisfies. Removing the fabricated `'MEDIUM'` alone would have left the
gate passing unconditionally, exactly as before. Requiring a real measurement is
what makes it a filter. **Effect: fewer trades reach the 95% tier in AGGRESSIVE
mode when microstructure is unavailable.** Revert by restoring the old
condition; it is one boolean (`volumeMeasuredAcceptable`).

**4.2 — Miner-cost assumptions moved.** `overheadMultiplier` 1.25 → 1.40, and
the 2013 efficiency anchor 8,000 → 30,000 J/TH. Both move the headline premium.
Rationale: 1.25 implied energy at ~80% of cash cost where disclosures put it at
60–75%, and the bias was systematic in one direction (low overhead → low miner
cost → low EV → **high** reported premium). January 2013 was still
GPU/FPGA-dominated at 50,000–300,000 J/TH. **If you disagree with either number,
say so — they are judgement calls, and they are now documented as such in-code.**

**4.3 — Legacy Firestore `trades` collection is closed, not migrated.**
Everything written there was world-writable for its whole life, so importing it
would launder untrusted data into the record the Risk Manager reasons over.
Export from the console and re-import deliberately if it is worth keeping.

---

## 5. Test changes — are these corrections or weakening?

Three existing assertions were changed. **All three previously asserted the old,
incorrect behaviour.** Judge each:

| Test | Was | Now | Why |
|---|---|---|---|
| `zero risk falls back to policy default 1%` | asserted `riskPct: 0` → sizes at 1% | asserts `riskPct: 0` is **rejected** | The old test locked in a hazard: clearing a free-text field sized a real trade |
| `long liq at 5x ~= 57,960` | first-order approximation | `~= 57,889.45`, the exact solve | Old form was anti-conservative for shorts |
| `label reads CORRELATED LONG EXPOSURE` | asserted the word "CORRELATED" | asserts `DIRECTIONAL LONG CONCENTRATION` | The rule counts direction and never computes a correlation. BTC + gold + EUR all long produced "CORRELATED" |

Net assertion count went **96 → 114** on the risk harness (18 new regression
tests), plus 190 new assertions across three new suites. **No test was deleted
or loosened to get green.**

`scripts/validate-macro-core.js` was **mutation-tested**: seven deliberate
regressions were introduced into the calculation core and the suite caught all
seven. One of them (the convergence OR condition) was *not* caught on the first
attempt — the test's fixture had too wide a spread to trip the bug, making it a
tautology of exactly the kind it was written to replace. It was rewritten to
construct the real failing shape, and the mutation is now caught. That
iteration is recorded here because a test suite's value is entirely in whether
it can fail.

---

## 6. Design decision to challenge

Provenance rides on candle arrays as a **non-enumerable property**
(`services/dataProvenance.js`). The alternative — returning
`{ candles, provenance }` — would have required changing every indexing,
slicing and `Object.entries` call site in live trading paths, each one a chance
to break something.

**Cost:** it does not survive `JSON.stringify` or a spread. Anything needing
provenance in a response body must read it via `getProvenance()` and place it
there explicitly.

This is the design decision in the PR most worth pushing back on.

---

## 7. What is NOT verified

Do not approve on the assumption these were checked:

1. **No page was rendered in a browser.** All inline `<script>` blocks in
   `risk.html`, `index.html`, `bitcoin-value.html` and `tracker.html` were
   extracted and syntax-checked — all parse clean — which proves they load, not
   that they lay out. **Mobile layout is unverified.**
2. **Nothing in this PR is deployed.** Production runs `main` @ `06cf3e1`.
   Everything verified live was against pre-PR code.
3. **`validate:btc-value` has never run against live providers.** Egress was
   blocked (403 at the proxy gateway).
4. **The live Firestore rules.** B-2's severity rests on a repo doc and a code
   comment, not on reading the console.
5. **The AI's actual output** under the new contract. The payload fix is
   verified; model behaviour given it is inferred.
6. **Whether the exposed wallets hold funds**, and whether the repo is public.

---

## 8. Known limitations that survive this PR

Ranked. None blocks the merge; all are real.

1. `/api/execute-trade` still trusts the client's `signal` object. The secret
   authenticates the caller, not the signal. Proper fix: re-run the strategy
   server-side and execute only what the server computed.
2. The rate ledger is in-memory, so per-lambda-instance on Vercel. Raises the
   cost of a drain attempt; does not bound it.
3. The *live* Economic Value validator still contains three tautological
   identity checks (they compare a value against the formula that produced
   it). They are now superseded by `validate-macro-core.js`, which is
   mutation-tested, but they have not been deleted from the live harness.
4. The `CapMVRVCur` dependency has visibility now, but no mitigation. No free
   alternative realized-cap source exists.
5. Indicators still *compute* on the unclosed candle. The dishonest part is
   fixed — `brokeResistanceOnClose` now returns `null` rather than `false`
   while the bar is forming, and `barClosed` / `lastBarClosed` are exposed —
   but EMAs and stochastics are still calculated including the in-progress
   bar, so they repaint. Making the engine drop or flag the forming bar for
   every indicator is a larger change.
6. `strategy_logic_export/` is a stale duplicate of `services/`, `api/`, `lib/`
   — including a full copy of the deleted synthetic generator. Not built by
   Vercel, but it will drift.

---

## 9. Approval checklist

**Merge criteria — all must hold:**

- [ ] `npm run validate:all` exits 0 with 3 PASS and 1 SKIPPED
- [ ] The P0 tripwire (§2 #2) throws, or returns data with honest provenance (§2 #4)
- [ ] §2 #3 produces no output
- [ ] §2 #5 returns `UNSUPPORTED_SYMBOL`
- [ ] You have read §4 and accept all three behaviour changes
- [ ] You have read §5 and agree the test changes are corrections
- [ ] You accept the §6 tradeoff, or have requested the alternative

**Must NOT be treated as satisfied by merging:**

- [ ] B-1 — funds moved, keys rotated, history purged
- [ ] B-2 — `firebase deploy --only firestore:rules,storage` run and confirmed
- [ ] `/risk` and `/bitcoin-value` loaded on a real phone post-deploy
- [ ] `npm run validate:btc-value` run somewhere with network access

---

## 10. Post-merge deploy notes

New environment variables. **All default closed** — the deploy is safe with none
of them set, and trade execution stays disabled.

| Variable | Default | Effect |
|---|---|---|
| `TRADING_ENABLED` | unset = **off** | Must be exactly `'true'` to arm `/api/execute-trade` |
| `TRADE_EXECUTION_SECRET` | unset = **off** | Required; compared to `x-trading-secret` in constant time |
| `MAX_TRADES_PER_HOUR` | `3` | Per-window trade count cap |
| `MAX_NOTIONAL_PER_HOUR_USD` | `1000` | Cumulative notional cap |
| `TRADING_ALLOWED_ORIGIN` | unset | CORS origin for the execution endpoint; no longer `*` |
| `CRYPTOPANIC_API_KEY` | unset = **fails loudly** | The hardcoded fallback key was removed. **Rotate the old one — it is in git history.** |

`vercel.json` gains clean routes for `/risk` and `/bitcoin-value`, which
currently **404 in production** (verified live). It also drops a dead
`/api/trade-status` route (the file does not exist) and adds the missing
`/api/review-trade` route (the file exists and `tracker.html` calls it).

---

## 11. Verdict

Return one of:

- **APPROVE** — merge, with B-1 and B-2 left open and tracked separately
- **APPROVE WITH CHANGES** — list them
- **REJECT** — name the claim that failed verification and the command that showed it
