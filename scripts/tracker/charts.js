/**
 * EditTrades call tracker - page charts (docs/PLAN_CALL_TRACKER.md "Charts").
 *
 * Two inline-SVG charts, drawn server-side for the first paint and redrawn client-side
 * by one dependency-free inline script (filters, range, container width). The drawing
 * code is `chartKit`, a self-contained function: build-page.js calls it in Node and
 * inlines its source into the page, so both paths draw the same SVG.
 *
 *   Chart 1 - engine-call equity curve: cumulative gross R of scored ready plans
 *             (tp1 = +R walked by the scorer, stop = -1R, 1R per call; not_filled and
 *             expired excluded; open calls as one hollow last point), with multi-select
 *             filters (OR within a dimension, AND across) and a by-filter table.
 *   Chart 2 - wallet value over time from data/wallet.jsonl (whitelisted numbers only),
 *             total solid, margin and holdings as lighter dashed/dotted lines, gaps for
 *             unavailable samples, a baseline rule, GOOD-call ticks (coincidence only),
 *             and a 24H / 7D / 30D / ALL range control.
 *   Journal (T2) - the equity chart carries a second, dashed line "your trades" (scored
 *             journal opens, same filters via the linked engine call's dims); the wallet
 *             chart carries journal entry/exit ticks (open = tick up, close = tick down,
 *             colored by the trade's result sign).
 *
 * Monochrome: opacity and dash pattern separate series; status color only on values.
 * No gradients, no shadows, no external scripts, no network.
 */

export const NO_SCORED_CHART = '[NO SCORED CALLS YET]';
export const NO_MATCH_CHART = '[NO CALLS MATCH THESE FILTERS]';
export const NO_WALLET = '[NO WALLET SAMPLES YET]';
export const NO_WALLET_RANGE = '[NO WALLET SAMPLES IN RANGE]';
export const NO_JOURNAL = '[NO JOURNAL RECORDS YET]';
export const NO_JOURNAL_TRADES = '[NO JOURNAL TRADES YET]';

/** Equity-curve filter dimensions: [key, label]. */
export const FILTER_DIMS = Object.freeze([
  ['class', 'Class'], ['reason', 'Reason code'], ['symbol', 'Symbol'], ['tf', 'Timeframe'], ['dir', 'Direction'],
  ['plan', 'Plan status at call'], ['td', 'Top-down'], ['ema', 'EMA200 side'], ['div', 'Divergence'],
  ['drift', 'Mark drift |bps|'], ['hour', 'Hour UTC'], ['via', 'Via']
]);

