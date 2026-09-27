/**
 * S1 mean-reversion rule: mr-channel-fade-4h (docs/PROMPT_S1_EDGE_SEARCH.md Agent D).
 *
 * The counter-slope channel fade `pb-channel-edge-4h` (S0-B) deliberately left out (its
 * own header: "the fade-the-channel-slope case is left out entirely, not defaulted to a
 * weaker signal") - MASTER_PLAN_TRADING_MODEL.md M-4's "a short at the top of a channel
 * that is itself rising" case. Short at the upper edge of a *rising* 4h channel (fade back
 * toward mid); mirror: long at the lower edge of a *falling* 4h channel. Same channel
 * geometry as pb-channel-edge-4h (`lib/geometry.js` swingPivots/fitDiagonal/channel/atr,
 * read-only per the S1 hard rules), same 0.5x ATR(4h) stop beyond the faded edge; TP1 is
 * mid-channel only (this rule fades to mid, it does not also carry the with-trend rule's
 * TP2-at-the-far-edge - a fade that reached the far edge would have been the trend-
 * following trade pb-channel-edge-4h already covers, not this one).
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
  id: 'mr-channel-fade-4h',
  label: '4h channel edge fade (counter-channel-trend)',
  source: 'docs/PROMPT_S1_EDGE_SEARCH.md Agent D; docs/MASTER_PLAN_TRADING_MODEL.md M-3, M-4',
  tf: OWN_TF,
  holdMaxHours: 24,
  stopKind: 'atr',
  notes: [
    "M-4: the counter-sentiment fade pb-channel-edge-4h (S0-B) left out - short at the upper edge of a *rising* channel, long at the lower edge of a *falling* one - taken here instead of with the channel's own slope.",
    'Same 4h channel geometry as pb-channel-edge-4h (lib/geometry.js swingPivots/fitDiagonal/channel), same 0.5x ATR(4h) stop beyond the faded edge.',
    'TP1 = mid-channel only, no TP2: a fade that ran to the far edge would be the with-trend trade pb-channel-edge-4h already covers, not this one.'
  ].join('\n')
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0/S1 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, reason:string[]}}
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
  if (ch.slope === 'rising' && ch.positionPct >= UPPER_EDGE_POSITION_PCT) direction = 'short';
  else if (ch.slope === 'falling' && ch.positionPct <= LOWER_EDGE_POSITION_PCT) direction = 'long';
  if (!direction) return null;

  const entry = price;
  const mid = (ch.upper + ch.lower) / 2;
  const stop = direction === 'long' ? ch.lower - STOP_ATR_MULTIPLE * a.atr : ch.upper + STOP_ATR_MULTIPLE * a.atr;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = mid;

  const reason = [
    `4h channel ${ch.slope}, positionPct ${ch.positionPct} (fading ${direction === 'long' ? 'lower edge of falling channel' : 'upper edge of rising channel'})`,
    `entry at channel edge close ${entry}; stop ${STOP_ATR_MULTIPLE}x ATR4h (${a.atr.toFixed ? a.atr.toFixed(4) : a.atr}) beyond the edge`,
    `TP1 = mid-channel ${mid} (fade target only, no TP2)`
  ];

  return { direction, entry, stop, tp1, reason };
}

export default { meta, signalAt };
