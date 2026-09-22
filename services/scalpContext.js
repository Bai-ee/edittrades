/**
 * Scalp Context Builder
 *
 * Assembles a compact, LLM/agent-friendly multi-symbol, multi-timeframe
 * snapshot (candles, indicators, structure, strategies) for BTC/SOL/ETH.
 * Never throws: any missing/failed data is recorded as a warning and the
 * corresponding slice of the payload is emitted with nulls/empties instead.
 */

import * as marketData from './marketData.js';
import * as indicatorService from './indicators.js';
import strategyService from './strategy.js';
import { buildStructure } from '../lib/structure.js';
import { getAccountSnapshot, emptySnapshot as emptyAccountSnapshot } from './walletTracker.js';

export const SYMBOLS = ['BTC', 'SOL', 'ETH'];
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

export const CANDLE_LIMITS = {
  '1m': 30,
  '3m': 30,
  '5m': 30,
  '15m': 24,
  '1h': 24,
  '4h': 20,
  '1d': 10
};

export const INTERVAL_MS = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000
};

const SYMBOL_PAIR_MAP = {
  BTC: 'BTCUSDT',
  SOL: 'SOLUSDT',
  ETH: 'ETHUSDT'
};

// Timeframes ordered smallest-first, used for price fallback selection.
const TF_SIZE_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

const FETCH_LIMIT = 500;
const MAX_CONCURRENCY = 6;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Round a number to N decimals, or null when not finite.
 * @param {*} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Round to 2 decimals, or null when not finite.
 * @param {*} value
 * @returns {number|null}
 */
function round2(value) {
  return roundN(value, 2);
}

/**
 * Tiny bounded-concurrency map helper (no new dependencies).
 * @param {Array} items
 * @param {number} limit
 * @param {(item:any, index:number)=>Promise<any>} iteratee
 * @returns {Promise<Array>}
 */
async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await iteratee(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Basic OHLCV shape check.
 * @param {*} c
 * @returns {boolean}
 */
function isValidCandle(c) {
  return !!c &&
    isFiniteNumber(c.timestamp) &&
    isFiniteNumber(c.open) &&
    isFiniteNumber(c.high) &&
    isFiniteNumber(c.low) &&
    isFiniteNumber(c.close);
}

/**
 * Remove any candle that has not fully closed yet (or is garbage).
 * A candle is closed when (closeTime ?? timestamp + INTERVAL_MS[interval]) <= now.
 * Never mutates the input array or its candles.
 * @param {Array<Object>} candles
 * @param {string} interval - one of TIMEFRAMES
 * @param {number} [now=Date.now()]
 * @returns {Array<Object>} new array of closed candles
 */
export function dropUnclosedCandles(candles, interval, now = Date.now()) {
  if (!Array.isArray(candles)) return [];

  const intervalMs = INTERVAL_MS[interval];
  const safeNow = isFiniteNumber(now) ? now : Date.now();
  const out = [];

  for (const candle of candles) {
    if (!isValidCandle(candle)) continue;

    const closeTime = isFiniteNumber(candle.closeTime)
      ? candle.closeTime
      : (isFiniteNumber(intervalMs) ? candle.timestamp + intervalMs : NaN);

    if (!isFiniteNumber(closeTime)) continue;
    if (closeTime <= safeNow) out.push(candle);
  }

  return out;
}

/**
 * Clamp a stoch value to [0, 100] and round to 2 decimals, or null.
 * @param {*} value
 * @returns {number|null}
 */
function clamp0to100(value) {
  if (!isFiniteNumber(value)) return null;
  return round2(Math.min(100, Math.max(0, value)));
}

/**
 * Derive a compact Stochastic RSI read from history.
 * @param {Array<{k:number,d:number}>|null|undefined} history
 * @returns {{k:number|null,d:number|null,state:string|null,cross:string|null,slopeK:number|null,slopeD:number|null}}
 */
export function deriveStochRsi(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { k: null, d: null, state: null, cross: null, slopeK: null, slopeD: null };
  }

  const last = history[history.length - 1];
  const k = clamp0to100(last && last.k);
  const d = clamp0to100(last && last.d);

  let state = null;
  if (k !== null && d !== null) {
    if (k > 80 && d > 80) state = 'OVERBOUGHT';
    else if (k < 20 && d < 20) state = 'OVERSOLD';
    else if (k > d) state = 'BULLISH';
    else if (k < d) state = 'BEARISH';
    else state = 'NEUTRAL';
  }

  let cross = null;
  let slopeK = null;
  let slopeD = null;

  if (history.length >= 2) {
    const prev = history[history.length - 2];
    const pk = clamp0to100(prev && prev.k);
    const pd = clamp0to100(prev && prev.d);

    if (pk !== null && pd !== null && k !== null && d !== null) {
      if (pk <= pd && k > d) cross = 'BULLISH_CROSS';
      else if (pk >= pd && k < d) cross = 'BEARISH_CROSS';
      else cross = 'NONE';
    } else {
      cross = 'NONE';
    }

    if (pk !== null && k !== null) slopeK = round2(k - pk);
    if (pd !== null && d !== null) slopeD = round2(d - pd);
  }

  return { k, d, state, cross, slopeK, slopeD };
}

