/**
 * BTC 4H Strategy Backtest
 *
 * Tests the existing 4H strategy engine against historical data
 * Timeframes: 3d, 1d, 4h, 1h, 15m, 5m
 * Symbol: BTCUSDT
 * Period: 2020-01-01 to now
 *
 * Data comes from ccxt by default. Where exchange hosts are unreachable, set
 * BACKTEST_CSV / BACKTEST_CSV_<TF> to run the same backtest from CSV files
 * (see loadCandlesFromCsv).
 */

import ccxt from 'ccxt';
import * as indicatorService from '../services/indicators.js';
import * as strategyService from '../services/strategy.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  symbol: 'BTC/USDT',
  startDate: '2020-01-01', // Start from 2020 (more reliable data)
  primaryTimeframe: '4h',
  /**
   * 3d/1d are here because the confidence engine forfeits a layer's weight
   * when that layer has no data (see "evidence coverage" in services/strategy.js).
   * With no daily-or-higher timeframe a TREND_4H signal tops out at
   * 75 * (0.35 + 0.25) = 45, below its own 60 gate, so the backtest would
   * report zero trades however good the setups were.
   */
  timeframes: ['3d', '1d', '4h', '1h', '15m', '5m'],
  setupType: '4h',
  mode: 'STANDARD',
  exchange: 'binance',
  maxCandles: 1000, // Per fetch
  lookbackCandles: 500, // Same window the live API hands the strategy
  slippage: 0.001, // 0.1% slippage
  commission: 0.0004 // 0.04% taker fee
};

// Length of one bar, used to work out when a bar has closed
const TIMEFRAME_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000
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
 * A candle we are willing to trade on.
 * Real OHLCV exports encode "missing" as 1.7e+308, which passes isFinite,
 * so the value has to be bounded as well as finite.
 */
function isSaneCandle(candle) {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  return prices.every(p => Number.isFinite(p) && p > 0 && p < 1e9);
}

/**
 * Parse a timestamp cell: epoch seconds, epoch millis, or a date string.
 */
function parseTimestamp(value) {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // Anything below ~1e11 is too small to be millis, so treat it as seconds
    return asNumber < 1e11 ? asNumber * 1000 : asNumber;
  }
  return Date.parse(value);
}

/**
 * Load candles for ONE timeframe from a CSV file.
 *
 * The file must already be at the timeframe it is supplied for - one file per
 * timeframe via BACKTEST_CSV_4H / BACKTEST_CSV_1H / etc. Resampling inside the
 * harness would mean re-deriving OHLCV (and getting bar boundaries, gaps and
 * partial bars right) for no gain, since exporting a second file from the same
 * source costs nothing.
 *
 * Header names are matched case-insensitively; a timestamp column plus
 * open/high/low/close is required, volume is optional.
 */
function loadCandlesFromCsv(path, timeframe) {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));

  const findColumn = names => header.findIndex(h => names.includes(h));
  const timeIndex = findColumn(['timestamp', 'time', 'date', 'datetime', 'open_time', 'opentime']);
  const openIndex = findColumn(['open']);
  const highIndex = findColumn(['high']);
  const lowIndex = findColumn(['low']);
  const closeIndex = findColumn(['close']);
  const volumeIndex = findColumn(['volume', 'vol']);

  if (timeIndex < 0 || openIndex < 0 || highIndex < 0 || lowIndex < 0 || closeIndex < 0) {
    throw new Error(`${path}: need timestamp/open/high/low/close columns, got: ${header.join(', ')}`);
  }

  const startTimestamp = new Date(CONFIG.startDate).getTime();
  const candles = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < header.length) continue;

    const candle = {
      timestamp: parseTimestamp(cells[timeIndex].trim().replace(/"/g, '')),
      open: Number(cells[openIndex]),
      high: Number(cells[highIndex]),
      low: Number(cells[lowIndex]),
      close: Number(cells[closeIndex]),
      volume: volumeIndex >= 0 ? Number(cells[volumeIndex]) : 0
    };

    if (!Number.isFinite(candle.timestamp) || !isSaneCandle(candle)) {
      skipped++;
      continue;
    }
    // Same period as the ccxt path, so both produce comparable results
    if (candle.timestamp < startTimestamp) continue;
    if (!Number.isFinite(candle.volume)) candle.volume = 0;

    candles.push(candle);
  }

  // Vendors export newest-first about as often as oldest-first
  candles.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`✅ Loaded ${candles.length} ${timeframe} candles from ${path}` +
    (skipped > 0 ? ` (skipped ${skipped} bad rows)` : ''));

  return candles;
}

