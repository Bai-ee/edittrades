# Adaptive Risk Manager — Handoff to the Deploying Agent

**From:** the implementing agent
**Branch:** `claude/edittrades-adaptive-risk-manager-fgz3im`
**Repo:** `Bai-ee/edittrades`
**Date:** 2026-08-23

---

## 0. Read this first — the one thing that will bite you

**Every deployment of this branch so far has FAILED on Vercel.** Both pushed
commits produced `state: ERROR` builds:

| Commit | Deployment | State |
|---|---|---|
| `5393f01` engine + wallet | `dpl_2DUPncpWVbJTTzu5SpDfpVi8RY7b` | **ERROR** |
| `396ee35` UI | `dpl_4Fg7o6wzv2pLgTw6XEHquwaan2zu` | **ERROR** |

**I did not diagnose why.** I identified the failures from the deployment list
and was about to pull build logs when the work was handed to you. Do not assume
the cause. Pull the logs before anything else:

```
get_deployment_build_logs(idOrUrl: "dpl_4Fg7o6wzv2pLgTw6XEHquwaan2zu",
                          teamId: "team_xmgNCNc6fHyZZinuszh8B6ZB",
                          errorsOnly: true)
```

Everything below is verified. This section is the exception — treat the build
failure as an open, undiagnosed problem.

**Do not merge to `main` until that build is green.** `main` is what deploys to
production.

---

## 1. Deployment facts

- Vercel project: **`snapshot_tradingview`** — `prj_odiA8buLOlo7mzCc5NQMDfBFdQ31`
- Team: `baiees-projects` — `team_xmgNCNc6fHyZZinuszh8B6ZB`
- GitHub-linked to `Bai-ee/edittrades`; **production auto-deploys from `main`**
- Production host: `snapshottradingview.vercel.app`
  (repo docs still advertise `edittrades.vercel.app` — stale, unfixed)

**`main` is currently also failing.** The most recent production-target builds on
`main` are `ERROR` (`dpl_DnYNzWv3nURUCgojJQGitAX8Yzjn`,
`dpl_8ZL7ontjkfXFwCnkkKanRWeo38P5`, `dpl_AZw2hVMvrW5famqZv5W86PEAyA6w`). The last
`READY` production deploy is `dpl_EAEfbwqgQqtrrc94JNyho54UEmAn` at commit
`496716dc`. So there is a pre-existing production breakage that is **not** mine —
do not assume merging my branch caused it, and do not assume merging my branch
will fix it. Separate the two before drawing conclusions.

Other sessions are active on this repo. Commits from `claude/edittrades-production-desk-k30mjg`
and direct hotfixes from the user landed on `main` while I was working. Rebase or
merge carefully.

---

## 2. Branch state at handoff

Two commits, both **pushed**:

```
396ee35  Build the Risk Manager page, home widget and level-based UX
5393f01  Add adaptive risk engine and read-only wallet reconstruction
```

A third commit carries Agent E's completed mobile QA and this document. See §6.

---

## 3. What was built

### Reused, not rebuilt
The repo already had a **tested manual position-sizing engine**. It was kept and
imported, not replaced:

- `public/js/riskManager.js` (1,015 lines) — `calculateStopDistance`,
  `calculatePositionSize`, `calculateRequiredMargin`, `estimateLiquidation`,
  `calculatePortfolioRisk`, `detectCorrelatedExposure`, `planTrade`,
  `DEFAULT_RISK_POLICY`. 96 assertions, all still passing.
- `services/riskManager.js` — thin server-side re-export.
- `api/parse-trade-image.js` — existing screenshot parser, reused for enrichment.
- `services/walletManager.js`, `jupiterSwap.js`, `dflow.js`, `tokenMapping.js`.
- `public/edittrax-styles.css` — design tokens and components.

### New: `public/js/adaptiveRisk.js` — the adaptive layer
Sits on top of `riskManager.js`. Lives in `public/js/` because there is **no build
step** and `vercel.json` serves only `public/**` to the browser.

- **Risk levels −2 → 5.** Driven by percentage performance, drawdown, trade count
  and consistency — never dollar milestones, so $2k / $20k / $200k wallets
  progress identically (asserted).
- **Slow up, fast down.** Level-up advances at most one level and requires a
  minimum trade count; per-trade contribution is winsorised so one outsized
  winner cannot leap levels. Demotion may drop more than one level at once.
- **Inactivity never demotes** — the earned level is kept and a conservatism
  haircut is applied instead.
- **`STRATEGY_PRESETS`** — STANDARD and AGGRESSIVE, each with a per-level
  envelope table. STANDARD is anchored to `DEFAULT_RISK_POLICY` at level 0 so the
  two engines agree. STANDARD's confidence slider tops out at 90, deliberately
  leaving the top decile of the envelope unreachable so the 2% ceiling stays a
  ceiling rather than a routine setting.