export const WALLET_RANGES = Object.freeze([['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'ALL']]);
export const DEFAULT_WALLET_RANGE = 'all';

const VALUE_ORDER = {
  class: ['GOOD', 'WATCH', 'BAD', 'DATA_UNAVAILABLE'],
  dir: ['long', 'short'],
  via: ['cron', 'chat'],
  td: ['supports', 'opposes', 'unknowns'],
  ema: ['above', 'below', 'missing'],
  div: ['agrees', 'conflicts', 'mixed'],
  drift: ['≤5', '5–10', '>10']
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const val = (v) => (v === null || v === undefined || v === '' ? 'none' : String(v));
const pad2 = (n) => String(n).padStart(2, '0');

/** |drift| bucket: ≤5, 5–10, >10 bps, or none. */
export function driftBucket(bps) {
  if (!isNum(bps)) return 'none';
  const a = Math.abs(bps);
  return a <= 5 ? '≤5' : a <= 10 ? '5–10' : '>10';
}

/** UTC 4-hour bucket of an ISO time: 00–03 ... 20–23. */
export function hourBucket(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'none';
  const start = Math.floor(new Date(ms).getUTCHours() / 4) * 4;
  return `${pad2(start)}–${pad2(start + 3)}`;
}

/**
 * Slim equity-curve rows from outcomes: ready plan calls that reached tp1 or stop, or are
 * still open. {t, at, o, r, f:{<dim>: value}}; r is +R (tp1) or -1 (stop), null if open.
 */
/** 'chat' for a call the GPT was served (T3, dims.source 'served'), else 'cron'. */
export function callVia(r) {
  return r && r.dims && r.dims.source === 'served' ? 'chat' : 'cron';
}

function rowFilters(r) {
  const d = r.dims && typeof r.dims === 'object' ? r.dims : {};
  return {
    class: val(d.recClass),
    reason: val(d.recReason ?? r.reasonCode),
    symbol: val(r.symbol),
    tf: val(r.timeframe ?? d.candidateTimeframe),
    dir: val(r.direction ?? d.candidateDirection),
    plan: val(d.planStatusAtCall ?? r.planStatus),
    td: val(d.topDown),
    ema: val(d.ema200Side),
    div: val(d.divergence),
    drift: driftBucket(r.markDriftBps),
    hour: hourBucket(r.calledAt),
    via: callVia(r)
  };
}

export function equityRows(outcomes) {
  return (outcomes || [])
    .filter((r) => r && r.kind === 'plan' && r.planStatus === 'ready' && ['tp1', 'stop', 'open'].includes(r.outcome))
    .map((r) => ({
      t: r.calledAt,
      at: r.resolvedAt || null,
      o: r.outcome,
      r: r.outcome === 'stop' ? -1 : r.outcome === 'tp1' && isNum(r.r) ? r.r : null,
      f: rowFilters(r)
    }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/**
 * "Your trades" rows from data/journal-outcomes.jsonl, same shape as equityRows: tp1 (+R),
 * stop (-1R), closed (the reported R), open (hollow). Filter dims come from the linked
 * engine call (score.js journalDims).
 */
export function journalEquityRows(journalOutcomes) {
  return (journalOutcomes || [])
    .filter((r) => r && r.kind === 'journal' && ['tp1', 'stop', 'open', 'closed'].includes(r.outcome))
    .filter((r) => r.outcome !== 'closed' || isNum(r.r))
    .map((r) => ({
      t: r.calledAt,
      at: r.resolvedAt || null,
      o: r.outcome,
      r: r.outcome === 'stop' ? -1 : (r.outcome === 'tp1' || r.outcome === 'closed') && isNum(r.r) ? r.r : null,
      f: rowFilters(r)
    }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/**
 * Wallet-chart journal marks: {t, k:'open'|'close', r} - opens at their trade time with
 * the scored R of that trade, closes with their reported R (else the R of the open they
 * closed). r null = neutral tick.
 */
export function walletMarks(journal, journalOutcomes) {
  const byJournalId = new Map((journalOutcomes || []).map((o) => [o.journalId, o]));
  const byCloseId = new Map((journalOutcomes || []).filter((o) => o.closeId).map((o) => [o.closeId, o]));
  const marks = [];
  for (const rec of journal || []) {
    const t = rec && (rec.saidAt || rec.receivedAt);
    if (!Number.isFinite(Date.parse(t))) continue;
    if (rec.kind === 'open') {
      const o = byJournalId.get(rec.id);
      marks.push({ t, k: 'open', r: o && isNum(o.r) ? o.r : o && o.outcome === 'stop' ? -1 : null });
    } else if (rec.kind === 'close') {
      const o = byCloseId.get(rec.id);
      marks.push({ t, k: 'close', r: isNum(rec.resultR) ? rec.resultR : o && isNum(o.r) ? o.r : null });
    }
  }
  return marks.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/** Distinct values per filter dimension, in a fixed order where one exists, `none` last. */
export function filterValues(rows) {
  const out = {};
  for (const [key] of FILTER_DIMS) {
    const seen = [...new Set(rows.map((r) => r.f[key]))];
    const order = VALUE_ORDER[key] || [];
    const rank = (v) => (v === 'none' ? 1e6 : order.includes(v) ? order.indexOf(v) : 1000);
    out[key] = seen.sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  }
  return out;
}

/** Whitelisted wallet rows for the page (keys re-picked; nothing else passes). */
export function walletChartRows(rows) {
  const num = (v) => (isNum(v) ? v : null);
  return (rows || []).filter((r) => r && Number.isFinite(Date.parse(r.t))).map((r) => ({
    t: r.t, status: typeof r.status === 'string' ? r.status : 'unknown',
    marginUsd: num(r.marginUsd), holdingsUsd: num(r.holdingsUsd), totalUsd: num(r.totalUsd),
    baselineUsd: num(r.baselineUsd), pnlUsd: num(r.pnlUsd), pnlPct: num(r.pnlPct)
  }));
}

/** Chart and control styles (appended to the page stylesheet; tokens from page-style.js). */
export const CHART_CSS = `.chart-readout{display:flex;flex-wrap:wrap;gap:4px 16px;font:400 var(--fs-sm)/1.5 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.chart-readout b{font-weight:400;color:var(--text-display)}
.chart-frame-box{margin-top:16px;width:100%;min-width:0}
.chart-svg{display:block;width:100%;height:auto}
.chart-svg text{font-family:var(--mono);font-size:10px;letter-spacing:.06em}
.chart-svg .ax{fill:var(--text-secondary)}
.chart-svg .grid{stroke:var(--border);stroke-width:1}
.chart-svg .grid.zero,.chart-svg .axis{stroke:var(--border-visible);stroke-width:1}
.chart-svg .chart-frame{fill:none;stroke:var(--border)}
.chart-svg .chart-empty{fill:var(--text-secondary);font-size:12px;letter-spacing:.08em}
.line-main{fill:none;stroke:var(--text-display);stroke-width:1.5;stroke-linejoin:round}
.line-margin{fill:none;stroke:var(--text-display);stroke-opacity:.55;stroke-width:1.25;stroke-dasharray:5 3}
.line-holdings{fill:none;stroke:var(--text-display);stroke-opacity:.4;stroke-width:1.5;stroke-dasharray:.5 3.5;stroke-linecap:round}
.baseline{stroke:var(--text-secondary);stroke-width:1;stroke-dasharray:2 2}
.good-tick{stroke:var(--text-display);stroke-width:1.5}
.line-you{fill:none;stroke:var(--text-display);stroke-opacity:.6;stroke-width:1.5;stroke-dasharray:4 3;stroke-linejoin:round}
.pt-you{fill:var(--text-display);fill-opacity:.6}
.j-tick{stroke:var(--text-secondary);stroke-width:2;stroke-linecap:square}
.j-tick.pos{stroke:var(--success)}
.j-tick.neg{stroke:var(--accent)}
.pt,.line-main-dot{fill:var(--text-display)}
.line-margin-dot{fill:var(--text-display);fill-opacity:.55}
.line-holdings-dot{fill:var(--text-display);fill-opacity:.4}
.pt-open{fill:var(--black);stroke:var(--text-display);stroke-width:1.5}
.chart-legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:12px;font:400 var(--fs-sm)/1 var(--mono);letter-spacing:.08em;color:var(--text-secondary)}
.chart-legend span{display:inline-flex;align-items:center;gap:6px}
.swatch{width:24px;height:12px;overflow:visible}
.wallet-head{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wallet-value{font:400 clamp(28px,8vw,40px)/1.1 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.filters{margin-top:24px;border-top:1px solid var(--border-visible)}
.filters summary{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:44px;cursor:pointer;list-style:none}
.filters summary::-webkit-details-marker{display:none}
.filters summary::after{content:"+";font-family:var(--mono);color:var(--text-secondary)}
.filters[open] summary::after{content:"\\2212"}
.filter-row{display:grid;grid-template-columns:1fr;gap:8px;padding:12px 0;border-top:1px solid var(--border)}
@media (min-width:760px){.filter-row{grid-template-columns:180px 1fr;align-items:start}.filter-row .label{padding-top:10px}}
.seg-ctl{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.seg-btn{appearance:none;-webkit-appearance:none;margin:0;border:1px solid var(--border-visible);border-radius:8px;background:transparent;color:var(--text-secondary);font:400 var(--fs-sm)/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;min-height:36px;padding:0 12px;cursor:pointer;transition:background-color .2s ease-out,color .2s ease-out}
.seg-btn.is-on{background:var(--text-display);border-color:var(--text-display);color:var(--black)}
.seg-btn:focus-visible{outline:1px solid var(--text-display);outline-offset:2px}
.seg-joined{display:inline-flex;flex-wrap:nowrap;gap:0;border:1px solid var(--border-visible);border-radius:8px;overflow:hidden}
.seg-joined .seg-btn{border:0;border-radius:0;flex:1 1 auto}
.seg-joined .seg-btn+.seg-btn{border-left:1px solid var(--border-visible)}
@media (prefers-reduced-motion: reduce){.seg-btn{transition:none}}
`;

/** JSON safe inside a <script> element. */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Self-contained drawing kit. Must not reference anything outside its own body: its
 * source is inlined into the page script.
 */
export function chartKit() {
  const MINUS = '−';
  const DASH = '–';
  const HOUR = 3600000;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (v) => Math.round(v * 10) / 10;
  const signedR = (v) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}R` : DASH);
  const pct = (v) => (isNum(v) ? `${Math.round(v * 1000) / 10}%` : DASH);
  const usd = (v) => (isNum(v) ? `${v < 0 ? MINUS : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : DASH);
  const usdShort = (v) => {
    const a = Math.abs(v);
    const s = a >= 1e6 ? `${f1(a / 1e6)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}K` : a >= 1e3 ? `${f1(a / 1e3)}K` : a >= 10 ? `${Math.round(a)}` : `${f1(a)}`;
    return `${v < 0 ? MINUS : ''}$${s}`;
  };
  const rStatus = (v) => (!isNum(v) ? '' : v >= 0 ? 'st-good' : v >= -0.5 ? 'st-warn' : 'st-bad');
  const heightFor = (w) => (w < 480 ? 200 : 260);

  function frame(width, padL) {
    const w = Math.max(280, Math.round(width || 640));
    const h = heightFor(w);
    const pad = { l: padL, r: 12, t: 16, b: 28 };
    return { w, h, pad, pw: w - pad.l - pad.r, ph: h - pad.t - pad.b };
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) { max = min + 1; min -= 1; }
    const raw = (max - min) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number((Math.round(v / step) * step).toFixed(8)));
    return { lo, hi, ticks };
  }

  function timeLabel(ms, spanMs) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return spanMs <= 36 * HOUR ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  function svgOpen(id, g, label) {
    return `<svg id="${id}" class="chart-svg" viewBox="0 0 ${g.w} ${g.h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">`;
  }

  function emptySvg(id, g, text) {
    return `${svgOpen(id, g, text)}<rect class="chart-frame" x="0.5" y="0.5" width="${g.w - 1}" height="${g.h - 1}"/>`
      + `<text class="chart-empty" x="${g.w / 2}" y="${g.h / 2}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text></svg>`;
  }

  /** Grid, y labels, x labels (thinned to the plot width). */
  function axes(g, x0, x1, yt, yFmt, ys) {
    let out = '';
    for (const v of yt.ticks) {
      const y = ys(v);
      out += `<line class="grid${v === 0 ? ' zero' : ''}" x1="${g.pad.l}" x2="${g.w - g.pad.r}" y1="${y}" y2="${y}"/>`
        + `<text class="ax" x="${g.pad.l - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(yFmt(v))}</text>`;
    }
    const n = Math.max(2, Math.min(7, Math.floor(g.pw / 84) + 1));
    const span = x1 - x0;
    for (let i = 0; i < n; i++) {
      const ms = x0 + (span * i) / (n - 1);
      const x = g.pad.l + (g.pw * i) / (n - 1);
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      out += `<text class="ax" x="${x}" y="${g.h - 8}" text-anchor="${anchor}">${esc(timeLabel(ms, span))}</text>`;
    }
    return out + `<line class="axis" x1="${g.pad.l}" x2="${g.w - g.pad.r}" y1="${g.pad.t + g.ph}" y2="${g.pad.t + g.ph}"/>`;
  }

  /** n = decided (tp1, stop, closed), win = R > 0, expectancy, max losing streak (R < 0 in a row), cumulative points. */
  function equityStats(rows) {
    const decided = rows.filter((r) => (r.o === 'tp1' || r.o === 'stop' || r.o === 'closed') && isNum(r.r))
      .map((r) => ({ ...r, ms: Date.parse(r.at || r.t) }))
      .sort((a, b) => a.ms - b.ms);
    let cum = 0;
    let streak = 0;
    let maxLosingStreak = 0;
    const points = decided.map((r) => {
      cum += r.r;
      if (r.r < 0) { streak++; maxLosingStreak = Math.max(maxLosingStreak, streak); } else streak = 0;
      return { ms: r.ms, cum: Math.round(cum * 100) / 100, o: r.o };
    });
    const wins = decided.filter((r) => r.r > 0).length;
    const n = decided.length;
    return {
      n, wins, losses: n - wins, open: rows.filter((r) => r.o === 'open').length,
      winRate: n ? wins / n : null,
      expectancy: n ? Math.round((cum / n) * 100) / 100 : null,
      cum: Math.round(cum * 100) / 100,
      maxLosingStreak, points
    };
  }

  function equitySvg(id, rows, width, nowMs, emptyText, you) {
    const g = frame(width, 48);
    const s = equityStats(rows);
    const y = equityStats(you || []);
    if (!s.n && !s.open && !y.n) return emptySvg(id, g, emptyText);
    const times = rows.map((r) => Date.parse(r.t)).concat(s.points.map((p) => p.ms), y.points.map((p) => p.ms)).filter(Number.isFinite);
    let x0 = Math.min(...times);
    let x1 = Math.max(...times, s.open ? nowMs : -Infinity);
    if (!(x1 > x0)) { x0 -= HOUR / 2; x1 += HOUR / 2; }
    const cums = [0, ...s.points.map((p) => p.cum), ...y.points.map((p) => p.cum)];
    const yt = niceTicks(Math.min(...cums), Math.max(...cums), g.ph < 180 ? 3 : 4);
    const xs = (ms) => f1(g.pad.l + ((ms - x0) / (x1 - x0)) * g.pw);
    const ys = (v) => f1(g.pad.t + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * g.ph);
    let youPath = '';
    if (y.n) {
      let yd = `M${xs(x0)} ${ys(0)}`;
      for (const p of y.points) {
        yd += ` L${xs(p.ms)} ${ys(p.cum)}`;
        youPath += `<circle class="pt-you" cx="${xs(p.ms)}" cy="${ys(p.cum)}" r="2.5"/>`;
      }
      youPath = `<path class="line-you" id="${id}-you-line" d="${yd}"/>${youPath}`;
    }
    let d = `M${xs(x0)} ${ys(0)}`;
    let dots = '';
    for (const p of s.points) {
      d += ` L${xs(p.ms)} ${ys(p.cum)}`;
      dots += `<circle class="pt" cx="${xs(p.ms)}" cy="${ys(p.cum)}" r="2.5"/>`;
    }
    let open = '';
    if (s.open) {
      const ox = xs(x1);
      const oy = ys(s.cum);
      d += ` L${ox} ${oy}`;
      open = `<circle class="pt-open" id="${id}-open-point" cx="${ox}" cy="${oy}" r="4.5"/>`
        + `<text class="ax" x="${ox - 8}" y="${oy - 10}" text-anchor="end">${s.open} OPEN</text>`;
    }
    const main = s.n || s.open ? `<path class="line-main${s.open ? ' has-open' : ''}" d="${d}"/>${dots}${open}` : '';
    return `${svgOpen(id, g, `Cumulative gross R, ${s.n} scored calls, ${y.n} journal trades`)}${axes(g, x0, x1, yt, (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)}R`, ys)}`
      + `${youPath}${main}</svg>`;
  }

  function readoutHtml(s) {
    return `<span id="equity-readout-n">N=${s.n}</span><span id="equity-readout-win">WIN ${pct(s.winRate)}</span>`
      + `<span id="equity-readout-exp">EXP <b class="${rStatus(s.expectancy)}">${signedR(s.expectancy)}</b></span>`
      + `<span id="equity-readout-cum">CUM <b class="${s.n ? rStatus(s.cum) : ''}">${s.n ? signedR(s.cum) : DASH}</b></span>`
      + `<span id="equity-readout-open">${s.open} OPEN</span>`;
  }

  /** Readout for the "your trades" line. */
  function youReadoutHtml(s, emptyText) {
    if (!s.n && !s.open) return `<span id="equity-you-readout-empty">YOUR TRADES ${esc(emptyText)}</span>`;
    return `<span id="equity-you-readout-n">YOUR TRADES N=${s.n}</span><span id="equity-you-readout-win">WIN ${pct(s.winRate)}</span>`
      + `<span id="equity-you-readout-exp">EXP <b class="${rStatus(s.expectancy)}">${signedR(s.expectancy)}</b></span>`
      + `<span id="equity-you-readout-cum">CUM <b class="${s.n ? rStatus(s.cum) : ''}">${s.n ? signedR(s.cum) : DASH}</b></span>`
      + `<span id="equity-you-readout-open">${s.open} OPEN</span>`;
  }

  const matches = (r, sel, skip) => Object.keys(sel).every((k) => k === skip || !sel[k].length || sel[k].includes(r.f[k]));

  /** Rows: all scored, the current selection, then each selected value within the other filters. */
  function filterTableHtml(rows, sel, dims, you) {
    const lines = [['All scored', equityStats(rows)]];
    const active = dims.filter(([k]) => sel[k] && sel[k].length);
    if (you && you.length) lines.push([active.length ? 'Your trades (selection)' : 'Your trades', equityStats(you.filter((r) => matches(r, sel)))]);
    if (active.length) {
      lines.push(['Selection', equityStats(rows.filter((r) => matches(r, sel)))]);
      for (const [k, label] of active) {
        for (const v of sel[k]) lines.push([`${label}: ${v}`, equityStats(rows.filter((r) => matches(r, sel, k) && r.f[k] === v))]);
      }
    }
    const td = (v, cls) => `<td class="num${cls ? ` ${cls}` : ''}">${esc(v)}</td>`;
    return `<table id="equity-filter-table"><thead><tr><th>Filter</th><th class="num">n</th><th class="num">Win rate</th><th class="num">Exp. (gross R)</th><th class="num">Max loss streak</th></tr></thead><tbody>`
      + lines.map(([label, s]) => `<tr><td>${esc(label)}</td>${td(s.n, s.n ? '' : 'dim')}${td(pct(s.winRate), s.n ? '' : 'dim')}`
        + `${td(signedR(s.expectancy), s.n ? rStatus(s.expectancy) : 'dim')}${td(s.maxLosingStreak, s.maxLosingStreak >= 5 ? 'st-bad' : s.maxLosingStreak ? '' : 'dim')}</tr>`).join('')
      + '</tbody></table>';
  }

  function rangeStart(range, lastMs) {
    const back = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR }[range];
    return back ? lastMs - back : -Infinity;
  }

  function walletSvg(id, rows, goods, width, range, nowMs, emptyText, marks) {
    const g = frame(width, 56);
    if (!rows.length) return emptySvg(id, g, emptyText);
    const lastMs = Math.max(nowMs, Date.parse(rows[rows.length - 1].t));
    const from = rangeStart(range, lastMs);
    const inRange = rows.filter((r) => Date.parse(r.t) >= from);
    if (!inRange.length) return emptySvg(id, g, '[NO WALLET SAMPLES IN RANGE]');
    let x0 = Number.isFinite(from) ? from : Date.parse(inRange[0].t);
    let x1 = Number.isFinite(from) ? lastMs : Date.parse(inRange[inRange.length - 1].t);
    if (!(x1 > x0)) { x0 -= HOUR / 2; x1 += HOUR / 2; }
    let baseline = null;
    for (const r of rows) if (isNum(r.baselineUsd)) baseline = r.baselineUsd;
    const vals = [];
    for (const r of inRange) for (const k of ['totalUsd', 'marginUsd', 'holdingsUsd']) if (isNum(r[k])) vals.push(r[k]);
    if (isNum(baseline)) vals.push(baseline);
    const xs = (ms) => f1(g.pad.l + ((ms - x0) / (x1 - x0)) * g.pw);
    if (!vals.length) {
      return `${svgOpen(id, g, 'Wallet value, no available samples in range')}<rect class="chart-frame" x="0.5" y="0.5" width="${g.w - 1}" height="${g.h - 1}"/>`
        + `<text class="chart-empty" x="${g.w / 2}" y="${g.h / 2}" text-anchor="middle" dominant-baseline="middle">[WALLET UNAVAILABLE IN RANGE]</text></svg>`;
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const spread = hi - lo || Math.max(1, Math.abs(hi) * 0.01);
    const yt = niceTicks(lo - spread * 0.1, hi + spread * 0.1, g.ph < 180 ? 3 : 4);
    const ys = (v) => f1(g.pad.t + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * g.ph);

    const series = (key, cls) => {
      let d = '';
      let dots = '';
      let run = [];
      const flush = () => {
        if (run.length === 1) dots += `<circle class="${cls}-dot" cx="${run[0][0]}" cy="${run[0][1]}" r="2"/>`;
        else if (run.length > 1) d += run.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' ';
        run = [];
      };
      for (const r of inRange) {
        if (isNum(r[key])) run.push([xs(Date.parse(r.t)), ys(r[key])]);
        else flush();
      }
      flush();
      return (d ? `<path class="${cls}" d="${d.trim()}"/>` : '') + dots;
    };

    let base = '';
    if (isNum(baseline)) {
      const y = ys(baseline);
      base = `<line class="baseline" id="${id}-baseline" x1="${g.pad.l}" x2="${g.w - g.pad.r}" y1="${y}" y2="${y}"/>`
        + `<text class="ax" x="${g.w - g.pad.r}" y="${y - 5}" text-anchor="end">BASELINE ${esc(usdShort(baseline))}</text>`;
    }

    // GOOD-call ticks on the total curve (nearest available sample within 2 h, else on the axis).
    const avail = inRange.filter((r) => isNum(r.totalUsd)).map((r) => [Date.parse(r.t), r.totalUsd]);
    let ticks = '';
    for (const t of goods || []) {
      const ms = Date.parse(t);
      if (!(ms >= x0 && ms <= x1)) continue;
      let best = null;
      for (const a of avail) if (Math.abs(a[0] - ms) <= 2 * HOUR && (!best || Math.abs(a[0] - ms) < Math.abs(best[0] - ms))) best = a;
      const x = xs(ms);
      const y = best ? ys(best[1]) : g.pad.t + g.ph;
      ticks += `<line class="good-tick" x1="${x}" x2="${x}" y1="${f1(y - 6)}" y2="${f1(y + 6)}"/>`;
    }

    // Journal ticks: open = up from the curve, close = down; colored by the trade's R sign.
    for (const m of marks || []) {
      const ms = Date.parse(m.t);
      if (!(ms >= x0 && ms <= x1)) continue;
      let best = null;
      for (const a of avail) if (Math.abs(a[0] - ms) <= 2 * HOUR && (!best || Math.abs(a[0] - ms) < Math.abs(best[0] - ms))) best = a;
      const x = xs(ms);
      const y = best ? ys(best[1]) : g.pad.t + g.ph;
      const tone = isNum(m.r) ? (m.r > 0 ? ' pos' : m.r < 0 ? ' neg' : '') : '';
      const y2 = m.k === 'open' ? y - 12 : y + 12;
      ticks += `<line class="j-tick j-${m.k === 'open' ? 'open' : 'close'}${tone}" x1="${x}" x2="${x}" y1="${f1(y)}" y2="${f1(y2)}"/>`;
    }

    return `${svgOpen(id, g, 'Wallet value over time')}${axes(g, x0, x1, yt, usdShort, ys)}${base}`
      + `${series('holdingsUsd', 'line-holdings')}${series('marginUsd', 'line-margin')}${series('totalUsd', 'line-main')}${ticks}</svg>`;
  }

  return { esc, usd, signedR, pct, rStatus, equityStats, equitySvg, readoutHtml, youReadoutHtml, filterTableHtml, walletSvg };
}

/** The page's one executable script: filters, range control, width-fit redraw. No network. */
export function chartScript() {
  return `(function(){
var kit=(${chartKit.toString()})();
var $=function(id){return document.getElementById(id);};
var read=function(id){try{return JSON.parse($(id).textContent);}catch(e){return null;}};
var calls=read('tracker-calls-data')||{rows:[],you:[],dims:[],now:null};
var wallet=read('tracker-wallet-data')||{rows:[],good:[],marks:[],now:null,range:'all'};
calls.you=calls.you||[];
var nowMs=Date.parse(calls.now)||Date.now();
var sel={};var range=wallet.range||'all';
var width=function(id){var el=$(id);return el&&el.clientWidth?el.clientWidth:640;};
var pick=function(list){return list.filter(function(r){return Object.keys(sel).every(function(k){return !sel[k].length||sel[k].indexOf(r.f[k])>=0;});});};
var selected=function(){return pick(calls.rows);};
function drawEquity(){
  if(!$('equity-chart-frame'))return;
  var rows=selected(),you=pick(calls.you);
  $('equity-chart-frame').innerHTML=kit.equitySvg('equity-chart-svg',rows,width('equity-chart-frame'),nowMs,calls.rows.length||calls.you.length?${JSON.stringify(NO_MATCH_CHART)}:${JSON.stringify(NO_SCORED_CHART)},you);
  if($('equity-readout'))$('equity-readout').innerHTML=kit.readoutHtml(kit.equityStats(rows));
  if($('equity-you-readout'))$('equity-you-readout').innerHTML=kit.youReadoutHtml(kit.equityStats(you),calls.you.length?${JSON.stringify(NO_MATCH_CHART)}:${JSON.stringify(NO_JOURNAL_TRADES)});
  if($('equity-filter-table-scroll'))$('equity-filter-table-scroll').innerHTML=kit.filterTableHtml(calls.rows,sel,calls.dims,calls.you);
  var n=Object.keys(sel).reduce(function(a,k){return a+sel[k].length;},0);
  if($('equity-filters-count'))$('equity-filters-count').textContent=n?n+' ACTIVE':'NONE ACTIVE';
}
function drawWallet(){
  if(!$('wallet-chart-frame'))return;
  $('wallet-chart-frame').innerHTML=kit.walletSvg('wallet-chart-svg',wallet.rows,wallet.good,width('wallet-chart-frame'),range,Date.parse(wallet.now)||nowMs,${JSON.stringify(NO_WALLET)},wallet.marks||[]);
}
function press(btn,on){btn.classList.toggle('is-on',on);btn.setAttribute('aria-pressed',on?'true':'false');}
Array.prototype.forEach.call(document.querySelectorAll('#equity-filters .seg-btn'),function(btn){
  btn.addEventListener('click',function(){
    var k=btn.getAttribute('data-dim'),v=btn.getAttribute('data-val'),list=sel[k]||[];
    if(v==='*')list=[];else if(list.indexOf(v)>=0)list=list.filter(function(x){return x!==v;});else list=list.concat([v]);
    sel[k]=list;
    Array.prototype.forEach.call(document.querySelectorAll('#equity-filters .seg-btn[data-dim="'+k+'"]'),function(b){var bv=b.getAttribute('data-val');press(b,bv==='*'?!list.length:list.indexOf(bv)>=0);});
    drawEquity();
  });
});
Array.prototype.forEach.call(document.querySelectorAll('#wallet-range-control .seg-btn'),function(btn){
  btn.addEventListener('click',function(){
    range=btn.getAttribute('data-val');
    Array.prototype.forEach.call(document.querySelectorAll('#wallet-range-control .seg-btn'),function(b){press(b,b===btn);});
    drawWallet();
  });
});
var lastW=0,timer=null;
function fit(){var w=width('equity-chart-frame');if(w===lastW)return;lastW=w;drawEquity();drawWallet();}
window.addEventListener('resize',function(){clearTimeout(timer);timer=setTimeout(fit,120);});
fit();
})();`;
}
