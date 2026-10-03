/**
 * Flow evidence for a trade candidate: volume quality, RSI, Stoch RSI and RSI divergence.
 * Pure functions, no I/O. Candles are closed, oldest first: { openMs, closeMs, o, h, l, c, v }.
 * dir is 'long' | 'short'. Every number is guarded with Number.isFinite.
 */

const fin = Number.isFinite;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const r1 = (x) => Math.round(x * 10) / 10;
const NO_VOLUME = Object.freeze({
  relVol: null, breakoutRelVol: null, flagRelVol: null, trend: null,
  quality: 'UNKNOWN', verdict: 'NO DATA', reason: 'no volume data'
});

/** Volume quality of the last (trigger) candle against the 20 candles before it. */
export function volumeQuality(candles, dir, opts = {}) {
  const lookback = opts.lookback ?? 20;
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < lookback + 2) return { ...NO_VOLUME };
  const vols = candles.map((c) => Number(c?.v));
  const need = vols.slice(n - lookback - 1);
  if (need.some((v) => !fin(v) || v < 0)) return { ...NO_VOLUME };
  const avg = mean(vols.slice(n - lookback - 1, n - 1));
  if (!fin(avg) || avg <= 0) return { ...NO_VOLUME };

  const last = candles[n - 1];
  const breakoutRelVol = vols[n - 1] / avg;
  const flagRelVol = mean(vols.slice(n - 6, n - 1)) / avg;
  const recent = mean(vols.slice(n - 3));
  const prev = mean(vols.slice(n - 6, n - 3));
  let trend = 'flat';
  if (prev > 0 && recent > prev * 1.15) trend = 'rising';
  else if (prev > 0 && recent < prev * 0.85) trend = 'falling';
  else if (prev === 0 && recent > 0) trend = 'rising';

  const body = last.c - last.o;
  const withTrade = fin(body) && (dir === 'long' ? body > 0 : body < 0);
  const against = fin(body) && (dir === 'long' ? body < 0 : body > 0);

  let quality;
  if (breakoutRelVol >= 1.5 && withTrade && flagRelVol <= 1.0) quality = 'STRONG';
  else if (breakoutRelVol >= 1.0 && withTrade) quality = 'OK';
  else if (breakoutRelVol < 0.8 || against) quality = 'WEAK';
  else quality = 'OK';

  const x = `${r1(breakoutRelVol)}x avg`;
  let reason;
  if (against) reason = `breakout vol ${x}, candle against trade`;
  else if (quality === 'WEAK') reason = `breakout vol ${x}, no push`;
  else if (quality === 'STRONG') reason = `breakout vol ${x}, quiet flag`;
  else reason = `breakout vol ${x}${flagRelVol > 1.0 ? ', busy flag' : ''}`;

  return {
    relVol: breakoutRelVol, breakoutRelVol, flagRelVol, trend, quality,
    verdict: quality === 'WEAK' ? 'STAY OUT' : 'GO', reason
  };
}

/** Wilder RSI aligned to closes (null during warmup). */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (!fin(d)) return out;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const rsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = rsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (!fin(d)) return out;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsi();
  }
  return out;
}

function sma(series, len) {
  return series.map((_, i) => {
    if (i < len - 1) return null;
    const w = series.slice(i - len + 1, i + 1);
    return w.every(fin) ? mean(w) : null;
  });
}

/** Last Stoch RSI { k, d } on a 0-100 scale, or null when there is not enough history. */
export function stochRsi(closes, { rsiPeriod = 14, stochPeriod = 14, k = 3, d = 3 } = {}) {
  const rsi = rsiSeries(closes, rsiPeriod);
  const raw = rsi.map((_, i) => {
    if (i < stochPeriod - 1) return null;
    const w = rsi.slice(i - stochPeriod + 1, i + 1);
    if (!w.every(fin)) return null;
    const lo = Math.min(...w);
    const hi = Math.max(...w);
    return hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100;
  });
  const kS = sma(raw, k);
  const dS = sma(kS, d);
  const kv = kS[kS.length - 1];
  const dv = dS[dS.length - 1];
  return fin(kv) && fin(dv) ? { k: kv, d: dv } : null;
}

