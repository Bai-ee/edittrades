/**
 * Advanced Chart Analysis Module
 * 
 * Calculates market structure, volume profile, liquidity zones, fair value gaps, and divergences
 */

/**
 * Calculate market structure (BOS/CHOCH, swing points, current structure)
 * @param {Array} candles - OHLCV array
 * @param {Object} swingPoints - Existing swing points { swingHigh, swingLow }
 * @param {String} trend - Current trend (UPTREND/DOWNTREND/FLAT)
 * @returns {Object} Market structure analysis
 */
export function calculateMarketStructure(candles, swingPoints, trend) {
  // Always return structured object, never null
  const defaultStructure = {
    currentStructure: 'unknown',
    lastSwings: [],
    lastBos: {
      type: 'none',
      direction: 'none',
      fromSwing: null,
      toSwing: null,
      price: null,
      timestamp: null
    },
    lastChoch: {
      type: 'none',
      direction: 'none',
      fromSwing: null,
      toSwing: null,
      price: null,
      timestamp: null
    }
  };
  
  if (!candles || candles.length < 5) {
    return defaultStructure; // Return empty structure instead of null
  }

  // Detect swing points (HH, HL, LH, LL)
  const swings = [];
  const lookback = Math.min(50, candles.length);
  const recentCandles = candles.slice(-lookback);
  
  // Simple swing detection: find local highs and lows
  // Reduced minimum lookback for shallow pivots (allow 1 candle on each side)
  const minLookback = Math.min(2, Math.floor(recentCandles.length / 3));
  for (let i = minLookback; i < recentCandles.length - minLookback; i++) {
    const candle = recentCandles[i];
    const prev2 = recentCandles[i - 2];
    const next2 = recentCandles[i + 2];
    
    // Swing high: higher than 2 candles before and after
    if (candle.high > prev2.high && candle.high > next2.high) {
      swings.push({
        type: 'HH', // Will be refined to HH/HL/LH/LL
        price: candle.high,
        timestamp: candle.timestamp || candle.closeTime || Date.now()
      });
    }
    
    // Swing low: lower than 2 candles before and after
    if (candle.low < prev2.low && candle.low < next2.low) {
      swings.push({
        type: 'LL', // Will be refined to HH/HL/LH/LL
        price: candle.low,
        timestamp: candle.timestamp || candle.closeTime || Date.now()
      });
    }
  }
  
  // Refine swing types (HH, HL, LH, LL)
  const refinedSwings = [];
  for (let i = 0; i < swings.length; i++) {
    const swing = swings[i];
    if (i === 0) {
      refinedSwings.push(swing);
      continue;
    }
    
    const prevSwing = refinedSwings[refinedSwings.length - 1];
    if (swing.type === 'HH' && prevSwing.type === 'LL') {
      // Higher high after lower low
      swing.type = 'HH';
    } else if (swing.type === 'HH' && prevSwing.type === 'HH') {
      // Higher high after higher high
      swing.type = 'HH';
    } else if (swing.type === 'LL' && prevSwing.type === 'HH') {
      // Lower low after higher high
      swing.type = 'LL';
    } else if (swing.type === 'LL' && prevSwing.type === 'LL') {
      // Lower low after lower low
      swing.type = 'LL';
    }
    
    // Check for HL (higher low) or LH (lower high)
    if (swing.type === 'LL' && prevSwing.type === 'HH' && swing.price > prevSwing.price) {
      swing.type = 'HL';
    } else if (swing.type === 'HH' && prevSwing.type === 'LL' && swing.price < prevSwing.price) {
      swing.type = 'LH';
    }
    
    refinedSwings.push(swing);
  }
  
  // Get last 4 swings
  const lastSwings = refinedSwings.slice(-4);
  
  // Determine current structure from trend
  let currentStructure = 'flat';
  if (trend === 'UPTREND' || trend === 'uptrend') {
    currentStructure = 'uptrend';
  } else if (trend === 'DOWNTREND' || trend === 'downtrend') {
    currentStructure = 'downtrend';
  }
  
  // Find last BOS (Break of Structure) - when price breaks previous swing
  let lastBos = null;
  if (lastSwings.length >= 2) {
    const lastSwing = lastSwings[lastSwings.length - 1];
    const prevSwing = lastSwings[lastSwings.length - 2];
    
    if (lastSwing.type === 'HH' && prevSwing.type === 'HL') {
      lastBos = {
        type: 'BOS',
        direction: 'bullish',
        fromSwing: 'HL',
        toSwing: 'HH',
        price: lastSwing.price,
        timestamp: lastSwing.timestamp
      };
    } else if (lastSwing.type === 'LL' && prevSwing.type === 'LH') {
      lastBos = {
        type: 'BOS',
        direction: 'bearish',
        fromSwing: 'LH',
        toSwing: 'LL',
        price: lastSwing.price,
        timestamp: lastSwing.timestamp
      };
    }
  }
  
  // CHOCH (Change of Character) - similar to BOS
  let lastChoch = lastBos; // Simplified - can be refined later
  
  // Fallback: if no BOS/CHOCH detected, use "none" instead of null
  // Ensure lastBos and lastChoch are always structured objects
  const defaultBos = {
    type: 'none',
    direction: 'none',
    fromSwing: null,
    toSwing: null,
    price: null,
    timestamp: null
  };
  
  const defaultChoch = {
    type: 'none',
    direction: 'none',
    fromSwing: null,
    toSwing: null,
    price: null,
    timestamp: null
  };
  
  // Ensure lastBos is always a structured object (never null)
  const finalBos = lastBos || defaultBos;
  // Ensure all fields exist even if lastBos was found
  // If type is null, missing, or BOS without price, set to 'none'
  if (!finalBos.type || finalBos.type === null || (finalBos.type === 'BOS' && !finalBos.price)) {
    finalBos.type = 'none';
    finalBos.direction = 'none';
  }
  // Also ensure direction is 'none' if type is 'none'
  if (finalBos.type === 'none' && finalBos.direction !== 'none') {
    finalBos.direction = 'none';
  }
  
  // Ensure lastChoch is always a structured object (never null)
  const finalChoch = lastChoch || defaultChoch;
  // If type is null, missing, or CHOCH without price, set to 'none'
  if (!finalChoch.type || finalChoch.type === null || (finalChoch.type === 'CHOCH' && !finalChoch.price)) {
    finalChoch.type = 'none';
    finalChoch.direction = 'none';
  }
  // Also ensure direction is 'none' if type is 'none'
  if (finalChoch.type === 'none' && finalChoch.direction !== 'none') {
    finalChoch.direction = 'none';
  }
  
  return {
    currentStructure: currentStructure || 'unknown',
    lastSwings: lastSwings.map(s => ({
      type: s.type,
      price: s.price,
      timestamp: s.timestamp
    })),
    lastBos: finalBos,
    lastChoch: finalChoch
  };
}

