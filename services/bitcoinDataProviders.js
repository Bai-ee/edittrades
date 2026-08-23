/**
 * Bitcoin Economic Data Providers
 * -------------------------------
 * All external I/O for the Bitcoin Economic Value feature lives here, so no
 * component above this layer talks to a third-party API directly.
 *
 * Sources, in order of preference:
 *
 *  1. Coin Metrics Community API  (https://community-api.coinmetrics.io/v4)
 *     Free, no key, authoritative, full history back to 2010. Supplies price,
 *     realized cap, supply, hashrate, issuance and difficulty.
 *
 *  2. Bitfinex public candles      (https://api-pub.bitfinex.com/v2)
 *     Price-history fallback with daily BTC/USD back to 2013. Used only when
 *     Coin Metrics is unavailable, and only for price: it cannot supply
 *     on-chain data.
 *
 *  3. services/marketData.js       (Kraken -> CoinGecko)
 *     Already the repo's spot-price source. Used for the live BTC price so the
 *     headline number is not a stale daily close.
 *
 * Short-Term / Long-Term Holder realized price are intentionally NOT sourced.
 * No free provider publishes genuine age-banded realized cap, and the
 * methodology forbids approximating them with a moving average. They are
 * reported as unavailable so the UI can disable the overlays honestly.
 *
 * Caching: these are slow-moving daily metrics. The historical series is
 * cached for hours, spot price for a minute, and a stale cache is preferred
 * over an error whenever a provider goes down.
 */

import axios from 'axios';
import * as marketData from './marketData.js';

/**
 * Base URLs are overridable so the stack can be pointed at a paid Coin Metrics
 * tier, an internal caching proxy, or a fixture server under test, without
 * touching this module.
 */
const COINMETRICS_BASE =
  process.env.COINMETRICS_API_BASE || 'https://community-api.coinmetrics.io/v4';
const BITFINEX_BASE =
  process.env.BITFINEX_API_BASE || 'https://api-pub.bitfinex.com/v2';

/**
 * Optional Coin Metrics API key. The community tier needs none; supplying one
 * unlocks the paid tier's metrics and rate limits through the same code path.
 */
const COINMETRICS_API_KEY = process.env.COINMETRICS_API_KEY || null;

/** Bitcoin's genesis-era start; Coin Metrics carries data from here. */
const HISTORY_START = '2010-07-18';

export const CACHE_TTL = {
  /** On-chain metrics publish once per day. */
  history: 6 * 60 * 60 * 1000,
  /** Spot price drives the headline number. */
  spot: 60 * 1000
};

/**
 * Metrics requested from Coin Metrics.
 * `core` is the minimum needed for the composite; `extended` adds context.
 * If the extended request fails (a renamed or ungranted metric would 400 the
 * whole batch) we retry with `core` rather than losing the feature entirely.
 */
const COINMETRICS_METRICS = {
  // CapMVRVCur and CapMrktCurUSD are requested alongside CapRealUSD on purpose.
  // Coin Metrics' published community dataset carries MVRV and market cap but
  // NOT realized cap, so a tier that withholds CapRealUSD would otherwise cost
  // us the heaviest-weighted anchor. Realized cap is recoverable exactly from
  // the other two (see deriveRealizedCap), so the core set can survive either
  // shape.
  core: ['PriceUSD', 'SplyCur', 'HashRate', 'IssTotNtv', 'CapMVRVCur', 'CapMrktCurUSD'],
  // IssTotUSD gives Puell an exact issuance value rather than the
  // issuance x price reconstruction; CapRealUSD is the direct measurement,
  // preferred over the derivation when the tier provides it.
  extended: [
    'PriceUSD',
    'SplyCur',
    'HashRate',
    'IssTotNtv',
    'CapMVRVCur',
    'CapMrktCurUSD',
    'CapRealUSD',
    'IssTotUSD'
  ]
};

/* ========================================================================
 * CACHE
 * ===================================================================== */

