/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - integration test for
 * scripts/research/tracker-evidence/horizon-backfill.js against a tiny hand-built
 * `data/calls` + `data/candles` fixture dir (same on-disk shape `scripts/tracker/store.js`
 * writes), built fresh in a temp dir per run and removed after.
 *
 * Run: node test-wp10-horizon-backfill.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHorizonRows, summarize } from './scripts/research/tracker-evidence/horizon-backfill.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(actual, expected, tol, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: not finite (${actual})`);
  assert(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
}

const BASE = Date.parse('2026-02-01T00:00:00.000Z');
function iso(mins) { return new Date(BASE + mins * 60000).toISOString(); }

function buildFixtureDataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp10-horizon-'));
  mkdirSync(path.join(dir, 'calls'), { recursive: true });
  mkdirSync(path.join(dir, 'candles'), { recursive: true });

  // One WATCH row (no plan, short-leaning candidate) and one row with a rejected plan
  // (carries entry/stop even though rejected), both at decision time minutes(0). A
  // second symbol row deliberately carries no directional evidence.
  const rows = [
    {
      capturedAt: iso(0), closedThrough: iso(0), schemaVersion: '1.0.0', configVersion: 'x',
      dataStatus: 'complete', symbol: 'BTC', price: 100, mark: { price: 100.1, driftBps: 1, status: 'ok' },
      flagTradePlan: null,
      flagRecommendation: { class: 'WATCH', candidate: { candidateId: 'BTC:1m:short:c1', direction: 'short' }, primaryReason: { code: 'need_confirmed_flag_plan' }, supports: ['divergence_agrees'], opposes: ['ct:4h'], trace: { score: null } },
      candidateSetups: [{ id: 'BTC:1m:short:c1', tf: '1m', dir: 'short', state: 'forming', qual: { quality: 'high', decision: 'watch', reasons: ['ct:4h'] } }],
      bias: null, pathOutlook: null, breakoutEntry: null
    },
    {
      capturedAt: iso(0), closedThrough: iso(0), schemaVersion: '1.0.0', configVersion: 'x',
      dataStatus: 'complete', symbol: 'ETH', price: 200, mark: { price: 200.2, driftBps: 1, status: 'ok' },
      flagTradePlan: { candidateId: 'ETH:5m:long:c2', direction: 'long', status: 'rejected', reasonCode: 'chase', entry: 200, stop: 198 },
      flagRecommendation: { class: 'BAD', candidate: null, primaryReason: { code: 'chase' }, supports: [], opposes: ['chase'], trace: { score: null } },
      candidateSetups: [],
      bias: null, pathOutlook: null, breakoutEntry: null
    }
  ];
  writeFileSync(path.join(dir, 'calls', '2026-02-01.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // BTC 1m candles: rally hard for 15 minutes (long move), used to sanity-check both
  // directions of the metric from a short-leaning row.
  const btc1m = [];
  for (let i = 0; i < 20; i++) {
    btc1m.push({ symbol: 'BTC', t: iso(i), o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 });
  }
  // ETH 1m candles: drop, so the rejected long plan's stop (198, 1% below entry 200) is
  // reachable within the window for an R sanity check.
  const eth1m = [];
  for (let i = 0; i < 20; i++) {
    eth1m.push({ symbol: 'ETH', t: iso(i), o: 200 - i, h: 200.5 - i, l: 199 - i, c: 200 - i, v: 1 });
  }
  writeFileSync(path.join(dir, 'candles', '1m.jsonl'), [...btc1m, ...eth1m].map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'candles', '15m.jsonl'), '');
  return dir;
}

console.log('WP10 horizon-backfill.js');

const dataDir = buildFixtureDataDir();
try {
  const { rows, dayFiles } = buildHorizonRows(dataDir);

  test('reads both deduped rows, one per symbol', () => {
    assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
    assert(dayFiles.length === 1, 'expected 1 day file');
  });

  test('BTC row: leaned short, qual.quality high, opposes carried through', () => {
    const btc = rows.find((r) => r.symbol === 'BTC');
    assert(btc.direction === 'short', `expected short, got ${btc.direction}`);
    assert(btc.qualQuality === 'high', `expected high, got ${btc.qualQuality}`);
    assert(btc.opposes.includes('ct:4h'), 'expected ct:4h in opposes');
    assert(btc.candidateId === 'BTC:1m:short:c1', 'expected candidateId from candidate');
  });

  test('BTC row: 15m horizon complete, short-perspective close return negative (price rose)', () => {
    const btc = rows.find((r) => r.symbol === 'BTC');
    assert(btc.horizons['15m'].state === 'complete', `expected complete, got ${btc.horizons['15m'].state}`);
    // price rose from 100 toward 114 over 15 candles -> bad for a short
    assert(btc.horizons['15m'].closeReturnPct > 0, 'expected positive raw close return (price rose)');
  });

  test('ETH row: plan risk basis used (riskPct=1%), R-equivalents computed', () => {
    const eth = rows.find((r) => r.symbol === 'ETH');
    assert(eth.riskSource === 'plan', `expected plan risk source, got ${eth.riskSource}`);
    assertClose(eth.riskPct, 1, 1e-6, 'riskPct');
    assert(eth.direction === 'long', `expected long, got ${eth.direction}`);
    // price fell steadily -> a long loses; closeReturnR_long should be negative and roughly
    // -1 candle's worth of pct move / 1% risk per minute of drop.
    assert(eth.horizons['15m'].closeReturnR_long < 0, 'expected negative R for a long into a falling market');
  });

  const summary = summarize(rows);
  test('summarize: every row counted exactly once per horizon', () => {
    for (const label of ['15m', '1h', '4h']) {
      const s = summary[label];
      const total = s.pending + s.complete + s.partial + s.unscorable;
      assert(total === s.total && s.total === 2, `expected 2 rows accounted for at ${label}, got ${total}`);
    }
  });

  test('summarize: 1h/4h horizons read pending (fixture only has 20 minutes of candles)', () => {
    assert(summary['1h'].pending === 2, `expected 2 pending at 1h, got ${summary['1h'].pending}`);
    assert(summary['4h'].pending === 2, `expected 2 pending at 4h, got ${summary['4h'].pending}`);
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
