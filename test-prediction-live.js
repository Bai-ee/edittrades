/**
 * Deterministic tests for the T-24 live prediction writer (lib/predictionLive.js,
 * docs/PROMPT_T24_PREDICTION_TRACKER.md "Agent D"). Blob get/put are injected in-memory
 * fakes (no network); `predict` is always injected here too, so nothing in this file
 * depends on lib/predictionRule.js's own T-24 stub decisions - that file is replaced
 * whole by agent A's real rule on merge with no call-site change in lib/predictionLive.js.
 *
 * Run: node test-prediction-live.js
 */

import {
  evaluatePredictions, normalizePredictionsState, emptyPredictionsState,
  predictionId, candleCloseIso, candleDir, predictionsDayPath, PREDICTIONS_MANIFEST_PATH,
  PREDICTION_SYMBOLS, PREDICTION_TIMEFRAMES, HIGHER_TF, RULE_VERSION
} from './lib/predictionLive.js';

let passed = 0;
let failed = 0;
const failures = [];

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

const BASE = 'https://fakestore.public.blob.vercel-storage.com';

/** In-memory Vercel Blob with ETags (same contract as test-served.js/test-journal.js). */
function fakeBlob() {
  const files = new Map();
  let n = 0;
  const state = { files, puts: [] };
  state.get = async (pathname) => {
    const f = files.get(pathname);
    if (!f) return null;
    return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `${BASE}/${pathname}` } };
  };
  state.put = async (pathname, body, opts) => {
    state.puts.push({ pathname, opts });
    const cur = files.get(pathname);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) {
      const err = new Error('Precondition failed'); err.name = 'BlobPreconditionFailedError'; throw err;
    }
    files.set(pathname, { text: String(body), etag: `"e${++n}"` });
    return { url: `${BASE}/${pathname}`, pathname };
  };
  return state;
}

