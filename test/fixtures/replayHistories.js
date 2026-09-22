/**
 * Synthetic multi-timeframe histories for the phase 10 replay proofs.
 *
 * Real Kraken history for the REGRESSION_001/002 dates is not retrievable: the handoff
 * records the shape of each miss, not the candles, and Kraken's OHLC endpoint serves only
 * the newest 720 rows. So each history wraps an existing unit fixture (flagFixtures.js
 * `regression001`, geometryFixtures.js `regression002Confluence`) in quiet candles on
 * every other timeframe, long enough for scripts/replay.js's compute window
 * (`replay.minComputeCandles`, 3m derived from 1m) to be satisfied before the fixture's
 * decisive closes.
 *
 * Every history has a short twin built by the fixture module's own mirror, applied to
 * every timeframe.
 */

import { INTERVAL_MS } from '../../services/scalpContext.js';
import { FIXTURE_PIVOT, mirror, regression001 } from './flagFixtures.js';
import { GEOMETRY_PIVOT, GEOMETRY_NOW, legs, mirrorAround, regression002Confluence } from './geometryFixtures.js';

/** Last close of every replay history. */
export const REPLAY_END = GEOMETRY_NOW;

const HIGHER_TFS = ['5m', '15m', '1h', '4h', '1d'];
const QUIET_HTF_CANDLES = 402;

/** Stamp candles so the last one closes at `endMs`. */
function stampEndingAt(candles, tf, endMs) {
  const step = INTERVAL_MS[tf];
  const firstOpen = endMs - candles.length * step;
  return candles.map((c, i) => ({ ...c, timestamp: firstOpen + i * step, volume: c.volume ?? 100, closeTime: firstOpen + (i + 1) * step }));
}

/**
 * Quiet chop around `level`: the same deterministic wobble as the suites' quietCandles
 * (±8 body, 5 wick at the 100,000 pivot), scaled by `scale`.
 */
function quiet(tf, count, endMs, level, scale = 1) {
  const candles = Array.from({ length: count }, (_, i) => {
    const wobble = (((i * 7919) % 17) - 8) * scale;
    const open = level + wobble;
    const close = level - wobble;
    return { open, high: Math.max(open, close) + 5 * scale, low: Math.min(open, close) - 5 * scale, close };
  });
  return stampEndingAt(candles, tf, endMs);
}

function mirrorHistory(history, fn) {
  return Object.fromEntries(Object.entries(history).map(([tf, c]) => [tf, fn(c)]));
}

/**
 * REGRESSION_001: 700 quiet 1m candles, then the regression001 fixture (impulse → EMA21
 * hold → flag → break → follow-through) ending at REPLAY_END; quiet 5m…1d at the same
 * price. The replay's last close is the fixture's confirmed close.
 *
 * The quiet wobble repeats every 17 candles and the strategies read its phase at the
 * last close. 402 = 300 + 6 × 17 higher-timeframe candles end on the same phase as the
 * 300-candle quiet series test-pattern-detector.js uses, where SCALP_1H is NO_TRADE.
 * @param {'long'|'short'} direction
 * @param {number} [quiet1m=700] - quiet 1m candles before the fixture (the timing test
 *   lengthens it to get 300 eligible closes)
 */
export function regression001History(direction = 'long', quiet1m = 700) {
  const fixture = regression001();
  const oneMinute = [...quiet('1m', quiet1m, 0, FIXTURE_PIVOT), ...fixture];
  const history = { '1m': stampEndingAt(oneMinute, '1m', REPLAY_END) };
  for (const tf of HIGHER_TFS) history[tf] = quiet(tf, QUIET_HTF_CANDLES, REPLAY_END, FIXTURE_PIVOT);
  return direction === 'long' ? history : mirrorHistory(history, (c) => mirror(c));
}

/**
 * REGRESSION_002: a smooth 4h ramp (no pivots) from 50 into the regression002Confluence
 * fixture, ending at REPLAY_END. The fixture's third rising low becomes a pivot only on
 * its last close (pivotRight = 3), so the diagonal + demand confluence exists at
 * REPLAY_END and not one 4h close earlier. Quiet 1m…1h and 1d sit at the last 4h close,
 * scaled down so their session/prev-day levels stay out of the 4h zone.
 * @param {'long'|'short'} direction
 */
export function regression002History(direction = 'long') {
  const fixture = regression002Confluence();
  const ramp = legs([50, fixture[0].open], 160);
  const fourHour = stampEndingAt([...ramp, ...fixture], '4h', REPLAY_END);
  const level = fixture[fixture.length - 1].close;
  const history = { '4h': fourHour, '1m': quiet('1m', 1500, REPLAY_END, level, 0.001) };
  for (const tf of ['5m', '15m', '1h', '1d']) history[tf] = quiet(tf, 400, REPLAY_END, level, 0.001);
  return direction === 'long' ? history : mirrorHistory(history, (c) => mirrorAround(c, GEOMETRY_PIVOT));
}
