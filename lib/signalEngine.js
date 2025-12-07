/**
 * Confluence-Based Signal Engine
 * 
 * Generates trade signals using confluence scoring across all advanced modules:
 * - Market Structure (BOS/CHOCH, swings, structural trend)
 * - Volatility (ATR, ATR%, state classification)
 * - Liquidity Zones (equal highs/lows, clusters)
 * - Fair Value Gaps (bullish/bearish, fill state)
 * - Divergences (RSI/StochRSI, regular/hidden)
 * - Volume Profile (HVN, LVN, Value Area)
 * - Volume Analysis (current, avg20, trend)
 */

// ---------------- CONFIG ----------------

const MODE_CONFIG = {
  SAFE: {
    minConfidence: 70,
    maxAtrPct: 3,
    allowCounterTrend: false,
    requireHTFAlignment: true,
  },
  AGGRESSIVE: {
    minConfidence: 50,
    maxAtrPct: 5,
    allowCounterTrend: true,
    requireHTFAlignment: false,
  },
};

// ---------------- UTILS ----------------

function pctDistance(price, level) {
  if (!price || !level || level === null || level === undefined) return null;
  return Math.abs((price - level) / price) * 100;
}

function isPullbackToEma(price, ema, maxPct) {
  if (!price || !ema || ema === null || ema === undefined) return false;
  const dist = pctDistance(price, ema);
  return dist !== null && dist <= maxPct;
}

/**
 * Derive market structure side from currentStructure
 * @param {Object} marketStructure - Market structure object
 * @returns {string} 'bullish' | 'bearish' | 'range' | null
 */
function deriveMsSide(marketStructure) {
  if (!marketStructure) return null;
  
  const currentStructure = marketStructure.currentStructure;
  if (currentStructure === 'uptrend') return 'bullish';
  if (currentStructure === 'downtrend') return 'bearish';
  if (currentStructure === 'flat' || currentStructure === 'unknown') return 'range';
  
  // Fallback: infer from lastBos direction
  if (marketStructure.lastBos && marketStructure.lastBos.type === 'BOS') {
    if (marketStructure.lastBos.direction === 'bullish') return 'bullish';
    if (marketStructure.lastBos.direction === 'bearish') return 'bearish';
  }
  
  return 'range';
}

function msSideScore(side, direction) {
  if (!side) return 0;
  if (side === 'range') return -5;
  if (direction === 'long' && side === 'bullish') return 10;
  if (direction === 'short' && side === 'bearish') return 10;
  return -10; // opposite
}

function htfAlignmentScore(htfBiasDir, htfBiasConf, direction) {
  if (htfBiasDir === 'neutral') return 0;
  const aligned = htfBiasDir === direction;
  const base = (htfBiasConf / 100) * 20; // up to 20
  return aligned ? base : -base;
}

function volatilityScore(vol) {
  if (!vol || vol.atrPctOfPrice == null || !vol.state) return 0;
  
  switch (vol.state) {
    case 'normal':
      return 5;
    case 'low':
      return 2;
    case 'high':
      return -3;
    case 'extreme':
      return -8;
    default:
      return 0;
  }
}

function divergenceScore(divergences, direction) {
  if (!divergences || !Array.isArray(divergences)) return 0;
  
  let score = 0;
  
  for (const d of divergences) {
    if (!d || !d.side || !d.type) continue;
    
    const { side, type } = d;
    const isLongSignal = side === 'bullish';
    const isShortSignal = side === 'bearish';
    const mag = type === 'regular' ? 6 : 3; // regular stronger than hidden
    
    if (direction === 'long' && isLongSignal) score += mag;
    if (direction === 'short' && isShortSignal) score += mag;
    if (direction === 'long' && isShortSignal) score -= mag;
    if (direction === 'short' && isLongSignal) score -= mag;
  }
  
  // Clamp
  return Math.max(-10, Math.min(10, score));
}

function liquidityScore(liquidity, direction, price) {
  if (!liquidity || !Array.isArray(liquidity)) return 0;
  
  let score = 0;
  
  // Filter arrays from flat structure
  const equalHighs = liquidity.filter(z => z.type === 'equal_highs') || [];
  const equalLows = liquidity.filter(z => z.type === 'equal_lows') || [];
  
  // If we're long, we like liquidity ABOVE (targets) and some stops BELOW.
  // If we're short, we like liquidity BELOW (targets) and stops ABOVE.
  
  if (direction === 'long') {
    if (equalLows.length > 0) score += 5; // liquidity below
    if (equalHighs.length > 0) score += 3; // target liquidity above
  } else {
    if (equalHighs.length > 0) score += 5; // liquidity above
    if (equalLows.length > 0) score += 3; // target liquidity below
  }
  
  return Math.max(0, Math.min(15, score));
}