/**
 * CSV file configured for a timeframe, or null if there is none.
 */
function csvPathFor(timeframe) {
  const specific = process.env[`BACKTEST_CSV_${timeframe.toUpperCase()}`];
  if (specific) return specific;
  // Plain BACKTEST_CSV is shorthand for the primary timeframe's file
  if (timeframe === CONFIG.primaryTimeframe && process.env.BACKTEST_CSV) {
    return process.env.BACKTEST_CSV;
  }
  return null;
}

/**
 * Build the per-timeframe object the API layer hands the strategy engine.
 * Shape must match api/analyze.js - the engine reads swing levels off
 * `structure`, not off `indicators`.
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
        candleCount: candles.length,
        lastCandle: candles[candles.length - 1]
      };
    }

    const result = strategyService.evaluateStrategy(
      CONFIG.symbol,
      analysis,
      CONFIG.setupType,
      CONFIG.mode
    );

    // The canonical result is { symbol, price, htfBias, timeframes, signal, meta }
    return result.signal;

  } catch (error) {
    console.error('Analysis error:', error.message);
    return { valid: false };
  }
}

/**
 * Candles visible at `timestamp`, capped to the same window the live API
 * feeds the strategy, so indicators see the same input they see in production.
 */
function getCandlesUpTo(candles, timestamp) {
  const visible = candles.filter(c => c.timestamp <= timestamp);
  return visible.slice(-CONFIG.lookbackCandles);
}

/**
 * Check if trade hit SL or TP. SL is checked first: when a single bar covers
 * both levels we cannot tell which came first, so assume the worse one.
 */
function checkTradeExit(trade, candle) {
  if (trade.direction === 'long') {
    if (candle.low <= trade.stopLoss) {
      return { type: 'SL', price: trade.stopLoss };
    }
    if (candle.high >= trade.target) {
      return { type: 'TP1', price: trade.target };
    }
  } else {
    if (candle.high >= trade.stopLoss) {
      return { type: 'SL', price: trade.stopLoss };
    }
    if (candle.low <= trade.target) {
      return { type: 'TP1', price: trade.target };
    }
  }

  return null;
}

/**
 * Realised R for a trade, net of costs.
 *
 * Slippage and commission are both charged twice - once entering, once
 * exiting - and are expressed in R by dividing the per-unit cost by the
 * per-unit risk, so they subtract straight off the gross R.
 */
function realisedR(trade, exitPrice) {
  const gross = trade.direction === 'long'
    ? (exitPrice - trade.entryPrice) / trade.risk
    : (trade.entryPrice - exitPrice) / trade.risk;

  const rate = CONFIG.slippage + CONFIG.commission;
  const cost = (trade.entryPrice * rate + exitPrice * rate) / trade.risk;

  return gross - cost;
}

// ---- Metrics -------------------------------------------------------------

function sum(values) {
  return values.reduce((total, v) => total + v, 0);
}

function mean(values) {
  return values.length > 0 ? sum(values) / values.length : 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Gross win / gross loss. Infinity when there is nothing on the loss side. */
function profitFactor(rs) {
  const grossWin = sum(rs.filter(r => r > 0));
  const grossLoss = Math.abs(sum(rs.filter(r => r < 0)));
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
}

/** Deepest peak-to-trough fall of the cumulative R curve. */
function maxDrawdown(rs) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    if (peak - equity > worst) worst = peak - equity;
  }
  return worst;
}

