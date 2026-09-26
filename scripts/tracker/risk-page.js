/**
 * EditTrades call tracker - "Risk & sizing" page (risk.html), T-14.
 *
 * Plain-language explainer of how a trade's size and leverage get decided: the venue
 * (Jupiter), the hard env caps, and the wallet-aware risk policy on top of them
 * (lib/execution/riskPolicy.js, lib/riskEngine.js, docs/PLAN_TELEGRAM_EXECUTION.md). Laid
 * out in the same bento system as how-to.html (./bento.js, ./page-style.js). Every number
 * below is cited to its source file next to where it's used - update both together when a
 * cap, default or formula changes. No data, no scripts, no live reads: this is reference
 * copy, not a dashboard.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav, sub } from './bento.js';

const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const usd = (v) => (isNum(v) ? `$${v.toFixed(2)}` : dash);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- layer 1: the venue (Jupiter perps) ----------
// config/engine.json risk block: maxLeverage 100, feeBps 5, slippageBps 5,
// costBpsByDirection {long:34, short:14}, liquidationBufferPct 0.05, maintenanceMarginPct 0.3.
const VENUE_FACTS = [
  ['Max leverage the venue allows', '100x', 'config/engine.json risk.maxLeverage'],
  ['Round-trip cost, long', '0.34%', 'config/engine.json risk.costBpsByDirection.long (34 bps)'],
  ['Round-trip cost, short', '0.14%', 'config/engine.json risk.costBpsByDirection.short (14 bps)'],
  ['Fills', 'Keeper-filled, seconds after you submit — not instant', "docs/PLAN_TELEGRAM_EXECUTION.md \"Two-phase open\" (Perps v2)"],
  ['Liquidation distance (planning estimate)', '≈ 1 / leverage − 0.3%', 'lib/riskEngine.js maxLeverageForStop: liquidation distance ≈ 1/leverage − maintenanceMarginPct/100']
];

// ---------- layer 2: the hard env caps ----------
// Deployed live values per docs/AGENT_SESSION_RULES.md line 3 ("caps $20 / 2x / $2 / $25 / 1"),
// not the larger placeholder numbers an earlier draft of this page assumed - verified against
// the current rules doc rather than guessed. Env var names + the drift cap default: lib/execution/gates.js CAP_ENV,
// entry-drift default from docs/PLAN_TELEGRAM_EXECUTION.md review fix #2 ("default 15" bps).
const ENV_CAPS = [
  ['EXECUTION_MAX_SIZE_USD', '$20', 'largest position (notional) any single order can open'],
  ['EXECUTION_MAX_LEVERAGE', '2x', 'far below the venue\'s 100x — this is the deliberate live-test ceiling, not a venue limit'],
  ['EXECUTION_MAX_LOSS_USD_PER_TRADE', '$2', 'refuses an order whose loss at the stop would exceed this'],
  ['EXECUTION_MAX_DAILY_LOSS_USD', '$25', 'refuses new orders once today\'s realized loss reaches this'],
  ['EXECUTION_MAX_OPEN_POSITIONS', '1', 'refuses a new order while this many are already open'],
  ['EXECUTION_MAX_ENTRY_DRIFT_BPS', '15 bps (default)', 'refuses a fill that has moved more than this from the plan\'s entry']
];

// ---------- layer 3: the wallet-aware risk policy ----------
// lib/execution/riskPolicy.js RISK_DEFAULTS + RISK_PCT_PER_TRADE_MAX.
const WALLET_POLICY = [
  ['RISK_PCT_PER_TRADE', '0.5%', '% of your wallet equity risked at the stop, per trade'],
  ['RISK_MAX_EXPOSURE_PCT', '25%', 'all open positions\' notional, combined, as a % of equity'],
  ['RISK_MAX_PER_SYMBOL_PCT', '15%', 'one symbol\'s notional as a % of equity'],
  ['RISK_DAILY_DRAWDOWN_PCT', '3%', 'today\'s realized loss vs. the equity you started the day with — breach engages the kill switch'],
  ['RISK_WEEKLY_DRAWDOWN_PCT', '8%', 'last 7 days\' realized loss vs. week-start equity — breach engages the kill switch'],
  ['RISK_MIN_FREE_GAS_SOL', '0.05 SOL', 'floor of free (non-position) SOL the signing wallet must keep for fees']
];

// ---------- worked example ----------
// Equity: owner-reported bot-wallet snapshot, ~0.12 SOL (docs/PROMPT_T14_AGENT_K.md line 21,
// "fund the bot wallet (JEAzPi...TjwT2) rather than trading the main wallet"; full address in
// scripts/transfer-funds.js:19). SOL/USD used only to express that in dollars for this example
// (CoinGecko spot, 2026-09-26, SOL ≈ $121.51) - illustrative, not a live figure.
const EXAMPLE_EQUITY_SOL = 0.12;
const EXAMPLE_SOL_USD = 121.51;
const EXAMPLE_EQUITY_USD = EXAMPLE_EQUITY_SOL * EXAMPLE_SOL_USD; // ≈ $14.58
const EXAMPLE_PCT_PER_TRADE = 0.5; // RISK_DEFAULTS.pctPerTrade, lib/execution/riskPolicy.js
const EXAMPLE_MAX_SIZE_CAP = 20; // EXECUTION_MAX_SIZE_USD live value, docs/AGENT_SESSION_RULES.md
const EXAMPLE_LEVERAGE_CAP = 2; // EXECUTION_MAX_LEVERAGE live value, docs/AGENT_SESSION_RULES.md
const EXAMPLE_LIQ_BUFFER = 0.05; // config/engine.json risk.liquidationBufferPct
const EXAMPLE_MAINT_MARGIN = 0.3; // config/engine.json risk.maintenanceMarginPct
const EXAMPLE_STOPS_PCT = [0.3, 0.65, 1, 1.5, 3];

/**
 * The same math as lib/execution/riskPolicy.js evaluateRiskPolicy (riskBudget -> suggestedSizeUsd)
 * and lib/riskEngine.js maxLeverageForStop (stop -> liquidation-safety leverage cap), with the
 * executor's own env cap (docs/PLAN_TELEGRAM_EXECUTION.md riskPolicy section: "suggestedLeverage
 * ... capped by policy.maxLeverageCap") folded in the same way the real code folds it.
 */
