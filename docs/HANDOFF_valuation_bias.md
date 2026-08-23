# Handoff — Valuation Bias readout + verdict leading

**For:** the agent taking over delivery of this change to production.
**From:** the agent that wrote it.
**Date:** 2026-08-23

Claims below are tagged **VERIFIED** (a command produced it — the command is
given), **INFERRED** (reasoned from evidence, not directly observed) or
**NOT VERIFIED** (could not be checked from this environment). Do not upgrade a
tag without running the check yourself.

---

## 1. Status in one paragraph

The work is **written, tested and already merged into `main`** at commit
`ccd80a6`. It is **not live.** Production deploys have been failing since
before this change landed, for a reason unrelated to it: the project is on the
Vercel **Hobby** plan, which caps a deployment at 12 Serverless Functions, and
`api/` now holds 13 `.js` files. Every production deploy since that 13th file
appeared has ERRORed at the `patchBuild` step. **Nothing about this change set
needs fixing. The function count does.** Section 4 is the blocker; sections 5–7
are the change itself.

---

## 2. Where the code is

| | |
|---|---|
| Feature branch | `claude/bitcoin-economic-value-jmpsbf` |
| Substantive commit | `a97bebc` — *Add directional Valuation Bias to the verdict; unify its leading* |
| Merged to `main` at | `ccd80a6` |
| `origin/main` == local `main` | **VERIFIED** — `git rev-list --left-right --count HEAD...origin/main` → `0  0` |
| Files touched | `public/bitcoin-value.html` (+145/−8), `public/edittrax-styles.css` (+5) |

Commits `e583e5f` and `f4c64e4` on the feature branch are merges of `origin/main`
taken while other agents were pushing concurrently. They carry no work of mine.

**There is nothing to push.** `main` already contains the change. The task is to
make `main` deploy.

---

## 3. What is actually serving right now

**VERIFIED** via the Vercel MCP `list_deployments` on
`prj_odiA8buLOlo7mzCc5NQMDfBFdQ31`:

- Last **READY** production deployment: `dpl_EAEfbwqgQqtrrc94JNyho54UEmAn`,
  commit `496716d`.
- Production is therefore serving `496716d`, which does **not** contain this
  work.

**VERIFIED** by direct grep of the two trees:

```
git show 496716d:public/bitcoin-value.html | grep -c BIAS_BY_STATE   # -> 0
git show ccd80a6:public/bitcoin-value.html | grep -c BIAS_BY_STATE   # -> 2
```

---

## 4. THE BLOCKER — production deploys are failing

### 4.1 The error, verbatim

**VERIFIED.** Vercel MCP `get_deployment` on `dpl_DnYNzWv3nURUCgojJQGitAX8Yzjn`
(the production deploy of my merge commit `ccd80a6`) returns:

```
errorCode:    exceeded_serverless_functions_per_deployment
errorMessage: No more than 12 Serverless Functions can be added to a
              Deployment on the Hobby plan. Create a team (Pro plan)
              to deploy more.
errorStep:    patchBuild
errorLink:    https://vercel.link/function-count-limit
```

The build itself **succeeds** — build logs end with `Build Completed in
/vercel/output [4s]` followed by `Deploying outputs…`. The failure is at
deploy, not compile. Do not go looking for a syntax error; there isn't one.

### 4.2 This predates my merge

**VERIFIED** from the deployment list. Production deploys in order:

| Commit | Author | Production state |
|---|---|---|
| `496716d` | other agent | **READY** ← currently live |
| `bb0feae` Hotfix nullable bid/ask imbalance dashboard crash | other agent | ERROR |
| `acb693c` Route analyze-full through nullable market data hotfix | other agent | ERROR |
| `ccd80a6` (merge carrying my work) | me | ERROR |

Two production deploys had already failed with the same error before my merge
existed. My own feature-branch preview deploys `a97bebc` and `e583e5f` both
built **READY** — so the change set itself deploys fine.

### 4.3 Cause

**VERIFIED** — `ls api/*.js | wc -l` → **13**:

```
agent-review          analyze-compact       analyze-full-safe
analyze-full          analyze               bitcoin-economic-value
crypto-news           execute-trade         health
indicators            parse-trade-image     review-trade
scan
```

`vercel.json` builds `api/**/*.js` with `@vercel/node`, so **every** file in
`api/` becomes a function whether or not a route points at it.

**VERIFIED** — every READY deployment in the list reports
`lambdaRuntimeStats: {"nodejs":12}`, i.e. the project was sitting exactly at the
cap. `api/analyze-full-safe.js` (added by `bb0feae`) is the 13th.

### 4.4 Relevant wiring before you choose a fix

**VERIFIED** by grep:

- `api/analyze-full-safe.js` is referenced in exactly one place — the
  `vercel.json` route `"/api/analyze-full" → "/api/analyze-full-safe.js"`.