const lines = (text) => String(text || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A closed candle: `close` at `closeIso`, `open` given (defaults to `close`, i.e. flat). */
function candle(closeIso, close, open = close) {
  return { open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, closeTime: Date.parse(closeIso), volume: 10 };
}

const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const CLOSE_1 = '2026-09-24T10:05:00.000Z';
const CLOSE_2 = '2026-09-24T10:10:00.000Z';

/** A fake `predict` returning a fixed decision, ignoring its input. */
const fixedRule = (direction, confidence = 0.6, reason = 'fixed') => () => ({
  direction, confidence, inputs: { ema21Side: 'above', ema200Side: 'above', higherEma21Side: 'above', stoch: 'rising', lastSwing: 'higher-high' }, reason
});

console.log('predictionId / candleCloseIso / candleDir');

await test('predictionId: "<SYM>:<tf>:<closeIso>"', () => {
  assertEqual(predictionId('BTC', '5m', CLOSE_1), `BTC:5m:${CLOSE_1}`, 'id shape');
});

await test('candleCloseIso: prefers closeTime, falls back to timestamp, null when neither', () => {
  assertEqual(candleCloseIso({ closeTime: Date.parse(CLOSE_1) }), CLOSE_1, 'closeTime');
  assertEqual(candleCloseIso({ timestamp: Date.parse(CLOSE_1) }), CLOSE_1, 'timestamp fallback');
  assertEqual(candleCloseIso({}), null, 'neither');
  assertEqual(candleCloseIso(null), null, 'null candle');
});

await test('candleDir: over/under/flat by close vs open, null on missing fields', () => {
  assertEqual(candleDir({ open: 100, close: 101 }), 'over', 'over');
  assertEqual(candleDir({ open: 100, close: 99 }), 'under', 'under');
  assertEqual(candleDir({ open: 100, close: 100 }), 'flat', 'flat');
  assertEqual(candleDir({ open: 100 }), null, 'missing close');
  assertEqual(candleDir(null), null, 'null candle');
});

console.log('\nstate shape');

await test('emptyPredictionsState: every (symbol, timeframe) cell present and null', () => {
  const s = emptyPredictionsState();
  for (const sym of PREDICTION_SYMBOLS) {
    for (const tf of PREDICTION_TIMEFRAMES) {
      assertEqual(s.pending[sym][tf], null, `pending ${sym} ${tf}`);
      assertEqual(s.lastClose[sym][tf], null, `lastClose ${sym} ${tf}`);
    }
  }
});

await test('normalizePredictionsState: garbage input never throws and normalizes to the empty grid', () => {
  for (const garbage of [null, undefined, 42, 'x', [], { pending: 'nope' }, { pending: { BTC: 'nope' } }]) {
    const s = normalizePredictionsState(garbage);
    assertEqual(s.pending.BTC['5m'], null, `pending for ${JSON.stringify(garbage)}`);
    assertEqual(s.lastClose.BTC['5m'], null, `lastClose for ${JSON.stringify(garbage)}`);
  }
});

await test('normalizePredictionsState: keeps a well-formed cell, drops a malformed one, ignores unknown symbols/timeframes', () => {
  const raw = {
    pending: {
      BTC: { '5m': { id: 'BTC:5m:x', direction: 'over', refClose: 100, prevCandleDir: 'under' }, '15m': { id: 'bad', direction: 'sideways', refClose: 1 } },
      XRP: { '5m': { id: 'nope', direction: 'over', refClose: 1 } }
    },
    lastClose: { BTC: { '5m': CLOSE_1, '1h': 'not-a-date' } }
  };
  const s = normalizePredictionsState(raw);
  assert(s.pending.BTC['5m'] && s.pending.BTC['5m'].id === 'BTC:5m:x' && s.pending.BTC['5m'].prevCandleDir === 'under', 'kept the valid cell');
  assertEqual(s.pending.BTC['15m'], null, 'dropped the malformed direction');
  assertEqual(s.lastClose.BTC['5m'], CLOSE_1, 'kept the valid ISO string');
  assertEqual(s.lastClose.BTC['1h'], null, 'dropped the unparseable string');
  assertEqual(s.pending.XRP, undefined, 'unknown symbol not carried through');
});

console.log('\nfirst prediction (no pending)');

await test('first tick with a newly closed candle writes a PREDICTION row only, no RESULT', async () => {
  const store = fakeBlob();
  const candlesByTf = { BTC: { '5m': [candle(CLOSE_1, 100)] } };
  const { state, rows } = await evaluatePredictions({
    payload: { configVersion: 'cfg-1' }, candlesByTf, prevState: null, nowMs: T0, store, predict: fixedRule('over', 0.6, 'r1')
  });
  assertEqual(rows.length, 1, 'one row only');
  const row = rows[0];
  assertEqual(row.kind, 'PREDICTION', 'kind');
  assertEqual(row.id, `BTC:5m:${CLOSE_1}`, 'id');
  assertEqual(row.symbol, 'BTC', 'symbol');
  assertEqual(row.timeframe, '5m', 'timeframe');
  assertEqual(row.closedAt, CLOSE_1, 'closedAt');
  assertEqual(row.refClose, 100, 'refClose');
  assertEqual(row.direction, 'over', 'direction');
  assertEqual(row.confidence, 0.6, 'confidence');
  assertEqual(row.reason, 'r1', 'reason');
  assertEqual(row.configVersion, 'cfg-1', 'configVersion');
  assertEqual(row.ruleVersion, RULE_VERSION, 'ruleVersion');
  assertEqual(typeof row.writtenAt, 'string', 'writtenAt is a string');
  assert(row.inputs && row.inputs.ema21Side === 'above', 'inputs carried through');
  const pending = state.pending.BTC['5m'];
  assert(pending && pending.id === row.id && pending.direction === 'over' && pending.refClose === 100, 'pending stored');
  assertEqual(pending.prevCandleDir, 'flat', 'prevCandleDir from a flat candle (open===close)');
  assertEqual(state.lastClose.BTC['5m'], CLOSE_1, 'lastClose advanced');
  const day = lines(store.files.get(predictionsDayPath('2026-09-24')).text);
  assertEqual(day.length, 1, 'one line in the day file');
  assertEqual(day[0].id, row.id, 'the line is the prediction');
  assert(JSON.parse(store.files.get(PREDICTIONS_MANIFEST_PATH).text).days.includes('2026-09-24'), 'day listed in the manifest');
});

console.log('\nnext close: RESULT + new PREDICTION');

await test('a later new close first writes the RESULT for the pending prediction, then a new PREDICTION', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 100, 99); // open 99, close 100 -> 'over'
  const first = await evaluatePredictions({
    payload: { configVersion: 'cfg-1' }, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over', 0.6)
  });
  const c2 = candle(CLOSE_2, 110); // moved up from refClose 100
  const second = await evaluatePredictions({
    payload: { configVersion: 'cfg-2' }, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('under', 0.4, 'r2')
  });
  assertEqual(second.rows.length, 2, 'two rows: RESULT then PREDICTION');
  const [resultRow, predRow] = second.rows;
  assertEqual(resultRow.kind, 'PREDICTION_RESULT', 'first row is the RESULT');
  assertEqual(resultRow.id, first.rows[0].id, 'RESULT carries the ORIGINAL prediction id');
  assertEqual(resultRow.closedAt, CLOSE_2, 'RESULT closedAt is the NEW close');
  assertEqual(resultRow.refClose, 100, 'RESULT refClose is the original prediction refClose');
  assertEqual(resultRow.nextClose, 110, 'RESULT nextClose is the new close');
  assertEqual(resultRow.hit, true, 'over + price up = hit');
  assertEqual(resultRow.lastCandleDir, 'over', 'lastCandleDir is the candle BEFORE the predicted one (c1: 99->100)');
  assertEqual(predRow.kind, 'PREDICTION', 'second row is the new PREDICTION');
  assertEqual(predRow.id, `BTC:5m:${CLOSE_2}`, 'new id anchored on the new close');
  assertEqual(predRow.direction, 'under', 'new direction');
  assertEqual(predRow.configVersion, 'cfg-2', 'configVersion reflects this tick\'s payload');
  const newPending = second.state.pending.BTC['5m'];
  assertEqual(newPending.id, predRow.id, 'pending replaced by the new prediction');
  assertEqual(second.state.lastClose.BTC['5m'], CLOSE_2, 'lastClose advanced to the new close');
  const day = lines(store.files.get(predictionsDayPath('2026-09-24')).text);
  assertEqual(day.length, 3, 'day file accumulated: 1st prediction + result + 2nd prediction');
});

