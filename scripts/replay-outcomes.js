#!/usr/bin/env node
/**
 * Replay outcome scoring (trading-model quick pass Q4; master plan M1).
 *
 * Reads scripts/replay.js's JSONL plus the same stored 1m candle history it replayed
 * against, and scores every valid strategy signal and every confirmed flag candidate:
 * did price fill the entry, then hit stop or TP1 first, and how long did it take. No
 * production code changes here - this only reads the replay output and walks candles
 * forward, the same no-lookahead discipline scripts/replay.js already applies.
 *
 * Usage:
 *   node scripts/replay-outcomes.js <replay.jsonl> <historyDir> [--json <file>]
 *
 * `historyDir` is a directory written by `scripts/replay.js --capture` (or matching its
 * `<SYMBOL>_1m.json` shape); only the 1m file per symbol is read.
 *
 * Dedupe: a strategy's signal (direction + entry zone + stop + TP1) counts once and is
 * walked once; it is re-armed only after that strategy goes invalid or the numbers
 * change. A confirmed flag candidate is identified by its (timeframe:direction,
 * startedAt) track (the pair scripts/replay-metrics.js already uses) and is walked once,
 * from its first `confirmed` close.
 *
 * Entry fill: the entry zone must be touched within `replay.outcomes.fillWindowCandles`
 * 1m candles of the close that produced the signal, else "not filled". Once filled, the
 * first candle to touch stop or TP1 decides the outcome; both in the same candle count
 * as a loss (conservative). A trade that touches neither within
 * `replay.outcomes.maxHoldCandles` reads "open" and is excluded from win/loss.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';
import { readJsonl } from './replay-metrics.js';
import { readHistoryFile } from './replay.js';

const STRATEGY_NAMES = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, n = 4) {
  return isFiniteNumber(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2, 2);
}

/**
 * Walk 1m candles forward from `fromMs` looking for the entry zone, then for stop or
 * target. No lookahead: only candles at or after `fromMs` are ever read.
 * @param {Object} p
 * @param {Array<{timestamp:number, high:number, low:number}>} p.candles1m - ascending
 * @param {number} p.fromMs - the signal's closedThrough, in ms
 * @param {'long'|'short'} p.direction
 * @param {number} p.entryMin
 * @param {number} p.entryMax
 * @param {number} p.stop
 * @param {number} p.target
 * @param {number} p.fillWindowCandles
 * @param {number} p.maxHoldCandles
 * @returns {{status:'invalid_levels'|'not_filled'|'open'|'win'|'loss', r?:number, holdCandles?:number, timeToTP1Candles?:number}}
 */
