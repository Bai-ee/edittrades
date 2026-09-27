/**
 * EditTrades call tracker - "Spot trend" page (spot.html), docs/PLAN_SPOT_TREND_2026-09-27.md P2.
 *
 * Paper tracking of the daily EMA20 spot trend filter (./spot-trend.js): today's state per
 * coin, the paper equity curve vs buy & hold from the first live day, recent flips, and the
 * backtest summary from docs/EDGE_SEARCH_2026-09-27.md. Same bento system as
 * strategies.html (./bento.js, ./page-style.js). Every live number comes from
 * data/spot-trend/; the backtest tile is static reference copy.
 */

import path from 'node:path';
import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';
import { readJsonl, readJson } from './store.js';
import { spotDir, SPOT_SYMBOLS } from './spot-trend.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 2) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const pct = (v, d = 1) => (isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '–');

/** Everything the page shows, read from <data>/spot-trend/. */
export function readSpotData(dataDir) {
  const dir = spotDir(dataDir);
  return {
    days: readJsonl(path.join(dir, 'days.jsonl')),
    flips: readJsonl(path.join(dir, 'flips.jsonl')),
    ledger: readJson(path.join(dir, 'ledger.json'), null),
    meta: readJson(path.join(dir, 'meta.json'), null)
  };
}