function fvgScore(fvgs, direction) {
  if (!fvgs || !Array.isArray(fvgs)) return 0;
  
  // Filter arrays from flat structure
  const bullish = fvgs.filter(f => f.direction === 'bullish') || [];
  const bearish = fvgs.filter(f => f.direction === 'bearish') || [];
  
  let score = 0;
  
  if (direction === 'long') {
    if (bullish.length > 0) score += 5; // continuation/mitigation interest
    if (bearish.length > 0) score -= 3; // overhead imbalance risk
  } else {
    if (bearish.length > 0) score += 5;
    if (bullish.length > 0) score -= 3;
  }
  
  return Math.max(-10, Math.min(10, score));
}

function volumeProfileScore(vp, direction, price) {
  if (!vp) return 0;
  
  const { valueAreaHigh: vah, valueAreaLow: val } = vp;
  if (!vah || !val || vah === null || val === null) return 0;
  
  const mid = (vah + val) / 2;
  
  // Simple logic: fade extremes, avoid trading in middle chop
  if (direction === 'long' && price <= val) return 7; // under value area low
  if (direction === 'short' && price >= vah) return 7; // above value area high
  if (price > val && price < vah) return -3; // inside value area = chop
  
  return 0;
}

// ---------------- MAIN SCORING ----------------

function computeDirectionScore(symbol, direction) {
  const { currentPrice, htfBias, timeframes } = symbol;
  const logs = [];
  
  const tf1d = timeframes['1d'];
  const tf4h = timeframes['4h'];
  const tf1h = timeframes['1h'];
  const tf15m = timeframes['15m'];
  
  let score = 0;
  
  // 1) HTF alignment
  const htfScore = htfAlignmentScore(htfBias.direction, htfBias.confidence, direction);
  score += htfScore;
  logs.push(`HTF alignment: ${htfScore.toFixed(1)}`);
  
  // 2) Market structure (4H + 1H)
  if (tf4h?.marketStructure) {
    const msSide = deriveMsSide(tf4h.marketStructure);
    const ms4h = msSideScore(msSide, direction);
    score += ms4h;
    logs.push(`4H market structure: ${ms4h}`);
  }
  
  if (tf1h?.marketStructure) {
    const msSide1h = deriveMsSide(tf1h.marketStructure);
    const ms1h = msSideScore(msSide1h, direction) * 0.7; // slightly less weight
    score += ms1h;
    logs.push(`1H market structure: ${(ms1h).toFixed(1)}`);
  }
  
  // 3) EMA pullback logic (4H + 1H)
  if (tf4h?.ema21) {
    const isPB = isPullbackToEma(currentPrice, tf4h.ema21, 2.5);
    if (isPB) {
      score += 8;
      logs.push('4H pullback near EMA21: +8');
    }
  }
  
  if (tf1h?.ema21) {
    const isPB1h = isPullbackToEma(currentPrice, tf1h.ema21, 2.0);
    if (isPB1h) {
      score += 5;
      logs.push('1H pullback near EMA21: +5');
    }
  }
  
  // 4) Liquidity zones (4H + 1H)
  if (tf4h?.liquidityZones) {
    const lq4h = liquidityScore(tf4h.liquidityZones, direction, currentPrice);
    score += lq4h;
    logs.push(`4H liquidity: ${lq4h}`);
  }
  
  if (tf1h?.liquidityZones) {
    const lq1h = liquidityScore(tf1h.liquidityZones, direction, currentPrice) * 0.5;
    score += lq1h;
    logs.push(`1H liquidity: ${lq1h.toFixed(1)}`);
  }
  
  // 5) FVG (4H + 1H)
  if (tf4h?.fairValueGaps) {
    const fvg4h = fvgScore(tf4h.fairValueGaps, direction);
    score += fvg4h;
    logs.push(`4H FVG: ${fvg4h}`);
  }
  
  if (tf1h?.fairValueGaps) {
    const fvg1h = fvgScore(tf1h.fairValueGaps, direction) * 0.6;
    score += fvg1h;
    logs.push(`1H FVG: ${fvg1h.toFixed(1)}`);
  }
  
  // 6) Divergences (1H + 15m)
  if (tf1h?.divergences) {
    const div1h = divergenceScore(tf1h.divergences, direction);
    score += div1h;
    logs.push(`1H divergences: ${div1h}`);
  }
  
  if (tf15m?.divergences) {
    const div15 = divergenceScore(tf15m.divergences, direction) * 0.5;
    score += div15;
    logs.push(`15m divergences: ${div15.toFixed(1)}`);
  }
  
  // 7) Volatility: prefer normal
  if (tf4h?.volatility) {
    const volScore = volatilityScore(tf4h.volatility);
    score += volScore;
    logs.push(`4H volatility: ${volScore}`);
  }
  
  // 8) Volume profile (4H)
  if (tf4h?.volumeProfile) {
    const vpScore = volumeProfileScore(tf4h.volumeProfile, direction, currentPrice);
    score += vpScore;
    logs.push(`4H volume profile: ${vpScore}`);
  }
  
  // Clamp
  const clamped = Math.max(0, Math.min(100, score));
  
  return { score: clamped, breakdown: logs };
}

