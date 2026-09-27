/**
 * Legacy control: services/strategy.js TREND_4H strategy
 * (docs/SIGNAL_GENERATION_SPECIFICATION.md §2), called through the real evaluator
 * (`evaluateAllStrategies`, the exact function services/scalpContext.js's production
 * pipeline calls) at each 4H close, mapped onto the swing-study rule interface
 * (scripts/swing/run.js).
 *
 * Self-contained by design, same reasoning as ./legacy-swing.js: builds its own
 * `multiTimeframeData` from `ctx.candlesByTf` rather than reading
 * ctx.indicatorsByTf/topDown/geometry, so it feeds evaluateAllStrategies the exact
 * `{ indicators, structure, candleCount, lastCandle }` shape services/scalpContext.js
 * itself builds.
 *
 * Inputs nulled (services/strategy.js evaluateAllStrategies(symbol, multiTimeframeData,
 * mode, marketData, dflowData)) - see ./legacy-swing.js's header for the full reasoning;
 * same two params, same guarded no-op behavior:
 *   - marketData -> null (volume-quality hard block / trade-count penalty, both
 *     `marketData && ...` guarded).
 *   - dflowData -> null (dFlow-alignment confidence bonus/penalty, `dflowData && ...`
 *     guarded).
 *
 * Unlike SWING, TREND_4H has no missing-timeframe gap in production: its evaluator path
 * (services/strategy.js evaluateStrategy(symbol, mtf, '4h', ...)) only reads
 * 4h/1h/15m/5m, all of which services/scalpContext.js supplies live - so this rule scores
 * the strategy exactly as production runs it today (the same evaluateAllStrategies call,
 * same TREND_4H branch, no synthesized data).
 *
 * entry/stop/tp1/tp2: the evaluator's `entryZone` is a {min,max} band; the rule interface
 * takes a single `entry` price, so this rule collapses the zone to its midpoint (same
 * convention services/scalpContext.js's own `attachRisk` uses for sizing).
 */
import { evaluateAllStrategies } from '../../../services/strategy.js';
import { calculateAllIndicators, detectSwingPoints } from '../../../services/indicators.js';

export const meta = {
  id: 'legacy-trend4h',
  label: 'Legacy TREND_4H (services/strategy.js)',
  source: 'services/strategy.js evaluateAllStrategies -> evaluateStrategy(setupType=\'4h\') (spec §2)',
  tf: '4h',
  holdMaxHours: 48,
  stopKind: 'structure',
  notes: [
    'Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.',
    'No missing-timeframe gap: TREND_4H\'s evaluator path only reads 4h/1h/15m/5m, all of which production supplies live, so this rule scores production behavior exactly, no synthesized inputs.',
    'entry/stop/tp1/tp2 collapse the evaluator\'s entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.'
  ]
};

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

  const mtf = {};
  for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
    const entry = mtfEntry(candlesByTf[tf]);
    if (entry) mtf[tf] = entry;
  }
  if (!mtf['4h'] || !mtf['1h']) return null;

  let result;
  try {
    result = quiet(() => evaluateAllStrategies(symbol, mtf, 'STANDARD', null, null));
  } catch {
    return null;
  }
  const trend4h = result && result.strategies && result.strategies.TREND_4H;
  if (!trend4h || !trend4h.valid || trend4h.direction === 'NO_TRADE') return null;

  const zone = trend4h.entryZone || {};
  const zoneMin = zone.min;
  const zoneMax = zone.max;
  const entry = Number.isFinite(zoneMin) && Number.isFinite(zoneMax)
    ? (zoneMin + zoneMax) / 2
    : (Number.isFinite(zoneMin) ? zoneMin : zoneMax);
  const stop = trend4h.stopLoss;
  const targets = Array.isArray(trend4h.targets) ? trend4h.targets : [];
  const [tp1, tp2] = targets;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(tp1)) return null;

  return {
    direction: trend4h.direction,
    entry,
    stop,
    tp1,
    tp2: Number.isFinite(tp2) ? tp2 : undefined,
    reason: [String(trend4h.reason || 'TREND_4H')]
  };
}
