/**
 * EditTrades call tracker - "Wallet strategies" page (strategies.html), T-9 v2 P5.
 *
 * The two wallet-management profiles (lib/execution/riskPolicy.js PROFILES) side by side,
 * which one is live (Telegram /risk profile), the real bot-wallet equity curve with both
 * profiles' virtual curves overlaid (./profiles.js `computeProfileCurves`), trades toward
 * each profile's 30-trade evaluation, and the evaluation rule itself. Laid out in the same
 * bento system as how-to.html (./bento.js, ./page-style.js).
 *
 * Data-driven (unlike how-to.html / a plain reference page): every number here comes from
 * `data` (already-synced/scored tracker files, see ./profiles.js), not hand-typed copy.
 *
 * Separate page from risk.html (scripts/tracker/risk-page.js, T-14's static "Risk & sizing"
 * reference) — the two were built independently for the same slot and split into two pages
 * rather than merged; each links to the other.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';
import { PROFILES, PROFILE_KEYS } from './profileConfig.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const usd = (v) => (isNum(v) ? `$${v.toFixed(2)}` : '–');
const pct = (v) => (isNum(v) ? `${v}%` : '–');

const LABEL = Object.freeze({ steady: 'Steady', aggressive: 'Aggressive' });
const COLOR = Object.freeze({ real: 'var(--text-primary)', steady: 'var(--success)', aggressive: 'var(--accent)' });

// ---------- profile comparison table ----------

const KNOB_ROWS = [
  ['Risk per trade (default)', (p) => pct(p.riskPctPerTrade)],
  ['Risk per trade (owner override ceiling)', (p) => pct(p.riskPctCeiling)],
  ['Max exposure (all open positions)', (p) => pct(p.maxExposurePct)],
  ['Max exposure (one symbol)', (p) => pct(p.maxPerSymbolPct)],
  ['Daily drawdown -> kill switch', (p) => pct(p.dailyDrawdownPct)],
  ['Weekly drawdown -> kill switch', (p) => pct(p.weeklyDrawdownPct)],
  ['Min stop, long (fee floor)', (p) => pct(p.minStopPct.long)],
  ['Min stop, short (fee floor)', (p) => pct(p.minStopPct.short)],
  ['Tier multiplier — A / B / C', (p) => `${p.tierMultipliers.A}x / ${p.tierMultipliers.B}x / ${p.tierMultipliers.C}x`],
  ['Boost cap (one-time, next tier)', (p) => `${p.boostMax}x`],
  ['Leverage for non-A tiers', (p) => (p.leverageRule === 'half' ? 'half the stop-allowed max' : 'the full stop-allowed max')],
  ['Goal', (p) => `+${p.goal.pctPer10Trades}% / 10 trades${Array.isArray(p.goal.pctPerMonth) ? ` (+${p.goal.pctPerMonth[0]}–${p.goal.pctPerMonth[1]}%/mo target)` : ''}`],
  ['Judged after', (p) => `${p.evaluateAfterTrades} scored trades`]
];

function profileTable() {
  const head = `<tr><th scope="col">Knob</th>${PROFILE_KEYS.map((k) => `<th scope="col">${esc(LABEL[k])}</th>`).join('')}</tr>`;
  const rows = KNOB_ROWS.map(([label, fn]) => `<tr><th scope="row">${esc(label)}</th>${PROFILE_KEYS.map((k) => `<td>${esc(fn(PROFILES[k]))}</td>`).join('')}</tr>`).join('');
  return `<table class="strategies-profile-table" id="strategies-profile-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`
    + `<p class="note" id="strategies-profile-blurb-steady"><b>${esc(LABEL.steady)}</b> — ${esc(PROFILES.steady.blurb)}</p>`
    + `<p class="note" id="strategies-profile-blurb-aggressive"><b>${esc(LABEL.aggressive)}</b> — ${esc(PROFILES.aggressive.blurb)}</p>`;
}

// ---------- equity curve chart (real + both profiles' live curves, same trade sequence) ----------

function sparklineSvg(series, { width = 560, height = 180 } = {}) {
  const vals = series.flatMap((s) => s.points.map((p) => p.equityUsd)).filter(isNum);
  if (vals.length < 2) return '<p class="note" id="strategies-curve-empty">No closed execution trades yet — the curve starts once the first one closes.</p>';
  const pad = 10;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const xAt = (i, len) => pad + (len > 1 ? (i / (len - 1)) * (width - pad * 2) : 0);
  const yAt = (v) => height - pad - ((v - min) / range) * (height - pad * 2);
  const lines = series.filter((s) => s.points.length > 1).map((s) => {
    const pts = s.points.map((p, i) => `${xAt(i, s.points.length).toFixed(1)},${yAt(p.equityUsd).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" />`;
  }).join('');
  const legend = series.map((s) => `<span class="strategies-curve-legend-item"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Equity curves: ${esc(series.map((s) => s.label).join(', '))}">${lines}</svg>`
    + `<div class="strategies-curve-legend" id="strategies-curve-legend">${legend}</div>`;
}

function curveZone(data) {
  const real = (data && data.real && data.real.points) || [];
  const steady = (data && data.profiles && data.profiles.steady && data.profiles.steady.live.points) || [];
  const aggressive = (data && data.profiles && data.profiles.aggressive && data.profiles.aggressive.live.points) || [];
  const chart = sparklineSvg([
    { key: 'real', label: 'Real wallet', color: COLOR.real, points: real },
    { key: 'steady', label: 'Steady (virtual)', color: COLOR.steady, points: steady },
    { key: 'aggressive', label: 'Aggressive (virtual)', color: COLOR.aggressive, points: aggressive }
  ]);
  const rows = PROFILE_KEYS.map((k) => {
    const p = (data && data.profiles && data.profiles[k]) || { live: { trades: 0, expectancyR: null }, asIf: { trades: 0, expectancyR: null }, evaluateAfterTrades: PROFILES[k].evaluateAfterTrades };
    return `<tr><th scope="row">${esc(LABEL[k])}</th>`
      + `<td>${p.live.trades} / ${p.evaluateAfterTrades}</td><td>${isNum(p.live.expectancyR) ? `${p.live.expectancyR}R` : '–'}</td>`
      + `<td>${p.asIf.trades}</td><td>${isNum(p.asIf.expectancyR) ? `${p.asIf.expectancyR}R` : '–'}</td></tr>`;
  }).join('');
  const table = `<table class="strategies-profile-table" id="strategies-trade-count-table">`
    + `<thead><tr><th scope="col">Profile</th><th scope="col">Live-taken trades / 30</th><th scope="col">Live expectancy (gross R)</th><th scope="col">As-if GOOD calls scored</th><th scope="col">As-if expectancy (gross R)</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
  return zone({
    id: 'strategies-curves-section', title: 'Equity curves', sub: `Starting from $${data ? data.startEquityUsd : 520} — the bot wallet's approximate starting equity`,
    tiles: [
      tile({ id: 'strategies-curve-chart-tile', title: 'Real wallet vs. both profiles, virtually', lg: 12, body: chart }),
      tile({
        id: 'strategies-trade-counts-tile', title: 'Trades toward the 30-trade judgment', lg: 12, body: table,
        foot: 'Live-taken = trades actually placed through the bot, sized off that profile\'s stamped riskUsd at open. As-if = every scored GOOD call, taken or not, sized off a running virtual equity at tier B — a simplification (see profiles.js), not the exact tier a live order of that call would have gotten.'
      })
    ]
  });
}

function evaluationZone() {
  return zone({
    id: 'strategies-evaluation-section', title: 'The evaluation rule',
    tiles: [tile({
      id: 'strategies-evaluation-tile', lg: 12,
      body: `<p id="strategies-evaluation-text">Judge after 30 scored trades on a profile (live-taken and as-if counted separately, above). Move up only at <b>&ge;40% wins and &ge;2.5R net</b> across those 30. <b>Steady</b> is the default and stays live until it clears that bar; <b>Aggressive</b> is defined and tracked in parallel on every call so the comparison exists from day one, but only runs live once the owner switches to it (Telegram <code>/risk profile aggressive PIN</code>) — never automatically.</p>`
    })]
  });
}

function liveZone(liveProfileKey) {
  const key = PROFILE_KEYS.includes(liveProfileKey) ? liveProfileKey : 'steady';
  return zone({
    id: 'strategies-live-section', title: 'Which one is live',
    tiles: [tile({
      id: 'strategies-live-tile', lg: 12,
      body: `<p id="strategies-live-text">Live right now: <b id="strategies-live-profile-name">${esc(LABEL[key])}</b>. New orders size off this profile; the other is tracked in parallel on the same calls (see the equity curves below) but never sizes a real order.</p>`
        + `<p class="note" id="strategies-live-howto">Switch in Telegram: <code>/risk profile ${key === 'steady' ? 'aggressive' : 'steady'}</code>, then reply with the PIN within 60 s.</p>`
    })]
  });
}

/**
 * @param {Object|null} data - ./profiles.js computeProfileCurves() output, or null before
 *   the first sync (renders zero-state text, same convention as the rest of this page set)
 * @param {string|null} liveProfileKey - data/telegram-status.json `riskProfile`, or null
 */
