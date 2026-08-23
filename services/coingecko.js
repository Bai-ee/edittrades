/**
 * CoinGecko API Service (Alternative to Binance)
 * Free API with global access, no restrictions
 */

import axios from 'axios';

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Map common symbols to CoinGecko IDs
const SYMBOL_MAP = {
  'BTCUSDT': 'bitcoin',
  'ETHUSDT': 'ethereum',
  'SOLUSDT': 'solana',
  'BNBUSDT': 'binancecoin',
  'ADAUSDT': 'cardano',
  'DOGEUSDT': 'dogecoin',
  'XRPUSDT': 'ripple',
  'DOTUSDT': 'polkadot',
  'MATICUSDT': 'matic-network',
  'LINKUSDT': 'chainlink'
};

/**
 * CoinGecko's /ohlc granularity is chosen by the API from the `days` window —
 * the caller cannot request a timeframe. This table records what each window
 * actually returns, so an interval the API cannot serve is refused instead of
 * being answered with a differently-sized candle wearing the requested label.
 *
 * The previous map claimed 1m, 3m, 5m and 15m were all available at days=1
 * (which returns 30-minute candles) and that 1h came from days=7 and 4h from
 * days=30 (both return 4-hour candles). Every one of those requests got a
 * candle of the wrong duration, labelled with the interval the caller asked
 * for. A "5m EMA21" computed on that series was a 21-period EMA of 30-minute
 * bars — a number roughly six times slower than the one the UI claimed.
 */
const COINGECKO_OHLC_WINDOWS = {
  '30m': { days: 1, granularity: '30m' },
  '4h': { days: 30, granularity: '4h' }
};

/**
 * Get coin ID from symbol, or throw.
 * The old `|| symbol.toLowerCase().replace('usdt','')` guess produced a plausible
 * id for anything ('foousdt' -> 'foo') and let CoinGecko decide what that meant.
 */
function getCoinId(symbol) {
  const id = SYMBOL_MAP[symbol.toUpperCase()];
  if (!id) throw new Error(`CoinGecko: unsupported symbol ${symbol}`);
  return id;
}

/**
 * Fetch OHLC candles from CoinGecko.
 * Only intervals CoinGecko genuinely serves are accepted; anything else throws.
 */
export async function fetchKlines(symbol, interval, limit = 500) {
  const coinId = getCoinId(symbol);
  const window = COINGECKO_OHLC_WINDOWS[interval];
  if (!window) {
    throw new Error(
      `CoinGecko cannot serve ${interval} candles. Supported: ${Object.keys(COINGECKO_OHLC_WINDOWS).join(', ')}.`
    );
  }

  const response = await axios.get(`${COINGECKO_API_BASE}/coins/${coinId}/ohlc`, {
    params: { vs_currency: 'usd', days: window.days },
    timeout: 10000
  });

  if (!Array.isArray(response.data)) {
    throw new Error('CoinGecko returned an unexpected OHLC payload shape');
  }

  // CoinGecko returns [timestamp, open, high, low, close] — no volume field.
  return response.data.slice(-limit).map((candle) => ({
    timestamp: candle[0],
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    // null, not 0. Zero is a claim that no trading occurred; null says the
    // provider does not report it. Volume analysis treats 0 as a measurement.
    volume: null,
    closeTime: candle[0] + 30 * 60 * 1000 * (window.granularity === '4h' ? 8 : 1)
  }));
}

/**
 * Fetch current price and 24h stats
 */
export async function fetchTickerPrice(symbol) {
  try {
    const coinId = getCoinId(symbol);
    
    const response = await axios.get(`${COINGECKO_API_BASE}/simple/price`, {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true
      },
      timeout: 5000
    });

    const data = response.data[coinId];
    
    if (!data) {
      throw new Error(`Symbol ${symbol} not found on CoinGecko`);
    }

    const price = Number(data.usd);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`CoinGecko returned no usable price for ${symbol}`);
    }

    const changePct = Number.isFinite(Number(data.usd_24h_change))
      ? Number(data.usd_24h_change)
      : null;

    return {
      symbol: symbol.toUpperCase(),
      price,
      // priceChange is an absolute currency amount everywhere else in this
      // repo; it used to be assigned the *percentage*, so the two fields were
      // identical and one of them was wrong by roughly the price of the asset.
      priceChange: changePct === null ? null : price - price / (1 + changePct / 100),
      priceChangePercent: changePct,
      // The simple/price endpoint does not publish a 24h high or low. These
      // were `price * 1.02` and `price * 0.98` — a fixed, fabricated 4% band
      // returned in the same field names as Kraken's measured values.
      high24h: null,
      low24h: null,
      volume24h: Number.isFinite(Number(data.usd_24h_vol)) ? Number(data.usd_24h_vol) : null
    };
  } catch (error) {
    console.error(`Error fetching ticker from CoinGecko:`, error.message);
    throw new Error(`Failed to fetch ticker: ${error.message}`);
  }
}

/**
 * Multi-timeframe from CoinGecko is not supported, and cannot be made honest.
 *
 * This function used to fetch ONE 30-day daily series and return that same
 * array for every requested interval, after synthesising each bar's high and
 * low as ±1% of the close and setting open === close. So: `4h`, `1h`, `15m`
 * and `5m` were the identical ~30-element daily array; every candle was a doji
 * by construction; and every wick was invented. An indicator computed on the
 * "5m" series was operating on daily data with fabricated ranges.
 *
 * There is no version of this that free-tier CoinGecko can actually serve, so
 * it throws rather than pretending. Callers should fall through to a provider
 * that publishes real intraday OHLCV.
 */
export async function fetchMultiTimeframe(symbol, intervals = []) {
  throw new Error(
    `CoinGecko cannot serve multi-timeframe OHLCV (requested: ${intervals.join(', ') || 'none'}). ` +
      'Its free tier returns a single daily series with no volume and no intraday granularity. ' +
      'Use services/marketData.js (Kraken -> Bitfinex) for candle data.'
  );
}

export default {
  fetchKlines,
  fetchTickerPrice,
  fetchMultiTimeframe
};