console.log('\nhit / no_call / tie semantics');

await test('no_call direction always yields hit:null on its RESULT, even on a real move', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 100);
  const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('no_call', 0) });
  const c2 = candle(CLOSE_2, 150);
  const second = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('over') });
  assertEqual(second.rows[0].hit, null, 'no_call -> hit null regardless of the move');
  assert(second.rows[0].moveBps > 0, 'moveBps is still computed');
});

await test('nextClose === refClose yields hit:null even for a real direction, and moveBps 0', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 100);
  const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over') });
  const c2 = candle(CLOSE_2, 100);
  const second = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('under') });
  assertEqual(second.rows[0].hit, null, 'tie -> hit null');
  assertEqual(second.rows[0].moveBps, 0, 'tie -> moveBps 0');
});

await test('hit is true/false correctly for every direction x move combination', async () => {
  const cases = [
    ['over', 110, true], ['over', 90, false], ['under', 90, true], ['under', 110, false]
  ];
  for (const [direction, nextPrice, expected] of cases) {
    const store = fakeBlob();
    const c1 = candle(CLOSE_1, 100);
    const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule(direction) });
    const c2 = candle(CLOSE_2, nextPrice);
    const second = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('over') });
    assertEqual(second.rows[0].hit, expected, `${direction} @ ${nextPrice}`);
  }
});

