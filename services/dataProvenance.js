/**
 * Data Provenance
 * ---------------
 * The vocabulary every market-data result in EditTrades is described with.
 *
 * The rule this module exists to enforce: a consumer must always be able to
 * tell whether the numbers it was handed are a real observation, a real
 * observation that has gone cold, or nothing at all. There is deliberately no
 * fourth category. Data that "looks real but isn't" is the failure mode the
 * whole decision desk is built to prevent, so no function here can produce a
 * price, a candle, or a bar count — it only describes data fetched elsewhere.
 *
 * Freshness is a four-state ladder, and the states are ordered by how much a
 * trade decision may lean on them:
 *
 *   LIVE        fetched now from a real provider
 *   CACHED      a real observation, still inside its useful window
 *   STALE       a real observation, past its window; usable only if labelled
 *   UNAVAILABLE no real observation. Never a number.
 *
 * `synthetic` is present on every provenance object and is always false. It is
 * not vestigial: it is a standing assertion that the pipeline cannot fabricate,
 * and `assertNotSynthetic` turns that assertion into a runtime tripwire so a
 * future regression fails loudly instead of quietly pricing a trade.
 */

/** @enum {string} */
export const FRESHNESS = Object.freeze({
  LIVE: 'LIVE',
  CACHED: 'CACHED',
  STALE: 'STALE',
  UNAVAILABLE: 'UNAVAILABLE'
});

/**
 * How old a series of a given interval may be before it stops counting as
 * current. Two bar-widths: one bar can always be mid-formation, so a single
 * interval of age is normal rather than a problem, and the second gives room
 * for a provider that publishes a little late. Past that the market has moved
 * on and the caller needs to know.
 */
const STALENESS_BUDGET_BARS = 2;

/** Interval identifier -> milliseconds. The canonical table for the repo. */
export const INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000
});

/**
 * Age past which a series of this interval is STALE.
 * Unknown intervals fall back to an hour, which is short enough to be
 * conservative rather than permissive.
 */
export function stalenessThresholdMs(interval) {
  const bar = INTERVAL_MS[interval];
  return bar ? bar * STALENESS_BUDGET_BARS : 3_600_000;
}

/**
 * Raised when no real provider could supply the requested data.
 *
 * This is thrown rather than returned so that a caller which forgets to check
 * cannot proceed on an empty value. `providerFailures` carries one entry per
 * provider tried, which is what makes the health model and the logs able to
 * say *which* feed broke rather than just "market data down".
 */
export class DataUnavailableError extends Error {
  constructor(message, { symbol, interval, providerFailures = [] } = {}) {
    super(message);
    this.name = 'DataUnavailableError';
    this.code = 'DATA_UNAVAILABLE';
    this.symbol = symbol;
    this.interval = interval;
    this.providerFailures = providerFailures;
  }
}

/**
 * Raised when real data arrived but there is not enough of it for the
 * calculation the caller intends.
 *
 * Kept distinct from DataUnavailableError because the remedy differs: an
 * unavailable feed may recover on retry, whereas insufficient history means
 * the requested indicator cannot be computed from this provider at all, and
 * silently returning a shorter series would make the indicator wrong rather
 * than missing.
 */
export class InsufficientHistoryError extends Error {
  constructor(message, { symbol, interval, required, available } = {}) {
    super(message);
    this.name = 'InsufficientHistoryError';
    this.code = 'INSUFFICIENT_HISTORY';
    this.symbol = symbol;
    this.interval = interval;
    this.required = required;
    this.available = available;
  }
}

/** Raised for a symbol the provider map does not know. */
export class UnsupportedSymbolError extends Error {
  constructor(symbol) {
    super(
      `Unsupported symbol: ${symbol}. Refusing to substitute a different asset.`
    );
    this.name = 'UnsupportedSymbolError';
    this.code = 'UNSUPPORTED_SYMBOL';
    this.symbol = symbol;
  }
}

/**
 * Build a provenance record.
 *
 * `fetchedAt` is when the data actually left the provider, not when this object
 * was constructed — for a cache hit those differ by the whole life of the entry,
 * and it is that gap the freshness state is derived from.
 *
 * @param {Object} params
 * @param {string} params.source        provider that produced the observation
 * @param {number} params.fetchedAt     epoch ms the provider was read
 * @param {string} [params.interval]    candle interval, for the staleness budget
 * @param {boolean} [params.fromCache]  served from cache rather than a fresh call
 * @param {number} [params.lastBarTime] epoch ms of the newest bar, when known
 * @param {string} [params.derivedFrom] native interval this was aggregated from
 * @param {Array} [params.providerFailures] providers tried and failed first
 * @param {number} [params.now]         injectable clock, for tests
 */
export function makeProvenance({
  source,
  fetchedAt,
  interval = null,
  fromCache = false,
  lastBarTime = null,
  derivedFrom = null,
  providerFailures = [],
  now = Date.now()
}) {
  const ageMs = Math.max(0, now - fetchedAt);
  const threshold = stalenessThresholdMs(interval);
  const stale = ageMs > threshold;

  let freshness;
  if (stale) freshness = FRESHNESS.STALE;
  else if (fromCache) freshness = FRESHNESS.CACHED;
  else freshness = FRESHNESS.LIVE;

  return {
    source,
    fetchedAt: new Date(fetchedAt).toISOString(),
    ageSeconds: Math.round(ageMs / 1000),
    freshness,
    stale,
    // Always false. See the module header: this is an assertion, not a flag
    // anything is expected to set.
    synthetic: false,
    interval,
    // Present only when the series was aggregated from a shorter native bar,
    // so a consumer can tell a real 4h print from four real 1h prints combined.
    derivedFrom,
    lastBarTime: lastBarTime === null ? null : new Date(lastBarTime).toISOString(),
    // Age of the newest bar, which is the number that actually matters for a
    // trade decision. `ageSeconds` only says when we called the API; a provider
    // can answer instantly with a series that stopped updating hours ago.
    lastBarAgeSeconds:
      lastBarTime === null ? null : Math.max(0, Math.round((now - lastBarTime) / 1000)),
    providerFailures
  };
}