export function walkOutcome({ candles1m, fromMs, direction, entryMin, entryMax, stop, target, fillWindowCandles, maxHoldCandles }) {
  if (!Array.isArray(candles1m) || !isFiniteNumber(entryMin) || !isFiniteNumber(entryMax)
    || !isFiniteNumber(stop) || !isFiniteNumber(target)) {
    return { status: 'invalid_levels' };
  }

  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;

  const zoneLow = Math.min(entryMin, entryMax);
  const zoneHigh = Math.max(entryMin, entryMax);
  const fillEnd = Math.min(candles1m.length, start + fillWindowCandles);
  let fillIdx = -1;
  for (let i = start; i < fillEnd; i++) {
    const c = candles1m[i];
    if (c.low <= zoneHigh && c.high >= zoneLow) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return { status: 'not_filled' };

  const entry = (entryMin + entryMax) / 2;
  const long = direction !== 'short';
  const rTarget = round(Math.abs(target - entry) / Math.abs(entry - stop), 4);

  const exitEnd = Math.min(candles1m.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = candles1m[i];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    const holdCandles = i - fillIdx + 1;
    if (stopHit) return { status: 'loss', r: -1, holdCandles, ambiguous: targetHit };
    if (targetHit) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
  }
  return { status: 'open', holdCandles: exitEnd - fillIdx };
}

/** `${direction}|${entryMin}|${entryMax}|${stop}|${target}`, or null for no/invalid signal. */
function strategySignature(s) {
  if (!s || !s.valid || !s.direction || !s.entryZone) return null;
  const target = Array.isArray(s.targets) && s.targets.length ? s.targets[0] : null;
  if (!isFiniteNumber(s.entryZone.min) || !isFiniteNumber(s.entryZone.max) || !isFiniteNumber(s.stopLoss) || !isFiniteNumber(target)) return null;
  return `${s.direction}|${s.entryZone.min}|${s.entryZone.max}|${s.stopLoss}|${target}`;
}

/**
 * One entry per new (re-armed) strategy signal, in the order it first appears, for one
 * symbol's replay lines.
 * @param {Array<Object>} lines - replay JSONL records for one symbol, chronological
 * @returns {Array<{strategy:string, direction:'long'|'short', entryMin:number, entryMax:number, stop:number, target:number, signalCloseMs:number}>}
 */
export function extractStrategySignals(lines) {
  const out = [];
  for (const name of STRATEGY_NAMES) {
    let lastSig = null;
    for (const line of lines) {
      const s = line.strategies && line.strategies[name];
      const sig = strategySignature(s);
      if (sig && sig !== lastSig) {
        out.push({
          strategy: name,
          direction: s.direction === 'SHORT' ? 'short' : 'long',
          entryMin: s.entryZone.min,
          entryMax: s.entryZone.max,
          stop: s.stopLoss,
          target: s.targets[0],
          signalCloseMs: Date.parse(line.closedThrough)
        });
      }
      lastSig = sig;
    }
  }
  return out;
}

/**
 * One entry per distinct flag candidate the moment it first reads `confirmed`, using
 * breakoutLevel as entry, invalidation as stop, and the Q1 measuredTarget as TP1.
 * @param {Array<Object>} lines - replay JSONL records for one symbol, chronological
 * @returns {Array<{strategy:'FLAG_MEASURED', timeframe:string, direction:'long'|'short', entryMin:number, entryMax:number, stop:number, target:number, signalCloseMs:number}>}
 */
export function extractCandidateSignals(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    for (const c of line.candidateLifecycle || []) {
      if (c.state !== 'confirmed') continue;
      const id = `${c.ref}|${c.startedAt}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!isFiniteNumber(c.breakoutLevel) || !isFiniteNumber(c.invalidation) || !isFiniteNumber(c.measuredTarget)) continue;
      const [timeframe, direction] = c.ref.split(':');
      out.push({
        strategy: 'FLAG_MEASURED',
        timeframe,
        direction,
        entryMin: c.breakoutLevel,
        entryMax: c.breakoutLevel,
        stop: c.invalidation,
        target: c.measuredTarget,
        signalCloseMs: Date.parse(line.closedThrough)
      });
    }
  }
  return out;
}

/**
 * Aggregate outcomes per (strategy, direction).
 * @param {Array<Object>} signals - extractStrategySignals/extractCandidateSignals output
 * @param {Array<Object>} candles1m - ascending, one symbol
 * @param {Object} [cfg=ENGINE_CONFIG.replay.outcomes]
 * @returns {Array<Object>} one row per (strategy, direction) that produced at least one signal
 */
export function aggregateOutcomes(signals, candles1m, cfg = ENGINE_CONFIG.replay.outcomes) {
  const groups = new Map();
  for (const sig of signals) {
    const key = `${sig.strategy}|${sig.direction}`;
    if (!groups.has(key)) {
      groups.set(key, {
        strategy: sig.strategy, direction: sig.direction,
        signals: 0, fills: 0, wins: 0, losses: 0, open: 0,
        rWins: [], timesToTP1: [], streak: 0, maxStreak: 0
      });
    }
    const g = groups.get(key);
    g.signals++;

    const outcome = walkOutcome({
      candles1m,
      fromMs: sig.signalCloseMs,
      direction: sig.direction,
      entryMin: sig.entryMin,
      entryMax: sig.entryMax,
      stop: sig.stop,
      target: sig.target,
      fillWindowCandles: cfg.fillWindowCandles,
      maxHoldCandles: cfg.maxHoldCandles
    });

    if (outcome.status === 'not_filled' || outcome.status === 'invalid_levels') continue;
    g.fills++;
    if (outcome.status === 'open') { g.open++; continue; }
    if (outcome.status === 'win') {
      g.wins++;
      g.rWins.push(outcome.r);
      g.timesToTP1.push(outcome.timeToTP1Candles);
      g.streak = 0;
    } else {
      g.losses++;
      g.streak++;
      g.maxStreak = Math.max(g.maxStreak, g.streak);
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const decided = g.wins + g.losses;
    const winRate = decided ? round(g.wins / decided) : null;
    const avgWinR = g.rWins.length ? round(g.rWins.reduce((a, b) => a + b, 0) / g.rWins.length) : null;
    const expectancy = decided ? round(winRate * (avgWinR ?? 0) + (1 - winRate) * -1) : null;
    rows.push({
      strategy: g.strategy,
      direction: g.direction,
      signals: g.signals,
      fills: g.fills,
      wins: g.wins,
      losses: g.losses,
      open: g.open,
      winRate,
      avgWinR,
      expectancy,
      maxConsecutiveLosses: g.maxStreak,
      medianTimeToTP1Candles: median(g.timesToTP1)
    });
  }
  return rows;
}

/**
 * Score one symbol's replay lines against its 1m history: strategy signals and
 * confirmed-flag (measured-move) signals, separately.
 * @param {Array<Object>} lines - one symbol's replay JSONL records, chronological
 * @param {Array<Object>} candles1m - ascending 1m candles for the same symbol
 * @param {Object} [cfg=ENGINE_CONFIG.replay.outcomes]
 * @returns {{strategies:Array<Object>, flagMeasuredMove:Array<Object>}}
 */
export function scoreSymbol(lines, candles1m, cfg = ENGINE_CONFIG.replay.outcomes) {
  return {
    strategies: aggregateOutcomes(extractStrategySignals(lines), candles1m, cfg),
    flagMeasuredMove: aggregateOutcomes(extractCandidateSignals(lines), candles1m, cfg)
  };
}

function table(rows) {
  if (!rows.length) return '  (none)';
  const header = ['strategy', 'dir', 'signals', 'fills', 'wins', 'losses', 'open', 'winRate', 'avgWinR', 'expectancy', 'maxLossStreak', 'medianTimeToTP1'];
  const body = rows.map((r) => [r.strategy, r.direction, r.signals, r.fills, r.wins, r.losses, r.open, r.winRate, r.avgWinR, r.expectancy, r.maxConsecutiveLosses, r.medianTimeToTP1Candles]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  return all.map((row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')).join('\n');
}

async function main() {
  const [, , jsonlFile, historyDir, ...rest] = process.argv;
  if (!jsonlFile || !historyDir) {
    throw new Error('usage: replay-outcomes.js <replay.jsonl> <historyDir> [--json <file>]');
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];

  const lines = readJsonl(jsonlFile);
  const bySymbol = new Map();
  for (const line of lines) {
    if (!bySymbol.has(line.symbol)) bySymbol.set(line.symbol, []);
    bySymbol.get(line.symbol).push(line);
  }

  const out = {};
  for (const [symbol, symLines] of bySymbol) {
    const historyFile = path.join(historyDir, `${symbol}_1m.json`);
    const candles1m = readHistoryFile(historyFile);
    out[symbol] = scoreSymbol(symLines, candles1m);
    console.log(`\n${symbol} - strategies`);
    console.log(table(out[symbol].strategies));
    console.log(`\n${symbol} - flag measured-move (confirmed candidates, Q1 target)`);
    console.log(table(out[symbol].flagMeasuredMove));
  }

  console.log('');
  console.log(JSON.stringify(out, null, 2));
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-outcomes] ${err.message}`);
    process.exit(1);
  });
}
