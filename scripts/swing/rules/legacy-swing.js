/**
 * Legacy control: services/strategy.js SWING strategy (docs/SIGNAL_GENERATION_SPECIFICATION.md
 * §1), called through the real evaluator (`evaluateAllStrategies`, the exact function
 * services/scalpContext.js's production pipeline calls) at each 4H close, mapped onto the
 * swing-study rule interface (scripts/swing/run.js).
 *
 * Self-contained by design: this rule builds its own `multiTimeframeData` from
 * `ctx.candlesByTf` (the one base-contract field every rule gets) instead of reading
 * ctx.indicatorsByTf/topDown/geometry, because evaluateAllStrategies needs the exact
 * `{ indicators, structure, candleCount, lastCandle }` per-timeframe shape
 * services/scalpContext.js itself builds - reusing the harness's more generic
 * indicatorsByTf would risk silently diverging from what production actually feeds the
 * evaluator.
 *
 * Inputs nulled (services/strategy.js evaluateAllStrategies(symbol, multiTimeframeData,
 * mode, marketData, dflowData)):
 *   - marketData -> null. Only gates a volume-quality hard block on BREAKOUT entries and
 *     a trade-count/spread confidence penalty (services/strategy.js
 *     applyMarketContextAdjustments), both guarded by `marketData && ...` - null is a
 *     no-op, not a fabricated favorable input.
 *   - dflowData -> null. Only feeds a confidence bonus/penalty (checkDflowAlignment),
 *     also guarded by `dflowData && ...`.
 *   - account/wallet, chart window, bias matrix, flag candidates -> never built; SWING's
 *     evaluator path never reads them.
 *
 * A structural gap, not a fixture gap: services/scalpContext.js (the ONLY production
 * caller of evaluateAllStrategies) requests timeframes
 * ['1m','3m','5m','15m','1h','4h','1d'] and NEVER '3d'. `evaluateSwingSetup`'s guard
 * (`if (!tf3d || !tf1d || !tf4h) return null`) therefore fires on every real production
 * call - SWING is dead code in production today, regardless of market conditions. To
 * score the strategy's actual LOGIC (the owner's research question), this rule
 * synthesizes '3d' the same grouping the codebase's own (unused) `aggregate3DayCandles`
 * (services/marketData.js) uses - buckets of 3 closed 1D candles, oldest-first - applied
 * to the FULL available 1D history at each cut (not a rolling fixed-length window like
 * the dormant `fetchFromKraken('3d', limit)` path), so 3D bucket boundaries stay stable
 * across the whole replay instead of drifting as the window rolls forward.
 *
 * entry/stop/tp1/tp2: the evaluator's `entryZone` is a {min,max} band; the rule interface
 * takes a single `entry` price, so this rule collapses the zone to its midpoint (same
 * convention services/scalpContext.js's own `attachRisk` uses for sizing).
 */
import { evaluateAllStrategies } from '../../../services/strategy.js';
import { calculateAllIndicators, detectSwingPoints } from '../../../services/indicators.js';

export const meta = {
  id: 'legacy-swing',
  label: 'Legacy SWING (services/strategy.js)',
  source: 'services/strategy.js evaluateAllStrategies -> evaluateSwingSetup (spec §1)',
  tf: '4h',
  holdMaxHours: 72,
  stopKind: 'structure',
  notes: [
    'Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.',
    'Production never supplies a 3D timeframe (services/scalpContext.js requests 1m/3m/5m/15m/1h/4h/1d only), so SWING is dead code live regardless of market conditions; this rule synthesizes 3D from 1D with the codebase\'s own (unused) bucketing (services/marketData.js aggregate3DayCandles) over the full available 1D history, so bucket edges stay stable across the replay instead of rolling with a fixed-window fetch.',
    'entry/stop/tp1/tp2 collapse the evaluator\'s entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.'
  ]
};

/** Groups of 3 closed 1D candles, oldest-first - mirrors services/marketData.js aggregate3DayCandles. */
function aggregate3d(daily) {
  const out = [];
  for (let i = 0; i < daily.length; i += 3) {
    const chunk = daily.slice(i, i + 3);
    if (chunk.length === 0) continue;
    const last = chunk[chunk.length - 1];
    out.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: last.close,
      closeTime: last.closeTime || (last.timestamp + 3 * 86400000)
    });
  }
  return out;
}

/** services/scalpContext.js's own mtfForStrategy[tf] shape. */
function mtfEntry(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let indicators;
  try {
    indicators = calculateAllIndicators(candles);
  } catch {
    return null;
  }
  return {
    indicators,
    structure: detectSwingPoints(candles, 20),
    candleCount: candles.length,
    lastCandle: candles[candles.length - 1]
  };
}

function quiet(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

export function signalAt(ctx) {
  const { symbol, candlesByTf } = ctx;
  const daily = candlesByTf['1d'];
  if (!Array.isArray(daily) || daily.length < 9) return null; // need footing for >=3 3D buckets

  const mtf = {};
  for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
    const entry = mtfEntry(candlesByTf[tf]);
    if (entry) mtf[tf] = entry;
  }
  const entry3d = mtfEntry(aggregate3d(daily));
  if (entry3d) mtf['3d'] = entry3d;

  if (!mtf['4h'] || !mtf['1d'] || !mtf['3d']) return null;

  let result;
  try {
    result = quiet(() => evaluateAllStrategies(symbol, mtf, 'STANDARD', null, null));
  } catch {
    return null;
  }
  const swing = result && result.strategies && result.strategies.SWING;
  if (!swing || !swing.valid || swing.direction === 'NO_TRADE') return null;

  const zone = swing.entryZone || {};
  const zoneMin = zone.min;
  const zoneMax = zone.max;
  const entry = Number.isFinite(zoneMin) && Number.isFinite(zoneMax)
    ? (zoneMin + zoneMax) / 2
    : (Number.isFinite(zoneMin) ? zoneMin : zoneMax);
  const stop = swing.stopLoss;
  const targets = Array.isArray(swing.targets) ? swing.targets : [];
  const [tp1, tp2] = targets;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(tp1)) return null;

  return {
    direction: swing.direction,
    entry,
    stop,
    tp1,
    tp2: Number.isFinite(tp2) ? tp2 : undefined,
    reason: [String(swing.reason || 'SWING')]
  };
}