function sizingRow(stopPct) {
  const riskBudgetUsd = EXAMPLE_EQUITY_USD * (EXAMPLE_PCT_PER_TRADE / 100);
  const rawSize = riskBudgetUsd / (stopPct / 100);
  const size = Math.min(rawSize, EXAMPLE_MAX_SIZE_CAP);
  const liqCapRaw = 100 / (stopPct + EXAMPLE_LIQ_BUFFER + EXAMPLE_MAINT_MARGIN);
  const leverage = Math.max(1, Math.min(Math.floor(liqCapRaw), EXAMPLE_LEVERAGE_CAP));
  const margin = size / leverage;
  return { stopPct, riskBudgetUsd, size, leverage, margin, capped: rawSize > EXAMPLE_MAX_SIZE_CAP };
}
const SIZING_ROWS = EXAMPLE_STOPS_PCT.map(sizingRow);

// ---------- why net R matters more than gross ----------
// Owner-stated fact, docs/PROMPT_T13_AGENT_J.md line 5: "the first five scored GOOD calls
// were +0.47R gross but -2.37R net. Stops of 0.02-0.07% on BTC are smaller than Jupiter's
// round-trip cost (0.34% long / 0.14% short), so even winners lose."
const FIRST_FIVE_GROSS_R = 0.47;
const FIRST_FIVE_NET_R = -2.37;
const FIRST_FIVE_STOP_RANGE = '0.02–0.07%';
// Rule of thumb derived from the same cost figures: at 3x the round-trip cost, fees alone
// consume 1/3 of one R at the stop; the first five calls' stops were 5-17x SMALLER than the
// fee itself (0.34% / 0.02-0.07% ≈ 5-17), which is why gross wins still net negative.
const RULE_OF_THUMB_LONG_MIN_STOP = 3 * 0.34; // 1.02%
const RULE_OF_THUMB_SHORT_MIN_STOP = 3 * 0.14; // 0.42%

// ---------- net-floor shadow (T-13) ----------
// Not merged into this checkout as of 2026-09-26 (docs/PROMPT_T13_AGENT_J.md assigns it to the
// sibling net-floor worktree). Described here as "when it lands" per that prompt's own fallback
// language, not as a feature already live.
const NET_FLOOR_PENDING = true;

