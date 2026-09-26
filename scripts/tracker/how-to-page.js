/**
 * EditTrades call tracker - "How to use EditTrades" page (how-to.html).
 *
 * Static guide to the whole product as it runs today: the Telegram bot (@EditTrades_Bot,
 * lib/telegram.js, docs/PLAN_TELEGRAM.md), the Custom GPT (docs/GPT_INSTRUCTIONS.md),
 * the rules in force (config/engine.json, docs/OWNER_DECISIONS_2026-09-23.md,
 * docs/OWNER_DECISIONS_2026-09-24.md), the tracker tiles (./build-page.js) and the journal
 * (api/journal.js, lib/journalSchema.js). Laid out in the shared bento system
 * (./bento.js, ./page-style.js). Update this page with those sources whenever a command,
 * alert, rule value or tile changes. No data, no scripts.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';

// ---------- daily routine (phone-first) ----------

const ROUTINE = [
  ['Alert arrives', 'Telegram pings on a GOOD, a SETUP or a BREAKOUT, with entry, stop, TP1 and gross / net R. During quiet hours (01-05 Chicago) it arrives silently; nothing is dropped.'],
  ['Tap Plan', 'Entry, stop, TP1 / TP2, gross and net R, suggested leverage, size and loss at stop, mark vs Kraken, and the readiness call. Anything that is not a trade says so: NOT A TRADE UNDER YOUR RULES, with the reason.'],
  ['Tap Thesis', 'Supports, against, unknowns and what changes the call, in plain words, plus the one thing that would make it GO IN.'],
  ['Tap Chart', 'The confirmation chart at the plan timeframe: flag, breakout level, stop, TP1, EMA21 / EMA200.'],
  ['Decide', 'GOOD = ready plan, act at the quoted levels or not at all. SETUP = wait for its retest trigger. BREAKOUT = a flag just confirmed; the entry is the retest that holds, never the breakout candle.'],
  ['Took it or Skipped', 'One tap journals your decision with the engine\'s own levels. Took it also tracks the trade: TP1 or stop hit on the mark brings Closed here / Partial / Still in, and one reminder after 10 minutes if nothing is journaled. /positions lists what is still open.'],
  ['Check the tracker', 'Once a day: engine vs you, the equity curve, and whether GOOD calls are actually paying.']
];

// ---------- Telegram ----------

const TG_MENU = [['Signals', 'Flags', 'Market'], ['Why BTC', 'Why ETH', 'Why SOL'], ['Charts', 'Wallet', 'Positions', 'Exec'], ['Journal', 'Status', 'Alerts', 'Tracking']];

// [command, what it does]
const TG_COMMANDS = [
  ['/signals', 'BTC / ETH / SOL call now: GO IN / HOLD / DON\'T plus SETUP lines, with buttons per symbol.'],
  ['/why SYM', 'Supports, against, unknowns and what changes, for one symbol.'],
  ['/flags [SYM]', 'Every flag candidate and its state, then chart albums of every live flag (up to 9 images).'],
  ['/chart SYM TF', 'One confirmation chart, e.g. /chart BTC 5m. Charts opens a picker grid.'],
  ['/wallet', 'Read-only account block.'],
  ['/journal [n]', 'Last n journal lines (default 10).'],
  ['/log text', 'Journal a line: took / closed / skipped / moved / anything else as a note.'],
  ['/market', 'Last 24h per symbol from engine fields: change and range, top-down, 4h / 1h lean, EMA200 count, Stoch 15m / 1h, mark drift; a rule-based LEAN line, alerts today, and the level that would change it.'],
  ['/positions', 'Journal opens with no close: live mark, R now, R to stop and TP1, age; Close @ mark and Chart buttons.'],
  ['/tracking', 'The flags you track (up to 10, 6 hours each) with Plan, Thesis and Untrack buttons.'],
  ['/status', 'Schema, data age, marks, last alert, cron health, alert level, quiet hours, alert timeframes.'],
  ['/alerts', 'Show or set the alert level, quiet hours and timeframes (/alerts tf 5m | 3m,5m | all; default 3m,5m).'],
  ['/menu · /help', 'Bring back the button keyboard; list every command.']
];

// [level, what you get]
const TG_LEVELS = [
  ['good', 'Only', 'New GOOD and GOOD ended.'],
  ['setup', 'Default', 'Adds new SETUPs (the best conditional plan awaiting its retest or breakout).'],
  ['watch', 'Loudest', 'Adds a one-line alert for each new forming or triggering flag (15-min cooldown per symbol).']
];

const TG_ALWAYS = [
  'BREAKOUT alerts send at every level, once per flag, the first time it confirms.',
  'WATCH, TRIGGERING and BREAKOUT follow /alerts tf (default 3m and 5m). Tracking a flag turns on 1m alerts for that symbol and direction only, labeled "1m ENTRY · for your tracked …"; GOOD, SETUP, tracked and health alerts are never filtered.',
  'A tracked flag alerts on every change at any level: forming → triggering → confirmed, SETUP, GET IN NOW (with the Plan card), void, and TP1 or stop once the plan is ready or you took it.',
  'Data unavailable or mark down for more than 5 minutes always alerts, as does the alerts cron failing 3 runs in a row (then hourly) and its recovery.',
  'Quiet hours: 01:00-05:00 America/Chicago every day by default. Alerts in the window send silently, never dropped. /alerts quiet 23-06 changes it, /alerts quiet off turns it off.',
  'Owner-only: anyone else who messages the bot gets no answer. Alerts and read commands never trade; a trade happens only through an order ticket you confirm with your PIN (see Execution), and only when execution is switched on.'
];

// [step or command, chip, what it does] - execution (T-3), off unless TRADE_EXECUTION_ENABLED=true
const TG_EXEC = [
  ['Dry run first', 'Default', 'Mode is DRY RUN until the mode is changed to live in Vercel (env only; /mode shows it). A dry run does everything except sign and send: same checks, same ticket, same PIN, journaled as a note. Do at least 3 dry orders before going live.'],
  ['Open @ plan', 'Ready plans only', 'On a GOOD alert or Plan card when the call is GET IN NOW. Builds the order from the engine plan: entry, stop, TP1; size and leverage = the engine suggestion, capped by your caps.'],
  ['Open (early)', 'SETUP / BREAKOUT with levels', 'Available once a SETUP or BREAKOUT already has entry, stop and TP1 but isn\'t ready yet — same checks and ticket as Open @ plan; you\'re choosing to go in ahead of the trigger, not waiting for it.'],
  ['Focus mode', 'auto (default) · off', 'While you have a position open, focus auto quiets every other alert down to just that symbol (health and kill-switch alerts still always send); off sends everything regardless of open positions. Toggle from the persistent menu or /alerts focus auto|off.'],
  ['Ticket', '60 s', '⚡ ORDER card: DRY RUN or LIVE banner, side, size, leverage, expected fill, SL, TP1, max loss, fees, and a risk $X (Y% eq) · exposure line once the risk policy is on it (see /risk below). Anything over a cap, a stop over 3%, the kill switch on or a missing cap → ⛔ ORDER REFUSED with the reasons.'],
  ['Confirm + PIN', 'Every time', 'Tap Confirm, then reply /confirm <nonce> <PIN>. The bot deletes that message so the PIN does not stay in the chat. Wrong PIN 3 times → execution auto-kills for 1 hour. Cancel sends nothing.'],
  ['/order', 'Manual', '/order BTC long size 200 lev 5 sl 84390 tp 85146. SL and TP are required; the same checks and ticket apply.'],
  ['/positions', 'Manage', 'Live positions from chain with PnL and a stops: SL ✔ TP ✔ / ⚠ none line: Close, Close 50%, SL→BE, Set SL/TP (/stops <pos> sl <price> tp <price>). Each makes a ticket and needs /confirm with your PIN.'],
  ['Chart on entry', 'When it lands', 'A chart showing entry, stop and target the moment a plan is ready or taken is planned (T-13) but not yet merged into this build.'],
  ['/kill · /arm', 'Stop switch', '/kill stops all execution at once, no PIN. /arm <PIN> clears a manual or wrong-PIN kill (an EXECUTION_KILL set in Vercel, or a live drawdown breach, stays until cleared at the source).'],
  ['/exec', 'Status', 'Mode, caps, kill state, today\'s realized loss and open-position count, plus (once the risk policy is on) equity, exposure and drawdown day/week — one status line for everything execution-related.'],
  ['/risk', 'Wallet-aware sizing', 'Risk policy on top of your caps, sized against your real wallet equity: per-trade risk, exposure, drawdown, gas. Shows equity, exposure, drawdown day/week and the policy; /risk pct 0.3 (or exposure/symbolexposure/dailydd/weeklydd/gas) tightens one, /risk reset clears it. An override can only tighten a knob, never loosen past env or 2% per trade. The ticket shows the risk and a suggested size when yours is larger. Full breakdown, worked example and current caps: Risk & sizing →.'],
  ['Leverage cap', '2x today · 100x at the venue', 'Jupiter allows up to 100x; your env cap is far tighter while live-testing. Wider stops also leave less leverage available under the liquidation-safety math regardless of the cap — see Risk & sizing → for the exact numbers.']
];

// Per-alert verdict + context lines (schema 1.27.0, lib/telegram.js clarity fields).
const CLARITY_VERDICTS = [
  ['GET IN NOW', '', 'Ready. Act at the quoted levels or not at all.'],
  ['BE READY', '', 'Close, but not ready yet — the trigger hasn\'t confirmed.'],
  ['WAIT (eta)', '', 'Not ready, with an estimate of when that could change.'],
  ['STAND DOWN', '', 'Nothing here is actionable right now.']
];
const CLARITY_CONTEXT = [
  ['Kill if:', '', 'The one thing that would invalidate this call outright.'],
  ['Other side:', '', 'What the mirror-direction case looks like, when there is one.']
];

const TG_BUTTONS = [
  ['Plan', 'Levels + size', 'Entry, stop, TP1 / TP2, R gross and net, max and suggested leverage, collateral, size, loss at stop, mark vs Kraken, expected length (n/a unless measured) and the call. Engine fields only.'],
  ['Thesis', 'Why, plainly', 'Supports / against / unknown / what changes the call, the counter-trend note, and what would make it GO IN.'],
  ['Chart', 'See it', 'The confirmation chart at the flag\'s timeframe.'],
  ['Track', 'Follow it', 'Alerts on every change of that flag for 6 hours; the button turns into Untrack.'],
  ['Took it', 'Journal: open', 'Logs an open with the engine\'s levels and reference, and tracks the trade for TP1 / stop. A double tap logs once.'],
  ['Skipped', 'Journal: skip', 'Logs a skip against the same plan, so engine vs you counts it.'],
  ['Closed here · Partial · Still in', 'After a hit', 'On a TP1 or stop alert of a trade you took: journal the close (R vs your entry and stop), a partial at TP1, or keep watching.']
];

// ---------- ChatGPT ----------

// [command, what you get, chip, phone span, desktop span]
const GPT_COMMANDS = [
  ['signals', 'BTC, ETH and SOL, longs and shorts. The strongest actionable asset gets the full call: thesis, GO IN / HOLD / DON\'T, entry, stop, targets, size. Others get one NO TRADE line with the trigger to watch, plus a SETUP line when one exists. "trades" gives the same answer.', 'Start here', 2, 6],
  ['flags', 'Every flag candidate per asset on 1m / 3m / 5m, both directions, every state including failed and expired, with the qualifier\'s decision and reasons.', 'Full list', 2, 6],
  ['forming', 'Flags still building, both directions: Confirmation price, Thesis Eliminated price, when to check back. No entries or sizing.', 'Watchlist', 2, 4],
  ['why SYM', 'Ask in plain words, e.g. "why BTC". It cites the engine\'s supports, against, unknowns and reason codes verbatim; no call line.', 'Explain', 2, 4],
  ['trades', 'Same as signals.', 'Alias', 1, 4],
  ['log text', 'Writes a journal line: took = open, closed = close, skipped = skip, anything else = note. Only your numbers; replies [LOGGED id].', 'Journal', 1, 3],
  ['journal', 'Last 10 journal lines, one each.', 'Journal', 1, 3],
  ['balance', 'Account and performance blocks only.', 'Account', 1, 3],
  ['data check', 'Only the DATA block.', 'Freshness', 2, 3],
  ['track', 'With a screenshot or a described setup you are not in. Five lines: TRACK YES/NO, entry condition, window, thesis null, expected trade time.', 'Screenshot', 2, 12]
];

const GPT_WILL = [
  'Pull a fresh snapshot (getScalpContext) before every analysis and quote the engine\'s numbers exactly.',
  'Treat the engine plan as the trade authority: ready = eligible for GO IN, conditional = wait, rejected = DON\'T with the reason code.',
  'Size against your wallet and show wallet risk, $ loss at the stop and leverage under the max.',
  'Check stops, Thesis Eliminated and liquidation against the Pyth mark (where Jupiter fills and stops), and say so when mark drifts more than 10 bps from the close.',
  'Say "thin after fees" when a plan carries the net_rr_low warning (net R under 1R).'
];

const GPT_WONT = [
  'Invent a level. Entry, stop, TP1 and R:R come from the engine; the plan math is not the GPT\'s to redo.',
  'Call GO IN under 65%, widen a scalp stop past 3%, or lower any threshold on request. NO TRADE is a valid answer.',
  'Reuse prices from earlier in the chat, or claim a trade was executed. Nothing here executes.',
  'Treat confidence as win odds. It measures setup strength, not the chance it pays.'
];

// Reading the classes.
const CLASSES = [
  ['GOOD', 'Act-eligible', 'A ready plan (breakout close, then a retest close that held) and no hard block. The only class that can carry GO IN.'],
  ['SETUP', 'Wait', 'The best conditional plan at ≥ 2.5R gross, awaiting its retest or breakout. Includes confirmed flags rejected only for chasing: the trigger is a retest that holds. Never GO IN until it becomes GOOD.'],
  ['WATCH', 'Not yet', 'The best candidate so far, with the concrete change that would upgrade it (e.g. a close above a price, a measured move that clears 2.5R).'],
  ['BAD', 'No', 'A named disqualifier (chase, rr_below_min, room_at_entry, stop too wide…) and the remedy that would fix it.'],
  ['DATA_UNAVAILABLE', 'Don\'t trust', 'The snapshot is missing or stale. Ask again; never act on it.']
];

const DATA_BLOCK = [
  ['Generated At', 'Snapshot time', 'Should be minutes old. If not, ask again.'],
  ['Closed Through', 'Last closed candle', 'The engine reads closed candles only, so it can trail the live price by one candle.'],
  ['Wallet Updated At', 'Account read', 'Unavailable is not a zero balance.'],
  ['Schema / Config', 'Versions', 'Instruction schema 1.24.x and the engine configVersion. A config change marks a boundary on the tracker.'],
  ['Warnings', 'Read them', 'Any listed warning means ask again before acting.']
];

// ---------- rules in force ----------

// [rule, value, since, source]
const RULES = [
  ['Gross R:R floor', '≥ 2.5R to TP1, gross (price only)', '2026-09-24', 'D-variant revised (09-24); gross, not net: decision 1 (09-23)'],
  ['Net R gate', 'Off. Net R is shown on every plan; net_rr_low warning when net < 1R', '2026-09-24', 'D-variant revised (09-24)'],
  ['3R rule', 'Runs as a shadow comparator on the tracker (gross 3.0), never traded', '2026-09-24', 'D-variant revised (09-24)'],
  ['Ready', 'Breakout close, then one retest close that holds; the retest must not wick through the stop', '2026-09-23', 'Decision 2 (09-23); wick rule: T6 plan A3 (09-24)'],
  ['Room check', 'Candidate\'s own geometry timeframe only (15m for 1m-5m flags); the TP1 cap still reads every timeframe', '2026-09-24', 'Decisions 4a (09-23), 4b (09-24)'],
  ['Scalp stop cap', '≤ 3% from entry; wider is NO_TRADE', 'Standing', 'Owner rule, unchanged'],
  ['Costs (round trip)', 'Long 0.34% · short 0.14% (USDC-funded) · 0.20% when direction is unresolved', '2026-09-24', 'D-cost (09-24)'],
  ['Timeframe pairs', '4H → 1m / 3m / 5m (main) · 1H → 1m / 3m · 1D → 15m / 1H · 1W not traded', '2026-09-23', 'Decision 7 (09-23)'],
  ['Stops on mark', 'Stops, Thesis Eliminated and liquidation checked on the Pyth mark', '2026-09-23', 'Decision 5 (09-23)'],
  ['The call', '21/200 flag recommendation; legacy strategies shown, labeled legacy', '2026-09-23', 'Decision 6 (09-23)'],
  ['Testing window', '2026-09-23 → 2026-10-07; thresholds frozen until 2026-10-08; config boundary marked', '2026-09-23', 'D-variant revised (09-24)']
];

// ---------- tracker tiles ----------

const TRACKER_TILES = [
  ['Status', 'Is it running?', 'LIVE / DELAYED / STALLED from the last capture. Captures every 10 min; the page rebuilds every 30. The Alerts fact shows the last Telegram alert and the alerts cron\'s heartbeat.'],
  ['Testing timeline', 'How far along?', 'Day of 14 and plans scored toward 30. Thresholds stay frozen; the config-boundary line splits stats before and after the 2026-09-24 rule change.'],
  ['Expectancy', 'Is it paying?', 'Gross R per scored call over 7 days, with net R under it. Scored = a ready plan that reached TP1 or its stop on later candles.'],
  ['Class check', 'Did the filter work?', 'WATCH and BAD scored as if taken. If they beat GOOD, the filter is not earning its keep. Counterfactual only. GOOD calls come from the engine\'s 1-minute Telegram alert log, not just the 10-minute captures - a GOOD window can last under a minute.'],
  ['3R shadow', 'Was 2.5 the right call?', 'The former 3R rule scored beside the live 2.5 rule on the same candles. Never traded.'],
  ['Breakout shadow · flag paths · calibration', 'Measure only', 'Alternative entries and path forecasts, scored and never fed back into a rule.'],
  ['GOOD / hour · SETUPs / day', 'How often?', 'How often a GOOD or a SETUP actually shows up in the feed.'],
  ['Equity curve', 'The running total', 'Cumulative gross R of engine calls, your journal trades dashed beside it. Filters (symbol, timeframe, direction and more) narrow both.'],
  ['Wallet value', 'Your account', 'Wallet total over time with GOOD calls and your journal trades marked.'],
  ['Engine vs you', 'Did you follow it?', 'GOOD calls you took, skipped or overrode, from the journal.'],
  ['Calls · served calls', 'What was said', 'Open calls, the 7-day call log and by-day table. "Via" and "Seen in chat" mark calls a GPT or Telegram answer actually served.'],
  ['1-minute GOOD log', 'When it lands (T-12)', 'Planned: scoring GOOD calls straight from a 1-minute Telegram alert log, tighter than today\'s 10-minute capture cadence. Not yet merged into this build.']
];

// ---------- journal ----------

const JOURNAL = [
  ['From Telegram', 'Took it / Skipped buttons, or /log text. Records carry source "telegram".'],
  ['From ChatGPT', 'log text through the postJournal Action; journal reads back through getJournal.'],
  ['Kinds', 'open, close, adjust, skip, note. Unknown wording is a note; your text is always kept verbatim.'],
  ['Append-only', 'POST /api/journal adds a line; nothing is edited or deleted. A repeated id is stored once.'],
  ['Where it shows', 'Engine vs you, the journal log and the dashed line on the equity curve.']
];

// ---------- honest limits ----------

const LIMITS = [
  'GOOD calls never auto-execute. You tap Open (or Open early) and confirm with your PIN every time — nothing trades on its own.',
  'Execution stays capped small while live-testing: $20 size, 2x leverage, $2 loss/trade, $25/day, 1 open position — raised only by owner decision, never automatically. Full breakdown: Risk & sizing →.',
  'The engine\'s own analysis still can\'t see your open positions — give it entry, size, leverage and liquidation when you ask about one. Telegram\'s /positions is separate: a live on-chain read from the execution stack, isolated from what the GPT and MCP see.',
  'One 15-day window of data. Every rate, win percentage and expectancy on the tracker is provisional.',
  'At the old flat 0.20% cost, the 1m-5m flag styles showed negative net expectancy in replay. Fees are a real share of a tight scalp stop.',
  '1 GOOD per hour was about 10× the rate observed under the 3R rule. The 2.5R floor raises volume; it does not make that target realistic on its own.'
];

const AFTER_WINDOW = [
  'Thresholds unfreeze on 2026-10-08.',
  'One calibration pass with the owner: 2.5R live vs the 3R shadow on net expectancy, costs as paid, class check and engine vs you.',
  'Phase 2 starts after the window: failed-flag reversal scouts (a failed long opens a short scout, and the mirror), gated on the MISS_004 fixture.'
];

// ---------- markup ----------

const defList = (id, rows) => `<dl class="def-list" id="${id}">${rows.map(([term, chip, text]) => `<div class="def-row"><dt>${esc(term)}<span class="label">${esc(chip)}</span></dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;
const plainList = (id, items) => `<ul class="howto-list" id="${id}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function renderHowTo() {
  const topStrip = `<header class="edge-strip" id="howto-top-edge-strip"><span id="howto-page-title">EDITTRADES / HOW TO USE</span>`
    + `<a class="nav-link" id="howto-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('howto-jump-nav', [
      ['#howto-what-section', 'What'], ['#howto-routine-section', 'Routine'], ['#howto-telegram-section', 'Telegram'],
      ['#howto-chatgpt-section', 'ChatGPT'], ['#howto-rules-section', 'Rules'], ['#howto-tracker-section', 'Tracker'],
      ['#howto-journal-section', 'Journal'], ['#howto-limits-section', 'Limits'],
      ['index.html', '← Tracker', 'class="nav-link" id="howto-nav-back-link"'], ['risk.html', 'Risk & sizing →', 'class="nav-link" id="howto-nav-risk-link"'], ['changelog.html', 'System map →', 'class="nav-link" id="howto-nav-system-map-link"']
    ]);

  const what = zone({
    id: 'howto-what-section', title: 'What this is',
    tiles: [
      tile({
        id: 'howto-what-tile', lg: 8,
        body: `<h1 id="howto-intro-title">The engine calls. You decide.</h1>`
          + `<p class="howto-lede" id="howto-what-text">EditTrades reads closed candles for BTC, ETH and SOL and turns them into one call per symbol: GOOD, WATCH, BAD or DATA_UNAVAILABLE, plus a SETUP line when a conditional plan is waiting for its trigger. The engine owns every level: entry, stop, TP1 and R:R. You get the calls on your phone from the Telegram bot and in ChatGPT from the EditTrades Custom GPT; the tracker records them every 10 minutes and scores each one on the candles that follow. Telegram can place a trade from a call, but only when you tap Open and confirm with your PIN — the GPT and MCP still never execute anything.</p>`
      }),
      tile({
        id: 'howto-quickstart-tile', title: 'Quick start', lg: 4,
        body: `<div class="prompt-stack" id="howto-quickstart-prompts"><pre class="howto-prompt" id="howto-quick-telegram">Telegram · @EditTrades_Bot · tap Signals</pre><pre class="howto-prompt" id="howto-quick-signals">ChatGPT · signals</pre></div>`
          + `<p class="note" id="howto-quickstart-note">Both read the same engine snapshot. Telegram pushes; ChatGPT answers when asked.</p>`
      })
    ]
  });

  const routine = zone({
    id: 'howto-routine-section', title: 'Daily routine', sub: 'Phone first · 6 steps',
    tiles: ROUTINE.map(([title, text], i) => tile({
      id: `howto-routine-step-${i + 1}-tile`, as: 'div', lg: 4,
      body: `<span class="step-num" aria-hidden="true">${i + 1}</span><h3 class="tile-title">${esc(title)}</h3><p class="step-text">${esc(text)}</p>`
    }))
  });

  const menuKeys = `<div class="menu-keys" id="howto-telegram-menu-keys" role="img" aria-label="Telegram menu: ${esc(TG_MENU.flat().join(', '))}">`
    + TG_MENU.map((row, i) => `<div class="menu-row" id="howto-telegram-menu-row-${i + 1}">${row.map((k) => `<span class="menu-key" data-menu-key="${esc(k)}">${esc(k)}</span>`).join('')}</div>`).join('')
    + `</div>`;
  const telegram = zone({
    id: 'howto-telegram-section', title: 'Telegram', sub: '@EditTrades_Bot · owner only',
    tiles: [
      tile({
        id: 'howto-telegram-menu-tile', title: 'The menu', tag: 'Always on screen', lg: 5,
        body: menuKeys + `<p class="note" id="howto-telegram-menu-note">A persistent keyboard under the chat. Each key runs its command; Charts opens a symbol × timeframe grid with an All flags button.</p>`
      }),
      tile({
        id: 'howto-telegram-commands-tile', title: 'Commands', lg: 7,
        body: `<dl class="def-list" id="howto-telegram-commands-list">${TG_COMMANDS.map(([cmd, text]) => `<div class="def-row"><dt><span class="cmd-inline" data-tg-command="${esc(cmd)}">${esc(cmd)}</span></dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`
      }),
      tile({
        id: 'howto-telegram-clarity-tile', title: 'Reading the verdict line', tag: 'Every alert', lg: 12,
        body: defList('howto-telegram-clarity-verdicts-list', CLARITY_VERDICTS) + defList('howto-telegram-clarity-context-list', CLARITY_CONTEXT),
        foot: 'Kill if and Other side appear per alert when the engine has them; not every call carries both.'
      }),
      tile({
        id: 'howto-telegram-levels-tile', title: 'Alert levels', tag: '/alerts good|setup|watch', lg: 6,
        body: defList('howto-telegram-levels-list', TG_LEVELS) + plainList('howto-telegram-always-list', TG_ALWAYS)
      }),
      tile({
        id: 'howto-telegram-buttons-tile', title: 'Buttons on every alert', lg: 6,
        body: defList('howto-telegram-buttons-list', TG_BUTTONS),
        foot: 'Rows: Plan · Thesis · Chart, then Track · Took it · Skipped. /signals carries them per symbol block. A button on an alert older than the bot\'s memory answers [expired — send /signals].'
      }),
      tile({
        id: 'howto-telegram-execution-tile', title: 'Execution', tag: 'Dry run first · PIN · /kill', lg: 12,
        body: defList('howto-telegram-execution-list', TG_EXEC),
        foot: 'Off unless execution is enabled; then every execution button and command answers "Execution off". The GPT and MCP can never reach it.'
      })
    ]
  });

  const chatgpt = zone({
    id: 'howto-chatgpt-section', title: 'ChatGPT', sub: 'EditTrades Custom GPT · schema 1.24.x',
    tiles: [
      ...GPT_COMMANDS.map(([cmd, desc, chip, sm, lg]) => tile({
        id: `howto-cmd-${slug(cmd)}-tile`, as: 'div', sm, lg,
        body: `<div class="cmd-head"><div class="cmd-name" data-command="${esc(cmd)}">${esc(cmd)}</div><span class="prov-tag">${esc(chip)}</span></div><p class="cmd-desc">${esc(desc)}</p>`
      })),
      tile({ id: 'howto-gpt-will-tile', title: 'It will', lg: 6, body: plainList('howto-gpt-will-list', GPT_WILL) }),
      tile({
        id: 'howto-gpt-wont-tile', title: 'It won\'t', lg: 6, body: plainList('howto-gpt-wont-list', GPT_WONT),
        foot: 'Action operations: getScalpContext (the snapshot), postJournal and getJournal (the journal). Read-only toward the market.'
      }),
      tile({ id: 'howto-classes-tile', title: 'Reading GOOD / SETUP / WATCH / BAD', tag: 'Engine class', lg: 7, body: defList('howto-classes-list', CLASSES) }),
      tile({
        id: 'howto-data-block-tile', title: 'The DATA block', tag: 'Every trade answer ends with it', lg: 5, body: defList('howto-data-block-list', DATA_BLOCK)
      })
    ]
  });

  const rulesTable = `<div class="table-scroll" id="howto-rules-table-scroll"><table class="rules-table" id="howto-rules-table">`
    + `<thead><tr><th>Rule</th><th>Value</th><th>Since</th><th>Owner decision</th></tr></thead><tbody>`
    + RULES.map(([rule, value, since, src]) => `<tr id="howto-rule-${slug(rule)}-row"><td class="rule-name">${esc(rule)}</td><td class="rule-value">${esc(value)}</td><td>${esc(since)}</td><td class="rule-src">${esc(src)}</td></tr>`).join('')
    + `</tbody></table></div>`;
  const rules = zone({
    id: 'howto-rules-section', title: 'The rules in force', sub: 'Frozen until 2026-10-08',
    tiles: [tile({
      id: 'howto-rules-tile', title: 'Rules', tag: 'config 2026.09.24-5', body: rulesTable,
      foot: 'Sources: config/engine.json, docs/OWNER_DECISIONS_2026-09-23.md, docs/OWNER_DECISIONS_2026-09-24.md in the engine repo. The flag detector runs on 1m / 3m / 5m.'
    })]
  });

  const tracker = zone({
    id: 'howto-tracker-section', title: 'What the tracker shows', sub: 'One question per tile',
    tiles: [tile({
      id: 'howto-tracker-tiles-tile', title: 'Reading each tile', lg: 12,
      body: defList('howto-tracker-tiles-list', TRACKER_TILES)
        + `<p id="howto-tracker-link-row"><a class="nav-link" id="howto-tracker-link" href="index.html">Open the call tracker →</a></p>`,
      foot: 'Gross R is price only; net R subtracts the round-trip cost for the call\'s direction. Both are shown wherever a call is scored.'
    })]
  });

  const journal = zone({
    id: 'howto-journal-section', title: 'Journal', sub: 'POST /api/journal',
    tiles: [tile({
      id: 'howto-journal-tile', title: 'Your side of the record', lg: 12,
      body: `<dl class="def-list" id="howto-journal-list">${JOURNAL.map(([term, text]) => `<div class="def-row"><dt>${esc(term)}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`
    })]
  });

  const limits = zone({
    id: 'howto-limits-section', title: 'Honest limits', sub: 'And what changes on 2026-10-08',
    tiles: [
      tile({ id: 'howto-limits-tile', title: 'Not built, or not proven', lg: 7, body: plainList('howto-limits-list', LIMITS) }),
      tile({ id: 'howto-after-window-tile', title: 'On 2026-10-08', tag: 'After the window', lg: 5, body: plainList('howto-after-window-list', AFTER_WINDOW) })
    ]
  });

  const bottomStrip = `<footer class="edge-strip" id="howto-bottom-edge-strip"><span id="howto-footer-note">NOT FINANCIAL ADVICE · NOTHING EXECUTES WITHOUT YOUR PIN · YOU CONFIRM EVERY ORDER</span></footer>`;

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
${[what, routine, telegram, chatgpt, rules, tracker, journal, limits].join('\n')}
${bottomStrip}
</main>
</body>
</html>
`;
}
