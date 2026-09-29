/**
 * Homepage live board (right column of the hero): what the engine sees right now, no performance.
 *
 * Input is the newest stored capture row per symbol (store.js latestCallPerSymbol), so it is as
 * fresh as the 10-minute capture. One card, hard-capped at 40vh: tabs (CSS-only radios) switch
 * between ALL (flag radar across symbols) and one panel per symbol; the panel body scrolls
 * inside the card, the card never grows past the cap.
 *
 * The ALL tab leads with the overall net PnL (fees underneath) and a facts grid.
 *
 * Presentation only: every value is read from the capture row, nothing is recomputed except
 * distance-to-breakout and the bias-string parse.
 */

import { esc } from './bento.js';

const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

/** Lifecycle labels. Active = worth showing on the radar; failed/expired only count in the symbol panel. */
const STATE = {
  confirmed: { label: 'BROKE OUT', rank: 0, active: true },
  triggering: { label: 'BREAKING', rank: 1, active: true },
  forming: { label: 'FORMING', rank: 2, active: true },
  proto: { label: 'PROTO', rank: 3, active: true },
  failed: { label: 'FAILED', rank: 4, active: false },
  expired: { label: 'EXPIRED', rank: 5, active: false }
};
const stateOf = (s) => STATE[s] || { label: String(s || '').toUpperCase(), rank: 6, active: false };

const fmtPrice = (v) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 }) : dash);
const dirWord = (d) => (d === 'long' ? 'LONG' : d === 'short' ? 'SHORT' : dash);
const dirClass = (d) => (d === 'long' ? 'st-good' : d === 'short' ? 'st-bad' : '');
const timeZ = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? dash : `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}Z`;
};

/** `tf:1m=S,3m=N,...` and `scalp:L48,S8,N44|swing:L80,S0,N20` out of the capture's bias string. */
export function parseBias(bias) {
  const out = { tf: {}, scalp: null, swing: null };
  if (typeof bias !== 'string') return out;
  for (const part of bias.split('|')) {
    if (part.startsWith('tf:')) {
      for (const pair of part.slice(3).split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) out.tf[k] = v;
      }
    } else if (part.startsWith('scalp:')) out.scalp = part.slice(6);
    else if (part.startsWith('swing:')) out.swing = part.slice(6);
  }
  return out;
}

const leanClass = { L: 'is-long', S: 'is-short', N: 'is-flat' };

function distancePct(row, flag) {
  if (!isNum(row.price) || row.price <= 0 || !isNum(flag.breakout)) return null;
  return Math.abs(flag.breakout - row.price) / row.price * 100;
}

function flagRow(row, flag, withSymbol) {
  const st = stateOf(flag.state);
  const dist = distancePct(row, flag);
  const q = flag.qual && flag.qual.decision ? String(flag.qual.decision).toUpperCase() : dash;
  return `<li class="lb-flag lb-state-${esc(flag.state)}">`
    + (withSymbol ? `<span class="lb-flag-sym">${esc(row.symbol)}</span>` : '')
    + `<span class="lb-flag-tf">${esc(flag.tf)}</span>`
    + `<span class="lb-flag-dir ${dirClass(flag.dir)}">${dirWord(flag.dir)}</span>`
    + `<span class="lb-flag-state">${esc(st.label)}</span>`
    + `<span class="lb-flag-dist">${dist === null ? dash : `${dist.toFixed(2)}% to ${esc(fmtPrice(flag.breakout))}`}</span>`
    + `<span class="lb-flag-rr">${isNum(flag.measuredRR) ? `${flag.measuredRR.toFixed(1)}R` : dash}</span>`
    + `<span class="lb-flag-q">${esc(q)}</span></li>`;
}

const sortFlags = (a, b) => stateOf(a.state).rank - stateOf(b.state).rank;

const MINUS = '−';
const signed = (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}`;
const count = (v) => (isNum(v) ? v.toLocaleString('en-US') : dash);
const statusClass = (v) => (v >= 0 ? 'st-good' : v >= -0.5 ? 'st-warn' : 'st-bad');
const usd = (v) => (isNum(v) ? `${v < 0 ? MINUS : ''}$${Math.abs(v).toFixed(2)}` : dash);

function lbStat(id, label, value) {
  return `<div class="lb-stat" id="${id}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