function stateTiles(days, flips) {
  return Object.keys(SPOT_SYMBOLS).map((sym) => {
    const id = `spot-trend-state-${sym.toLowerCase()}`;
    const rows = days.filter((r) => r.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
    const last = rows.at(-1);
    if (!last) return tile({ id, title: sym, sm: 2, lg: 4, body: '<p class="dim">[NO DAILY CLOSE YET]</p>' });
    const lastFlip = flips.filter((f) => f.symbol === sym).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const dist = isNum(last.close) && isNum(last.ema20) && last.ema20 ? last.close / last.ema20 - 1 : null;
    const into = last.state === 'IN';
    const body = `<div class="spot-state ${into ? 'spot-state-in' : 'spot-state-out'}" id="${id}-state">${into ? 'IN · HOLD' : 'OUT · USDC'}</div>`
      + `<dl class="spot-facts" id="${id}-facts">`
      + `<dt>Daily close</dt><dd id="${id}-close">${num(last.close)}</dd>`
      + `<dt>EMA20</dt><dd id="${id}-ema">${num(last.ema20)}</dd>`
      + `<dt>Close vs EMA20</dt><dd id="${id}-distance">${pct(dist)}</dd>`
      + `<dt>Suggested weight</dt><dd id="${id}-weight">${into && isNum(last.weight) ? `${Math.round(last.weight * 100)}%` : '0%'}</dd>`
      + `<dt>Since</dt><dd id="${id}-since">${esc(lastFlip ? lastFlip.date : '–')}</dd>`
      + `</dl>`;
    return tile({ id, title: sym, tag: last.date, sm: 2, lg: 4, body });
  });
}

/** Two-line SVG: paper equity vs buy & hold, both starting at 1. */
function equitySvg(rows) {
  const W = 600, Hh = 160, pad = 6;
  const vals = rows.flatMap((r) => [r.equity, r.bh]).concat([1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pts = (k) => [{ v: 1 }, ...rows.map((r) => ({ v: r[k] }))].map((p, i, a) => {
    const x = pad + (i / Math.max(1, a.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (p.v - lo) / span) * (Hh - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spot-equity-svg" id="spot-trend-equity-svg" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Paper equity vs buy and hold">`
    + `<polyline fill="none" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="4 3" points="${pts('bh')}"/>`
    + `<polyline fill="none" stroke="var(--success)" stroke-width="2" points="${pts('equity')}"/></svg>`;
}

function equityTile(ledger, meta) {
  const rows = ledger && Array.isArray(ledger.rows) ? ledger.rows : [];
  const start = (meta && meta.startDate) || (ledger && ledger.startDate) || null;
  if (!rows.length) {
    return tile({
      id: 'spot-trend-equity-panel', title: 'Paper equity vs buy & hold', lg: 12,
      body: `<p class="dim" id="spot-trend-equity-empty">[STARTS ${esc(start || 'ON THE FIRST DAILY CLOSE')}; THE FIRST RESULT SHOWS AFTER THE NEXT CLOSE]</p>`
    });
  }
  const last = rows.at(-1);
  const body = `<dl class="spot-facts spot-facts-wide" id="spot-trend-equity-facts">`
    + `<dt>Filter (paper)</dt><dd id="spot-trend-equity-filter">${pct(last.equity - 1)}</dd>`
    + `<dt>Buy & hold</dt><dd id="spot-trend-equity-bh">${pct(last.bh - 1)}</dd>`
    + `<dt>Days</dt><dd id="spot-trend-equity-days">${rows.length}</dd></dl>`
    + equitySvg(rows)
    + `<p class="spot-legend" id="spot-trend-equity-legend"><span><i style="background:var(--success)"></i>Filter</span><span><i style="background:var(--text-secondary)"></i>Buy & hold</span></p>`;
  return tile({
    id: 'spot-trend-equity-panel', title: 'Paper equity vs buy & hold', tag: `FROM ${start}`, lg: 12, body,
    foot: 'Equal share per coin, 0.15% per unit of weight changed, weight set on a close earns from the next day. A few weeks say nothing about the edge either way.'
  });
}

function flipsTile(flips) {
  const recent = [...flips].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  const rows = recent.map((f, i) => `<tr id="spot-trend-flip-row-${i}"><td>${esc(f.date)}</td><td>${esc(f.symbol)}</td><td>${esc(f.from)} → ${esc(f.to)}</td>`
    + `<td>${num(f.close)}</td><td>${num(f.ema20)}</td><td>${f.live ? 'live' : 'history'}</td></tr>`).join('');
  const body = recent.length
    ? `<div class="spot-table-scroll" id="spot-trend-flips-scroll"><table class="spot-table" id="spot-trend-flips-table-el"><thead><tr><th>Day</th><th>Coin</th><th>Flip</th><th>Close</th><th>EMA20</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="dim">[NO FLIPS YET]</p>';
  return tile({ id: 'spot-trend-flips-table', title: 'Recent flips', lg: 12, body, foot: '"history" = before tracking started (no alert); "live" flips send a Telegram alert.' });
}

function backtestTile() {
  const rows = [
    ['Buy & hold', '50%', '88%', '0.92'],
    ['EMA20 filter', '73%', '56%', '1.39'],
    ['EMA20 + 40% vol target (tracked here)', '39%', '37%', '1.37']
  ].map((r, i) => `<tr id="spot-trend-backtest-row-${i}">${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const body = `<div class="spot-table-scroll" id="spot-trend-backtest-scroll"><table class="spot-table" id="spot-trend-backtest-table"><thead><tr><th>Equal thirds BTC/ETH/SOL, 2017 → 2026</th><th>CAGR</th><th>Max DD</th><th>Sharpe</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<p class="note" id="spot-trend-backtest-years">Filter vs buy & hold by year: 2018 −4% vs −77%, 2022 −37% vs −80%, 2025 −4% vs −14%, 2026 YTD +15% vs −4%. It trails in strong bull years (2021 +725% vs +1150%).</p>`;
  return tile({
    id: 'spot-trend-backtest-panel', title: 'Why this rule', tag: 'BACKTEST', lg: 12, body,
    foot: 'EMA20 chosen on Oct 2024 – Dec 2025 only; 2017–2024 and 2026 were unseen. Three correlated coins: one bet that crypto trends persist. Source: docs/EDGE_SEARCH_2026-09-27.md.'
  });
}

export function renderSpot(data = { days: [], flips: [], ledger: null, meta: null }) {
  const topStrip = `<header class="edge-strip" id="spot-trend-top-edge-strip"><span id="spot-trend-page-title">EDITTRADES / SPOT TREND (PAPER)</span>`
    + `<a class="nav-link" id="spot-trend-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('spot-trend-jump-nav', [
      ['#spot-trend-state-row', 'Today'], ['#spot-trend-equity-zone', 'Equity'], ['#spot-trend-flips-zone', 'Flips'], ['#spot-trend-why-zone', 'Why'],
      ['index.html', '← Tracker', 'class="nav-link" id="spot-trend-nav-back-link"'], ['how-to.html', 'How to use →', 'class="nav-link" id="spot-trend-nav-how-to-link"'], ['risk.html', 'Risk & sizing →', 'class="nav-link" id="spot-trend-nav-risk-link"'], ['strategies.html', 'Wallet strategies →', 'class="nav-link" id="spot-trend-nav-strategies-link"']
    ]);
  const bottomStrip = `<footer class="edge-strip" id="spot-trend-bottom-edge-strip"><span id="spot-trend-footer-note">PAPER ONLY · NO ORDERS · DAILY UTC CLOSE, KRAKEN · NOT FINANCIAL ADVICE</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Spot Trend</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
.spot-state{font-family:'Space Mono',monospace;font-size:var(--fs-md);margin-bottom:10px}
.spot-state-in{color:var(--success)}
.spot-state-out{color:var(--text-secondary)}
.spot-facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:var(--fs-sm)}
.spot-facts dt{color:var(--text-secondary)}
.spot-facts dd{margin:0;text-align:right;font-family:'Space Mono',monospace}
.spot-facts-wide{max-width:360px;margin-bottom:12px}
.spot-equity-svg{width:100%;height:160px;display:block}
.spot-legend{display:flex;gap:16px;margin-top:8px;font-size:var(--fs-sm);color:var(--text-secondary)}
.spot-legend span{display:inline-flex;align-items:center;gap:6px}
.spot-legend i{display:inline-block;width:10px;height:10px;border-radius:2px}
.spot-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.spot-table th,.spot-table td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
.spot-table thead th{color:var(--text-secondary);font-weight:500}
#spot-trend-page-main .tile{min-width:0}
.spot-table-scroll{overflow-x:auto;max-width:100%}
</style>
</head>
<body>
<main id="spot-trend-page-main">
${topStrip}
${zone({ id: 'spot-trend-state-row', title: 'Today', sub: 'Latest UTC daily close per coin', tiles: stateTiles(data.days || [], data.flips || []) })}
${zone({ id: 'spot-trend-equity-zone', title: 'Paper equity', sub: 'Since tracking started', tiles: [equityTile(data.ledger, data.meta)] })}
${zone({ id: 'spot-trend-flips-zone', title: 'Flips', sub: 'Last 20', tiles: [flipsTile(data.flips || [])] })}
${zone({ id: 'spot-trend-why-zone', title: 'Why this rule', sub: 'Backtest summary', tiles: [backtestTile()] })}
${bottomStrip}
</main>
</body>
</html>
`;
}
