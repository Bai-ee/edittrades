/**
 * Advanced Indicators Module
 * 
 * Provides VWAP, ATR, Bollinger Bands, and MA stack analysis
 */

/**
 * Calculate VWAP (Volume Weighted Average Price)
 * @param {Array} candles - OHLCV array
 * @param {Number} currentPrice - Current price
 * @param {Number} lookback - Number of candles to use (default: all candles in session/window)
 * @returns {Object} VWAP analysis
 */
export function calculateVWAP(candles, currentPrice, lookback = null) {
  if (!Array.isArray(candles) || candles.length === 0 || !currentPrice) {
    return null;
  }

  // Use lookback or all candles
  const windowCandles = lookback ? candles.slice(-lookback) : candles;
  
  // Check if volume data exists
  const hasVolume = windowCandles.every(c => c.volume !== undefined && c.volume !== null);
  if (!hasVolume) {
    return null; // No volume data available
  }

  // Calculate VWAP: sum(typical_price * volume) / sum(volume)
  let sumPriceVolume = 0;
  let sumVolume = 0;

  for (const candle of windowCandles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume;
    
    sumPriceVolume += typicalPrice * volume;
    sumVolume += volume;
  }

  if (sumVolume === 0) {
    return null;
  }

  const vwapValue = sumPriceVolume / sumVolume;
  const distancePct = ((currentPrice - vwapValue) / currentPrice) * 100;
  const above = currentPrice > vwapValue;
  const below = currentPrice < vwapValue;
  const atVwap = Math.abs(distancePct) < 0.2; // Within 0.2%
  const reversionZone = Math.abs(distancePct) > 2.0; // More than 2% away

  return {
    value: parseFloat(vwapValue.toFixed(2)),
    distancePct: parseFloat(distancePct.toFixed(2)),
    above,
    below,
    bias: above ? 'long' : 'short',
    atVwap,
    reversionZone
  };
}

/**
 * Determine trapped positioning based on VWAP and trend
 * @param {Object} vwap - VWAP data
 * @param {String} trend - Current trend (UPTREND/DOWNTREND/FLAT)
 * @returns {Object} Trapped positioning
 */
export function determineVWAPPositioning(vwap, trend) {
  if (!vwap || !trend) {
    return {
      trappedLongsLikely: false,
      trappedShortsLikely: false
    };
  }

  const trappedLongsLikely = 
    vwap.below && 
    trend === 'DOWNTREND' && 
    vwap.distancePct < -0.5;

  const trappedShortsLikely = 
    vwap.above && 
    trend === 'UPTREND' && 
    vwap.distancePct > 0.5;

  return {
    trappedLongsLikely,
    trappedShortsLikely
  };
}

/**
 * Volatility regime boundaries, expressed as percentiles of a symbol's OWN
 * trailing ATR% distribution on the SAME timeframe.
 *
 * Why percentiles rather than absolute ATR% thresholds: an absolute cut such as
 * "ATR% > 2 means HIGH" is a BTC-daily-shaped constant. Applied to a mid-cap on
 * a 5m chart it is exceeded on essentially every bar, so the classifier
 * saturates and carries no information; applied to a large-cap on 5m it is
 * never reached. The same asset would also change regime purely by switching
 * timeframe, which is not a regime change. Ranking a symbol against its own
 * recent history is scale-free and timeframe-free by construction.
 *
 * The 30/70/90 split is the STARTING HYPOTHESIS from docs/VOLATILITY_REGIME_HANDOFF.md
 * §5 Step 1, NOT a validated optimum. It is deliberately exported so it can be
 * swept in a backtest rather than edited in place.
 */
export const VOLATILITY_REGIME_PERCENTILES = Object.freeze({
  LOW_BELOW: 30,
  HIGH_ABOVE: 70,
  EXTREME_ABOVE: 90
});

/**
 * Minimum number of ATR observations required before a percentile rank means
 * anything. Below this we report UNKNOWN rather than inventing a regime.
 *
 * 60 is chosen so a single observation moves the rank by at most ~1.7
 * percentile points, which keeps the LOW/NORMAL/HIGH boundaries from flipping
 * on one bar. Reporting UNKNOWN is deliberate: per the data-integrity rule, a
 * missing input must never be laundered into a usable neutral value.
 */
export const MIN_ATR_OBSERVATIONS_FOR_PERCENTILE = 60;