const cache = new Map();

function readCache(key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ttl) return null;
  return entry;
}

/**
 * Maximum age at which a stale cache entry is still worth serving.
 *
 * readStaleCache had no bound at all, so after a long provider outage the API
 * would keep serving an arbitrarily old series with only a `stale` flag to say
 * so. Past two days a valuation built on that history is not a degraded
 * reading of the present, it is a reading of a different market.
 */
const MAX_STALE_AGE_MS = 48 * 60 * 60 * 1000;

function readStaleCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > MAX_STALE_AGE_MS) {
    console.warn(
      `[BitcoinData] Cache entry for ${key} is older than ${MAX_STALE_AGE_MS / 3600000}h; refusing to serve it.`
    );
    return null;
  }
  return entry;
}

function writeCache(key, value) {
  cache.set(key, { value, storedAt: Date.now() });
  return value;
}

/** Exposed for tests and for the validation script. */
export function clearCache() {
  cache.clear();
}

/* ========================================================================
 * COIN METRICS
 * ===================================================================== */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fetch a daily asset-metrics series from the Coin Metrics community API.
 * Follows `next_page_url` until exhausted, with a hard page cap so a provider
 * bug can never spin this forever.
 */
async function fetchCoinMetrics(metrics, { startTime = HISTORY_START, timeout = 25000 } = {}) {
  const rows = [];
  let url = `${COINMETRICS_BASE}/timeseries/asset-metrics`;
  let params = {
    assets: 'btc',
    metrics: metrics.join(','),
    frequency: '1d',
    start_time: startTime,
    page_size: 10000
  };
  if (COINMETRICS_API_KEY) params.api_key = COINMETRICS_API_KEY;

  const MAX_PAGES = 12;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await axios.get(url, { params, timeout });
    const body = response.data;

    if (!body || !Array.isArray(body.data)) {
      throw new Error('Coin Metrics returned an unexpected payload shape');
    }
    rows.push(...body.data);

    if (!body.next_page_url) break;
    // next_page_url is fully qualified and already carries every parameter.
    url = body.next_page_url;
    params = undefined;
  }

  return rows;
}

/**
 * Normalise Coin Metrics rows into the shape the calculation module expects.
 *
 * Units:
 *  - HashRate is reported in terahashes per second, which is exactly what
 *    estimateMinerProductionCost() expects. No conversion is applied.
 *  - IssTotNtv is native units (BTC) issued that day.
 */
/**
 * Realized cap, direct if published, otherwise derived.
 *
 * MVRV is *defined* as market cap / realized cap, so
 *
 *     realizedCap = CapMrktCurUSD / CapMVRVCur
 *
 * is exact algebra rather than an approximation — the same identity the UI
 * relies on when it reports MVRV as `price / realizedPrice`. The direct
 * measurement is always preferred; this only fills in when a tier does not
 * publish CapRealUSD.
 *
 * @returns {{ value: number, derived: boolean }|{ value: null, derived: false }}
 */
function deriveRealizedCap(row) {
  const direct = toNumber(row.CapRealUSD);
  if (direct !== null && direct > 0) return { value: direct, derived: false };

  const marketCap = toNumber(row.CapMrktCurUSD);
  const mvrv = toNumber(row.CapMVRVCur);
  if (marketCap !== null && marketCap > 0 && mvrv !== null && mvrv > 0) {
    return { value: marketCap / mvrv, derived: true };
  }
  return { value: null, derived: false };
}

function normalizeCoinMetricsRows(rows) {
  const out = [];
  let derivedCount = 0;
  let nullCount = 0;

  for (const row of rows) {
    if (!row || typeof row.time !== 'string') continue;
    const date = row.time.slice(0, 10);
    const realized = deriveRealizedCap(row);
    if (realized.derived) derivedCount++;
    else if (realized.value === null) nullCount++;

    out.push({
      date,
      price: toNumber(row.PriceUSD),
      realizedCap: realized.value,
      supply: toNumber(row.SplyCur),
      hashRate: toNumber(row.HashRate),
      issuanceNtv: toNumber(row.IssTotNtv),
      issuanceUsd: toNumber(row.IssTotUSD)
    });
  }

  return { rows: out, realizedCapDerivedRows: derivedCount, realizedCapNullRows: nullCount };
}