/**
 * Overall PnL headline (flag strategy since its epoch, net of fees) with the fee drag under it,
 * then a compact facts grid. Falls back to the all-time totals when there is no epoch.
 * @param {Object} agg - computeAggregates() output
 * @param {Array<Object>} rows - latest capture row per symbol (active flag count)
 */
function summaryBlock(agg, rows) {
  if (!agg || !agg.totals) return '';
  const sb = agg.scoreboard || {};
  const flag = sb.flag || null;
  const tr = agg.totals.tradable || {};
  const legacyScored = (tr.wins || 0) + (tr.losses || 0);
  const scored = flag ? flag.resolved : legacyScored;
  const net = flag ? (flag.resolved > 0 ? flag.netRMean : null) : (legacyScored > 0 ? tr.netExpectancy : null);
  const gross = flag ? (flag.resolved > 0 ? flag.grossRMean : null) : (legacyScored > 0 ? tr.expectancy : null);
  const wins = flag ? flag.wins : tr.wins;
  const losses = flag ? flag.losses : tr.losses;
  const winRate = flag ? flag.winRate : tr.winRate;
  const goodCalls = flag ? flag.calls : (agg.byDay || []).reduce((n, d) => n + d.good, 0);

  const figure = isNum(net)
    ? `<div class="lb-net ${statusClass(net)}" id="live-board-net-r">${esc(signed(net))}<span class="lb-net-unit">R</span></div>`
      + `<p class="lb-fees" id="live-board-fees-line">${isNum(gross) ? esc(`${signed(gross)}R gross · fees and slippage ${signed(net - gross)}R`) : ''}</p>`
    : `<div class="lb-net lb-net-empty" id="live-board-net-r">0.00<span class="lb-net-unit">R</span></div><p class="lb-fees" id="live-board-fees-line">[NO SCORED CALLS YET]</p>`;

  const wallet = sb.wallet || null;
  const walletDelta = wallet && isNum(wallet.equityNowUsd) && isNum(wallet.equityStartUsd) ? wallet.equityNowUsd - wallet.equityStartUsd : null;
  const prog = (c) => (c ? `${count(c.towardThirty)}/${count(c.promotionTarget)}` : dash);
  const activeFlags = (rows || []).reduce((n, r) => n + (r.candidateSetups || []).filter((f) => stateOf(f.state).active).length, 0);
  const candles = agg.captures && agg.captures.candles1m ? Object.values(agg.captures.candles1m).reduce((n, v) => n + v, 0) : null;
  const since = flag ? `${String(flag.epochIso).slice(0, 10)} (net floor)` : null;

  return `<div class="lb-summary" id="live-board-pnl-block" data-section="live-board-pnl-block"><span class="label lb-summary-label">Overall net PnL · per scored GOOD call</span>${figure}`
    + `<dl class="lb-stats" id="live-board-summary-stats">`
    + lbStat('live-board-stat-record', 'Scored W / L', scored > 0 ? `${count(wins)} / ${count(losses)}${isNum(winRate) ? ` · ${Math.round(winRate * 1000) / 10}%` : ''}` : dash)
    + lbStat('live-board-stat-good', 'GOOD calls', count(goodCalls))
    + lbStat('live-board-stat-wallet', 'Bot wallet', wallet ? `${usd(wallet.equityNowUsd)}${walletDelta === null ? '' : ` (${walletDelta >= 0 ? '+' : MINUS}${usd(Math.abs(walletDelta))})`}` : dash)
    + lbStat('live-board-stat-live-trades', 'Live trades', wallet ? count(wallet.trades) : dash)
    + lbStat('live-board-stat-progress', 'To 30 · Flag / HTF / RETEST', `${prog(sb.flag)} / ${prog(sb.htf)} / ${prog(sb.retest1h)}`)
    + lbStat('live-board-stat-active-flags', 'Active flags now', count(activeFlags))
    + lbStat('live-board-stat-signals', 'Signals logged', count(agg.totals.recCalls))
    + lbStat('live-board-stat-candles', '1m candles', count(candles))
    + (since ? lbStat('live-board-stat-since', 'Since', since) : '')
    + `</dl></div>`;
}