export function renderStrategies(data = null, liveProfileKey = null) {
  const topStrip = `<header class="edge-strip" id="strategies-top-edge-strip"><span id="strategies-page-title">EDITTRADES / WALLET STRATEGIES</span>`
    + `<a class="nav-link" id="strategies-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('strategies-jump-nav', [
      ['#strategies-profiles-section', 'Profiles'], ['#strategies-live-section', 'Live'], ['#strategies-curves-section', 'Curves'], ['#strategies-evaluation-section', 'Evaluation'],
      ['index.html', '← Tracker', 'class="nav-link" id="strategies-nav-back-link"'], ['risk.html', 'Risk & sizing →', 'class="nav-link" id="strategies-nav-risk-link"'], ['how-to.html#howto-telegram-section', 'How to use →', 'class="nav-link" id="strategies-nav-how-to-link"']
    ]);

  const profiles = zone({
    id: 'strategies-profiles-section', title: 'Wallet strategy profiles', sub: 'Every knob, side by side',
    tiles: [tile({
      id: 'strategies-profile-table-tile', lg: 12, body: profileTable(),
      foot: `The venue and hard env caps sit under both profiles the same way — full breakdown: <a href="risk.html">Risk & sizing →</a>.`
    })]
  });

  const bottomStrip = `<footer class="edge-strip" id="strategies-bottom-edge-strip"><span id="strategies-footer-note">NOT FINANCIAL ADVICE · AGGRESSIVE IS OWNER-TARGETED, NOT ENGINE-VALIDATED · STEADY IS THE DEFAULT UNTIL IT EARNS OUT</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Wallet Strategies</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
.strategies-profile-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.strategies-profile-table th,.strategies-profile-table td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
.strategies-profile-table thead th{color:var(--text-secondary);font-weight:500}
.strategies-curve-legend{display:flex;gap:16px;margin-top:8px;font-size:var(--fs-sm);color:var(--text-secondary)}
.strategies-curve-legend-item{display:inline-flex;align-items:center;gap:6px}
.strategies-curve-legend-item i{display:inline-block;width:10px;height:10px;border-radius:2px}
</style>
</head>
<body>
<main id="strategies-page-main">
${topStrip}
${profiles}
${liveZone(liveProfileKey)}
${curveZone(data)}
${evaluationZone()}
${bottomStrip}
</main>
</body>
</html>
`;
}