// ---------- step by step ----------
const STEPS = [
  ['Alert arrives', 'GOOD, SETUP or BREAKOUT with entry, stop, TP1, gross and net R. A verdict line reads GET IN NOW, BE READY, WAIT (with an eta) or STAND DOWN, plus Kill if: and Other side: context lines (lib/telegram.js clarity fields, schema 1.27.0).'],
  ['Tap Plan', 'Entry, stop, TP1/TP2, gross and net R, suggested leverage, size and loss at stop, mark vs Kraken.'],
  ['Open @ plan, or Open (early)', 'Open @ plan appears once a GOOD plan is ready (GET IN NOW). Open (early) appears on a SETUP or BREAKOUT that already has entry/stop/TP1 but isn\'t ready yet — same checks, same ticket, you\'re choosing to go in ahead of the trigger.'],
  ['Ticket', 'Side, size, leverage, expected fill, SL, TP1, max loss, fees, and — once the risk policy is on the ticket — a risk $X (Y% eq) · exposure line, with a suggested $X note when your size is larger than the policy would pick. Anything over a cap, a stop over 3%, the kill switch on, or a missing cap comes back ⛔ ORDER REFUSED with the reasons instead.'],
  ['Confirm + PIN', 'Reply /confirm <nonce> <PIN>. The bot deletes that message so the PIN doesn\'t sit in the chat. Wrong PIN 3 times auto-kills execution for 1 hour.'],
  ['Manage it', '/positions shows live PnL and a stops: SL ✔ TP ✔ line; Close, Close 50%, SL→BE and Set SL/TP each make a new ticket needing its own /confirm + PIN.'],
  ['/kill and /arm', '/kill stops all execution immediately, no PIN. /arm <PIN> clears a manual or wrong-PIN kill (an EXECUTION_KILL set in Vercel stays until removed there, and a drawdown-triggered kill needs the drawdown itself to clear, not just /arm).'],
  ['Journal + tracker', 'Every open/close/adjust is journaled and shows up in the tracker\'s Engine vs you and Journal sections — your side of the record, not the engine\'s.']
];

// ---------- growing size safely ----------
const GROWING_SIZE = [
  'There is no automatic step-up. The env caps ($20 / 2x / $2 / $25 / 1 today) only change when someone edits them in Vercel — that\'s a deliberate choke point, not a bug.',
  'docs/PLAN_TELEGRAM_EXECUTION.md\'s own go-live plan (phase E) is the precedent: go live with tiny caps only after ≥ 3 clean dry-run orders, then raise by owner decision only, never automatically.',
  'Keep loss-per-trade in the 0.5–1% of equity range even once caps are raised — RISK_PCT_PER_TRADE defaults to 0.5% and can be tightened with /risk pct, never loosened past 2% (RISK_PCT_PER_TRADE_MAX).',
  'The daily/weekly drawdown kill (3% / 8%) is the backstop if sizing discipline slips — it engages the kill switch on its own, independent of any cap you\'ve set.',
  `Fund the bot wallet (JEAzPi…TjwT2 — scripts/transfer-funds.js) rather than trading the main wallet. Every % above is relative to THIS wallet's equity: a bigger wallet balance changes every suggested size and risk $ figure without you touching a single env var.`
];

// ---------- what the tracker's numbers mean, for risk ----------
const TRACKER_NUMBERS = [
  ['Exp. (gross R)', 'Price-only expectancy — what the call was worth before any fee.'],
  ['Net exp. (net of fees)', 'The same calls after the round-trip cost for that call\'s direction. This is the number that matters for whether taking a call actually pays; see "Why net R matters more than gross" above.'],
  ['Max loss streak', 'How many losers in a row the engine\'s calls have strung together — sizing at RISK_PCT_PER_TRADE (0.5% default) means a streak like that costs a known, bounded % of equity, not a guess.'],
  ['Exposure', 'Not a tracker column today, but the same idea as RISK_MAX_EXPOSURE_PCT (25%) and RISK_MAX_PER_SYMBOL_PCT (15%) above — how much of your wallet is committed at once, and to which symbol.']
];

