// Edge-search backtest core (research only). Standalone: reads the deep2y fixture directly,
// builds signals on 1h/4h/1d bars, walks exits on 5m bars. No engine imports.
//
// Conventions (docs/EDGE_SEARCH_2026-09-27.md):
// - Signal on a closed bar; entry at the next 5m bar open at/after that bar's close (no lookahead).
// - Stop and target both inside one 5m bar -> stop (conservative). Trailing stop checked
//   against the bar's adverse extreme BEFORE it is raised by that bar's favorable extreme.
// - Net R = gross R - (round-trip cost % + borrow %/h * hours held) * entry / |entry - stop|.
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE = 'test/fixtures/history/deep2y-2026-09-26';

export function loadBars(symbol, tf, dir = FIXTURE) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `${symbol}_${tf}.json`), 'utf8'));
  const c = Array.isArray(raw) ? raw : raw.candles;
  const n = c.length;
  const b = { n, t: new Float64Array(n), ct: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const k = c[i];
    b.t[i] = k.timestamp; b.ct[i] = k.closeTime ?? k.timestamp; b.o[i] = k.open; b.h[i] = k.high; b.l[i] = k.low; b.c[i] = k.close; b.v[i] = k.volume;
  }
  return b;
}

// ---------------------------------------------------------------- indicators (index-aligned, NaN warmup)

export function ema(x, p) {
  const out = new Float64Array(x.length).fill(NaN);
  const k = 2 / (p + 1);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < p - 1) { s += x[i]; continue; }
    if (i === p - 1) { s += x[i]; out[i] = s / p; continue; }
    out[i] = x[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function sma(x, p) {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= p) s -= x[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

export function stdev(x, p) {
  const m = sma(x, p);
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = p - 1; i < x.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (x[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / p);
  }
  return out;
}

/** Wilder ATR. */
export function atr(b, p = 14) {
  const out = new Float64Array(b.n).fill(NaN);
  let a = 0;
  for (let i = 1; i < b.n; i++) {
    const tr = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    if (i < p) { a += tr; continue; }
    if (i === p) { a = (a + tr) / p; out[i] = a; continue; }
    a = (a * (p - 1) + tr) / p; out[i] = a;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(x, p = 14) {
  const out = new Float64Array(x.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Highest high / lowest low of the N bars BEFORE i (excludes bar i). */
export function donchian(b, n) {
  const hi = new Float64Array(b.n).fill(NaN), lo = new Float64Array(b.n).fill(NaN);
  for (let i = n; i < b.n; i++) {
    let H = -Infinity, L = Infinity;
    for (let j = i - n; j < i; j++) { if (b.h[j] > H) H = b.h[j]; if (b.l[j] < L) L = b.l[j]; }
    hi[i] = H; lo[i] = L;
  }
  return { hi, lo };
}

/** Index of the last bar in `b` whose closeTime <= tMs (the latest CLOSED bar at tMs), or -1. */
export function lastClosedIdx(b, tMs) {
  let lo = 0, hi = b.n - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b.ct[m] <= tMs) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** First index in `b` with t >= tMs, or -1. */
export function firstAtOrAfter(b, tMs) {
  let lo = 0, hi = b.n - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b.t[m] >= tMs) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
}

// ---------------------------------------------------------------- trade simulation on the 5m path

/**
 * @param {Object} p5 - 5m bars
 * @param {Object} s - {dir:'long'|'short', entryTime, stop, target?, trailAtr?, trailMult?, maxHoldH, exitAt?(i5, entry)->bool}
 * @returns {{entryTime, exitTime, entry, exit, stop, grossR, hours, reason}|null}
 */
export function simulate(p5, s) {
  const i0 = firstAtOrAfter(p5, s.entryTime);
  if (i0 < 0) return null;
  const entry = p5.o[i0];
  const long = s.dir === 'long';
  const risk = long ? entry - s.stop : s.stop - entry;
  if (!(risk > 0)) return null;
  let stop = s.stop;
  let best = entry;
  const endT = s.entryTime + s.maxHoldH * 3600e3;
  for (let i = i0; i < p5.n; i++) {
    if (p5.t[i] >= endT) return done(i, p5.o[i], 'timeout');
    const adverse = long ? p5.l[i] : p5.h[i];
    const fav = long ? p5.h[i] : p5.l[i];
    if (long ? adverse <= stop : adverse >= stop) {
      // Gap through the stop fills at the bar open when the open is already beyond it.
      const px = long ? Math.min(stop, p5.o[i]) : Math.max(stop, p5.o[i]);
      return done(i, px, stop === s.stop ? 'stop' : 'trail');
    }
    if (s.target != null && (long ? fav >= s.target : fav <= s.target)) return done(i, s.target, 'target');
    if (s.trailAtr) {
      best = long ? Math.max(best, fav) : Math.min(best, fav);
      const t = long ? best - s.trailMult * s.trailAtr : best + s.trailMult * s.trailAtr;
      stop = long ? Math.max(stop, t) : Math.min(stop, t);
    }
    if (s.exitAt && s.exitAt(i, entry)) return done(i, p5.c[i], 'signal', p5.ct[i]);
  }
  return null; // ran off the end of data: unresolved, dropped

  function done(i, px, reason, tExit = p5.t[i]) {
    const grossR = (long ? px - entry : entry - px) / risk;
    return { entryTime: p5.t[i0], exitTime: tExit, entry, exit: px, stop: s.stop, riskPct: (risk / entry) * 100, grossR, hours: (tExit - p5.t[i0]) / 3600e3, reason };
  }
}

export const COSTS = {
  base: { long: 0.20, short: 0.14, borrowPerH: 0.02 },
  harsh: { long: 0.34, short: 0.14, borrowPerH: 0.024 },
  light: { long: 0.15, short: 0.14, borrowPerH: 0.01 }
};

export function netR(tr, dir, cost) {
  const pct = (dir === 'long' ? cost.long : cost.short) + cost.borrowPerH * tr.hours;
  return tr.grossR - pct / tr.riskPct;
}

// ---------------------------------------------------------------- stats

export function stats(trades, key = 'netR') {
  const r = trades.map((t) => t[key]);
  const n = r.length;
  if (!n) return { n: 0 };
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x <= 0);
  const sorted = [...r].sort((a, b) => a - b);
  let run = 0, maxRun = 0;
  for (const x of r) { if (x <= 0) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
  return {
    n, mean, median: sorted[n >> 1], t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, total: mean * n,
    win: wins.length / n, avgWin: wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0,
    avgLoss: losses.length ? -losses.reduce((s, x) => s + x, 0) / losses.length : 0, maxLossRun: maxRun,
    hours: trades.reduce((s, t) => s + t.hours, 0) / n, riskPct: trades.reduce((s, t) => s + t.riskPct, 0) / n
  };
}