/**
 * Deep-clone a value for safe JSON output: NaN/Infinity/-Infinity/undefined
 * become null, undefined object properties are dropped, and cycles are
 * broken (converted to null).
 * @param {*} value
 * @param {WeakSet} [seen]
 * @returns {*}
 */
export function normalizeJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null;

  const type = typeof value;

  if (type === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (type === 'string' || type === 'boolean') {
    return value;
  }
  if (type !== 'object') {
    // functions, symbols, bigint, etc. have no safe JSON representation
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (seen.has(value)) return null; // cycle guard
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value.map((item) => normalizeJson(item, seen));
    seen.delete(value);
    return arr;
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue; // drop undefined properties
    out[key] = normalizeJson(v, seen);
  }
  seen.delete(value);
  return out;
}

/**
 * Format a closed candle for the compact payload.
 * @param {Object} candle
 * @returns {{t:string|null,o:number|null,h:number|null,l:number|null,c:number|null,v:number|null}}
 */
function formatCandleOut(candle) {
  return {
    t: isFiniteNumber(candle.timestamp) ? new Date(candle.timestamp).toISOString() : null,
    o: round2(candle.open),
    h: round2(candle.high),
    l: round2(candle.low),
    c: round2(candle.close),
    v: roundN(candle.volume, 4)
  };
}

/**
 * @returns {Object} a fully-null timeframe entry (used when data is unusable)
 */
function nullTimeframeEntry() {
  return {
    candles: [],
    ema21: null,
    ema200: null,
    priceVs21Pct: null,
    priceVs200Pct: null,
    trend: null,
    stochRsi: { k: null, d: null, state: null, cross: null, slopeK: null, slopeD: null },
    closedThrough: null,
    candleCount: 0
  };
}

/**
 * @returns {Object} a fully-null structure block
 */
function nullStructure() {
  return {
    sessionHigh: null,
    sessionLow: null,
    prevDayHigh: null,
    prevDayLow: null,
    swingHighs: [],
    swingLows: [],
    support: [],
    resistance: [],
    aboveEma21: null,
    aboveEma200: null
  };
}

/**
 * Coerce a value to a finite number, or null.
 *
 * Nothing is fabricated here: a missing or non-finite engine level becomes null so
 * a consumer can tell "the engine did not produce this level" from a real price.
 *
 * @param {*} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * Normalize an engine entry zone to { min, max }, dropping non-finite bounds.
 * @param {*} zone
 * @returns {{min:number|null,max:number|null}}
 */
function normalizeEntryZone(zone) {
  if (!zone || typeof zone !== 'object') return { min: null, max: null };
  return { min: finiteOrNull(zone.min), max: finiteOrNull(zone.max) };
}

/**
 * Normalize engine targets to an array of finite prices, preserving order.
 * Unavailable targets collapse to [] rather than [null, null].
 * @param {*} targets
 * @returns {Array<number>}
 */
function normalizeTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(isFiniteNumber);
}

/**
 * Normalize an engine risk/reward block, dropping non-finite ratios.
 * @param {*} rr
 * @returns {{tp1RR:number|null,tp2RR:number|null}}
 */
function normalizeRiskReward(rr) {
  if (!rr || typeof rr !== 'object') return { tp1RR: null, tp2RR: null };
  return { tp1RR: finiteOrNull(rr.tp1RR), tp2RR: finiteOrNull(rr.tp2RR) };
}

/**
 * Trim a strategy result down to the essentials so the payload stays small.
 *
 * The execution levels the engine already calculated (entry zone, stop, targets,
 * risk/reward, stop source) are carried through verbatim, because a consumer that
 * only sees valid/direction/confidence has no way to act on - or disagree with - a
 * signal. Nothing is invented: a level the engine did not produce stays null (or
 * [] for targets).
 *
 * @param {Object} strategies - strategyService.evaluateAllStrategies(...).strategies
 * @returns {Object}
 */
