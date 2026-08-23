/**
 * Market Data Module
 * ------------------
 * Single source of truth for OHLCV candlestick data.
 *
 * TRUST MODEL — the one rule this module exists to hold:
 *
 *   Every value returned here is a real observation from a named provider, or
 *   it is an error. There is no third option.
 *
 * That is a change in kind, not degree. This module previously answered a
 * failed Kraken call with `generateSyntheticData()` — a random walk seeded from
 * a spot price, or from a hardcoded $50,000 when even the spot lookup failed —
 * and returned it through the same code path as genuine candles, with nothing
 * in the shape of the result to tell them apart. Those candles fed the scanner,
 * the strategy engine, the AI trading context and anything sizing a position
 * off them. It is deleted, and `assertNotSynthetic` now guards the return path
 * so it cannot come back unnoticed.
 *
 * Providers are Kraken then Bitfinex. Both publish genuine exchange trades, so
 * failing between them changes the venue but not the meaning of the data. When
 * both are down, a cached real observation is served and labelled STALE; when
 * there is no cache either, the call throws DataUnavailableError.
 *
 * Every candle array carries provenance — source, fetch time, age, freshness,
 * whether it was aggregated from a shorter bar — readable via
 * `getProvenance()` from services/dataProvenance.js.
 */

import axios from 'axios';
import * as provenance from './dataProvenance.js';

const BITFINEX_BASE = process.env.BITFINEX_API_BASE || 'https://api-pub.bitfinex.com/v2';

// Comprehensive symbol mapping for major cryptocurrencies
const SYMBOL_MAP = {
  // Major Coins
  'BTCUSDT': { kraken: 'XBTUSD', bitfinex: 'tBTCUSD', coingecko: 'bitcoin', name: 'Bitcoin' },
  'ETHUSDT': { kraken: 'ETHUSD', bitfinex: 'tETHUSD', coingecko: 'ethereum', name: 'Ethereum' },
  'SOLUSDT': { kraken: 'SOLUSD', bitfinex: 'tSOLUSD', coingecko: 'solana', name: 'Solana' },
  'BNBUSDT': { kraken: 'BNBUSD', bitfinex: 'tBNBUSD', coingecko: 'binancecoin', name: 'BNB' },
  'ADAUSDT': { kraken: 'ADAUSD', bitfinex: 'tADAUSD', coingecko: 'cardano', name: 'Cardano' },
  'XRPUSDT': { kraken: 'XRPUSD', bitfinex: 'tXRPUSD', coingecko: 'ripple', name: 'XRP' },
  'DOGEUSDT': { kraken: 'DOGEUSD', bitfinex: 'tDOGEUSD', coingecko: 'dogecoin', name: 'Dogecoin' },
  'DOTUSDT': { kraken: 'DOTUSD', bitfinex: 'tDOTUSD', coingecko: 'polkadot', name: 'Polkadot' },
  'MATICUSDT': { kraken: 'MATICUSD', bitfinex: 'tMATICUSD', coingecko: 'matic-network', name: 'Polygon' },
  'LINKUSDT': { kraken: 'LINKUSD', bitfinex: 'tLINKUSD', coingecko: 'chainlink', name: 'Chainlink' },
  
  // DeFi & Layer 1
  'AVAXUSDT': { kraken: 'AVAXUSD', bitfinex: 'tAVAXUSD', coingecko: 'avalanche-2', name: 'Avalanche' },
  'ATOMUSDT': { kraken: 'ATOMUSD', bitfinex: 'tATOMUSD', coingecko: 'cosmos', name: 'Cosmos' },
  'UNIUSDT': { kraken: 'UNIUSD', bitfinex: 'tUNIUSD', coingecko: 'uniswap', name: 'Uniswap' },
  'AAVEUSDT': { kraken: 'AAVEUSD', bitfinex: 'tAAVEUSD', coingecko: 'aave', name: 'Aave' },
  'ALGOUSDT': { kraken: 'ALGOUSD', bitfinex: 'tALGOUSD', coingecko: 'algorand', name: 'Algorand' },
  
  // Layer 2 & Scaling
  'ARBUSDT': { kraken: 'ARBUSD', bitfinex: 'tARBUSD', coingecko: 'arbitrum', name: 'Arbitrum' },
  'OPUSDT': { kraken: 'OPUSD', bitfinex: 'tOPUSD', coingecko: 'optimism', name: 'Optimism' },
  
  // Meme & Community
  'SHIBUSDT': { kraken: 'SHIBUSD', bitfinex: 'tSHIBUSD', coingecko: 'shiba-inu', name: 'Shiba Inu' },
  'PEPEUSDT': { kraken: 'PEPEUSD', bitfinex: 'tPEPEUSD', coingecko: 'pepe', name: 'Pepe' },
  
  // Other Major Assets
  'LTCUSDT': { kraken: 'LTCUSD', bitfinex: 'tLTCUSD', coingecko: 'litecoin', name: 'Litecoin' },
  'BCHUSDT': { kraken: 'BCHUSD', bitfinex: 'tBCHUSD', coingecko: 'bitcoin-cash', name: 'Bitcoin Cash' },
  'XLMUSDT': { kraken: 'XLMUSD', bitfinex: 'tXLMUSD', coingecko: 'stellar', name: 'Stellar' },
  'TRXUSDT': { kraken: 'TRXUSD', bitfinex: 'tTRXUSD', coingecko: 'tron', name: 'Tron' },
  'ETCUSDT': { kraken: 'ETCUSD', bitfinex: 'tETCUSD', coingecko: 'ethereum-classic', name: 'Ethereum Classic' },
  'XMRUSDT': { kraken: 'XMRUSD', bitfinex: 'tXMRUSD', coingecko: 'monero', name: 'Monero' },
  'FILUSDT': { kraken: 'FILUSD', bitfinex: 'tFILUSD', coingecko: 'filecoin', name: 'Filecoin' },
  'APTUSDT': { kraken: 'APTUSD', bitfinex: 'tAPTUSD', coingecko: 'aptos', name: 'Aptos' },
  'NEARUSDT': { kraken: 'NEARUSD', bitfinex: 'tNEARUSD', coingecko: 'near', name: 'Near Protocol' },
  'ICPUSDT': { kraken: 'ICPUSD', bitfinex: 'tICPUSD', coingecko: 'internet-computer', name: 'Internet Computer' },
  'INJUSDT': { kraken: 'INJUSD', bitfinex: 'tINJUSD', coingecko: 'injective-protocol', name: 'Injective' },
  'SUIUSDT': { kraken: 'SUIUSD', bitfinex: 'tSUIUSD', coingecko: 'sui', name: 'Sui' },
  'TONUSDT': { kraken: 'TONUSD', bitfinex: 'tTONUSD', coingecko: 'the-open-network', name: 'Toncoin' }
};