// ---------------- STRATEGY SELECTION ----------------

function selectStrategy(symbol, direction, score) {
  const tf4h = symbol.timeframes['4h'];
  const tf1h = symbol.timeframes['1h'];
  
  // Normalize trend values to match expected format
  const normalizeTrend = (trend) => {
    if (!trend) return null;
    const lower = String(trend).toLowerCase();
    if (lower.includes('up')) return 'up';
    if (lower.includes('down')) return 'down';
    return 'flat';
  };
  
  const trend4h = normalizeTrend(tf4h?.trend);
  const trend1h = normalizeTrend(tf1h?.trend);
  
  const strongTrend4h = trend4h === (direction === 'long' ? 'up' : 'down');
  const strongTrend1h = trend1h === (direction === 'long' ? 'up' : 'down');
  
  if (strongTrend4h && strongTrend1h && score >= 75) {
    return 'TREND_RIDER';
  }
  
  if (strongTrend4h && score >= 65) {
    return 'TREND_4H';
  }
  
  if (strongTrend1h && score >= 60) {
    return 'SCALP_1H';
  }
  
  // If nothing else, maybe SWING if HTF bias is strong
  if (symbol.htfBias.direction === direction && symbol.htfBias.confidence >= 80) {
    return 'SWING';
  }
  
  return 'NO_TRADE';
}

// ---------------- STOP, TARGETS, ENTRY ----------------

function buildStopsAndTargets(symbol, direction, selectedStrategy) {
  const price = symbol.currentPrice;
  const tf4h = symbol.timeframes['4h'];
  const tf1d = symbol.timeframes['1d'];
  
  // ATR-based stop (4H)
  const atr = tf4h?.volatility?.atr ?? null;
  const atrPct = tf4h?.volatility?.atrPctOfPrice ?? null;
  
  let stopLoss = null;
  
  if (atr && atrPct) {
    const mul = selectedStrategy === 'TREND_RIDER' ? 2.0 : 1.5;
    if (direction === 'long') {
      stopLoss = price - atr * mul;
    } else {
      stopLoss = price + atr * mul;
    }
  }
  
  // Invalidation slightly inside stop
  const invalidationLevel = stopLoss;
  
  // Entry zone: around current price w/ small band or based on EMA 21 1H/4H
  let entryZone = { min: null, max: null };
  
  const emaRef = symbol.timeframes['1h']?.ema21 ?? symbol.timeframes['4h']?.ema21;
  if (emaRef) {
    const tolerance = price * 0.003; // 0.3%
    entryZone = {
      min: Math.min(price, emaRef) - tolerance,
      max: Math.max(price, emaRef) + tolerance,
    };
  } else {
    const band = price * 0.002;
    entryZone = { min: price - band, max: price + band };
  }
  
  // Targets using structure + simple multiples of risk
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;
  
  if (stopLoss) {
    const risk = Math.abs(price - stopLoss);
    
    // Use liquidity zones for targets if available
    const lz = tf4h?.liquidityZones || [];
    const equalHighs = lz.filter(z => z.type === 'equal_highs');
    const equalLows = lz.filter(z => z.type === 'equal_lows');
    
    if (direction === 'long') {
      tp1 = price + risk * 1.5;
      tp2 = price + risk * 3;
      
      // Use nearest equal high as tp3 if available
      if (equalHighs.length > 0) {
        const nearestHigh = equalHighs
          .map(z => z.price)
          .filter(p => p > price)
          .sort((a, b) => a - b)[0];
        if (nearestHigh && nearestHigh > tp2) {
          tp3 = nearestHigh;
        }
      }
    } else {
      tp1 = price - risk * 1.5;
      tp2 = price - risk * 3;
      
      // Use nearest equal low as tp3 if available
      if (equalLows.length > 0) {
        const nearestLow = equalLows
          .map(z => z.price)
          .filter(p => p < price)
          .sort((a, b) => b - a)[0];
        if (nearestLow && nearestLow < tp2) {
          tp3 = nearestLow;
        }
      }
    }
  }
  
  const targets = { tp1, tp2, tp3 };
  
  const riskReward = {
    tp1RR: stopLoss && tp1 ? Number((Math.abs(tp1 - price) / Math.abs(price - stopLoss)).toFixed(2)) : null,
    tp2RR: stopLoss && tp2 ? Number((Math.abs(tp2 - price) / Math.abs(price - stopLoss)).toFixed(2)) : null,
    tp3RR: stopLoss && tp3 ? Number((Math.abs(tp3 - price) / Math.abs(price - stopLoss)).toFixed(2)) : null,
  };
  
  return { entryZone, stopLoss, invalidationLevel, targets, riskReward };
}