await test('moveBps rounds to 1 decimal, computed from (nextClose-refClose)/refClose*1e4', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 10000);
  const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over') });
  const c2 = candle(CLOSE_2, 10003.746); // (3.746/10000)*1e4 = 3.746 -> rounds to 3.7
  const second = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('over') });
  assertEqual(second.rows[0].moveBps, 3.7, 'moveBps rounded');
});

console.log('\ndedupe / idempotency / failure handling');

await test('dedupe on a repeated tick: the same latest close produces no rows and an unchanged state', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 100);
  const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over') });
  const again = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('over') });
  assertEqual(again.rows.length, 0, 'no rows on a repeated close');
  assertEqual(JSON.stringify(again.state), JSON.stringify(first.state), 'state unchanged');
  const day = lines(store.files.get(predictionsDayPath('2026-09-24')).text);
  assertEqual(day.length, 1, 'day file not touched again');
});

await test('a Blob write failure is swallowed: no throw, state reverts to prevState, rows empty (safe to retry next tick)', async () => {
  const store = fakeBlob();
  store.put = async () => { throw new Error('network down'); };
  const c1 = candle(CLOSE_1, 100);
  const prevState = null;
  const { state, rows } = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState, nowMs: T0, store, predict: fixedRule('over') });
  assertEqual(rows.length, 0, 'nothing durably written, so no rows reported');
  assertEqual(JSON.stringify(state), JSON.stringify(normalizePredictionsState(prevState)), 'state reverted to prevState, unchanged for a retry');
});

await test('a missing/invalid store is swallowed the same way as a write failure', async () => {
  const c1 = candle(CLOSE_1, 100);
  const { state, rows } = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store: null, predict: fixedRule('over') });
  assertEqual(rows.length, 0, 'no rows without a usable store');
  assertEqual(JSON.stringify(state), JSON.stringify(emptyPredictionsState()), 'state unchanged');
});

console.log('\nmissing candles / multi-cell independence');

await test('a (symbol, timeframe) with no candles this tick is skipped; other cells still process', async () => {
  const store = fakeBlob();
  const { rows, state } = await evaluatePredictions({
    payload: { configVersion: 'cfg' },
    candlesByTf: { BTC: { '5m': [candle(CLOSE_1, 100)], '15m': [] }, ETH: { '5m': [candle(CLOSE_1, 200)] } },
    prevState: null, nowMs: T0, store, predict: fixedRule('over')
  });
  assertEqual(rows.length, 2, 'BTC 5m and ETH 5m only');
  assertEqual(state.lastClose.BTC['15m'], null, 'BTC 15m untouched (no candles)');
  assert(state.lastClose.BTC['5m'] === CLOSE_1 && state.lastClose.ETH['5m'] === CLOSE_1, 'both processed cells advanced independently');
});

await test('predict is called with the cell\'s own candles and its HIGHER_TF candles', async () => {
  const store = fakeBlob();
  const captured = [];
  const c5m = [candle(CLOSE_1, 100)];
  const c15m = [candle(CLOSE_1, 100), candle(CLOSE_2, 101)];
  await evaluatePredictions({
    payload: {}, candlesByTf: { BTC: { '5m': c5m, '15m': c15m } }, prevState: null, nowMs: T0, store,
    predict: (args) => { captured.push(args); return { direction: 'no_call', confidence: 0, inputs: {}, reason: '' }; }
  });
  const call = captured.find((c) => c.timeframe === '5m');
  assert(call, 'predict called for 5m');
  assertEqual(call.symbol, 'BTC', 'symbol passed');
  assertEqual(call.candles, c5m, 'candles is the 5m array');
  assertEqual(call.higherCandles, c15m, `higherCandles is the ${HIGHER_TF['5m']} array`);
});

await test('a throwing predict is treated as no_call and never propagates', async () => {
  const store = fakeBlob();
  const { rows } = await evaluatePredictions({
    payload: {}, candlesByTf: { BTC: { '5m': [candle(CLOSE_1, 100)] } }, prevState: null, nowMs: T0, store,
    predict: () => { throw new Error('rule blew up'); }
  });
  assertEqual(rows[0].direction, 'no_call', 'no_call fallback');
  assertEqual(rows[0].confidence, 0, 'confidence 0 fallback');
});