function trimStrategies(strategies) {
  const out = {};
  if (!strategies || typeof strategies !== 'object') return out;

  for (const [name, s] of Object.entries(strategies)) {
    if (!s || typeof s !== 'object') continue;
    out[name] = {
      valid: !!s.valid,
      direction: s.direction || 'NO_TRADE',
      confidence: isFiniteNumber(s.confidence) ? s.confidence : 0,
      reason: s.reason || null,
      entryZone: normalizeEntryZone(s.entryZone),
      stopLoss: finiteOrNull(s.stopLoss),
      invalidationLevel: finiteOrNull(s.invalidationLevel),
      targets: normalizeTargets(s.targets),
      riskReward: normalizeRiskReward(s.riskReward),
      stopSource: typeof s.stopSource === 'string' ? s.stopSource : null,
      entryType: typeof s.entryType === 'string' ? s.entryType : null
    };
  }
  return out;
}

/**
 * Determine the ISO close time of the newest closed candle in an array.
 * @param {Array<Object>} closed
 * @param {string} tf
 * @returns {string|null}
 */
function closedThroughOf(closed, tf) {
  if (!Array.isArray(closed) || closed.length === 0) return null;
  const newest = closed[closed.length - 1];
  if (isFiniteNumber(newest.closeTime)) return new Date(newest.closeTime).toISOString();
  if (isFiniteNumber(newest.timestamp) && isFiniteNumber(INTERVAL_MS[tf])) {
    return new Date(newest.timestamp + INTERVAL_MS[tf]).toISOString();
  }
  return null;
}

/**
 * Strict live-data fetch used by the connector.
 *
 * Synthetic candles are never requested: allowSynthetic stays false, so a provider
 * failure surfaces as an error envelope instead of fabricated data. 3m is derived
 * from verified live 1m candles inside marketData, so Kraken is never asked for
 * interval=3.
 *
 * @param {string} pair
 * @param {string} interval
 * @param {number} limit
 * @param {Object} [opts]
 * @returns {Promise<Object>} provenance envelope
 */
function defaultStrictFetch(pair, interval, limit, opts = {}) {
  return marketData.getCandlesWithProvenance(pair, interval, limit, {
    allowSynthetic: false,
    now: opts && isFiniteNumber(opts.now) ? opts.now : Date.now()
  });
}

/**
 * Normalize a fetch result into a provenance envelope.
 *
 * A bare array (legacy/injected fetchers) is accepted and labelled 'injected' - it is
 * never labelled as a live provider, so synthetic data cannot masquerade as Kraken.
 *
 * @param {*} raw
 * @returns {{candles:Array, provider:string|null, synthetic:boolean, error:string|null}}
 */
function toEnvelope(raw) {
  if (Array.isArray(raw)) {
    return { candles: raw, provider: 'injected', synthetic: false, error: null };
  }
  if (!raw || typeof raw !== 'object') {
    return { candles: [], provider: null, synthetic: false, error: 'invalid fetch result' };
  }
  return {
    candles: Array.isArray(raw.candles) ? raw.candles : [],
    provider: raw.provider || null,
    synthetic: raw.synthetic === true,
    error: raw.error || null
  };
}

/**
 * Resolve the symbol-level provider label from the providers actually observed.
 * Never infers 'kraken' from the mere absence of an exception.
 *
 * @param {Array<string>} providers - providers that returned usable live data
 * @param {number} expectedCount - number of timeframes requested
 * @param {boolean} hadWarning
 * @returns {string}
 */
function resolveSymbolProvider(providers, expectedCount, hadWarning) {
  if (!Array.isArray(providers) || providers.length === 0) return 'unavailable';

  const unique = [...new Set(providers)];
  const allKraken = unique.every((p) => p === 'kraken' || p === 'kraken-derived');
  const complete = providers.length === expectedCount && !hadWarning;

  if (allKraken) return complete ? 'kraken' : 'kraken-partial';
  if (unique.length === 1) return complete ? unique[0] : `${unique[0]}-partial`;
  return 'mixed';
}

/**
 * Build the full scalp context payload for a set of symbols/timeframes.
 *
 * @param {Object} [options]
 * @param {Array<string>} [options.symbols=SYMBOLS]
 * @param {Array<string>} [options.timeframes=TIMEFRAMES]
 * @param {number} [options.now=Date.now()]
 * @param {(pair:string, interval:string, limit:number)=>Promise<Array>} [options.fetchCandles] - injectable for tests
 * @param {Function} [options.fetchAccount] - injectable wallet snapshot reader, for tests
 * @returns {Promise<Object>} normalized JSON-safe payload
 */