/**
 * Resolve a symbol to its per-provider identifiers, or refuse.
 *
 * The previous code wrote `SYMBOL_MAP[symbol]?.kraken || 'XBTUSD'` at three
 * call sites, so an unrecognised ticker did not fail — it silently returned
 * **Bitcoin** data under the requested symbol's name. A typo, or any asset not
 * in the map, produced a complete, plausible, entirely wrong analysis: BTC
 * candles, BTC indicators, a BTC setup, labelled as the other asset. That is
 * the purest form of the failure this module now forbids, so an unknown symbol
 * is an error.
 */
function requireSymbol(symbol) {
  const entry = SYMBOL_MAP[symbol];
  if (!entry) throw new provenance.UnsupportedSymbolError(symbol);
  return entry;
}

/**
 * Resolve a symbol to its Kraken pair, or throw.
 *
 * Exported because two other modules had each grown their own copy of this
 * lookup and both were wrong: `api/analyze-full.js` declared a shadowing
 * three-entry map (so every asset outside BTC/ETH/SOL got Bitcoin's order book
 * under its own name), and `server.js` read `marketData.SYMBOL_MAP`, which was
 * never exported — so the optional chain collapsed to `'XBTUSD'` for *every*
 * symbol. One exported resolver that throws is the only way that stays fixed.
 */
export function resolveKrakenPair(symbol) {
  return requireSymbol(symbol).kraken;
}

/** Read-only view of the supported-symbol table. */
export const SUPPORTED_SYMBOLS = Object.freeze({ ...SYMBOL_MAP });

/* ========================================================================
 * AGGREGATION
 *
 * Aggregating shorter real bars into longer ones is a legitimate transform of
 * genuine observations, not fabrication — but only if the buckets are pinned
 * to absolute time.
 *
 * The previous implementation chunked the array in fixed groups (`i += 7`)
 * starting from whatever row the provider's window happened to begin at. Since
 * Kraken returns a rolling last-N window, that start row moves on every call,
 * so a "weekly" candle silently changed which seven days it covered between
 * one request and the next, and never matched a real weekly bar on any chart.
 * Indicators built on it were computing over a drifting basis.
 *
 * Every bucket below is now derived from the bar's own timestamp, so the same
 * calendar period always produces the same candle regardless of the window.
 * ===================================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Combine a set of same-bucket candles into one.
 * Open comes from the earliest bar and close from the latest, so the caller
 * must pass them in ascending time order.
 */
