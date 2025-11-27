/**
 * BTC 4H Strategy Backtest
 * 
 * Tests the existing 4H strategy engine against historical data
 * Timeframes: 4h, 1h, 15m, 5m
 * Symbol: BTCUSDT
 * Period: 2018-01-01 to now
 */

import ccxt from 'ccxt';
import * as indicatorService from '../services/indicators.js';
import * as strategyService from '../services/strategy.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  symbol: 'BTC/USDT',
  startDate: '2020-01-01', // Start from 2020 (more reliable data)
  primaryTimeframe: '4h',
  timeframes: ['4h', '1h', '15m', '5m'],
  exchange: 'binance',
  maxCandles: 1000, // Per fetch
  slippage: 0.001, // 0.1% slippage
  commission: 0.0004 // 0.04% taker fee
};

// Initialize exchange
const exchange = new ccxt[CONFIG.exchange]({
  enableRateLimit: true,
  options: {
    defaultType: 'future' // Use futures for more historical data
  }
});

/**
 * Fetch historical candles for a timeframe
 */
async function fetchCandles(symbol, timeframe, since) {
  console.log(`Fetching ${timeframe} candles from ${new Date(since).toISOString()}...`);
  
  const allCandles = [];
  let currentSince = since;
  
  try {
    while (true) {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, currentSince, CONFIG.maxCandles);
      
      if (candles.length === 0) break;
      
      allCandles.push(...candles);
      
      // Move to next batch
      const lastTimestamp = candles[candles.length - 1][0];
      if (lastTimestamp >= Date.now()) break; // Caught up to present
      if (currentSince === lastTimestamp) break; // No more data
      
      currentSince = lastTimestamp + 1;
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, exchange.rateLimit));
    }
    
    console.log(`✅ Fetched ${allCandles.length} ${timeframe} candles`);
    
    // Convert to our format
    return allCandles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    }));
    
  } catch (error) {
    console.error(`❌ Error fetching ${timeframe} candles:`, error.message);
    return [];
  }
}

/**
 * Get candles up to a specific timestamp
 */
function getCandlesUpTo(candles, timestamp) {
  return candles.filter(c => c.timestamp <= timestamp);
}

/**
 * Analyze market using our existing strategy engine
 */
function analyzeMarket(candlesByTimeframe) {
  try {
    const analysis = {};
    
    for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
      if (candles.length < 200) continue; // Need enough data for indicators
      
      const indicators = indicatorService.calculateAllIndicators(candles);
      const swingPoints = indicatorService.detectSwingPoints(candles, 20);
      
      analysis[tf] = {
        indicators,
        structure: swingPoints,
        lastCandle: candles[candles.length - 1]
      };
    }
    
    // Get 4H signal using strategy engine
    if (analysis['4h']) {
      const signal = strategyService.evaluateStrategy(
        analysis['4h'].indicators,
        analysis['1h']?.indicators,
        analysis['15m']?.indicators,
        analysis['5m']?.indicators
      );
      
      return { analysis, signal };
    }
    
    return { analysis, signal: { valid: false } };
    
  } catch (error) {
    console.error('Analysis error:', error.message);
    return { analysis: {}, signal: { valid: false } };
  }
}

/**
 * Check if trade hit SL or TP
 */
function checkTradeExit(trade, candle) {
  if (trade.direction === 'long') {
    // Check SL first (conservative)
    if (candle.low <= trade.stopLoss) {
      return { type: 'SL', price: trade.stopLoss, r: -1 };
    }
    // Check TP
    if (candle.high >= trade.tp1) {
      return { type: 'TP1', price: trade.tp1, r: trade.r };
    }
  } else {
    // Short trade
    if (candle.high >= trade.stopLoss) {
      return { type: 'SL', price: trade.stopLoss, r: -1 };
    }
    if (candle.low <= trade.tp1) {
      return { type: 'TP1', price: trade.tp1, r: trade.r };
    }
  }
  
  return null;
}

/**
 * Main backtest function
 */