export async function buildScalpContext(options = {}) {
  const {
    symbols = SYMBOLS,
    timeframes = TIMEFRAMES,
    now = Date.now(),
    fetchCandles = defaultStrictFetch,
    fetchAccount = getAccountSnapshot
  } = options || {};

  const safeNow = isFiniteNumber(now) ? now : Date.now();
  const warnings = [];

  const symbolList = Array.isArray(symbols) && symbols.length > 0 ? symbols : SYMBOLS;
  const timeframeList = Array.isArray(timeframes) && timeframes.length > 0 ? timeframes : TIMEFRAMES;

  console.log(`[ScalpContext] Building context: symbols=${symbolList.join(',')} timeframes=${timeframeList.join(',')}`);

  // Build the flat list of (symbol, timeframe) fetch tasks.
  const tasks = [];
  for (const symbol of symbolList) {
    const pair = SYMBOL_PAIR_MAP[symbol] || `${symbol}USDT`;
    for (const tf of timeframeList) {
      tasks.push({ symbol, tf, pair });
    }
  }

  const fetchResults = await mapLimit(tasks, MAX_CONCURRENCY, async (task) => {
    try {
      const raw = await fetchCandles(task.pair, task.tf, FETCH_LIMIT, { now: safeNow });
      const envelope = toEnvelope(raw);

      // Synthetic candles must never reach the connector, and must never be
      // presented as live provider data.
      if (envelope.synthetic || envelope.provider === 'synthetic') {
        return {
          ...task,
          candles: [],
          ok: false,
          provider: 'synthetic',
          error: 'synthetic data rejected by strict connector'
        };
      }

      if (envelope.error || !envelope.provider || envelope.candles.length === 0) {
        return {
          ...task,
          candles: [],
          ok: false,
          provider: envelope.provider || null,
          error: envelope.error || 'no live candles returned'
        };
      }

      return { ...task, candles: envelope.candles, ok: true, provider: envelope.provider, error: null };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[ScalpContext] fetch failed for ${task.symbol} ${task.tf}: ${message}`);
      return { ...task, candles: [], ok: false, provider: null, error: message };
    }
  });

  const bySymbolTf = {};
  for (const symbol of symbolList) bySymbolTf[symbol] = {};
  for (const r of fetchResults) {
    bySymbolTf[r.symbol][r.tf] = r;
  }

  const symbolsOut = {};
  const newest1mCloses = [];

  for (const symbol of symbolList) {
    const pair = SYMBOL_PAIR_MAP[symbol] || `${symbol}USDT`;
    let symbolHadWarning = false;

    const tfEntries = {};
    const closedByTf = {};
    const mtfForStrategy = {};
    const tfProviders = [];

    for (const tf of timeframeList) {
      const fetched = bySymbolTf[symbol][tf];

      if (!fetched || !fetched.ok) {
        warnings.push(`${symbol} ${tf}: live data unavailable${fetched && fetched.error ? ' - ' + fetched.error : ''}`);
        symbolHadWarning = true;
      } else if (fetched.provider) {
        tfProviders.push(fetched.provider);
      }

      const rawCandles = (fetched && fetched.candles) || [];
      const closed = dropUnclosedCandles(rawCandles, tf, safeNow);
      closedByTf[tf] = closed;

      if (closed.length < 2) {
        warnings.push(`${symbol} ${tf}: insufficient closed candles (${closed.length})`);
        symbolHadWarning = true;
        tfEntries[tf] = nullTimeframeEntry();
        continue;
      }

      let indicators;
      try {
        indicators = indicatorService.calculateAllIndicators(closed);
      } catch (err) {
        warnings.push(`${symbol} ${tf}: indicator calculation failed - ${err.message}`);
        symbolHadWarning = true;
        tfEntries[tf] = nullTimeframeEntry();
        continue;
      }

      const limitCount = CANDLE_LIMITS[tf] || closed.length;
      const trimmed = closed.slice(-limitCount);

      const ema21 = isFiniteNumber(indicators.ema && indicators.ema.ema21) ? indicators.ema.ema21 : null;
      const ema200 = isFiniteNumber(indicators.ema && indicators.ema.ema200) ? indicators.ema.ema200 : null;
      const lastClose = closed[closed.length - 1].close;

      const priceVs21Pct = ema21 !== null && isFiniteNumber(lastClose)
        ? round2(((lastClose - ema21) / ema21) * 100)
        : null;
      const priceVs200Pct = ema200 !== null && isFiniteNumber(lastClose)
        ? round2(((lastClose - ema200) / ema200) * 100)
        : null;

      tfEntries[tf] = {
        candles: trimmed.map(formatCandleOut),
        ema21,
        ema200,
        priceVs21Pct,
        priceVs200Pct,
        trend: (indicators.analysis && indicators.analysis.trend) || null,
        stochRsi: deriveStochRsi(indicators.stochRSI && indicators.stochRSI.history),
        closedThrough: closedThroughOf(closed, tf),
        candleCount: closed.length
      };

      mtfForStrategy[tf] = {
        indicators,
        structure: indicatorService.detectSwingPoints(closed, 20),
        candleCount: closed.length,
        lastCandle: closed[closed.length - 1]
      };
    }

    // price = close of newest closed 1m candle, fall back to smallest available timeframe
    let price = null;
    for (const tf of TF_SIZE_ORDER) {
      const entry = tfEntries[tf];
      if (entry && entry.candles && entry.candles.length > 0) {
        const lastCandle = entry.candles[entry.candles.length - 1];
        if (isFiniteNumber(lastCandle.c)) {
          price = lastCandle.c;
          break;
        }
      }
    }

    if (tfEntries['1m'] && tfEntries['1m'].closedThrough) {
      newest1mCloses.push(tfEntries['1m'].closedThrough);
    }

    let structure;
    try {
      structure = buildStructure({
        candles1d: closedByTf['1d'] || [],
        candles1h: closedByTf['1h'] || [],
        candles15m: closedByTf['15m'] || [],
        price,
        ema21: tfEntries['1h'] ? tfEntries['1h'].ema21 : null,
        ema200: tfEntries['1h'] ? tfEntries['1h'].ema200 : null,
        now: safeNow
      });
    } catch (err) {
      warnings.push(`${symbol}: structure build failed - ${err.message}`);
      symbolHadWarning = true;
      structure = nullStructure();
    }

    let strategies = {};
    let bestSignal = null;
    try {
      const result = strategyService.evaluateAllStrategies(pair, mtfForStrategy, 'STANDARD');
      strategies = trimStrategies(result && result.strategies);
      bestSignal = (result && result.bestSignal) || null;
    } catch (err) {
      warnings.push(`${symbol}: strategy evaluation failed - ${err.message}`);
      symbolHadWarning = true;
      strategies = {};
      bestSignal = null;
    }

    symbolsOut[symbol] = {
      price,
      source: {
        provider: resolveSymbolProvider(tfProviders, timeframeList.length, symbolHadWarning),
        pair,
        fetchedAt: new Date(safeNow).toISOString()
      },
      structure,
      timeframes: tfEntries,
      strategies,
      bestSignal
    };
  }

  const usableSymbolCount = Object.values(symbolsOut).filter((s) => s.price !== null).length;
  let dataStatus = 'complete';
  if (usableSymbolCount === 0) {
    dataStatus = 'unavailable';
  } else if (warnings.length > 0) {
    dataStatus = 'partial';
  }

  // Oldest of the per-symbol newest 1m closes = the time through which ALL data is closed.
  const closedThrough = newest1mCloses.length > 0
    ? newest1mCloses.slice().sort()[0]
    : null;

  console.log(`[ScalpContext] Done: dataStatus=${dataStatus} warnings=${warnings.length}`);

  // Tracked-wallet equity, priced with the SOL price this build already resolved so no
  // extra price source is introduced. Read-only: walletTracker holds no signing key.
  //
  // A failed wallet read is reported on account.status and is deliberately NOT pushed
  // into `warnings`, because `warnings` drives `dataStatus` - an RPC hiccup on the wallet
  // must not mark otherwise-complete market data as 'partial'.
  let account;
  try {
    account = await fetchAccount({
      prices: {
        SOL: symbolsOut.SOL ? symbolsOut.SOL.price : null,
        BTC: symbolsOut.BTC ? symbolsOut.BTC.price : null,
        ETH: symbolsOut.ETH ? symbolsOut.ETH.price : null
      },
      now: safeNow
    });
  } catch (err) {
    account = emptyAccountSnapshot('unavailable', `wallet read threw - ${err.message}`);
  }

  const payload = {
    schemaVersion: '1.1.0',
    generatedAt: new Date(safeNow).toISOString(),
    closedThrough,
    sessionTimezone: 'UTC',
    dataStatus,
    account,
    symbols: symbolsOut,
    warnings
  };

  return normalizeJson(payload);
}

export default {
  buildScalpContext,
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_LIMITS
};
