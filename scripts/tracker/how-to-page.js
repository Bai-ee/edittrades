/**
 * EditTrades call tracker - "How to use with ChatGPT" page (how-to.html).
 *
 * Static guide for talking to the EditTrades Custom GPT about trades. Content mirrors
 * docs/GPT_INSTRUCTIONS.md (commands, answer format, engine authority); update both
 * together when a command or the answer format changes. No data, no scripts.
 */

import { PAGE_CSS } from './page-style.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function section(id, title, body, tag = 'GUIDE') {
  return `<section id="${id}" data-section="${id}">`
    + `<div class="section-head" id="${id}-head"><h2>${esc(title)}</h2><span class="prov-tag">${esc(tag)}</span></div>${body}</section>`;
}

/** Rows of [label, explanation, right-hand value] in the tracker's track-row layout. */
function rows(id, items) {
  return `<dl class="track-list" id="${id}">${items.map(([rowId, label, why, val]) => `<div class="track-row" id="${rowId}"><dt>${esc(label)}</dt><dd class="track-why">${esc(why)}</dd><dd class="track-val">${esc(val)}</dd></div>`).join('')}</dl>`;
}

const prompt = (id, text) => `<pre class="howto-prompt" id="${id}">${esc(text)}</pre>`;
const para = (id, text) => `<p class="howto-text" id="${id}">${esc(text)}</p>`;
const steps = (id, items) => `<ol class="howto-steps" id="${id}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`;

const COMMANDS = [
  ['howto-cmd-signals-row', 'signals', 'BTC, ETH and SOL, longs and shorts. The strongest actionable asset gets the full call (thesis, GO IN / HOLD / DON\'T, entry, stops, targets, size). The others get one NO TRADE line each with the trigger to watch.', 'START HERE'],
  ['howto-cmd-trades-row', 'trades', 'Same answer as signals.', '= SIGNALS'],
  ['howto-cmd-forming-row', 'forming', 'Flags still building on 1m / 3m / 5m, both directions: what confirms them, what kills them, when to check back. No entries or sizing.', 'WATCHLIST'],
  ['howto-cmd-flags-row', 'flags', 'Every flag candidate per asset in every state, including failed and expired, with the engine\'s quality decision and reasons.', 'FULL LIST'],
  ['howto-cmd-track-row', 'track', 'Send with a chart screenshot or a described setup you are NOT in. Replies with five lines only: TRACK YES/NO, entry condition, window, thesis null, expected trade time.', 'SCREENSHOT'],
  ['howto-cmd-balance-row', 'balance', 'Wallet balance, exposure and P&L only.', 'ACCOUNT'],
  ['howto-cmd-data-check-row', 'data check', 'Only the data block: when the snapshot was generated, the last closed candle, schema and config version, warnings.', 'FRESHNESS']
];

const READING = [
  ['howto-read-call-row', 'GO IN / HOLD / DON\'T', 'Three percentages that add to 100. GO IN needs at least 65% plus a ready engine plan, entry, confirmation, stop, targets and acceptable wallet risk. Anything less is HOLD or DON\'T.', '≥ 65% TO ACT'],
  ['howto-read-class-row', 'Recommendation class', 'The engine\'s 21/200 flag call: GOOD, WATCH, BAD or DATA_UNAVAILABLE, with Supports / Against / Unknown / What changes. The GPT reports it; it does not recompute it.', 'ENGINE CALL'],
  ['howto-read-plan-row', 'Plan status', 'ready = eligible for GO IN at the quoted levels. conditional = wait for the entry condition. rejected = no trade, with a reason code (chase, rr_below_min, room_at_entry…).', 'TRADE AUTHORITY'],
  ['howto-read-thesis-row', 'Thesis Eliminated', 'The price where the idea is wrong. For a long it sits at or below the zone low; for a short at or above the zone high. Never inside the zone.', 'KILL LEVEL'],
  ['howto-read-stop-row', 'Stop Loss', 'The executable exit, with a buffer past Thesis Eliminated. Scalp stops are capped at 3% from entry.', 'EXIT'],
  ['howto-read-rr-row', 'R:R', 'Trades need about 3R to TP1 before fees. Under 1R to TP1 is always DON\'T.', '≥ 3R GROSS'],
  ['howto-read-mark-row', 'Mark drift', 'Stops and liquidation hit on the Pyth mark, not the Kraken close. The GPT flags it when the gap is over 10 bps.', 'CHECK > 10 BPS'],
  ['howto-read-data-row', 'DATA block', 'Every trade answer ends with Generated At and Closed Through. If they are old, or warnings are listed, ask again before acting.', 'ALWAYS CHECK']
];