/* ========================================================================
 * BITFINEX (price fallback only)
 * ===================================================================== */

/**
 * Daily BTC/USD closes from Bitfinex. History reaches back to 2013.
 * Used only when Coin Metrics is unreachable: it yields a 200-week moving
 * average, but no on-chain anchors.
 */
async function fetchBitfinexDailyCloses({ timeout = 20000 } = {}) {
  const response = await axios.get(`${BITFINEX_BASE}/candles/trade:1D:tBTCUSD/hist`, {
    params: { limit: 10000, sort: 1 },
    timeout
  });

  if (!Array.isArray(response.data)) {
    throw new Error('Bitfinex returned an unexpected payload shape');
  }

  // Bitfinex candle layout: [ MTS, OPEN, CLOSE, HIGH, LOW, VOLUME ]
  return response.data
    .filter((candle) => Array.isArray(candle) && candle.length >= 3)
    .map((candle) => ({
      date: new Date(candle[0]).toISOString().slice(0, 10),
      price: toNumber(candle[2])
    }))
    .filter((row) => row.price !== null);
}

/* ========================================================================
 * SPOT PRICE
 * ===================================================================== */

/**
 * Live BTC spot price via the repo's existing market-data service
 * (Kraken, falling back to CoinGecko). Short cache; a failure is not fatal
 * because the last daily close can stand in.
 */
export async function getBitcoinSpotPrice() {
  const key = 'spot:BTCUSDT';
  const cached = readCache(key, CACHE_TTL.spot);
  if (cached) return { ...cached.value, cached: true };

  try {
    const ticker = await marketData.getTickerPrice('BTCUSDT');
    const price = toNumber(ticker?.price);
    if (price === null || price <= 0) throw new Error('Ticker returned no usable price');

    return {
      ...writeCache(key, {
        price,
        change24h: toNumber(ticker.priceChangePercent),
        fetchedAt: new Date().toISOString(),
        source: 'marketData (kraken/coingecko)'
      }),
      cached: false
    };
  } catch (error) {
    const stale = readStaleCache(key);
    if (stale) {
      console.warn('[BitcoinData] Spot price failed, serving stale cache:', error.message);
      return { ...stale.value, cached: true, stale: true };
    }
    console.warn('[BitcoinData] Spot price unavailable:', error.message);
    return { price: null, error: error.message, source: 'unavailable' };
  }
}

/* ========================================================================
 * PUBLIC ENTRY POINT
 * ===================================================================== */

/**
 * Fetch the full daily economic series for Bitcoin.
 *
 * Never throws for a partial outage: it degrades to whatever it could reach
 * and reports the state of every source, so the UI can say what is missing
 * instead of showing a fabricated line.
 *
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh] - bypass the cache
 * @returns {Promise<{ rows: Array, sources: Object, fetchedAt: string, cached: boolean }>}
 */