- `api/analyze-full.js` now has **no route of its own**. It is still built as a
  function, and is still imported by the safe wrapper (`import analyzeFull from
  './analyze-full.js'`), so it cannot simply be deleted.
- `server.js` serves `/api/analyze-full` from its own Express handler and does
  **not** go through the wrapper. **INFERRED consequence:** the wrapper's
  behaviour is exercised only on Vercel, never in local dev — so local testing
  will not tell you whether it works.

The wrapper's whole job is 8 lines: intercept `res.json`, and if
`marketData.bidAskImbalance === null`, delete that key before sending, so the
legacy dashboard renderer shows `N/A` instead of calling `.toFixed()` on null.

### 4.5 Options

I did **not** apply any of these — the wrapper is another agent's work and the
plan choice is the owner's. Ranked by my judgement:

1. **Fold the wrapper into `api/analyze-full.js` and delete
   `api/analyze-full-safe.js`** (back to 12 functions). Preserves the other
   agent's intent exactly, no plan change, smallest diff. Restore the
   `vercel.json` route to point at `analyze-full.js`.
2. **Fix the renderer instead.** The wrapper's own comment says it exists only
   until the dashboard uses `Number.isFinite` guards. Doing that lets both the
   wrapper and the route override go away. Larger diff, better end state.
3. **Upgrade to Vercel Pro.** Owner's call, costs money, fixes it without code.

Whichever you pick: **the deploy failure is the only thing standing between
`main` and production.** No code in this change set needs to change.

---

## 5. What the change does

The `Premium to Value` figure told the reader how far price sits from Economic
Value but not what that distance means, so `+30%` read as alarming when it is an
ordinary reading for this composite. A **Valuation Bias** readout now sits
between the percentage and the state pill.

| Engine state | Bias label | Tone |
|---|---|---|
| DEEP DISCOUNT | Supports Long | long (green) |
| DISCOUNT | Supports Long | long |
| NEAR VALUE | Neutral | neutral (cream) |
| **PREMIUM** | **Neutral** | neutral |
| EXTENDED | Supports Short | short (red) |
| EUPHORIC | Supports Short | short |
| UNCALIBRATED / UNAVAILABLE | `—` | neutral |

### Three decisions worth understanding before you change anything

**PREMIUM maps to Neutral on purpose.** Economic Value is built from cost-basis
anchors, so price normally sits well above it; the historical median premium is
roughly +65%. Colouring an ordinary premium bearish would make the page lean
short through most of a typical year. Only readings past the historical extremes
take a side. If someone "fixes" this to red, they have broken it.

**The bias has no thresholds of its own.** It reads off `current.state`, which
the engine already derives from the percentile calibration in
`ECONOMIC_VALUE_CONFIG.valuationStates` (8-year lookback). A second threshold set
would be a second thing to keep in sync, and would drift.

**Colour comes from the engine, not the map.** `renderBias` sets the class from
`current.stateTone || bias.tone`. The engine emits `stateTone` alongside `state`,
so the pill and the bias physically cannot disagree; `BIAS_BY_STATE` supplies
only wording. The map still carries a `tone` per entry as a fallback, and a test
(§6.1) asserts the two agree.

Every caption ends `· not a timing signal`. This is a statement about valuation
against history, not about whether a trade will work — valuation stays stretched
for long stretches. That wording was deliberate; the original brief warned that
a premium is not automatically bad and a discount is not automatically a trade
signal, and this readout is scoped to stay on the valuation side of that line.

### Leading

The user's complaint was that spacing in this block was inconsistent. The actual
cause, once measured: `.eco-label` and `.eco-state` had **no `line-height`**, so
they used the browser default. Mathias reports ~1.0 and the fallback stack ~1.2,
so the block visibly reflowed as the webfont swapped in.

Fixed by pinning one scale:

- `.eco-label` → `line-height: 1.1` (in `edittrax-styles.css`, shared token)
- `.eco-state`, `.eco-bias` → `1.1`
- `.eco-caption` → `1.5` (multi-line prose needs more)
- rhythm: label→figure `0.35rem`, figure→caption `0.5rem`, group→group `1.5rem`

The ad-hoc inline margins (`0.4rem`, `0.35rem`, `0.1rem`) that produced the
unevenness are gone. `.eco-figure-deviation` is a flex column at **both** widths
so one `gap` governs the group spacing rather than collapsing margins at one size
and a flex gap at the other.

`.eco-label` is a shared design-system token — this change touches `index.html`
and `risk.html` too. §6.3 covers that.

### One incidental fix

`particlesJS(...)` was called unguarded at the top of the same `<script>` block
that later defines the chart and the whole valuation render. The script comes
from a CDN; when that request fails, the `ReferenceError` **killed the entire
rest of the block** — no chart, no figures, nothing. I hit this locally and
guarded it with `if (typeof particlesJS === 'function')`.