const FOLLOW_UPS = [
  ['howto-follow-why', 'Why is the BTC plan rejected?'],
  ['howto-follow-changes', 'What would make ETH GOOD instead of WATCH?'],
  ['howto-follow-bias', 'What\'s your bias on SOL right now?'],
  ['howto-follow-coil', 'What\'s happening with the ETH 1h coil?'],
  ['howto-follow-position', 'I\'m long BTC, entry 61000, 5x, liquidation 52400, collateral $2000. What should I do?']
];

const DONTS = [
  'Don\'t ask it to lower the 65% threshold, widen a scalp stop past 3%, or "just give me an entry". NO TRADE is a valid answer.',
  'Don\'t act on an entry the engine didn\'t produce. If the GPT offers its own level, it must show R:R, $ loss and wallet risk, and it is labeled legacy or provisional.',
  'Don\'t reuse numbers from earlier in the chat. Prices move; ask again so it pulls a fresh snapshot.',
  'Don\'t treat confidence as win odds. It measures how strong the setup looks, not how likely it is to pay.',
  'Counter-trend against the 4h is allowed, but size smaller and keep targets inside the next higher-timeframe level.',
  'When it asks for a screenshot (visual confirmation), send the chart it names before any GO IN.'
];

export function renderHowTo() {
  const topStrip = `<header class="edge-strip" id="howto-top-edge-strip"><span id="howto-page-title">EDITTRADES / HOW TO USE WITH CHATGPT</span>`
    + `<a class="nav-link" id="howto-back-link" href="index.html">← CALL TRACKER</a></header>`;

  const intro = `<section id="howto-intro-section" data-section="howto-intro-section" class="hero">`
    + `<h1 id="howto-intro-title">Talk to the engine, not around it.</h1>`
    + para('howto-intro-text', 'The EditTrades GPT reads a closed-candle snapshot of BTC, ETH and SOL from the engine before every answer. The engine owns the trade levels (entry, stop, targets, R:R). The GPT\'s job is to report them, explain them and size them against your wallet. Use it as a second pair of eyes with fixed rules, not as an oracle.')
    + `</section>`;

  const loop = steps('howto-session-steps', [
    'Open a fresh chat for each session so no old prices carry over.',
    'Send "signals". Read the call line first (GO IN / HOLD / DON\'T), then the DATA block at the bottom to confirm the snapshot is current.',
    'If nothing is actionable, send "forming". Note each Confirmation price and Thesis Eliminated price, and set alerts on your chart.',
    'When an alert fires, send "signals" again. Only act if the plan is now ready and the call says GO IN.',
    'Enter at the quoted entry, place the quoted Stop Loss right away, and use the quoted leverage or less (never above max).',
    'Once in, send your position details (entry, size, collateral, leverage, liquidation) to get HOLD / REDUCE / EXIT guidance and an executable protective stop.',
    'Respect the Time Stop: when it passes, ask again and reassess.'
  ]);

  const follow = FOLLOW_UPS.map(([id, text]) => prompt(id, text)).join('')
    + para('howto-follow-note', 'For an open position, always give entry, size or notional, collateral, leverage and liquidation price. Without them it can\'t check that your stop clears liquidation.');

  const donts = `<ul class="howto-list" id="howto-donts-list">${DONTS.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;

  const tracker = para('howto-tracker-text', 'The call tracker records the same engine calls every 30 minutes and scores them against later candles. Until it has enough scored plans, every number there is provisional. Check it before trusting a class: if GOOD calls are losing, that matters more than any single answer in the chat.')
    + `<p class="howto-text" id="howto-tracker-link-row"><a class="nav-link" id="howto-tracker-link" href="index.html">OPEN THE CALL TRACKER →</a></p>`;

  const body = [
    intro,
    section('howto-session-section', 'A session, step by step', loop),
    section('howto-commands-section', 'Commands', para('howto-commands-note', 'Type these as the whole message. Case doesn\'t matter.') + rows('howto-commands-list', COMMANDS)),
    section('howto-reading-section', 'Reading an answer', rows('howto-reading-list', READING)),
    section('howto-follow-ups-section', 'Good follow-up questions', follow),
    section('howto-donts-section', 'What not to do', donts),
    section('howto-tracker-section', 'How this ties to the tracker', tracker)
  ].join('\n');

  const bottomStrip = `<footer class="edge-strip" id="howto-bottom-edge-strip"><span id="howto-footer-note">NOT FINANCIAL ADVICE · THE ENGINE NEVER EXECUTES TRADES · YOU PLACE EVERY ORDER</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades How-To</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
</style>
</head>
<body>
<main id="howto-page-main">
${topStrip}
${body}
${bottomStrip}
</main>
</body>
</html>
`;
}