function mergeBucket(bucket, bucketStart, bucketEnd) {
  return {
    timestamp: bucketStart,
    open: bucket[0].open,
    high: Math.max(...bucket.map((c) => c.high)),
    low: Math.min(...bucket.map((c) => c.low)),
    close: bucket[bucket.length - 1].close,
    volume: bucket.reduce((sum, c) => sum + c.volume, 0),
    closeTime: bucketEnd,
    // How many source bars actually landed in this bucket. A trailing bucket
    // mid-formation, or one spanning a provider gap, will be short — the
    // caller can drop partial periods rather than treat them as complete.
    sourceBars: bucket.length
  };
}

/**
 * Group candles by a key function, then merge each group.
 * @param {Array} candles ascending by timestamp
 * @param {(ts:number)=>{start:number,end:number}} bucketFor
 */
function aggregateByBucket(candles, bucketFor) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const out = [];
  let current = [];
  let currentStart = null;
  let currentEnd = null;

  for (const candle of candles) {
    const { start, end } = bucketFor(candle.timestamp);
    if (currentStart === null) {
      currentStart = start;
      currentEnd = end;
    } else if (start !== currentStart) {
      out.push(mergeBucket(current, currentStart, currentEnd));
      current = [];
      currentStart = start;
      currentEnd = end;
    }
    current.push(candle);
  }

  if (current.length > 0) out.push(mergeBucket(current, currentStart, currentEnd));
  return out;
}

/**
 * 3-day buckets anchored to the Unix epoch.
 *
 * There is no universal convention for where a 3-day candle starts, so the
 * choice is arbitrary — but it must be *fixed*, and epoch-anchoring makes it
 * reproducible by anyone: bucket = floor(ts / 3 days).
 */
function aggregate3DayCandles(dailyCandles) {
  const span = 3 * DAY_MS;
  return aggregateByBucket(dailyCandles, (ts) => {
    const start = Math.floor(ts / span) * span;
    return { start, end: start + span };
  });
}

/** ISO weeks: Monday 00:00 UTC through the following Sunday. */
function aggregateWeeklyCandles(dailyCandles) {
  return aggregateByBucket(dailyCandles, (ts) => {
    const d = new Date(ts);
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dayOfWeek * DAY_MS;
    return { start, end: start + 7 * DAY_MS };
  });
}

/**
 * Calendar months, not 30-day blocks.
 * The old fixed-30-day chunking drifted a full month out of alignment roughly
 * every year, so a "monthly" candle was not a month.
 */
function aggregateMonthlyCandles(dailyCandles) {
  return aggregateByBucket(dailyCandles, (ts) => {
    const d = new Date(ts);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return { start, end };
  });
}

/**
 * Fetch OHLCV data from Kraken
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Timeframe (1m, 5m, 15m, 1h, 4h, 1d, 3d)
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Array>} Array of OHLCV objects
 */
async function fetchFromKraken(symbol, interval, limit = 500) {
  const krakenSymbol = requireSymbol(symbol).kraken;

  // Intervals Kraken serves natively. Anything absent here is aggregated from
  // a shorter native bar rather than being requested and silently mis-served:
  // the old code fell back to `|| 60`, so a request for '3m' — which Kraken
  // does not offer — returned HOURLY candles labelled as three-minute ones.
  const KRAKEN_NATIVE = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };

  const DERIVED = {
    '3m': { from: '1m', aggregate: (c) => aggregateByBucket(c, bucketOfMinutes(3)), factor: 3 },
    '3d': { from: '1d', aggregate: aggregate3DayCandles, factor: 3 },
    '1M': { from: '1d', aggregate: aggregateMonthlyCandles, factor: 31 }
  };

  const derived = DERIVED[interval];
  if (derived) {
    const source = await fetchFromKraken(symbol, derived.from, limit * derived.factor);
    return { candles: derived.aggregate(source.candles), derivedFrom: derived.from };
  }

  const krakenInterval = KRAKEN_NATIVE[interval];
  if (!krakenInterval) {
    throw new Error(`Kraken does not support interval ${interval} for ${symbol}`);
  }

  const response = await axios.get('https://api.kraken.com/0/public/OHLC', {
    params: { pair: krakenSymbol, interval: krakenInterval },
    timeout: 10000
  });

  if (response.data?.error && response.data.error.length > 0) {
    throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
  }
  if (!response.data?.result) {
    throw new Error('Kraken returned an unexpected payload shape');
  }

  const pairKey = Object.keys(response.data.result).find((k) => k !== 'last');
  const ohlcData = response.data.result[pairKey];

  if (!Array.isArray(ohlcData) || ohlcData.length === 0) {
    throw new Error('No data returned from Kraken');
  }

  const candles = ohlcData.slice(-limit).map((candle) => ({
    timestamp: candle[0] * 1000, // Kraken reports seconds
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[6]),
    closeTime: (candle[0] + krakenInterval * 60) * 1000
  }));

  return { candles: rejectMalformed(candles, 'kraken', symbol, interval), derivedFrom: null };
}

