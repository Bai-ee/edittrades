# Risk Manager — Mobile / Responsive QA

Measured QA pass over the complete Risk Manager (`/risk.html`) and the home
page Risk widget (`/`), driven by a real Chromium in a touch-enabled mobile
context. Mobile is treated as a primary environment here, not a breakpoint
patch: every flow below was exercised **by touch**, and every defect was
found by a programmatic assertion rather than by looking at a screenshot.

| | |
|---|---|
| **Surfaces** | `public/risk.html`, `public/index.html` (risk widget), `public/edittrax-styles.css`, `public/js/riskPage.js` |
| **Widths** | 320, 375, 390, 430 (phones) · 768, 1024 (tablets) |
| **Context** | `isMobile: true`, `hasTouch: true`, `deviceScaleFactor: 3`, iOS Safari UA |
| **Interaction** | `page.touchscreen.tap()` and CDP touch drags — never `click()`, never hover |
| **Result** | **0 failing geometry probes at all six widths** after the fixes below |

---

## 1. How to reproduce

The harness lives in the session scratchpad (it is tooling, not shipped code):

```
/tmp/claude-0/-home-user-edittrades/3b376cb0-1aa1-5222-a080-660effb66e51/scratchpad/mobile/
  run.mjs        # driver: launches Chromium, walks all 17 flows at every width
  measure.mjs    # the probes — overflow, tap targets, iOS zoom, clipping, sticky, rail
  fixtures.mjs   # deterministic wallet / trades / cash-flow / equity-curve fixtures
  report.json    # every probe result from the last run
  shots/         # 72 screenshots, 12 per width
```

```bash
node server.js &                       # port 3000
cd <scratchpad>/mobile
NODE_PATH=<scratchpad>/node_modules node run.mjs --shots
NODE_PATH=<scratchpad>/node_modules node run.mjs --width 320   # one width
```

Chromium comes from `/opt/pw-browsers/chromium` via `playwright-core`;
`playwright install` is never run.

### Two things the harness has to fake, and why

1. **Tailwind.** `risk.html` loads `cdn.tailwindcss.com`, which is unreachable
   from the sandbox but *is* present on a real device, where it sets the page
   measure (`max-w-6xl mx-auto px-4`) and every primary button's padding.
   Measuring without it would report a layout no user will ever see, so the
   run fulfils the CDN request with a shim containing Tailwind's preflight
   subset plus the exact utilities this page uses, injected into a `<style>`
   appended to `<head>` — the same cascade position the real script uses.
2. **Wallet data.** `/api/wallet/portfolio` and `/api/wallet/trades` are
   fulfilled from fixtures shaped exactly like
   `services/jupiterReconstruction.js` output (12 trades incl. 2 open, a
   `NEEDS_REVIEW` record, a `PARTIAL` record, a 20-character asset symbol, 2
   unclassified cash flows). 18 equity snapshots and 2 level transitions are
   seeded into `localStorage` so the equity curve actually draws — it refuses
   to plot from a single point, and without them the chart's tap-inspection
   flow has nothing to test.

---

## 2. Flows exercised, by touch, at every phone width

All seventeen pass at 320 / 375 / 390 / 430 / 768 / 1024.

| # | Flow | Verified by |
|---|---|---|
| 1 | Risk page load and first paint | cold-load probe sweep, no page errors |
| 2 | Home page Risk widget | populated state, rail fits, tap opens `/risk.html` |
| 3 | Wallet connect (read-only address) | typed + tapped `Watch wallet`, `#walletConnected` visible |
| 4 | Strategy toggle STANDARD / AGGRESSIVE | tap flips `aria-pressed` both ways |
| 5 | Confidence slider | CDP touch **drag** moves 50 → 86-90 and updates the readout |
| 6 | Asset / entry / stop inputs | tapped and filled, all ≥ 16px |
| 7 | GET RECOMMENDATION | `TRADE $7,341 @ 1×` rendered, dominant at every width |
| 8 | NO TRADE + explanation | reached via sandbox drawdown; blocker + NOW/LIMIT shown |
| 9 | Decision factor pills | 15 pills, 0 overflowing, 0 clipped |
| 10 | Level rail (-2..5) + progress bar | 8 nodes fit at 320 with no scroller |
| 11 | Equity chart — **tap** inspection | tapping a level marker opens the transition detail on-screen |
| 12 | Open positions → EVALUATE | row select by tap, `HOLD` evaluation renders |
| 13 | Trade history table | 12 rows, 4 columns on phones, no page overflow |
| 14 | Trade detail / edit sheet | opens by tap, scrolls internally, closes by tap, body locked |
| 15 | Screenshot upload | file accepted, parse result rendered |
| 16 | Deposit / withdrawal classification | disclosure opens, all three classify buttons tappable |
| 17 | Simulation mode | banner, sandbox trades, reset, toggle off |