export async function getBitcoinEconomicSeries(options = {}) {
  const key = 'history:btc';

  if (!options.forceRefresh) {
    const cached = readCache(key, CACHE_TTL.history);
    if (cached) return { ...cached.value, cached: true };
  }

  const sources = {
    coinmetrics: { status: 'pending', metrics: [] },
    bitfinex: { status: 'not-attempted' },
    sthRealizedPrice: {
      status: 'unavailable',
      reason: 'No free provider publishes genuine short-term holder realized price. Not approximated.'
    },
    lthRealizedPrice: {
      status: 'unavailable',
      reason: 'No free provider publishes genuine long-term holder realized price. Not approximated.'
    }
  };

  let rows = [];

  // --- Primary: Coin Metrics -------------------------------------------
  try {
    let raw;
    let metricsUsed = COINMETRICS_METRICS.extended;
    try {
      raw = await fetchCoinMetrics(COINMETRICS_METRICS.extended);
    } catch (extendedError) {
      console.warn(
        '[BitcoinData] Coin Metrics extended metrics failed, retrying core set:',
        extendedError.message
      );
      metricsUsed = COINMETRICS_METRICS.core;
      raw = await fetchCoinMetrics(COINMETRICS_METRICS.core);
    }

    const normalized = normalizeCoinMetricsRows(raw);
    rows = normalized.rows;
    if (rows.length === 0) throw new Error('Coin Metrics returned zero rows');

    sources.coinmetrics = {
      status: 'ok',
      metrics: metricsUsed,
      rows: rows.length,
      firstDate: rows[0].date,
      lastDate: rows[rows.length - 1].date,
      url: COINMETRICS_BASE,
      // Surfaced so the page can say whether realized cap was measured
      // directly or recovered from MVRV x market cap.
      realizedCapDerivedRows: normalized.realizedCapDerivedRows,
      realizedCapNullRows: normalized.realizedCapNullRows,
      // The unavailable case must be reported as unavailable.
      //
      // This label used to read `derivedRows === 0 ? 'CapRealUSD (direct)'`,
      // and deriveRealizedCap returns `derived: false` when BOTH CapRealUSD
      // and CapMVRVCur are missing. So in the exact scenario this field exists
      // to detect — the realized-cap anchor dying entirely — it affirmatively
      // reported "CapRealUSD (direct)" while realizedCap was null on every row
      // and the composite had silently dropped to two anchors. The tripwire
      // inverted under the failure it was meant to catch.
      realizedCapSource:
        normalized.realizedCapNullRows === rows.length
          ? 'UNAVAILABLE — neither CapRealUSD nor CapMVRVCur was served'
          : normalized.realizedCapDerivedRows === 0
            ? 'CapRealUSD (direct)'
            : normalized.realizedCapDerivedRows + normalized.realizedCapNullRows === rows.length
              ? 'derived from CapMrktCurUSD / CapMVRVCur'
              : 'mixed: CapRealUSD where published, otherwise derived from MVRV'
    };
  } catch (error) {
    console.error('[BitcoinData] Coin Metrics unavailable:', error.message);
    sources.coinmetrics = { status: 'failed', error: error.message, url: COINMETRICS_BASE };
  }

  // --- Fallback: Bitfinex price history --------------------------------
  if (sources.coinmetrics.status !== 'ok') {
    try {
      const priceRows = await fetchBitfinexDailyCloses();
      if (priceRows.length === 0) throw new Error('Bitfinex returned zero candles');

      rows = priceRows;
      sources.bitfinex = {
        status: 'ok',
        rows: priceRows.length,
        firstDate: priceRows[0].date,
        lastDate: priceRows[priceRows.length - 1].date,
        note: 'Price only. On-chain anchors unavailable without Coin Metrics.',
        url: BITFINEX_BASE
      };
    } catch (error) {
      console.error('[BitcoinData] Bitfinex fallback unavailable:', error.message);
      sources.bitfinex = { status: 'failed', error: error.message, url: BITFINEX_BASE };
    }
  }

  // --- Nothing reachable: serve stale rather than nothing ---------------
  if (rows.length === 0) {
    const stale = readStaleCache(key);
    if (stale) {
      console.warn('[BitcoinData] All providers failed, serving stale history cache');
      return { ...stale.value, cached: true, stale: true, sources };
    }
    return { rows: [], sources, fetchedAt: new Date().toISOString(), cached: false };
  }

  return {
    ...writeCache(key, {
      rows,
      sources,
      fetchedAt: new Date().toISOString()
    }),
    cached: false
  };
}

export default {
  getBitcoinEconomicSeries,
  getBitcoinSpotPrice,
  clearCache,
  CACHE_TTL
};