function maxConsecutiveLosses(rs) {
  let current = 0;
  let worst = 0;
  for (const r of rs) {
    current = r < 0 ? current + 1 : 0;
    if (current > worst) worst = current;
  }
  return worst;
}

function round(value, decimals) {
  if (!Number.isFinite(value)) return value;
  return parseFloat(value.toFixed(decimals));
}

/** Headline numbers for any subset of trades (all, longs, one bucket, ...). */
function summarise(trades) {
  const rs = trades.map(t => t.rMultiple);
  const wins = rs.filter(r => r > 0);
  return {
    trades: trades.length,
    winRate: trades.length > 0 ? round((wins.length / trades.length) * 100, 2) : 0,
    expectancy: round(mean(rs), 3),
    medianR: round(median(rs), 3),
    totalR: round(sum(rs), 2)
  };
}

const CONFIDENCE_BUCKETS = [
  { label: '0-60', min: 0, max: 60 },
  { label: '60-70', min: 60, max: 70 },
  { label: '70-80', min: 70, max: 80 },
  { label: '80-90', min: 80, max: 90 },
  { label: '90-100', min: 90, max: 101 }
];

function bucketByConfidence(trades) {
  const buckets = {};
  for (const bucket of CONFIDENCE_BUCKETS) {
    const inBucket = trades.filter(t => t.confidence >= bucket.min && t.confidence < bucket.max);
    buckets[bucket.label] = summarise(inBucket);
  }
  return buckets;
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
  console.log(`Setup: ${CONFIG.setupType} (${CONFIG.mode})`);
  console.log(`Timeframes: ${CONFIG.timeframes.join(', ')}`);
  console.log('='.repeat(60));
  console.log('');

  // Load all historical data (CSV where configured, otherwise the exchange)
  const startTimestamp = new Date(CONFIG.startDate).getTime();
  const offline = Boolean(csvPathFor(CONFIG.primaryTimeframe));
  const candleData = {};

  for (const tf of CONFIG.timeframes) {
    const csvPath = csvPathFor(tf);

    if (csvPath) {
      candleData[tf] = loadCandlesFromCsv(csvPath, tf);
    } else if (offline) {
      // Offline run with no file for this timeframe: the strategy treats a
      // missing timeframe as missing evidence, which is honest enough
      console.log(`⚠️  No CSV for ${tf}, skipping timeframe`);
      candleData[tf] = [];
    } else {
      candleData[tf] = await fetchCandles(CONFIG.symbol, tf, startTimestamp);
    }

    if (tf === CONFIG.primaryTimeframe && candleData[tf].length === 0) {
      console.error(`❌ No data for ${tf}, aborting backtest`);
      return;
    }
  }

  console.log('');
  console.log('📊 Starting backtest simulation...');
  console.log('');

  const trades = [];
  let openTrade = null;

  // Iterate through primary timeframe candles
  const candles4h = candleData[CONFIG.primaryTimeframe];
  const barMs = TIMEFRAME_MS[CONFIG.primaryTimeframe];

  for (let i = 200; i < candles4h.length; i++) {
    const currentCandle = candles4h[i];
    const currentTime = currentCandle.timestamp;
    // Decisions are taken at bar close, so every timeframe is cut at the same
    // moment - otherwise the 4h bar would be complete while the 5m bars inside
    // it were not yet visible
    const decisionTime = currentTime + barMs - 1;

    // Progress indicator
    if (i % 100 === 0) {
      const progress = ((i / candles4h.length) * 100).toFixed(1);
      const date = new Date(currentTime).toISOString().split('T')[0];
      console.log(`Progress: ${progress}% | Date: ${date} | Trades: ${trades.length}`);
    }

    // Check if we have an open trade
    if (openTrade) {
      const exit = checkTradeExit(openTrade, currentCandle);

      if (exit) {
        const durationHours = (currentTime - openTrade.entryTime) / (1000 * 60 * 60);

        trades.push({
          ...openTrade,
          exitTime: currentTime,
          exitPrice: exit.price,
          exitType: exit.type,
          rMultiple: realisedR(openTrade, exit.price),
          duration: durationHours
        });

        openTrade = null;
      }

      continue; // Don't look for new trades while in position
    }

    // Build snapshot of all timeframes as of this bar's close
    const snapshot = {};
    for (const tf of CONFIG.timeframes) {
      snapshot[tf] = getCandlesUpTo(candleData[tf], decisionTime);
    }

    // Look for a new trade signal. No extra filters here on purpose: FLAT
    // trends and OVEREXTENDED pullbacks are already rejected by the engine,
    // and re-filtering would backtest something other than what ships.
    const signal = analyzeMarket(snapshot);

    if (!signal || !signal.valid) continue;

    // Trade the strategy's own levels: entry zone midpoint, its stop, its TP1
    const entry = (signal.entryZone.min + signal.entryZone.max) / 2;
    const stopLoss = signal.stopLoss;
    const target = signal.targets[0];
    const risk = Math.abs(entry - stopLoss);

    if (!Number.isFinite(risk) || risk === 0 || !Number.isFinite(target)) continue;

    openTrade = {
      id: trades.length + 1,
      direction: signal.direction,
      entryTime: currentTime,
      entryPrice: entry,
      stopLoss,
      target,
      risk,
      confidence: signal.confidence || 0,
      strategy: signal.selectedStrategy || 'N/A',
      reason: signal.reason || 'N/A'
    };
  }

  // Close any remaining open trade at the last candle
  if (openTrade) {
    const lastCandle = candles4h[candles4h.length - 1];
    trades.push({
      ...openTrade,
      exitTime: lastCandle.timestamp,
      exitPrice: lastCandle.close,
      exitType: 'OPEN_AT_END',
      rMultiple: realisedR(openTrade, lastCandle.close),
      duration: (lastCandle.timestamp - openTrade.entryTime) / (1000 * 60 * 60)
    });
  }

  // Calculate metrics
  console.log('');
  console.log('='.repeat(60));
  console.log('📈 BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log('');

  const rs = trades.map(t => t.rMultiple);
  const wins = trades.filter(t => t.rMultiple > 0);
  const losses = trades.filter(t => t.rMultiple < 0);
  const breakevens = trades.filter(t => t.rMultiple === 0);

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const expectancy = mean(rs);
  const totalR = sum(rs);
  const avgWin = mean(wins.map(t => t.rMultiple));
  const avgLoss = Math.abs(mean(losses.map(t => t.rMultiple)));

  // Trade frequency and exposure over the period actually covered
  const periodHours = candles4h.length > 1
    ? (candles4h[candles4h.length - 1].timestamp - candles4h[0].timestamp) / (1000 * 60 * 60)
    : 0;
  const tradesPerMonth = periodHours > 0 ? totalTrades / (periodHours / (24 * 30)) : 0;
  const exposure = periodHours > 0 ? (sum(trades.map(t => t.duration)) / periodHours) * 100 : 0;

  const longs = trades.filter(t => t.direction === 'long');
  const shorts = trades.filter(t => t.direction === 'short');

  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Wins: ${wins.length} | Losses: ${losses.length} | Breakeven: ${breakevens.length}`);
  console.log(`Win Rate: ${winRate.toFixed(2)}%`);
  console.log(`Expectancy: ${expectancy.toFixed(3)}R | Median: ${median(rs).toFixed(3)}R`);
  console.log(`Total R: ${totalR.toFixed(2)}R`);
  console.log(`Avg Win: ${avgWin.toFixed(3)}R | Avg Loss: ${avgLoss.toFixed(3)}R`);
  console.log(`Profit Factor: ${profitFactor(rs).toFixed(2)}`);
  console.log(`Max Drawdown: ${maxDrawdown(rs).toFixed(2)}R`);
  console.log(`Max Consecutive Losses: ${maxConsecutiveLosses(rs)}`);
  console.log(`Trade Frequency: ${tradesPerMonth.toFixed(2)}/month | Exposure: ${exposure.toFixed(1)}%`);
  console.log(`Longs: ${longs.length} (${summarise(longs).winRate}% win) | Shorts: ${shorts.length} (${summarise(shorts).winRate}% win)`);
  console.log('');

  console.log('By Confidence:');
  const byConfidence = bucketByConfidence(trades);
  for (const [label, stats] of Object.entries(byConfidence)) {
    console.log(`  ${label}: ${stats.trades} trades | ${stats.winRate}% win | ${stats.expectancy}R avg`);
  }
  console.log('');

  // Show sample trades
  console.log('='.repeat(60));
  console.log('🔍 SAMPLE TRADES');
  console.log('='.repeat(60));
  console.log('');

  const describe = t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    return `${t.id}. ${t.direction.toUpperCase()} @ $${t.entryPrice.toFixed(0)} | ${date} | Exit: ${t.exitType} | R: ${t.rMultiple.toFixed(2)}R`;
  };

  console.log('First 5 Trades:');
  trades.slice(0, 5).forEach(t => console.log(describe(t)));
  console.log('');

  const sortedByR = [...trades].sort((a, b) => b.rMultiple - a.rMultiple);
  console.log('Best 5 Trades (by R):');
  sortedByR.slice(0, 5).forEach(t => console.log(describe(t)));
  console.log('');

  console.log('Worst 5 Trades (by R):');
  sortedByR.slice(-5).reverse().forEach(t => console.log(describe(t)));
  console.log('');

  // Save results
  const results = {
    config: CONFIG,
    summary: {
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      winRate: round(winRate, 2),
      expectancy: round(expectancy, 3),
      medianR: round(median(rs), 3),
      totalR: round(totalR, 2),
      avgWin: round(avgWin, 3),
      avgLoss: round(avgLoss, 3),
      // JSON has no Infinity literal, so a loss-free run goes out as a string
      profitFactor: Number.isFinite(profitFactor(rs)) ? round(profitFactor(rs), 2) : 'Infinity',
      maxDrawdown: round(maxDrawdown(rs), 2),
      maxConsecutiveLosses: maxConsecutiveLosses(rs),
      tradesPerMonth: round(tradesPerMonth, 2),
      exposurePercent: round(exposure, 1),
      avgDurationHours: round(mean(trades.map(t => t.duration)), 1)
    },
    byDirection: {
      long: summarise(longs),
      short: summarise(shorts)
    },
    byConfidence,
    trades: trades.map(t => ({
      id: t.id,
      direction: t.direction,
      entryTime: new Date(t.entryTime).toISOString(),
      entryPrice: round(t.entryPrice, 2),
      stopLoss: round(t.stopLoss, 2),
      target: round(t.target, 2),
      exitTime: new Date(t.exitTime).toISOString(),
      exitPrice: round(t.exitPrice, 2),
      exitType: t.exitType,
      rMultiple: round(t.rMultiple, 3),
      duration: round(t.duration, 1),
      confidence: t.confidence,
      strategy: t.strategy,
      reason: t.reason
    }))
  };

  const outputDir = join(__dirname, 'results');
  mkdirSync(outputDir, { recursive: true }); // Not in git - nothing creates it for us
  const outputPath = join(outputDir, 'btc-4h-backtest.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`✅ Results saved to: ${outputPath}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('✅ Backtest Complete!');
  console.log('='.repeat(60));
}

// Run backtest
runBacktest().catch(console.error);
