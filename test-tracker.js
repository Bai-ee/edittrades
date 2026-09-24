/**
 * Deterministic tests for scripts/tracker/ (T1 call tracker, docs/PLAN_CALL_TRACKER.md):
 * collector strip (fails closed), dedupe, candle store, vendored walkOutcome parity,
 * scorer on a synthetic day, idempotency, aggregate math, the page from an empty
 * store, the wallet whitelist (data/wallet.jsonl), call filter dimensions, the charts, and the
 * T2 journal (pull via an injected fetch, scoring, "your trades" line, wallet ticks, Engine vs
 * you, journal log). All file I/O is under os.tmpdir(); no network.
 *
 * Run: node test-tracker.js
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitiveKey, stripSensitive, findSensitiveKeys, recordsFromPayload, candlesFromPayload, ingestPayload,
  candlesFromKraken, walletRowFromPayload, WALLET_KEYS, pullJournal, blobBaseFromToken, resolveJournalBase, journalRecordsFromLines,
  pullServed, servedRowsFromLines, servedKey, slimCandidate
} from './scripts/tracker/collect.js';
import { runAlerts, findNewGood, alertKey, alertsFile, ALERT_MAX_AGE_MIN } from './scripts/tracker/alerts.js';
import {
  readAllCalls, readCandles, readJsonl, writeJsonl, outcomesFile, aggregatesFile, parseArgs, walletFile, readWallet,
  readJournal, appendJournal, journalOutcomesFile, appendCalls, appendCandles
} from './scripts/tracker/store.js';
import { extractCalls, scoreCalls, scoreDataDir, callDims, scoreJournal, scoreJournalDataDir, rFromExit, candidateLevels } from './scripts/tracker/score.js';
import { chartKit, equityRows, journalEquityRows, walletMarks, filterValues, driftBucket, hourBucket, callVia, FILTER_DIMS } from './scripts/tracker/charts.js';
import { statsFor, computeAggregates, classCheck, aggregateDataDir } from './scripts/tracker/aggregate.js';
import { buildPage, renderHtml, rStatus, engineVsYou, systemStatus, nextRunMs, expectedRuns, SCHEDULE_MINUTES, PROVISIONAL, EDGE_NOTE, NO_SCORED } from './scripts/tracker/build-page.js';
import { walkOutcome as vendoredWalk } from './scripts/tracker/walk-outcome.js';
import { walkOutcome as sourceWalk } from './scripts/replay-outcomes.js';
import { featuresAt } from './scripts/tracker/flag-paths.js';
import {
  pathsDataDir, computePathsRows, extractTighteningPoints, candidatesInRow, pathsFile, pathsSummary, derive3mFrom1m
} from './scripts/tracker/paths.js';

let passed = 0;
let failed = 0;
const failures = [];
const tmpDirs = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tracker-test-'));
  tmpDirs.push(dir);
  return dir;
}

function allText(dir, skip = () => false) {
  let text = '';
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    text += statSync(p).isDirectory() ? allText(p, skip) : readFileSync(p, 'utf8');
  }
  return text;
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-20T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** 1m candles from `startMs`, each from fn(i) -> {h, l} (o/c = mid). */
function candles(startMs, n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const { h, l } = fn(i);
    return { timestamp: startMs + i * MIN, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 };
  });
}

const plan = (over = {}) => ({
  candidateId: 'BTC:1m:long:2026-09-19T23:40:00.000Z', timeframe: '1m', direction: 'long',
  status: 'ready', reasonCode: null, entryType: 'retest', entryCondition: 'closed candle retests 100 and holds',
  entry: 100, stop: 99, tp1: 103, tp2: null, grossRR: 3, netRR: 2.8, stopDistancePct: 1,
  planId: 'x', ...over
});

const rec = (klass, over = {}) => ({
  class: klass, setupId: 's', candidateId: 'BTC:1m:long:2026-09-19T23:40:00.000Z', asOf: 'x',
  primaryReason: { code: klass === 'GOOD' ? 'ready_flag_plan' : 'rr_below_min', text: 't' },
  readiness: 'ready', supports: [], opposes: [], unknowns: [], changeConditions: [], trace: {}, ...over
});

const captureRow = (symbol, ms, flagTradePlan, flagRecommendation) => ({
  capturedAt: iso(ms + 2000), closedThrough: iso(ms), schemaVersion: '1.18.0', configVersion: 'CFG',
  dataStatus: 'complete', symbol, price: 100, mark: { price: 100.01, driftBps: 1, status: 'ok' },
  flagTradePlan, flagRecommendation, candidateSetups: [], bias: 'b'
});

function payloadWithSecrets() {
  const c1 = (i) => ({ t: iso(T0 - (20 - i) * MIN), o: 1, h: 2, l: 0.5, c: 1.5, v: 3 });
  const tf = (n, closedThrough) => ({ candles: Array.from({ length: n }, (_, i) => c1(i)), closedThrough });
  return {
    schemaVersion: '1.18.0', configVersion: 'CFG', generatedAt: iso(T0 + 1500), closedThrough: iso(T0), dataStatus: 'complete',
    account: {
      status: 'available', reason: 'REASONSENTINEL', address: 'SECRET_ADDR_1', fetchedAt: 'FETCHEDSENTINEL',
      margin: { usd: 999, byAsset: { USDC: 31337 } },
      holdings: [{ symbol: 'HOLDSENTINEL', amount: 1, usdValue: 4242 }], holdingsUsd: 7777,
      unpriced: ['UNPRICEDSENTINEL'], gas: { sol: 0.654321, minSol: 0.01, sufficient: true },
      performance: { baselineUsd: 900, netPnlUsd: 99, returnPct: 11, source: 'SOURCESENTINEL' }
    },
    wallet: { balance: 123 },
    performance: { pnl: 42 },
    symbols: {
      BTC: {
        price: 100,
        mark: { price: 100.1, driftBps: 2, status: 'ok', walletBalance: 5 },
        timeframes: {
          '1m': { ...tf(20, iso(T0)), candles: [...tf(20).candles, { t: iso(T0), o: 1, h: 1, l: 1, c: 1, v: 1 }] }, // last one still forming
          '5m': tf(4, iso(T0)),
          '15m': tf(2, iso(T0))
        },
        candidateSetups: [{ candidateId: 'c1', timeframe: '1m', direction: 'long', state: 'confirmed', breakoutLevel: 100, invalidation: 99, measuredRR: 3.2, qual: { quality: 'high' }, risk: { lossAtStopPctOfWallet: 0.1, collateralUsd: 10 } }],
        decisionTrace: { bias: 'scalp:L1', walletAddress: 'SECRET_ADDR_2' },
        flagTradePlan: plan({ margin: { usd: 1 }, balanceUsd: 3, nested: { depositAddress: 'SECRET_ADDR_3' } }),
        flagRecommendation: rec('GOOD', { performance: { x: 1 }, trace: { holdingsUsd: 1, walletStatus: 'ok' } })
      },
      ETH: { price: 50, timeframes: {}, flagTradePlan: null, flagRecommendation: rec('WATCH', { candidateId: null }) }
    }
  };
}

