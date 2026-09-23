/**
 * Test suite: lib/pythMark.js (P1, schema 1.16.0)
 *
 * Rules under test:
 *   1. One Hermes request for every symbol, Bearer auth, parsed=true.
 *   2. No key → every symbol unavailable and no request at all.
 *   3. Never throws: HTTP error, network error, timeout, bad body all read unavailable.
 *   4. price/conf scale by expo; driftBps signed both ways, 1 decimal; stale by age.
 *   5. An unavailable mark never moves dataStatus or adds a warning.
 *   6. The key and the request URL never reach a log line.
 *
 * No network calls: the HTTP layer is a stub.
 */

import { fetchPythMarks, buildMark, markTraceToken, compactMark, scaleByExpo, parseParsedEntry, HERMES_BASE_URL } from './lib/pythMark.js';
import { buildScalpContext } from './services/scalpContext.js';
import { ENGINE_CONFIG } from './config/engine.js';

const FEEDS = ENGINE_CONFIG.mark.pyth.feedIds;
const KEY = 'test-key-SHOULD-NEVER-BE-LOGGED';
const NOW_S = 1_800_000_000;

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
    failed++;
    failures.push(name);
  }
}

/** Capture console.log/warn/error while fn runs; returns the joined text. */
async function captureLogs(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const grab = (...args) => lines.push(args.map(String).join(' '));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

function entry(id, price, conf, expo, publishTime) {
  return { id, price: { price: String(price), conf: String(conf), expo, publish_time: publishTime }, ema_price: {}, metadata: {} };
}

/** Hermes stub: records every call, answers from `respond(url, init)`. */
function makeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetchImpl, calls };
}

const okBody = (entries) => ({ ok: true, status: 200, json: async () => ({ binary: { encoding: 'hex', data: [] }, parsed: entries }) });

const liveLike = () => [
  entry(FEEDS.BTC, 8445290000000, 3512345678, -8, NOW_S - 2),
  entry(FEEDS.ETH, 267738000000, 150000000, -8, NOW_S - 2),
  entry(FEEDS.SOL, 11450000000, 9000000, -8, NOW_S - 2)
];