function radarPanel(rows, agg) {
  const items = [];
  for (const row of rows) {
    for (const f of row.candidateSetups || []) {
      if (stateOf(f.state).active) items.push([row, f]);
    }
  }
  items.sort((a, b) => sortFlags(a[1], b[1]) || String(a[0].symbol).localeCompare(String(b[0].symbol)));
  const body = items.length
    ? `<ul class="lb-flag-list" id="live-board-radar-list">${items.map(([r, f]) => flagRow(r, f, true)).join('')}</ul>`
    : (rows.length
      ? `<p class="lb-empty" id="live-board-radar-empty">No flag forming on any symbol right now.</p>`
      : `<p class="lb-empty" id="live-board-empty">No live capture yet.</p>`);
  return `<div class="lb-panel" id="live-board-panel-all" data-section="live-board-panel-all">${summaryBlock(agg, rows)}<h2 class="lb-title label">Flag radar · forming to break out</h2>${body}</div>`;
}

const ODDS = [['retest_go', 'retest'], ['runner', 'runner'], ['false_break', 'false break'], ['fail_first', 'fail first'], ['chop', 'chop']];

function oddsBlock(po) {
  if (!po || !po.w) return '';
  const total = ODDS.reduce((n, [k]) => n + (isNum(po.w[k]) ? po.w[k] : 0), 0) || 1;
  const bar = ODDS.map(([k], i) => `<span class="lb-odds-seg lb-odds-${i}" style="width:${(((po.w[k] || 0) / total) * 100).toFixed(1)}%"></span>`).join('');
  const legend = ODDS.map(([k, l]) => `${l} ${isNum(po.w[k]) ? Math.round(po.w[k]) : dash}%`).join(' · ');
  return `<div class="lb-odds"><div class="lb-odds-bar" role="img" aria-label="Path odds">${bar}</div>`
    + `<p class="lb-odds-legend">${esc(legend)}${po.cal === false ? ' · uncalibrated' : ''}${isNum(po.n) ? ` · n=${po.n}` : ''}${po.chase ? ` · chase ${esc(po.chase)}` : ''}</p></div>`;
}

function symbolPanel(row) {
  const sym = row.symbol;
  const rec = row.flagRecommendation || {};
  const cand = rec.candidate || null;
  const plan = row.flagTradePlan || null;
  const action = rec.action || null;
  const clarity = rec.clarity || null;
  const bias = parseBias(row.bias);
  const mark = row.mark || {};
  const drift = isNum(mark.driftBps) ? `${mark.driftBps > 0 ? '+' : ''}${mark.driftBps} bps` : dash;

  const calledDir = (plan && plan.direction) || (cand && cand.direction) || null;
  const calledLine = `<div class="lb-call"><span class="lb-chip lb-chip-${esc(String(rec.class || 'none').toLowerCase())}">${esc(rec.class || 'NO CALL')}</span>`
    + `<span class="lb-call-dir ${dirClass(calledDir)}">${calledDir ? `${dirWord(calledDir)}${cand ? ` ${esc(cand.timeframe)} ${esc(stateOf(cand.state).label)}` : ''}` : 'no direction called'}</span>`
    + (action && action.call ? `<span class="lb-call-action">${esc(action.call)}${isNum(action.etaMin) ? ` ~${action.etaMin}m` : ''}</span>` : '') + `</div>`;
  const next = action && action.note ? `<p class="lb-line" id="live-board-${sym.toLowerCase()}-next"><b>Next</b> ${esc(action.note)}</p>` : '';

  const lean = `<div class="lb-lean" id="live-board-${sym.toLowerCase()}-lean" role="img" aria-label="Timeframe lean">`
    + TFS.map((tf) => `<span class="lb-lean-cell ${leanClass[bias.tf[tf]] || 'is-flat'}"><i>${tf}</i>${esc(bias.tf[tf] || dash)}</span>`).join('') + `</div>`;
  const context = [
    bias.scalp ? `scalp ${bias.scalp}` : null,
    bias.swing ? `swing ${bias.swing}` : null
  ].filter(Boolean).join(' · ');

  const gate = clarity && clarity.gate && clarity.gate.text ? `<p class="lb-line"><b>${clarity.gate.passable ? 'Gate open' : 'Blocked'}</b> ${esc(clarity.gate.text)}</p>` : '';
  const kill = clarity && clarity.killIf && clarity.killIf.text ? `<p class="lb-line"><b>Kill if</b> ${esc(clarity.killIf.text)}</p>` : '';
  const other = clarity && clarity.otherSide && clarity.otherSide.text ? `<p class="lb-line"><b>Other side</b> ${esc(clarity.otherSide.text)}</p>` : '';

  const flags = (row.candidateSetups || []).slice().sort(sortFlags);
  const flagList = flags.length ? `<ul class="lb-flag-list" id="live-board-${sym.toLowerCase()}-flags">${flags.map((f) => flagRow(row, f, false)).join('')}</ul>` : '';

  return `<div class="lb-panel" id="live-board-panel-${sym.toLowerCase()}" data-section="live-board-panel-${sym.toLowerCase()}">`
    + `<div class="lb-price-row"><span class="lb-price" id="live-board-${sym.toLowerCase()}-price">${esc(fmtPrice(row.price))}</span>`
    + `<span class="lb-mark">Pyth ${esc(fmtPrice(mark.price))} · ${esc(drift)}${mark.status && mark.status !== 'ok' ? ` · ${esc(String(mark.status).toUpperCase())}` : ''}</span></div>`
    + calledLine + next + lean
    + (context ? `<p class="lb-line lb-context">${esc(context)}</p>` : '')
    + oddsBlock(row.pathOutlook) + gate + kill + other + flagList
    + `</div>`;
}

