/**
 * S0-B playbook rule: pb-channel-edge-4h.
 *
 * MASTER_PLAN_TRADING_MODEL.md M-3: identify the channel price is trading in and aim at
 * its top (longs) or bottom (shorts); no single channel "governs" a trade, but this rule
 * only needs its own timeframe's channel, so it trades the 4h channel's own edges and
 * slope directly rather than picking a channel from several timeframes. M-4: a
 * counter-sentiment play (e.g. a short at the top of a channel that is itself rising)
 * needs a breakout read - this rule sidesteps that by only trading with the channel's
 * own slope (long at the lower edge of a *rising* channel, short at the upper edge of a
 * *falling* one), never the fade-the-trend case M-4 requires extra judgement for.
 *
 * Reuses `lib/geometry.js` `channel()` read-only, per the S0 playbook-rules contract;
 * `channel()` needs a detected support and resistance diagonal, so `swingPivots`,
 * `fitDiagonal`, and `atr` (also lib/geometry.js, needed to build channel()'s own inputs)
 * are used the same way, on 4h candles only, with that module's default geometry config.
 *
 * No lookahead: candles are truncated to `candlesByTf['4h'].slice(0, i + 1)` before any
 * pivot, diagonal, or channel computation runs on them.
 */

import { swingPivots, fitDiagonal, channel, atr as geometryAtr } from '../../../lib/geometry.js';

const OWN_TF = '4h';
const LOWER_EDGE_POSITION_PCT = 15;
const UPPER_EDGE_POSITION_PCT = 100 - LOWER_EDGE_POSITION_PCT;
const STOP_ATR_MULTIPLE = 0.5;

export const meta = {
  id: 'pb-channel-edge-4h',
  label: '4h channel edge (with-channel-trend only)',
  source: 'docs/MASTER_PLAN_TRADING_MODEL.md M-3, M-4',
  tf: OWN_TF,
  holdMaxHours: 24,
  stopKind: 'atr',
  notes: [
    'M-3: identify the channel price trades in and aim at its top (long side) or bottom (short side); this rule uses the 4h channel from lib/geometry.js swingPivots/fitDiagonal/channel.',
    'M-4: counter-sentiment fades need a breakout read this rule does not attempt, so it only takes the lower edge of a *rising* channel long, or the upper edge of a *falling* channel short - the fade-the-channel-slope case is left out entirely, not defaulted to a weaker signal.',
    'Stop sits 0.5x ATR(4h) outside the channel edge (a clean break invalidates the channel read); TP1 is mid-channel, TP2 the far edge, both read directly off channel().'
  ].join('\n')
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, tp2:number, reason:string[]}}
 */
export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw4h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw4h) || i >= raw4h.length) return null;
  const candles4h = raw4h.slice(0, i + 1);
  if (!candles4h.every(isValidCandle)) return null;

  const a = geometryAtr(candles4h);
  if (!a || !isFiniteNumber(a.atr) || a.atr <= 0) return null;

  const pivots = swingPivots(candles4h);
  const diagonalSupport = fitDiagonal(pivots, 'support', undefined, { candles: candles4h, atr: a.atr });
  const diagonalResistance = fitDiagonal(pivots, 'resistance', undefined, { candles: candles4h, atr: a.atr });
  const price = candles4h[candles4h.length - 1].close;
  const ch = channel(diagonalSupport, diagonalResistance, price);
  if (!ch.detected) return null;

  let direction = null;
  if (ch.slope === 'rising' && ch.positionPct <= LOWER_EDGE_POSITION_PCT) direction = 'long';
  else if (ch.slope === 'falling' && ch.positionPct >= UPPER_EDGE_POSITION_PCT) direction = 'short';
  if (!direction) return null;

  const entry = price;
  const mid = (ch.upper + ch.lower) / 2;
  const stop = direction === 'long' ? ch.lower - STOP_ATR_MULTIPLE * a.atr : ch.upper + STOP_ATR_MULTIPLE * a.atr;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = mid;
  const tp2 = direction === 'long' ? ch.upper : ch.lower;

  const reason = [
    `4h channel ${ch.slope}, positionPct ${ch.positionPct} (${direction === 'long' ? 'at lower edge' : 'at upper edge'})`,
    `entry at channel edge close ${entry}; stop ${STOP_ATR_MULTIPLE}x ATR4h (${a.atr.toFixed ? a.atr.toFixed(4) : a.atr}) beyond the edge`,
    `TP1 = mid-channel ${mid}, TP2 = far edge ${tp2}`
  ];

  return { direction, entry, stop, tp1, tp2, reason };
}

export default { meta, signalAt };
