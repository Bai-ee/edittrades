/**
 * In-trade updates (owner 2026-10-04: "when locked in I want regular updates on intervals related
 * to the tf, about % up or down since entry and confidence in the trade from that point on").
 *
 * For a taken lock (I'm in -> `filled`): one update per closed candle of the lock's timeframe,
 * at least 5 min and at most 60 min apart. The update reads % and R since the fill, the distance
 * to TP and SL, and a 0-100 confidence that the trade still works from here:
 *
 *   checklist share with the trade      30
 *   next timeframe up with the trade    15 (mixed 7)
 *   price on the trade side of EMA21    15 (lock timeframe)
 *   Stoch RSI favors the trade          15
 *   no divergence against the trade     15
 *   RSI not stretched (long <75/short >25) 10
 *
 * >= 65 hold, 45-64 watch, < 45 turning against. Display only: never moves a level or closes
 * the lock. Pure functions, no I/O.
 */
import { LOCK_TF_MS, lockR, timeframesAbove } from './tradeLock.js';
import { escapeHtml, fmtLvl } from './telegram.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MIN_MS = 60_000;

export const TRADE_UPDATE_MIN_MS = 5 * MIN_MS;
export const TRADE_UPDATE_MAX_MS = 60 * MIN_MS;

/** Update spacing for a lock timeframe: one candle, clamped to 5-60 min. */
export function updateIntervalMs(tf) {
  const ms = LOCK_TF_MS[tf] || TRADE_UPDATE_MIN_MS;
  return Math.min(TRADE_UPDATE_MAX_MS, Math.max(TRADE_UPDATE_MIN_MS, ms));
}

/** True when a taken lock is due an update at `nowMs` (first one an interval after the fill). */
export function updateDue(lock, nowMs) {
  if (!isObj(lock) || lock.status !== 'filled') return false;
  const last = Date.parse(lock.updAt || lock.filledAt);
  return Number.isFinite(last) && nowMs - last >= updateIntervalMs(lock.timeframe);
}

/** Live price for a symbol entry: Pyth mark when ok, else the last close. */
export function livePrice(sym) {
  if (!isObj(sym)) return null;
  if (isObj(sym.mark) && sym.mark.status === 'ok' && isNum(sym.mark.price)) return sym.mark.price;
  return isNum(sym.price) ? sym.price : null;
}

/**
 * Confidence 0-100 that the trade still works from here, with the reasons that cost points.
 * @param {Object} lock - a filled lock (conf rows re-scored by evaluateLock)
 * @param {Object} sym - payload.symbols[lock.symbol] (timeframes with ema21)
 * @param {Object|null} ev - payload.tfEvidence[symbol][tf][direction] (lib/flowEvidence.js)
 * @returns {{score:number, label:string, verdict:'HOLD'|'WATCH'|'EXIT?', against:string[]}}
 */
export function tradeConfidence(lock, sym, ev) {
  const dir = lock.direction === 'short' ? -1 : 1;
  const tf = lock.timeframe;
  const against = [];
  let score = 0;
  const rows = isObj(lock.conf) && Array.isArray(lock.conf.rows) ? lock.conf.rows : [];
  if (rows.length) {
    const share = rows.filter((r) => r.mark === '✅').length / rows.length;
    score += 30 * share;
    if (share < 0.5) against.push(`${rows.filter((r) => r.mark === '✅').length}/${rows.length} timeframes with you`);
  }
  const up = timeframesAbove(tf, 1)[0];
  const upRow = up ? rows.find((r) => r.tf === up) : null;
  if (!up || (upRow && upRow.mark === '✅')) score += 15;
  else if (upRow && upRow.mark === '⚠️') { score += 7; against.push(`${up} mixed`); } else against.push(`${up} against`);
  const t = isObj(sym) && isObj(sym.timeframes) ? sym.timeframes[tf] : null;
  const px = livePrice(sym);
  if (isObj(t) && isNum(t.ema21) && isNum(px)) {
    if (dir * (px - t.ema21) >= 0) score += 15;
    else against.push(`price ${dir === 1 ? 'below' : 'above'} ${tf} EMA21`);
  }
  if (isObj(ev)) {
    if (ev.stoch && ev.stoch.favors) score += 15;
    else if (ev.stoch) against.push(`Stoch ${ev.stoch.state}`);
    if (!(ev.divergence && ev.divergence.against)) score += 15;
    else against.push(`${ev.divergence.type} divergence`);
    const hot = isNum(ev.rsi) && (dir === 1 ? ev.rsi > 75 : ev.rsi < 25);
    if (!hot) score += 10;
    else against.push(`RSI ${Math.round(ev.rsi)} stretched`);
  }
  score = Math.round(score);
  if (score >= 65) return { score, verdict: 'HOLD', label: 'Holding up · stay in', against };
  if (score >= 45) return { score, verdict: 'WATCH', label: 'Mixed · watch it', against };
  return { score, verdict: 'EXIT?', label: 'Turning against you · consider exit', against };
}