/**
 * @param {Array<Object>} rows - latest capture row per symbol
 * @param {string} [generatedAt] - page build time, for the "captured Nm ago" stamp
 * @param {Object} [agg] - computeAggregates() output; adds the overall PnL summary to the ALL tab
 */
export function liveBoard(rows, generatedAt, agg) {
  const bySym = new Map((rows || []).map((r) => [r.symbol, r]));
  const have = SYMBOLS.map((s) => bySym.get(s)).filter(Boolean);
  const newest = have.map((r) => Date.parse(r.closedThrough)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const built = Date.parse(generatedAt);
  const ageMin = Number.isFinite(newest) && Number.isFinite(built) ? Math.max(0, Math.round((built - newest) / 60000)) : null;
  const asOf = newest ? `Closed ${timeZ(new Date(newest).toISOString())}${ageMin === null ? '' : ` · ${ageMin}m old at build`} · refreshes every 10 min` : 'No live capture yet';

  const tabs = ['all', ...SYMBOLS.map((s) => s.toLowerCase())];
  const radios = tabs.map((t, i) => `<input class="lb-radio" type="radio" name="live-board-tab" id="live-board-tab-${t}"${i === 0 ? ' checked' : ''} aria-label="${t.toUpperCase()}">`).join('');
  const labels = tabs.map((t) => `<label class="lb-tab" for="live-board-tab-${t}" id="live-board-tab-label-${t}">${t.toUpperCase()}</label>`).join('');

  const panels = radarPanel(have, agg) + have.map(symbolPanel).join('');
  return `<article class="live-board" id="live-board-card" data-section="live-board-card" aria-label="Live engine state">`
    + radios
    + `<header class="lb-head" id="live-board-head"><span class="label">Live · what the engine sees</span><nav class="lb-tabs" id="live-board-tabs" aria-label="Board view">${labels}</nav></header>`
    + `<div class="lb-body" id="live-board-body">${panels}</div>`
    + `<p class="lb-asof" id="live-board-asof-line">${esc(asOf)}</p></article>`;
}

const tabRule = (t) => `#live-board-tab-${t}:checked ~ .lb-body #live-board-panel-${t}{display:flex}#live-board-tab-${t}:checked ~ .lb-head #live-board-tab-label-${t}{background:var(--text-display);border-color:var(--text-display);color:var(--black)}#live-board-tab-${t}:focus-visible ~ .lb-head #live-board-tab-label-${t}{outline:1px solid var(--text-display);outline-offset:2px}`;

export const LIVE_BOARD_CSS = `
/* live board: hard cap 40vh; the body scrolls, the card never grows. */
.live-board{container-type:inline-size;position:relative;display:flex;flex-direction:column;gap:var(--sp-2);min-width:0;max-height:40vh;overflow:hidden;padding:var(--sp-3) var(--sp-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.lb-radio{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.lb-head{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);flex-wrap:wrap}
.lb-tabs{display:flex;gap:var(--sp-1)}
.lb-tab{display:inline-flex;align-items:center;min-height:28px;padding:0 var(--sp-2);border:1px solid var(--border-visible);border-radius:999px;font:400 11px/1 var(--mono);letter-spacing:.08em;color:var(--text-primary);cursor:pointer;user-select:none}
.lb-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.lb-panel{display:none;flex-direction:column;gap:var(--sp-2)}
${tabRule('all')}${tabRule('btc')}${tabRule('eth')}${tabRule('sol')}
.lb-summary{display:flex;flex-direction:column;gap:var(--sp-1);padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)}
.lb-summary-label{font-weight:400}
.lb-net{font:700 clamp(40px,11cqi,64px)/.95 var(--doto);letter-spacing:-.03em;font-variant-numeric:tabular-nums;white-space:nowrap}
.lb-net-empty{color:var(--text-disabled)}
.lb-net-unit{font:400 var(--fs-body)/1 var(--mono);letter-spacing:0;margin-left:var(--sp-2);color:var(--text-secondary);vertical-align:top}
.lb-fees{margin:0;font:400 11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.lb-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:var(--sp-1) 0 0;border-top:1px solid var(--border)}
.lb-stat{display:flex;flex-direction:column;gap:2px;padding:var(--sp-1) 0;border-bottom:1px solid var(--border);min-width:0}
.lb-stat:nth-child(odd){padding-right:var(--sp-2)}
.lb-stat:nth-child(even){padding-left:var(--sp-2);border-left:1px solid var(--border)}
.lb-stat dt{font:400 10px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.lb-stat dd{margin:0;font:400 13px/1.2 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.lb-title{margin:0;font-weight:400}
.lb-price-row{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-2);flex-wrap:wrap}
.lb-price{font:700 var(--fs-md)/1 var(--doto);color:var(--text-display);font-variant-numeric:tabular-nums}
.lb-mark,.lb-asof,.lb-odds-legend,.lb-context{font:400 11px/1.4 var(--mono);color:var(--text-secondary);margin:0}
.lb-call{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);font:400 12px/1.3 var(--mono)}
.lb-chip{padding:1px var(--sp-2);border:1px solid var(--border-visible);border-radius:999px;letter-spacing:.08em;color:var(--text-display)}
.lb-chip-good{border-color:var(--success);color:var(--success)}
.lb-chip-watch{border-color:var(--warning);color:var(--warning)}
.lb-chip-bad{border-color:var(--accent);color:var(--accent)}
.lb-call-action{color:var(--text-secondary)}
.lb-line{margin:0;font:400 12px/1.4 var(--mono);color:var(--text-primary);overflow-wrap:anywhere}
.lb-line b{color:var(--text-secondary);font-weight:400;text-transform:uppercase;letter-spacing:.06em;margin-right:var(--sp-1)}
.lb-lean{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.lb-lean-cell{display:flex;flex-direction:column;align-items:center;padding:2px 0;border:1px solid var(--border);border-radius:4px;font:400 12px/1.2 var(--mono);color:var(--text-secondary)}
.lb-lean-cell i{font-style:normal;font-size:10px;color:var(--text-secondary)}
.lb-lean-cell.is-long{color:var(--success);border-color:var(--success)}
.lb-lean-cell.is-short{color:var(--accent);border-color:var(--accent)}
.lb-odds-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--border)}
.lb-odds-seg{display:block;height:100%}
.lb-odds-0{background:var(--success)}.lb-odds-1{background:var(--text-display)}.lb-odds-2{background:var(--warning)}.lb-odds-3{background:var(--accent)}.lb-odds-4{background:var(--border-visible)}
.lb-flag-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.lb-flag{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--sp-2);padding:var(--sp-1) 0;border-bottom:1px solid var(--border);font:400 12px/1.3 var(--mono);font-variant-numeric:tabular-nums;color:var(--text-display)}
.lb-flag-sym{min-width:3ch}
.lb-flag-state{letter-spacing:.06em;color:var(--text-secondary)}
.lb-state-triggering .lb-flag-state,.lb-state-confirmed .lb-flag-state{color:var(--text-display);font-weight:700}
.lb-state-failed,.lb-state-expired{opacity:.55}
.lb-flag-dist,.lb-flag-q{color:var(--text-secondary)}
.lb-empty{margin:0;font:400 12px/1.4 var(--mono);color:var(--text-secondary)}
.lb-asof{flex:0 0 auto}
@media (prefers-reduced-motion: reduce){.lb-tab{transition:none}}
`;