/**
 * Percentile rank of `value` within `sample`, using the midrank convention for
 * ties (counts strictly-below plus half of equal). Midrank matters here because
 * a quiet market produces genuinely repeated ATR values, and the naive
 * "fraction strictly below" would report 0 for a value that is merely typical.
 *
 * @param {Number} value
 * @param {Array<Number>} sample
 * @returns {Number} 0-100
 */
function percentileRank(value, sample) {
  let below = 0;
  let equal = 0;
  for (const v of sample) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + equal / 2) / sample.length) * 100;
}

/**
 * Calculate ATR (Average True Range) and classify the volatility regime by
 * percentile rank against the symbol's own trailing distribution.
 *
 * NOTE ON PRECISION: no value returned here is rounded. ATR feeds stop
 * placement and position sizing, where rounding to 2 decimals destroys
 * meaningful digits for low-priced assets (an ATR of 0.00042 became 0.00).
 * Rounding belongs in the presentation layer.
 *
 * @param {Array} candles - OHLCV array, oldest first
 * @param {Number} period - ATR period (default 14)
 * @param {Object} [options]
 * @param {String} [options.timeframe] - Timeframe label, echoed back for callers
 * @param {Number} [options.lookback] - Max trailing ATR observations to rank against
 * @returns {Object|null} { atr, atrPct, atrPercentile, volatilityState, timeframe, sampleSize }
 */
export function calculateATR(candles, period = 14, options = {}) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    return null;
  }

  const { timeframe = null, lookback = 500 } = options;

  // True Range for each candle after the first.
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trueRanges.push(tr);
  }

  // Wilder's smoothing, retaining the whole series rather than only its final
  // value — the series IS the distribution we rank against.
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;

  // atrPctSeries[i] pairs the smoothed ATR with the close of the candle it was
  // computed through, so every observation is a volatility-relative-to-price
  // reading taken on the same basis as the current one.
  const atrPctSeries = [];
  const closeAt = (trIndex) => candles[trIndex + 1].close;

  let firstClose = closeAt(period - 1);
  if (firstClose > 0) atrPctSeries.push((atr / firstClose) * 100);

  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
    const close = closeAt(i);
    if (close > 0) atrPctSeries.push((atr / close) * 100);
  }

  const currentPrice = candles[candles.length - 1].close;
  if (!(currentPrice > 0)) {
    return null;
  }
  const atrPct = (atr / currentPrice) * 100;

  // Rank the current reading against the trailing distribution, EXCLUDING the
  // current observation so a value cannot inflate its own percentile.
  const history = atrPctSeries.slice(0, -1).slice(-lookback);

  let atrPercentile = null;
  let volatilityState = 'UNKNOWN';

  if (history.length >= MIN_ATR_OBSERVATIONS_FOR_PERCENTILE) {
    atrPercentile = percentileRank(atrPct, history);

    if (atrPercentile >= VOLATILITY_REGIME_PERCENTILES.EXTREME_ABOVE) {
      volatilityState = 'EXTREME';
    } else if (atrPercentile >= VOLATILITY_REGIME_PERCENTILES.HIGH_ABOVE) {
      volatilityState = 'HIGH';
    } else if (atrPercentile < VOLATILITY_REGIME_PERCENTILES.LOW_BELOW) {
      volatilityState = 'LOW';
    } else {
      volatilityState = 'NORMAL';
    }
  }

  return {
    atr,
    atrPct,
    atrPercentile,
    volatilityState,
    timeframe,
    sampleSize: history.length
  };
}

/**
 * Calculate Bollinger Bands
 * @param {Array} candles - OHLCV array
 * @param {Number} period - BB period (default 20)
 * @param {Number} stdDev - Standard deviation multiplier (default 2)
 * @returns {Object} Bollinger Bands analysis
 */
export function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (!Array.isArray(candles) || candles.length < period) {
    return null;
  }

  const closes = candles.map(c => c.close);
  const recentCloses = closes.slice(-period);
  
  // Calculate SMA (middle band)
  const sum = recentCloses.reduce((acc, val) => acc + val, 0);
  const mid = sum / period;
  
  // Calculate standard deviation
  const squaredDiffs = recentCloses.map(close => Math.pow(close - mid, 2));
  const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / period;
  const std = Math.sqrt(variance);
  
  // Calculate bands
  const upper = mid + (stdDev * std);
  const lower = mid - (stdDev * std);
  
  const currentPrice = candles[candles.length - 1].close;
  
  // Calculate bandwidth (volatility measure)
  const bandWidthPct = ((upper - lower) / mid) * 100;
  
  // Detect squeeze (low volatility)
  const squeeze = bandWidthPct < 2.0; // Less than 2% bandwidth = squeeze
  
  // Calculate price position within bands (0 = lower band, 50 = mid, 100 = upper)
  let pricePosPct = 50;
  if (upper !== lower) {
    pricePosPct = ((currentPrice - lower) / (upper - lower)) * 100;
    pricePosPct = Math.max(0, Math.min(100, pricePosPct)); // Clamp to 0-100
  }

  return {
    mid: parseFloat(mid.toFixed(2)),
    upper: parseFloat(upper.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    bandWidthPct: parseFloat(bandWidthPct.toFixed(2)),
    squeeze,
    pricePosPct: parseFloat(pricePosPct.toFixed(2))
  };
}