console.log('\nconfigVersion / row shape / day-file placement');

await test('configVersion comes from payload.configVersion; null when missing or non-string', async () => {
  for (const payload of [{}, { configVersion: 42 }, undefined]) {
    const store = fakeBlob();
    const { rows } = await evaluatePredictions({ payload, candlesByTf: { BTC: { '5m': [candle(CLOSE_1, 100)] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over') });
    assertEqual(rows[0].configVersion, null, `configVersion null for ${JSON.stringify(payload)}`);
  }
});

await test('a RESULT and its later PREDICTION landing on different UTC days go to different day files', async () => {
  const store = fakeBlob();
  const closeDay1 = '2026-09-24T23:55:00.000Z';
  const closeDay2 = '2026-09-25T00:05:00.000Z';
  const c1 = candle(closeDay1, 100);
  const first = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: Date.parse(closeDay1), store, predict: fixedRule('over') });
  const c2 = candle(closeDay2, 105);
  await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: Date.parse(closeDay2), store, predict: fixedRule('over') });
  const day1 = lines(store.files.get(predictionsDayPath('2026-09-24')).text);
  const day2 = lines(store.files.get(predictionsDayPath('2026-09-25')).text);
  assertEqual(day1.length, 1, 'day 1 file has only the original PREDICTION');
  assertEqual(day1[0].kind, 'PREDICTION', 'day 1 line is the PREDICTION');
  assertEqual(day2.length, 2, 'day 2 file has the RESULT and the new PREDICTION');
  assertEqual(day2[0].kind, 'PREDICTION_RESULT', 'day 2 first line is the RESULT (own closedAt is day 2)');
  const manifest = JSON.parse(store.files.get(PREDICTIONS_MANIFEST_PATH).text);
  assert(manifest.days.includes('2026-09-24') && manifest.days.includes('2026-09-25'), 'both days listed');
});

await test('every PREDICTION row and every PREDICTION_RESULT row carries its full contract shape', async () => {
  const store = fakeBlob();
  const c1 = candle(CLOSE_1, 100, 99);
  const first = await evaluatePredictions({ payload: { configVersion: 'cfg' }, candlesByTf: { BTC: { '5m': [c1] } }, prevState: null, nowMs: T0, store, predict: fixedRule('over', 0.6, 'r') });
  const predRow = first.rows[0];
  for (const k of ['id', 'kind', 'symbol', 'timeframe', 'closedAt', 'refClose', 'direction', 'confidence', 'inputs', 'reason', 'configVersion', 'ruleVersion', 'writtenAt']) {
    assert(k in predRow, `PREDICTION row missing ${k}`);
  }
  const c2 = candle(CLOSE_2, 105);
  const second = await evaluatePredictions({ payload: {}, candlesByTf: { BTC: { '5m': [c1, c2] } }, prevState: first.state, nowMs: T0 + 60000, store, predict: fixedRule('under') });
  const resultRow = second.rows[0];
  for (const k of ['id', 'kind', 'symbol', 'timeframe', 'closedAt', 'refClose', 'nextClose', 'moveBps', 'hit', 'lastCandleDir', 'writtenAt']) {
    assert(k in resultRow, `PREDICTION_RESULT row missing ${k}`);
  }
});

console.log('\nconstants');

await test('PREDICTION_TIMEFRAMES / PREDICTION_SYMBOLS / HIGHER_TF match the shared contract', () => {
  assertEqual(PREDICTION_TIMEFRAMES.join(), '5m,15m,1h,4h', 'timeframes');
  assertEqual(PREDICTION_SYMBOLS.join(), 'BTC,ETH,SOL', 'symbols');
  assertEqual(JSON.stringify(HIGHER_TF), JSON.stringify({ '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' }), 'higher-tf map');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
