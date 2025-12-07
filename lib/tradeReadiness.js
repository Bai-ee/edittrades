/**
 * Trade Readiness Meter
 * Evaluates market conditions and returns a 0-100 score with classification
 */

/**
 * @typedef {Object} TradeReadinessResult
 * @property {number} tradeReadinessScore - Score from 0-100
 * @property {string} tradeReadinessLevel - "DONT_BOTHER" | "WATCH" | "PRIME"
 * @property {string} directionBias - "long" | "short" | "neutral"
 * @property {Object} timeframeAlignment - Alignment status for 1d, 4h, 1h
 * @property {string[]} keyDrivers - Positive factors contributing to score
 * @property {string[]} redFlags - Warning factors
 * @property {Object} quickView - Quick status flags
 */

/**
 * Evaluate trade readiness for a symbol
 * @param {Object} richSymbol - Rich symbol object with htfBias, timeframes, currentPrice
 * @returns {TradeReadinessResult}
 */
export function evaluateTradeReadiness(richSymbol) {
  if (!richSymbol) {
    return createDefaultResult('neutral');
  }

  const { htfBias, timeframes, currentPrice } = richSymbol;
  const direction = htfBias?.direction || 'neutral';
  const biasConfidence = htfBias?.confidence || 0;

  let score = 0;
  const keyDrivers = [];
  const redFlags = [];

  // 3.1 HTF Bias & Trend Alignment (max ~35 pts)
  if (direction === 'neutral') {
    redFlags.push('No clear HTF bias direction');
  } else {
    // Base score from bias confidence
    const biasScore = Math.round(biasConfidence * 0.2); // up to 20 pts
    score += biasScore;
    if (biasScore >= 15) {
      keyDrivers.push(`Strong HTF bias (${biasConfidence}% confidence)`);
    }

    // Timeframe alignment (1D/4H/1H)
    const tfs = ['1d', '4h', '1h'];
    const expectedTrend = direction === 'long' ? 'up' : 'down';
    const aligned = tfs.every(tf => {
      const tfData = timeframes?.[tf];
      const trend = tfData?.trend || tfData?.indicators?.analysis?.trend;
      return trend && (trend.toLowerCase().includes(expectedTrend) || trend.toLowerCase() === expectedTrend);
    });

    if (aligned) {
      score += 10;
      keyDrivers.push(`All HTF timeframes aligned ${direction === 'long' ? '↑' : '↓'}`);
    } else {
      const alignedCount = tfs.filter(tf => {
        const tfData = timeframes?.[tf];
        const trend = tfData?.trend || tfData?.indicators?.analysis?.trend;
        return trend && (trend.toLowerCase().includes(expectedTrend) || trend.toLowerCase() === expectedTrend);
      }).length;
      score += alignedCount * 3; // partial credit
      if (alignedCount >= 2) {
        keyDrivers.push(`${alignedCount}/3 HTF timeframes aligned`);
      } else {
        redFlags.push(`Only ${alignedCount}/3 HTF timeframes aligned`);
      }
    }

    // Market structure side alignment
    const msAligned = tfs.every(tf => {
      const tfData = timeframes?.[tf];
      const ms = tfData?.marketStructure || tfData?.analysis?.marketStructure;
      const msSide = ms?.side;
      const expectedSide = direction === 'long' ? 'bullish' : 'bearish';
      return msSide === expectedSide;
    });

    if (msAligned) {
      score += 5;
      keyDrivers.push('Market structure aligned across HTF');
    }
  }

  // 3.2 EMA & Structure Cleanliness (max ~15 pts)
  const tf4 = timeframes?.['4h'];
  const tf1 = timeframes?.['1h'];
  const price = currentPrice;

  if (tf4 && price) {
    const ema21_4h = tf4.ema21 || tf4.indicators?.ema?.ema21;
    const ema200_4h = tf4.ema200 || tf4.indicators?.ema?.ema200;

    if (ema21_4h && ema200_4h) {
      const ema4Aligned =
        (direction === 'short' && price < ema21_4h && price < ema200_4h) ||
        (direction === 'long' && price > ema21_4h && price > ema200_4h);

      if (ema4Aligned) {
        score += 7;
        keyDrivers.push('Price aligned with 4H EMAs');
      }
    }
  }

  if (tf1 && price) {
    const ema21_1h = tf1.ema21 || tf1.indicators?.ema?.ema21;
    const ema200_1h = tf1.ema200 || tf1.indicators?.ema?.ema200;

    if (ema21_1h && ema200_1h) {
      const ema1Aligned =
        (direction === 'short' && price < ema21_1h && price < ema200_1h) ||
        (direction === 'long' && price > ema21_1h && price > ema200_1h);

      if (ema1Aligned) {
        score += 5;
        keyDrivers.push('Price aligned with 1H EMAs');
      }
    }
  }

  // BOS/CHOCH check
  if (tf4) {
    const ms4 = tf4.marketStructure || tf4.analysis?.marketStructure;
    if (ms4) {
      const lastBos = ms4.lastBos || ms4.bos;
      const lastChoch = ms4.lastChoch || ms4.choch;

      if (lastBos && lastBos.type === 'BOS' && lastBos.direction === (direction === 'long' ? 'bullish' : 'bearish')) {
        score += 3;
        keyDrivers.push('Recent BOS in bias direction');
      }

      if (lastChoch && lastChoch.type === 'CHOCH' && lastChoch.direction !== (direction === 'long' ? 'bullish' : 'bearish')) {
        score -= 5;
        redFlags.push('Recent CHOCH against bias direction');
      }
    }
  }

  // 3.3 Liquidity Context (max ~15 pts)
  const { scoreDelta: lqDelta4, clean: lqClean4 } = evaluateLiquidity(tf4, direction);
  score += lqDelta4;

  const { scoreDelta: lqDelta1, clean: lqClean1 } = evaluateLiquidity(tf1, direction);
  score += Math.round(lqDelta1 * 0.5); // 1h less weight

  if (lqClean4) {
    keyDrivers.push('Clean liquidity structure on 4H');
  }

  // 3.4 FVG Context (max ~10 pts)
  const fvgScore = evaluateFVGContext(tf4, tf1, direction, price);
  score += fvgScore.score;
  if (fvgScore.driver) keyDrivers.push(fvgScore.driver);
  if (fvgScore.flag) redFlags.push(fvgScore.flag);

  // 3.5 Volatility State (max ~10 pts)
  const vol = tf4?.volatility || tf4?.analysis?.volatility;
  if (vol) {
    if (vol.state === 'low') {
      score -= 5;
      redFlags.push('Low volatility - dead market');
    } else if (vol.state === 'normal') {
      score += 7;
      keyDrivers.push('Normal volatility - sweet spot');
    } else if (vol.state === 'high') {
      score += 3;
      keyDrivers.push('High volatility - tradable but spiky');
    } else if (vol.state === 'extreme') {
      score -= 8;
      redFlags.push('Extreme volatility - avoid');
    }

    // Clamp if ATR % too extreme
    if (vol.atrPercent !== undefined && vol.atrPercent !== null) {
      if (vol.atrPercent < 0.4) {
        score = Math.min(score, 50);
        redFlags.push('ATR % too low - choppy conditions');
      }
      if (vol.atrPercent > 3.0) {
        score = Math.min(score, 60);
        redFlags.push('ATR % too high - extreme conditions');
      }
    }
  }

  // 3.6 Divergences (max ±10 pts)
  const divScore = evaluateDivergences(tf4, direction);
  score += divScore.score;
  if (divScore.driver) keyDrivers.push(divScore.driver);
  if (divScore.flag) redFlags.push(divScore.flag);

  // 3.7 Volume & Volume Profile (max ~10 pts)
  const volScore = evaluateVolumeProfile(tf4, direction, price);
  score += volScore.score;
  if (volScore.driver) keyDrivers.push(volScore.driver);

  // 3.8 Clamp & classify
  if (direction === 'neutral') {
    score = Math.min(score, 60);
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let level;
  if (score < 40) {
    level = 'DONT_BOTHER';
  } else if (score < 70) {
    level = 'WATCH';
  } else {
    level = 'PRIME';
  }

  // Build timeframe alignment object
  const timeframeAlignment = {};
  const tfs = ['1d', '4h', '1h'];
  tfs.forEach(tf => {
    const tfData = timeframes?.[tf];
    const trend = tfData?.trend || tfData?.indicators?.analysis?.trend;
    timeframeAlignment[tf] = trend ? (trend.toLowerCase().includes('up') ? 'up' : trend.toLowerCase().includes('down') ? 'down' : 'flat') : 'unknown';
  });
  timeframeAlignment.aligned = tfs.every(tf => {
    const expectedTrend = direction === 'long' ? 'up' : direction === 'short' ? 'down' : null;
    return expectedTrend && timeframeAlignment[tf] === expectedTrend;
  });

  // Build quickView
  const quickView = {
    htfAligned: timeframeAlignment.aligned,
    liquidityClean: lqClean4,
    volatilityTradable: vol?.state === 'normal' || vol?.state === 'high',
    structureClean: score >= 70,
    fvgContext: fvgScore.context || 'none',
    divergenceContext: divScore.context || 'none'
  };

  return {
    tradeReadinessScore: score,
    tradeReadinessLevel: level,
    directionBias: direction,
    timeframeAlignment,
    keyDrivers: keyDrivers.length > 0 ? keyDrivers : ['No clear drivers identified'],
    redFlags: redFlags.length > 0 ? redFlags : [],
    quickView
  };
}

/**
 * Evaluate liquidity context for a timeframe
 */
function evaluateLiquidity(tf, direction) {
  if (!tf) return { scoreDelta: 0, clean: false };

  const lq = tf.liquidityZones || tf.analysis?.liquidityZones;
  if (!lq || !Array.isArray(lq)) return { scoreDelta: 0, clean: false };

  // Filter liquidity zones by type
  const equalHighs = lq.filter(z => z.type === 'equal_highs' || z.type === 'equalHighs');
  const equalLows = lq.filter(z => z.type === 'equal_lows' || z.type === 'equalLows');

  let delta = 0;
  let clean = false;

  if (direction === 'short') {
    if (equalLows.length > 0) {
      delta += 7; // liquidity below to target
    }
    if (equalHighs.length === 0) {
      delta += 3; // less risk of squeeze
    } else if (equalHighs.length > equalLows.length * 2) {
      delta -= 3; // too many equal highs above
    }
  } else if (direction === 'long') {
    if (equalHighs.length > 0) {
      delta += 7; // liquidity above to target
    }
    if (equalLows.length === 0) {
      delta += 3; // less risk of squeeze
    } else if (equalLows.length > equalHighs.length * 2) {
      delta -= 3; // too many equal lows below
    }
  }

  clean = delta >= 7;
  return { scoreDelta: delta, clean };
}

/**
 * Evaluate FVG context
 */
function evaluateFVGContext(tf4, tf1, direction, price) {
  if (!price) return { score: 0, context: 'none' };

  const fvgs4h = tf4?.fairValueGaps || tf4?.analysis?.fairValueGaps || [];
  const fvgs1h = tf1?.fairValueGaps || tf1?.analysis?.fairValueGaps || [];
  const allFvgs = [...fvgs4h, ...fvgs1h];

  let score = 0;
  let driver = null;
  let flag = null;
  let context = 'none';

  if (direction === 'short') {
    const bearishFvgs = allFvgs.filter(f => f.direction === 'bearish' && !f.filled);
    const bullishFvgs = allFvgs.filter(f => f.direction === 'bullish' && !f.filled);

    // Check if price is inside opposite FVG
    const inBullishFvg = bullishFvgs.some(f => price > f.low && price < f.high);
    if (inBullishFvg) {
      score -= 5;
      flag = 'Price inside bullish FVG - messy context';
      context = 'opposite';
    }

    // Check for bearish FVG behind price (below)
    const bearishFvgBelow = bearishFvgs.filter(f => f.high < price);
    if (bearishFvgBelow.length > 0) {
      score += 7;
      driver = 'Bearish FVG below price - continuation context';
      context = 'supportive';
    }
  } else if (direction === 'long') {
    const bullishFvgs = allFvgs.filter(f => f.direction === 'bullish' && !f.filled);
    const bearishFvgs = allFvgs.filter(f => f.direction === 'bearish' && !f.filled);

    // Check if price is inside opposite FVG
    const inBearishFvg = bearishFvgs.some(f => price > f.low && price < f.high);
    if (inBearishFvg) {
      score -= 5;
      flag = 'Price inside bearish FVG - messy context';
      context = 'opposite';
    }

    // Check for bullish FVG behind price (above)
    const bullishFvgAbove = bullishFvgs.filter(f => f.low > price);
    if (bullishFvgAbove.length > 0) {
      score += 7;
      driver = 'Bullish FVG above price - continuation context';
      context = 'supportive';
    }
  }

  return { score, driver, flag, context };
}

/**
 * Evaluate divergences
 */
function evaluateDivergences(tf, direction) {
  if (!tf) return { score: 0, context: 'none' };

  const divs = tf.divergences || tf.analysis?.divergences || [];
  if (!Array.isArray(divs)) return { score: 0, context: 'none' };

  let score = 0;
  let driver = null;
  let flag = null;
  let context = 'none';

  // Check for RSI divergences
  const rsiDivs = divs.filter(d => d.indicator === 'rsi' || d.type === 'rsi');
  const bearishDivs = rsiDivs.filter(d => d.side === 'bearish' || d.direction === 'bearish');
  const bullishDivs = rsiDivs.filter(d => d.side === 'bullish' || d.direction === 'bullish');

  if (direction === 'short') {
    if (bearishDivs.length > 0) {
      score += 5;
      driver = 'Bearish divergence supports short';
      context = 'supportive';
    }
    if (bullishDivs.length > 0) {
      score -= 7;
      flag = 'Bullish divergence warns against short';
      context = 'warning';
    }
  } else if (direction === 'long') {
    if (bullishDivs.length > 0) {
      score += 5;
      driver = 'Bullish divergence supports long';
      context = 'supportive';
    }
    if (bearishDivs.length > 0) {
      score -= 7;
      flag = 'Bearish divergence warns against long';
      context = 'warning';
    }
  }

  return { score, driver, flag, context };
}

/**
 * Evaluate volume and volume profile
 */
function evaluateVolumeProfile(tf, direction, price) {
  if (!tf || !price) return { score: 0 };

  let score = 0;
  let driver = null;

  const vol = tf.volume || tf.analysis?.volume;
  if (vol?.trend === 'up') {
    score += 3;
    driver = 'Volume trending up';
  }

  const vp = tf.volumeProfile || tf.analysis?.volumeProfile;
  if (vp?.valueAreaHigh && vp?.valueAreaLow) {
    if (price > vp.valueAreaLow && price < vp.valueAreaHigh) {
      score += 2;
      driver = driver ? driver + ', price in value area' : 'Price in value area';
    }
  }

  return { score, driver };
}

/**
 * Create default result for neutral/no data
 */
function createDefaultResult(direction) {
  return {
    tradeReadinessScore: 0,
    tradeReadinessLevel: 'DONT_BOTHER',
    directionBias: direction,
    timeframeAlignment: {
      '1d': 'unknown',
      '4h': 'unknown',
      '1h': 'unknown',
      aligned: false
    },
    keyDrivers: ['No data available'],
    redFlags: ['Insufficient data for evaluation'],
    quickView: {
      htfAligned: false,
      liquidityClean: false,
      volatilityTradable: false,
      structureClean: false,
      fvgContext: 'none',
      divergenceContext: 'none'
    }
  };
}