/**
 * Calculate volume profile (HVN, LVN, value area)
 * @param {Array} candles - OHLCV array
 * @returns {Object} Volume profile analysis
 */
export function calculateVolumeProfile(candles) {
  // Always return structured object, never null
  const defaultProfile = {
    highVolumeNodes: [],
    lowVolumeNodes: [],
    valueAreaHigh: null,
    valueAreaLow: null
  };
  
  if (!candles || candles.length < 3) {
    return defaultProfile; // Return empty structure instead of null
  }

  // Check if volume data exists
  const hasVolume = candles.some(c => c.volume !== undefined && c.volume !== null && c.volume > 0);
  if (!hasVolume) {
    return defaultProfile; // Return empty structure instead of null
  }

  // Create price buckets (simplified - use price range divided into bins)
  const prices = candles.map(c => [c.high, c.low, c.close]).flat();
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;
  
  if (priceRange <= 0) {
    return defaultProfile; // Invalid price range
  }
  
  // Fix: Dynamic binning based on candle count (max 24 bins, min 3)
  // bins = Math.min(24, candles.length / 3) as requested
  // Ensure bins <= candleCount to prevent empty profiles
  const numBins = Math.min(24, Math.max(3, Math.floor(candles.length / 3)), candles.length);
  const binSize = priceRange / numBins;
  
  if (binSize <= 0 || !isFinite(binSize)) {
    return defaultProfile; // Invalid bin size
  }
  
  // Aggregate volume by price level
  const volumeByPrice = {};
  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const bin = Math.floor((typicalPrice - minPrice) / binSize);
    const binPrice = minPrice + (bin * binSize);
    const key = Math.round(binPrice);
    
    if (!volumeByPrice[key]) {
      volumeByPrice[key] = 0;
    }
    volumeByPrice[key] += candle.volume || 0;
  }
  
  // Find high volume nodes (HVN) and low volume nodes (LVN)
  const volumeEntries = Object.entries(volumeByPrice).map(([price, volume]) => ({
    price: parseFloat(price),
    volume: parseFloat(volume)
  }));
  
  // Sort by volume
  volumeEntries.sort((a, b) => b.volume - a.volume);
  
  // Top 3 are HVN, bottom 3 are LVN
  const highVolumeNodes = volumeEntries.slice(0, 3);
  const lowVolumeNodes = volumeEntries.slice(-3).reverse();
  
  // Value area (70% of volume) - FIX: Ensure valueAreaLow < valueAreaHigh
  const totalVolume = volumeEntries.reduce((sum, e) => sum + e.volume, 0);
  const valueAreaVolume = totalVolume * 0.7;
  let accumulatedVolume = 0;
  
  // Find value area by accumulating volume from highest volume nodes
  // Sort by volume (descending) to get the 70% value area
  const sortedByVolume = [...volumeEntries].sort((a, b) => b.volume - a.volume);
  const valueAreaPrices = [];
  
  for (const entry of sortedByVolume) {
    accumulatedVolume += entry.volume;
    valueAreaPrices.push(entry.price);
    if (accumulatedVolume >= valueAreaVolume) {
      break;
    }
  }
  
  // Ensure we have prices to work with
  if (valueAreaPrices.length === 0) {
    valueAreaPrices.push(maxPrice, minPrice);
  }
  
  // Calculate value area high and low from the accumulated prices
  const valueAreaHigh = Math.max(...valueAreaPrices);
  const valueAreaLow = Math.min(...valueAreaPrices);
  
  // Final validation: ensure low < high (swap if needed)
  const finalValueAreaHigh = Math.max(valueAreaHigh, valueAreaLow);
  const finalValueAreaLow = Math.min(valueAreaHigh, valueAreaLow);
  
  return {
    highVolumeNodes,
    lowVolumeNodes,
    valueAreaHigh: parseFloat(finalValueAreaHigh.toFixed(2)),
    valueAreaLow: parseFloat(finalValueAreaLow.toFixed(2))
  };
}

