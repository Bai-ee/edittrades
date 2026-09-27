/**
 * Confirmation chart renderer (phase 8b).
 *
 * Draws ONE PNG for one symbol and one timeframe from a buildScalpContext() payload:
 * the timeframe's published candle window, EMA21/EMA200, horizontal zones as bands,
 * diagonals, channel, and the candidate flag's high/low/breakout/invalidation. The
 * image is a confirmation layer only - every line on it is a value the payload already
 * carries, so detection never depends on it.
 *
 * Pure JS on purpose (Vercel Hobby, no native build): pureimage supplies the bitmap,
 * text and PNG encoder; shapes are written straight into the RGBA buffer so every
 * pixel is opaque and exact. One bundled font: assets/fonts/IBMPlexMono-Regular.ttf
 * (SIL OFL 1.1, assets/fonts/OFL.txt).
 */

import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as PImage from 'pureimage';

// Mirrors SYMBOLS / TIMEFRAMES in services/scalpContext.js (test:chart asserts they
// match); kept local so the renderer does not pull in the whole context builder.
export const CHART_SYMBOLS = ['BTC', 'SOL', 'ETH'];
export const CHART_TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
// No geometry is computed below 15m, so these draw candles + EMAs + candidate only.
const CANDLES_ONLY_TIMEFRAMES = ['1m', '3m', '5m'];

export const CHART_WIDTH = 900;
export const CHART_HEIGHT = 500;
export const CHART_MAX_BYTES = 150 * 1024;

// Right gutter holds the price axis and the level labels, clear of the candles.
const PLOT = { left: 10, top: 40, right: CHART_WIDTH - 180, bottom: CHART_HEIGHT - 24 };
// An overlay joins the price range only when it sits within this fraction of the
// candle span beyond it, so a distant EMA200 or zone cannot flatten the candles.
const RANGE_REACH = 0.5;
const LABEL_GAP_PX = 12;

/** `hex` blended over `base` at `alpha` (0..1), as an opaque hex - the painter only writes opaque pixels. */
function blend(base, hex, alpha) {
  const a = parseInt(base.slice(1), 16);
  const b = parseInt(hex.slice(1), 16);
  const ch = (v, shift) => (v >> shift) & 255;
  const mix = (shift) => Math.round(ch(a, shift) * (1 - alpha) + ch(b, shift) * alpha);
  return `#${[16, 8, 0].map((sh) => mix(sh).toString(16).padStart(2, '0')).join('')}`;
}

export const CHART_COLORS = Object.freeze({
  background: '#0e1117',
  grid: '#1c2230',
  text: '#c9d1d9',
  muted: '#8b949e',
  up: '#26a69a',
  down: '#ef5350',
  ema21: '#f0b429',
  ema200: '#7aa2f7',
  zoneSupport: '#12352c',
  zoneResistance: '#3d1b22',
  diagonalSupport: '#3fb950',
  diagonalResistance: '#f85149',
  channel: '#bc8cff',
  candidateLong: '#56d4dd',
  candidateShort: '#ff9e64',
  lastPrice: '#e6edf3',
  // T-13 trade overlay: entry / stop / TP lines and 15 % risk / reward bands.
  tradeEntry: '#e6edf3',
  tradeStop: '#ef5350',
  tradeTarget: '#26a69a',
  riskBand: blend('#0e1117', '#ef5350', 0.15),
  rewardBand: blend('#0e1117', '#26a69a', 0.15),
  // T-16: ENTRY / EXIT time markers (vertical, cut through both panels) and the RSI line.
  entryMarker: '#ffffff',
  exitMarker: '#ffa657',
  rsi: '#d29922'
});

/** Candles the trade chart shows (the plan's timeframe). */
export const TRADE_CHART_CANDLES = 120;

// T-16: RSI(14) panel under the price panel. Period matches the reference implementation
// the owner approved visually (mock-trades-v2.mjs); no new library, Wilder smoothing.
export const RSI_PERIOD = 14;
export const RSI_PANEL_HEIGHT = 170;
const INDICATOR_TOP_PAD = 22;
const INDICATOR_BOTTOM_PAD = 18;
// Both time markers (ENTRY / EXIT) start here, just under the title/legend row.
const MARKER_TOP = 40;

const FONT_FAMILY = 'EditTradesChart';
const FONT_PATH = fileURLToPath(new URL('../assets/fonts/IBMPlexMono-Regular.ttf', import.meta.url));
let fontLoaded = false;