// ---------------- PUBLIC API ----------------

export function generateSignal(symbol) {
  const modeCfg = MODE_CONFIG[symbol.mode];
  
  if (!modeCfg) {
    console.warn('[SignalEngine] Unknown mode:', symbol.mode, '- defaulting to SAFE');
    symbol.mode = 'SAFE';
  }
  
  const strategiesChecked = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];
  
  // Score both directions
  const longEval = computeDirectionScore(symbol, 'long');
  const shortEval = computeDirectionScore(symbol, 'short');
  
  // Decide direction
  let direction = 'NO_TRADE';
  let score = 0;
  let breakdown = [];
  
  if (longEval.score > shortEval.score) {
    direction = 'long';
    score = longEval.score;
    breakdown = longEval.breakdown;
  } else if (shortEval.score > longEval.score) {
    direction = 'short';
    score = shortEval.score;
    breakdown = shortEval.breakdown;
  }
  
  // Mode filters
  if (direction !== 'NO_TRADE') {
    if (score < modeCfg.minConfidence) {
      direction = 'NO_TRADE';
    } else if (modeCfg.requireHTFAlignment) {
      if (symbol.htfBias.direction !== direction) {
        direction = 'NO_TRADE';
      }
    }
    
    // Check ATR % filter
    const tf4h = symbol.timeframes['4h'];
    if (tf4h?.volatility?.atrPctOfPrice) {
      if (tf4h.volatility.atrPctOfPrice > modeCfg.maxAtrPct) {
        direction = 'NO_TRADE';
        breakdown.push(`ATR% (${tf4h.volatility.atrPctOfPrice.toFixed(2)}%) exceeds max (${modeCfg.maxAtrPct}%)`);
      }
    }
  }
  
  if (direction === 'NO_TRADE') {
    return {
      valid: false,
      direction: 'NO_TRADE',
      setupType: 'auto',
      selectedStrategy: 'NO_TRADE',
      strategiesChecked,
      confidence: 0,
      reason: `No clean setup. Long score: ${longEval.score.toFixed(1)}, short score: ${shortEval.score.toFixed(1)}. ${breakdown.join(' | ')}`,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: { tp1: null, tp2: null, tp3: null },
      riskReward: { tp1RR: null, tp2RR: null, tp3RR: null },
    };
  }
  
  // Pick strategy
  const selectedStrategy = selectStrategy(symbol, direction, score);
  
  if (selectedStrategy === 'NO_TRADE') {
    return {
      valid: false,
      direction: 'NO_TRADE',
      setupType: 'auto',
      selectedStrategy: 'NO_TRADE',
      strategiesChecked,
      confidence: score,
      reason: `Directional bias ${direction.toUpperCase()} (score ${score.toFixed(1)}) but no clean strategy template fit. ${breakdown.join(' | ')}`,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: { tp1: null, tp2: null, tp3: null },
      riskReward: { tp1RR: null, tp2RR: null, tp3RR: null },
    };
  }
  
  // Build stops/targets
  const { entryZone, stopLoss, invalidationLevel, targets, riskReward } =
    buildStopsAndTargets(symbol, direction, selectedStrategy);
  
  const reasonLines = [
    `${selectedStrategy} ${direction.toUpperCase()} (mode: ${symbol.mode})`,
    `Score: ${score.toFixed(1)}`,
    `HTF bias: ${symbol.htfBias.direction} (${symbol.htfBias.confidence}%)`,
    ...breakdown,
  ];
  
  return {
    valid: true,
    direction,
    setupType: 'auto',
    selectedStrategy,
    strategiesChecked,
    confidence: score,
    reason: reasonLines.join(' | '),
    entryZone,
    stopLoss,
    invalidationLevel,
    targets,
    riskReward,
  };
}
