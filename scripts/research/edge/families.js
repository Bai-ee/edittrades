// Pre-registered strategy families for the edge search (docs/EDGE_SEARCH_2026-09-27.md).
// Each config: { id, family, tf, signal(ctx, i) -> spec|null } where i is a CLOSED bar of
// ctx.bars[tf] and spec = { dir, stop, target?, trailMult?, trailAtr?, maxHoldH, exitAt? }.
// Entry is at ctx.bars[tf].ct[i] (next bar open), filled on the 5m path by lib.simulate.
import { ema, sma, stdev, atr, rsi, donchian, lastClosedIdx } from './lib.js';

const H = 3600e3;

/** Per-symbol lazily built indicator cache. */
export function makeCtx(bars) {
  const cache = new Map();
  const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
  const ctx = {
    bars,
    atr: (tf, p = 14) => memo(`atr${tf}${p}`, () => atr(bars[tf], p)),
    ema: (tf, p) => memo(`ema${tf}${p}`, () => ema(bars[tf].c, p)),
    sma: (tf, p) => memo(`sma${tf}${p}`, () => sma(bars[tf].c, p)),
    sd: (tf, p) => memo(`sd${tf}${p}`, () => stdev(bars[tf].c, p)),
    rsi: (tf, p) => memo(`rsi${tf}${p}`, () => rsi(bars[tf].c, p)),
    don: (tf, n) => memo(`don${tf}${n}`, () => donchian(bars[tf], n)),
    /** Daily regime at time tMs from the last CLOSED 1d bar: +1 above EMA50, -1 below, 0 unknown. */
    regime: (tMs) => {
      const d = bars['1d'];
      const j = lastClosedIdx(d, tMs);
      const e = ctx.ema('1d', 50);
      if (j < 0 || !Number.isFinite(e[j])) return 0;
      return d.c[j] > e[j] ? 1 : -1;
    }
  };
  return ctx;
}

const ok = (...xs) => xs.every(Number.isFinite);
const regimeOk = (ctx, useRegime, dir, tMs) => {
  if (!useRegime) return true;
  const r = ctx.regime(tMs);
  return dir === 'long' ? r === 1 : r === -1;
};

export function buildConfigs() {
  const out = [];

  // F1 Donchian breakout + chandelier trail (trend following; low win rate, large winners).
  for (const tf of ['1h', '4h']) for (const N of [20, 55]) for (const k of [2, 3]) for (const reg of [false, true]) {
    out.push({
      id: `F1-don-${tf}-N${N}-k${k}${reg ? '-reg' : ''}`, family: 'F1', tf,
      signal(ctx, i) {
        const b = ctx.bars[tf], { hi, lo } = ctx.don(tf, N), a = ctx.atr(tf)[i];
        if (!ok(hi[i], lo[i], a)) return null;
        const dir = b.c[i] > hi[i] ? 'long' : b.c[i] < lo[i] ? 'short' : null;
        if (!dir || !regimeOk(ctx, reg, dir, b.ct[i])) return null;
        const stop = dir === 'long' ? b.c[i] - k * a : b.c[i] + k * a;
        return { dir, stop, trailAtr: a, trailMult: k, maxHoldH: tf === '4h' ? 14 * 24 : 5 * 24 };
      }
    });
  }

  // F2 Daily time-series momentum, trailed.
  for (const L of [20, 60]) for (const k of [2, 3]) {
    out.push({
      id: `F2-tsmom-1d-L${L}-k${k}`, family: 'F2', tf: '1d',
      signal(ctx, i) {
        const b = ctx.bars['1d'], a = ctx.atr('1d')[i], e = ctx.ema('1d', 50)[i];
        if (i < L || !ok(a, e)) return null;
        const dir = b.c[i] > b.c[i - L] && b.c[i] > e ? 'long' : b.c[i] < b.c[i - L] && b.c[i] < e ? 'short' : null;
        if (!dir) return null;
        return { dir, stop: dir === 'long' ? b.c[i] - k * a : b.c[i] + k * a, trailAtr: a, trailMult: k, maxHoldH: 30 * 24 };
      }
    });
  }

  // F3 1h mean reversion to SMA20, optionally only with the daily trend.
  for (const trig of ['rsi2', 'bb']) for (const k of [1.5, 2.5]) for (const reg of [false, true]) {
    out.push({
      id: `F3-mr-1h-${trig}-k${k}${reg ? '-reg' : ''}`, family: 'F3', tf: '1h',
      signal(ctx, i) {
        const b = ctx.bars['1h'], a = ctx.atr('1h')[i], m = ctx.sma('1h', 20)[i], sd = ctx.sd('1h', 20)[i], r2 = ctx.rsi('1h', 2)[i];
        if (!ok(a, m, sd, r2)) return null;
        let dir = null;
        if (trig === 'rsi2') dir = r2 < 5 ? 'long' : r2 > 95 ? 'short' : null;
        else dir = b.c[i] < m - 2.5 * sd ? 'long' : b.c[i] > m + 2.5 * sd ? 'short' : null;
        if (!dir || !regimeOk(ctx, reg, dir, b.ct[i])) return null;
        const p5 = ctx.bars['5m'];
        const sma1h = ctx.sma('1h', 20);
        return {
          dir, stop: dir === 'long' ? b.c[i] - k * a : b.c[i] + k * a, maxHoldH: 48,
          // Exit at the first 1h close back through SMA20 (evaluated on 1h boundaries only).
          exitAt(i5) {
            if (p5.ct[i5] % H !== 0) return false;
            const j = lastClosedIdx(b, p5.ct[i5]);
            if (j <= i || !Number.isFinite(sma1h[j])) return false;
            return dir === 'long' ? b.c[j] >= sma1h[j] : b.c[j] <= sma1h[j];
          }
        };
      }
    });
  }

  // F4 4h volatility squeeze -> breakout, trailed.
  for (const k of [2, 3]) for (const reg of [false, true]) {
    out.push({
      id: `F4-squeeze-4h-k${k}${reg ? '-reg' : ''}`, family: 'F4', tf: '4h',
      signal(ctx, i) {
        const b = ctx.bars['4h'], m = ctx.sma('4h', 20), sd = ctx.sd('4h', 20), a = ctx.atr('4h')[i];
        if (i < 121 || !ok(m[i], sd[i], a)) return null;
        // Squeeze: the PREVIOUS bar's band width is in the lowest 10% of the last 120 bars.
        const w = (j) => (4 * sd[j]) / m[j];
        const ws = []; for (let j = i - 120; j < i; j++) if (Number.isFinite(w(j))) ws.push(w(j));
        ws.sort((x, y) => x - y);
        if (!(w(i - 1) <= ws[Math.floor(ws.length * 0.1)])) return null;
        const dir = b.c[i] > m[i] + 2 * sd[i] ? 'long' : b.c[i] < m[i] - 2 * sd[i] ? 'short' : null;
        if (!dir || !regimeOk(ctx, reg, dir, b.ct[i])) return null;
        return { dir, stop: dir === 'long' ? b.c[i] - k * a : b.c[i] + k * a, trailAtr: a, trailMult: k, maxHoldH: 10 * 24 };
      }
    });
  }

  return out;
}