---

## 3. Findings

### 3.1 What was already correct

These were asserted, not assumed, and passed everywhere with no change:

| Check | Evidence |
|---|---|
| **Horizontal overflow** | `documentElement.scrollWidth === innerWidth` at all 6 widths, in all 17 flows, including sheet-open and simulation-open states. **Zero offenders.** |
| **iOS input zoom** | 0 violations. Every `input`/`select`/`textarea` computes ≥ 16px (17px on phones via the `max-width: 720px` block). |
| **Sticky/fixed occlusion** | 0 hits against the recommendation, blocker, warnings, notice or `I took this trade`. |
| **Recommendation dominance** | `#recHeadline` at 320px = **35.2px** against 14px body type — 2.5x body, the largest type on the page. 41.3 / 42.9 / 47.3 / 56 / 56px at the other widths. |
| **Level rail at 320px** | 8 nodes, rail width 254px inside a 320px viewport, `scrolls: false`, no node clipped. |
| **Long wallet address** | Truncated to `7xKXtg…osgAsU` with `text-overflow: ellipsis`; never overflows the viewport. |
| **Chart tooltips on-screen** | Transition detail renders fully inside the viewport at every width (`offscreen: false`). |
| **Warnings never hidden** | Blocker, warnings and critical figures visible with real height in every state measured. |

### 3.2 Defects found and fixed

Every row was measured before, fixed, and re-measured after.

| # | Width | Flow | Defect | Before | Fix | After |
|---|---|---|---|---|---|---|
| **D1** | all | 3, 16, 17, 11, 14 | `.rm-mini-btn` below the 44px tap floor. Not decorative: these classify a deposit (`Deposit` / `Withdrawal` / `Not a transfer`), drive the sandbox (`Add +1R win` / `Add −1R loss` / `Reset`), and close the trade sheet and the transition detail. | **34.5px** tall (10 distinct buttons) | `min-height: 34px` → `44px` in `.rm-mini-btn` (`risk.html`) | **44px** |
| **D2** | all | 16, reference | `.rm-details summary` below the tap floor. The `Unclassified transfers` disclosure is the **only** route to the deposit/withdrawal classification queue. | **34px** tall (5 disclosures) | `min-height: 34px` → `44px` in `.rm-details summary` | **44px** |
| **D3** | all | 13, 14 | `tr.rm-history-row` below the tap floor — this row is the tap target that opens the trade record. | **38.2px** (phones), **36.6px** (tablets) | `.rm-history .table-edittrax td` padding `0.55rem` → `0.8rem`; mobile override `0.6rem` → `0.8rem` | **44.6px** at every width |
| **D4** | 320 | 13 | `td.rm-col-data` clipped the data-quality flag. The cell's own `overflow: hidden` cut `NEEDS REVIEW` — the flag that says *this record cannot be trusted* — to `NEEDS REVIE`, with no ellipsis to signal the truncation. | `scrollWidth 83` vs `clientWidth 69` | `.rm-history .rm-data-flag { white-space: normal }` inside the existing `max-width: 720px` block, so it wraps to two readable lines | **0 clipped elements** |
| **D5** | all | 15 | `input#sheetScreenshot` was the smallest target on the page — a bare file input on the control whose whole job is "photograph your fill and drop it in here". | **21.5px** tall | `.rm-file` → block, full width, `min-height: 44px`; `::file-selector-button` given a 44px floor and `.rm-mini-btn`'s appearance | **52px** |
| **D6** | 320 | 11 | Equity-chart level marker hit circle under 44px. At 320 the SVG is drawn at ~0.94x its viewBox, so the `r="22"` hit circle shrank below the floor. | **41.2 x 41.2px** | `r="22"` → `r="24"` in `renderChart()` (`riskPage.js`) — display geometry only, no calculation touched | **44.9px** at 320, 48px elsewhere |
| **D7** | all | 5 | Confidence slider hit box under 44px. The author's intent (`height: 4px` + `padding: 20px 0`) was correct but defeated by the page-wide `box-sizing: border-box`, which made the 4px height *absorb* the padding instead of adding to it. | **40px** tall | `box-sizing: content-box` on `.rm-slider` | **44px** |