/** Bucket helper for minute-multiple intervals, anchored to the epoch. */
function bucketOfMinutes(minutes) {
  const span = minutes * 60 * 1000;
  return (ts) => {
    const start = Math.floor(ts / span) * span;
    return { start, end: start + span };
  };
}

/**
 * Second real provider for candles.
 *
 * Bitfinex is already trusted elsewhere in this repo (the Bitcoin Economic
 * Value price fallback) and publishes genuine exchange OHLCV, which is what
 * makes it an acceptable fallback under the trust model: both providers report
 * real trades, so failing over changes the venue but not the meaning. It also
 * serves up to 10,000 bars against Kraken's hard 720, so on long timeframes it
 * is frequently the *better* source rather than a degraded one.
 */
async function fetchFromBitfinex(symbol, interval, limit = 500) {
  const bitfinexSymbol = requireSymbol(symbol).bitfinex;

  const BITFINEX_NATIVE = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1h', '1d': '1D', '1w': '1W', '1M': '1M'
  };

  const DERIVED = {
    '3m': { from: '1m', aggregate: (c) => aggregateByBucket(c, bucketOfMinutes(3)), factor: 3 },
    // Bitfinex has 3h and 6h but no 4h, so a 4h bar is four real 1h bars.
    '4h': { from: '1h', aggregate: (c) => aggregateByBucket(c, bucketOfMinutes(240)), factor: 4 },
    '3d': { from: '1d', aggregate: aggregate3DayCandles, factor: 3 }
  };

  const derived = DERIVED[interval];
  if (derived) {
    const source = await fetchFromBitfinex(symbol, derived.from, limit * derived.factor);
    return { candles: derived.aggregate(source.candles), derivedFrom: derived.from };
  }

  const tf = BITFINEX_NATIVE[interval];
  if (!tf) {
    throw new Error(`Bitfinex does not support interval ${interval} for ${symbol}`);
  }

  const response = await axios.get(
    `${BITFINEX_BASE}/candles/trade:${tf}:${bitfinexSymbol}/hist`,
    { params: { limit: Math.min(limit, 10000), sort: 1 }, timeout: 10000 }
  );

  if (!Array.isArray(response.data)) {
    throw new Error('Bitfinex returned an unexpected payload shape');
  }
  if (response.data.length === 0) {
    throw new Error('No data returned from Bitfinex');
  }

  // Bitfinex candle layout: [ MTS, OPEN, CLOSE, HIGH, LOW, VOLUME ]
  const intervalMs = provenance.INTERVAL_MS[interval] || 0;
  const candles = response.data
    .filter((c) => Array.isArray(c) && c.length >= 6)
    .map((c) => ({
      timestamp: c[0],
      open: Number(c[1]),
      high: Number(c[3]),
      low: Number(c[4]),
      close: Number(c[2]),
      volume: Number(c[5]),
      closeTime: c[0] + intervalMs
    }));

  return { candles: rejectMalformed(candles, 'bitfinex', symbol, interval), derivedFrom: null };
}

/**
 * Drop nothing, fix nothing — just refuse a series that is not internally
 * coherent.
 *
 * A NaN close or a high below the low is a parse or provider fault, and every
 * indicator downstream will happily consume it and emit a number. Repairing
 * such a bar would be fabrication; the only honest options are to reject the
 * series or pass the fault on, and passing it on is how a bad print becomes a
 * position size.
 */
function rejectMalformed(candles, source, symbol, interval) {
  for (const c of candles) {
    const values = [c.open, c.high, c.low, c.close, c.volume];
    if (values.some((v) => !Number.isFinite(v))) {
      throw new Error(`${source} returned a non-numeric OHLCV field for ${symbol} ${interval}`);
    }
    if (c.high < c.low || c.open <= 0 || c.close <= 0) {
      throw new Error(`${source} returned an incoherent candle for ${symbol} ${interval} at ${new Date(c.timestamp).toISOString()}`);
    }
  }
  // Ascending time order is assumed by every aggregation and indicator here.
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timestamp <= candles[i - 1].timestamp) {
      throw new Error(`${source} returned out-of-order candles for ${symbol} ${interval}`);
    }
  }
  return candles;
}

/* ========================================================================
 * CANDLE CACHE
 *
 * Two jobs. The obvious one is avoiding a provider round-trip per request.
 * The load-bearing one is that when every provider is down, a real observation
 * from twenty minutes ago — clearly labelled STALE — is more useful to a trader
 * than an error, and infinitely more honest than a fabricated series. The cache
 * therefore stores the fetch time and never rewrites it: freshness is always
 * computed from when the data actually left the exchange.
 * ===================================================================== */

const candleCache = new Map();

