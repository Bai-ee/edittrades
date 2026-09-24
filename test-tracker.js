/**
 * Deterministic tests for scripts/tracker/ (T1 call tracker, docs/PLAN_CALL_TRACKER.md):
 * collector strip (fails closed), dedupe, candle store, vendored walkOutcome parity,
 * scorer on a synthetic day, idempotency, aggregate math, the page from an empty
 * store, the wallet whitelist (data/wallet.jsonl), call filter dimensions, and the charts. All file I/O is under os.tmpdir(); no network.
 *
 * Run: node test-tracker.js
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitiveKey, stripSensitive, findSensitiveKeys, recordsFromPayload, candlesFromPayload, ingestPayload,
  candlesFromKraken, walletRowFromPayload, WALLET_KEYS
} from './scripts/tracker/collect.js';
import { readAllCalls, readCandles, readJsonl, outcomesFile, parseArgs, walletFile, readWallet } from './scripts/tracker/store.js';
import { extractCalls, scoreCalls, scoreDataDir, callDims } from './scripts/tracker/score.js';
import { chartKit, equityRows, filterValues, driftBucket, hourBucket, FILTER_DIMS } from './scripts/tracker/charts.js';
import { statsFor, computeAggregates } from './scripts/tracker/aggregate.js';
import { buildPage, renderHtml, rStatus, PROVISIONAL, EDGE_NOTE, NO_SCORED } from './scripts/tracker/build-page.js';
import { walkOutcome as vendoredWalk } from './scripts/tracker/walk-outcome.js';
import { walkOutcome as sourceWalk } from './scripts/replay-outcomes.js';

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
    assertEqual(JSON.stringify(Object.keys(btc.candidateSetups[0])), '["id","tf","dir","state","breakout","invalidation","measuredRR","qual"]', 'candidate slimmed');
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
    assert(index.includes('id="tracker-how-to-link" href="how-to.html"'), 'index links to how-to');
    assert(howTo.includes('href="index.html"'), 'how-to links back');
    for (const cmd of ['signals', 'trades', 'forming', 'flags', 'track', 'balance', 'data check']) {
      assert(howTo.includes(`<dt>${cmd}</dt>`), `command ${cmd}`);
    }
    for (const id of ['howto-session-section', 'howto-commands-section', 'howto-reading-section', 'howto-follow-ups-section', 'howto-donts-section', 'howto-tracker-section']) {
      assert(howTo.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(!/<script/i.test(howTo), 'no scripts');
    assert(!/SCALP_CONTEXT_API_KEY|Bearer|walletAddress/i.test(howTo), 'no secrets or wallet fields');
    assert(howTo.includes('prefers-color-scheme: dark') && howTo.includes('prefers-color-scheme: light'), 'both schemes');
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