/**
 * Calculate liquidity zones (equal highs/lows)
 * @param {Array} candles - OHLCV array
 * @param {Number} tolerance - Price tolerance for equal levels (default: 0.5%)
 * @returns {Array} Liquidity zones
 */
export function calculateLiquidityZones(candles, tolerance = null) {
  // Always return an array, even if empty
  if (!candles || candles.length < 5) {
    return []; // Reduced minimum from 10 to 5 candles
  }
  
  // Dynamic tolerance based on timeframe (lower timeframes need looser tolerance)
  // Default: 0.5% for higher timeframes, 0.2% for lower timeframes
  const defaultTolerance = tolerance !== null ? tolerance : (candles.length < 20 ? 0.2 : 0.5);

  const zones = [];
  const lookback = Math.min(100, candles.length);
  const recentCandles = candles.slice(-lookback);
  
  // Find swing highs and lows
  const highs = [];
  const lows = [];
  
  // Reduced minimum lookback for shallow pivots
  const minLookback = Math.min(1, Math.floor(recentCandles.length / 4));
  for (let i = minLookback; i < recentCandles.length - minLookback; i++) {
    const candle = recentCandles[i];
    const prev2 = recentCandles[i - 2];
    const next2 = recentCandles[i + 2];
    
    if (candle.high > prev2.high && candle.high > next2.high) {
      highs.push({
        price: candle.high,
        index: i,
        timestamp: candle.timestamp || candle.closeTime
      });
    }
    
    if (candle.low < prev2.low && candle.low < next2.low) {
      lows.push({
        price: candle.low,
        index: i,
        timestamp: candle.timestamp || candle.closeTime
      });
    }
  }
  
  // Find equal highs
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i].price - highs[j].price);
      const avgPrice = (highs[i].price + highs[j].price) / 2;
      const percentDiff = (diff / avgPrice) * 100;
      
      if (percentDiff <= tolerance) {
        // Found equal highs
        const zonePrice = avgPrice;
        const existingZone = zones.find(z => 
          z.type === 'equal_highs' && 
          Math.abs(z.price - zonePrice) / zonePrice * 100 <= tolerance
        );
        
        if (existingZone) {
          existingZone.touches++;
          existingZone.strength = Math.min(100, existingZone.strength + 20);
        } else {
          zones.push({
            type: 'equal_highs',
            price: parseFloat(zonePrice.toFixed(2)),
            tolerance: parseFloat(percentDiff.toFixed(2)),
            strength: 40,
            side: 'sell',
            touches: 2
          });
        }
      }
    }
  }
  
  // Find equal lows
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i].price - lows[j].price);
      const avgPrice = (lows[i].price + lows[j].price) / 2;
      const percentDiff = (diff / avgPrice) * 100;
      
      if (percentDiff <= tolerance) {
        // Found equal lows
        const zonePrice = avgPrice;
        const existingZone = zones.find(z => 
          z.type === 'equal_lows' && 
          Math.abs(z.price - zonePrice) / zonePrice * 100 <= tolerance
        );
        
        if (existingZone) {
          existingZone.touches++;
          existingZone.strength = Math.min(100, existingZone.strength + 20);
        } else {
          zones.push({
            type: 'equal_lows',
            price: parseFloat(zonePrice.toFixed(2)),
            tolerance: parseFloat(percentDiff.toFixed(2)),
            strength: 40,
            side: 'buy',
            touches: 2
          });
        }
      }
    }
  }
  
  return zones;
}