/** Fresh window per interval: half a bar, so a cache hit is never a stale bar. */
function cacheTtlMs(interval) {
  const bar = provenance.INTERVAL_MS[interval] || 3_600_000;
  return Math.max(30_000, Math.min(bar / 2, 15 * 60 * 1000));
}

function cacheKey(symbol, interval, limit) {
  return `${symbol}:${interval}:${limit}`;
}

/** Exposed so validation scripts and tests can start from a known state. */
export function clearCandleCache() {
  candleCache.clear();
}

/**
 * Fetch OHLCV candles for one symbol and interval from a real provider.
 *
 * Provider order is Kraken, then Bitfinex — both genuine exchange feeds. If
 * both fail, a cached real observation is served and labelled STALE; if there
 * is no cache either, this THROWS `DataUnavailableError`.
 *
 * It does not, and must not, ever return invented candles. The random-walk
 * fallback this function used to carry could put a fabricated series into the
 * scanner, the strategy engine, the AI context and any risk calculation
 * downstream, with nothing in the response to distinguish it from a real one.
 *
 * @returns {Promise<Array>} candle array carrying non-enumerable provenance
 * @throws {DataUnavailableError|UnsupportedSymbolError}
 */
export async function getCandles(symbol, interval, limit = 500) {
  requireSymbol(symbol); // throws rather than substituting Bitcoin

  const key = cacheKey(symbol, interval, limit);
  const cached = candleCache.get(key);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < cacheTtlMs(interval)) {
    const candles = cached.candles.slice();
    return provenance.attachProvenance(
      candles,
      provenance.makeProvenance({
        source: cached.source,
        fetchedAt: cached.fetchedAt,
        interval,
        fromCache: true,
        lastBarTime: candles[candles.length - 1]?.timestamp ?? null,
        derivedFrom: cached.derivedFrom
      })
    );
  }

  const providerFailures = [];

  for (const provider of [
    { name: 'kraken', fetch: fetchFromKraken },
    { name: 'bitfinex', fetch: fetchFromBitfinex }
  ]) {
    try {
      const { candles, derivedFrom } = await provider.fetch(symbol, interval, limit);
      if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('Provider returned an empty series');
      }

      const fetchedAt = Date.now();
      candleCache.set(key, { candles, source: provider.name, derivedFrom, fetchedAt });

      if (providerFailures.length > 0) {
        // A provider transition is a real operational event, not noise. It is
        // logged at warn so it shows up without having to enable debug output.
        logProviderTransition({
          symbol, interval, used: provider.name, failures: providerFailures
        });
      }

      const result = provenance.attachProvenance(
        candles.slice(),
        provenance.makeProvenance({
          source: provider.name,
          fetchedAt,
          interval,
          fromCache: false,
          lastBarTime: candles[candles.length - 1]?.timestamp ?? null,
          derivedFrom,
          providerFailures
        })
      );
      // Tripwire: fails here, at the source, if anything ever reintroduces a
      // fabricated series rather than several layers downstream.
      return provenance.assertNotSynthetic(result, `getCandles(${symbol},${interval})`);
    } catch (error) {
      providerFailures.push({ provider: provider.name, error: error.message });
      console.warn(`[MarketData] ${provider.name} failed for ${symbol} ${interval}: ${error.message}`);
    }
  }

  // Every provider is down. A real observation that has gone cold, clearly
  // marked, beats both an error and an invention.
  if (cached) {
    console.warn(
      `[MarketData] All providers failed for ${symbol} ${interval}; serving STALE cache from ${new Date(cached.fetchedAt).toISOString()}`
    );
    const candles = cached.candles.slice();
    return provenance.attachProvenance(
      candles,
      provenance.makeProvenance({
        source: cached.source,
        fetchedAt: cached.fetchedAt,
        interval,
        fromCache: true,
        lastBarTime: candles[candles.length - 1]?.timestamp ?? null,
        derivedFrom: cached.derivedFrom,
        providerFailures
      })
    );
  }

  throw new provenance.DataUnavailableError(
    `No market data available for ${symbol} ${interval}: every provider failed and no cached observation exists.`,
    { symbol, interval, providerFailures }
  );
}

/**
 * Candles plus an explicit provenance object, for callers that need to put
 * freshness into a response body (provenance attached to the array itself is
 * non-enumerable and does not survive JSON serialisation).
 *
 * Never throws: an unavailable feed comes back as `ok:false` with the reason,
 * which is the shape the system-health model and the decision context consume.
 */
export async function getCandlesWithProvenance(symbol, interval, limit = 500) {
  try {
    const candles = await getCandles(symbol, interval, limit);
    return { ok: true, candles, provenance: provenance.getProvenance(candles), error: null };
  } catch (error) {
    return {
      ok: false,
      candles: null,
      provenance: provenance.unavailableProvenance({
        interval,
        providerFailures: error.providerFailures || []
      }),
      error: { code: error.code || 'ERROR', message: error.message }
    };
  }
}

