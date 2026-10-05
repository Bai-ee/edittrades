/**
 * 24h Brief (owner 2026-10-04: "a button to get the past 24 hours of market action and the next
 * 24 hours likely breakdown"). Per symbol, from the engine's own published fields only:
 *
 *   LAST 24H   change and range to the live price (24 x 1h, else 6 x 4h), volume vs the prior 24h
 *              (4h candles), 4h / 1d trend
 *   NEXT 24H   lean (1d + 4h + 1h trend and the 4h EMA200 side), expected range = price +/- one
 *              daily ATR (closed 1d candles), the nearest 1h/4h support below and resistance
 *              above (changeLevel), 4h Stoch state, and 1h/4h flags forming on the flag board
 *
 * "Likely" is structure, not a forecast: the text says what it is built from. Pure, no I/O.
 */
import { dayMove, changeLevel, escapeHtml, fmtLvl, joinSections } from './telegram.js';
import { closedCandles, simpleAtr } from './tradeLock.js';
import { rankFlags } from './flagFlow.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const GLYPH = { BTC: '₿', ETH: 'Ξ', SOL: '◎' };
const SYMBOLS = ['BTC', 'ETH', 'SOL'];

/**
 * Last 24h to the live price: closed candles (24 x 1h, else 6 x 4h) plus the current price, so
 * the range always contains it and the change runs from the window's open to now.
 * @returns {{changePct:number, low:number, high:number}|null}
 */
export function last24h(s) {
  const m = dayMove(s);
  if (!m) return null;
  const tfs = isObj(s && s.timeframes) ? s.timeframes : {};
  const c = isObj(tfs[m.source]) && Array.isArray(tfs[m.source].candles) ? tfs[m.source].candles.filter((k) => isObj(k) && isNum(k.o)) : [];
  const n = m.source === '1h' ? 24 : 6;
  const open = c.length >= n ? c[c.length - n].o : null;
  if (!isNum(s.price) || !(open > 0)) return m;
  return { changePct: Math.round(((s.price - open) / open) * 10000) / 100, low: Math.min(m.low, s.price), high: Math.max(m.high, s.price) };
}

/** UPTREND / DOWNTREND / FLAT (any casing) -> up / down / flat; null when not published. */
export function trendOf(s, tf) {
  const t = isObj(s && s.timeframes) && isObj(s.timeframes[tf]) ? s.timeframes[tf].trend : null;
  if (typeof t !== 'string') return null;
  const x = t.toLowerCase();
  return x.includes('up') ? 'up' : (x.includes('down') ? 'down' : 'flat');
}

/** Sum of the last 6 closed 4h volumes vs the 6 before: {ratio} or null. */
export function volumeVsPrior(s) {
  const c = isObj(s && s.timeframes) && isObj(s.timeframes['4h']) && Array.isArray(s.timeframes['4h'].candles) ? s.timeframes['4h'].candles : [];
  const v = c.map((k) => (isObj(k) ? k.v : null)).filter(isNum);
  if (v.length < 12) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const prior = sum(v.slice(-12, -6));
  return prior > 0 ? { ratio: Math.round((sum(v.slice(-6)) / prior) * 100) / 100 } : null;
}

/**
 * Next-24h lean from structure: +1 per up trend on 1d / 4h / 1h and +1 above the 4h EMA200
 * (-1 for down / below). >= 2 up-lean, <= -2 down-lean, else range.
 * @returns {{side:'up'|'down'|'range', score:number, of:number}}
 */
export function nextLean(s) {
  let score = 0;
  let of = 0;
  for (const tf of ['1d', '4h', '1h']) {
    const t = trendOf(s, tf);
    if (t === null) continue;
    of++;
    if (t === 'up') score++;
    else if (t === 'down') score--;
  }
  const t4 = isObj(s && s.timeframes) ? s.timeframes['4h'] : null;
  if (isObj(t4) && isNum(t4.ema200) && isNum(s.price)) { of++; score += s.price >= t4.ema200 ? 1 : -1; }
  return { side: score >= 2 ? 'up' : (score <= -2 ? 'down' : 'range'), score, of };
}

/** Expected 24h range: price +/- one simple daily ATR (closed 1d candles); null without data. */
export function expectedRange(s) {
  const atr = simpleAtr(closedCandles(isObj(s && s.timeframes) ? s.timeframes['1d'] : null, '1d'));
  if (!isNum(atr) || !isNum(s.price) || !(s.price > 0)) return null;
  return { low: s.price - atr, high: s.price + atr, pct: Math.round((atr / s.price) * 1000) / 10 };
}