async function run() {
  console.log('\nPyth mark (P1)\n');

  await test('expo handling: expo -8 scales exactly; expo 0 and positive expo work', () => {
    assertEqual(scaleByExpo('8445290000000', -8), 84452.9, 'expo -8');
    assertEqual(scaleByExpo('11450000000', -8), 114.5, 'SOL expo -8');
    assertEqual(scaleByExpo('42', 0), 42, 'expo 0');
    assertEqual(scaleByExpo('42', 2), 4200, 'expo +2');
    assertEqual(scaleByExpo('abc', -8), null, 'non-numeric');
  });

  await test('parse: price, conf and publish_time from parsed[].price', () => {
    const r = parseParsedEntry(entry(FEEDS.BTC, 8445290000000, 3512345678, -8, NOW_S));
    assertEqual(r.status, 'ok', 'status');
    assertEqual(r.price, 84452.9, 'price');
    assertEqual(r.conf, 35.12345678, 'conf scaled by the same expo');
    assertEqual(r.publishTime, NOW_S, 'publishTime');
    assertEqual(parseParsedEntry({ id: 'x' }).status, 'unavailable', 'no price block');
    assertEqual(parseParsedEntry(entry('x', 0, 1, -8, NOW_S)).status, 'unavailable', 'zero price');
  });

  await test('one request for all symbols: ids[] for each, parsed=true, Bearer header only', async () => {
    const { fetchImpl, calls } = makeFetch(() => okBody(liveLike()));
    const marks = await fetchPythMarks(['BTC', 'SOL', 'ETH'], { apiKey: KEY, fetchImpl });
    assertEqual(calls.length, 1, 'exactly one request');
    const { url, init } = calls[0];
    assert(url.startsWith(`${HERMES_BASE_URL}/v2/updates/price/latest?`), `path ${url}`);
    for (const sym of ['BTC', 'SOL', 'ETH']) assert(url.includes(`ids[]=${FEEDS[sym]}`), `${sym} id in query`);
    assert(url.endsWith('&parsed=true'), 'parsed=true');
    assert(!url.includes(KEY), 'key never in the URL');
    assertEqual(init.headers.Authorization, `Bearer ${KEY}`, 'Bearer header');
    assert(!('X-API-Key' in init.headers) && !('api-key' in init.headers), 'no other key header');
    assertEqual(marks.BTC.price, 84452.9, 'BTC');
    assertEqual(marks.ETH.price, 2677.38, 'ETH');
    assertEqual(marks.SOL.price, 114.5, 'SOL');
  });

  await test('response ids with a 0x prefix still match', async () => {
    const { fetchImpl } = makeFetch(() => okBody([entry(`0x${FEEDS.BTC}`, 100, 1, 0, NOW_S)]));
    const marks = await fetchPythMarks(['BTC'], { apiKey: KEY, fetchImpl });
    assertEqual(marks.BTC.status, 'ok', 'status');
    assertEqual(marks.BTC.price, 100, 'price');
  });

  await test('no key → every symbol unavailable and no request', async () => {
    const { fetchImpl, calls } = makeFetch(() => okBody(liveLike()));
    let marks;
    await captureLogs(async () => { marks = await fetchPythMarks(['BTC', 'SOL', 'ETH'], { apiKey: '', fetchImpl }); });
    assertEqual(calls.length, 0, 'no request without a key');
    for (const sym of ['BTC', 'SOL', 'ETH']) assertEqual(marks[sym].status, 'unavailable', sym);
    // Default path: the key comes from process.env.PYTH_API_KEY; unset means no request.
    const savedKey = process.env.PYTH_API_KEY;
    delete process.env.PYTH_API_KEY;
    try {
      await captureLogs(async () => { marks = await fetchPythMarks(['BTC'], { fetchImpl }); });
    } finally {
      if (savedKey !== undefined) process.env.PYTH_API_KEY = savedKey;
    }
    assertEqual(calls.length, 0, 'env key unset: no request');
    assertEqual(marks.BTC.status, 'unavailable', 'env key unset: unavailable');
  });

  await test('HTTP 401, network error, timeout and a bad body all read unavailable without throwing', async () => {
    const cases = {
      http401: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      network: async () => { throw new TypeError('fetch failed'); },
      badJson: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
      noParsed: async () => ({ ok: true, status: 200, json: async () => ({ binary: {} }) }),
      timeout: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      })
    };
    for (const [name, fetchImpl] of Object.entries(cases)) {
      let marks;
      await captureLogs(async () => { marks = await fetchPythMarks(['BTC', 'SOL'], { apiKey: KEY, fetchImpl, timeoutMs: 20 }); });
      assertEqual(marks.BTC.status, 'unavailable', `${name}: BTC`);
      assertEqual(marks.SOL.status, 'unavailable', `${name}: SOL`);
      assertEqual(marks.BTC.price, null, `${name}: price null`);
    }
  });

  await test('a feed missing from the response is unavailable; the others stay ok', async () => {
    const { fetchImpl } = makeFetch(() => okBody([entry(FEEDS.BTC, 100, 1, 0, NOW_S)]));
    const marks = await fetchPythMarks(['BTC', 'ETH'], { apiKey: KEY, fetchImpl });
    assertEqual(marks.BTC.status, 'ok', 'BTC ok');
    assertEqual(marks.ETH.status, 'unavailable', 'ETH missing');
  });

  await test('the key and the request URL never reach a log line', async () => {
    const logs = await captureLogs(async () => {
      await fetchPythMarks(['BTC', 'SOL', 'ETH'], { apiKey: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY}`); } });
      await fetchPythMarks(['BTC'], { apiKey: KEY, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
      await fetchPythMarks(['BTC'], { apiKey: '', fetchImpl: async () => okBody([]) });
    });
    assert(logs.length > 0, 'failures are logged');
    assert(!logs.includes(KEY), 'key leaked into logs');
    assert(!logs.includes('hermes.pyth.network') && !logs.includes('ids[]'), 'URL leaked into logs');
  });

  await test('buildMark: driftBps sign both ways, 1 decimal; ageSec; publishTime ISO', () => {
    const above = buildMark({ status: 'ok', price: 100.123, conf: 0.05, publishTime: NOW_S - 4 }, 100, NOW_S * 1000);
    assertEqual(above.driftBps, 12.3, 'mark above price → positive');
    assertEqual(above.ageSec, 4, 'ageSec');
    assertEqual(above.status, 'ok', 'fresh');
    assertEqual(above.source, 'pyth', 'source');
    assertEqual(above.publishTime, new Date((NOW_S - 4) * 1000).toISOString(), 'ISO publishTime');
    assertEqual(above.conf, 0.05, 'conf carried');
    const below = buildMark({ status: 'ok', price: 99.9, conf: 0.05, publishTime: NOW_S }, 100, NOW_S * 1000);
    assertEqual(below.driftBps, -10, 'mark below price → negative');
  });

  await test('buildMark: stale past maxAgeSec; unavailable raw → null fields; null candle price → null drift', () => {
    const stale = buildMark({ status: 'ok', price: 100, conf: 0, publishTime: NOW_S - 31 }, 100, NOW_S * 1000, 30);
    assertEqual(stale.status, 'stale', '31 s > 30 s');
    assertEqual(buildMark({ status: 'ok', price: 100, conf: 0, publishTime: NOW_S - 30 }, 100, NOW_S * 1000, 30).status, 'ok', '30 s is still ok');
    const un = buildMark({ status: 'unavailable', price: null, conf: null, publishTime: null }, 100, NOW_S * 1000);
    assertEqual(un.status, 'unavailable', 'status');
    for (const k of ['price', 'conf', 'publishTime', 'ageSec', 'driftBps']) assertEqual(un[k], null, `unavailable ${k}`);
    assertEqual(buildMark(undefined, 100, NOW_S * 1000).status, 'unavailable', 'missing raw');
    const noPrice = buildMark({ status: 'ok', price: 100, conf: 0, publishTime: NOW_S }, null, NOW_S * 1000);
    assertEqual(noPrice.driftBps, null, 'no candle price → no drift');
    assertEqual(noPrice.status, 'ok', 'mark itself still ok');
    const future = buildMark({ status: 'ok', price: 100, conf: 0, publishTime: NOW_S + 2 }, 100, NOW_S * 1000);
    assertEqual(future.ageSec, 0, 'publish after build start clamps to 0');
  });

  await test('trace token: mark:<driftBps> or mark:na, always under 12 chars; compact mark shape', () => {
    assertEqual(markTraceToken({ status: 'ok', driftBps: 12.3 }), 'mark:12.3', 'positive');
    assertEqual(markTraceToken({ status: 'stale', driftBps: -4.5 }), 'mark:-4.5', 'stale still carries drift');
    assertEqual(markTraceToken({ status: 'unavailable', driftBps: null }), 'mark:na', 'unavailable');
    assertEqual(markTraceToken(null), 'mark:na', 'null');
    for (const d of [-99.9, 123.4, -1234.5, 99999]) assert(markTraceToken({ status: 'ok', driftBps: d }).length < 12, `${d}: ${markTraceToken({ status: 'ok', driftBps: d })}`);
    const full = buildMark({ status: 'ok', price: 101, conf: 1, publishTime: NOW_S }, 100, NOW_S * 1000);
    const c = compactMark(full);
    assertEqual(JSON.stringify(Object.keys(c)), '["price","driftBps","status"]', 'compact keys');
    assertEqual(c.driftBps, 100, 'compact drift');
  });

  await test('scalpContext: a failed Hermes read leaves dataStatus and warnings untouched', async () => {
    // Flat synthetic candles; enough history for every timeframe.
    const STEP = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
    const now = NOW_S * 1000;
    const fetchCandles = async (_pair, tf) => {
      const step = STEP[tf];
      const last = Math.floor(now / step) * step - step;
      return Array.from({ length: 260 }, (_, i) => {
        const t = last - (259 - i) * step;
        const p = 100 + Math.sin(i / 7);
        return { timestamp: t, open: p, high: p + 0.5, low: p - 0.5, close: p + 0.1, volume: 10, closeTime: t + step };
      });
    };
    const base = { symbols: ['BTC', 'SOL'], now, fetchCandles, fetchAccount: async () => ({ status: 'disabled', margin: { usd: null, byAsset: {} } }) };
    let plain;
    let broken;
    let calls = 0;
    await captureLogs(async () => {
      plain = await buildScalpContext({ ...base, fetchMarks: null });
      broken = await buildScalpContext({
        ...base,
        fetchMarks: (syms) => fetchPythMarks(syms, { apiKey: KEY, fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); } })
      });
    });
    assertEqual(calls, 1, 'one Hermes request for the whole build');
    assertEqual(broken.dataStatus, plain.dataStatus, 'dataStatus');
    assertEqual(JSON.stringify(broken.warnings), JSON.stringify(plain.warnings), 'warnings');
    for (const sym of ['BTC', 'SOL']) {
      assertEqual(broken.symbols[sym].mark.status, 'unavailable', `${sym}: mark`);
      assertEqual(broken.symbols[sym].price, plain.symbols[sym].price, `${sym}: price untouched`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(1);
});