/** Structured record of a fallback, so provider health is greppable in logs. */
function logProviderTransition({ symbol, interval, used, failures }) {
  console.warn(
    '[MarketData] provider_transition ' +
      JSON.stringify({
        event: 'provider_transition',
        symbol,
        interval,
        used,
        failed: failures.map((f) => f.provider),
        reasons: failures.map((f) => `${f.provider}: ${f.error}`)
      })
  );
}

/**
 * Fetch multi-timeframe data for a symbol
 * Main function used by the strategy engine
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {Array<string>} intervals - Array of timeframes (e.g., ['4h', '1h', '15m', '5m'])
 * @param {number} limit - Number of candles per timeframe
 * @returns {Promise<Object>} Object with interval as key, candles array as value
 */
export async function getMultiTimeframeData(symbol, intervals = ['4h', '1h', '15m', '5m'], limit = 500) {
  const results = {};

  const settled = await Promise.all(
    intervals.map(async (interval) => {
      try {
        const candles = await getCandles(symbol, interval, limit);
        return { interval, candles, error: null };
      } catch (error) {
        console.warn(`[MarketData] ${symbol} ${interval} unavailable: ${error.message}`);
        return {
          interval,
          candles: null,
          // Preserved as a structured code so callers can distinguish "the feed
          // is down" from "the feed is fine but too short for this indicator".
          error: { code: error.code || 'ERROR', message: error.message }
        };
      }
    })
  );

  // A per-interval failure stays a `{ error }` object rather than an array,
  // which is the contract every existing consumer already tests for
  // (`candles.error`, then `Array.isArray`). One dead timeframe therefore
  // degrades that timeframe only — it does not fabricate, and it does not take
  // the whole request down.
  for (const { interval, candles, error } of settled) {
    results[interval] = error ? { error: error.message, code: error.code } : candles;
  }

  return results;
}

/**
 * Provenance for a multi-timeframe bundle, keyed by interval.
 * Separate from the bundle itself so the candle arrays keep the plain shape
 * indicator code expects.
 */
export function multiTimeframeProvenance(multiData) {
  const out = {};
  for (const [interval, value] of Object.entries(multiData || {})) {
    if (Array.isArray(value)) {
      out[interval] = provenance.getProvenance(value);
    } else {
      out[interval] = provenance.unavailableProvenance({ interval });
    }
  }
  return out;
}

/**
 * Get current spot price for a symbol
 * @param {string} symbol - Trading pair
 * @returns {Promise<Object>} Price data
 */
export async function getTickerPrice(symbol) {
  const entry = requireSymbol(symbol);
  const providerFailures = [];

  // --- Kraken: full ticker, every field a real observation -----------------
  try {
    const response = await axios.get('https://api.kraken.com/0/public/Ticker', {
      params: { pair: entry.kraken },
      timeout: 5000
    });

    if (response.data?.error && response.data.error.length > 0) {
      throw new Error(`Kraken ticker error: ${response.data.error.join(', ')}`);
    }

    const pairKey = Object.keys(response.data?.result || {})[0];
    const tickerData = response.data?.result?.[pairKey];
    if (!tickerData) throw new Error('Kraken ticker returned no pair data');

    const lastPrice = parseFloat(tickerData.c[0]);
    const openPrice = parseFloat(tickerData.o);
    const high24h = parseFloat(tickerData.h[1]);
    const low24h = parseFloat(tickerData.l[1]);
    const volume24h = parseFloat(tickerData.v[1]);

    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      throw new Error('Kraken ticker returned no usable price');
    }

    const changeAvailable = Number.isFinite(openPrice) && openPrice > 0;

    return {
      symbol,
      price: lastPrice,
      // Absolute and percentage are genuinely different quantities. The old
      // CoinGecko branch assigned the *percentage* to both, so any consumer
      // reading `priceChange` as dollars was off by orders of magnitude.
      priceChange: changeAvailable ? lastPrice - openPrice : null,
      priceChangePercent: changeAvailable ? ((lastPrice - openPrice) / openPrice) * 100 : null,
      high24h: Number.isFinite(high24h) ? high24h : null,
      low24h: Number.isFinite(low24h) ? low24h : null,
      volume24h: Number.isFinite(volume24h) ? volume24h : null,
      provenance: provenance.makeProvenance({
        source: 'kraken',
        fetchedAt: Date.now(),
        interval: '1m'
      })
    };
  } catch (error) {
    providerFailures.push({ provider: 'kraken', error: error.message });
    console.warn(`[MarketData] Kraken ticker failed for ${symbol}: ${error.message}`);
  }

  // --- CoinGecko: a real price, but a genuinely narrower observation -------
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: entry.coingecko,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true
      },
      timeout: 5000
    });

    const data = response.data?.[entry.coingecko];
    const price = Number(data?.usd);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('CoinGecko returned no usable price');
    }

    const changePct = Number.isFinite(Number(data.usd_24h_change))
      ? Number(data.usd_24h_change)
      : null;

    logProviderTransition({ symbol, interval: 'ticker', used: 'coingecko', failures: providerFailures });

    return {
      symbol,
      price,
      // Derived from the percentage against the implied 24h-ago price. This is
      // arithmetic on a real observation, not an invented figure.
      priceChange: changePct === null ? null : price - price / (1 + changePct / 100),
      priceChangePercent: changePct,
      // CoinGecko's simple/price does not publish a 24h high or low, so these
      // are null. They were previously filled with `price * 1.02` and
      // `price * 0.98` — a fabricated 4%-wide range that any range-based
      // indicator or stop placement would have consumed as a real day's trade.
      high24h: null,
      low24h: null,
      volume24h: Number.isFinite(Number(data.usd_24h_vol)) ? Number(data.usd_24h_vol) : null,
      provenance: provenance.makeProvenance({
        source: 'coingecko',
        fetchedAt: Date.now(),
        interval: '1m',
        providerFailures
      })
    };
  } catch (error) {
    providerFailures.push({ provider: 'coingecko', error: error.message });
  }

  throw new provenance.DataUnavailableError(
    `No ticker available for ${symbol}: every provider failed.`,
    { symbol, interval: 'ticker', providerFailures }
  );
}