async function runBacktest() {
  console.log('='.repeat(60));
  console.log('🚀 BTC 4H STRATEGY BACKTEST');
  console.log('='.repeat(60));
  console.log(`Symbol: ${CONFIG.symbol}`);
  console.log(`Start Date: ${CONFIG.startDate}`);
  console.log(`Exchange: ${CONFIG.exchange}`);
  console.log(`Timeframes: ${CONFIG.timeframes.join(', ')}`);
  console.log('='.repeat(60));
  console.log('');
  
  // Fetch all historical data
  const startTimestamp = new Date(CONFIG.startDate).getTime();
  const candleData = {};
  
  for (const tf of CONFIG.timeframes) {
    candleData[tf] = await fetchCandles(CONFIG.symbol, tf, startTimestamp);
    if (candleData[tf].length === 0) {
      console.error(`❌ No data for ${tf}, aborting backtest`);
      return;
    }
  }
  
  console.log('');
  console.log('📊 Starting backtest simulation...');
  console.log('');
  
  // Backtest variables
  const trades = [];
  let openTrade = null;
  let equity = 0;
  let maxEquity = 0;
  let maxDrawdown = 0;
  
  // Iterate through 4H candles
  const candles4h = candleData['4h'];
  
  for (let i = 200; i < candles4h.length; i++) {
    const currentCandle = candles4h[i];
    const currentTime = currentCandle.timestamp;
    
    // Progress indicator
    if (i % 100 === 0) {
      const progress = ((i / candles4h.length) * 100).toFixed(1);
      const date = new Date(currentTime).toISOString().split('T')[0];
      console.log(`Progress: ${progress}% | Date: ${date} | Trades: ${trades.length}`);
    }
    
    // Build snapshot of all timeframes up to current time
    const snapshot = {};
    for (const tf of CONFIG.timeframes) {
      snapshot[tf] = getCandlesUpTo(candleData[tf], currentTime);
    }
    
    // Check if we have an open trade
    if (openTrade) {
      // Check for exit on current candle
      const exit = checkTradeExit(openTrade, currentCandle);
      
      if (exit) {
        // Close trade
        const duration = currentTime - openTrade.entryTime;
        const durationHours = duration / (1000 * 60 * 60);
        
        const closedTrade = {
          ...openTrade,
          exitTime: currentTime,
          exitPrice: exit.price,
          exitType: exit.type,
          rMultiple: exit.r,
          duration: durationHours,
          pnl: exit.r * openTrade.riskAmount
        };
        
        trades.push(closedTrade);
        equity += exit.r;
        
        // Track max equity and drawdown
        if (equity > maxEquity) {
          maxEquity = equity;
        }
        const currentDrawdown = maxEquity - equity;
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown;
        }
        
        openTrade = null;
      }
      
      continue; // Don't look for new trades while in position
    }
    
    // Look for new trade signal
    const { analysis, signal } = analyzeMarket(snapshot);
    
    if (!signal || !signal.valid) continue;
    
    // Check additional filters (avoid overextended, flat trends)
    const trend4h = analysis['4h']?.indicators?.analysis?.trend;
    const pullback4h = analysis['4h']?.indicators?.analysis?.pullbackState;
    
    if (trend4h === 'FLAT' || pullback4h === 'OVEREXTENDED') continue;
    
    // Open new trade
    const direction = signal.direction;
    const entry = currentCandle.close;
    const swingPoints = analysis['4h'].structure;
    
    let stopLoss, riskAmount;
    if (direction === 'long') {
      stopLoss = swingPoints.swingLow || (entry * 0.95); // 5% default
    } else {
      stopLoss = swingPoints.swingHigh || (entry * 1.05);
    }
    
    riskAmount = Math.abs(entry - stopLoss);
    const r = riskAmount / entry; // R as % of entry
    
    const tp1 = direction === 'long' ? entry + riskAmount : entry - riskAmount;
    
    openTrade = {
      id: trades.length + 1,
      direction,
      entryTime: currentTime,
      entryPrice: entry,
      stopLoss,
      tp1,
      riskAmount: entry * r, // Risk in dollar terms
      r: 1, // Assuming full R if TP hit
      confidence: signal.confidence || 0,
      reason: signal.reason || 'N/A'
    };
  }
  
  // Close any remaining open trade at last candle
  if (openTrade) {
    const lastCandle = candles4h[candles4h.length - 1];
    const exit = { type: 'MANUAL_CLOSE', price: lastCandle.close, r: 0 };
    
    trades.push({
      ...openTrade,
      exitTime: lastCandle.timestamp,
      exitPrice: exit.price,
      exitType: exit.type,
      rMultiple: 0,
      pnl: 0
    });
  }
  
  // Calculate metrics
  console.log('');
  console.log('='.repeat(60));
  console.log('📈 BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log('');
  
  const wins = trades.filter(t => t.rMultiple > 0);
  const losses = trades.filter(t => t.rMultiple < 0);
  const breakevens = trades.filter(t => t.rMultiple === 0);
  
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const avgR = totalTrades > 0 ? trades.reduce((sum, t) => sum + t.rMultiple, 0) / totalTrades : 0;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  
  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.rMultiple, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + t.rMultiple, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
  
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Wins: ${wins.length} | Losses: ${losses.length} | Breakeven: ${breakevens.length}`);
  console.log(`Win Rate: ${winRate.toFixed(2)}%`);
  console.log(`Avg R: ${avgR.toFixed(3)}R`);
  console.log(`Total R: ${totalR.toFixed(2)}R`);
  console.log(`Avg Win: ${avgWin.toFixed(3)}R | Avg Loss: ${avgLoss.toFixed(3)}R`);
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown: ${maxDrawdown.toFixed(2)}R`);
  console.log('');
  
  // Show sample trades
  console.log('='.repeat(60));
  console.log('🔍 SAMPLE TRADES');
  console.log('='.repeat(60));
  console.log('');
  
  console.log('First 5 Trades:');
  trades.slice(0, 5).forEach(t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    console.log(`${t.id}. ${t.direction.toUpperCase()} @ $${t.entryPrice.toFixed(0)} | ${date} | Exit: ${t.exitType} | R: ${t.rMultiple.toFixed(2)}R`);
  });
  console.log('');
  
  const sortedByR = [...trades].sort((a, b) => b.rMultiple - a.rMultiple);
  console.log('Best 5 Trades (by R):');
  sortedByR.slice(0, 5).forEach(t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    console.log(`${t.id}. ${t.direction.toUpperCase()} @ $${t.entryPrice.toFixed(0)} | ${date} | Exit: ${t.exitType} | R: ${t.rMultiple.toFixed(2)}R`);
  });
  console.log('');
  
  console.log('Worst 5 Trades (by R):');
  sortedByR.slice(-5).reverse().forEach(t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    console.log(`${t.id}. ${t.direction.toUpperCase()} @ $${t.entryPrice.toFixed(0)} | ${date} | Exit: ${t.exitType} | R: ${t.rMultiple.toFixed(2)}R`);
  });
  console.log('');
  
  // Save results
  const results = {
    config: CONFIG,
    summary: {
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: parseFloat(winRate.toFixed(2)),
      avgR: parseFloat(avgR.toFixed(3)),
      totalR: parseFloat(totalR.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(3)),
      avgLoss: parseFloat(avgLoss.toFixed(3)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2))
    },
    trades: trades.map(t => ({
      id: t.id,
      direction: t.direction,
      entryTime: new Date(t.entryTime).toISOString(),
      entryPrice: t.entryPrice,
      exitTime: new Date(t.exitTime).toISOString(),
      exitPrice: t.exitPrice,
      exitType: t.exitType,
      rMultiple: parseFloat(t.rMultiple.toFixed(3)),
      confidence: t.confidence,
      reason: t.reason
    }))
  };
  
  const outputPath = join(__dirname, 'results', 'btc-4h-backtest.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`✅ Results saved to: ${outputPath}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('✅ Backtest Complete!');
  console.log('='.repeat(60));
}

// Run backtest
runBacktest().catch(console.error);