/** A chart request the caller got wrong, or one the payload cannot satisfy. */
export class ChartRequestError extends Error {
  /**
   * @param {string} message
   * @param {'invalid_format'|'multiple_charts'|'unknown_symbol'|'unknown_timeframe'|'no_data'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ChartRequestError';
    this.code = code;
  }
}

/**
 * Parse the `chart` argument ("BTC:1m"). Exactly one symbol:timeframe pair; anything
 * naming more than one chart is rejected, never truncated to the first.
 * @param {*} value - MCP arg or REST query value (string, or array when repeated)
 * @returns {{symbol:string, timeframe:string}|null} null when the argument is absent
 * @throws {ChartRequestError}
 */
export function parseChartArg(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    if (value.length > 1) throw new ChartRequestError('One chart per request: chart was given more than once.', 'multiple_charts');
    return parseChartArg(value[0]);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ChartRequestError('chart must be SYMBOL:TIMEFRAME, e.g. "BTC:1m".', 'invalid_format');
  }
  const raw = value.trim();
  if (raw.includes(',') || raw.split(':').length > 2) {
    throw new ChartRequestError(`One chart per request: "${raw}" names more than one.`, 'multiple_charts');
  }
  const [sym, tf] = raw.split(':').map((s) => (s || '').trim());
  if (!sym || !tf) throw new ChartRequestError('chart must be SYMBOL:TIMEFRAME, e.g. "BTC:1m".', 'invalid_format');
  return validateChartRequest({ symbol: sym.toUpperCase(), timeframe: tf.toLowerCase() });
}

/**
 * @param {{symbol:string, timeframe:string}} request
 * @returns {{symbol:string, timeframe:string}}
 * @throws {ChartRequestError} on a symbol or timeframe the payload does not carry
 */