// ---------- markup ----------
const defList = (id, rows) => `<dl class="def-list" id="${id}">${rows.map(([term, chip, text]) => `<div class="def-row"><dt>${esc(term)}<span class="label">${esc(chip)}</span></dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;
const factList = (id, rows) => `<dl class="def-list" id="${id}">${rows.map(([term, value, src]) => `<div class="def-row"><dt>${esc(term)}</dt><dd>${esc(value)}<span class="note" style="display:block">${esc(src)}</span></dd></div>`).join('')}</dl>`;
const plainList = (id, items) => `<ul class="howto-list" id="${id}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const stepList = (id, rows) => `<ol class="def-list" id="${id}">${rows.map(([title, text], i) => `<div class="def-row" id="${id}-${i + 1}"><dt>${i + 1}. ${esc(title)}</dt><dd>${esc(text)}</dd></div>`).join('')}</ol>`;

function sizingTable() {
  const rows = SIZING_ROWS.map((r) => `<tr id="risk-sizing-row-${slug(String(r.stopPct))}"><td>${r.stopPct}%</td><td>${usd(r.riskBudgetUsd)}</td><td>${usd(r.size)}${r.capped ? '<span class="label"> capped</span>' : ''}</td><td>${r.leverage}x</td><td>${usd(r.margin)}</td></tr>`).join('');
  return `<div class="table-scroll" id="risk-sizing-table-scroll"><table class="rules-table" id="risk-sizing-table">`
    + `<thead><tr><th>Stop distance</th><th>Risk $ (0.5% of equity)</th><th>Suggested size</th><th>Leverage</th><th>Margin</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