- **Recent performance is a one-way DOWNWARD adjustment.** A good run never
  raises risk directly — it earns levels, and levels widen the envelope. This is
  the mechanism that makes "slow up" structural rather than a tuning constant.
- **Confidence** applies only inside the resolved envelope. It can never raise
  risk above the envelope max, exceed the leverage cap, or clear a `NO_TRADE`.
- **`NO_TRADE`** is a first-class result. Every blocker carries
  `{ code, label, current, limit, remedy }`.
- **Open positions keep consuming risk until closed**, with a closure reserve so
  a beyond-breakeven stop does not recycle the full budget. Unrealized losses
  count in full; unrealized gains are discounted.
- **`evaluatePosition`** returns ADD / HOLD / REDUCE / EXIT / PROTECT_PROFIT, only
  when explicitly invoked.
- **`analyzeStrategyPerformance`** emits proposals only; it never mutates rules.
- Deterministic: `now` is a parameter, no `Math.random()`, no network, no LLM.

### New: wallet layer (read-only)
- `services/solanaWalletReader.js` — balances, holdings, USD value, signatures.
  **Address only. No seed phrase, private key or signing anywhere.**
- `services/jupiterReconstruction.js` — Jupiter swap reconstruction with **FIFO**
  lot matching; every trade carries `VERIFIED` / `PARTIAL` / `NEEDS_REVIEW` plus
  reasons. Deterministic ids so reconstruction is idempotent and user corrections
  re-attach. Overrides layer on top; on-chain stays authoritative underneath.
- `api/wallet-portfolio.js`, `api/wallet-trades.js` — routed in both `vercel.json`
  and `server.js`.
- Provider failure returns `complete: false` with a reason and a **null** total —
  never a fabricated balance.
- Transfers surface as **unclassified** candidate cash flows; only user-classified
  flows are excluded from performance.

### New: UI
- `public/risk.html` reworked; `public/js/riskPage.js` (new controller);
  `public/js/riskStore.js` extended (404 → 1,222 lines); home widget in
  `public/index.html`.
- **The UI computes nothing.** Every number comes from `adaptiveRisk.js`; the page
  formats and renders only.
- Persistence stays **local-first**. Account size is deliberately kept out of
  Firestore, whose rules are `allow read, write: if true`.

---

## 4. The two safety properties worth re-running

These are the point of the whole engine. From `npm run validate:adaptive`:

```
STANDARD, level 2, confidence 50 — risk % as losses accumulate:
1.200 → 1.020 → 0.770 → 0.605 → 0.421 → 0.337 → 0.281 → 0.098

-2R run decisions:
TRADE ×9, then NO_TRADE ×6
```

Risk contracts monotonically as history worsens and terminates in `NO_TRADE`.

```
improving history: 1.00 → 1.00 → 1.00 → 1.10 → 1.10
(levels, not results, widen the envelope)
```

Wins alone never widen risk. If a change makes either of these fail, the change
is wrong, not the test.

---

## 5. Validation — commands and results

```bash
npm run validate:adaptive   # 247 assertions   PASS
npm run validate:wallet     # 200 assertions   PASS (fixture-driven, zero network)
npm run validate:risk       #  96 assertions   PASS (pre-existing, no regression)
```

Also verified by hand before each commit:

- `node --check` on every new/changed JS file
- **No bare npm imports** in `public/js/*` — the browser ESM graph must resolve
  without a build step
- Server boots; `/risk.html` `200`, `/js/riskPage.js` `200`,
  `/js/adaptiveRisk.js` `200`, `/` `200`
- `GET /api/wallet/portfolio?address=invalid` returns
  `{"error":"Invalid Solana address","message":"Address must be base58 and decode to 32 bytes."}`
  — an honest rejection, not a fabricated 200

---

## 6. What is NOT done — do not represent these as finished

1. **The Vercel build fails.** Undiagnosed. §0.
2. ~~Mobile QA is incomplete.~~ **Mobile QA DID complete** — see `docs/MOBILE_QA.md`
   and §6a below. Verdict: usable on a phone, with one architectural caveat.
3. **Adversarial review returned nothing.** Agent F wrote probe scripts
   (`p01-loss-raises-risk`, `p02-deposits`, `p03-overrides`, `p04-confidence`,
   `p05-leverage`, `p06-level-climb`, `p07-float-thresholds`, `p08-coercion`,
   `p09-openrisk-stale-add`) but **never reported findings**. The engine has not
   passed an adversarial review. Re-run it.
