// Edge search round 2 (docs/EDGE_SEARCH_2026-09-27.md): larger moves, shorter holds.
// Loaded by run.js via --extra scripts/research/edge/round2.js.
import { lastClosedIdx } from './lib.js';

const H = 3600e3, DAY = 24 * H;
const ok = (...xs) => xs.every(Number.isFinite);

const configs = [];

// R2a Daily volatility breakout: 1h close beyond today's open +/- k * yesterday's range,
// stop at today's open, flat at the UTC day end. One trade per symbol per day.
for (const k of [0.3, 0.5, 0.7]) for (const reg of [false, true]) {
  configs.push({
    id: `R2a-volbrk-k${k}${reg ? '-reg' : ''}`, family: 'R2a', tf: '1h',
    signal(ctx, i) {
      const b = ctx.bars['1h'], d = ctx.bars['1d'];
      const t = b.ct[i];
      const dayStart = Math.floor((t - 1) / DAY) * DAY;
      const j = lastClosedIdx(d, dayStart); // yesterday
      if (j < 0 || d.ct[j] !== dayStart) return null;
      ctx.state ??= {};
      if (ctx.state[this.id] === dayStart) return null;
      const range = d.h[j] - d.l[j];
      // Today's open = first 1h bar of the day.
      const i0 = lastClosedIdx(b, dayStart) + 1;
      if (i0 > i) return null;
      const open = b.o[i0];
      const dir = b.c[i] > open + k * range ? 'long' : b.c[i] < open - k * range ? 'short' : null;
      if (!dir) return null;
      if (reg) { const r = ctx.regime(t); if ((dir === 'long' && r !== 1) || (dir === 'short' && r !== -1)) return null; }
      const hoursLeft = (dayStart + DAY - t) / H;
      if (hoursLeft < 1) return null;
      ctx.state[this.id] = dayStart;
      return { dir, stop: open, maxHoldH: hoursLeft };
    }
  });
}

// R2b Daily RSI(2) pullback with the trend (Connors-style); exit on a close back over SMA5.
for (const k of [2, 3]) for (const longOnly of [false, true]) {
  configs.push({
    id: `R2b-rsi2pb-1d-k${k}${longOnly ? '-long' : ''}`, family: 'R2b', tf: '1d',
    signal(ctx, i) {
      const b = ctx.bars['1d'], r2 = ctx.rsi('1d', 2)[i], e = ctx.ema('1d', 50)[i], a = ctx.atr('1d')[i];
      if (!ok(r2, e, a)) return null;
      const dir = b.c[i] > e && r2 < 10 ? 'long' : !longOnly && b.c[i] < e && r2 > 90 ? 'short' : null;
      if (!dir) return null;
      const p5 = ctx.bars['5m'], s5 = ctx.sma('1d', 5);
      return {
        dir, stop: dir === 'long' ? b.c[i] - k * a : b.c[i] + k * a, maxHoldH: 10 * 24,
        exitAt(i5) {
          if (p5.ct[i5] % DAY !== 0) return false;
          const jd = lastClosedIdx(b, p5.ct[i5]);
          if (jd <= i || !Number.isFinite(s5[jd])) return false;
          return dir === 'long' ? b.c[jd] > s5[jd] : b.c[jd] < s5[jd];
        }
      };
    }
  });
}

// R2c 1h shock bars (|close - open| > 2.5 ATR): fade or follow, fixed hold.
for (const mode of ['fade', 'follow']) for (const hold of [6, 24]) {
  configs.push({
    id: `R2c-shock-1h-${mode}-${hold}h`, family: 'R2c', tf: '1h',
    signal(ctx, i) {
      const b = ctx.bars['1h'], a = ctx.atr('1h')[i - 1];
      if (!ok(a)) return null;
      const body = b.c[i] - b.o[i];
      if (Math.abs(body) < 2.5 * a) return null;
      const up = body > 0;
      const dir = (mode === 'fade') === up ? 'short' : 'long';
      // Fade: stop beyond the shock bar's extreme + 0.5 ATR. Follow: stop at the bar's midpoint.
      const stop = mode === 'fade'
        ? (dir === 'short' ? b.h[i] + 0.5 * a : b.l[i] - 0.5 * a)
        : (b.o[i] + b.c[i]) / 2;
      return { dir, stop, maxHoldH: hold };
    }
  });
}

export default configs;