/**
 * Calculate fair value gaps (FVGs)
 * @param {Array} candles - OHLCV array
 * @returns {Array} Fair value gaps
 */
export function calculateFairValueGaps(candles) {
  if (!candles || candles.length < 3) {
    return [];
  }

  const gaps = [];
  const lookback = Math.min(50, candles.length);
  const recentCandles = candles.slice(-lookback);
  
  // Check for FVGs: gap between candle 1 high/low and candle 3 high/low
  for (let i = 0; i < recentCandles.length - 2; i++) {
    const candle1 = recentCandles[i];
    const candle2 = recentCandles[i + 1];
    const candle3 = recentCandles[i + 2];
    
    // Bullish FVG: candle1 high < candle3 low (gap up)
    if (candle1.high < candle3.low) {
      const low = candle1.high;
      const high = candle3.low;
      
      // Check if filled (candle2 or later candles entered the gap)
      let filled = false;
      for (let j = i + 1; j < recentCandles.length; j++) {
        const checkCandle = recentCandles[j];
        if (checkCandle.low <= high && checkCandle.high >= low) {
          filled = true;
          break;
        }
      }
      
      gaps.push({
        direction: 'bullish',
        low: parseFloat(low.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        filled,
        candleIndex: i + 1
      });
    }
    
    // Bearish FVG: candle1 low > candle3 high (gap down)
    if (candle1.low > candle3.high) {
      const low = candle3.high;
      const high = candle1.low;
      
      // Check if filled
      let filled = false;
      for (let j = i + 1; j < recentCandles.length; j++) {
        const checkCandle = recentCandles[j];
        if (checkCandle.low <= high && checkCandle.high >= low) {
          filled = true;
          break;
        }
      }
      
      gaps.push({
        direction: 'bearish',
        low: parseFloat(low.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        filled,
        candleIndex: i + 1
      });
    }
  }
  
  return gaps;
}

/**
 * Calculate divergences (RSI/Stoch divergences)
 * @param {Array} candles - OHLCV array
 * @param {Object} indicators - Existing indicators (RSI, StochRSI)
 * @returns {Array} Divergences
 */
export function calculateDivergences(candles, indicators) {
  // Always return an array, even if empty
  if (!candles || candles.length < 5) {
    return []; // Reduced minimum from 20 to 5 candles
  }

  const divergences = [];
  
  // Get RSI and StochRSI history if available
  const rsiHistory = indicators?.rsi?.history || [];
  const stochHistory = indicators?.stochRSI?.history || [];
  const closes = candles.map(c => c.close);
  
  // Reduced minimum data points for divergence detection (from 10 to 5)
  const minLength = Math.min(closes.length, Math.max(rsiHistory.length, stochHistory.length));
  if (minLength < 5) {
    return []; // Not enough data, but return empty array (not null)
  }
  
  // Find price pivots (local highs and lows) - Allow shallow pivots
  const pricePivots = [];
  // Reduced pivot depth: allow 1 candle on each side instead of 2
  // Use minimum depth of 1, but allow deeper if we have enough candles
  const pivotDepth = Math.max(1, Math.min(2, Math.floor(closes.length / 5)));
  
  for (let i = pivotDepth; i < closes.length - pivotDepth; i++) {
    // Shallow pivot detection: only need 1 candle on each side
    const isHigh = closes[i] > closes[i-1] && closes[i] > closes[i+1];
    const isLow = closes[i] < closes[i-1] && closes[i] < closes[i+1];
    
    // If we have more candles, check deeper pivots for stronger signals
    if (pivotDepth >= 2 && i >= 2 && i < closes.length - 2) {
      const isHighDeep = isHigh && closes[i] > closes[i-2] && closes[i] > closes[i+2];
      const isLowDeep = isLow && closes[i] < closes[i-2] && closes[i] < closes[i+2];
      if (isHighDeep || isLowDeep) {
        pricePivots.push({
          index: i,
          price: closes[i],
          type: isHighDeep ? 'high' : 'low',
          timestamp: candles[i].timestamp || candles[i].closeTime
        });
      }
    } else if (isHigh || isLow) {
      // Shallow pivot (only 1 candle on each side) - accept these for more detection
      pricePivots.push({
        index: i,
        price: closes[i],
        type: isHigh ? 'high' : 'low',
        timestamp: candles[i].timestamp || candles[i].closeTime
      });
    }
  }
  
  // If we have very few pivots, try even shallower detection (0-depth for very short series)
  if (pricePivots.length < 2 && closes.length >= 3) {
    for (let i = 1; i < closes.length - 1; i++) {
      const isHigh = closes[i] > closes[i-1] && closes[i] > closes[i+1];
      const isLow = closes[i] < closes[i-1] && closes[i] < closes[i+1];
      if ((isHigh || isLow) && !pricePivots.find(p => p.index === i)) {
        pricePivots.push({
          index: i,
          price: closes[i],
          type: isHigh ? 'high' : 'low',
          timestamp: candles[i].timestamp || candles[i].closeTime
        });
      }
    }
  }
  
  // Check for RSI divergences - Reduced minimum requirements
  if (rsiHistory.length >= 5 && pricePivots.length >= 2) {
    // Get last 2 pivots
    const lastPivots = pricePivots.slice(-2);
    if (lastPivots.length === 2) {
      const [pivot1, pivot2] = lastPivots;
      const rsi1 = rsiHistory[pivot1.index];
      const rsi2 = rsiHistory[pivot2.index];
      
      if (rsi1 !== undefined && rsi2 !== undefined) {
        // Regular bearish divergence: price makes higher high, RSI makes lower high
        if (pivot1.type === 'high' && pivot2.type === 'high' && 
            pivot2.price > pivot1.price && rsi2 < rsi1) {
          divergences.push({
            oscillator: 'RSI',
            type: 'regular',
            side: 'bearish',
            pricePointIndex: pivot2.index,
            oscPointIndex: pivot2.index
          });
        }
        // Regular bullish divergence: price makes lower low, RSI makes higher low
        else if (pivot1.type === 'low' && pivot2.type === 'low' && 
                 pivot2.price < pivot1.price && rsi2 > rsi1) {
          divergences.push({
            oscillator: 'RSI',
            type: 'regular',
            side: 'bullish',
            pricePointIndex: pivot2.index,
            oscPointIndex: pivot2.index
          });
        }
      }
    }
  }
  
  // Check for StochRSI divergences - Reduced minimum requirements
  if (stochHistory.length >= 5 && pricePivots.length >= 2) {
    const lastPivots = pricePivots.slice(-2);
    if (lastPivots.length === 2) {
      const [pivot1, pivot2] = lastPivots;
      const stoch1 = stochHistory[pivot1.index]?.k || stochHistory[pivot1.index];
      const stoch2 = stochHistory[pivot2.index]?.k || stochHistory[pivot2.index];
      
      if (stoch1 !== undefined && stoch2 !== undefined) {
        // Regular bearish divergence
        if (pivot1.type === 'high' && pivot2.type === 'high' && 
            pivot2.price > pivot1.price && stoch2 < stoch1) {
          divergences.push({
            oscillator: 'StochRSI',
            type: 'regular',
            side: 'bearish',
            pricePointIndex: pivot2.index,
            oscPointIndex: pivot2.index
          });
        }
        // Regular bullish divergence
        else if (pivot1.type === 'low' && pivot2.type === 'low' && 
                 pivot2.price < pivot1.price && stoch2 > stoch1) {
          divergences.push({
            oscillator: 'StochRSI',
            type: 'regular',
            side: 'bullish',
            pricePointIndex: pivot2.index,
            oscPointIndex: pivot2.index
          });
        }
      }
    }
  }
  
  return divergences;
}

/**
 * Calculate all advanced chart analysis modules for a timeframe
 * @param {Array} candles - OHLCV array
 * @param {Object} indicators - Existing indicators
 * @param {Object} swingPoints - Existing swing points
 * @param {String} trend - Current trend
 * @returns {Object} All advanced chart analysis
 */
export function calculateAllAdvancedChartAnalysis(candles, indicators, swingPoints, trend) {
  const result = {};
  
  // Market Structure - Always include structured object (never null)
  try {
    const marketStructure = calculateMarketStructure(candles, swingPoints, trend);
    result.marketStructure = marketStructure || {
      currentStructure: 'unknown',
      lastSwings: [],
      lastBos: { type: 'none', direction: 'none', fromSwing: null, toSwing: null, price: null, timestamp: null },
      lastChoch: { type: 'none', direction: 'none', fromSwing: null, toSwing: null, price: null, timestamp: null }
    };
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Market structure calculation error:', error.message);
    result.marketStructure = {
      currentStructure: 'unknown',
      lastSwings: [],
      lastBos: { type: 'none', direction: 'none', fromSwing: null, toSwing: null, price: null, timestamp: null },
      lastChoch: { type: 'none', direction: 'none', fromSwing: null, toSwing: null, price: null, timestamp: null }
    };
  }
  
  // Volume Profile - Always include structured object (never null)
  try {
    const volumeProfile = calculateVolumeProfile(candles);
    result.volumeProfile = volumeProfile || {
      highVolumeNodes: [],
      lowVolumeNodes: [],
      valueAreaHigh: null,
      valueAreaLow: null
    };
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Volume profile calculation error:', error.message);
    result.volumeProfile = {
      highVolumeNodes: [],
      lowVolumeNodes: [],
      valueAreaHigh: null,
      valueAreaLow: null
    };
  }
  
  // Liquidity Zones - Always include array (even if empty)
  try {
    const liquidityZones = calculateLiquidityZones(candles);
    result.liquidityZones = Array.isArray(liquidityZones) ? liquidityZones : [];
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Liquidity zones calculation error:', error.message);
    result.liquidityZones = []; // Always include empty array
  }
  
  // Fair Value Gaps - Always include array (even if empty)
  try {
    const fairValueGaps = calculateFairValueGaps(candles);
    result.fairValueGaps = Array.isArray(fairValueGaps) ? fairValueGaps : [];
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Fair value gaps calculation error:', error.message);
    result.fairValueGaps = []; // Always include empty array
  }
  
  // Divergences - Always include array (even if empty)
  try {
    const divergences = calculateDivergences(candles, indicators);
    result.divergences = Array.isArray(divergences) ? divergences : [];
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Divergences calculation error:', error.message);
    result.divergences = []; // Always include empty array
  }
  
  return result;
}