**`public/index.html` and `public/risk.html` have the same latent bug and I left
them alone** — other agents were editing those files concurrently and it was
outside what I was asked to do. It is the same one-line guard if you want it.

---

## 6. How to verify

### 6.1 Every engine state maps to a bias, and tones agree

This is the tripwire. It parses the state labels straight out of the engine and
the map straight out of the page, so a renamed band fails it. **If this fails,
the page will silently render an em-dash where a bias should be.**

```bash
node -e "
const fs = require('fs');
const engine = fs.readFileSync('services/bitcoinEconomicValue.js','utf8');
const html   = fs.readFileSync('public/bitcoin-value.html','utf8');
const states = new Set();
for (const m of engine.matchAll(/state:\s*'([A-Z ]+)'/g)) states.add(m[1]);
const pairs = {};
for (const m of engine.matchAll(/state:\s*'([A-Z ]+)',\s*tone:\s*'(\w+)'/g)) pairs[m[1]] = m[2];
const block = html.match(/const BIAS_BY_STATE = \{[\s\S]*?\n\s*\};/);
if (!block) { console.log('FAIL: BIAS_BY_STATE missing'); process.exit(1); }
const mapped = {};
for (const m of block[0].matchAll(/(?:'([A-Z ]+)'|([A-Z]+)):\s*\{\s*label:\s*'([^']+)',\s*tone:\s*'(\w+)'/g))
  mapped[(m[1]||m[2])] = { label: m[3], tone: m[4] };
const HANDLED = new Set(['UNAVAILABLE','UNCALIBRATED']);
let ok = true;
for (const s of [...states].sort()) {
  if (HANDLED.has(s)) { console.log('skip-by-design  '+s); continue; }
  if (!mapped[s]) { console.log('MISSING         '+s); ok=false; continue; }
  if (pairs[s] !== mapped[s].tone) { console.log('TONE MISMATCH   '+s); ok=false; }
  else console.log('ok  '+s.padEnd(14)+' tone='+mapped[s].tone);
}
for (const k of Object.keys(mapped)) if (!states.has(k)) { console.log('ORPHAN IN UI '+k); ok=false; }
console.log(ok?'RESULT: coverage intact':'RESULT: FAILED');
process.exit(ok?0:1);
"
```

Expected: six `ok` lines, two `skip-by-design`, `RESULT: coverage intact`,
exit 0. **VERIFIED** — this is the output I got on `ccd80a6`.

### 6.2 Offline suites

```bash
npm run validate:all
```

**VERIFIED** on the merged tree: `Market data integrity`, `Risk Manager`,
`Decision desk integration` and `Bitcoin macro core` all **PASS**.
`Bitcoin Economic Value` reports **SKIPPED (no network)** — see §7.

### 6.3 Browser

Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Serve with
`node server.js` (port 3000). **VERIFIED** at 390px and 1280px on `ccd80a6`:

- All nine `renderBias` cases render correctly, including a deliberate
  engine-vs-map tone-conflict case where the engine tone wins.
- Computed leading in the verdict block: `1.1` for label / bias / state, `1.5`
  for captions, `1` for the big tabular figure. No element left on `normal`.
- Group gaps `24px` at **both** widths.
- `scrollWidth - clientWidth === 0` on `index.html`, `risk.html` and
  `bitcoin-value.html` at both widths — no horizontal overflow anywhere.
  This is the check that covers the shared `.eco-label` change.

---

## 7. What I could NOT verify

State these as open, not as passing.

1. **The live data path.** This sandbox's egress proxy returns 405 for Coin
   Metrics, Bitfinex and Kraken, and blocks `snapshottradingview.vercel.app`
   outright. `validate:btc-value` therefore verified **nothing**, and every
   browser check ran against an em-dash payload with `renderBias` driven
   directly. **The bias has never been observed rendering from real API data.**
   Re-run §6.1–6.3 from a networked environment before calling it confirmed.
2. **The `+65% median premium` figure** behind the PREMIUM→Neutral decision comes
   from earlier analysis in my session against the Coin Metrics community
   dataset. It is not re-derived by any committed test. Treat as **INFERRED**.
3. **Interaction with `current.degraded`.** Another agent added a banner warning
   that a composite running on fewer anchors is a different model. The bias reads
   the same `state` as the pill, so it inherits that caveat and behaves
   consistently with the pill — but I did not design a separate degraded
   treatment for it, and did not test the two together. Worth a look.
4. **Anything about the other agents' concurrent changes** beyond confirming my
   merges were clean and §6.1–6.3 still pass afterwards.

---

## 8. Suggested order of work

1. Resolve the function count (§4.5). Nothing else matters until deploys succeed.
2. Push / redeploy `main`. The code is already there — no cherry-pick needed.
3. Once a production deploy reaches READY, load `/bitcoin-value` and confirm the
   Valuation Bias line renders from real data — the one thing I could not check.
4. Optionally extend the `particlesJS` guard to `index.html` and `risk.html`.