4. **Wallet reconstruction has never touched live mainnet.** The suite prints this
   itself: `fixture-driven, zero network. Not validated against live mainnet.`
   Nothing here is evidence that it works against a real wallet.
5. **Jupiter perps status is unknown.** The reconstruction agent was told to report
   honestly whether perps decoding is achievable without an IDL or indexer. It
   never reported. Do not claim perps support.
6. **No agent returned a written report.** Agents A–F produced files; none
   delivered its findings. Everything in this doc is from my own inspection.
7. **`nothing-design` skill was unavailable** in the environment. Design
   constraints were briefed manually from the EditTrax tokens instead. That is a
   substitution, not the thing that was asked for.
8. **Simulation-mode sandboxing is asserted in the engine but not verified in the
   UI.**
9. **"I took this trade" → on-chain match linking** is built but never exercised
   against real wallet activity.

---

---

## 6a. Mobile QA — completed, and it found real defects

`docs/MOBILE_QA.md` (184 lines) is a measured pass: real Chromium, touch-enabled
mobile context, `page.touchscreen.tap()` and CDP touch drags — never `click()`,
never hover. 17 flows × 6 widths (320/375/390/430/768/1024). 72 screenshots.

**Verdict: yes, genuinely usable on a phone.**

Already correct before the pass, asserted rather than assumed: zero horizontal
overflow in every flow at every width; zero iOS-zoom violations; the
recommendation measures **35.2px at 320px** against 14px body type; the level rail
fits in 254px inside a 320px viewport with no scroller; long wallet addresses
truncate to `7xKXtg…osgAsU`.

The problem was **touch ergonomics, not layout** — 7 defects, each measured before
and after:

| | Defect | Before → After |
|---|---|---|
| D1 | `.rm-mini-btn` — classifies deposits, drives the sandbox, closes sheets | 34.5px → **44px** |
| D2 | `.rm-details summary` — the only route to the cash-flow queue | 34px → **44px** |
| D3 | `tr.rm-history-row` — the tap target that opens a trade record | 38.2px → **44.6px** |
| D4 | `NEEDS REVIEW` clipped to `NEEDS REVIE` at 320px, no ellipsis | clipped → **wraps, 0 clipped** |
| D5 | Screenshot file input | 21.5px → **52px** |
| D6 | Chart level-marker hit circle at 320px | 41.2px → **44.9px** |
| D7 | Confidence slider — `box-sizing: border-box` made the 4px height *absorb* the 20px padding instead of adding to it | 40px → **44px** |

**1,380 tap-target violations across the run → 0.**

D4 is the one to note: the truncated string was the flag that says *this record
cannot be trusted*. A data-confidence warning silently cut off is exactly the
failure mode the brief asked to rule out.

The agent also **retracted two of its own findings** — "strategy toggle doesn't
respond to touch" and "slider can't be dragged" were harness artifacts (it tapped
stale coordinates after an async re-render), not product defects. Worth trusting
the report more for that, not less.

**Carry-forward caveat, unfixed and architectural:** the run measured a *shimmed*
Tailwind because the sandbox cannot reach the CDN. `risk.html` depends on a
third-party CDN for its page measure (`max-w-6xl mx-auto px-4`) and primary button
padding — **if that CDN is blocked or slow on a phone network, the page has no
layout at all.** That is outside what a QA pass could fix. A real-device pass on
hardware is still worth doing.

---

## 7. Pre-existing repo issues — not introduced here, not fixed here

- **Firestore rules are `allow read, write: if true`** — world-readable and
  world-writable. This is why wallet balances were kept local-first.
- **`marketData.getCandles()` falls back to `generateSyntheticData()`** — a random
  walk. Any consumer can silently receive fabricated candles. The risk engine was
  routed around it.
- Earlier handoff notes two open blockers: **private keys in git history** and
  **Firestore rules committed but not deployed**.

---

## 8. Recommended order for you

1. Pull the build logs; fix the build. Nothing else matters until it is green.
2. Determine whether `main`'s failure is independent of this branch.
3. Re-run the three suites (§5).
4. Run the adversarial review properly — it is the largest remaining gap.
5. Consider the Tailwind-CDN dependency in §6a before shipping to phones.
6. Only then merge to `main`.

**Production readiness: NO-GO** — on the build, not on the product.

What is genuinely solid: the engine's determinism and its two core safety
properties (§4), 543 passing assertions across three suites, and a measured
mobile pass that found and fixed 7 real touch defects.

What blocks GO: **the Vercel build fails and has not been diagnosed.** Beyond
that, the adversarial financial review never returned findings, and wallet
reconstruction has never run against a real wallet — so "the wallet is the source
of truth" is designed and unit-tested but not demonstrated. Do not claim
Jupiter perps support at all.