/**
 * F5 US-open range breakout, driven off 5m bars directly (not a closed-bar family):
 * range = 13:30-14:30 UTC high/low; first 5m close outside it before 20:00 UTC enters;
 * stop = the other side of the range; exit by target (xR) or trail, flat by 21:00 UTC.
 */
export function buildOrbConfigs() {
  const out = [];
  for (const exit of ['2R', '3R', 'trail']) for (const reg of [false, true]) {
    out.push({ id: `F5-orb-us-${exit}${reg ? '-reg' : ''}`, family: 'F5', exit, reg });
  }
  return out;
}

export function orbSignals(ctx, cfg) {
  const p5 = ctx.bars['5m'];
  const a1h = ctx.atr('1h');
  const specs = [];
  const DAY = 24 * H;
  const first = Math.ceil(p5.t[0] / DAY) * DAY;
  for (let d = first; d < p5.t[p5.n - 1]; d += DAY) {
    const rs = d + 13.5 * H, re = d + 14.5 * H, last = d + 20 * H, flat = d + 21 * H;
    let lo = Infinity, hi = -Infinity, i = lastClosedIdx(p5, rs) + 1;
    if (i <= 0) continue;
    for (; i < p5.n && p5.t[i] < re; i++) { hi = Math.max(hi, p5.h[i]); lo = Math.min(lo, p5.l[i]); }
    if (!Number.isFinite(hi)) continue;
    for (; i < p5.n && p5.ct[i] <= last; i++) {
      const dir = p5.c[i] > hi ? 'long' : p5.c[i] < lo ? 'short' : null;
      if (!dir) continue;
      if (!regimeOk(ctx, cfg.reg, dir, p5.ct[i])) break;
      const entryRef = p5.c[i];
      const stop = dir === 'long' ? lo : hi;
      const risk = Math.abs(entryRef - stop);
      const j = lastClosedIdx(ctx.bars['1h'], p5.ct[i]);
      const spec = { dir, stop, entryTime: p5.ct[i], maxHoldH: (flat - p5.ct[i]) / H };
      if (cfg.exit === '2R' || cfg.exit === '3R') spec.target = dir === 'long' ? entryRef + Number(cfg.exit[0]) * risk : entryRef - Number(cfg.exit[0]) * risk;
      else if (Number.isFinite(a1h[j])) { spec.trailAtr = a1h[j]; spec.trailMult = 2; }
      specs.push(spec);
      break; // one trade per day
    }
  }
  return specs;
}