function validateChartRequest({ symbol, timeframe }) {
  if (!CHART_SYMBOLS.includes(symbol)) {
    throw new ChartRequestError(`Unknown chart symbol "${symbol}". Use one of ${CHART_SYMBOLS.join(', ')}.`, 'unknown_symbol');
  }
  if (!CHART_TIMEFRAMES.includes(timeframe)) {
    throw new ChartRequestError(`Unknown chart timeframe "${timeframe}". Use one of ${CHART_TIMEFRAMES.join(', ')}.`, 'unknown_timeframe');
  }
  return { symbol, timeframe };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Assemble the drawing spec for one chart from a context payload. Pure data, no pixels.
 * @param {Object} payload - buildScalpContext() output (unfiltered)
 * @param {{symbol:string, timeframe:string}} request
 * @param {{ema21?:Array<number|null>, ema200?:Array<number|null>}} [series] - EMA values
 *   aligned to the candle window (buildScalpContext `chart.onSeries`). Absent: no EMA lines.
 * @returns {Object} spec for renderChart
 * @throws {ChartRequestError}
 */
export function buildChartSpec(payload, request, series = {}) {
  const { symbol, timeframe } = validateChartRequest(request || {});
  const sym = payload && payload.symbols ? payload.symbols[symbol] : null;
  const tfEntry = sym && sym.timeframes ? sym.timeframes[timeframe] : null;
  const trade = normalizeTradeOverlay(request && request.tradeOverlay);
  // T-13: a trade chart may be handed a longer closed window (buildScalpContext
  // `chartWindow`) than the payload publishes; its EMA series then come with it.
  const win = series && series.window && Array.isArray(series.window.candles) ? series.window : null;
  const source = win ? win.candles.slice(-TRADE_CHART_CANDLES) : (tfEntry && Array.isArray(tfEntry.candles) ? tfEntry.candles : []);
  const candles = source.filter((c) => c && [c.o, c.h, c.l, c.c].every(isFiniteNumber));
  if (win && candles.length === source.length) {
    const n = candles.length;
    series = { ema21: Array.isArray(win.ema21) ? win.ema21.slice(-n) : null, ema200: Array.isArray(win.ema200) ? win.ema200.slice(-n) : null };
  }
  if (candles.length === 0) {
    throw new ChartRequestError(`No closed candles for ${symbol} ${timeframe} in this build.`, 'no_data');
  }

  // T-16: the ENTRY / EXIT time markers resolve to a candle index once the actual candle
  // window is known (a marker time before the window's first candle or after its last one
  // clamps to that edge, so a fill reported a little after the last closed candle still
  // draws at the right edge instead of vanishing).
  if (trade) {
    trade.entryIndex = candleIndexAt(candles, trade.entryAt ? Date.parse(trade.entryAt) : NaN);
    if (trade.exit) trade.exit.index = candleIndexAt(candles, trade.exit.at ? Date.parse(trade.exit.at) : NaN);
  }
  const indicators = Array.isArray(request && request.indicators) ? request.indicators.filter((x) => x === 'rsi14') : [];
  const rsi14 = indicators.includes('rsi14') ? computeRSI14(candles) : null;

  const geometry = CANDLES_ONLY_TIMEFRAMES.includes(timeframe)
    ? null
    : ((sym.geometryContext && sym.geometryContext[timeframe]) || null);
  // A trade chart draws the plan's own lines instead of every candidate's dashed levels.
  const candidates = trade ? [] : (Array.isArray(sym.candidateSetups) ? sym.candidateSetups : [])
    .filter((s) => s && s.timeframe === timeframe);
  const te = tfEntry || {};

  return {
    symbol,
    timeframe,
    closedThrough: te.closedThrough || payload.closedThrough || null,
    candles,
    ema21: { value: te.ema21, series: alignSeries(series && series.ema21, candles.length) },
    ema200: { value: te.ema200, series: alignSeries(series && series.ema200, candles.length) },
    geometry,
    candidates,
    trade,
    indicators,
    rsi14
  };
}

/** The index of the first candle at or after `atMs` (ISO/ms parsed by the caller), clamped
 * to the last candle when `atMs` is at or after the window's end; null when `atMs` is not
 * a finite time or there are no candles. */
function candleIndexAt(candles, atMs) {
  if (!isFiniteNumber(atMs) || !Array.isArray(candles) || candles.length === 0) return null;
  const idx = candles.findIndex((c) => c && c.t && Date.parse(c.t) >= atMs - 1);
  return idx === -1 ? candles.length - 1 : idx;
}

/**
 * T-13 trade overlay request -> the normalized shape the renderer draws, or null when
 * entry / stop / TP1 are not all finite or not on the right sides for the direction.
 * @param {Object|null} t - {direction, entry, stop, tp1, tp2?, nfStop?, grossRR?, netRR?,
 *   entryAt?, exit?}
 *   `entryAt` (T-16): ISO string, Date or ms epoch for the vertical ENTRY marker; absent or
 *   unparseable -> no marker. `exit` (T-16): {price, at?, r?} for the journal-close card's
 *   EXIT marker; `r` defaults to the R multiple of `price` against entry/stop, `at` defaults
 *   to the window's last candle when absent.
 * @returns {Object|null}
 */
export function normalizeTradeOverlay(t) {
  if (!t || typeof t !== 'object') return null;
  const direction = t.direction === 'short' ? 'short' : t.direction === 'long' ? 'long' : null;
  const { entry, stop, tp1 } = t;
  if (!direction || ![entry, stop, tp1].every(isFiniteNumber)) return null;
  const sign = direction === 'short' ? -1 : 1;
  if (sign * (entry - stop) <= 0 || sign * (tp1 - entry) <= 0) return null;
  const tp2 = isFiniteNumber(t.tp2) && sign * (t.tp2 - tp1) > 0 ? t.tp2 : null;
  const nfStop = isFiniteNumber(t.nfStop) && sign * (entry - t.nfStop) > 0 && Math.abs(t.nfStop - stop) > 1e-9 ? t.nfStop : null;
  return {
    direction,
    entry,
    stop,
    tp1,
    tp2,
    nfStop,
    grossRR: isFiniteNumber(t.grossRR) ? t.grossRR : Math.abs(tp1 - entry) / Math.abs(entry - stop),
    netRR: isFiniteNumber(t.netRR) ? t.netRR : null,
    entryAt: normalizeIso(t.entryAt),
    exit: normalizeExit(t.exit, direction, entry, stop)
  };
}

/** An ISO string from a Date, ms epoch or ISO string; null when it does not parse. */
function normalizeIso(v) {
  if (v === undefined || v === null) return null;
  const ms = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** T-16 EXIT marker: {price, at, r}, or null without a finite price. */
function normalizeExit(e, direction, entry, stop) {
  if (!e || typeof e !== 'object' || !isFiniteNumber(e.price)) return null;
  const r = isFiniteNumber(e.r)
    ? e.r
    : (entry !== stop ? Math.round((direction === 'short' ? -1 : 1) * (e.price - entry) / Math.abs(entry - stop) * 100) / 100 : null);
  return { price: e.price, at: normalizeIso(e.at), r };
}

/** Legend text for a trade overlay: "R 1:2.8 gross · 1:0.9 net" (net "n/a" when unknown). */
export function tradeLegendText(trade) {
  if (!trade) return '';
  const r = (v) => (isFiniteNumber(v) ? (Math.round(v * 10) / 10).toFixed(1) : 'n/a');
  return `R 1:${r(trade.grossRR)} gross · 1:${r(trade.netRR)} net`;
}

function alignSeries(values, n) {
  if (!Array.isArray(values) || values.length !== n) return null;
  return values.map((v) => (isFiniteNumber(v) ? v : null));
}

/**
 * Horizontal levels and diagonal lines to draw, in price terms. Diagonals are
 * reconstructed from the payload's currentLevel and slope (percent of currentLevel per
 * candle), so the line matches what the payload states at the newest candle.
 */
function overlays(spec) {
  const n = spec.candles.length;
  const bands = [];
  const lines = [];
  const levels = [];
  const g = spec.geometry;

  if (g) {
    // Coloured by role relative to price (the list the payload puts it in), not by
    // which pivots formed it: old highs below price read as support here.
    for (const [list, color] of [[g.horizontalSupportZones, CHART_COLORS.zoneSupport], [g.horizontalResistanceZones, CHART_COLORS.zoneResistance]]) {
      for (const z of list || []) {
        if (!z || !isFiniteNumber(z.low) || !isFiniteNumber(z.high)) continue;
        bands.push({ low: Math.min(z.low, z.high), high: Math.max(z.low, z.high), color });
      }
    }
    const inChannel = Boolean(g.channel && g.channel.detected);
    for (const [key, side] of [['diagonalSupport', 'S'], ['diagonalResistance', 'R']]) {
      const d = g[key];
      if (!d || !d.detected || !isFiniteNumber(d.currentLevel) || !isFiniteNumber(d.slope)) continue;
      const perCandle = (d.slope / 100) * d.currentLevel;
      const color = inChannel ? CHART_COLORS.channel : CHART_COLORS[key];
      lines.push({ from: d.currentLevel - perCandle * (n - 1), to: d.currentLevel, color });
      levels.push({ price: d.currentLevel, color, label: `${inChannel ? 'ch' : 'diag'} ${side}` });
    }
  }

  for (const s of spec.candidates) {
    const color = s.direction === 'short' ? CHART_COLORS.candidateShort : CHART_COLORS.candidateLong;
    const tag = s.direction === 'short' ? 'S' : 'L';
    const named = [
      ['flag hi', s.flagHigh],
      ['flag lo', s.flagLow],
      ['brk', s.breakoutLevel],
      ['inv', s.invalidation]
    ].filter(([, p]) => isFiniteNumber(p));
    // Breakout and invalidation coincide with a flag edge; one dashed line per price.
    const byPrice = new Map();
    for (const [name, p] of named) byPrice.set(p, [...(byPrice.get(p) || []), name]);
    for (const [p, names] of byPrice) levels.push({ price: p, color, dashed: true, label: `${tag} ${names.join('/')}` });
  }

  const t = spec.trade;
  if (t) {
    // Risk band entry<->stop (red 15 %), reward band entry<->TP1 (green 15 %); solid
    // entry / stop / TP lines; the NF shadow stop dashed red when it differs.
    bands.push({ low: Math.min(t.entry, t.stop), high: Math.max(t.entry, t.stop), color: CHART_COLORS.riskBand, trade: 'risk' });
    bands.push({ low: Math.min(t.entry, t.tp1), high: Math.max(t.entry, t.tp1), color: CHART_COLORS.rewardBand, trade: 'reward' });
    levels.push({ price: t.entry, color: CHART_COLORS.tradeEntry, solid: true, force: true, label: 'entry' });
    levels.push({ price: t.stop, color: CHART_COLORS.tradeStop, solid: true, force: true, label: 'stop' });
    levels.push({ price: t.tp1, color: CHART_COLORS.tradeTarget, solid: true, force: true, label: 'TP1' });
    if (t.tp2 !== null) levels.push({ price: t.tp2, color: CHART_COLORS.tradeTarget, solid: true, force: true, label: 'TP2' });
    if (t.nfStop !== null) levels.push({ price: t.nfStop, color: CHART_COLORS.tradeStop, dashed: true, force: true, label: 'NF stop' });
  }

  return { bands, lines, levels };
}

/**
 * The overlay items (bands, lines, levels) a spec draws, in price terms. Exported for
 * tests (T-13 trade overlay geometry).
 * @param {Object} spec - buildChartSpec output
 */
export function chartOverlays(spec) {
  return overlays(spec);
}

/**
 * Price range and pixel mapping for a spec. Exported so the test suite can assert
 * that an overlay lands on the pixel row its price maps to.
 * @param {Object} spec - buildChartSpec output
 * @returns {{min:number, max:number, yOf:(p:number)=>number, xOf:(i:number)=>number, slot:number}}
 */
export function computeLayout(spec) {
  const n = spec.candles.length;
  let lo = Math.min(...spec.candles.map((c) => c.l));
  let hi = Math.max(...spec.candles.map((c) => c.h));
  const span = Math.max(hi - lo, Math.abs(hi) * 1e-4, 1e-9);
  const reachLo = lo - RANGE_REACH * span;
  const reachHi = hi + RANGE_REACH * span;
  const { bands, lines, levels } = overlays(spec);
  const extras = [
    ...[spec.ema21, spec.ema200].flatMap((e) => (e.series || [e.value])),
    ...bands.flatMap((b) => [b.low, b.high]),
    ...lines.flatMap((l) => [l.from, l.to]),
    ...levels.map((l) => l.price)
  ].filter((p) => isFiniteNumber(p) && p >= reachLo && p <= reachHi);
  // Trade lines (T-13) always join the range: a stop or TP off the chart defeats the point.
  for (const l of levels) if (l.force && isFiniteNumber(l.price)) extras.push(l.price);
  for (const b of bands) if (b.trade) extras.push(b.low, b.high);
  for (const p of extras) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const pad = (hi - lo || span) * 0.05;
  const min = lo - pad;
  const max = hi + pad;
  const plotH = PLOT.bottom - PLOT.top;
  const slot = (PLOT.right - PLOT.left) / n;
  return {
    min,
    max,
    slot,
    yOf: (p) => Math.round(PLOT.top + ((max - p) / (max - min)) * plotH),
    xOf: (i) => Math.round(PLOT.left + slot * (i + 0.5))
  };
}

/**
 * Wilder RSI(`period`) from a candle window's closes, aligned 1:1 with `candles` (null
 * until the average has `period` deltas to seed on). Mirrors the owner-approved reference
 * script (`mock-trades-v2.mjs`) exactly - no new library, same recurrence used everywhere.
 * @param {Array<{c:number}>} candles
 * @param {number} [period=RSI_PERIOD]
 * @returns {Array<number|null>}
 */
export function computeRSI14(candles, period = RSI_PERIOD) {
  const closes = (Array.isArray(candles) ? candles : []).map((c) => (c && isFiniteNumber(c.c) ? c.c : NaN));
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(closes[i]) || !Number.isFinite(closes[i - 1])) continue;
    const delta = closes[i] - closes[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 1e9 : avgGain / avgLoss));
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 1e9 : avgGain / avgLoss));
  }
  return out;
}

