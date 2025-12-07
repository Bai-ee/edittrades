/**
 * Vercel Serverless Function: Full Strategy Analysis Endpoint
 * GET /api/analyze-full?symbol=BTCUSDT&mode=STANDARD
 * 
 * Returns rich strategy object with ALL strategies (even NO_TRADE ones)
 * Includes htfBias, timeframes, and all strategy evaluations
 */

import * as marketData from '../services/marketData.js';
import * as indicatorService from '../services/indicators.js';
import strategyService from '../services/strategy.js';
import * as advancedChartAnalysis from '../lib/advancedChartAnalysis.js';
import * as dataValidation from '../lib/dataValidation.js';
import axios from 'axios';

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[Analyze-Full] === START REQUEST ===');
    console.log('[Analyze-Full] URL:', req.url);
    console.log('[Analyze-Full] Query:', JSON.stringify(req.query));
    console.log('[Analyze-Full] Method:', req.method);
    
    // Parse symbol from URL path or query parameter
    let symbol = req.query.symbol;
    
    if (!symbol && req.url) {
      const pathMatch = req.url.match(/\/api\/analyze-full\/([^?]+)/);
      if (pathMatch) {
        symbol = pathMatch[1];
      }
    }

    if (!symbol) {
      console.error('[Analyze-Full] ERROR: Missing symbol parameter');
      return res.status(400).json({ 
        error: 'Missing required parameter: symbol'
      });
    }
    
    console.log('[Analyze-Full] Symbol:', symbol);
    
    // Get mode from query (default to 'STANDARD')
    const mode = req.query.mode || 'STANDARD';
    
    // Parse intervals
    const { intervals } = req.query;
    const intervalList = intervals 
      ? intervals.split(',').map(i => i.trim()) 
      : ['1M', '1w', '3d', '1d', '4h', '1h', '15m', '5m', '3m', '1m'];

    console.log(`[Analyze-Full] Processing ${symbol} (mode: ${mode}) for intervals: ${intervalList.join(', ')}`);

    // Fetch multi-timeframe OHLCV data
    console.log('[Analyze-Full] Step 1: Fetching multi-timeframe data...');
    let multiData;
    try {
      multiData = await marketData.getMultiTimeframeData(symbol, intervalList, 500);
      console.log('[Analyze-Full] Step 1: Success - got data for', Object.keys(multiData).length, 'timeframes');
    } catch (dataError) {
      console.error('[Analyze-Full] Step 1: ERROR fetching multi-timeframe data:', dataError.message);
      console.error('[Analyze-Full] Step 1: Stack:', dataError.stack);
      // Return fallback response instead of 500 error
      return res.status(200).json({
        symbol,
        mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
        currentPrice: null,
        htfBias: { direction: 'neutral', confidence: 0, source: 'none' },
        timeframes: {},
        strategies: {
          SWING: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - market data fetch failed' },
          TREND_4H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - market data fetch failed' },
          TREND_RIDER: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - market data fetch failed' },
          SCALP_1H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - market data fetch failed' },
          MICRO_SCALP: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - market data fetch failed' }
        },
        bestSignal: null,
        marketData: null,
        dflowData: null,
        schemaVersion: '1.0.0',
        jsonVersion: '0.05',
        generatedAt: new Date().toISOString(),
        error: 'Market data fetch failed',
        errorMessage: dataError.message
      });
    }

    // Calculate indicators for each timeframe
    console.log('[Analyze-Full] Step 2: Calculating indicators...');
    const analysis = {};
    for (const [interval, candles] of Object.entries(multiData)) {
      try {
      if (candles && candles.error) {
          console.log(`[Analyze-Full] Step 2: ${interval} has error:`, candles.error);
        analysis[interval] = { error: candles.error };
        continue;
      }

      if (!Array.isArray(candles) || candles.length === 0) {
          console.log(`[Analyze-Full] Step 2: ${interval} has no data`);
        analysis[interval] = { error: 'No data' };
        continue;
      }

        console.log(`[Analyze-Full] Step 2: Processing ${interval} with ${candles.length} candles`);
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        // Calculate advanced chart analysis modules
        const trend = indicators.analysis?.trend || 'FLAT';
        const advancedChart = advancedChartAnalysis.calculateAllAdvancedChartAnalysis(
          candles,
          indicators,
          swingPoints,
          trend
        );
        
        // Get volatility from advancedIndicators - Always include (even if null)
        let volatility = null;
        try {
          const { calculateATR } = await import('../lib/advancedIndicators.js');
          const atrData = calculateATR(candles);
          if (atrData) {
            // Ensure state is always set
            const state = (atrData.volatilityState || 'NORMAL').toLowerCase();
            volatility = {
              atr: atrData.atr,
              atrPctOfPrice: atrData.atrPct,
              state: ['low', 'normal', 'high', 'extreme'].includes(state) ? state : 'normal'
            };
          } else {
            // Set default volatility if ATR calculation fails
            const currentPrice = indicators.price?.current || candles[candles.length - 1]?.close;
            volatility = {
              atr: null,
              atrPctOfPrice: null,
              state: 'normal' // Default state
            };
          }
        } catch (atrError) {
          console.warn(`[Analyze-Full] ATR calculation error for ${interval}:`, atrError.message);
          // Always include volatility object, even on error
          volatility = {
            atr: null,
            atrPctOfPrice: null,
            state: 'normal' // Default state
          };
        }
        
        // Calculate volume metrics - Always include structured object (never null)
        let volume = null;
        try {
          const { calculateVolumeAnalysis } = await import('../lib/volumeAnalysis.js');
          volume = calculateVolumeAnalysis(candles, 20);
          // Ensure volume is always a structured object
          if (!volume || typeof volume !== 'object') {
            const lastCandle = candles[candles.length - 1];
            volume = {
              current: lastCandle?.volume || 0,
              avg20: 0,
              trend: 'flat'
            };
          }
        } catch (volumeError) {
          console.warn(`[Analyze-Full] Volume calculation error for ${interval}:`, volumeError.message);
          // Always return structured object on error
          const lastCandle = candles[candles.length - 1];
          volume = {
            current: lastCandle?.volume || 0,
            avg20: 0,
            trend: 'flat'
          };
        }
        
        // Build analysis object with advanced modules - ALWAYS include all fields (even if null/empty)
        const tfAnalysis = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1],
          // Advanced chart analysis modules - ALWAYS include structured objects (never null)
          marketStructure: advancedChart.marketStructure || {
            currentStructure: 'unknown',
            lastSwings: [],
            lastBos: { type: 'BOS', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null },
            lastChoch: { type: 'CHOCH', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null }
          },
          volatility: volatility || { atr: null, atrPctOfPrice: null, state: 'normal' }, // Always include
          volume: volume || { current: 0, avg20: 0, trend: 'flat' }, // Always include structured object
          volumeProfile: advancedChart.volumeProfile || {
            highVolumeNodes: [],
            lowVolumeNodes: [],
            valueAreaHigh: null,
            valueAreaLow: null
          },
          liquidityZones: Array.isArray(advancedChart.liquidityZones) ? advancedChart.liquidityZones : [], // Always include array (never null)
          fairValueGaps: Array.isArray(advancedChart.fairValueGaps) ? advancedChart.fairValueGaps : [], // Always include array (never null)
          divergences: Array.isArray(advancedChart.divergences) ? advancedChart.divergences : [] // Always include array (never null)
        };

        // Validate and fix data consistency issues
        const currentPrice = indicators.price?.current || candles[candles.length - 1]?.close;
        analysis[interval] = dataValidation.validateTimeframeAnalysis(tfAnalysis, currentPrice);
        console.log(`[Analyze-Full] Step 2: ${interval} processed successfully`);
      } catch (err) {
        console.error(`[Analyze-Full] Step 2: ERROR processing ${interval}:`, err.message);
        console.error(`[Analyze-Full] Step 2: ${interval} stack:`, err.stack);
        // Even on error, include all required fields with defaults
        analysis[interval] = {
          error: err.message,
          indicators: null,
          structure: null,
          candleCount: 0,
          lastCandle: null,
          marketStructure: null,
          volatility: { atr: null, atrPctOfPrice: null, state: 'normal' },
          volumeProfile: null,
          liquidityZones: [], // Always include as array
          fairValueGaps: [], // Always include as array
          divergences: [] // Always include as array
        };
      }
    }
    console.log('[Analyze-Full] Step 2: Complete - processed', Object.keys(analysis).length, 'timeframes');

    // Get current price and market data
    console.log('[Analyze-Full] Step 3: Fetching ticker price...');
    let ticker, currentPrice;
    try {
      ticker = await marketData.getTickerPrice(symbol);
      currentPrice = parseFloat(ticker.price.toFixed(2));
      console.log('[Analyze-Full] Step 3: Success - current price:', currentPrice);
    } catch (tickerError) {
      console.error('[Analyze-Full] Step 3: ERROR fetching ticker:', tickerError.message);
      console.error('[Analyze-Full] Step 3: Stack:', tickerError.stack);
      // Try to extract price from analysis if available
      const lastCandle = analysis['1h']?.lastCandle || analysis['4h']?.lastCandle || analysis['1d']?.lastCandle;
      currentPrice = lastCandle ? parseFloat(lastCandle.close.toFixed(2)) : null;
      console.warn(`[Analyze-Full] Step 3: Using fallback price from candles:`, currentPrice);
      if (!currentPrice) {
        // Return fallback response if we can't get price at all
        return res.status(200).json({
          symbol,
          mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
          currentPrice: null,
          htfBias: { direction: 'neutral', confidence: 0, source: 'none' },
          timeframes: strategyService.buildTimeframeSummary(analysis),
          strategies: {
            SWING: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - ticker price fetch failed' },
            TREND_4H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - ticker price fetch failed' },
            TREND_RIDER: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - ticker price fetch failed' },
            SCALP_1H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - ticker price fetch failed' },
            MICRO_SCALP: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Data not available - ticker price fetch failed' }
          },
          bestSignal: null,
          marketData: null,
          dflowData: null,
          schemaVersion: '1.0.0',
          jsonVersion: '0.05',
          generatedAt: new Date().toISOString(),
          error: 'Ticker price fetch failed',
          errorMessage: tickerError.message
        });
      }
    }

    // Fetch additional market data (spread, bid/ask, order book, recent trades)
    let marketDataInfo = null;
    try {
      // Get ticker data which includes bid/ask
      // Use SYMBOL_MAP from marketData service
      const { default: marketDataModule } = await import('../services/marketData.js');
      const SYMBOL_MAP = {
        'BTCUSDT': { kraken: 'XBTUSD' },
        'ETHUSDT': { kraken: 'ETHUSD' },
        'SOLUSDT': { kraken: 'SOLUSD' }
      };
      const krakenSymbol = SYMBOL_MAP[symbol]?.kraken || 'XBTUSD';
      
      const tickerResponse = await axios.get('https://api.kraken.com/0/public/Ticker', {
        params: { pair: krakenSymbol },
        timeout: 10000
      });
      
      if (tickerResponse.data && !tickerResponse.data.error && tickerResponse.data.result) {
        const pairKey = Object.keys(tickerResponse.data.result)[0];
        const tickerInfo = tickerResponse.data.result[pairKey];
        
        // Kraken ticker structure:
        // a = ask array [price, wholeLotVolume, lotVolume]
        // b = bid array [price, wholeLotVolume, lotVolume]
        // c = last trade closed array [price, lotVolume]
        // t = today's array [number of trades, number of trades]
        // v = 24h volume array [volume, volume]
        // p = volume weighted average price array [today, last 24 hours]
        // l = today's low array [today, last 24 hours]
        // h = today's high array [today, last 24 hours]
        // o = today's opening price
        
        const bid = parseFloat(tickerInfo.b?.[0]) || currentPrice;
        const ask = parseFloat(tickerInfo.a?.[0]) || currentPrice;
        // Use lotVolume (index 2) for bid/ask quantities
        const bidQty = parseFloat(tickerInfo.b?.[2] || 0) || 0;
        const askQty = parseFloat(tickerInfo.a?.[2] || 0) || 0;
        // Trade count is in t array - use first element (today's trades)
        const tradeCount24h = parseInt(tickerInfo.t?.[0] || tickerInfo.t?.[1] || 0) || 0;
        
        console.log(`[Analyze-Full] ${symbol} market data extracted from Kraken API:`, {
          bid,
          ask,
          bidQty,
          askQty,
          tradeCount24h,
          currentPrice,
          spread: Math.abs(ask - bid),
          apiWorking: true
        });
        
        // Calculate spread
        const spread = Math.abs(ask - bid);
        const spreadPercent = currentPrice > 0 ? (spread / currentPrice) * 100 : 0;
        
        // Calculate bid/ask imbalance
        const totalQty = bidQty + askQty;
        const bidAskImbalance = totalQty > 0 ? ((bidQty - askQty) / totalQty) * 100 : 0;
        
        // Calculate volume quality (simplified - based on trade count vs volume)
        const volumeQuality = tradeCount24h > 50000 ? 'HIGH' : tradeCount24h > 20000 ? 'MEDIUM' : 'LOW';
        
        // Get order book depth
        let orderBookData = null;
        try {
          const orderBookResponse = await axios.get('https://api.kraken.com/0/public/Depth', {
            params: { pair: krakenSymbol, count: 10 },
            timeout: 5000
          });
          
          if (orderBookResponse.data && !orderBookResponse.data.error) {
            const orderBook = orderBookResponse.data.result[pairKey];
            const bids = orderBook.bids || [];
            const asks = orderBook.asks || [];
            
            const bidLiquidity = bids.reduce((sum, [price, qty]) => sum + parseFloat(qty), 0);
            const askLiquidity = asks.reduce((sum, [price, qty]) => sum + parseFloat(qty), 0);
            const totalLiquidity = bidLiquidity + askLiquidity;
            const liquidityImbalance = totalLiquidity > 0 ? ((bidLiquidity - askLiquidity) / totalLiquidity) * 100 : 0;
            
            orderBookData = {
              bidLiquidity: parseFloat(bidLiquidity.toFixed(3)),
              askLiquidity: parseFloat(askLiquidity.toFixed(2)),
              imbalance: parseFloat(liquidityImbalance.toFixed(1))
            };
          }
        } catch (obError) {
          console.warn(`[Analyze-Full] Order book unavailable for ${symbol}:`, obError.message);
        }
        
        // Get recent trades
        let recentTradesData = null;
        try {
          const tradesResponse = await axios.get('https://api.kraken.com/0/public/Trades', {
            params: { pair: krakenSymbol, count: 100 },
            timeout: 5000
          });
          
          if (tradesResponse.data && !tradesResponse.data.error) {
            const trades = tradesResponse.data.result[pairKey] || [];
            let buyVolume = 0;
            let sellVolume = 0;
            let buyCount = 0;
            let sellCount = 0;
            
            trades.forEach(([price, volume, time, side]) => {
              const vol = parseFloat(volume);
              if (side === 'b' || side === 'buy') {
                buyVolume += vol;
                buyCount++;
              } else {
                sellVolume += vol;
                sellCount++;
              }
            });
            
            const totalVolume = buyVolume + sellVolume;
            const buyPressure = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
            const sellPressure = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 50;
            const volumeImbalance = buyPressure - sellPressure;
            const overallFlow = volumeImbalance > 5 ? 'BUY' : volumeImbalance < -5 ? 'SELL' : 'NEUTRAL';
            
            recentTradesData = {
              overallFlow: overallFlow,
              buyPressure: parseFloat(buyPressure.toFixed(1)),
              sellPressure: parseFloat(sellPressure.toFixed(1)),
              volumeImbalance: parseFloat(volumeImbalance.toFixed(1))
            };
          }
        } catch (tradesError) {
          console.warn(`[Analyze-Full] Recent trades unavailable for ${symbol}:`, tradesError.message);
        }
        
        marketDataInfo = {
          spread: parseFloat(spread.toFixed(2)),
          spreadPercent: parseFloat(spreadPercent.toFixed(4)),
          bid: parseFloat(bid.toFixed(2)),
          ask: parseFloat(ask.toFixed(2)),
          bidAskImbalance: parseFloat(bidAskImbalance.toFixed(1)),
          volumeQuality: volumeQuality,
          tradeCount24h: tradeCount24h,
          orderBook: orderBookData || { bidLiquidity: null, askLiquidity: null, imbalance: null },
          recentTrades: recentTradesData || { overallFlow: 'N/A', buyPressure: null, sellPressure: null, volumeImbalance: null }
        };
      } else {
        console.warn(`[Analyze-Full] Ticker response error for ${symbol} - API FAILED, using fallback values`);
        // Set default values instead of null
        marketDataInfo = {
          spread: 0,
          spreadPercent: 0,
          bid: currentPrice,
          ask: currentPrice,
          bidAskImbalance: 0,
          volumeQuality: 'MEDIUM', // Use MEDIUM as neutral fallback instead of 'N/A'
          tradeCount24h: 0,
          orderBook: { bidLiquidity: null, askLiquidity: null, imbalance: null },
          recentTrades: { overallFlow: 'N/A', buyPressure: null, sellPressure: null, volumeImbalance: null },
          apiWorking: false // Flag to indicate API failure
        };
      }
    } catch (error) {
      console.warn(`[Analyze-Full] Market data unavailable for ${symbol}:`, error.message, '- API FAILED, using fallback values');
      // Set default values instead of null so UI always shows the section
      marketDataInfo = {
        spread: 0,
        spreadPercent: 0,
        bid: currentPrice,
        ask: currentPrice,
        bidAskImbalance: 0,
        volumeQuality: 'MEDIUM', // Use MEDIUM as neutral fallback instead of 'N/A'
        tradeCount24h: 0,
        orderBook: { bidLiquidity: null, askLiquidity: null, imbalance: null },
        recentTrades: { overallFlow: 'N/A', buyPressure: null, sellPressure: null, volumeImbalance: null },
        apiWorking: false // Flag to indicate API failure
      };
    }

    // Fetch dFlow prediction market data (non-blocking - don't fail if unavailable)
    let dflowData = null;
    try {
      dflowData = await marketData.getDflowPredictionMarkets(symbol);
    } catch (error) {
      console.warn(`[Analyze-Full] dFlow data unavailable for ${symbol}:`, error.message);
      dflowData = {
        symbol,
        error: 'dFlow API unavailable',
        events: [],
        markets: []
      };
    }

    // Evaluate all strategies (pass marketData and dflowData for filters)
    console.log('[Analyze-Full] Step 6: Evaluating all strategies...');
    console.log('[Analyze-Full] Step 6: Analysis keys:', Object.keys(analysis));
    console.log('[Analyze-Full] Step 6: Mode:', mode);
    console.log('[Analyze-Full] Step 6: MarketData present:', !!marketDataInfo);
    console.log('[Analyze-Full] Step 6: dFlowData present:', !!dflowData);
    
    let allStrategiesResult;
    try {
      console.log('[Analyze-Full] Step 6: Calling evaluateAllStrategies...');
      allStrategiesResult = strategyService.evaluateAllStrategies(
        symbol, 
        analysis, 
        mode,
        marketDataInfo,  // Pass market data for volume quality and trade flow filters
        dflowData         // Pass dFlow data for alignment check
      );
      console.log('[Analyze-Full] Step 6: Success - got strategies:', Object.keys(allStrategiesResult.strategies || {}));
      console.log('[Analyze-Full] Step 6: Best signal:', allStrategiesResult.bestSignal);
    } catch (strategyError) {
      console.error(`[Analyze-Full] Step 6: ERROR in strategy evaluation for ${symbol}:`);
      console.error(`[Analyze-Full] Step 6: Error message:`, strategyError.message);
      console.error(`[Analyze-Full] Step 6: Error stack:`, strategyError.stack);
      console.error(`[Analyze-Full] Step 6: Error name:`, strategyError.name);
      console.error(`[Analyze-Full] Step 6: Full error object:`, JSON.stringify(strategyError, Object.getOwnPropertyNames(strategyError)));
      
      // Return fallback response instead of 500 error
      let timeframes = {};
      let htfBiasRaw = { direction: 'neutral', confidence: 0, source: 'none' };
      try {
        timeframes = strategyService.buildTimeframeSummary(analysis) || {};
        htfBiasRaw = strategyService.computeHTFBias(analysis) || htfBiasRaw;
      } catch (e) {
        console.error('[Analyze-Full] Step 6: Error building fallback data:', e.message);
      }
      
      return res.status(200).json({
        symbol,
        mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
        currentPrice: currentPrice || null,
        htfBias: {
          direction: htfBiasRaw.direction || 'neutral',
          confidence: typeof htfBiasRaw.confidence === 'number' 
            ? (htfBiasRaw.confidence > 1 ? htfBiasRaw.confidence : htfBiasRaw.confidence * 100)
            : 0,
          source: htfBiasRaw.source || 'none'
        },
        timeframes: timeframes || {},
        strategies: {
          SWING: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: `Strategy evaluation failed: ${strategyError.message}` },
          TREND_4H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: `Strategy evaluation failed: ${strategyError.message}` },
          TREND_RIDER: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: `Strategy evaluation failed: ${strategyError.message}` },
          SCALP_1H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: `Strategy evaluation failed: ${strategyError.message}` },
          MICRO_SCALP: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: `Strategy evaluation failed: ${strategyError.message}` }
        },
        bestSignal: null,
        marketData: marketDataInfo || null,
        dflowData: dflowData || null,
        schemaVersion: '1.0.0',
        jsonVersion: '0.05',
        generatedAt: new Date().toISOString(),
        error: 'Strategy evaluation failed',
        errorMessage: strategyError.message
      });
    }
    
    // DEBUG: Log strategies keys to verify TREND_RIDER is included
    console.log('DEBUG strategies keys', {
      symbol,
      mode,
      keys: Object.keys(allStrategiesResult.strategies),
      hasTREND_RIDER: 'TREND_RIDER' in allStrategiesResult.strategies
    });
    
    // Build timeframe summary - ensure it always returns an object
    let timeframes = {};
    try {
      timeframes = strategyService.buildTimeframeSummary(analysis) || {};
    } catch (tfError) {
      console.error('[Analyze-Full] Step 7: ERROR building timeframe summary:', tfError.message);
      timeframes = {};
    }
    
    // Get HTF bias from strategy service (compute from analysis directly)
    // Use the exported computeHTFBias function - ensure it always returns valid structure
    let htfBiasRaw = { direction: 'neutral', confidence: 0, source: 'none' };
    try {
      htfBiasRaw = strategyService.computeHTFBias(analysis) || htfBiasRaw;
    } catch (biasError) {
      console.error('[Analyze-Full] Step 7: ERROR computing HTF bias:', biasError.message);
    }
    
    const htfBias = {
      direction: htfBiasRaw.direction || 'neutral',
      confidence: typeof htfBiasRaw.confidence === 'number' 
        ? (htfBiasRaw.confidence > 1 ? htfBiasRaw.confidence : htfBiasRaw.confidence * 100)
        : 0,
      source: htfBiasRaw.source || 'none'
    };
    
    // Ensure strategies object exists and has all required strategies
    const strategies = allStrategiesResult?.strategies || {
      SWING: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Strategy evaluation returned null' },
      TREND_4H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Strategy evaluation returned null' },
      TREND_RIDER: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Strategy evaluation returned null' },
      SCALP_1H: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Strategy evaluation returned null' },
      MICRO_SCALP: { valid: false, direction: 'NO_TRADE', confidence: 0, reason: 'Strategy evaluation returned null' }
    };
    
    // Build rich symbol object - ensure all required fields are present
    const richSymbol = {
      symbol,
      mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
      currentPrice: currentPrice || null, // Always include, even if null
      htfBias: {
        direction: htfBias.direction || 'neutral',
        confidence: typeof htfBias.confidence === 'number' 
          ? (htfBias.confidence > 1 ? htfBias.confidence : htfBias.confidence * 100)
          : 0,
        source: htfBias.source || 'none'
      },
      timeframes: timeframes || {}, // Always include, even if empty
      analysis: analysis || {}, // ✅ CRITICAL: Include full analysis object with all chart data
      strategies: { ...strategies }, // ✅ Includes TREND_RIDER automatically
      bestSignal: allStrategiesResult?.bestSignal || null,
      overrideUsed: allStrategiesResult?.overrideUsed || false, // NEW: Override flag
      overrideNotes: allStrategiesResult?.overrideNotes || [], // NEW: Override explanation
      marketData: marketDataInfo || null, // Spread, bid/ask, volume quality, order book, recent trades
      dflowData: dflowData || null, // Prediction market data
      schemaVersion: '1.0.0',
      jsonVersion: '0.10', // Incremented - now includes all advanced modules in timeframes object
      generatedAt: new Date().toISOString()
    };

    console.log('[Analyze-Full] Step 8: Building response object...');
    console.log('[Analyze-Full] Step 8: Rich symbol keys:', Object.keys(richSymbol));
    
    // ✅ DEBUG: Log analysis object to verify advanced modules are present
    console.log('[Analyze-Full] FINAL ANALYSIS BEFORE EXPORT:');
    console.log('[Analyze-Full] Analysis keys:', Object.keys(analysis));
    if (Object.keys(analysis).length > 0) {
      const firstTf = Object.keys(analysis)[0];
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) keys:`, Object.keys(analysis[firstTf] || {}));
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has marketStructure:`, !!analysis[firstTf]?.marketStructure);
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has volumeProfile:`, !!analysis[firstTf]?.volumeProfile);
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has liquidityZones:`, !!analysis[firstTf]?.liquidityZones);
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has fairValueGaps:`, !!analysis[firstTf]?.fairValueGaps);
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has divergences:`, !!analysis[firstTf]?.divergences);
      console.log(`[Analyze-Full] Sample timeframe (${firstTf}) has volatility:`, !!analysis[firstTf]?.volatility);
    }
    
    console.log('[Analyze-Full] === REQUEST SUCCESS ===');

    return res.status(200).json(richSymbol);

  } catch (error) {
    console.error('[Analyze-Full] === FATAL ERROR ===');
    console.error('[Analyze-Full] Error name:', error.name);
    console.error('[Analyze-Full] Error message:', error.message);
    console.error('[Analyze-Full] Error stack:', error.stack);
    console.error('[Analyze-Full] Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