**Aggregate: 1380 tap-target violations across the run → 0.**

### 3.3 Two things I initially recorded as defects and retracted

Reported here because the first run's log says otherwise and the correction matters:

- **"Strategy toggle does not respond to touch"** and **"confidence slider cannot be dragged by touch"** were **harness artifacts, not product defects**. The harness measured an element's box, then tapped those coordinates after an async data layer had re-rendered the page and shifted it. Adding a settle step (poll the box until it stops moving, then tap) made both pass at all six widths. The bindings are plain `click` handlers, which touch synthesises correctly.
- **"Tapping a chart marker does nothing"** was also mis-aimed. The marker `<g>` contains a full-height 1px dashed guide line, so the group's bounding-box centre sits on a *gap between dashes*, ~70px from the dot. Aiming at the dot — where a user aims — opens the detail. Worth knowing when writing future tests against this chart.

---

## 4. Changes made

Additive, inside the EditTrax design system, reusing the existing
`@media (max-width: 720px)` block rather than introducing a parallel one. No
token values changed. No calculation touched.

- `public/risk.html` — D1, D2, D3, D4, D5, D7 (all CSS, plus one comment on
  `.rm-marker-hit` recording why `r` is 24).
- `public/js/riskPage.js` — D6, one character: the hit circle's radius.

Untouched, as required: `public/js/adaptiveRisk.js`, `public/js/riskManager.js`,
`services/*`, `api/*`, `server.js`, `vercel.json`, `scripts/*`.
`public/index.html` and `public/edittrax-styles.css` needed no mobile fix —
the home widget and the shared table/button/header rules measured clean.

---

## 5. Screenshots

72 PNGs, 12 per width, at `<scratchpad>/mobile/shots/`:

```
{iphone-se-320, iphone-8-375, iphone-14-390, iphone-pro-max-430,
 tablet-768, tablet-1024}-{01-cold, 02-home-widget, 03-wallet,
 07-recommendation, 08-no-trade, 11-chart, 12-evaluate, 13-history,
 14-sheet, 16-cashflow, 17-simulation, full}.png
```

`-full` is the full-page capture at that width.

---

## 6. Verdict

**Yes — the complete Risk Manager is genuinely usable on a phone.**

Stated plainly, with the caveats that belong to it:

- The layout was already sound before this pass. Zero horizontal overflow and
  zero iOS zoom triggers across 17 flows at 6 widths is not a common starting
  point, and the level rail, the recommendation type scale and the bottom-sheet
  pattern were all built for a phone rather than retrofitted to one.
- What was wrong was **touch ergonomics, not layout**: ten button classes, five
  disclosures, every history row, the file picker, the chart markers and the
  confidence slider all sat between 21px and 41px where a finger needs 44px.
  On a 320px screen those are the controls that classify a transfer, open a
  trade record and set confidence — the ones that are hard to hit are exactly
  the ones a user needs. That is now fixed and re-measured at 0 violations.
- The one caveat worth carrying forward: this run measured a **shimmed**
  Tailwind, because the sandbox cannot reach the CDN. The shim reproduces the
  utilities this page uses, but a real-device pass on hardware would still be
  worth doing before calling it done, and a page whose measure and button
  padding depend on a third-party CDN will simply have no layout at all if
  that CDN is blocked or slow on a phone network. That is an architectural
  risk this QA pass could not fix from inside its own scope.