/**
 * Calculate EMA
 * @param {Array} values - Array of values
 * @param {Number} period - EMA period
 * @returns {Number} EMA value
 */
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  
  // Start with SMA
  let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  
  // Apply EMA formula for remaining values
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Calculate moving average stack
 * @param {Array} candles - OHLCV array
 * @param {Object} existingEmas - Pre-calculated EMAs (ema21, ema200)
 * @returns {Object} MA stack analysis
 */
export function calculateMAStack(candles, existingEmas = {}) {
  if (!Array.isArray(candles) || candles.length < 200) {
    return null;
  }

  const closes = candles.map(c => c.close);
  
  // Calculate EMA50 if not provided
  const ema21 = existingEmas.ema21 || null;
  const ema50 = calculateEMA(closes, 50);
  const ema200 = existingEmas.ema200 || null;

  if (!ema21 || !ema50 || !ema200) {
    return {
      ema21: ema21 ? parseFloat(ema21.toFixed(2)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(2)) : null,
      ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
      bullStack: false,
      bearStack: false,
      flatStack: false
    };
  }

  // Determine stack alignment
  const bullStack = ema21 > ema50 && ema50 > ema200;
  const bearStack = ema21 < ema50 && ema50 < ema200;
  const flatStack = !bullStack && !bearStack;

  return {
    ema21: parseFloat(ema21.toFixed(2)),
    ema50: parseFloat(ema50.toFixed(2)),
    ema200: parseFloat(ema200.toFixed(2)),
    bullStack,
    bearStack,
    flatStack
  };
}

/**
 * Calculate all advanced indicators for a timeframe
 * @param {Array} candles - OHLCV array
 * @param {Number} currentPrice - Current price
 * @param {String} trend - Current trend
 * @param {Object} existingEmas - Pre-calculated EMAs
 * @param {String} timeframe - Timeframe string (e.g., '4h', '1h')
 * @returns {Object} All advanced indicators
 */
export function calculateAllAdvanced(candles, currentPrice, trend, existingEmas = {}, timeframe = null) {
  const result = {};

  // VWAP (for intraday timeframes: 5m, 15m, 1h)
  const shouldCalculateVWAP = ['5m', '15m', '1h'].includes(timeframe);
  if (shouldCalculateVWAP) {
    const vwap = calculateVWAP(candles, currentPrice);
    if (vwap) {
      result.vwap = vwap;
      result.vwapPositioning = determineVWAPPositioning(vwap, trend);
    }
  }

  // ATR (all timeframes). The timeframe is threaded through because a
  // volatility regime is only meaningful relative to the timeframe it was
  // measured on — consumers must not compare a 5m percentile with a 4h one.
  const volatility = calculateATR(candles, 14, { timeframe });
  if (volatility) {
    result.volatility = volatility;
  }

  // Bollinger Bands (for 4h, 1h, 15m)
  const shouldCalculateBB = ['4h', '1h', '15m'].includes(timeframe);
  if (shouldCalculateBB) {
    const bollinger = calculateBollingerBands(candles);
    if (bollinger) {
      result.bollinger = bollinger;
    }
  }

  // MA Stack (for 4h and 1h only - most relevant for trend structure)
  const shouldCalculateMAStack = ['4h', '1h'].includes(timeframe);
  if (shouldCalculateMAStack) {
    const maStack = calculateMAStack(candles, existingEmas);
    if (maStack) {
      result.movingAverages = {
        ema21: maStack.ema21,
        ema50: maStack.ema50,
        ema200: maStack.ema200
      };
      result.maStructure = {
        bullStack: maStack.bullStack,
        bearStack: maStack.bearStack,
        flatStack: maStack.flatStack
      };
    }
  }

  return result;
}