export function renderRisk() {
  const topStrip = `<header class="edge-strip" id="risk-top-edge-strip"><span id="risk-page-title">EDITTRADES / RISK &amp; SIZING</span>`
    + `<a class="nav-link" id="risk-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('risk-jump-nav', [
      ['#risk-intro-section', 'Overview'], ['#risk-layers-section', 'Layers'], ['#risk-example-section', 'Sizing example'], ['#risk-net-r-section', 'Net R'],
      ['#risk-steps-section', 'Step by step'], ['#risk-growing-section', 'Growing size'], ['#risk-tracker-section', 'Tracker numbers'],
      ['how-to.html', '← How to use', 'class="nav-link" id="risk-nav-howto-link"'], ['strategies.html', 'Wallet strategies →', 'class="nav-link" id="risk-nav-strategies-link"'], ['index.html', 'Call tracker →', 'class="nav-link" id="risk-nav-tracker-link"']
    ]);

  const intro = zone({
    id: 'risk-intro-section', title: 'How much to trade, and why',
    tiles: [tile({
      id: 'risk-intro-tile', lg: 12,
      body: `<h1 id="risk-intro-title">Three layers decide every trade's size.</h1>`
        + `<p class="howto-lede" id="risk-intro-text">The venue sets what's possible, an env cap sets a hard ceiling regardless of your wallet, and a wallet-aware policy sizes the trade against what you actually have. None of these numbers are guesses — the ticket you get on Telegram is this same math, run live.</p>`
        + `<p class="note" id="risk-strategies-crosslink">Which profile is live and how the wallet is actually tracking: <a href="strategies.html">Wallet strategies →</a>.</p>`
    })]
  });

  const layers = zone({
    id: 'risk-layers-section', title: 'The three layers that size a trade', sub: 'Venue → env cap → wallet policy',
    tiles: [
      tile({ id: 'risk-layer-venue-tile', title: 'Layer 1 · the venue (Jupiter)', lg: 4, body: factList('risk-layer-venue-list', VENUE_FACTS) }),
      tile({ id: 'risk-layer-env-tile', title: 'Layer 2 · your hard caps', tag: 'Vercel env · live today', lg: 4, body: factList('risk-layer-env-list', ENV_CAPS) }),
      tile({
        id: 'risk-layer-wallet-tile', title: 'Layer 3 · wallet-aware risk policy', tag: '/risk', lg: 4, body: factList('risk-layer-wallet-list', WALLET_POLICY),
        foot: '/risk pct|exposure|symbolexposure|dailydd|weeklydd|gas VALUE tightens one knob; /risk reset clears overrides. An override can only tighten, never loosen past the env default or 2% per trade.'
      })
    ]
  });

  const example = zone({
    id: 'risk-example-section', title: 'How a trade amount is computed', sub: `Worked example at the bot wallet's real equity`,
    tiles: [
      tile({
        id: 'risk-example-tile', lg: 12,
        body: `<p class="note" id="risk-example-intro">At ${EXAMPLE_EQUITY_SOL} SOL (~${usd(EXAMPLE_EQUITY_USD)} at a recent SOL price), risking the default 0.5% per trade is ${usd(EXAMPLE_EQUITY_USD * EXAMPLE_PCT_PER_TRADE / 100)} — before any cap or leverage math. Two steps: <b>risk $ = equity × pct</b>, then <b>size = risk $ ÷ stop distance %</b>, capped at ${usd(EXAMPLE_MAX_SIZE_CAP)} (EXECUTION_MAX_SIZE_USD). Leverage is whichever is smaller of the liquidation-safety cap (lib/riskEngine.js maxLeverageForStop, ≈100 / (stop% + 0.35)) and today's env cap of ${EXAMPLE_LEVERAGE_CAP}x — at these stop distances the env cap always binds first.</p>`
          + sizingTable()
          + `<p class="note" id="risk-example-note">Margin = size ÷ leverage: what actually gets locked up as collateral. This wallet's equity is smaller than the $20 size cap itself, so the wallet-risk layer — not the env cap — is usually the tighter limit right now; a bigger wallet balance raises every number in this table without any env change.</p>`
      })
    ]
  });

  const netR = zone({
    id: 'risk-net-r-section', title: 'Why net R matters more than gross', sub: 'Fees are a real share of a tight stop',
    tiles: [
      tile({
        id: 'risk-net-r-tile', lg: 7,
        body: `<p class="howto-lede" id="risk-net-r-text">The first five scored GOOD calls were <b>+${FIRST_FIVE_GROSS_R}R gross</b> but <b>${FIRST_FIVE_NET_R}R net</b>. Their stops (${FIRST_FIVE_STOP_RANGE} on BTC) were smaller than Jupiter's round-trip cost (0.34% long / 0.14% short) — fees alone were several multiples of the whole trade's risk, so even the winners lost after costs.</p>`
          + `<p class="note" id="risk-net-r-rule">Rule of thumb: don't take a stop tighter than about 3× the round-trip fee — roughly ${RULE_OF_THUMB_LONG_MIN_STOP.toFixed(2)}% for a long, ${RULE_OF_THUMB_SHORT_MIN_STOP.toFixed(2)}% for a short. Below that, fees start eating a third or more of your risk before the market even moves.</p>`,
        foot: 'docs/PROMPT_T13_AGENT_J.md — owner finding, 2026-09-26.'
      }),
      tile({
        id: 'risk-net-floor-tile', title: 'Net-floor shadow', tag: NET_FLOOR_PENDING ? 'When it lands' : 'NF', lg: 5,
        body: NET_FLOOR_PENDING
          ? `<p class="note" id="risk-net-floor-pending">A fee-aware "net floor" line — <span class="cmd-inline">net floor: READY</span> or <span class="cmd-inline">NOT YET</span> — is planned to run in shadow beside the live rules until the 2026-10-08 freeze ends, so plans can be judged net of fees without changing what's traded yet. Not merged into this build as of 2026-09-26.</p>`
          : `<p class="note" id="risk-net-floor-live">Runs in shadow beside the live rules, never traded.</p>`,
        foot: 'docs/PROMPT_T13_AGENT_J.md (T-13).'
      })
    ]
  });

  const steps = zone({
    id: 'risk-steps-section', title: 'How to approach a trade, step by step',
    tiles: [tile({ id: 'risk-steps-tile', lg: 12, body: stepList('risk-steps-list', STEPS) })]
  });

  const growing = zone({
    id: 'risk-growing-section', title: 'Growing size safely',
    tiles: [tile({ id: 'risk-growing-tile', lg: 12, body: plainList('risk-growing-list', GROWING_SIZE) })]
  });

  const trackerNumbers = zone({
    id: 'risk-tracker-section', title: 'What the tracker\'s numbers mean for risk',
    tiles: [tile({
      id: 'risk-tracker-tile', lg: 12, body: defList('risk-tracker-list', TRACKER_NUMBERS),
      foot: 'Column names match the tracker page (index.html) exactly.'
    })]
  });

  const bottomStrip = `<footer class="edge-strip" id="risk-bottom-edge-strip"><span id="risk-footer-note">NOT FINANCIAL ADVICE · EVERY NUMBER ABOVE IS A CAP OR A SUGGESTION, NEVER A GUARANTEE</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Risk &amp; Sizing</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
</style>
</head>
<body>
<main id="risk-page-main">
${topStrip}
${[intro, layers, example, netR, steps, growing, trackerNumbers].join('\n')}
${bottomStrip}
</main>
</body>
</html>
`;
}