/** 'overbought' | 'oversold' | 'rising' (k >= d) | 'falling' (k < d). dir is accepted for symmetry. */
export function stochState(k, d) {
  if (k > 80 && d > 80) return 'overbought';
  if (k < 20 && d < 20) return 'oversold';
  return k >= d ? 'rising' : 'falling';
}

/** Does the Stoch RSI state support the trade direction? */
export function stochFavors(state, k, dir) {
  if (dir === 'long') return state === 'oversold' || (state === 'rising' && k < 80);
  return state === 'overbought' || (state === 'falling' && k > 20);
}

/** Regular RSI divergence over the last ~40 candles. Pivots need `pivot` bars on the left, at least 1 on the right. */
export function divergence(candles, rsi, opts = {}) {
  const pivot = opts.pivot ?? 3;
  const span = opts.span ?? 40;
  const none = { type: null, against: false };
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < pivot + 3 || !Array.isArray(rsi)) return none;
  const lo = Math.max(0, n - span);
  const highs = [];
  const lows = [];
  for (let i = lo + pivot; i <= n - 2; i++) {
    if (!fin(rsi[i]) || !fin(candles[i].h) || !fin(candles[i].l)) continue;
    const right = Math.min(pivot, n - 1 - i);
    let isHigh = true;
    let isLow = true;
    for (let j = i - pivot; j <= i + right; j++) {
      if (j === i) continue;
      if (!(candles[i].h > candles[j].h)) isHigh = false;
      if (!(candles[i].l < candles[j].l)) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  let type = null;
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const bear = h2 !== undefined && candles[h2].h > candles[h1].h && rsi[h2] < rsi[h1];
  const bull = l2 !== undefined && candles[l2].l < candles[l1].l && rsi[l2] > rsi[l1];
  if (bear && bull) type = h2 > l2 ? 'bearish' : 'bullish';
  else if (bear) type = 'bearish';
  else if (bull) type = 'bullish';
  return { type, against: (type === 'bearish' && opts.dir === 'long') || (type === 'bullish' && opts.dir === 'short') };
}

/** Combined volume + momentum evidence for a trade candidate. */
export function flowEvidence(candles, dir) {
  const volume = volumeQuality(candles, dir);
  const closes = (Array.isArray(candles) ? candles : []).map((c) => Number(c?.c));
  const rsi = rsiSeries(closes);
  const rsiLast = rsi.length ? rsi[rsi.length - 1] : null;
  const rsiVal = fin(rsiLast) ? r1(rsiLast) : null;
  const st = stochRsi(closes);
  const stoch = st
    ? (() => {
        const state = stochState(st.k, st.d, dir);
        return { k: st.k, d: st.d, state, favors: stochFavors(state, st.k, dir) };
      })()
    : null;
  const div = divergence(candles, rsi, { dir });

  let verdict;
  const hot = rsiVal !== null && (dir === 'long' ? rsiVal > 75 : rsiVal < 25);
  if (volume.verdict === 'STAY OUT') verdict = 'STAY OUT';
  else if (div.against || (stoch && !stoch.favors) || hot) verdict = 'CAUTION';
  else verdict = volume.verdict;

  const vLine = volume.quality === 'UNKNOWN'
    ? 'Volume n/a → NO DATA'
    : `Volume ${volume.quality} · ${r1(volume.breakoutRelVol)}x avg${volume.quality === 'STRONG' ? ' · quiet flag' : ''} → ${volume.verdict}`;
  const parts = [rsiVal !== null ? `RSI ${Math.round(rsiVal)}` : 'RSI n/a'];
  if (stoch) parts.push(`Stoch ${Math.round(stoch.k)}/${Math.round(stoch.d)} ${stoch.state}`);
  parts.push(div.type ? `${div.type} div${div.against ? ' ⚠️' : ''}` : 'no divergence');

  return { volume, rsi: rsiVal, stoch, divergence: div, verdict, lines: { volume: vLine, momentum: parts.join(' · ') } };
}