async function run() {
  await test('candlesFromKraken: converts rows, drops the open last candle, skips bad rows', () => {
    const result = { XXBTZUSD: [
      [1790200000, '100.1', '101.2', '99.5', '100.9', '100.5', '12.5', 40],
      [1790200060, 'x', '1', '1', '1', '1', '1', 1],
      [1790200120, '100.9', '102', '100', '101.5', '101', '3', 9],
      [1790200180, '101.5', '101.6', '101.4', '101.5', '101.5', '0.1', 1]
    ], last: 1790200120 };
    const rows = candlesFromKraken('BTC', result);
    assertEqual(rows.length, 2, 'two closed valid candles');
    assertEqual(rows[0].t, new Date(1790200000 * 1000).toISOString(), 'first t');
    assertEqual(rows[0].h, 101.2, 'high parsed');
    assertEqual(rows[1].v, 3, 'volume parsed');
    assertEqual(candlesFromKraken('BTC', null).length, 0, 'null result is empty');
  });

  console.log('\nscripts/tracker\n');

  await test('isSensitiveKey: account/wallet/performance/margin/holdings* and *wallet*/*balance*/*address*', () => {
    for (const k of ['account', 'wallet', 'performance', 'margin', 'holdings', 'holdingsUsd', 'walletAddress', 'lossAtStopPctOfWallet', 'balanceUsd', 'depositAddress', 'Balance']) {
      assert(isSensitiveKey(k), `${k} should be sensitive`);
    }
    for (const k of ['price', 'mark', 'flagTradePlan', 'entry', 'stop', 'tp1', 'class']) assert(!isSensitiveKey(k), `${k} should pass`);
  });

  await test('collector: no account/wallet/balance/address key or value reaches disk (wallet.jsonl whitelisted only)', () => {
    const dir = tmp();
    ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const text = allText(dir, (p) => p === walletFile(dir));
    for (const needle of ['"account"', '"wallet"', '"performance"', '"margin"', '"holdings', 'allet', 'alance', 'ddress', 'SECRET_ADDR', '7777', '999']) {
      assert(!text.includes(needle), `found ${needle} outside wallet.jsonl`);
    }
    const everything = allText(dir);
    for (const needle of ['SECRET_ADDR', 'ddress', '"holdings"', 'HOLDSENTINEL', '4242', 'byAsset', '31337', 'REASONSENTINEL', 'FETCHEDSENTINEL',
      'UNPRICEDSENTINEL', 'unpriced', '"gas"', '0.654321', 'SOURCESENTINEL', 'netPnlUsd', 'returnPct', '"reason"']) {
      assert(!everything.includes(needle), `found ${needle} anywhere on disk`);
    }
    const rows = readAllCalls(dir);
    assertEqual(rows.length, 2, 'one row per symbol');
    assertEqual(findSensitiveKeys(rows).length, 0, 'no sensitive keys in stored rows');
    const btc = rows.find((r) => r.symbol === 'BTC');
    assertEqual(btc.flagTradePlan.entry, 100, 'plan kept');
    assertEqual(btc.flagRecommendation.class, 'GOOD', 'rec kept');
    assertEqual(btc.bias, 'scalp:L1', 'bias string kept');
    assertEqual(JSON.stringify(Object.keys(btc.mark)), '["price","driftBps","status"]', 'mark slimmed');
    assertEqual(JSON.stringify(Object.keys(btc.candidateSetups[0])),
      '["id","tf","dir","state","breakout","invalidation","measuredRR","qual","measuredTarget","compressionScore","durationCandles","impulseStrength","flagHigh","flagLow"]',
      'candidate slimmed (T4-additive fields included)');
  });

  await test('wallet.jsonl: rows carry exactly the whitelisted keys, numbers only, deduped by t', () => {
    const dir = tmp();
    const a = ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const b = ingestPayload(dir, payloadWithSecrets(), T0 + 60_000);
    assertEqual(a.wallet, 1, 'first capture writes a sample');
    assertEqual(b.wallet, 0, 'same closedThrough writes none');
    const raw = readFileSync(walletFile(dir), 'utf8').trim().split('\n');
    assertEqual(raw.length, 1, 'one line');
    const row = JSON.parse(raw[0]);
    assertEqual(JSON.stringify(Object.keys(row)), JSON.stringify(WALLET_KEYS), 'exact whitelist, in order');
    assertEqual(JSON.stringify(row), JSON.stringify({ t: iso(T0), status: 'available', marginUsd: 999, holdingsUsd: 7777, totalUsd: 8776, baselineUsd: 900, pnlUsd: 99, pnlPct: 11 }), 'values');
    for (const k of WALLET_KEYS.slice(2)) assert(row[k] === null || typeof row[k] === 'number', `${k} numeric`);
  });

  await test('wallet row: not available -> status kept, every number null; no account -> absent', () => {
    for (const status of ['partial', 'unavailable', 'disabled']) {
      const p = payloadWithSecrets();
      p.account.status = status;
      const row = walletRowFromPayload(p);
      assertEqual(JSON.stringify(Object.keys(row)), JSON.stringify(WALLET_KEYS), `${status} keys`);
      assertEqual(row.status, status, 'status kept');
      assert(WALLET_KEYS.slice(2).every((k) => row[k] === null), `${status} writes nulls`);
    }
    const p = payloadWithSecrets();
    delete p.account;
    assertEqual(walletRowFromPayload(p).status, 'absent', 'no account block');
    p.account = { status: 'Available <script>', margin: { usd: 5 } };
    assertEqual(walletRowFromPayload(p).status, 'unknown', 'odd status word not copied');
    p.account = { status: 'available', margin: { usd: '5' }, holdingsUsd: 2, performance: { baselineUsd: 'x' } };
    const r = walletRowFromPayload(p);
    assert(r.marginUsd === null && r.totalUsd === null && r.baselineUsd === null && r.holdingsUsd === 2, 'non-numbers become null');
    assertEqual(walletRowFromPayload({ closedThrough: 'nope' }), null, 'no valid closedThrough -> no row');
  });

  await test('collector: row fields match the plan list', () => {
    const [row] = recordsFromPayload(payloadWithSecrets(), T0);
    for (const k of ['capturedAt', 'closedThrough', 'schemaVersion', 'configVersion', 'symbol', 'price', 'mark', 'flagTradePlan', 'flagRecommendation', 'candidateSetups', 'bias']) {
      assert(k in row, `missing ${k}`);
    }
  });

  await test('collector: strip fails closed (findSensitiveKeys sees any survivor; strip is deep)', () => {
    const found = findSensitiveKeys({ a: [{ b: { walletX: 1 } }], account: 1 });
    assertEqual(found.length, 2, 'both found');
    assertEqual(findSensitiveKeys(stripSensitive({ a: [{ b: { walletX: 1, ok: 2 } }], account: 1 })).length, 0, 'strip removes all');
  });

  await test('dedupe: same symbol+closedThrough twice writes nothing the second time', () => {
    const dir = tmp();
    const a = ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const b = ingestPayload(dir, payloadWithSecrets(), T0 + 60_000);
    assertEqual(a.calls.added, 2, 'first run adds');
    assertEqual(b.calls.added, 0, 'second run adds none');
    assertEqual(b.calls.duplicates, 2, 'second run sees duplicates');
    assertEqual(b.candles['1m'], 0, 'no duplicate candles');
    assertEqual(readAllCalls(dir).length, 2, 'still two rows');
    assert(existsSync(path.join(dir, 'calls', '2026-09-20.jsonl')), 'day file named by closedThrough UTC day');
  });

  await test('candle store: only closed candles, keyed by symbol+t, ascending', () => {
    const dir = tmp();
    const byTf = candlesFromPayload(payloadWithSecrets());
    assertEqual(byTf['1m'].length, 20, 'forming 1m candle dropped');
    ingestPayload(dir, payloadWithSecrets(), T0);
    const c = readCandles(dir, '1m').BTC;
    assertEqual(c.length, 20, '20 stored');
    assert(c.every((x, i) => i === 0 || x.timestamp > c[i - 1].timestamp), 'ascending');
    assertEqual(c[19].timestamp, T0 - MIN, 'last stored candle is the one closing at closedThrough');
    assertEqual(readCandles(dir, '15m').BTC.length, 2, '15m stored');
  });

  await test('walk-outcome.js: vendored walkOutcome matches scripts/replay-outcomes.js', () => {
    const cs = candles(T0, 60, (i) => ({ h: 100 + (i % 7) * 0.6, l: 99.4 + (i % 5) * 0.3 }));
    const cases = [
      { direction: 'long', entryMin: 100, entryMax: 100, stop: 99, target: 103, prefilled: true },
      { direction: 'long', entryMin: 100.5, entryMax: 100.5, stop: 99.5, target: 102.5, prefilled: false },
      { direction: 'short', entryMin: 101, entryMax: 101, stop: 102, target: 99.5, prefilled: false },
      { direction: 'short', entryMin: 101, entryMax: 101, stop: 103, target: 90, prefilled: true },
      { direction: 'long', entryMin: null, entryMax: 1, stop: 1, target: 2 }
    ];
    for (const c of cases) {
      const args = { candles1m: cs, fromMs: T0 + 3 * MIN, fillWindowCandles: 15, maxHoldCandles: 40, ...c };
      assertEqual(JSON.stringify(vendoredWalk(args)), JSON.stringify(sourceWalk(args)), `parity ${JSON.stringify(c)}`);
    }
  });

  // ---- synthetic day
  const condId = 'SOL:5m:long:2026-09-19T23:00:00.000Z';
  const rows = [
    captureRow('BTC', T0, plan(), rec('GOOD')),
    captureRow('BTC', T0 + 10 * MIN, plan(), rec('GOOD')), // same call, no new row
    captureRow('ETH', T0, plan({ candidateId: 'ETH:1m:short:x', direction: 'short', entry: 50, stop: 51, tp1: 47 }), null),
    captureRow('SOL', T0, plan({ candidateId: condId, timeframe: '5m', status: 'conditional', reasonCode: 'awaiting_retest', entry: 20, stop: 19, tp1: 23 }), rec('WATCH', { candidateId: condId, primaryReason: { code: 'entry_condition' } })),
    captureRow('SOL', T0 + 10 * MIN, plan({ candidateId: condId, timeframe: '5m', status: 'ready', entry: 20, stop: 19, tp1: 23 }), rec('GOOD', { candidateId: condId })),
    captureRow('XRP', T0, plan({ candidateId: 'XRP:c', status: 'rejected', reasonCode: 'rr_below_min', entry: 10, stop: 9, tp1: 11 }), rec('BAD', { candidateId: 'XRP:c' })),
    captureRow('ADA', T0, plan({ candidateId: 'ADA:c', status: 'conditional', reasonCode: 'awaiting_breakout' }), rec('DATA_UNAVAILABLE', { candidateId: null, primaryReason: { code: 'market_data_unavailable' } })),
    captureRow('DOT', T0, plan({ candidateId: 'DOT:c', entry: 5, stop: 4, tp1: 8 }), null)
  ];
  const candleSet = {
    BTC: candles(T0, 30, (i) => (i < 10 ? { h: 101, l: 99.5 } : { h: 103.5, l: 101 })), // tp1 at i=10
    ETH: candles(T0, 30, (i) => (i === 3 ? { h: 51.2, l: 49.8 } : { h: 50.2, l: 49.8 })), // stop at i=3
    SOL: candles(T0, 120, (i) => (i < 60 ? { h: 21, l: 19.5 } : { h: 23.5, l: 21 })), // ready at +10m, tp1 at i=60
    XRP: candles(T0, 30, () => ({ h: 13, l: 12 })), // BAD levels never touched
    DOT: candles(T0, 30, () => ({ h: 5.5, l: 4.5 })) // filled, unresolved
  };

  await test('extractCalls: one call per signature change, plan and rec separately', () => {
    const calls = extractCalls(rows);
    assertEqual(calls.filter((c) => c.symbol === 'BTC').length, 2, 'BTC: one plan + one rec despite two captures');
    assertEqual(calls.filter((c) => c.symbol === 'SOL').length, 4, 'SOL: conditional, ready, WATCH, GOOD');
    const bad = calls.find((c) => c.symbol === 'XRP' && c.kind === 'rec');
    assertEqual(bad.entry, 10, 'BAD rec linked to its plan levels');
    assertEqual(bad.netRR, 2.8, 'netRR carried');
  });

  await test('scorer: synthetic day (long tp1, short stop, not_filled, open, expired, conditional, rejected)', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const get = (sym, kind, status) => out.find((r) => r.symbol === sym && r.kind === kind && (!status || r.planStatus === status || r.class === status));
    const btc = get('BTC', 'plan');
    assertEqual(btc.outcome, 'tp1', 'long tp1');
    assertEqual(btc.r, 3, 'gross R to TP1');
    assertEqual(btc.filledAt, iso(T0), 'ready fills at the ready close');
    assertEqual(btc.minutesToResolution, 11, 'minutes to TP1');
    assertEqual(btc.netRR, 2.8, 'net carried from plan');
    assertEqual(get('BTC', 'rec').outcome, 'tp1', 'GOOD rec scored like its ready plan');
    assertEqual(get('BTC', 'rec').mode, 'ready_prefilled', 'GOOD mode');
    const eth = get('ETH', 'plan');
    assertEqual(eth.outcome, 'stop', 'short stop');
    assertEqual(eth.r, -1, 'stop is -1R');
    assertEqual(get('XRP', 'plan').outcome, 'rejected', 'rejected plan not walked');
    const bad = get('XRP', 'rec');
    assertEqual(bad.outcome, 'not_filled', 'BAD counterfactual never touched');
    assertEqual(bad.mode, 'counterfactual_level_touch', 'BAD mode');
    assertEqual(get('ADA', 'rec').outcome, 'no_levels', 'no levels');
    assertEqual(get('DOT', 'plan').outcome, 'open', 'filled, unresolved, window open');
    const cond = get('SOL', 'plan', 'conditional');
    const ready = get('SOL', 'plan', 'ready');
    assertEqual(ready.outcome, 'tp1', 'SOL ready tp1');
    assertEqual(cond.becameReady, true, 'conditional linked to its ready plan');
    assertEqual(cond.readyCallId, ready.callId, 'linked by candidateId');
    assertEqual(cond.outcome, 'tp1', 'conditional takes the ready outcome');
    const watch = get('SOL', 'rec', 'WATCH');
    assertEqual(watch.outcome, 'tp1', 'WATCH counterfactual touch then tp1');
    assertEqual(get('ADA', 'plan').outcome, 'pending', 'conditional never ready, window open');
  });

  await test('callDims: filter dimensions copied from the capture row; final rows backfilled once', () => {
    const r = captureRow('BTC', T0, plan(), rec('GOOD', {
      candidate: { timeframe: '1m', direction: 'long', state: 'confirmed' },
      supports: ['td:bull:3/4', 'divergence_agrees'], opposes: ['ema200:1m:below', 'ema200:4h:above'], unknowns: ['ema200:1w:missing']
    }));
    const d = callDims(r);
    assertEqual(d.recClass, 'GOOD', 'class');
    assertEqual(d.recReason, 'ready_flag_plan', 'reason');
    assertEqual(d.planStatusAtCall, 'ready', 'plan status');
    assertEqual(d.candidateState, 'confirmed', 'candidate state');
    assertEqual(d.topDown, 'supports', 'td side');
    assertEqual(d.topDownToken, 'td:bull:3/4', 'td token');
    assertEqual(d.ema200Side, 'below', 'EMA200 side on the call timeframe');
    assertEqual(d.divergence, 'agrees', 'divergence');
    assertEqual(d.closedThrough, iso(T0), 'closedThrough');
    assertEqual(JSON.stringify(d.unknowns), '["ema200:1w:missing"]', 'codes copied');
    assertEqual(callDims(captureRow('BTC', T0, null, null)).divergence, 'none', 'no rec -> none');
    const calls = extractCalls([r]);
    assert(calls.every((c) => c.dims && c.dims.recClass === 'GOOD'), 'every call carries dims');
    const old = scoreCalls(calls, candleSet, [], T0 + 2 * 60 * MIN).map(({ dims, ...rest }) => rest);
    const again = scoreCalls(calls, candleSet, old, T0 + 3 * 60 * MIN);
    const plan1 = again.find((c) => c.kind === 'plan');
    assertEqual(plan1.outcome, 'tp1', 'final outcome kept');
    assertEqual(plan1.dims.topDown, 'supports', 'dims backfilled');
    assertEqual(plan1.scoredAt, old.find((c) => c.kind === 'plan').scoredAt, 'scoredAt kept');
  });

  await test('scorer: 24 h window -> expired / not_filled', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 25 * 60 * MIN);
    assertEqual(out.find((r) => r.symbol === 'DOT').outcome, 'expired', 'unresolved after 24 h');
    assertEqual(out.find((r) => r.symbol === 'ADA' && r.kind === 'plan').outcome, 'not_filled', 'conditional never ready');
    assertEqual(out.find((r) => r.symbol === 'ADA' && r.kind === 'plan').becameReady, false, 'becameReady false');
  });

  await test('scorer: idempotent; final rows never rewritten, open rows re-scored', () => {
    const calls = extractCalls(rows);
    const first = scoreCalls(calls, candleSet, [], T0 + 2 * 60 * MIN);
    const again = scoreCalls(calls, candleSet, first, T0 + 3 * 60 * MIN);
    assertEqual(JSON.stringify(again), JSON.stringify(first), 'no change -> identical, scoredAt kept');
    const moved = { ...candleSet, BTC: candles(T0, 30, () => ({ h: 100.5, l: 98 })), DOT: candles(T0, 30, (i) => (i === 20 ? { h: 8.5, l: 5 } : { h: 5.5, l: 4.5 })) };
    const third = scoreCalls(calls, moved, first, T0 + 3 * 60 * MIN);
    assertEqual(third.find((r) => r.symbol === 'BTC' && r.kind === 'plan').outcome, 'tp1', 'final kept');
    const dot = third.find((r) => r.symbol === 'DOT');
    assertEqual(dot.outcome, 'tp1', 'open re-scored');
    assertEqual(dot.scoredAt, iso(T0 + 3 * 60 * MIN), 'scoredAt moves only on change');
  });

  await test('scoreDataDir: end-to-end through the store, stable on rerun', () => {
    const dir = tmp();
    ingestPayload(dir, payloadWithSecrets(), T0);
    const a = scoreDataDir(dir, T0 + MIN);
    const b = scoreDataDir(dir, T0 + 2 * MIN);
    assertEqual(readJsonl(outcomesFile(dir)).length, a.length, 'written');
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'rerun identical');
  });

  await test('aggregate: win rate, expectancy, losing streak, median time', () => {
    const r = (outcome, rv, mins, at) => ({ kind: 'plan', planStatus: 'ready', outcome, r: rv, filledAt: at, resolvedAt: at, calledAt: at, minutesToResolution: mins, netRR: 3 });
    const s = statsFor([
      r('stop', -1, 5, iso(T0)), r('stop', -1, 5, iso(T0 + MIN)), r('tp1', 3, 10, iso(T0 + 2 * MIN)),
      r('stop', -1, 5, iso(T0 + 3 * MIN)), r('tp1', 4, 30, iso(T0 + 4 * MIN)), r('open', null, null, iso(T0 + 5 * MIN))
    ]);
    assertEqual(s.calls, 6, 'calls');
    assertEqual(s.fills, 6, 'fills');
    assertEqual(s.winRate, 0.4, 'win rate 2/5');
    assertEqual(s.expectancy, 0.8, 'expectancy (3+4-3)/5');
    assertEqual(s.avgWinR, 3.5, 'avg win R');
    assertEqual(s.maxLosingStreak, 2, 'streak');
    assertEqual(s.medianMinutesToTP1, 20, 'median min to TP1');
    assertEqual(s.avgNetRR, 3, 'avg net');
  });

  await test('aggregate: tiles, classes, capture gaps', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const caps = [...rows, captureRow('BTC', T0 + 60 * MIN, plan(), rec('GOOD'))];
    const agg = computeAggregates(out, caps, candleSet, T0 + 2 * 60 * MIN);
    assertEqual(agg.tiles.goodToday, 2, 'GOOD today (BTC + SOL)');
    assertEqual(agg.tiles.callsToday, 5, 'rec calls today (BTC GOOD, SOL WATCH+GOOD, XRP BAD, ADA DATA_UNAVAILABLE)');
    assertEqual(agg.tiles.fills7d, 4, 'ready plan fills');
    assertEqual(agg.captures.gaps, 1, 'BTC 10m -> 60m gap');
    assertEqual(agg.captures.dataUnavailable, 1, 'DATA_UNAVAILABLE capture');
    assert(agg.windows['7d'].byClass.some((g) => g.key === 'BAD'), 'by class');
    assertEqual(agg.windows['7d'].reasonCounts.rr_below_min, 2, 'rr_below_min plan + rec');
  });

  await test('page: renders from an empty data dir with hero, phase block, and one provisional tag per section', () => {
    const dir = tmp();
    const out = path.join(dir, 'docs');
    const { htmlFile, mdFile } = buildPage(path.join(dir, 'data'), out, T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['tile-last-capture', 'tile-expectancy-7d', 'hero-sample-size', 'tile-win-rate-7d', 'tile-fills-7d', 'tile-good-7d', 'tile-losing-streak-7d', 'tile-avg-r-7d', 'testing-phase-section', 'testing-phase-status', 'testing-phase-days-bar', 'testing-phase-plans-bar', 'what-we-track-section', 'open-calls-section', 'window-7d-section', 'window-30d-section', 'daily-log-section', 'capture-health-summary']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    const sections = (html.match(/<section /g) || []).length;
    assertEqual((html.match(/class="prov-tag"/g) || []).length, sections, 'one provisional tag per section');
    assertEqual(html.split(EDGE_NOTE.replace(/'/g, '&#39;')).length - 1, 1, 'edge note once');
    assert(html.includes(NO_SCORED), 'empty-state text');
    assert(html.includes('n=0 scored calls'), 'sample size');
    assert(/\[(RUNNING|SCHEDULED|READY FOR REVIEW)\]/.test(html), 'phase status word');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'exactly one executable inline script');
    assert(scripts.every((t) => !/\bsrc=/i.test(t)), 'no external scripts');
    assert(!/fetch\(|XMLHttpRequest|import\(/.test(html), 'no network in the script');
    for (const id of ['equity-chart-section', 'equity-chart-svg', 'equity-readout', 'equity-filter-table', 'wallet-chart-section', 'wallet-chart-svg', 'wallet-range-control', 'wallet-current-value', 'tracker-calls-data', 'tracker-wallet-data']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.indexOf('id="testing-phase-section"') < html.indexOf('id="equity-chart-section"')
      && html.indexOf('id="equity-chart-section"') < html.indexOf('id="wallet-chart-section"')
      && html.indexOf('id="wallet-chart-section"') < html.indexOf('id="what-we-track-section"'), 'chart order');
    assert(html.includes('[NO WALLET SAMPLES YET]'), 'wallet empty state');
    assert(/<svg id="equity-chart-svg"[^>]*>[\s\S]*?\[NO SCORED CALLS YET\]/.test(html), 'equity empty state inside the chart frame');
    assert(!/gradient|box-shadow|drop-shadow/i.test(html), 'no gradients or shadows');
    assert(html.includes('.chart-svg{') && html.includes('.seg-btn{'), 'chart styles on the page');
    assert(html.includes('prefers-color-scheme: dark') && html.includes('prefers-color-scheme: light'), 'both schemes');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes(PROVISIONAL) && md.includes('## Testing phase'), 'report labelled, phase block');
  });

  await test('page: how-to page is written beside index, linked both ways, static, no account fields', () => {
    const dir = tmp();
    const { htmlFile, howToFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const index = readFileSync(htmlFile, 'utf8');
    const howTo = readFileSync(howToFile, 'utf8');
    assert(/<a href="how-to.html"[^>]*id="tracker-how-to-link"/.test(index), 'index links to how-to');
    assert(howTo.includes('href="index.html"'), 'how-to links back');
    for (const cmd of ['signals', 'forming', 'flags', 'track', 'balance', 'data check']) {
      assert(howTo.includes(`data-command="${cmd}"`), `command ${cmd}`);
    }
    assert(howTo.includes('&quot;trades&quot; gives the same answer'), 'trades = signals');
    for (const id of ['howto-session-section', 'howto-commands-section', 'howto-reading-section', 'howto-follow-ups-section', 'howto-donts-section', 'howto-tracker-section']) {
      assert(howTo.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(!/<script/i.test(howTo), 'no scripts');
    assert(!/SCALP_CONTEXT_API_KEY|Bearer|walletAddress/i.test(howTo), 'no secrets or wallet fields');
    assert(howTo.includes('prefers-color-scheme: dark') && howTo.includes('prefers-color-scheme: light'), 'both schemes');
  });

  await test('alerts: new GOOD call alerts once per symbol+candidate, fresh only, owner mentioned', () => {
    const dir = tmp();
    const data = path.join(dir, 'data');
    const now = Date.parse('2026-09-24T06:10:00Z');
    const row = (symbol, cls, at, candidateId, extra = {}) => ({
      capturedAt: at, closedThrough: at.replace(/:\d\d\.\d{3}Z$/, ':00.000Z'), symbol, price: 100, source: 'cron',
      flagRecommendation: { class: cls, candidateId, primaryReason: { code: 'ok', text: 'aligned 21/200' } },
      flagTradePlan: cls === 'GOOD' ? { status: 'ready', direction: 'long', timeframe: '5m', entry: 100, stop: 99, tp1: 103, tp2: 105, grossRR: 3, netRR: 2.8, candidateId } : null,
      ...extra
    });
    appendCalls(data, [
      row('BTC', 'GOOD', '2026-09-24T06:07:05.000Z', 'BTC:5m:long:a'),
      row('ETH', 'WATCH', '2026-09-24T06:07:05.000Z', 'ETH:5m:long:b'),
      row('SOL', 'GOOD', '2026-09-24T03:00:05.000Z', 'SOL:5m:long:old')
    ]);
    const first = runAlerts(data, { nowMs: now, mention: 'owner-x' });
    assertEqual(first.length, 1, 'one fresh GOOD');
    assert(first[0].title.includes('BTC LONG 5m') && first[0].title.includes('entry 100') && first[0].title.includes('TP1 103'), 'title levels');
    assert(first[0].body.includes('@owner-x') && first[0].body.includes('aligned 21/200'), 'mention + reason');
    assertEqual(readJsonl(alertsFile(data)).length, 1, 'recorded');
    appendCalls(data, [row('BTC', 'GOOD', '2026-09-24T06:08:05.000Z', 'BTC:5m:long:a')]);
    assertEqual(runAlerts(data, { nowMs: now + 60_000 }).length, 0, 'same candidate not re-alerted');
    appendCalls(data, [row('BTC', 'GOOD', '2026-09-24T06:09:05.000Z', 'BTC:5m:long:c', { source: 'served' })]);
    const second = runAlerts(data, { nowMs: now + 120_000 });
    assertEqual(second.length, 1, 'new candidate alerts');
    assert(second[0].body.includes('seen via chat'), 'served labelled chat');
    assertEqual(findNewGood([row('SOL', 'GOOD', new Date(now - (ALERT_MAX_AGE_MIN + 1) * 60_000).toISOString(), 'x')], [], now).length, 0, 'stale ignored');
    assertEqual(alertKey({ symbol: 'BTC', closedThrough: 't', flagRecommendation: {} }), 'BTC|t', 'key falls back to close');
  });

  await test('status: LIVE / DELAYED / STALLED bands, next run on the schedule, cron in sync', () => {
    const at = Date.parse('2026-09-24T02:00:00Z');
    assertEqual(systemStatus(null, at).word, 'WAITING', 'no captures');
    assertEqual(systemStatus('2026-09-24T01:30:00Z', at).word, 'LIVE', '30 min');
    assertEqual(systemStatus('2026-09-24T00:50:00Z', at).word, 'DELAYED', '70 min');
    assertEqual(systemStatus('2026-09-23T23:00:00Z', at).word, 'STALLED', '3 h');
    assertEqual(new Date(nextRunMs(at)).toISOString(), '2026-09-24T02:07:00.000Z', 'next :07');
    assertEqual(new Date(nextRunMs(Date.parse('2026-09-24T02:07:00Z'))).toISOString(), '2026-09-24T02:17:00.000Z', 'strictly after');
    assertEqual(new Date(nextRunMs(Date.parse('2026-09-24T02:58:00Z'))).toISOString(), '2026-09-24T03:07:00.000Z', 'wraps the hour');
    assertEqual(expectedRuns(Date.parse('2026-09-24T05:00:00Z'), Date.parse('2026-09-24T06:00:00Z')), 2, '30-min cadence before the switch');
    assertEqual(expectedRuns(Date.parse('2026-09-24T06:00:00Z'), Date.parse('2026-09-24T07:00:00Z')), 6, '10-min cadence after');
    assertEqual(expectedRuns(Date.parse('2026-09-24T05:30:00Z'), Date.parse('2026-09-24T06:30:00Z')), 4, 'mixed span');
    const yml = readFileSync('scripts/tracker/repo-template/.github/workflows/track.yml', 'utf8');
    assert(yml.includes(`cron: '${SCHEDULE_MINUTES.join(',')} * * * *'`), 'page schedule matches workflow cron');
  });

  await test('page: system zone sits first with status, heartbeat, timeline and activity', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['zone-system', 'system-status-section', 'system-status-word', 'system-heartbeat', 'system-next-run', 'system-runs-24h', 'testing-phase-day', 'testing-phase-plans-eta', 'activity-24h-section']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.indexOf('id="zone-system"') < html.indexOf('id="zone-performance"'), 'system zone first');
    assert(html.includes('>WAITING<'), 'empty store shows WAITING');
    assert(html.includes('data-last-capture=""'), 'status tile carries last capture for the browser');
  });

  await test('page: hero shows signed expectancy with status color and phase progress counts', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const agg = computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN, { phaseStartMs: T0 - 60 * MIN });
    const html = renderHtml(agg);
    const e = agg.tiles.expectancy7d;
    assert(typeof e === 'number', 'synthetic day has an expectancy');
    assert(html.includes(`class="hero-value ${rStatus(e)}" id="tile-expectancy-7d"`), 'hero status class');
    const t = agg.windows['7d'].tradable;
    assert(html.includes(`n=${t.wins + t.losses} scored call`), 'hero sample size');
    assertEqual(agg.phase.tradable.wins + agg.phase.tradable.losses, t.wins + t.losses, 'phase scored plans');
    assertEqual(rStatus(0), 'st-good', '0R is green');
    assertEqual(rStatus(-0.3), 'st-warn', 'amber band');
    assertEqual(rStatus(-0.6), 'st-bad', 'red below -0.5R');
  });

  await test('page: populated render escapes values', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    out[0].symbol = '<b>BTC</b>';
    const html = renderHtml(computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN));
    assert(!html.includes('<b>BTC</b>') && html.includes('&lt;b&gt;BTC&lt;/b&gt;'), 'escaped');
  });

  await test('charts: equity curve math, filters, open point, by-filter table', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const eq = equityRows(out);
    assertEqual(eq.length, 4, 'ready plans at tp1/stop/open (BTC, ETH, SOL ready, DOT); conditional + rejected + recs excluded');
    const kit = chartKit();
    const s = kit.equityStats(eq);
    assertEqual(s.n, 3, 'decided');
    assertEqual(s.open, 1, 'open');
    assertEqual(s.cum, 5, 'cum = 3 - 1 + 3');
    assertEqual(Math.round(s.winRate * 100), 67, 'win rate');
    assertEqual(s.maxLosingStreak, 1, 'streak');
    const svg = kit.equitySvg('eq', eq, 360, T0 + 2 * 60 * MIN, 'x');
    assert(svg.includes('class="pt-open"') && (svg.match(/class="pt"/g) || []).length === 3, 'three points + hollow open point');
    assert(!svg.includes('NaN'), 'no NaN');
    const eth = eq.filter((r) => r.f.symbol === 'ETH');
    assertEqual(kit.equityStats(eth).cum, -1, 'filtered to ETH');
    const table = kit.filterTableHtml(eq, { symbol: ['ETH', 'BTC'], dir: [] }, FILTER_DIMS);
    assert(table.includes('Selection') && table.includes('Symbol: ETH') && table.includes('Symbol: BTC'), 'selection rows');
    assert(filterValues(eq).symbol.join() === 'BTC,DOT,ETH,SOL', 'filter values');
    assertEqual(driftBucket(-7), '5–10', 'drift bucket');
    assertEqual(driftBucket(null), 'none', 'drift none');
    assertEqual(hourBucket('2026-09-20T13:59:00Z'), '12–15', 'hour bucket');
    assert(kit.equitySvg('eq', [], 360, T0, '[NO SCORED CALLS YET]').includes('[NO SCORED CALLS YET]'), 'empty');
  });

  await test('charts: wallet line with gaps, baseline, GOOD ticks, range; page renders the value', () => {
    const kit = chartKit();
    const w = (h, total, status = 'available') => ({ t: iso(T0 + h * 60 * MIN), status, marginUsd: total === null ? null : total - 10, holdingsUsd: total === null ? null : 10, totalUsd: total, baselineUsd: total === null ? null : 90, pnlUsd: total === null ? null : total - 100, pnlPct: null });
    const ws = [w(0, 100), w(1, 101), w(2, null, 'unavailable'), w(3, 104), w(4, 103)];
    const svg = kit.walletSvg('ws', ws, [iso(T0 + 60 * MIN)], 640, 'all', T0 + 4 * 60 * MIN, 'x');
    assertEqual((svg.match(/class="line-main"/g) || []).length, 1, 'one total path');
    assert(/class="line-main" d="M[^"]*M/.test(svg), 'gap splits the total path');
    assert(svg.includes('id="ws-baseline"'), 'baseline rule');
    assertEqual((svg.match(/class="good-tick"/g) || []).length, 1, 'GOOD tick');
    assert(!svg.includes('NaN'), 'no NaN');
    assert(kit.walletSvg('ws', ws, [], 640, '24h', T0 + 60 * 60 * MIN, 'x').includes('[NO WALLET SAMPLES IN RANGE]'), 'range filters samples');
    const agg = computeAggregates([], [], {}, T0 + 4 * 60 * MIN);
    const html = renderHtml(agg, { outcomes: [], wallet: ws });
    assert(/id="wallet-current-value">\$103\.00</.test(html), 'current value');
    assert(html.includes('class="wallet-value st-good"'), 'status color by sign of pnl');
    assert(html.includes('coincidence only'), 'coincidence caption');
  });

  // ---------------------------------------------------------------- journal (T2)

  const jrec = (id, kind, ms, over = {}) => ({
    id, schemaVersion: 'journal-1', receivedAt: iso(ms + 5000), saidAt: iso(ms), kind, symbol: 'BTC', direction: null,
    entry: null, stop: null, tp1: null, sizeUsd: null, leverage: null, exitPrice: null, resultR: null, resultUsd: null,
    engineRef: null, text: `${kind} ${id}`, ...over
  });

  await test('journal pull: manifest + day files via fetch (cache-busted), deduped by id, sensitive keys stripped', async () => {
    const dir = tmp();
    const base = 'https://store1.public.blob.vercel-storage.com';
    const files = {
      [`${base}/journal/manifest.json`]: JSON.stringify({ schemaVersion: 'journal-manifest-1', baseUrl: base, days: ['2026-09-20', '2026-09-21', 'bad'] }),
      [`${base}/journal/2026-09-20.jsonl`]: [JSON.stringify(jrec('j1', 'open', T0)), '{torn', JSON.stringify({ ...jrec('j2', 'note', T0 + MIN), walletAddress: 'SECRET_ADDR_J' })].join('\n'),
      [`${base}/journal/2026-09-21.jsonl`]: JSON.stringify(jrec('j3', 'close', T0 + 24 * 60 * MIN)) + '\n'
    };
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      const key = url.split('?')[0];
      return files[key] === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => files[key] };
    };
    const r1 = await pullJournal(dir, base, fakeFetch, 123);
    assertEqual(r1.added, 3, 'added');
    assertEqual(r1.days, 2, 'valid days only');
    assert(urls.every((u) => u.endsWith('?t=123')), 'cache-busted');
    const r2 = await pullJournal(dir, base, fakeFetch, 124);
    assertEqual(r2.added, 0, 'dedupe');
    assertEqual(r2.duplicates, 3, 'duplicates');
    assertEqual(readJournal(dir).map((r) => r.id).join(), 'j1,j2,j3', 'stored, oldest first');
    assert(existsSync(path.join(dir, 'journal', '2026-09-21.jsonl')), 'day file by receivedAt');
    assert(!allText(dir).includes('SECRET_ADDR_J'), 'sensitive key stripped');
    const none = await pullJournal(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assertEqual(none.added, 0, 'no manifest -> nothing');
    assertEqual(journalRecordsFromLines([{ id: 'x' }, null, [1]]).length, 0, 'records need id + receivedAt');
  });

  await test('journal base: explicit > JOURNAL_BLOB_BASE > store id from the token (token itself never used)', () => {
    assertEqual(blobBaseFromToken('vercel_blob_rw_AbCd123_secretpart'), 'https://abcd123.public.blob.vercel-storage.com', 'derived');
    assertEqual(blobBaseFromToken('nope'), null, 'bad token');
    assertEqual(resolveJournalBase({ 'journal-base': 'https://x.example/' }, {}), 'https://x.example', 'explicit');
    assertEqual(resolveJournalBase({}, { JOURNAL_BLOB_BASE: 'https://y.example' }), 'https://y.example', 'env');
    assert(!resolveJournalBase({}, { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_S1_secretpart' }).includes('secretpart'), 'no secret in URL');
    assertEqual(resolveJournalBase({}, {}), null, 'unset');
  });

  // BTC rises 1/min from 100: long 100/99/103 hits TP1 on the 3rd candle.
  const jCandles = { BTC: candles(T0, 200, (i) => ({ h: 100 + i + 0.5, l: 100 + i - 0.5 })) };
  const cid = 'BTC:1m:long:2026-09-19T23:40:00.000Z';
  const engineOutcomes = [
    { callId: 'rec|g1', kind: 'rec', class: 'GOOD', candidateId: cid, calledAt: iso(T0), outcome: 'tp1', r: 3, dims: { recClass: 'GOOD', recReason: 'ready_flag_plan', candidateTimeframe: '1m', topDown: 'supports' } },
    { callId: 'rec|g2', kind: 'rec', class: 'GOOD', candidateId: 'ETH:skip', calledAt: iso(T0), outcome: 'stop', r: -1, dims: { recClass: 'GOOD' } },
    { callId: 'rec|g3', kind: 'rec', class: 'GOOD', candidateId: 'SOL:quiet', calledAt: iso(T0), outcome: 'tp1', r: 2, dims: { recClass: 'GOOD' } }
  ];
  const journalSet = [
    jrec('o1', 'open', T0, { direction: 'long', entry: 100, stop: 99, tp1: 103, engineRef: { candidateId: cid, planId: 'p', recClass: 'GOOD', reasonCode: 'ready_flag_plan' } }),
    jrec('o2', 'open', T0 + 10 * MIN, { symbol: 'ETH', direction: 'short', entry: 50, stop: 51, tp1: 47, engineRef: { candidateId: 'ETH:watch', planId: null, recClass: 'WATCH', reasonCode: 'rr_below_min' } }),
    jrec('c2', 'close', T0 + 30 * MIN, { symbol: 'ETH', exitPrice: 49 }),
    jrec('o3', 'open', T0 + 40 * MIN, { symbol: 'SOL', direction: 'long' }),
    jrec('c3', 'close', T0 + 50 * MIN, { symbol: 'SOL', resultR: -0.5 }),
    jrec('s1', 'skip', T0 + 5 * MIN, { symbol: 'ETH', engineRef: { candidateId: 'ETH:skip', planId: null, recClass: 'GOOD', reasonCode: null } }),
    jrec('n1', 'note', T0 + 6 * MIN, { text: '<b>x</b>' })
  ];

  await test('journal score: open walked like a ready plan; close overrides with resultR or exitPrice; dims from the linked call', () => {
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    assertEqual(rows.length, 3, 'one row per open');
    const [a, b, c] = rows;
    assertEqual(a.outcome, 'tp1', 'walked to TP1');
    assertEqual(a.r, 3, 'R to TP1');
    assertEqual(a.mode, 'ready_prefilled', 'mode');
    assertEqual(a.dims.topDown, 'supports', 'dims copied from the linked engine call');
    assertEqual(a.linkedCallId, 'rec|g1', 'link');
    assertEqual(b.outcome, 'closed', 'ETH closed');
    assertEqual(b.r, 1, 'short R from exitPrice (50-49)/1');
    assertEqual(b.mode, 'reported_exit_price', 'mode');
    assertEqual(b.dims.recClass, 'WATCH', 'minimal dims from engineRef');
    assertEqual(c.outcome, 'closed', 'SOL closed without levels');
    assertEqual(c.r, -0.5, 'reported resultR');
    assertEqual(rFromExit('long', 100, 99, 101.5), 1.5, 'rFromExit long');
    const again = scoreJournal(journalSet, jCandles, engineOutcomes, rows, T0 + 4 * 60 * MIN);
    assertEqual(again[0].scoredAt, rows[0].scoredAt, 'scoredAt stable when unchanged');
    const noClose = scoreJournal([journalSet[3]], jCandles, [], [], T0);
    assertEqual(noClose[0].outcome, 'no_levels', 'no levels, no close');
  });

  await test('journal chart rows, wallet marks (up/down, colored by R), your-trades line, Engine vs you', () => {
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    const you = journalEquityRows(rows);
    assertEqual(you.length, 3, 'three scored trades');
    assertEqual(you.map((r) => r.o).join(), 'tp1,closed,closed', 'outcomes');
    assertEqual(you[0].f.class, 'GOOD', 'filter dims');
    const kit = chartKit();
    const st = kit.equityStats(you);
    assertEqual(st.cum, 3.5, 'cum 3 + 1 - 0.5');
    assertEqual(st.wins, 2, 'wins = R > 0');
    const eq = [{ t: iso(T0), at: iso(T0 + MIN), o: 'tp1', r: 2, f: you[0].f }];
    const svg = kit.equitySvg('eq', eq, 640, T0 + 60 * MIN, 'x', you);
    assert(svg.includes('id="eq-you-line"') && svg.includes('class="line-main'), 'both lines');
    assert(!svg.includes('NaN'), 'no NaN');
    assert(kit.equitySvg('eq', [], 640, T0, 'x', you).includes('eq-you-line'), 'your line alone still draws');
    assert(kit.filterTableHtml(eq, {}, FILTER_DIMS, you).includes('Your trades'), 'filter table row');
    const marks = walletMarks(journalSet, rows);
    assertEqual(marks.map((m) => m.k).join(), 'open,open,close,open,close', 'opens and closes only');
    assertEqual(marks[0].r, 3, 'open colored by its trade R');
    assertEqual(marks[4].r, -0.5, 'close colored by reported R');
    const w = (h, total) => ({ t: iso(T0 + h * 60 * MIN), status: 'available', marginUsd: total, holdingsUsd: 0, totalUsd: total, baselineUsd: null, pnlUsd: null, pnlPct: null });
    const wsvg = kit.walletSvg('ws', [w(0, 100), w(1, 101)], [], 640, 'all', T0 + 60 * MIN, 'x', marks);
    assert(/class="j-tick j-open pos"/.test(wsvg), 'open tick up, green');
    assert(/class="j-tick j-close neg"/.test(wsvg), 'close tick down, red');
    const ev = engineVsYou(engineOutcomes, journalSet, rows);
    assertEqual(ev.goodCalls, 3, 'GOOD calls');
    assertEqual(ev.goodTaken, 1, 'taken');
    assertEqual(ev.goodSkipped, 1, 'skipped');
    assertEqual(ev.goodNotLogged, 1, 'not logged');
    assertEqual(ev.overrides.length, 1, 'WATCH taken');
    assertEqual(ev.skippedEngineStats.cum, -1, "skipped GOOD: the engine's own result");
    assertEqual(ev.unlinked, 1, 'SOL open had no engine link');
  });

  await test('page: journal sections render populated and empty (bracketed empty states), text escaped', () => {
    const agg = computeAggregates([], [], {}, T0 + 3 * 60 * MIN);
    const empty = renderHtml(agg, { outcomes: [], wallet: [] });
    assert(empty.includes('id="engine-vs-you-section"') && empty.includes('id="journal-log-section"'), 'sections');
    assert(empty.includes('id="engine-vs-you-empty">[NO JOURNAL RECORDS YET]'), 'engine vs you empty');
    assert(empty.includes('id="journal-log-table-empty">[NO JOURNAL RECORDS YET]'), 'log empty');
    assert(empty.includes('YOUR TRADES [NO JOURNAL TRADES YET]'), 'your-trades readout empty');
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    const html = renderHtml(agg, { outcomes: engineOutcomes, wallet: [], journal: journalSet, journalOutcomes: rows });
    assert(html.includes('id="journal-log-table"') && html.includes('id="engine-vs-you-overrides-table"'), 'tables');
    assert(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'), 'journal text escaped');
    assert(html.includes('"you":[{'), 'your-trades rows in the page data');
    assert(html.includes('"marks":[{'), 'marks in the page data');
    assertEqual((html.match(/class="prov-tag">PROVISIONAL</g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section');
  });

  await test('scoreJournalDataDir + buildPage end to end from the store', () => {
    const dir = tmp();
    appendJournal(dir, journalSet);
    const rows = scoreJournalDataDir(dir, T0 + 3 * 60 * MIN);
    assertEqual(rows.length, 3, 'scored');
    assertEqual(readJsonl(journalOutcomesFile(dir)).length, 3, 'written');
    const out = path.join(dir, 'site');
    buildPage(dir, out, T0 + 3 * 60 * MIN);
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert(html.includes('id="journal-log-table"'), 'journal log on the built page');
  });

  // ------------------------------------------------ rec calls scored on candidate levels
  const cand = (over = {}) => ({ candidateId: 'C', timeframe: '5m', direction: 'long', state: 'forming', breakout: 100, invalidation: 99, measuredRR: 2, ...over });
  const candRec = (klass, over = {}) => rec(klass, { candidateId: null, readiness: 'no_plan', candidate: cand(over) });
  const candCandles = {
    LNG: candles(T0, 40, (i) => (i < 3 ? { h: 99.8, l: 99.5 } : i === 3 ? { h: 100.2, l: 99.9 } : i === 10 ? { h: 102.5, l: 101 } : { h: 100.5, l: 99.6 })),
    SHT: candles(T0, 40, (i) => (i < 2 ? { h: 99.8, l: 99.5 } : i === 2 ? { h: 100.2, l: 99.8 } : i === 8 ? { h: 101.5, l: 100.5 } : { h: 100.4, l: 99.5 })),
    NOF: candles(T0, 40, () => ({ h: 99.6, l: 99.2 }))
  };
  const candRows = [
    captureRow('LNG', T0, null, candRec('WATCH')),
    captureRow('SHT', T0, null, candRec('BAD', { direction: 'short', invalidation: 101 })),
    captureRow('NOF', T0, null, candRec('WATCH'))
  ];

  await test('candidateLevels: long/short mirrored, measuredTarget preferred, bad geometry or no RR -> null', () => {
    assertEqual(JSON.stringify(candidateLevels(candRec('WATCH'))), '{"direction":"long","entry":100,"stop":99,"tp1":102}', 'long from measuredRR');
    assertEqual(JSON.stringify(candidateLevels(candRec('WATCH', { direction: 'short', invalidation: 101 }))), '{"direction":"short","entry":100,"stop":101,"tp1":98}', 'short mirrored');
    assertEqual(candidateLevels(candRec('WATCH', { measuredTarget: 105 })).tp1, 105, 'measuredTarget preferred');
    assertEqual(candidateLevels(candRec('WATCH', { invalidation: 101 })), null, 'long with stop above entry');
    assertEqual(candidateLevels(candRec('WATCH', { measuredTarget: 99.5 })), null, 'long target below entry');
    assertEqual(candidateLevels(candRec('WATCH', { measuredRR: null })), null, 'no measuredRR');
    assertEqual(candidateLevels(candRec('WATCH', { measuredRR: 0 })), null, 'measuredRR 0');
    assertEqual(candidateLevels(rec('WATCH')), null, 'no candidate');
  });

  await test('scorer: rec with no plan but a candidate walks candidate levels (tp1 long, stop short, not_filled)', () => {
    const out = scoreCalls(extractCalls(candRows), candCandles, [], T0 + 2 * 60 * MIN);
    const get = (s) => out.find((r) => r.symbol === s);
    const lng = get('LNG');
    assertEqual(lng.outcome, 'tp1', 'long tp1');
    assertEqual(lng.r, 2, 'R = measuredRR');
    assertEqual(lng.filledAt, iso(T0 + 3 * MIN), 'touch fill');
    assertEqual(lng.levelSource, 'candidate', 'levelSource');
    assertEqual(lng.mode, 'counterfactual_candidate', 'mode');
    assertEqual(lng.kind, 'rec', 'stays a rec row');
    assertEqual(lng.timeframe, '5m', 'candidate timeframe');
    const sht = get('SHT');
    assertEqual(sht.outcome, 'stop', 'short stop');
    assertEqual(sht.r, -1, '-1R');
    assertEqual(sht.levelSource, 'candidate', 'short levelSource');
    assertEqual(get('NOF').outcome, 'not_filled', 'entry never touched in 15 candles');
    assertEqual(get('NOF').mode, 'counterfactual_candidate', 'not_filled mode');
    const base = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    assertEqual(base.find((r) => r.symbol === 'ADA' && r.kind === 'rec').levelSource, null, 'no levels -> null');
    assertEqual(base.find((r) => r.symbol === 'XRP' && r.kind === 'rec').levelSource, 'plan', 'plan levels -> plan');
    assert(base.filter((r) => r.kind === 'plan').every((r) => r.levelSource === 'plan'), 'plan rows -> plan');
  });

  await test('scorer: old no_levels rec row re-scored on candidate levels; other final rows untouched', () => {
    const calls = extractCalls([...candRows, captureRow('BTC', T0, plan(), rec('GOOD'))]);
    const strip = ({ levelSource, ...rest }) => rest;
    const fresh = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, [], T0 + 2 * 60 * MIN);
    const prev = fresh.map((r) => (r.symbol === 'LNG'
      ? { ...strip(r), outcome: 'no_levels', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null, mode: 'not_walked', scoredAt: 'OLD' }
      : r.symbol === 'BTC' ? { ...strip(r), outcome: 'stop', r: -1, scoredAt: 'OLD' } : r));
    const again = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, prev, T0 + 3 * 60 * MIN);
    const lng = again.find((r) => r.symbol === 'LNG');
    assertEqual(lng.outcome, 'tp1', 're-scored');
    assertEqual(lng.levelSource, 'candidate', 'levelSource set');
    assertEqual(lng.scoredAt, iso(T0 + 3 * 60 * MIN), 'scoredAt moved');
    const btc = again.filter((r) => r.symbol === 'BTC');
    assert(btc.every((r) => r.outcome === 'stop' && r.scoredAt === 'OLD'), 'other final rows kept as written');
    assert(btc.every((r) => r.levelSource === 'plan'), 'levelSource backfilled on kept rows');
    const third = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, again, T0 + 4 * 60 * MIN);
    assertEqual(JSON.stringify(third), JSON.stringify(again), 'stable after the one re-score');
  });

  await test('aggregate: candidate rows never move tradable, phase or 7d tiles', () => {
    const base = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const extra = scoreCalls(extractCalls(candRows), candCandles, [], T0 + 2 * 60 * MIN);
    const opts = { phaseStartMs: T0 - 60 * MIN };
    const a = computeAggregates(base, rows, candleSet, T0 + 2 * 60 * MIN, opts);
    const b = computeAggregates([...base, ...extra], rows, candleSet, T0 + 2 * 60 * MIN, opts);
    assertEqual(JSON.stringify(b.phase), JSON.stringify(a.phase), 'phase');
    assertEqual(JSON.stringify(b.windows['7d'].tradable), JSON.stringify(a.windows['7d'].tradable), '7d tradable');
    assertEqual(JSON.stringify(b.totals.tradable), JSON.stringify(a.totals.tradable), 'totals tradable');
    for (const k of ['fills7d', 'winRate7d', 'expectancy7d', 'losingStreak7d']) assertEqual(b.tiles[k], a.tiles[k], k);
    assert(b.classCheck.rows.find((r) => r.key === 'WATCH').fromCandidate === 1, 'candidate rows land in classCheck');
  });

  await test('aggregate: classCheck shape and numbers', () => {
    const r = (klass, outcome, rv, levelSource, at = T0) => ({ kind: 'rec', class: klass, outcome, r: rv, levelSource, calledAt: iso(at), resolvedAt: iso(at), filledAt: rv === null ? null : iso(at) });
    const out = [
      r('BAD', 'stop', -1, 'candidate'), r('BAD', 'stop', -1, 'plan'), r('BAD', 'tp1', 2, 'candidate'), r('BAD', 'no_levels', null, null),
      r('BAD', 'not_filled', null, 'candidate'), r('BAD', 'expired', null, 'candidate'), r('BAD', 'open', null, 'candidate'), r('BAD', 'pending', null, 'plan'),
      r('WATCH', 'tp1', 3, 'candidate'), r('WATCH', 'stop', -1, 'candidate', T0 - 2 * 60 * MIN),
      { kind: 'plan', planStatus: 'ready', outcome: 'tp1', r: 3, levelSource: 'plan', calledAt: iso(T0) }
    ];
    const cc = classCheck(out);
    assertEqual(cc.since, null, 'no phase -> null');
    assertEqual(cc.rows.map((x) => x.key).join(','), 'GOOD,WATCH,BAD', 'GOOD/WATCH/BAD always, no DATA_UNAVAILABLE');
    const good = cc.rows[0];
    assertEqual(good.calls, 0, 'GOOD zero');
    assertEqual(good.winRate, null, 'GOOD winRate null');
    assertEqual(good.expectancy, null, 'GOOD expectancy null');
    const bad = cc.rows[2];
    assertEqual(JSON.stringify([bad.calls, bad.scored, bad.wins, bad.losses, bad.open, bad.notFilled, bad.noLevels, bad.fromPlan, bad.fromCandidate]),
      '[8,3,1,2,2,2,1,1,2]', 'BAD counts');
    assertEqual(bad.winRate, 0.3333, 'BAD win rate 1/3');
    assertEqual(bad.expectancy, 0, 'BAD expectancy (2-1-1)/3');
    assertEqual(cc.rows[1].scored, 2, 'WATCH all time');
    const since = classCheck([...out, r('DATA_UNAVAILABLE', 'no_levels', null, null)], T0 - 60 * MIN);
    assertEqual(since.since, iso(T0 - 60 * MIN), 'since ISO');
    assertEqual(since.rows[1].scored, 1, 'WATCH before phase excluded');
    assertEqual(since.rows[3].key, 'DATA_UNAVAILABLE', 'DATA_UNAVAILABLE when present');
    assertEqual(JSON.stringify(Object.keys(since.rows[0])), JSON.stringify(['key', 'calls', 'scored', 'wins', 'losses', 'open', 'notFilled', 'noLevels', 'winRate', 'expectancy', 'fromPlan', 'fromCandidate']), 'row keys');
    assert(computeAggregates([], [], {}, T0).classCheck.rows.length === 3, 'computeAggregates carries classCheck');
  });

  // ---- served calls (T3)
  const servedRow = (row, servedMs) => ({ ...row, capturedAt: iso(servedMs), source: 'served', servedAt: iso(servedMs) });

  await test('served pull: manifest + day files, source served, cron close dropped, class change kept, deduped, stripped', async () => {
    const dir = tmp();
    const base = 'https://store1.public.blob.vercel-storage.com';
    appendCalls(dir, [captureRow('BTC', T0, plan(), rec('GOOD'))]); // cron already has BTC @ T0
    const day1 = [
      servedRow(captureRow('BTC', T0, plan(), rec('GOOD')), T0 + 20_000), // cron duplicate -> dropped
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 30_000),
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('GOOD', { candidateId: null })), T0 + 15 * MIN + 40_000), // class differs -> kept
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 50_000), // same key -> dropped
      { ...servedRow(captureRow('SOL', T0 + 16 * MIN, null, rec('BAD', { candidateId: null, walletAddress: 'SECRET_ADDR_S' })), T0 + 16 * MIN), account: { address: 'SECRET_ADDR_T' } },
      servedRow(captureRow('SOL', T0 + 17 * MIN, null, null), T0 + 17 * MIN) // no recommendation -> skipped
    ];
    const files = {
      [`${base}/served/manifest.json`]: JSON.stringify({ schemaVersion: 'served-manifest-1', baseUrl: base, days: ['2026-09-20', 'bad'] }),
      [`${base}/served/2026-09-20.jsonl`]: [...day1.map((r) => JSON.stringify(r)), '{torn'].join('\n')
    };
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      const key = url.split('?')[0];
      return files[key] === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => files[key] };
    };
    const r1 = await pullServed(dir, base, fakeFetch, 123);
    assertEqual(r1.days, 1, 'valid days only');
    assertEqual(r1.added, 3, 'added ETH WATCH, ETH GOOD, SOL BAD');
    assertEqual(r1.duplicates, 2, 'cron close + same served key');
    assert(urls.every((u) => u.endsWith('?t=123')), 'cache-busted');
    const all = readAllCalls(dir);
    assertEqual(all.filter((r) => r.source === 'served').length, 3, 'served rows');
    assertEqual(all.filter((r) => r.source === 'cron').length, 1, 'old cron row reads as cron');
    assert(!allText(dir).includes('SECRET_ADDR'), 'sensitive keys stripped');
    const r2 = await pullServed(dir, base, fakeFetch, 124);
    assertEqual(r2.added, 0, 'second pull adds nothing');
    assertEqual(servedKey(day1[1]), `ETH|${iso(T0 + 15 * MIN)}|WATCH|-`, 'served key');
    assertEqual(servedRowsFromLines([{ symbol: 'BTC' }, null, [1], { symbol: 'X', closedThrough: iso(T0) }]).length, 0, 'rows need symbol, close, recommendation');
    const none = await pullServed(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assertEqual(none.added, 0, 'no manifest -> nothing');
  });

  await test('served pull: only days from the newest stored served day minus one are fetched', async () => {
    const dir = tmp();
    const base = 'https://store2.public.blob.vercel-storage.com';
    const day = (d) => `2026-09-${d}`;
    const files = { [`${base}/served/manifest.json`]: JSON.stringify({ baseUrl: base, days: [day(18), day(19), day(20), day(21)] }) };
    for (const d of [18, 19, 20, 21]) {
      const ms = Date.parse(`${day(d)}T12:00:00.000Z`);
      files[`${base}/served/${day(d)}.jsonl`] = JSON.stringify(servedRow(captureRow('BTC', ms, null, rec('WATCH', { candidateId: null })), ms + 1000)) + '\n';
    }
    const urls = [];
    const fakeFetch = async (url) => { urls.push(url.split('?')[0]); const t = files[url.split('?')[0]]; return t === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => t }; };
    assertEqual((await pullServed(dir, base, fakeFetch, 1)).days, 4, 'first pull reads every day');
    urls.length = 0;
    assertEqual((await pullServed(dir, base, fakeFetch, 2)).days, 2, 'then newest stored day minus one');
    assert(!urls.some((u) => u.includes(day(18)) || u.includes(day(19))), 'older days skipped');
  });

  await test('served GOOD call on a ready plan scores ready_prefilled exactly like cron; dims.source split', () => {
    const cronRows = [captureRow('BTC', T0, plan(), rec('GOOD'))];
    const servedRows = [servedRow(captureRow('BTC', T0, plan(), rec('GOOD')), T0 + 30_000)];
    const strip = (r) => { const { dims, capturedAt, ...rest } = r; const { source, ...d } = dims; return JSON.stringify({ ...rest, d }); };
    const a = scoreCalls(extractCalls(cronRows), candleSet, [], T0 + 2 * 60 * MIN);
    const b = scoreCalls(extractCalls(servedRows), candleSet, [], T0 + 2 * 60 * MIN);
    const goodA = a.find((r) => r.kind === 'rec');
    const goodB = b.find((r) => r.kind === 'rec');
    assertEqual(goodB.mode, 'ready_prefilled', 'mode');
    assertEqual(goodB.outcome, 'tp1', 'outcome');
    assertEqual(goodA.dims.source, 'cron', 'cron source');
    assertEqual(goodB.dims.source, 'served', 'served source');
    assertEqual(callDims({}).source, 'cron', 'rows without source read as cron');
    assertEqual(a.length, b.length, 'same calls');
    for (let i = 0; i < a.length; i++) assertEqual(strip(b[i]), strip(a[i]), `call ${i} identical apart from source`);
    assertEqual(callVia(goodB), 'chat', 'via chat');
    assertEqual(callVia({ dims: {} }), 'cron', 'via cron default');
    assert(FILTER_DIMS.some(([k]) => k === 'via'), 'via filter dim');
    assertEqual(equityRows(b).find(() => true).f.via, 'chat', 'equity row carries via');
  });

  await test('aggregate: served rows counted in activity, never as runs, last capture or capture health', () => {
    const nowMs = T0 + 60 * MIN;
    const capture = [
      captureRow('BTC', T0, plan(), rec('WATCH')),
      servedRow(captureRow('BTC', T0 + 15 * MIN, plan(), rec('GOOD')), T0 + 15 * MIN + 10_000),
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 10_000),
      servedRow(captureRow('ETH', T0 - 30 * 60 * MIN, null, rec('GOOD', { candidateId: null })), T0 - 30 * 60 * MIN) // older than 24 h
    ];
    const out = scoreCalls(extractCalls(capture), candleSet, [], nowMs);
    const agg = computeAggregates(out, capture, {}, nowMs);
    assertEqual(agg.activity.served24h, 2, 'served 24h');
    assertEqual(agg.activity.servedGood24h, 1, 'served GOOD 24h');
    assertEqual(agg.activity.runs, 1, 'runs = cron capture minutes only');
    assertEqual(agg.tiles.lastCapture, iso(T0 + 2000), 'last capture from cron');
    assertEqual(agg.captures.captures, 1, 'capture health counts cron rows');
    const html = renderHtml(agg, { outcomes: out });
    assert(html.includes('id="activity-served-row"'), 'served activity row');
    assert(/id="activity-served-row"><dt>Seen in chat · 24 h<\/dt><dd[^>]*>2 <span class="st-good">\(1 GOOD\)<\/span>/.test(html), 'served count and GOOD count');
    assert(/<th>Via<\/th>/.test(html), 'Via column');
    assert(/<td[^>]*>chat<\/td><\/tr>/.test(html), 'served call shows chat');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'exactly one executable inline script');
    assert(!/gradient|box-shadow|drop-shadow/i.test(html), 'no gradients or shadows');
  });

  // ---------------------------------------------------------------- T4 flag paths (paths.js, docs/PLAN_FLAG_PATHS.md P0)

  const tfRows = (startMs, stepMs, cs) => cs.map((r, i) => ({ timestamp: startMs + i * stepMs, open: r.o, high: r.h, low: r.l, close: r.c }));
  const toStoreCandles = (symbol, arr) => arr.map((c) => ({ symbol, t: iso(c.timestamp), o: c.open, h: c.high, l: c.low, c: c.close, v: 0 }));
  const allStoreCandles = (bySymbol) => Object.entries(bySymbol).flatMap(([sym, arr]) => toStoreCandles(sym, arr));
  const slimCand = (over = {}) => ({
    id: 'BTC:5m:long:tight', tf: '5m', dir: 'long', state: 'proto', breakout: 100, invalidation: 99, measuredRR: 2, qual: null,
    measuredTarget: null, compressionScore: null, durationCandles: null, impulseStrength: null, flagHigh: null, flagLow: null, ...over
  });
  const candCaptureRow = (symbol, ms, candidateSetups, flagRecommendation = null, over = {}) =>
    ({ ...captureRow(symbol, ms, null, flagRecommendation), candidateSetups, ...over });

  await test('derive3mFrom1m: full UTC-aligned 3-minute buckets only, partial trailing bucket dropped', () => {
    const c1m = candles(T0, 7, () => ({ h: 1, l: 0 }));
    const out = derive3mFrom1m({ BTC: c1m }).BTC;
    assertEqual(out.length, 2, 'two full buckets from 7 one-minute candles');
    assertEqual(out[0].timestamp, T0, 'first bucket starts at T0');
    assertEqual(out[1].timestamp, T0 + 3 * MIN, 'second bucket starts 3m later');
    assertEqual(out[0].close, c1m[2].close, 'bucket close is its third 1m candle close');
  });

  await test('candidatesInRow: candidateSetups preferred over the flagRecommendation.candidate summary; legacy rows (no T4 fields) still parse to null', () => {
    const rich = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [slimCand({ measuredTarget: 103, compressionScore: 0.8, durationCandles: 6, impulseStrength: 3 })], flagRecommendation: null };
    const c = candidatesInRow(rich).get('BTC:5m:long:tight');
    assertEqual(c.measuredTarget, 103, 'richer candidateSetups value wins');
    const legacy = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [{ id: 'legacy1', tf: '5m', dir: 'long', state: 'proto', breakout: 100, invalidation: 99, measuredRR: 2, qual: null }], flagRecommendation: null };
    const lc = candidatesInRow(legacy).get('legacy1');
    assert(lc, 'legacy candidate (no T4 fields) parsed');
    for (const k of ['measuredTarget', 'compressionScore', 'durationCandles', 'impulseStrength', 'flagHigh', 'flagLow']) assertEqual(lc[k], null, `${k} null on a legacy row`);
    const feats = featuresAt({ ...lc, timeframe: lc.tf }, {});
    assertEqual(feats.compression, 'unknown', 'compression unknown for a legacy row');
    assertEqual(feats.duration, 'unknown', 'duration unknown for a legacy row');
    assertEqual(feats.impulseStrength, 'unknown', 'impulseStrength unknown for a legacy row');
    const summaryOnly = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [], flagRecommendation: { class: 'WATCH', candidateId: 'sum1', candidate: { candidateId: 'sum1', timeframe: '3m', direction: 'short', state: 'forming', breakout: 50, invalidation: 51, measuredRR: 2 } } };
    const su = candidatesInRow(summaryOnly).get('sum1');
    assertEqual(su.tf, '3m', 'flagRecommendation.candidate summary fills in an id candidateSetups did not carry');
    assertEqual(su.measuredTarget, null, 'summary carries no measuredTarget');
  });

  await test('extractTighteningPoints / computePathsRows: pure in-memory unit (no disk), earliest forming/proto sighting only, any input order', () => {
    const cid = 'SOL:3m:short:unit';
    const r1 = candCaptureRow('SOL', T0, [slimCand({ id: cid, tf: '3m', dir: 'short', state: 'forming', breakout: 20, invalidation: 21 })]);
    const r2 = candCaptureRow('SOL', T0 + 3 * MIN, [slimCand({ id: cid, tf: '3m', dir: 'short', state: 'triggering', breakout: 20, invalidation: 21 })]);
    const tightened = extractTighteningPoints([r2, r1]); // reversed input order
    assertEqual(tightened.length, 1, 'one candidate');
    assertEqual(tightened[0].tighteningAt, iso(T0), 'earliest forming/proto capture, regardless of input order');
    assertEqual(tightened[0].symbol, 'SOL', 'symbol');
    assertEqual(tightened[0].source, 'cron', 'default source');
    const out = computePathsRows([r1, r2], { '3m': {}, '1m': {} }, [], T0 + 50 * MIN);
    assertEqual(out.length, 1, 'computePathsRows finds it too');
    assertEqual(out[0].status, 'pending', 'no candle data at all -> chop -> pending, window (24 x 3m = 72min) not yet elapsed');
    assertEqual(out[0].path, 'chop', 'no data to resolve against');
  });

  await test('paths.js: tightening point detection, served-first-sighting source, runner path resolved, idempotent (frozen labelledAt)', () => {
    const dir = tmp();
    const cid = 'BTC:5m:long:tight';
    const pCandles5m = tfRows(T0, 5 * MIN, [
      { o: 99.6, h: 99.9, l: 99.4, c: 99.7 }, // forming
      { o: 99.7, h: 100.5, l: 99.6, c: 100.4 }, // breakout close
      { o: 100.4, h: 101.2, l: 100.3, c: 101.0 }
    ]);
    const p1m = tfRows(T0 + 5 * MIN, MIN, [
      { o: 100.4, h: 100.5, l: 100.35, c: 100.45 },
      { o: 100.45, h: 100.7, l: 100.4, c: 100.65 },
      { o: 100.65, h: 100.9, l: 100.6, c: 100.85 },
      { o: 100.85, h: 101.05, l: 100.8, c: 101.0 }, // target touch (+1R = 101)
      { o: 101.0, h: 101.2, l: 100.95, c: 101.15 }
    ]);
    appendCandles(dir, '5m', toStoreCandles('BTC', pCandles5m));
    appendCandles(dir, '1m', toStoreCandles('BTC', p1m));
    appendCalls(dir, [
      candCaptureRow('BTC', T0, [slimCand({ id: cid, state: 'proto' })], { class: 'WATCH', candidateId: cid, candidate: { candidateId: cid } }, { source: 'served' }),
      candCaptureRow('BTC', T0 + 5 * MIN, [slimCand({ id: cid, state: 'confirmed' })])
    ]);
    const out = pathsDataDir(dir, T0 + 30 * MIN);
    assertEqual(out.length, 1, 'one row per candidate despite two captures');
    const r = out[0];
    assertEqual(r.candidateId, cid, 'candidateId');
    assertEqual(r.symbol, 'BTC', 'symbol');
    assertEqual(r.tf, '5m', 'tf');
    assertEqual(r.direction, 'long', 'direction');
    assertEqual(r.tighteningAt, iso(T0), 'tightening at the first proto sighting, not the later confirmed one');
    assertEqual(r.source, 'served', 'first sighting source recorded');
    assertEqual(r.recClass, 'WATCH', 'recClass at tightening (flagRecommendation names this candidate)');
    assertEqual(r.status, 'resolved', 'runner resolves on its own (has its own resolvedAt); window need not elapse');
    assertEqual(r.path, 'runner', 'runner path');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt (ms, labelPath field)');
    assertEqual(r.resolvedAt, T0 + 8 * MIN, 'resolvedAt at the target touch (ms)');
    assertEqual(r.minutes, 8, 'minutes from tightening to resolution');
    assert(r.labelledAt, 'labelledAt set once resolved');
    assertEqual(r.features.tf, '5m', 'featuresAt tf (candidate.timeframe alias)');
    assertEqual(r.features.direction, 'long', 'featuresAt direction');

    const again = pathsDataDir(dir, T0 + 60 * MIN);
    assertEqual(JSON.stringify(again), JSON.stringify(out), 'resolved row frozen byte-for-byte on rerun (idempotent, like score.js)');
  });

  await test('paths.js: pending while the window has not elapsed, resolved chop once it has, then frozen', () => {
    const dir = tmp();
    const cid = 'ETH:5m:long:flat';
    const flatCandles = tfRows(T0, 5 * MIN, Array.from({ length: 6 }, () => ({ o: 49.5, h: 49.6, l: 49.4, c: 49.5 })));
    appendCandles(dir, '5m', toStoreCandles('ETH', flatCandles));
    appendCalls(dir, [candCaptureRow('ETH', T0, [slimCand({ id: cid, tf: '5m', dir: 'long', breakout: 50, invalidation: 49 })])]);

    const soon = pathsDataDir(dir, T0 + 30 * MIN);
    assertEqual(soon.length, 1, 'one candidate');
    assertEqual(soon[0].status, 'pending', 'window (24 x 5m = 120min) has not elapsed yet');
    assertEqual(soon[0].path, 'chop', 'nothing has happened yet');
    assertEqual(soon[0].labelledAt, null, 'not labelled while pending');

    const late = pathsDataDir(dir, T0 + 130 * MIN);
    assertEqual(late[0].status, 'resolved', 'window has now elapsed - final chop');
    assertEqual(late[0].path, 'chop', 'still chop');
    assert(late[0].labelledAt, 'labelledAt set on the run that resolves it');
    const firstLabelledAt = late[0].labelledAt;

    const evenLater = pathsDataDir(dir, T0 + 999 * MIN);
    assertEqual(JSON.stringify(evenLater), JSON.stringify(late), 'resolved chop frozen, labelledAt never moves again');
    assertEqual(evenLater[0].labelledAt, firstLabelledAt, 'labelledAt unchanged');
  });

  await test('pathsSummary: base rates over resolved rows only, windowed by tighteningAt, by tf; uncalibrated under n=100', () => {
    const mk = (id, tf, tighteningAt, p) => ({
      candidateId: id, symbol: 'BTC', tf, direction: 'long', tighteningAt, source: 'cron', recClass: null, status: 'resolved',
      path: p, breakoutAt: null, retestAt: null, resolvedAt: null, mfeR: null, targetR: null, minutes: null, features: {}, labelledAt: tighteningAt
    });
    const nowMs = T0 + 10 * 24 * 60 * MIN;
    const rows2 = [
      mk('a', '5m', iso(nowMs - 1 * 24 * 60 * MIN), 'runner'),
      mk('b', '5m', iso(nowMs - 2 * 24 * 60 * MIN), 'retest_go'),
      mk('c', '3m', iso(nowMs - 3 * 24 * 60 * MIN), 'chop'),
      mk('d', '5m', iso(nowMs - 10 * 24 * 60 * MIN), 'runner'), // outside 7d, inside 30d
      { ...mk('e', '5m', iso(nowMs - 1 * 24 * 60 * MIN), 'runner'), status: 'pending' } // excluded, not resolved
    ];
    const s = pathsSummary(rows2, nowMs);
    assertEqual(s.d7.n, 3, '7d: a, b, c (d is outside 7d, e is pending)');
    assertEqual(s.d7.overall.n, 3, 'overall n');
    assertEqual(s.d7.overall.calibrated, false, 'n < 100 -> uncalibrated');
    assertEqual(s.d7.overall.shares.runner, 33.33, 'runner share 1/3');
    const tf5 = s.d7.byTf.find((g) => g.key === '5m');
    assertEqual(tf5.n, 2, '5m bucket n (a, b)');
    assertEqual(s.d30.n, 4, '30d also includes d');
    const empty = pathsSummary([], nowMs);
    assertEqual(empty.d7.n, 0, 'empty rows -> n 0');
    assertEqual(empty.d7.overall.calibrated, false, 'empty -> uncalibrated');
  });

  await test('paths.js: outcomes.jsonl and aggregates.json byte-identical whether or not the step runs', () => {
    const dirA = tmp();
    const dirB = tmp();
    const cid = 'BTC:5m:long:byte-check';
    const extraRow = candCaptureRow('BTC', T0 + 50 * MIN, [slimCand({ id: cid, state: 'proto' })]);
    const allRows = [...rows, extraRow];
    for (const d of [dirA, dirB]) {
      appendCalls(d, allRows);
      appendCandles(d, '1m', allStoreCandles(candleSet));
    }
    scoreDataDir(dirA, T0 + 2 * 60 * MIN);
    scoreDataDir(dirB, T0 + 2 * 60 * MIN);
    aggregateDataDir(dirA, T0 + 2 * 60 * MIN);
    aggregateDataDir(dirB, T0 + 2 * 60 * MIN);
    const outcomesBefore = readFileSync(outcomesFile(dirB), 'utf8');
    const aggBefore = readFileSync(aggregatesFile(dirB), 'utf8');

    const pathsOut = pathsDataDir(dirB, T0 + 2 * 60 * MIN);
    assert(pathsOut.length >= 1, 'paths.js found the injected tightening candidate');

    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), outcomesBefore, 'outcomes.jsonl byte-identical after running paths.js');
    assertEqual(readFileSync(aggregatesFile(dirB), 'utf8'), aggBefore, 'aggregates.json byte-identical after running paths.js');
    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), readFileSync(outcomesFile(dirA), 'utf8'), 'outcomes.jsonl identical vs a dir that never ran paths.js');
  });

  await test('page: flag-paths tile renders with ids and the empty state from an empty data dir', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['flag-paths-section', 'flag-paths-empty']) assert(html.includes(`id="${id}"`), `missing #${id}`);
    assert(html.includes('[NO RESOLVED FLAG PATHS YET]'), 'empty state text');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section (paths tile included)');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'still exactly one executable inline script');
    assert(html.indexOf('id="class-check-section"') < html.indexOf('id="flag-paths-section"'), 'placed after class check in the performance zone');
  });

  await test('page: flag-paths tile renders populated rows with the path mix and an uncalibrated tag under n=100', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const resolvedRow = {
      candidateId: 'BTC:5m:long:x', symbol: 'BTC', tf: '5m', direction: 'long', tighteningAt: iso(T0), source: 'cron',
      recClass: 'WATCH', status: 'resolved', path: 'runner', breakoutAt: T0 + 5 * MIN, retestAt: null, resolvedAt: T0 + 8 * MIN,
      mfeR: 1.5, targetR: 2, minutes: 8,
      features: {
        compression: 'tight', duration: 'short', impulseStrength: 'moderate', tf: '5m', direction: 'long', levelTests: 'unknown',
        structureSteps: 'unknown', stochSide: 'unknown', stochSlope: 'unknown', tfAgreement: 'unknown', tdSide: 'unknown', ema200Side: 'unknown', roomR: 'unknown', hourUtc: '00-06'
      },
      labelledAt: iso(T0 + 8 * MIN)
    };
    writeJsonl(pathsFile(dataDir), [resolvedRow]);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="flag-paths-7d-table"'), 'populated 7d table renders');
    assert(html.includes('UNCALIBRATED'), 'n=1 < 100 -> flagged uncalibrated');
    assert(html.includes('100%'), 'runner share visible (1/1 = 100%)');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'still one provisional tag per section');
  });

  await test('parseArgs: --data default ./data, --out default ./docs', () => {
    assertEqual(parseArgs([]).data, './data', 'data default');
    assertEqual(parseArgs([]).out, './docs', 'out default');
    assertEqual(parseArgs(['--data', '/x', '--out', '/y']).out, '/y', 'out');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