/**
 * RSI panel geometry (T-16), or null when the spec carries no `rsi14` indicator. Exported
 * so tests can assert an RSI value lands on the pixel row it maps to, the same pattern as
 * `computeLayout` for the price panel.
 * @param {Object} spec - buildChartSpec output
 */
export function computeIndicatorLayout(spec) {
  if (!spec || !Array.isArray(spec.indicators) || !spec.indicators.includes('rsi14')) return null;
  const top = CHART_HEIGHT + INDICATOR_TOP_PAD;
  const bottom = CHART_HEIGHT + RSI_PANEL_HEIGHT - INDICATOR_BOTTOM_PAD;
  return {
    top,
    bottom,
    left: PLOT.left,
    right: PLOT.right,
    yOf: (v) => Math.round(bottom - (v / 100) * (bottom - top))
  };
}

/** Total canvas height for a spec: the price panel, plus the RSI panel when requested. */
export function chartCanvasHeight(spec) {
  return CHART_HEIGHT + (spec && Array.isArray(spec.indicators) && spec.indicators.includes('rsi14') ? RSI_PANEL_HEIGHT : 0);
}

// --- raw pixel primitives (opaque, clipped) ---------------------------------

function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function makePainter(bitmap) {
  const { data, width, height } = bitmap;
  const put = (x, y, c, clip) => {
    if (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom) return;
    const o = (y * width + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  };
  const full = { left: 0, top: 0, right: width, bottom: height };
  const rect = (x0, y0, x1, y1, hex, clip = full) => {
    const c = rgb(hex);
    const xa = Math.max(Math.min(x0, x1), clip.left);
    const xb = Math.min(Math.max(x0, x1), clip.right - 1);
    const ya = Math.max(Math.min(y0, y1), clip.top);
    const yb = Math.min(Math.max(y0, y1), clip.bottom - 1);
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) put(x, y, c, clip);
  };
  // Bresenham with a square brush `w` px wide; `dash` = [on, off] in px along x/y.
  const line = (x0, y0, x1, y1, hex, w = 1, clip = full, dash = null) => {
    const c = rgb(hex);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const off = Math.floor((w - 1) / 2);
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (let step = 0; ; step++) {
      if (!dash || step % (dash[0] + dash[1]) < dash[0]) {
        for (let by = 0; by < w; by++) for (let bx = 0; bx < w; bx++) put(x + bx - off, y + by - off, c, clip);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  };
  return { rect, line };
}

function ensureFont() {
  if (fontLoaded) return;
  PImage.registerFont(FONT_PATH, FONT_FAMILY).loadSync();
  fontLoaded = true;
}

function fmtPrice(p) {
  const a = Math.abs(p);
  const d = a >= 1000 ? 1 : (a >= 10 ? 2 : 4);
  return p.toFixed(d);
}

/** "09-26 09:07z" from an ISO string (month-day hour:minute, UTC, as the reference script prints it). */
function fmtMarkerTime(iso) {
  return iso ? `${String(iso).slice(5, 16).replace('T', ' ')}z` : '';
}

/** "+1.8R" / "-1.0R" / "R n/a". */
function fmtSignedR(v) {
  return isFiniteNumber(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(Math.round(v * 10) / 10).toFixed(1)}R` : 'R n/a';
}

/** Spread labels vertically so none overlap; keeps input order for equal rows. */
function stackLabels(items, top, bottom) {
  const sorted = items.slice().sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    sorted[i].ty = Math.max(top, prev ? Math.max(sorted[i].y, prev.ty + LABEL_GAP_PX) : sorted[i].y);
  }
  const overflow = sorted.length > 0 ? sorted[sorted.length - 1].ty - bottom : 0;
  if (overflow > 0) for (const s of sorted) s.ty -= overflow;
  return sorted;
}

async function encodePng(bitmap) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  await PImage.encodePNGToStream(bitmap, stream);
  return Buffer.concat(chunks);
}

/**
 * Render a spec to PNG bytes.
 * @param {Object} spec - buildChartSpec output
 * @returns {Promise<Buffer>}
 * @throws {ChartRequestError} on an unknown symbol/timeframe or an empty candle window
 */
export async function renderChart(spec) {
  validateChartRequest(spec || {});
  if (!Array.isArray(spec.candles) || spec.candles.length === 0) {
    throw new ChartRequestError(`No closed candles for ${spec.symbol} ${spec.timeframe}.`, 'no_data');
  }
  ensureFont();

  const totalHeight = chartCanvasHeight(spec);
  const bitmap = PImage.make(CHART_WIDTH, totalHeight);
  const ctx = bitmap.getContext('2d');
  const paint = makePainter(bitmap);
  const clip = PLOT;
  const L = computeLayout(spec);
  const { bands, lines, levels } = overlays(spec);
  const n = spec.candles.length;

  paint.rect(0, 0, CHART_WIDTH - 1, totalHeight - 1, CHART_COLORS.background);

  // Grid: five price rows.
  const gridPrices = [];
  for (let k = 0; k <= 4; k++) gridPrices.push(L.min + ((L.max - L.min) * k) / 4);
  for (const p of gridPrices) paint.line(PLOT.left, L.yOf(p), PLOT.right - 1, L.yOf(p), CHART_COLORS.grid, 1, clip);

  // Zones first, so candles and lines sit on top of the bands.
  for (const b of bands) paint.rect(PLOT.left, L.yOf(b.high), PLOT.right - 1, L.yOf(b.low), b.color, clip);

  // Candles.
  const body = Math.max(1, Math.floor(L.slot * 0.6));
  spec.candles.forEach((c, i) => {
    const x = L.xOf(i);
    const color = c.c >= c.o ? CHART_COLORS.up : CHART_COLORS.down;
    paint.line(x, L.yOf(c.h), x, L.yOf(c.l), color, 1, clip);
    const half = Math.floor(body / 2);
    paint.rect(x - half, L.yOf(Math.max(c.o, c.c)), x - half + body - 1, L.yOf(Math.min(c.o, c.c)), color, clip);
  });

  // Diagonals / channel.
  for (const ln of lines) paint.line(L.xOf(0), L.yOf(ln.from), L.xOf(n - 1), L.yOf(ln.to), ln.color, 2, clip);

  // EMAs.
  for (const [ema, color] of [[spec.ema200, CHART_COLORS.ema200], [spec.ema21, CHART_COLORS.ema21]]) {
    if (!ema.series) continue;
    for (let i = 1; i < n; i++) {
      const a = ema.series[i - 1];
      const b = ema.series[i];
      if (a === null || b === null) continue;
      paint.line(L.xOf(i - 1), L.yOf(a), L.xOf(i), L.yOf(b), color, 2, clip);
    }
  }

  // Candidate levels: dashed, full width. Trade lines (T-13): solid, 2 px.
  for (const lv of levels) {
    if (lv.dashed) paint.line(PLOT.left, L.yOf(lv.price), PLOT.right - 1, L.yOf(lv.price), lv.color, lv.force ? 2 : 1, clip, [6, 4]);
    else if (lv.solid) paint.line(PLOT.left, L.yOf(lv.price), PLOT.right - 1, L.yOf(lv.price), lv.color, 2, clip);
  }

  // Text: title, legend, axis, labels.
  ctx.font = `14px ${FONT_FAMILY}`;
  ctx.fillStyle = CHART_COLORS.text;
  const tradeTag = spec.trade ? ` · ${spec.trade.direction === 'short' ? 'SHORT' : 'LONG'} TRADE` : '';
  ctx.fillText(`${spec.symbol} · ${spec.timeframe}${tradeTag} · closedThrough ${spec.closedThrough || 'unknown'}`, PLOT.left, 18);
  ctx.font = `11px ${FONT_FAMILY}`;
  const legend = [
    [`EMA21 ${isFiniteNumber(spec.ema21.value) ? fmtPrice(spec.ema21.value) : 'n/a'}`, CHART_COLORS.ema21],
    [`EMA200 ${isFiniteNumber(spec.ema200.value) ? fmtPrice(spec.ema200.value) : 'n/a'}`, CHART_COLORS.ema200],
    [`${n} closed candles`, CHART_COLORS.muted],
    ...(spec.trade ? [[tradeLegendText(spec.trade), CHART_COLORS.text]] : [])
  ];
  let lx = PLOT.left;
  for (const [text, color] of legend) {
    ctx.fillStyle = color;
    ctx.fillText(text, lx, 34);
    lx += (text.length + 3) * 7;
  }

  const first = spec.candles[0].t;
  const last = spec.candles[n - 1].t;
  if (first) ctx.fillText(String(first).slice(0, 16).replace('T', ' '), PLOT.left, CHART_HEIGHT - 8);
  if (last) ctx.fillText(String(last).slice(0, 16).replace('T', ' '), PLOT.right - 112, CHART_HEIGHT - 8);

  // Gutter labels: last close and every named level, stacked to avoid overlap, each
  // with a short tick at its true row. Grid prices fill in only where there is room.
  const lastClose = spec.candles[n - 1].c;
  const labelItems = [
    { y: L.yOf(lastClose), color: CHART_COLORS.lastPrice, text: fmtPrice(lastClose) },
    ...levels.map((lv) => ({ y: L.yOf(lv.price), color: lv.color, text: `${lv.label} ${fmtPrice(lv.price)}` }))
  ].filter((it) => it.y >= PLOT.top && it.y <= PLOT.bottom);
  const placed = stackLabels(labelItems, PLOT.top + 4, PLOT.bottom - 2);
  for (const it of placed) {
    paint.line(PLOT.right, it.y, PLOT.right + 4, it.y, it.color, 1);
    ctx.fillStyle = it.color;
    ctx.fillText(it.text, PLOT.right + 8, it.ty + 4);
  }
  ctx.fillStyle = CHART_COLORS.muted;
  for (const p of gridPrices) {
    const y = L.yOf(p);
    if (placed.every((it) => Math.abs(it.ty - y) >= LABEL_GAP_PX)) ctx.fillText(fmtPrice(p), PLOT.right + 8, y + 4);
  }

  // T-16: RSI(14) panel under the price panel, then the ENTRY / EXIT time markers on top of
  // everything - they cut straight through both panels, so they are drawn last.
  const rsiLayout = computeIndicatorLayout(spec);
  if (rsiLayout) drawRsiPanel(paint, ctx, spec, L, rsiLayout);
  drawTradeMarkers(paint, ctx, spec, L, rsiLayout, totalHeight);

  return encodePng(bitmap);
}

/** RSI(14) panel: 30/50/70 guides with labels, the RSI line, and its own header. */
function drawRsiPanel(paint, ctx, spec, L, L2) {
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.fillText(`RSI(14) · ${spec.timeframe}`, L2.left, CHART_HEIGHT + 14);
  for (const lv of [30, 50, 70]) {
    const y = L2.yOf(lv);
    paint.line(L2.left, y, L2.right - 1, y, CHART_COLORS.grid, 1);
    ctx.fillStyle = CHART_COLORS.muted;
    ctx.fillText(String(lv), L2.right + 8, y + 4);
  }
  const rsi = Array.isArray(spec.rsi14) ? spec.rsi14 : [];
  let prevX = 0;
  let prevY = 0;
  let started = false;
  for (let i = 0; i < spec.candles.length; i++) {
    const v = rsi[i];
    if (!isFiniteNumber(v)) { started = false; continue; }
    const x = L.xOf(i);
    const y = L2.yOf(v);
    if (started) paint.line(prevX, prevY, x, y, CHART_COLORS.rsi, 2);
    prevX = x;
    prevY = y;
    started = true;
  }
}

/**
 * ENTRY (white, dashed) and EXIT (amber, dashed) vertical time markers, each with a label:
 * "ENTRY LONG 09-26 09:07z" (+ "RSI at entry 51.1" when the RSI panel is present) and
 * "EXIT 84,204.90 · +1.0R". Drawn full-height so a marker reads through both panels.
 */
function drawTradeMarkers(paint, ctx, spec, L, rsiLayout, totalHeight) {
  const t = spec.trade;
  if (!t) return;
  const bottom = totalHeight - 18;
  const labelX = (x) => Math.min(x + 6, CHART_WIDTH - 300);
  ctx.font = `12px ${FONT_FAMILY}`;
  if (isFiniteNumber(t.entryIndex)) {
    const x = L.xOf(t.entryIndex);
    paint.line(x, MARKER_TOP, x, bottom, CHART_COLORS.entryMarker, 1, undefined, [4, 4]);
    ctx.fillStyle = CHART_COLORS.entryMarker;
    ctx.fillText(`ENTRY ${t.direction.toUpperCase()} ${fmtMarkerTime(t.entryAt)}`, labelX(x), 56);
    if (rsiLayout) {
      const rv = Array.isArray(spec.rsi14) ? spec.rsi14[t.entryIndex] : null;
      ctx.fillText(`RSI at entry ${isFiniteNumber(rv) ? rv.toFixed(1) : 'n/a'}`, labelX(x), rsiLayout.top + 14);
    }
  }
  if (t.exit && isFiniteNumber(t.exit.index)) {
    const x = L.xOf(t.exit.index);
    paint.line(x, MARKER_TOP, x, bottom, CHART_COLORS.exitMarker, 1, undefined, [2, 4]);
    ctx.fillStyle = CHART_COLORS.exitMarker;
    ctx.fillText(`EXIT ${fmtPrice(t.exit.price)} · ${fmtSignedR(t.exit.r)}`, labelX(x), 74);
  }
}

/**
 * Parse-free convenience for callers: spec + render + timing in one call.
 * @param {Object} payload - buildScalpContext() output
 * @param {{symbol:string, timeframe:string}} request - parseChartArg output
 * @param {Object} [series] - EMA series captured via buildScalpContext `chart.onSeries`
 * @returns {Promise<{png:Buffer, bytes:number, durationMs:number}>}
 * @throws {ChartRequestError}
 */
export async function renderContextChart(payload, request, series) {
  const startedAt = Date.now();
  const png = await renderChart(buildChartSpec(payload, request, series));
  return { png, bytes: png.length, durationMs: Date.now() - startedAt };
}

export default {
  parseChartArg,
  buildChartSpec,
  normalizeTradeOverlay,
  tradeLegendText,
  chartOverlays,
  TRADE_CHART_CANDLES,
  computeLayout,
  computeIndicatorLayout,
  computeRSI14,
  chartCanvasHeight,
  renderChart,
  renderContextChart,
  ChartRequestError,
  CHART_SYMBOLS,
  CHART_TIMEFRAMES,
  CHART_COLORS,
  CHART_WIDTH,
  CHART_HEIGHT,
  CHART_MAX_BYTES,
  RSI_PERIOD,
  RSI_PANEL_HEIGHT
};