/**
 * Validate if a symbol is supported
 * @param {string} symbol - Trading pair to validate
 * @returns {boolean} True if supported
 */
export function isSymbolSupported(symbol) {
  return symbol in SYMBOL_MAP;
}

/**
 * Get list of supported symbols
 * @returns {Array<string>} Array of supported symbols
 */
export function getSupportedSymbols() {
  return Object.keys(SYMBOL_MAP);
}

/**
 * Get list of supported symbols with metadata
 * @returns {Array<Object>} Array of symbol objects with metadata
 */
export function getSupportedSymbolsWithInfo() {
  return Object.entries(SYMBOL_MAP).map(([symbol, info]) => ({
    symbol,
    name: info.name,
    krakenSymbol: info.kraken,
    coingeckoId: info.coingecko
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch ALL available trading pairs from Kraken dynamically
 * @returns {Promise<Array>} Array of all available trading pairs
 */
export async function getAllKrakenPairs() {
  try {
    const response = await axios.get('https://api.kraken.com/0/public/AssetPairs', {
      timeout: 10000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
    }

    const pairs = response.data.result;
    const usdPairs = [];

    // Filter for USD pairs and format them
    for (const [pairKey, pairData] of Object.entries(pairs)) {
      // Only include USD pairs (not USDT, USDC, etc. for simplicity)
      if (pairData.quote === 'USD' || pairData.quote === 'ZUSD') {
        const baseCurrency = pairData.base.replace(/^X|^Z/, ''); // Remove X/Z prefix
        const symbol = `${baseCurrency}USDT`; // Standardize to USDT format
        
        // Get a clean name (prioritize our known names, otherwise use base currency)
        const knownInfo = SYMBOL_MAP[symbol];
        const name = knownInfo ? knownInfo.name : formatCoinName(baseCurrency);
        
        usdPairs.push({
          symbol: symbol,
          name: name,
          krakenPair: pairKey,
          krakenBase: pairData.base,
          krakenQuote: pairData.quote,
          altname: pairData.altname
        });
      }
    }

    // Sort by name
    usdPairs.sort((a, b) => a.name.localeCompare(b.name));
    
    console.log(`✅ Loaded ${usdPairs.length} trading pairs from Kraken`);
    return usdPairs;

  } catch (error) {
    console.error('Error fetching Kraken pairs:', error.message);
    // Fallback to hardcoded list
    return getSupportedSymbolsWithInfo();
  }
}

/**
 * Format a coin symbol into a readable name
 * @param {string} symbol - Coin symbol (e.g., 'BTC', 'ETH')
 * @returns {string} Formatted name
 */
function formatCoinName(symbol) {
  const commonNames = {
    'BTC': 'Bitcoin',
    'XBT': 'Bitcoin',
    'ETH': 'Ethereum',
    'SOL': 'Solana',
    'BNB': 'BNB',
    'ADA': 'Cardano',
    'XRP': 'XRP',
    'DOGE': 'Dogecoin',
    'DOT': 'Polkadot',
    'MATIC': 'Polygon',
    'LINK': 'Chainlink',
    'AVAX': 'Avalanche',
    'ATOM': 'Cosmos',
    'UNI': 'Uniswap',
    'AAVE': 'Aave',
    'ALGO': 'Algorand',
    'ARB': 'Arbitrum',
    'OP': 'Optimism',
    'SHIB': 'Shiba Inu',
    'PEPE': 'Pepe',
    'LTC': 'Litecoin',
    'BCH': 'Bitcoin Cash',
    'XLM': 'Stellar',
    'TRX': 'Tron',
    'ETC': 'Ethereum Classic',
    'XMR': 'Monero',
    'FIL': 'Filecoin',
    'APT': 'Aptos',
    'NEAR': 'Near Protocol',
    'ICP': 'Internet Computer',
    'INJ': 'Injective',
    'SUI': 'Sui',
    'TON': 'Toncoin',
    'JUP': 'Jupiter',
    'RNDR': 'Render',
    'FTM': 'Fantom',
    'GRT': 'The Graph',
    'SAND': 'The Sandbox',
    'MANA': 'Decentraland',
    'AXS': 'Axie Infinity',
    'RUNE': 'THORChain',
    'FLOW': 'Flow',
    'IMX': 'Immutable X',
    'ENJ': 'Enjin',
    'ZEC': 'Zcash',
    'DASH': 'Dash',
    'COMP': 'Compound',
    'MKR': 'Maker',
    'SNX': 'Synthetix',
    'CRV': 'Curve',
    '1INCH': '1inch',
    'YFI': 'Yearn Finance',
    'SUSHI': 'SushiSwap',
    'BAT': 'Basic Attention Token',
    'ZRX': '0x',
    'OMG': 'OMG Network',
    'LRC': 'Loopring',
    'ENS': 'Ethereum Name Service',
    'AUDIO': 'Audius',
    'CHZ': 'Chiliz',
    'GALA': 'Gala',
    'APE': 'ApeCoin',
    'BLUR': 'Blur',
    'LDO': 'Lido DAO'
  };

  return commonNames[symbol] || symbol; // Fallback to symbol if not found
}

/**
 * Fetch all available trading pairs from Kraken dynamically
 * This gives us ALL coins available on Kraken
 * @returns {Promise<Array>} Array of all trading pairs
 */
export async function fetchAllKrakenPairs() {
  try {
    const response = await axios.get('https://api.kraken.com/0/public/AssetPairs', {
      timeout: 10000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
    }

    const pairs = response.data.result;
    const usdPairs = [];

    // Filter for USD pairs and clean up the data
    for (const [pairKey, pairData] of Object.entries(pairs)) {
      // Only include pairs that trade against USD
      if (pairData.quote === 'ZUSD' || pairData.quote === 'USD') {
        const baseCurrency = pairData.base;
        const wsname = pairData.wsname || pairKey;
        
        // Extract clean symbol names
        let cleanBase = baseCurrency
          .replace('X', '')
          .replace('Z', '')
          .toUpperCase();
        
        // Create USDT-style symbol for consistency
        const symbol = `${cleanBase}USDT`;
        const krakenSymbol = pairData.altname || pairKey;
        
        // Try to get a friendly name
        let name = cleanBase;
        // Check if we have it in our map
        if (SYMBOL_MAP[symbol]) {
          name = SYMBOL_MAP[symbol].name;
        } else {
          // Generate name from symbol
          name = cleanBase.charAt(0) + cleanBase.slice(1).toLowerCase();
        }

        usdPairs.push({
          symbol,
          name,
          krakenSymbol,
          krakenPair: pairKey,
          wsname,
          base: pairData.base,
          quote: pairData.quote
        });
      }
    }

    // Sort by name
    usdPairs.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`✅ Fetched ${usdPairs.length} trading pairs from Kraken`);
    return usdPairs;

  } catch (error) {
    console.error('Error fetching Kraken pairs:', error.message);
    // Fallback to our hardcoded list
    return getSupportedSymbolsWithInfo();
  }
}

/**
 * Get dFlow prediction market data for a symbol
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @returns {Promise<Object>} Prediction market data
 */
export async function getDflowPredictionMarkets(symbol) {
  try {
    // Dynamic import to avoid circular dependencies
    const dflow = await import('./dflow.js');
    return await dflow.getPredictionMarkets(symbol);
  } catch (error) {
    console.error(`[MarketData] Error fetching dFlow data for ${symbol}:`, error.message);
    return {
      symbol,
      error: error.message,
      events: [],
      markets: []
    };
  }
}

export default {
  getCandles,
  getCandlesWithProvenance,
  getMultiTimeframeData,
  multiTimeframeProvenance,
  getTickerPrice,
  isSymbolSupported,
  getSupportedSymbols,
  getSupportedSymbolsWithInfo,
  getAllKrakenPairs,
  getDflowPredictionMarkets,
  clearCandleCache
};

