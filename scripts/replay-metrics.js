#!/usr/bin/env node
/**
 * Replay metrics (engine refinement plan, phase 10). Reads scripts/replay.js JSONL.
 *
 * Usage: node scripts/replay-metrics.js <replay.jsonl> [--labels <dir>] [--json <file>]
 *
 * Prints a table, then the same numbers as JSON:
 *   - candidate appearances by state and direction (one per close a candidate is present)
 *     and the number of distinct candidates (symbol + timeframe:direction + start time)
 *   - visual-gate rate: fraction of closes with needsVisualConfirmation, overall and per code
 *   - average candidate lifetime, in candles of the candidate's own timeframe, first to
 *     last close it was seen
 *   - confirmed → failReason: of the candidates ever confirmed, how many later carried a
 *     failReason
 *   - precision/recall against `<labels>/<SYMBOL>.json` (default test/fixtures/labels):
 *     `[{ closedThrough, timeframe, direction, expected: forming|triggering|confirmed|none }]`.
 *     A failed candidate predicts `none`; a neutral coil predicts `forming` for either
 *     direction. Without a labels file the section reads "no labels yet".
 *
 * Label scoring (micro-averaged over labels): TP = expected ≠ none and predicted =
 * expected; FN = expected ≠ none and predicted ≠ expected; FP = predicted ≠ none and
 * predicted ≠ expected. A wrong non-none state counts as both FN and FP.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERVAL_MS } from '../services/scalpContext.js';

export const LABEL_STATES = ['forming', 'triggering', 'confirmed', 'none'];
const STATES = ['forming', 'triggering', 'confirmed', 'failed'];
const DIRECTIONS = ['long', 'short', 'neutral'];

const round = (v, n = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null);

export function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Load `<dir>/<SYMBOL>.json` for each symbol that has one. */
export function loadLabels(dir, symbols) {
  const out = {};
  for (const symbol of symbols) {
    const file = path.join(dir, `${symbol}.json`);
    if (existsSync(file)) out[symbol] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return out;
}

function predictedState(line, timeframe, direction) {
  const own = line.candidateLifecycle.find((c) => c.ref === `${timeframe}:${direction}`);
  if (own) return own.state === 'failed' ? 'none' : own.state;
  const coil = line.candidateLifecycle.find((c) => c.ref === `${timeframe}:neutral`);
  return coil && coil.state !== 'failed' ? coil.state : 'none';
}

function scoreLabels(lines, labelsBySymbol) {
  const symbols = Object.keys(labelsBySymbol);
  if (symbols.length === 0) return { status: 'no labels yet' };
  const byKey = new Map(lines.map((l) => [`${l.symbol}|${l.closedThrough}`, l]));
  const s = { status: 'scored', labels: 0, matched: 0, unmatched: 0, tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const symbol of symbols) {
    for (const label of labelsBySymbol[symbol]) {
      s.labels++;
      if (!LABEL_STATES.includes(label.expected)) throw new Error(`label expected must be one of ${LABEL_STATES.join('|')}: ${JSON.stringify(label)}`);
      const line = byKey.get(`${symbol}|${new Date(label.closedThrough).toISOString()}`);
      if (!line) { s.unmatched++; continue; }
      s.matched++;
      const got = predictedState(line, label.timeframe, label.direction);
      if (label.expected === 'none' && got === 'none') s.tn++;
      if (label.expected !== 'none' && got === label.expected) s.tp++;
      if (label.expected !== 'none' && got !== label.expected) s.fn++;
      if (got !== 'none' && got !== label.expected) s.fp++;
    }
  }
  s.precision = s.tp + s.fp ? round(s.tp / (s.tp + s.fp)) : null;
  s.recall = s.tp + s.fn ? round(s.tp / (s.tp + s.fn)) : null;
  return s;
}

/**
 * @param {Array<Object>} lines - replay JSONL records
 * @param {Object} [labelsBySymbol] - symbol -> labels array
 */
export function computeMetrics(lines, labelsBySymbol = {}) {
  const appearances = Object.fromEntries(STATES.map((st) => [st, Object.fromEntries(DIRECTIONS.map((d) => [d, 0]))]));
  const tracks = new Map();
  let gated = 0;
  const codeCounts = {};

  for (const line of lines) {
    if (line.gate.needsVisualConfirmation) gated++;
    for (const code of line.gate.codes) codeCounts[code] = (codeCounts[code] || 0) + 1;
    const t = Date.parse(line.closedThrough);
    for (const c of line.candidateLifecycle) {
      const [tf, direction] = c.ref.split(':');
      appearances[c.state][direction]++;
      const id = `${line.symbol}|${c.ref}|${c.startedAt}`;
      let track = tracks.get(id);
      if (!track) tracks.set(id, (track = { tf, first: t, last: t, confirmed: false, failAfterConfirm: null }));
      track.last = t;
      if (c.state === 'confirmed') track.confirmed = true;
      else if (track.confirmed && c.failReason && !track.failAfterConfirm) track.failAfterConfirm = c.failReason;
    }
  }

  const all = [...tracks.values()];
  const lifetimes = all.map((k) => (k.last - k.first) / INTERVAL_MS[k.tf] + 1);
  const byTf = {};
  for (const k of all) (byTf[k.tf] ||= []).push((k.last - k.first) / INTERVAL_MS[k.tf] + 1);
  const confirmed = all.filter((k) => k.confirmed);
  const laterFailed = confirmed.filter((k) => k.failAfterConfirm);
  const byReason = {};
  for (const k of laterFailed) byReason[k.failAfterConfirm] = (byReason[k.failAfterConfirm] || 0) + 1;

  return {
    closes: lines.length,
    symbols: [...new Set(lines.map((l) => l.symbol))],
    from: lines.length ? lines[0].closedThrough : null,
    to: lines.length ? lines[lines.length - 1].closedThrough : null,
    candidates: { appearances, distinct: all.length },
    gate: {
      closesWithGate: gated,
      rate: lines.length ? round(gated / lines.length) : null,
      byCode: Object.fromEntries(Object.entries(codeCounts).sort((a, b) => b[1] - a[1])
        .map(([code, n]) => [code, { closes: n, rate: round(n / lines.length) }]))
    },
    lifetime: {
      candidates: all.length,
      avgCandles: lifetimes.length ? round(lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length, 2) : null,
      byTimeframe: Object.fromEntries(Object.entries(byTf).map(([tf, v]) => [tf, round(v.reduce((a, b) => a + b, 0) / v.length, 2)]))
    },
    confirmedThenFailed: {
      confirmed: confirmed.length,
      laterFailed: laterFailed.length,
      rate: confirmed.length ? round(laterFailed.length / confirmed.length) : null,
      byReason
    },
    labels: scoreLabels(lines, labelsBySymbol)
  };
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')).join('\n');
}

export function formatMetrics(m) {
  const out = [];
  out.push(`Replay metrics: ${m.closes} closes, ${m.symbols.join(',')} (${m.from} → ${m.to})`, '');
  out.push('Candidate appearances (closes × candidates)');
  out.push(table([['state', ...DIRECTIONS, 'total'], ...STATES.map((st) => {
    const r = DIRECTIONS.map((d) => m.candidates.appearances[st][d]);
    return [st, ...r, r.reduce((a, b) => a + b, 0)];
  })]));
  out.push(`distinct candidates: ${m.candidates.distinct}`, '');
  out.push(`Visual gate: ${m.gate.closesWithGate}/${m.closes} closes (rate ${m.gate.rate})`);
  const codes = Object.entries(m.gate.byCode);
  if (codes.length) out.push(table([['code', 'closes', 'rate'], ...codes.map(([c, v]) => [c, v.closes, v.rate])]));
  out.push('');
  out.push(`Lifetime: avg ${m.lifetime.avgCandles} candles over ${m.lifetime.candidates} candidates; by timeframe ${JSON.stringify(m.lifetime.byTimeframe)}`);
  out.push(`Confirmed → failReason: ${m.confirmedThenFailed.laterFailed}/${m.confirmedThenFailed.confirmed} (rate ${m.confirmedThenFailed.rate}) ${JSON.stringify(m.confirmedThenFailed.byReason)}`);
  const l = m.labels;
  out.push(l.status === 'scored'
    ? `Labels: ${l.matched}/${l.labels} matched; TP ${l.tp} FP ${l.fp} FN ${l.fn} TN ${l.tn}; precision ${l.precision} recall ${l.recall}`
    : `Labels: ${l.status}`);
  return out.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i]] = argv[++i];
    else file = argv[i];
  }
  if (!file) throw new Error('usage: replay-metrics.js <replay.jsonl> [--labels <dir>] [--json <file>]');
  const opt = (k) => opts[k] || null;
  const lines = readJsonl(file);
  const labelsDir = opt('--labels') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'labels');
  const m = computeMetrics(lines, loadLabels(labelsDir, [...new Set(lines.map((l) => l.symbol))]));
  console.log(formatMetrics(m));
  console.log('');
  console.log(JSON.stringify(m, null, 2));
  if (opt('--json')) writeFileSync(opt('--json'), `${JSON.stringify(m, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-metrics] ${err.message}`);
    process.exit(1);
  });
}