const pct = (v) => `${v >= 0 ? '+' : ''}${v}%`;
const arrow = { up: '▲ up', down: '▼ down', flat: '▬ flat' };

/** One symbol's block. */
function block(sym, s, setups) {
  const m = last24h(s);
  const vol = volumeVsPrior(s);
  const lean = nextLean(s);
  const rng = expectedRange(s);
  const lv = changeLevel(s, 'mixed');
  const st4 = isObj(s.timeframes) && isObj(s.timeframes['4h']) && isObj(s.timeframes['4h'].stochRsi) ? String(s.timeframes['4h'].stochRsi.state || '').toLowerCase() : '';
  const t4 = trendOf(s, '4h');
  const t1d = trendOf(s, '1d');
  const leanDot = lean.side === 'up' ? '🟢' : (lean.side === 'down' ? '🔴' : '⚪');
  const leanWord = lean.side === 'up' ? 'Up-lean' : (lean.side === 'down' ? 'Down-lean' : 'Range / no clear lean');
  const last = [
    `${m ? `<b>${pct(m.changePct)}</b> · range ${fmtLvl(m.low)}–${fmtLvl(m.high)}` : '24h move n/a'}${vol ? ` · volume ${vol.ratio}x prior 24h` : ''}`,
    `Trend 4h ${t4 ? arrow[t4] : 'n/a'} · 1d ${t1d ? arrow[t1d] : 'n/a'}`
  ];
  const next = [
    `${leanDot} ${leanWord} (${lean.score >= 0 ? '+' : ''}${lean.score}/${lean.of} structure)`,
    rng ? `Likely range ${fmtLvl(rng.low)}–${fmtLvl(rng.high)} (±${rng.pct}%, 1 day ATR)` : null,
    lv && (lv.below || lv.above) ? `Watch: ${[lv.above ? `resistance ${fmtLvl(lv.above.price)} (${lv.above.tf})` : null, lv.below ? `support ${fmtLvl(lv.below.price)} (${lv.below.tf})` : null].filter(Boolean).join(' · ')}` : null,
    st4 === 'overbought' || st4 === 'oversold' ? `4h Stoch ${st4} · ${st4 === 'overbought' ? 'upside stretched' : 'downside stretched'}` : null,
    ...setups.map((e) => `Setup: ${e.tf} ${e.dir === 'short' ? 'bear' : 'bull'} flag ${e.stage === 'lockable' ? 'live now' : 'forming'} · ${e.dir === 'short' ? 'below' : 'above'} ${fmtLvl(e.levels.entry)}${isNum(e.levels.target) ? ` → ${fmtLvl(e.levels.target)}` : ''}`)
  ];
  return [
    `${GLYPH[sym] || ''} <b>${escapeHtml(sym)}</b> ${isNum(s.price) ? fmtLvl(s.price) : ''}`,
    // Lines are numbers and fixed words (plus <b>), nothing user-supplied, so no escaping needed.
    '<u>Last 24h</u>', ...last,
    '<u>Next 24h (likely)</u>', ...next.filter(Boolean)
  ].join('\n');
}

/**
 * The 24h Brief text (Telegram HTML).
 * @param {Object} payload - full build with flagBoard (setups) and symbols
 */
export function formatDayBrief(payload, nowMs = Date.now()) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const keys = SYMBOLS.filter((k) => isObj(syms[k]));
  if (!keys.length) return '📅 24H BRIEF\nMarket data unavailable.';
  let ranked = [];
  try { ranked = rankFlags(payload.flagBoard, syms); } catch { ranked = []; }
  const setupsFor = (k) => ranked.filter((e) => e.symbol === k && ['1h', '4h'].includes(e.tf) && ['lockable', 'found'].includes(e.stage)).slice(0, 2);
  return joinSections([
    `📅 <b>24H BRIEF</b> · ${new Date(nowMs).toISOString().slice(0, 16).replace('T', ' ')}Z`,
    ...keys.map((k) => block(k, syms[k], setupsFor(k))),
    '<i>Likely = structure, not a forecast: lean from 1d/4h/1h trend + 4h EMA200; range = one daily ATR; levels = nearest 1h/4h zones.</i>'
  ]);
}
