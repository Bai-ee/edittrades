/**
 * EditTrades call tracker - "How to use with ChatGPT" page (how-to.html).
 *
 * Static guide for talking to the EditTrades Custom GPT about trades, laid out in the
 * shared bento system (./bento.js, ./page-style.js). Content mirrors
 * docs/GPT_INSTRUCTIONS.md (commands, answer format, engine authority); update both
 * together when a command or the answer format changes. No data, no scripts.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';

const STEPS = [
  ['Fresh chat', 'Open a new chat for each session so no old prices carry over.'],
  ['Ask "signals"', 'Read the call line first (GO IN / HOLD / DON\'T), then the DATA block at the bottom. Generated At and Closed Through should be minutes old.'],
  ['Nothing actionable? Ask "forming"', 'Note each Confirmation price and Thesis Eliminated price. Set chart alerts on them.'],
  ['Alert fires: ask "signals" again', 'Act only if the plan is now ready and the call says GO IN.'],
  ['Enter as quoted', 'Quoted entry, Stop Loss placed right away, leverage at or under the suggested figure. Never above max.'],
  ['Manage with facts', 'Send entry, size, collateral, leverage and liquidation for HOLD / REDUCE / EXIT and a protective stop. Past the Time Stop, ask again.']
];

// [command, what you get, chip, phone span, desktop span]
const COMMANDS = [
  ['signals', 'BTC, ETH and SOL, longs and shorts. The strongest actionable asset gets the full call: thesis, GO IN / HOLD / DON\'T, entry, stops, targets, size. The others get one NO TRADE line each with the trigger to watch. "trades" gives the same answer.', 'Start here', 2, 6],
  ['forming', 'Flags still building on 1m / 3m / 5m, both directions: what confirms them, what kills them, when to check back. No entries or sizing.', 'Watchlist', 2, 6],
  ['track', 'Send with a chart screenshot or a described setup you are not in. Five lines back: TRACK YES/NO, entry condition, window, thesis null, expected trade time.', 'Screenshot', 2, 4],
  ['flags', 'Every flag candidate per asset in every state, failed and expired included, with the engine\'s quality decision and reasons.', 'Full list', 2, 4],
  ['balance', 'Wallet balance, exposure and P&L only.', 'Account', 1, 2],
  ['data check', 'Only the data block: snapshot time, last closed candle, versions, warnings.', 'Freshness', 1, 2]
];

// Reading an answer, grouped by the question each group answers.
const READING = [
  ['howto-read-call-tile', 'The call', 'Should I act?', [
    ['GO IN / HOLD / DON\'T', '≥ 65% to act', 'Three percentages that add to 100. GO IN needs at least 65% plus a ready engine plan, entry, confirmation, stop, targets and acceptable wallet risk. Anything less is HOLD or DON\'T.'],
    ['NO TRADE', 'Valid answer', 'Below threshold is normal. It comes with the exact trigger that would change it.']
  ]],
  ['howto-read-engine-tile', 'Engine verdict', 'What does the engine say?', [
    ['Recommendation class', 'Engine call', 'GOOD, WATCH, BAD or DATA_UNAVAILABLE, with Supports / Against / Unknown / What changes. The GPT reports it; it does not recompute it.'],
    ['Plan status', 'Trade authority', 'ready = eligible for GO IN at the quoted levels. conditional = wait for the entry condition. rejected = no trade, with a reason code (chase, rr_below_min, room_at_entry…).']
  ]],
  ['howto-read-levels-tile', 'Levels', 'Where am I wrong?', [
    ['Thesis Eliminated', 'Kill level', 'The price where the idea is wrong. Long: at or below the zone low. Short: at or above the zone high. Never inside the zone.'],
    ['Stop Loss', 'Exit', 'The executable exit, with a buffer past Thesis Eliminated. Scalp stops are capped at 3% from entry.'],
    ['R:R', '≥ 3R gross', 'Trades need about 3R to TP1 before fees. Under 1R to TP1 is always DON\'T.']
  ]],
  ['howto-read-fresh-tile', 'Freshness', 'Can I trust these numbers?', [
    ['DATA block', 'Always check', 'Every trade answer ends with Generated At and Closed Through. If they are old, or warnings are listed, ask again before acting.'],
    ['Mark drift', '> 10 bps', 'Stops and liquidation hit on the Pyth mark, not the Kraken close. The GPT flags it when the gap is over 10 bps.']
  ]]
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
  'Don\'t act on an entry the engine didn\'t produce. A GPT-made level must show R:R, $ loss and wallet risk, and is labeled legacy or provisional.',
  'Don\'t reuse numbers from earlier in the chat. Ask again so it pulls a fresh snapshot.',
  'Don\'t treat confidence as win odds. It measures setup strength, not the chance it pays.',
  'Counter-trend against the 4h is allowed: size smaller, targets inside the next higher-timeframe level.',
  'When it asks for a screenshot (visual confirmation), send the chart it names before any GO IN.'
];

const defList = (id, rows) => `<dl class="def-list" id="${id}">${rows.map(([term, chip, text]) => `<div class="def-row"><dt>${esc(term)}<span class="label">${esc(chip)}</span></dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;

export function renderHowTo() {
  const topStrip = `<header class="edge-strip" id="howto-top-edge-strip"><span id="howto-page-title">EDITTRADES / HOW TO USE WITH CHATGPT</span>`
    + `<a class="nav-link" id="howto-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('howto-jump-nav', [
      ['#howto-session-section', 'Session'], ['#howto-commands-section', 'Commands'], ['#howto-reading-section', 'Reading'],
      ['#howto-ask-zone', 'Asking'], ['#howto-tracker-section', 'Tracker'], ['index.html', '← Tracker', 'class="nav-link" id="howto-nav-back-link"'], ['changelog.html', 'System map →', 'class="nav-link" id="howto-nav-system-map-link"']
    ]);

  const intro = zone({
    id: 'howto-intro-zone', title: 'How to use EditTrades in ChatGPT',
    tiles: [
      tile({
        id: 'howto-intro-section', lg: 8,
        body: `<h1 id="howto-intro-title">Talk to the engine, not around it.</h1>`
          + `<p class="howto-lede" id="howto-intro-text">The GPT reads a closed-candle snapshot of BTC, ETH and SOL before every answer. The engine owns the trade levels: entry, stop, targets, R:R. The GPT reports them, explains them and sizes them against your wallet. Treat it as a second pair of eyes with fixed rules.</p>`
      }),
      tile({
        id: 'howto-quickstart-tile', title: 'Quick start', lg: 4,
        body: `<div class="prompt-stack" id="howto-quickstart-prompts"><pre class="howto-prompt" id="howto-quick-signals">signals</pre><pre class="howto-prompt" id="howto-quick-forming">forming</pre></div>`
          + `<p class="note" id="howto-quickstart-note">Type either as the whole message. Case doesn't matter.</p>`
      })
    ]
  });

  const session = zone({
    id: 'howto-session-section', title: 'A session, step by step', sub: '6 steps',
    tiles: STEPS.map(([title, text], i) => tile({
      id: `howto-step-${i + 1}-tile`, as: 'div', lg: 4,
      body: `<span class="step-num" aria-hidden="true">${i + 1}</span><h3 class="tile-title">${esc(title)}</h3><p class="step-text">${esc(text)}</p>`
    }))
  });

  const commands = zone({
    id: 'howto-commands-section', title: 'Commands', sub: 'The whole message',
    tiles: COMMANDS.map(([cmd, desc, chip, sm, lg]) => tile({
      id: `howto-cmd-${cmd.replace(/\s+/g, '-')}-tile`, as: 'div', sm, lg,
      body: `<div class="cmd-head"><div class="cmd-name" data-command="${esc(cmd)}">${esc(cmd)}</div><span class="prov-tag">${esc(chip)}</span></div><p class="cmd-desc">${esc(desc)}</p>`
    }))
  });

  const reading = zone({
    id: 'howto-reading-section', title: 'Reading an answer', sub: 'Four questions, in order',
    tiles: READING.map(([id, title, question, rows]) => tile({
      id, title, tag: question, lg: 6,
      body: defList(`${id}-list`, rows)
    }))
  });

  const ask = zone({
    id: 'howto-ask-zone', title: 'Asking well',
    tiles: [
      tile({
        id: 'howto-follow-ups-section', title: 'Good follow-up questions', lg: 7,
        body: `<div class="prompt-stack" id="howto-follow-ups-list">${FOLLOW_UPS.map(([id, text]) => `<pre class="howto-prompt" id="${id}">${esc(text)}</pre>`).join('')}</div>`,
        foot: 'For an open position, always give entry, size or notional, collateral, leverage and liquidation price. Without them it can\'t check that your stop clears liquidation.'
      }),
      tile({
        id: 'howto-donts-section', title: 'What not to do', lg: 5,
        body: `<ul class="howto-list" id="howto-donts-list">${DONTS.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
      })
    ]
  });

  const tracker = zone({
    id: 'howto-tracker-zone', title: 'The tracker',
    tiles: [tile({
      id: 'howto-tracker-section', title: 'How this ties to the call tracker',
      body: `<p class="howto-lede" id="howto-tracker-text">The call tracker records the same engine calls every 30 minutes and scores them against later candles. Until it has enough scored plans, every number there is provisional. Check it before trusting a class: if GOOD calls are losing, that matters more than any single answer in the chat.</p>`
        + `<p id="howto-tracker-link-row"><a class="nav-link" id="howto-tracker-link" href="index.html">Open the call tracker →</a></p>`
    })]
  });

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
${[intro, session, commands, reading, ask, tracker].join('\n')}
${bottomStrip}
</main>
</body>
</html>
`;
}
