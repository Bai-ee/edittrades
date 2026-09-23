/**
 * Deterministic tests for scripts/paper-ledger.js (signal-reliability minimum plan,
 * work package 3.3): the local, append-only forward-paper ledger and its separate
 * scoring command. All file I/O happens under a throwaway os.tmpdir() directory,
 * cleaned up at the end - never under paper-ledger/ in the repo.
 *
 * Run: node test-paper-ledger.js
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ledgerIdFor,
  marketInputHash,
  rowsFromPayload,
  appendCalls,
  scoreLedgerRows
} from './scripts/paper-ledger.js';

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

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const readyPlan = (over = {}) => ({
  candidateId: 'BTC:1m:long:2026-09-23T11:00:00.000Z',
  planId: 'BTC:1m:long:2026-09-23T11:00:00.000Z|2026-09-23T12:00:00.000Z|CFG-1',
  timeframe: '1m', direction: 'long', status: 'ready', reasonCode: null,
  entryType: 'retest', entryCondition: 'closed candle retests 1000 and holds at or above it',
  entry: 1000, stop: 990, tp1: 1040, tp2: null, netRR: 3.17, stopDistancePct: 1.0,
  ...over
});

function samplePayload(over = {}) {
  return {
    generatedAt: '2026-09-23T12:00:05.000Z',
    closedThrough: '2026-09-23T12:00:00.000Z',
    schemaVersion: '1.13.0',
    configVersion: 'CFG-1',
    account: { status: 'available', margin: { usd: 12345 } }, // must never leak into the ledger
    symbols: {
      BTC: { flagTradePlan: readyPlan() },
      ETH: { flagTradePlan: null } // a genuine no-trade call
    },
    ...over
  };
}

async function run() {
  console.log('\nscripts/paper-ledger.js\n');

  await test('ledgerIdFor: uses the plan\'s own planId plus status and reasonCode when a plan exists', () => {
    const id = ledgerIdFor('BTC', readyPlan(), '2026-09-23T12:00:00.000Z');
    assertEqual(id, `${readyPlan().planId}|ready|none`, 'ledgerId = planId|status|reasonCode');
  });

  await test('ledgerIdFor: synthesizes a stable no-plan id when there is no plan (a real no-trade call)', () => {
    const id = ledgerIdFor('ETH', null, '2026-09-23T12:00:00.000Z');
    assertEqual(id, 'ETH:no-plan:2026-09-23T12:00:00.000Z', 'synthetic id names the symbol and snapshot');
    assertEqual(ledgerIdFor('ETH', null, '2026-09-23T12:00:00.000Z'), id, 'deterministic - same snapshot, same id');
  });

  await test('marketInputHash: deterministic, and differs when any level differs', () => {
    const a = marketInputHash('BTC', readyPlan(), '2026-09-23T12:00:00.000Z');
    const b = marketInputHash('BTC', readyPlan(), '2026-09-23T12:00:00.000Z');
    assertEqual(a, b, 'same input, same hash');
    const c = marketInputHash('BTC', readyPlan({ entry: 1001 }), '2026-09-23T12:00:00.000Z');
    assert(a !== c, 'a changed level must change the hash');
  });

  await test('rowsFromPayload: one row per symbol, including a genuine no-trade (null plan) call', () => {
    const rows = rowsFromPayload(samplePayload(), Date.UTC(2026, 8, 23, 12, 0, 5));
    assertEqual(rows.length, 2, 'BTC + ETH');
    const btc = rows.find((r) => r.symbol === 'BTC');
    const eth = rows.find((r) => r.symbol === 'ETH');
    assert(btc.plan && btc.plan.status === 'ready', 'BTC carries its ready plan');
    assertEqual(eth.plan, null, 'ETH is recorded as a real no-trade call, not skipped');
    assertEqual(eth.ledgerId, 'ETH:no-plan:2026-09-23T12:00:00.000Z', 'no-trade rows still get a stable ledgerId');
  });

  await test('rowsFromPayload: never carries account/wallet data (market-only)', () => {
    const rows = rowsFromPayload(samplePayload());
    for (const row of rows) {
      const str = JSON.stringify(row);
      assert(!str.includes('12345'), 'the wallet margin figure must never appear in a ledger row');
      assert(!('account' in row), 'no account key at all');
    }
  });

  let dir;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'edittrades-ledger-test-'));
    const ledgerFile = path.join(dir, 'calls.jsonl');

    await test('appendCalls: creates the file and appends one line per symbol', () => {
      const { recorded, duplicates } = appendCalls(ledgerFile, samplePayload());
      assertEqual(recorded.length, 2, 'both BTC and ETH recorded');
      assertEqual(duplicates.length, 0, 'nothing was a duplicate yet');
      assert(existsSync(ledgerFile), 'ledger file was created');
      assertEqual(readJsonl(ledgerFile).length, 2, 'two lines on disk');
    });

    await test('appendCalls: refuses (skips) a duplicate ledgerId; the file is never rewritten', () => {
      const before = readFileSync(ledgerFile, 'utf8');
      const { recorded, duplicates } = appendCalls(ledgerFile, samplePayload());
      assertEqual(recorded.length, 0, 'nothing new to record - same snapshot');
      assertEqual(duplicates.length, 2, 'both rows already exist');
      const after = readFileSync(ledgerFile, 'utf8');
      assertEqual(after, before, 'file bytes are byte-identical - append-only, never rewritten');
    });

    await test('appendCalls: a genuinely new snapshot (different closedThrough) appends alongside the old rows, not replacing them', () => {
      const nextPayload = samplePayload({ closedThrough: '2026-09-23T12:05:00.000Z', generatedAt: '2026-09-23T12:05:05.000Z' });
      nextPayload.symbols.BTC.flagTradePlan = readyPlan({
        candidateId: 'BTC:1m:long:2026-09-23T11:05:00.000Z',
        planId: 'BTC:1m:long:2026-09-23T11:05:00.000Z|2026-09-23T12:05:00.000Z|CFG-1'
      });
      const { recorded } = appendCalls(ledgerFile, nextPayload);
      assertEqual(recorded.length, 2, 'a new snapshot for both symbols');
      assertEqual(readJsonl(ledgerFile).length, 4, 'old rows are still there, plus the two new ones');
    });

    await test('scoreLedgerRows: walks only ready plans against history, skips no-trade rows, never touches the ledger file', () => {
      const rows = readJsonl(ledgerFile);
      const before = readFileSync(ledgerFile, 'utf8');
      // A simple 1m series that fills the BTC plan's entry (1000) then wins at target (1040).
      const candles1m = [
        { timestamp: Date.parse('2026-09-23T12:00:00.000Z'), high: 1001, low: 999 },
        { timestamp: Date.parse('2026-09-23T12:01:00.000Z'), high: 1045, low: 1035 }
      ];
      const outcomes = scoreLedgerRows(rows, { BTC: candles1m, ETH: [] }, { fillWindowCandles: 5, maxHoldCandles: 5 });
      // Two BTC rows (12:00 and 12:05 snapshots) are walkable; the two ETH no-trade rows are not.
      assertEqual(outcomes.length, 2, 'only the two ready BTC plans are scored');
      assert(outcomes.every((o) => o.symbol === 'BTC'), 'no-trade rows produce no outcome record');
      const first = outcomes.find((o) => o.ledgerId.includes('11:00:00'));
      assertEqual(first.outcomeStatus, 'win', 'fills then reaches target on a later candle');
      const after = readFileSync(ledgerFile, 'utf8');
      assertEqual(after, before, 'scoring never rewrites the ledger file');
    });

    await test('scoreLedgerRows: missing history for a symbol reports no_history rather than throwing', () => {
      const rows = readJsonl(ledgerFile).filter((r) => r.symbol === 'BTC').slice(0, 1);
      const outcomes = scoreLedgerRows(rows, {}, { fillWindowCandles: 5, maxHoldCandles: 5 });
      assertEqual(outcomes.length, 1, 'still one outcome row');
      assertEqual(outcomes[0].status, 'no_history', 'missing history is explicit, not a crash');
    });
    await test('review fix 7: a plan that goes rejected -> ready in the same window keeps both rows (long + short)', () => {
      for (const direction of ['long', 'short']) {
        const file = path.join(dir, `transition-${direction}.jsonl`);
        const plan = readyPlan({ direction, stop: direction === 'short' ? 1010 : 990, tp1: direction === 'short' ? 960 : 1040 });
        appendCalls(file, samplePayload({ symbols: { BTC: { flagTradePlan: { ...plan, status: 'rejected', reasonCode: 'room_at_entry' } } } }), Date.parse('2026-09-23T12:00:06.000Z'));
        const { recorded, duplicates } = appendCalls(file, samplePayload({ symbols: { BTC: { flagTradePlan: plan } } }), Date.parse('2026-09-23T12:00:06.000Z'));
        assertEqual(recorded.length, 1, `${direction}: the ready row is recorded`);
        assertEqual(duplicates.length, 0, `${direction}: not treated as a duplicate`);
        assertEqual(readJsonl(file).map((r) => r.plan.status).join(','), 'rejected,ready', `${direction}: both rows kept`);
        const again = appendCalls(file, samplePayload({ symbols: { BTC: { flagTradePlan: plan } } }), Date.parse('2026-09-23T12:00:06.000Z'));
        assertEqual(again.duplicates.length, 1, `${direction}: the identical ready snapshot still dedupes`);
      }
    });

    await test('review fix 8: a ready plan is filled at the ready close; a target on the first later candle wins (long + short)', () => {
      const t0 = Date.parse('2026-09-23T12:00:00.000Z');
      const cases = [
        { direction: 'long', stop: 990, tp1: 1040, candles: [{ timestamp: t0, high: 1045, low: 1005 }] },
        { direction: 'short', stop: 1010, tp1: 960, candles: [{ timestamp: t0, high: 995, low: 955 }] }
      ];
      for (const c of cases) {
        const row = { ledgerId: 'x', symbol: 'BTC', closedThrough: '2026-09-23T12:00:00.000Z', plan: readyPlan({ direction: c.direction, stop: c.stop, tp1: c.tp1 }) };
        // Price never returns to 1000 after the ready close: a touch-fill walk would say not_filled.
        const [o] = scoreLedgerRows([row], { BTC: c.candles }, { fillWindowCandles: 5, maxHoldCandles: 5 });
        assertEqual(o.outcomeStatus, 'win', `${c.direction}: prefilled at the ready close`);
        assertEqual(o.r, 4, `${c.direction}: gross R from the entry level`);
        assertEqual(o.rUnits, 'gross_R_before_fees_slippage', `${c.direction}: R stays labeled gross`);
      }
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