const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/** "1 h 10 min" / "25 min" since an ISO time. */
function ago(iso, nowMs) {
  const m = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / MIN_MS));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * The in-trade update text (Telegram HTML):
 *   🔵 ETH 1h ▲ · IN · +0.35% · +0.52R · 1 h 10 min in
 *   Price 2,705.10 · entry 2,695.57
 *   TP 2,715.40 (+0.38% to go) · SL 2,676.84 (-1.04% away)
 *   🟢 Confidence 72/100 · Holding up · stay in
 *   ⚠️ Stoch overbought · 4h mixed
 *   📊 Volume OK · 1.1x avg
 */
export function formatTradeUpdate(lock, sym, ev, nowMs) {
  const dir = lock.direction === 'short' ? -1 : 1;
  const entry = isNum(lock.fillPrice) ? lock.fillPrice : lock.levels.entry;
  const px = livePrice(sym);
  const head = `🔵 <b>${escapeHtml(`${lock.symbol} ${lock.timeframe} ${dir === 1 ? '▲' : '▼'}`)}</b> · IN`;
  if (!isNum(px) || !isNum(entry) || entry === 0) return `${head} · price unavailable this minute`;
  const move = (dir * (px - entry)) / entry * 100;
  const r = lockR(lock, px);
  const { stop, tp1 } = lock.levels;
  const c = tradeConfidence(lock, sym, ev);
  const dot = c.verdict === 'HOLD' ? '🟢' : (c.verdict === 'WATCH' ? '🟡' : '🔴');
  const lines = [
    `${head} · <b>${pct(move)}</b>${isNum(r) ? ` · ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : ''} · ${ago(lock.filledAt, nowMs)} in`,
    `Price ${fmtLvl(px)} · entry ${fmtLvl(entry)}`,
    `${isNum(tp1) ? `TP ${fmtLvl(tp1)} (${pct((dir * (tp1 - px)) / px * 100)} to go) · ` : ''}SL ${fmtLvl(stop)} (${pct((dir * (stop - px)) / px * 100)} away)`,
    `${dot} Confidence <b>${c.score}/100</b> · ${escapeHtml(c.label)}`,
    c.against.length ? `⚠️ ${escapeHtml(c.against.slice(0, 3).join(' · '))}` : null,
    // Volume as context only (the GO / STAY OUT verdict is an entry read, not an in-trade one).
    isObj(ev) && isObj(ev.volume) && ev.volume.quality !== 'UNKNOWN' && isNum(ev.volume.breakoutRelVol) ? `📊 Volume ${escapeHtml(ev.volume.quality)} · ${ev.volume.breakoutRelVol.toFixed(1)}x avg` : null
  ];
  return lines.filter(Boolean).join('\n');
}

/** tfEvidence entry for a lock (its symbol, timeframe and direction) or null. */
export function lockEvidence(payload, lock) {
  const e = payload && isObj(payload.tfEvidence) && isObj(payload.tfEvidence[lock.symbol]) ? payload.tfEvidence[lock.symbol][lock.timeframe] : null;
  return isObj(e) ? (lock.direction === 'short' ? e.short : e.long) || null : null;
}
