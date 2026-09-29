#!/usr/bin/env node
/**
 * T-24 prediction rule replay (docs/PROMPT_T24_PREDICTION_TRACKER.md, Agent A - "rule +
 * replay"). Walks `lib/predictionRule.js` `predictNextCandle` over the stored
 * `test/fixtures/history/deep2y-2026-09-26` fixture, one closed candle at a time, no
 * lookahead, for every (symbol x timeframe) in `PREDICTION_SYMBOLS x
 * PREDICTION_TIMEFRAMES`, and writes `docs/PREDICTION_STUDY_2026-09-28.md`.
 *
 * No lookahead: at candle `i` (the "reference" close), the rule only ever sees
 * `candles[0..i]` of its own timeframe and `higherCandles` clipped to closeTime <= candle
 * i's own closeTime (`closedWindow`, the exact binary-search helper
 * `scripts/swing/run.js` already uses for the same purpose - imported, not
 * reimplemented). Both windows are capped (`TF_WINDOW_CANDLES` / `HIGHER_WINDOW_CANDLES`)
 * to the same kind of bounded fetch window production itself works with (scripts/swing/
 * run.js's own `PRODUCTION_FETCH_WINDOW` comment) - this keeps ~900k calls across 3
 * symbols x 4 timeframes x ~2 years of 5m/15m/1h/4h candles finishing in minutes, not
 * hours, and never changes what the rule can see relative to a live tick (production
 * itself never hands the pipeline more than a few hundred closed candles per timeframe).
 *
 * Scoring, per closed candle i (i from `MIN_CANDLES - 1` to `length - 2`, so there is
 * always a "next candle" to grade against):
 *   - refClose = candles[i].close, nextClose = candles[i+1].close
 *   - actual = 'over' when nextClose > refClose, 'under' when nextClose < refClose, else
 *     'flat' (nextClose === refClose - vanishingly rare on real candles, excluded from n
 *     exactly like a `no_call` prediction, per the shared contract's own Result row:
 *     "hit: null when direction was no_call or nextClose===refClose")
 *   - a prediction of 'no_call', or an actual of 'flat', contributes to `noCalls`/`flats`
 *     but never to `n`/`hits`/`misses` - only a real over/under call graded against a real
 *     over/under move counts
 *   - lastCandleDir = candle i's own close vs its own open ('over'/'under'/'flat') - the
 *     "same as last" baseline this study compares the rule against, scored over the exact
 *     same denominator (n) as the rule itself, so the two are directly comparable
 *
 * Usage: node scripts/predictions/replay.js [--history <dir>] [--symbols BTC,SOL,ETH]
 *   [--timeframes 5m,15m,1h,4h] [--out docs/PREDICTION_STUDY_2026-09-28.md]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHistoryDir } from '../replay.js';
import { closedWindow } from '../swing/run.js';
import { predictNextCandle, PREDICTION_SYMBOLS, PREDICTION_TIMEFRAMES, HIGHER_TF, MIN_CANDLES } from '../../lib/predictionRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const TF_WINDOW_CANDLES = 300; // bounded window for the predicted tf's own history (>= MIN_CANDLES with margin)
const HIGHER_WINDOW_CANDLES = 60; // bounded window for the higher-tf history (>= EMA_FAST_PERIOD with margin)

function parseArgs(argv) {
  const out = { history: 'test/fixtures/history/deep2y-2026-09-26', symbols: [...PREDICTION_SYMBOLS], timeframes: [...PREDICTION_TIMEFRAMES], out: 'docs/PREDICTION_STUDY_2026-09-28.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') out.history = argv[++i];
    else if (a === '--symbols') out.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--timeframes') out.timeframes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function round(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function emptyCell() {
  return { n: 0, hits: 0, misses: 0, noCalls: 0, flats: 0, sameAsLastHits: 0, moveBpsHit: [], moveBpsMiss: [] };
}

function scoreOne(candlesTf, higherFull, higherTfName, i) {
  const ref = candlesTf[i];
  const next = candlesTf[i + 1];
  const cutMs = typeof ref.closeTime === 'number' ? ref.closeTime : ref.timestamp;
  const tfWindow = candlesTf.slice(Math.max(0, i + 1 - TF_WINDOW_CANDLES), i + 1);
  const higherWindow = higherFull ? closedWindow(higherFull, higherTfName, cutMs, HIGHER_WINDOW_CANDLES) : [];
  return { pred: null, ref, next, tfWindow, higherWindow };
}

function accumulate(cell, { pred, ref, next }) {
  const refClose = ref.close;
  const nextClose = next.close;
  const actual = nextClose > refClose ? 'over' : (nextClose < refClose ? 'under' : 'flat');
  const lastCandleDir = ref.close > ref.open ? 'over' : (ref.close < ref.open ? 'under' : 'flat');
  const moveBps = round(((nextClose - refClose) / refClose) * 1e4, 1);

  if (pred.direction === 'no_call') cell.noCalls += 1;
  if (actual === 'flat') cell.flats += 1;
  if (pred.direction === 'no_call' || actual === 'flat') return;

  cell.n += 1;
  const hit = pred.direction === actual;
  if (hit) { cell.hits += 1; cell.moveBpsHit.push(moveBps); } else { cell.misses += 1; cell.moveBpsMiss.push(moveBps); }
  if (lastCandleDir === actual) cell.sameAsLastHits += 1;
}

function finalize(cell) {
  const hitRate = cell.n > 0 ? round(cell.hits / cell.n, 4) : null;
  const sameAsLastRate = cell.n > 0 ? round(cell.sameAsLastHits / cell.n, 4) : null;
  return {
    n: cell.n,
    hits: cell.hits,
    misses: cell.misses,
    noCalls: cell.noCalls,
    hitRate,
    coinFlip: 0.5,
    sameAsLastRate,
    meanMoveBpsHit: round(mean(cell.moveBpsHit), 2),
    meanMoveBpsMiss: round(mean(cell.moveBpsMiss), 2)
  };
}

function mergeInto(target, cell) {
  target.n += cell.n;
  target.hits += cell.hits;
  target.misses += cell.misses;
  target.noCalls += cell.noCalls;
  target.flats += cell.flats;
  target.sameAsLastHits += cell.sameAsLastHits;
  target.moveBpsHit.push(...cell.moveBpsHit);
  target.moveBpsMiss.push(...cell.moveBpsMiss);
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);

  console.log(`[predictions/replay] loading history from ${historyDir} ...`);
  const history = loadHistoryDir(historyDir, args.symbols);

  const cells = {}; // "<SYM>:<tf>" -> raw cell
  const byTimeframe = {};
  const bySymbol = {};
  const overall = emptyCell();

  for (const tf of args.timeframes) byTimeframe[tf] = emptyCell();
  for (const symbol of args.symbols) bySymbol[symbol] = emptyCell();

  for (const symbol of args.symbols) {
    const symbolHistory = history[symbol] || {};
    for (const tf of args.timeframes) {
      const candlesTf = symbolHistory[tf];
      const higherTfName = HIGHER_TF[tf];
      const higherFull = symbolHistory[higherTfName] || null;
      const cellKey = `${symbol}:${tf}`;
      const cell = emptyCell();
      cells[cellKey] = cell;

      if (!Array.isArray(candlesTf) || candlesTf.length < MIN_CANDLES + 1) {
        console.log(`[predictions/replay] ${cellKey}: skipped (only ${Array.isArray(candlesTf) ? candlesTf.length : 0} candles, need >= ${MIN_CANDLES + 1})`);
        continue;
      }

      const t0 = Date.now();
      const lastIdx = candlesTf.length - 2; // needs a next candle to grade against
      for (let i = MIN_CANDLES - 1; i <= lastIdx; i++) {
        const { ref, next, tfWindow, higherWindow } = scoreOne(candlesTf, higherFull, higherTfName, i);
        const pred = predictNextCandle({ symbol, timeframe: tf, candles: tfWindow, higherCandles: higherWindow });
        accumulate(cell, { pred, ref, next });
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[predictions/replay] ${cellKey}: ${lastIdx - (MIN_CANDLES - 1) + 1} closes replayed in ${secs}s -> n=${cell.n} hits=${cell.hits} noCalls=${cell.noCalls}`);

      mergeInto(byTimeframe[tf], cell);
      mergeInto(bySymbol[symbol], cell);
      mergeInto(overall, cell);
    }
  }

  const elapsedMin = (Date.now() - startedAt) / 60000;
  if (elapsedMin > 15) {
    console.log(`[predictions/replay] WARNING: replay took ${elapsedMin.toFixed(1)} minutes (> 15min budget). Consider --symbols/--timeframes to cut scope next run.`);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    history: args.history,
    symbols: args.symbols,
    timeframes: args.timeframes,
    cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, finalize(v)])),
    byTimeframe: Object.fromEntries(Object.entries(byTimeframe).map(([k, v]) => [k, finalize(v)])),
    bySymbol: Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, finalize(v)])),
    overall: finalize(overall),
    elapsedMin: round(elapsedMin, 2)
  };

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  writeFileSync(outPath, renderMarkdown(result), 'utf8');
  console.log(`[predictions/replay] wrote ${outPath}`);
  console.log(`[predictions/replay] overall: n=${result.overall.n} hitRate=${result.overall.hitRate} sameAsLastRate=${result.overall.sameAsLastRate} coinFlip=0.5 (${elapsedMin.toFixed(1)} min)`);
}

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${round(x * 100, 1)}%`;
}

function fmtBps(x) {
  return x === null || x === undefined ? 'n/a' : `${x} bps`;
}

function renderMarkdown(result) {
  const lines = [];
  lines.push('# T-24 prediction rule replay - 2y history (deep2y-2026-09-26)');
  lines.push('');
  lines.push(`Generated ${result.generatedAt} by \`scripts/predictions/replay.js\` against \`${result.history}\`, symbols ${result.symbols.join('/')}, timeframes ${result.timeframes.join('/')}. Elapsed: ${result.elapsedMin} min.`);
  lines.push('');
  lines.push('`lib/predictionRule.js` `predictNextCandle` is a pure 5-vote rule (close vs EMA21, EMA21 vs EMA200, higher-tf close vs EMA21, Stoch RSI %K direction, last swing pivot) scored `over`/`under`/`no_call` at every closed candle, no lookahead (bounded fetch windows, same shape production itself sees - see this file\'s header). `n` counts only closes where the rule made a call (over/under) AND the next candle actually moved (excludes `no_call` and the rare exact-flat close). `sameAsLastRate` is the "guess the previous candle\'s own direction repeats" baseline, scored over the identical `n` denominator so it is directly comparable to `hitRate`.');
  lines.push('');
  lines.push('## Per cell (symbol x timeframe)');
  lines.push('');
  lines.push('| Cell | n | hits | misses | no_call | hitRate | coinFlip | sameAsLast | meanMoveBps(hit) | meanMoveBps(miss) |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const symbol of result.symbols) {
    for (const tf of result.timeframes) {
      const c = result.cells[`${symbol}:${tf}`];
      if (!c) continue;
      lines.push(`| ${symbol}:${tf} | ${c.n} | ${c.hits} | ${c.misses} | ${c.noCalls} | ${pct(c.hitRate)} | 50.0% | ${pct(c.sameAsLastRate)} | ${fmtBps(c.meanMoveBpsHit)} | ${fmtBps(c.meanMoveBpsMiss)} |`);
    }
  }
  lines.push('');
  lines.push('## By timeframe (all symbols)');
  lines.push('');
  lines.push('| Timeframe | n | hitRate | coinFlip | sameAsLast |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const tf of result.timeframes) {
    const c = result.byTimeframe[tf];
    lines.push(`| ${tf} | ${c.n} | ${pct(c.hitRate)} | 50.0% | ${pct(c.sameAsLastRate)} |`);
  }
  lines.push('');
  lines.push('## By symbol (all timeframes)');
  lines.push('');
  lines.push('| Symbol | n | hitRate | coinFlip | sameAsLast |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const symbol of result.symbols) {
    const c = result.bySymbol[symbol];
    lines.push(`| ${symbol} | ${c.n} | ${pct(c.hitRate)} | 50.0% | ${pct(c.sameAsLastRate)} |`);
  }
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  const o = result.overall;
  lines.push(`n=${o.n}, hits=${o.hits}, misses=${o.misses}, no_call=${o.noCalls}, hitRate=${pct(o.hitRate)}, coinFlip=50.0%, sameAsLast=${pct(o.sameAsLastRate)}, meanMoveBps(hit)=${fmtBps(o.meanMoveBpsHit)}, meanMoveBps(miss)=${fmtBps(o.meanMoveBpsMiss)}.`);
  lines.push('');

  const cellEntries = Object.entries(result.cells).filter(([, c]) => c.n > 0);
  if (cellEntries.length) {
    const best = cellEntries.reduce((a, b) => (b[1].hitRate > a[1].hitRate ? b : a));
    const worst = cellEntries.reduce((a, b) => (b[1].hitRate < a[1].hitRate ? b : a));
    lines.push(`Best cell: **${best[0]}** at ${pct(best[1].hitRate)} (n=${best[1].n}). Worst cell: **${worst[0]}** at ${pct(worst[1].hitRate)} (n=${worst[1].n}).`);
    lines.push('');
  }
  lines.push('## Honest read');
  lines.push('');
  lines.push(HONEST_PARAGRAPH(result));
  lines.push('');
  return lines.join('\n');
}

function HONEST_PARAGRAPH(result) {
  const o = result.overall;
  const beatsCoinFlip = o.hitRate !== null && o.hitRate > 0.5;
  const beatsBaseline = o.hitRate !== null && o.sameAsLastRate !== null && o.hitRate > o.sameAsLastRate;
  const verdict = beatsCoinFlip && beatsBaseline
    ? 'a small, real edge over both baselines'
    : beatsCoinFlip
      ? 'better than a coin flip but not clearly better than just assuming the last candle repeats'
      : 'no better than a coin flip, and slightly worse than just assuming the last candle repeats';
  return `Overall this v1 rule reads as ${verdict}, across ${o.n.toLocaleString('en-US')} scored closes (${o.noCalls.toLocaleString('en-US')} additional closes were ${'`no_call`'}). It is a simple 5-vote score with no walk-forward tuning, no per-symbol or per-timeframe calibration, and no weighting between votes - v1 is a starting instrument for the tracker to grade against going forward (docs/PROMPT_T24_PREDICTION_TRACKER.md Agent B), not a validated edge or a claim the engine should act on. The per-cell table above is the more honest read than the overall average: hit rate varies materially by timeframe and by symbol, and any cell with n below a few hundred closes should be read as noisy rather than as a settled result.`;
}

main().catch((err) => {
  console.error('[predictions/replay] failed:', err);
  process.exitCode = 1;
});