/** Provenance for the case where nothing real could be obtained. */
export function unavailableProvenance({ interval = null, providerFailures = [] } = {}) {
  return {
    source: null,
    fetchedAt: null,
    ageSeconds: null,
    freshness: FRESHNESS.UNAVAILABLE,
    stale: false,
    synthetic: false,
    interval,
    derivedFrom: null,
    lastBarTime: null,
    lastBarAgeSeconds: null,
    providerFailures
  };
}

/**
 * Property name under which provenance rides along on a candle array.
 *
 * Candle arrays are passed straight into indicator code that indexes, slices
 * and maps them, and into `Object.entries` loops over a multi-timeframe bundle.
 * Wrapping them in `{ candles, provenance }` would mean touching every one of
 * those call sites, and each touch is a chance to break a live trading path.
 * A non-enumerable property attaches the metadata without changing the array's
 * identity: `Array.isArray` still holds, `.length` and iteration are unchanged,
 * and `Object.entries` over the bundle still yields only intervals.
 *
 * The tradeoff, stated plainly: it does not survive `JSON.stringify` or a
 * spread. Anything that needs provenance in a response body must read it with
 * `getProvenance()` and place it in the payload explicitly.
 */
const PROVENANCE_KEY = '__provenance';

/** Attach provenance to a candle array in place and return the array. */
export function attachProvenance(candles, provenance) {
  Object.defineProperty(candles, PROVENANCE_KEY, {
    value: Object.freeze(provenance),
    enumerable: false,
    writable: true,
    configurable: true
  });
  return candles;
}

/** Read provenance off a candle array. Null when absent. */
export function getProvenance(candles) {
  if (!candles || typeof candles !== 'object') return null;
  return candles[PROVENANCE_KEY] || null;
}

/**
 * Tripwire. Throws if a value ever arrives carrying synthetic provenance, or
 * carrying none at all where provenance is required.
 *
 * Called on the hot path in `getCandles` so that a future change which
 * reintroduces a fabricated series fails at the point of fabrication rather
 * than several layers downstream in a position size.
 */
export function assertNotSynthetic(candles, context = 'market data') {
  const prov = getProvenance(candles);
  if (!prov) {
    throw new Error(
      `${context}: result carries no provenance. Every market-data result must declare its source.`
    );
  }
  if (prov.synthetic) {
    throw new Error(
      `${context}: synthetic data reached a live path from source "${prov.source}". This is never permitted.`
    );
  }
  return candles;
}

/**
 * Minimum bars needed before an indicator's output means anything.
 *
 * These are warmup requirements, not cosmetic minimums. An EMA-200 computed
 * over 50 bars returns a number, and that number is dominated by the seed
 * rather than by the market — convincing to look at and wrong to trade. The
 * multiplier below is the standard "several time constants" rule for letting a
 * recursive average forget its seed.
 */
export const INDICATOR_WARMUP = Object.freeze({
  rsi14: 15 * 3,
  stochRsi: 14 * 2 + 14 + 3,
  ema21: 21 * 3,
  ema50: 50 * 3,
  ema200: 200 * 3,
  atr14: 15 * 3,
  bollinger20: 20 * 2,
  macd: 26 * 3 + 9,
  ma200w: 200
});

/**
 * Assert a series is long enough for a named calculation.
 * Throws InsufficientHistoryError rather than returning a shortened series,
 * because the caller's next line is an indicator that would happily compute.
 */
export function requireCoverage(candles, required, { symbol, interval, label } = {}) {
  const available = Array.isArray(candles) ? candles.length : 0;
  if (available < required) {
    throw new InsufficientHistoryError(
      `Insufficient history for ${label || 'calculation'}: need ${required} bars of ${interval}, have ${available}.`,
      { symbol, interval, required, available }
    );
  }
  return candles;
}

/**
 * Non-throwing coverage report, for building a UI that shows which indicators
 * are computable rather than failing the whole request because one is not.
 *
 * @returns {{ available: number, sufficient: Object<string, boolean>, insufficient: string[] }}
 */
export function coverageReport(candles, requirements = INDICATOR_WARMUP) {
  const available = Array.isArray(candles) ? candles.length : 0;
  const sufficient = {};
  const insufficient = [];
  for (const [name, required] of Object.entries(requirements)) {
    const ok = available >= required;
    sufficient[name] = ok;
    if (!ok) insufficient.push(`${name} (needs ${required}, have ${available})`);
  }
  return { available, sufficient, insufficient };
}

export default {
  FRESHNESS,
  INTERVAL_MS,
  INDICATOR_WARMUP,
  stalenessThresholdMs,
  makeProvenance,
  unavailableProvenance,
  attachProvenance,
  getProvenance,
  assertNotSynthetic,
  requireCoverage,
  coverageReport,
  DataUnavailableError,
  InsufficientHistoryError,
  UnsupportedSymbolError
};
