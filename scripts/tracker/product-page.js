/**
 * EditTrades call tracker - "What EditTrades is" page (product.html), T-19.
 *
 * Plain-language product overview: what the system is, every strategy and its measured
 * record, the full capability list, honest limitations, goals, how to use the tracker, the
 * tech stack and architecture, and the product/revenue plan. Static reference copy (no data,
 * no scripts) in the same bento system as how-to.html (./bento.js, ./page-style.js). Sources:
 * docs/STATUS_2026-09-27.md, docs/STATUS_2026-09-26.md, CHANGELOG.md, docs/OWNER_DECISIONS_*,
 * docs/PLAN_*, docs/*_STUDY_*, docs/EDGE_SEARCH_2026-09-27.md, docs/HISTORY_2Y_2026-09-26.md,
 * docs/research/RESEARCH_BACKLOG.md, docs/MASTER_PLAN_TRADING_MODEL.md,
 * docs/MASTER_PLAN_NEXT_STEPS.md, docs/EDITTRADES_MCP_CONNECTOR.md, docs/ARCHITECTURE_MAP.json,
 * PRODUCT.md, package.json, vercel.json. Every performance number below carries its sample
 * size and a line-anchored GitHub blob link to its source doc - update both together when a
 * rule, number or module changes. Reuses content arrays already sourced and maintained in
 * how-to-page.js, risk-page.js and profileConfig.js rather than re-typing them (single source
 * of truth for command lists, caps and profile knobs).
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';
import {
  TG_COMMANDS, TG_LEVELS, TG_ALWAYS, TG_EXEC, TG_BUTTONS, GPT_COMMANDS, GPT_WILL, GPT_WONT,
  CLASSES, DATA_BLOCK, TRACKER_TILES, STUDIES, STUDIES_REPO
} from './how-to-page.js';
import { VENUE_FACTS, ENV_CAPS, WALLET_POLICY } from './risk-page.js';
import { PROFILES, PROFILE_KEYS } from './profileConfig.js';

const REPO = 'https://github.com/Bai-ee/snapshot_tradingview/blob/upgrade-signal-engine/';
const cite = (path, frag) => `${REPO}${path}${frag ? `#${frag}` : ''}`;
const srcLink = (label, path, frag) => `<a class="nav-link" href="${esc(cite(path, frag))}" target="_blank" rel="noopener">${esc(label)}</a>`;

// ---------- markup helpers (same conventions as how-to-page.js / risk-page.js) ----------
const defList = (id, rows) => `<dl class="def-list" id="${id}">${rows.map(([term, chip, text]) => `<div class="def-row"><dt>${esc(term)}${chip ? `<span class="label">${esc(chip)}</span>` : ''}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;
const plainList = (id, items) => `<ul class="howto-list" id="${id}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
const htmlList = (id, items) => `<ul class="howto-list" id="${id}">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;

// =====================================================================================
// 1. What EditTrades is
// =====================================================================================

const WHAT_TEXT = `EditTrades reads closed BTC, ETH and SOL candles and turns them into one market-context and trade-recommendation payload — the same payload behind a Custom GPT Action, one read-only MCP tool and a Telegram trading desk on Jupiter perps. A flag-pattern engine (21 EMA / 200 EMA) grades every setup GOOD, WATCH, BAD or DATA_UNAVAILABLE and never invents a level: entry, stop, TP1 and R:R come from the same rulebook every time, and a plan is never built from a candle that hasn't closed yet. A research harness studies every rule change against measured history before it ships — twelve studies since 2026-09-26 alone, most of which did <b>not</b> become a rule change — and a public tracker captures and scores every call the engine actually made, net of fees, so nothing is judged after the fact. Execution is opt-in and capped hard: nothing places an order without a tap and a PIN, and the caps ($150 size / 100x leverage / $5 per trade / $25 per day / 1 open position) move only by owner decision, never automatically. Today this is built for one person — the owner, checking once or twice a day — and "done" means a proven edge on the tracker's own numbers first, a product second: the data licensed to other GPTs and agents, or the signals sold as a subscription, never a promise sold ahead of the evidence.`;

function whatSection() {
  return zone({
    id: 'product-what-section', title: 'What EditTrades is',
    tiles: [tile({
      id: 'product-what-tile', lg: 12,
      body: `<h1 id="product-what-title">Closed candles in. One honest call out.</h1><p class="howto-lede" id="product-what-text">${WHAT_TEXT}</p>`,
      foot: 'Sources: PRODUCT.md, CLAUDE.md, docs/MASTER_PLAN_ENGINE_REFINEMENT.md.'
    })]
  });
}

// =====================================================================================
// 2. Strategies
// =====================================================================================

function strategyCard(id, opts) {
  const { title, tag, lg = 6, rule, levels, record, sources, status, statusClass = '' } = opts;
  const rows = levels ? defList(`${id}-levels`, levels) : '';
  const recordHtml = record ? `<p class="note" id="${id}-record">${record}</p>` : '';
  const srcHtml = sources && sources.length ? `<p class="note" id="${id}-sources">Sources: ${sources.join(' &middot; ')}</p>` : '';
  return tile({
    id, title, tag, lg,
    body: `<p id="${id}-rule">${rule}</p>${rows}${recordHtml}`
      + `<p class="status-word ${statusClass}" id="${id}-status">${esc(status)}</p>${srcHtml}`
  });
}

function strategiesSection() {
  const flag = strategyCard('product-strategy-flag21', {
    title: 'Flag engine 21/200', tag: 'LIVE · TRADABLE', lg: 12,
    rule: `The engine's live call: a continuation flag on the 21 EMA (1m/3m/5m), confirmed by a breakout close then one retest close that holds (a wick through the stop voids it). Gross R:R must clear ≥2.5R to TP1. Since 2026-09-27 (T-15) the stop is floored at <b>max(0.5× ATR(15m), 3× round-trip cost)</b> before every other gate, and a plan is ready only once net R:R also clears 1.0R — the fee-aware floor that used to run as a shadow now IS the live stop. Scalp stops (SCALP_1H, MICRO_SCALP) cap at 3% of entry; wider is a canonical NO_TRADE. Once a live position reaches +1R, an automatic trailing stop tightens toward price minus 1R every minute — tighten-only, never widens, one applied step per 5 minutes.`,
    levels: [
      ['Entry', '', 'The retest that holds — never the breakout candle itself'],
      ['Stop', '', 'Structure invalidation, or the fee-aware floor when that\'s tighter'],
      ['Target', '', 'TP1 at the gross ≥2.5R level; TP2 further out'],
      ['Exit', '', 'TP1, stop, the +1R trailing stop once armed, or 24h expiry unresolved'],
      ['Hold', '', 'Up to 24h to resolve once filled (score.js scoring window)'],
      ['Timeframe', '', '1m / 3m / 5m entries; 1h / 4h / 1d context for direction']
    ],
    record: `Before the floor, the first five scored GOOD calls were <b>+0.47R gross</b> but <b>−2.37R net</b> (n=5) — stops of 0.02–0.07% on BTC were smaller than Jupiter's own round-trip cost. The rule that shipped as T-15 (net floor + 1R trailing stop) measured <b>median net R −0.20, mean −0.0047, 61.11% win rate on n=30</b> live-rule signals in replay. A live 30-trade Steady evaluation on the real bot wallet started <b>2026-09-26T22:08Z at $523.14 equity</b>; it's judged at ≥40% wins and ≥2.5R net over those 30 trades.`,
    status: 'LIVE — in the 30-trade Steady evaluation window; thresholds frozen until 2026-10-08 except this floor, the trailing stop and the G1/G2 guardrails.',
    statusClass: 'st-good',
    sources: [
      srcLink('docs/PROMPT_T13_AGENT_J.md#L5', 'docs/PROMPT_T13_AGENT_J.md', 'L5'),
      srcLink('docs/VARIANTS_STUDY_2026-09-26.md#L85', 'docs/VARIANTS_STUDY_2026-09-26.md', 'L85'),
      srcLink('docs/PLAN_TELEGRAM_EXECUTION.md#L105', 'docs/PLAN_TELEGRAM_EXECUTION.md', 'L105'),
      srcLink('docs/OWNER_DECISIONS_2026-09-27.md', 'docs/OWNER_DECISIONS_2026-09-27.md')
    ]
  });

  const retest = strategyCard('product-strategy-retest1h', {
    title: 'RETEST 1H', tag: 'PAPER ONLY', lg: 6,
    rule: `A 1D+4h trend gate, entry on a close within 0.25× ATR(1h) of a breakout that holds. Stop is the tighter of (retest low − 0.1× ATR(1h)) or the structure invalidation, still NF-floored. Target is the measured move; the setup is skipped outright under 2.5R. Exit on stop, target, a 5-candle structure fail-back, or a 7-day cap.`,
    record: `<b>RETEST_ENTRY_STUDY_2026-09-27</b>: on a 2-year window, every rule tested — including its own random-direction control — came back net-median-negative in both out-of-sample halves (headline rule n=101 signals).`,
    status: 'PAPER ONLY — no Open button; the bot refuses retest orders until the promotion rule passes: ≥ 30 live signals, mean net R > 0 with the bootstrap 90% lower bound > 0, and max drawdown within the active profile’s daily/weekly limits.',
    statusClass: 'st-warn',
    sources: [srcLink('lib/retest1hRule.js#L8-L14', 'lib/retest1hRule.js', 'L8-L14'), srcLink('docs/OWNER_DECISIONS_2026-09-27.md', 'docs/OWNER_DECISIONS_2026-09-27.md'), srcLink('docs/RETEST_ENTRY_STUDY_2026-09-27.md', 'docs/RETEST_ENTRY_STUDY_2026-09-27.md')]
  });

  const spot = strategyCard('product-strategy-spot-ema20', {
    title: 'Spot EMA20 daily trend', tag: 'PAPER ONLY', lg: 6,
    rule: `Hold a coin (BTC/ETH/SOL, equal thirds) above its own daily EMA20, otherwise sit in USDC; a volatility-targeted weight sizes each coin, priced off Kraken's daily UTC close, 0.15% cost per unit of weight changed.`,
    record: `Equal-thirds portfolio, 2017→2026: buy &amp; hold CAGR 50% / max DD 88% / Sharpe 0.92; the EMA20 filter alone CAGR 73% / max DD 56% / Sharpe 1.39; EMA20 + the 40% vol-target actually tracked here CAGR 39% / max DD 37% / Sharpe 1.37. The rule was chosen on Oct 2024–Dec 2025 only — 2017–2024 and 2026 were unseen at selection time. It trails buy &amp; hold in strong bull years (2021 +725% vs +1150%) but cuts drawdown hard (2018 −4% vs −77%, 2022 −37% vs −80%).`,
    status: 'PAPER ONLY — long-or-cash against a daily close, no live execution; the paper-to-live step (P3) has not started.',
    statusClass: 'st-warn',
    sources: [srcLink('docs/EDGE_SEARCH_2026-09-27.md', 'docs/EDGE_SEARCH_2026-09-27.md'), srcLink('docs/MASTER_PLAN_NEXT_STEPS.md', 'docs/MASTER_PLAN_NEXT_STEPS.md')]
  });

  const aggressive = strategyCard('product-strategy-aggressive', {
    title: 'Aggressive profile', tag: 'VIRTUAL · TRACKED', lg: 6,
    rule: `The same engine calls, sized differently: 2.5%/trade default (ceiling 3%), 50% / 30% exposure caps, tier multipliers 2×/1×/0.5× for A/B/C, full stop-allowed leverage (Steady uses half). ${esc(PROFILES.aggressive.blurb)}`,
    status: 'VIRTUAL — tracked in parallel on every call since T-9 v2; never sizes a real order until the owner explicitly runs /risk profile aggressive + PIN.',
    statusClass: '',
    sources: [srcLink('scripts/tracker/profileConfig.js', 'scripts/tracker/profileConfig.js'), srcLink('scripts/tracker/strategies-page.js', 'scripts/tracker/strategies-page.js')]
  });

  const legacy = strategyCard('product-strategy-legacy', {
    title: 'Legacy SWING / TREND_4H', tag: 'EVALUATED · NOT SURFACED', lg: 6,
    rule: `Both are older strategies from <code>services/strategy.js</code>, from before the flag/21-200 engine existed. <b>SWING</b> is dead code in production: <code>services/scalpContext.js</code> never requests the 3D timeframe SWING's own gate needs, so it can never fire regardless of market conditions — zero signals in an 85-day replay. <b>TREND_4H</b> still computes and is shown in the payload, but the 2026-09-23 owner decision made the 21/200 flag recommendation "the call," so it's labeled legacy, not primary; on the same 85-day replay it was flat-to-negative gross (−0.06R, 149 resolved signals) before costs.`,
    status: 'Shown, labeled legacy. Neither is gated for promotion or gated by the freeze.',
    statusClass: 'dim',
    sources: [srcLink('docs/SWING_STUDY_2026-09-26.md#L56', 'docs/SWING_STUDY_2026-09-26.md', 'L56'), srcLink('docs/SIGNAL_GENERATION_SPECIFICATION.md#L229-L365', 'docs/SIGNAL_GENERATION_SPECIFICATION.md', 'L229-L365')]
  });

  const htf = strategyCard('product-strategy-htf-entry', {
    title: 'HTF-anchored entries', tag: 'IN BUILD · T-20', lg: 12,
    rule: `Owner decision 2026-09-27: direction comes from the 4H and 1D lean, the stop and target are built on 1h structure (so the stop is wide enough to survive fees), and the 1m / 5m flag is only the trigger that times the entry. Released live without a prior replay study, by owner call, and judged on the tracker like everything else: it must clear the same promotion bar (≥ 30 live signals, mean net R > 0, bootstrap 90% lower bound > 0) before it is treated as more than an experiment. Every HTF signal ships as a picture: the trade chart (entry, stop, target, 21/200 EMAs, RSI) with a fixed <b>WHAT TO DO</b> caption saying exactly what action the signal asks for, so a phone glance is enough.`,
    levels: [
      ['Direction', '', '4H and 1D lean must agree; no counter-trend entries'],
      ['Stop / target', '', '1h structure, NF-floored; target at least 2.5R gross'],
      ['Trigger', '', 'A 1m or 5m flag retest that holds, in the HTF direction'],
      ['Output', '', 'Chart image + WHAT TO DO caption on every alert and touchpoint']
    ],
    status: 'IN BUILD — not yet in the live payload or Telegram; schema will bump to 1.29.0 / config 2026.09.27-3 when it deploys.',
    statusClass: 'st-warn',
    sources: [srcLink('docs/PROMPT_T20_HTF_ENTRY.md', 'docs/PROMPT_T20_HTF_ENTRY.md'), srcLink('docs/OWNER_DECISIONS_2026-09-27.md', 'docs/OWNER_DECISIONS_2026-09-27.md')]
  });

  const candidates = tile({
    id: 'product-strategy-candidates', title: 'Candidates in the research backlog', tag: 'NOTHING BUILT LIVE', lg: 12,
    body: defList('product-strategy-candidates-list', [
      ['4H SMA200 (EXTERNAL_4H_SMA200_V1)', 'Card 1', 'Long when the closed 4H close is above SMA200, otherwise flat — no shorts, stops or targets. Verdict so far: paper candidate for spot long/flat, reject on perps. A paper arm in the spot tracker is currently blocked on the engine freeze.'],
      ['Quattro', 'Card 2', '4H Donchian breakout + daily EMA200 regime filter. Parked — the next external candidate after Card 1’s review, nothing built yet; restricted to spot or low-carry venues pending a real Jupiter-borrow recheck before any perps port.']
    ]),
    foot: `Source: ${'docs/research/RESEARCH_BACKLOG.md'} (Card 1 lines 10-73, Card 2 lines 76-91).`
  });

  return zone({
    id: 'product-strategies-section', title: 'Strategies', sub: 'One card each — entry, stop, target, exit, what the data says, status',
    tiles: [flag, htf, retest, spot, aggressive, legacy, candidates]
  });
}

// =====================================================================================
// 3. Capabilities and features
// =====================================================================================

// New facts not already covered by TG_EXEC (transaction landing, two-phase open, emergency
// close, exactly-once, G2 guardrail) - docs/PLAN_TELEGRAM_EXECUTION.md and
// docs/EDITTRADES_MCP_CONNECTOR.md / docs/PLAN_RISK_GUARDRAILS_2026-09-27.md.
const EXEC_MECHANICS = [
  ['Two-phase open', 'On Jupiter Perps v2, opening only submits an increase-position request; a keeper fills it seconds later, so stop-loss and take-profit can’t ride the same transaction as the open.'],
  ['Transaction landing', 'Every real send rebroadcasts the identical signed bytes every 2s while the outcome is unknown — it never re-signs, so a resend can only help a dropped send land, never execute twice. A send is only declared expired once the finalized block height has passed the transaction’s own validity window AND a fresh on-chain lookup still finds nothing.'],
  ['Naked-position handling', 'If attaching stops or verifying them fails after a fill, the executor immediately submits a full market close. If that close also fails: the kill switch engages, an alert fires, and the close keeps retrying every 5s for up to 45s.'],
  ['Exactly-once', 'Every order ticket is single-use (an 8-hex nonce that expires in 60s, guarded by a blob ETag), and the action id behind it is exactly-once — a slow Telegram redelivery of the same update cannot send an order twice.'],
  ['G2 guardrail', 'A plan whose stop is tighter than 0.1% is rejected outright (stop_distance_below_floor), and the payload’s own suggested sizing dropped from 2% to 0.5% of wallet risk to match the Steady profile — merged 2026-09-27 under the same owner freeze exception as the net floor.']
];

const CHART_FEATURES = [
  ['Entry / exit markers', 'A dashed white ENTRY marker and, once a trade closes, a dashed amber EXIT marker on the same chart, at GOOD/Plan, Took it, live fills and Closed here.'],
  ['RSI(14) panel', 'Ships alongside the entry/exit markers on every trade chart since T-16.'],
  ['NF stop line', 'The chart can draw a dashed "NF stop" line where the fee-aware floor differs from the plan’s own stop — but since the net floor went live (T-15) that value is always null now, so the floored stop is simply the chart’s one stop line; the dormant line is dead code, not a live feature.']
];

function capabilitiesSection() {
  const telegramCommands = tile({
    id: 'product-cap-telegram-commands', title: 'Telegram — commands', tag: '@EditTrades_Bot · owner only', lg: 7,
    body: defList('product-cap-telegram-commands-list', TG_COMMANDS.map(([cmd, text]) => [cmd, '', text]))
  });
  const telegramAlerts = tile({
    id: 'product-cap-telegram-alerts', title: 'Alerts, levels, quiet hours, focus mode', lg: 5,
    body: defList('product-cap-telegram-levels-list', TG_LEVELS) + plainList('product-cap-telegram-always-list', TG_ALWAYS.slice(0, 4))
  });
  const telegramButtons = tile({
    id: 'product-cap-telegram-buttons', title: 'Buttons on every alert', tag: 'Plan · Thesis · Chart · Track · Took it · Skipped', lg: 12,
    body: defList('product-cap-telegram-buttons-list', TG_BUTTONS)
  });
  const execution = tile({
    id: 'product-cap-execution', title: 'Execution', tag: 'Off unless TRADE_EXECUTION_ENABLED=true', lg: 12,
    body: defList('product-cap-execution-list', TG_EXEC)
      + `<p class="note" id="product-cap-execution-mechanics-intro">The mechanics underneath the ticket:</p>`
      + defList('product-cap-execution-mechanics-list', EXEC_MECHANICS.map(([a, b]) => [a, '', b])),
    foot: 'Sources: docs/PLAN_TELEGRAM_EXECUTION.md (two-phase open, transaction landing, naked-position handling, exactly-once), docs/EDITTRADES_MCP_CONNECTOR.md and docs/PLAN_RISK_GUARDRAILS_2026-09-27.md (G2). Never reachable from MCP or the GPT.'
  });
  const riskProfileRows = PROFILE_KEYS.map((k) => {
    const p = PROFILES[k];
    return [`${k === 'steady' ? 'Steady (default)' : 'Aggressive'}`, '', `${p.riskPctPerTrade}%/trade (ceiling ${p.riskPctCeiling}%) · exposure ${p.maxExposurePct}%/${p.maxPerSymbolPct}% · min stop ${p.minStopPct.long}% long / ${p.minStopPct.short}% short · daily/weekly drawdown kill ${p.dailyDrawdownPct}%/${p.weeklyDrawdownPct}% · peak drawdown kill ${p.peakDrawdownPct}% · goal +${p.goal.pctPer10Trades}%/10 trades · judged after ${p.evaluateAfterTrades} trades`];
  });
  const risk = tile({
    id: 'product-cap-risk', title: 'Risk', tag: 'Venue → env cap → wallet policy', lg: 12,
    body: `<div class="table-scroll"><table class="rules-table" id="product-cap-risk-venue-table"><thead><tr><th>Venue</th><th>Value</th><th>Source</th></tr></thead><tbody>`
      + VENUE_FACTS.map(([a, b, c]) => `<tr><td class="rule-name">${esc(a)}</td><td class="rule-value">${esc(b)}</td><td class="rule-src">${esc(c)}</td></tr>`).join('')
      + `</tbody></table></div>`
      + `<div class="table-scroll"><table class="rules-table" id="product-cap-risk-env-table"><thead><tr><th>Env cap (hard, live today)</th><th>Value</th><th>What it does</th></tr></thead><tbody>`
      + ENV_CAPS.map(([a, b, c]) => `<tr><td class="rule-name">${esc(a)}</td><td class="rule-value">${esc(b)}</td><td class="rule-src">${esc(c)}</td></tr>`).join('')
      + `</tbody></table></div>`
      + `<div class="table-scroll"><table class="rules-table" id="product-cap-risk-wallet-table"><thead><tr><th>Wallet-aware policy (/risk)</th><th>Value</th><th>What it does</th></tr></thead><tbody>`
      + WALLET_POLICY.map(([a, b, c]) => `<tr><td class="rule-name">${esc(a)}</td><td class="rule-value">${esc(b)}</td><td class="rule-src">${esc(c)}</td></tr>`).join('')
      + `</tbody></table></div>`
      + defList('product-cap-risk-profiles-list', riskProfileRows),
    foot: `Full walk-through with a worked sizing example: risk.html →. Profile comparison and live equity curves: strategies.html →.`
  });
  const charts = tile({
    id: 'product-cap-charts', title: 'Charts', lg: 6,
    body: defList('product-cap-charts-list', CHART_FEATURES)
  });
  const gptMcp = tile({
    id: 'product-cap-gpt-mcp', title: 'GPT Action + MCP', tag: 'Schema 1.28.0 · configVersion 2026.09.27-2', lg: 6,
    body: `<p class="note" id="product-cap-mcp-note">One read-only MCP tool, <code>get_scalp_context</code>, served stateless at <code>POST /api/mcp</code>, beside the key-protected <code>GET /api/scalp-context</code> Custom GPT Action. Both read the same <code>buildScalpContext()</code> and narrow it with the same <code>filterPayload()</code>; neither proxies the other, and journal reads/writes (<code>postJournal</code>/<code>getJournal</code>) exist only on the GPT Action's REST surface, never as an MCP tool.</p>`
      + defList('product-cap-gpt-commands-list', GPT_COMMANDS.map(([cmd, desc]) => [cmd, '', desc]))
      + plainList('product-cap-gpt-will-list', GPT_WILL)
      + plainList('product-cap-gpt-wont-list', GPT_WONT)
      + defList('product-cap-gpt-data-block-list', DATA_BLOCK),
    foot: `Source: ${'docs/EDITTRADES_MCP_CONNECTOR.md'}.`
  });
  const trackerCap = tile({
    id: 'product-cap-tracker', title: 'Tracker', tag: 'GOOD calls scored from the 1-minute alert log since 2026-09-25 (T-12)', lg: 12,
    body: defList('product-cap-tracker-list', TRACKER_TILES),
    foot: `Every class GOOD/SETUP/WATCH/BAD/DATA_UNAVAILABLE reads the same as on how-to.html →.`
  });
  const classesTile = tile({
    id: 'product-cap-classes', title: 'Reading GOOD / SETUP / WATCH / BAD', lg: 12,
    body: defList('product-cap-classes-list', CLASSES)
  });

  return zone({
    id: 'product-capabilities-section', title: 'Capabilities and features',
    tiles: [telegramCommands, telegramAlerts, telegramButtons, execution, risk, charts, gptMcp, classesTile, trackerCap]
  });
}

// =====================================================================================
// 4. Limitations, honestly
// =====================================================================================

function limitationsSection() {
  const noEdge = [
    `<b>No proven perps edge yet.</b> ${srcLink('docs/EDGE_SEARCH_2026-09-27.md', 'docs/EDGE_SEARCH_2026-09-27.md', 'L22-L30')}: "no edge (76 configs, search period)" and "no config is net-positive with t ≥ 1." ${srcLink('docs/MASTER_PLAN_NEXT_STEPS.md', 'docs/MASTER_PLAN_NEXT_STEPS.md', 'L13')} sums up the rest: the 2-year perps rule search, swing-timeframe rules, mean-reversion-at-zones and 2-year retest-entry all failed their own out-of-sample bar; the NF-stop-floor + trailing-stop combination is the one exception that changed a rule (T-15).`,
    `<b>Frequency is far below the owner's goal.</b> After the net floor the flag engine produces roughly 0.35 GOOD calls a day across all three coins, against a stated goal of 5–10 actionable calls a day. Frequency and expectancy pull against each other here: every filter that improved net R also cut the count. The HTF-anchored entry work (T-20) is the current attempt at more, wider-stopped calls.`,
    `<b>Fees vs. stop distance is the binding constraint.</b> Round-trip cost is 0.34% long / 0.14% short — wider than the stop on many of the flag engine's early calls, which is exactly what forced the net floor.`,
    `<b>Jupiter has three markets and keeper fills.</b> The venue supports BTC, ETH and SOL only, and every open is a two-phase keeper fill (seconds, not instant) — see Execution above.`,
    `<b>Capture history: 10-minute before 2026-09-25, then 1-minute.</b> The tracker's own capture cadence (2-5, sometimes under 1 minute) badly undercounted GOOD calls before the engine's 1-minute Telegram alert log became the scoring source (T-12).`,
    `<b>85 days vs. the 2-year backfill.</b> A 2-year, gap-free 1-minute fixture now exists (2024-10-01 → 2026-09-27, ~1.05M candles per symbol), but only three of the twelve studies below have actually rerun on it (the 2-year rerun itself, the edge search, and the 2-year retest-entry study). The other nine studies still rest on the original 85.5-day window — they sit alongside, not superseded by, the larger-sample confirmations, which reached the same "no edge" verdict at higher n.`,
    `<b>Sample sizes are small.</b> Examples: the conditions study is n=881 GOOD calls; the one cost-gate cell that passed out-of-sample is n=45-50; the shipped T-15 rule measured n=30; the 2-year rerun reaches n=2,994 total calls (BTC 1,041 / ETH 1,008 / SOL 945); retest-entry rules run on 38-101 signals each.`,
    `<b>Single owner, single wallet.</b> Telegram answers one owner only; execution touches exactly one bot wallet (~$520-523 today). Nothing here is multi-tenant.`,
    `<b>Paper only, today:</b> RETEST 1H, the Spot EMA20 filter (the paper-to-live step hasn't started) and the Aggressive wallet profile (never sizes a real order).`,
    `<b>The auto-trail doesn't show up on the tracking chart yet.</b> The T-15 trailing stop moves the live on-chain stop but doesn't write back into the tracked-flag state, so a trailed stop isn't reflected on that chart — a known follow-up, not done.`,
    `<b>The GPT's own instructions lag the schema.</b> The payload is schema 1.28.0; the Custom GPT's instructions box still documents 1.27.x and hasn't been re-audited to the current version.`
  ];

  return zone({
    id: 'product-limitations-section', title: 'Limitations, honestly',
    tiles: [
      tile({ id: 'product-limitations-tile', lg: 12, body: htmlList('product-limitations-list', noEdge) }),
      tile({
        id: 'product-limitations-studies-tile', title: 'The twelve studies', tag: '2026-09-26/27', lg: 12,
        body: `<ul class="howto-list" id="product-limitations-studies-list">${STUDIES.map(([file, text]) => `<li><a class="nav-link" href="${esc(STUDIES_REPO + file)}" target="_blank" rel="noopener">${esc(file.replace(/\.md$/, ''))}</a> — ${esc(text)}</li>`).join('')}</ul>`,
        foot: 'Most of these did not become a rule change. Full list and context: how-to.html → Research.'
      })
    ]
  });
}

// =====================================================================================
// 5. Goals
// =====================================================================================

function goalsSection() {
  const ownerModel = `The owner's own trading model states it plainly: <b>"expected win rate when following the model is about 3 in 10 ... every trade needs ≥ 3R available to the target"</b> ${srcLink('docs/MASTER_PLAN_TRADING_MODEL.md#L36', 'docs/MASTER_PLAN_TRADING_MODEL.md', 'L36')} (M-9), and flag targets are "usually around 3:1 reward to risk" ${srcLink('docs/MASTER_PLAN_TRADING_MODEL.md#L26', 'docs/MASTER_PLAN_TRADING_MODEL.md', 'L26')} (M-5b). Do the arithmetic on those two stated numbers — 0.3 × 3R − 0.7 × 1R — and sized right, that's <b>+0.2R gross expectancy per trade</b>. That figure isn't quoted anywhere verbatim; it's what M-9's own numbers imply.`;
  const stopImplication = `Getting a real 3R target without fees eating the trade means a stop wide enough to matter. The system already enforces that two ways: the net floor won't let a plan go live with a stop tighter than roughly 3× the round-trip cost (≈1.02% long / ≈0.42% short), and the wallet-strategy profiles independently floor stops even wider — 1.0-1.5% long / 0.7-1.0% short. Those distances sit more naturally on 1h-4h charts than the 1m-5m windows the flag engine hunts on — part of why RETEST 1H (1h) and Spot EMA20 (1d) exist as separate, paper-tracked experiments rather than changes to the flag engine itself.`;
  const steadyGoal = `Steady's descriptive goal (it never gates a trade): <b>+2% per 10 trades, +5-10% per month</b>. Aggressive's owner-set target is +25% per 10 trades — "expected to fail on a 30%/3R edge," tracked to test that exact claim.`;
  const evalRule = `Judge after <b>30 scored trades</b> on a profile (live-taken and as-if counted separately). Move up only at <b>≥40% wins and ≥2.5R net</b> across those 30. Steady stays live until it clears that bar.`;
  const research = `<b>Open, per the owner's own next-steps note</b> ${srcLink('docs/MASTER_PLAN_NEXT_STEPS.md#L15', 'docs/MASTER_PLAN_NEXT_STEPS.md', 'L15')}: the management study (does the wider net floor + trailing stop actually hold up net-positive over more live trades — the 30-trade Steady evaluation is the vehicle for that answer), the spot-trend paper-to-live step, a longer live-trading window before any further threshold change, the owner-only kill/arm live drill, and the journal/positions work deferred as later enhancements. Matched-random-entry controls (timing- and regime-matched, net of borrow) are parked in the research backlog as the reference test that should eventually supersede the simpler random-direction controls already run.`;

  return zone({
    id: 'product-goals-section', title: 'Goals',
    tiles: [
      tile({ id: 'product-goals-model-tile', title: 'The owner’s stated target', lg: 12, body: `<p id="product-goals-model-text">${ownerModel}</p><p class="note" id="product-goals-implication">${stopImplication}</p>` }),
      tile({ id: 'product-goals-steady-tile', title: 'The Steady goal', lg: 6, body: `<p id="product-goals-steady-text">${steadyGoal}</p>` }),
      tile({ id: 'product-goals-eval-tile', title: 'The evaluation rule', lg: 6, body: `<p id="product-goals-eval-text">${evalRule}</p>`, foot: 'Source: docs/PLAN_TELEGRAM_EXECUTION.md.' }),
      tile({ id: 'product-goals-research-tile', title: 'The research plan from here', lg: 12, body: `<p id="product-goals-research-text">${research}</p>` })
    ]
  });
}

// =====================================================================================
// 6. Tracking how-tos
// =====================================================================================

const PAGE_GUIDE = [
  ['index.html — Call tracker', '', 'Status, 7d/30d performance, charts, engine vs you, wallet-strategy teaser, open calls, alerts and the raw data tables.'],
  ['how-to.html — How to use', '', 'The daily routine, every Telegram command and button, the ChatGPT commands, the rules currently in force, the research list, and the honest limits.'],
  ['risk.html — Risk & sizing', '', 'The three layers that size a trade (venue, env cap, wallet policy), a worked sizing example, and why net R matters more than gross.'],
  ['strategies.html — Wallet strategies', '', 'Steady vs Aggressive side by side, which one is live, both profiles’ equity curves, and the 30-trade evaluation rule.'],
  ['spot.html — Spot trend', '', 'Today’s state per coin, the paper equity curve vs buy & hold, recent flips, and why the rule was chosen.'],
  ['changelog.html — System map', '', 'The architecture board (every module, grouped by stage) and the dated changelog.']
];

const CALL_SCORING = [
  ['Fill window', '', 'A call has 15 candles (~15 minutes) from its close to fill; if it never triggers in that window it scores not_filled.'],
  ['Resolution window', '', 'Once filled, a call has 24 hours to hit TP1 or its stop; still open after that scores expired.'],
  ['Net R', '', 'Gross R (price only) minus the round-trip cost for that call’s direction (0.34% long / 0.14% short). Shown wherever a call is scored.'],
  ['"Scored"', '', 'A ready plan that actually reached TP1 or its stop on the candles that followed — the only calls counted into win rate and expectancy.']
];

const CURVE_CONSTRUCTION = [
  'The real wallet curve is reconstructed from journal open/close records at their stamped riskUsd — the bot wallet’s actual trade sequence.',
  'Each profile’s virtual "live" curve compounds only the trades actually taken, sized at that profile’s own tier at the time.',
  'Each profile’s "as-if" curve sizes every scored GOOD call — taken or not — off a running virtual equity at tier B, a simplification, not the exact tier a live order of that call would have gotten.'
];

const REGEN_SCRIPTS = ['tracker:collect', 'tracker:score', 'tracker:paths', 'tracker:calibration', 'tracker:shadow', 'tracker:nf-shadow', 'tracker:page', 'tracker:sync', 'tracker:changelog'];

function howtoSection() {
  return zone({
    id: 'product-howto-section', title: 'Tracking how-tos',
    tiles: [
      tile({ id: 'product-howto-pages-tile', title: 'Reading each page', lg: 12, body: defList('product-howto-pages-list', PAGE_GUIDE) }),
      tile({ id: 'product-howto-scoring-tile', title: 'What a "call" is and how it’s scored', lg: 6, body: defList('product-howto-scoring-list', CALL_SCORING) }),
      tile({ id: 'product-howto-follow-tile', title: 'Following a trade, alert to journal', lg: 6, body: `<p id="product-howto-follow-text">Alert arrives → tap Plan → tap Thesis → tap Chart → decide → Took it or Skipped, which journals the decision and (if taken) tracks the trade to TP1 or stop → check the tracker once a day. Full routine: how-to.html →.</p>` }),
      tile({ id: 'product-howto-curves-tile', title: 'How the equity and wallet curves are built', lg: 12, body: plainList('product-howto-curves-list', CURVE_CONSTRUCTION) }),
      tile({
        id: 'product-howto-regen-tile', title: 'Regenerating anything', lg: 12,
        body: `<p id="product-howto-regen-text">Each step of the pipeline is its own script: ${REGEN_SCRIPTS.map((s) => `<code>npm run ${esc(s)}</code>`).join(', ')}. Running <code>tracker:page</code> alone rebuilds every page (including this one) from whatever data is already on disk.</p>`
      })
    ]
  });
}

// =====================================================================================
// 7. Tech stack and architecture
// =====================================================================================

// Core engine stages from docs/ARCHITECTURE_MAP.json, roles quoted verbatim from the map.
const STACK_STAGES = [
  {
    id: 'market-data', title: 'Market data', purpose: 'Pulls closed candles, the Pyth mark and the wallet balance, and checks the data is fresh.',
    modules: [
      ['services/marketData.js', 'Fetches closed BTC/ETH/SOL candles from Kraken (Bitfinex as fallback) for every timeframe and hands them to the indicator step.'],
      ['lib/pythMark.js', 'Reads the live Pyth price the perps venue fills and liquidates on, so you can see how far it sits from the candle close.'],
      ['services/walletTracker.js', 'Reads your trading wallet’s stablecoin margin and holdings (read-only, no keys) so sizing and P&L use your real capital.'],
      ['lib/freshness.js', 'Decides whether the newest candle is recent enough to trade on; stale data can never produce a ready plan.'],
      ['lib/retest1hRule.js', 'The 1h flag-retest entry rule (1D+4h trend gate, retest within 0.25 ATR, NF-floored stop, measured-move TP); one implementation shared by research and the live alert.'],
      ['lib/slowTrendSpot.js', 'Daily SMA140 spot regime per symbol; alerts only when the regime flips (stand-in for the research 4h SMA840 rule).']
    ]
  },
  {
    id: 'indicators-geometry', title: 'Indicators & geometry', purpose: 'Turns candles into EMAs, Stoch RSI, ATR, swings, zones, diagonals and channels.',
    modules: [
      ['services/indicators.js', 'Computes EMA21/EMA200, Stoch RSI and trend per timeframe and hands them to every later step.'],
      ['lib/structure.js', 'Finds swing highs and lows and session levels, the plain structure you would mark by hand.'],
      ['lib/advancedIndicators.js', 'Supplies the shared ATR (and VWAP/Bollinger helpers) that stops and geometry are measured in.'],
      ['lib/geometry.js', 'Draws the chart for the engine: pivots, horizontal zones, diagonals, channels and room to the next level, the same way for longs and shorts.']
    ]
  },
  {
    id: 'pattern-detection', title: 'Pattern detection', purpose: 'Finds momentum flags and coils, tracks their lifecycle and labels each one.',
    modules: [
      ['lib/patternDetector.js', 'Spots continuation flags (impulse, tight pullback, EMA21 hold, break) on 1m/3m/5m and says what state each one is in.'],
      ['lib/patternLifecycle.js', 'Snaps each flag’s breakout and kill levels to real zones, merges bull/bear pairs into coils, and says when to look at a chart first.'],
      ['lib/candidateQualifier.js', 'Labels each flag watch / wait / don’t / actionable from room, conflict, exhaustion and the 4h lean, without changing the flag.']
    ]
  },
  {
    id: 'bias-topdown', title: 'Bias & top-down', purpose: 'Says which way each higher timeframe leans and whether a setup trades with or against it.',
    modules: [
      ['lib/biasMatrix.js', 'Scores each timeframe’s lean and marks every flag and strategy as with or against the higher timeframes, plus its room to the next zone.'],
      ['lib/topDown.js', 'Rolls the weekly, daily, 4h and 1h leans into one sentiment with a conviction score, higher timeframes weighted most.']
    ]
  },
  {
    id: 'trade-plan', title: 'Trade plan', purpose: 'Turns one confirmed flag into exact entry, stop, targets and R:R, or a reason not to trade.',
    modules: [
      ['lib/flagTradePlan.js', 'Builds the one trade you can act on: entry, stop, TP1/TP2, gross and net R:R after fees, and ready / conditional / rejected with a reason; also runs the V-B shadow variant.'],
      ['lib/riskEngine.js', 'Works out dollar loss at the stop, position size and the highest safe leverage for each setup against your margin.'],
      ['services/strategy.js', 'The older strategy engine (4h trend, 1h scalp, swing, micro-scalp): its own entries and stops, scalp stops capped at 3%.'],
      ['config/engine.json', 'The rulebook: every threshold (2.5R gross minimum, the NF stop floor with its 1.0R net gate, 3% scalp stop cap, fees, timeframes) in one file with a configVersion (2026.09.27-2 live).']
    ]
  },
  {
    id: 'recommendation', title: 'Recommendation', purpose: 'Grades the plan GOOD / WATCH / BAD with reasons and a measured-history outlook.',
    modules: [
      ['lib/flagRecommendation.js', 'Gives the call its class (GOOD, WATCH, BAD or DATA_UNAVAILABLE) with what supports it, what argues against it and what would change it, plus a clarity block.'],
      ['lib/modelEvidence.js', 'Collects the 21/200 evidence (EMA map, channels, divergence) the recommendation reads; shown in full with include=model.'],
      ['lib/pathOutlook.js', 'Says what usually happens next for the live flag (retest, runner, false break...) from measured history with a sample size; info only.']
    ]
  }
];

// Live vs legacy api/*.js (docs/ARCHITECTURE_MAP.json "delivery" and "legacy" stages).
const API_LIVE = [
  ['api/scalp-context.js', 'The GPT Action endpoint: checks the API key, returns the payload or a chart image, and records what was served.'],
  ['api/journal.js', 'Stores the trades you tell the GPT about (log / journal) and returns the latest ones; never executes anything.'],
  ['api/telegram-webhook.js', 'Answers your Telegram commands from the same context build and journals /log lines; never executes anything on its own.'],
  ['api/telegram-cron.js', 'Runs every minute, compares the fresh context with stored state and sends only new GOOD, new SETUP, GOOD-ended and lasting data/mark alerts.'],
  ['api/health.js', 'A ping that says the deployment is up; no market data.'],
  ['/api/mcp', 'No file of its own — vercel.json rewrites it to api/scalp-context.js?__mcp=1, keeping the project inside its 12-function layout.']
];
const API_LEGACY = ['api/analyze.js', 'api/analyze-compact.js', 'api/analyze-full.js', 'api/indicators.js', 'api/scan.js', 'api/agent-review.js', 'api/parse-trade-image.js', 'api/execute-trade.js'];

// Test counts drift every phase; rather than freeze a stale number here (EDITTRADES_MCP_CONNECTOR.md
// carries a dated per-suite table that was already 4 days stale on its own last-updated date),
// this page states the deploy-gate policy and points to CHANGELOG.md for the count at any given change.
const TEST_COUNTS_NOTE = 'Every `npm run test:*` script (over 40 suites, several thousand assertions) runs green before a deploy; the four in the gate below run first. Exact per-suite counts drift often enough that they’re not worth freezing on this page — see CHANGELOG.md for the count at any given change.';

function stackSection() {
  const stageTiles = STACK_STAGES.map((s) => tile({
    id: `product-stack-${s.id}`, title: s.title, lg: 6,
    body: `<p class="note" id="product-stack-${s.id}-purpose">${esc(s.purpose)}</p>${defList(`product-stack-${s.id}-list`, s.modules.map(([p, r]) => [p, '', r]))}`
  }));

  const apiTile = tile({
    id: 'product-stack-api', title: 'Vercel functions', tag: 'Vercel Pro · 12-function layout', lg: 12,
    body: `<p class="note" id="product-stack-api-live-note">Live and routed (vercel.json):</p>${defList('product-stack-api-live-list', API_LIVE.map(([p, r]) => [p, '', r]))}`
      + `<p class="note" id="product-stack-api-legacy-note">Off the live path — Nov–Dec 2025 dashboard/scanner/AI-agent/trading code; nothing here feeds the live call: ${API_LEGACY.map((f) => `<code>${esc(f)}</code>`).join(', ')}.</p>`,
    foot: `Sources: vercel.json, ${srcLink('docs/ARCHITECTURE_MAP.json', 'docs/ARCHITECTURE_MAP.json')}, ${srcLink('docs/EDITTRADES_MCP_CONNECTOR.md', 'docs/EDITTRADES_MCP_CONNECTOR.md')}.`
  });

  const infraTile = tile({
    id: 'product-stack-infra', title: 'Infrastructure', lg: 6,
    body: defList('product-stack-infra-list', [
      ['Runtime', '', 'Node ESM on Vercel functions (Pro plan; the Telegram webhook runs with a 300 s budget so a two-phase open, keeper fill and stop attach finish inside one request).'],
      ['Storage', '', 'Vercel Blob for journal, execution audit, tickets and telegram state — no database.'],
      ['Market data', '', 'Kraken OHLC (Bitfinex fallback), Pyth Hermes for the live mark, Binance for research history capture.'],
      ['Chain', '', '@solana/kit + jup-perps-client (patched via patch-package) for Jupiter perps quotes, custody reads and position opens.'],
      ['Messaging', '', 'Telegram Bot API — a webhook for commands/buttons and a 1-minute cron for alerts and the trailing stop.'],
      ['Charts', '', 'pureimage, server-rendered PNGs.'],
      ['Distribution', '', 'ChatGPT Custom GPT Action (OpenAPI) and MCP; GitHub Actions + Pages for this tracker site.']
    ])
  });

  const testsTile = tile({
    id: 'product-stack-tests', title: 'Tests and the deploy gate', lg: 6,
    body: `<p class="note" id="product-stack-tests-note">${TEST_COUNTS_NOTE}</p>`
      + `<p class="note" id="product-stack-gate-note">The deploy gate is <code>test:sltp</code>, <code>test:scalp</code>, <code>test:mcp</code> and <code>test:wallet</code>; all suites run before any deploy. <code>git diff --check</code> on touched files.</p>`
  });

  const sessionTile = tile({
    id: 'product-stack-sessions', title: 'How sessions and agents work on it', lg: 12,
    body: `<p id="product-stack-sessions-text">One orchestrator thread owns live orders, env and deploys. Every other agent session: never places or confirms a Telegram order, never deploys or touches Vercel env, stages files by name (never <code>git add -A</code>), and works in its own git worktree if it touches a file another session has open. Engine rules and thresholds are frozen (currently until 2026-10-08) — sessions do presentation, routing and execution-plumbing work in that window, not rule changes. Research docs are pushed to the shared branch the same day they’re written, even when the code stays local.</p>`,
    foot: `Source: ${'docs/AGENT_SESSION_RULES.md'}.`
  });

  return zone({
    id: 'product-stack-section', title: 'Tech stack and architecture',
    tiles: [...stageTiles, apiTile, infraTile, testsTile, sessionTile]
  });
}

// =====================================================================================
// 8. Product and revenue plan
// =====================================================================================

function revenueSection() {
  const trades = `<b>Own wallet, then managed/copy execution for others.</b> Today: one bot wallet (~$520-523), capped hard, in the middle of its first 30-trade Steady evaluation (started 2026-09-26T22:08Z). Blocked until that evaluation — or a stronger one on more history — actually clears its own bar (≥40% wins and ≥2.5R net over 30 trades), and, honestly, none of the twelve studies above have found a net-positive perps edge on two years of history yet. A 30-trade window on one wallet is a start, not proof.`;
  const data = `<b>Sell the context, the recommendation and the tracker record</b> to other GPTs and agents. What’s actually unique: closed-candle discipline (never a call from an unclosed candle), a scored public track record with nothing hidden after the fact, plain-language clarity lines (kill-if / other side), and net-of-fee R shown everywhere gross is. The pipeline is already live, read-only, and metered by nothing but one shared API key today — the blocker here is packaging (per-customer keys, rate limits, pricing), not proof of an edge, since the free scored tracker is already the funnel: anyone can already see the whole record for free.`;
  const signals = `<b>Telegram alerts as a subscription.</b> The offer would be the same GOOD/SETUP alerts and journal/tracking tooling the owner already gets. Why not yet: no proven edge (same twelve studies), and the closest existing template for "prove it before it’s offered" is RETEST 1H's own promotion rule (≥30 live signals, mean net R > 0, bootstrap 90% lower bound > 0) — scoped to one signal, not a general readiness bar. The honest way to sell this, per the product's own design principles, is to publish the tracker and sell the tooling and the record, never a promise.`;
  const bar = [
    'A strategy clears its own stated evaluation bar — Steady’s ≥40% wins / ≥2.5R net over 30 trades, or RETEST 1H’s ≥30 signals / mean net R > 0 / bootstrap 90% LB > 0 — on real results, not paper.',
    'That result holds up on the 2-year history, not just a 30-trade window: every 85-day study’s "no edge" conclusion has so far been confirmed, not reversed, when rerun at 2-year scale.',
    'Metering, per-customer keys and billing exist for the data/MCP route — none of this is built today.'
  ];

  return zone({
    id: 'product-revenue-section', title: 'Product and revenue plan', sub: 'Three routes, what each needs, what blocks it today',
    tiles: [
      tile({ id: 'product-revenue-trades-tile', title: 'Trades', lg: 4, body: `<p id="product-revenue-trades-text">${trades}</p>` }),
      tile({ id: 'product-revenue-data-tile', title: 'Data / MCP', lg: 4, body: `<p id="product-revenue-data-text">${data}</p>` }),
      tile({ id: 'product-revenue-signals-tile', title: 'Signals engine', lg: 4, body: `<p id="product-revenue-signals-text">${signals}</p>` }),
      tile({
        id: 'product-revenue-bar-tile', title: 'What has to be true before charging anyone', lg: 12,
        body: plainList('product-revenue-bar-list', bar),
        foot: 'This bar is inferred from the evaluation/promotion gates already built into the code (above) — there is no owner-stated business rule for it in any decision log. The product framing itself (data over signals, net over gross, the trade stays yours) is PRODUCT.md.'
      })
    ]
  });
}

// =====================================================================================
// page shell
// =====================================================================================

export function renderProduct() {
  const topStrip = `<header class="edge-strip" id="product-top-edge-strip"><span id="product-page-title">EDITTRADES / WHAT IT IS</span>`
    + `<a class="nav-link" id="product-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('product-jump-nav', [
      ['#product-what-section', 'What'], ['#product-strategies-section', 'Strategies'], ['#product-capabilities-section', 'Capabilities'],
      ['#product-limitations-section', 'Limitations'], ['#product-goals-section', 'Goals'], ['#product-howto-section', 'How-to'],
      ['#product-stack-section', 'Stack'], ['#product-revenue-section', 'Revenue'],
      ['index.html', '← Tracker', 'class="nav-link" id="product-nav-back-link"'], ['how-to.html', 'How to use →', 'class="nav-link" id="product-nav-howto-link"'],
      ['risk.html', 'Risk & sizing →', 'class="nav-link" id="product-nav-risk-link"'], ['strategies.html', 'Wallet strategies →', 'class="nav-link" id="product-nav-strategies-link"'],
      ['spot.html', 'Spot trend →', 'class="nav-link" id="product-nav-spot-trend-link"'], ['changelog.html', 'System map →', 'class="nav-link" id="product-nav-system-map-link"']
    ]);

  const bottomStrip = `<footer class="edge-strip" id="product-bottom-edge-strip"><span id="product-footer-note">NOT FINANCIAL ADVICE · NO PROVEN EDGE YET · THE DATA IS THE PRODUCT, THE TRADE IS YOURS</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades — What It Is</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
.status-word{font:400 var(--fs-sm)/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em}
</style>
</head>
<body>
<main id="product-page-main">
${topStrip}
${[whatSection(), strategiesSection(), capabilitiesSection(), limitationsSection(), goalsSection(), howtoSection(), stackSection(), revenueSection()].join('\n')}
${bottomStrip}
</main>
</body>
</html>
`;
}
