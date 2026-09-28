/**
 * WP6 (Card 6.1) tests for scripts/research/edge/jupiter-borrow.js:
 *  - decoding a saved account-data fixture (no network) with the app's own on-chain
 *    decoder (jup-perps-client), matching the live run captured 2026-09-27
 *  - the %/h conversion math (app-convention hourlyFundingDbps, and the jump-rate
 *    utilization curve used for the current live rate)
 *  - the CLI's fixture path end-to-end (spawns the script with --fixture, no RPC)
 *
 * Run: node test-jupiter-borrow.js
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jupPerpsClient from 'jup-perps-client';
import { custodyToBorrowRow, jumpRateAprAt } from './scripts/research/edge/jupiter-borrow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'scripts/research/edge/fixtures/jupiter-custody-2026-09-27.json');

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function approx(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg}: ${a} !~ ${b} (eps ${eps})`);
}

console.log('jupiter-borrow tests\n');

// --- fixture decode ---------------------------------------------------------------------
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('fixture has all 5 custodies (SOL/ETH/BTC/USDC/USDT)', () => {
  const symbols = fixture.custodies.map((c) => c.symbol).sort();
  assert(JSON.stringify(symbols) === JSON.stringify(['BTC', 'ETH', 'SOL', 'USDC', 'USDT']), `got ${symbols}`);
});

test('fixture bytes decode with jup-perps-client getCustodyDecoder (no throw)', () => {
  const decoder = jupPerpsClient.getCustodyDecoder();
  for (const entry of fixture.custodies) {
    const bytes = Buffer.from(entry.dataBase64, 'base64');
    const decoded = decoder.decode(bytes);
    assert(decoded.fundingRateState, `${entry.symbol}: missing fundingRateState`);
    assert(decoded.jumpRateState, `${entry.symbol}: missing jumpRateState`);
    assert(decoded.assets, `${entry.symbol}: missing assets`);
  }
});

test('SOL fixture decodes to the live-captured utilization/rate figures', () => {
  const decoder = jupPerpsClient.getCustodyDecoder();
  const sol = fixture.custodies.find((c) => c.symbol === 'SOL');
  const decoded = decoder.decode(Buffer.from(sol.dataBase64, 'base64'));
  const row = custodyToBorrowRow('SOL', { address: sol.address, data: decoded });
  approx(row.utilizationPct, 9.843, 0.01, 'SOL utilization%');
  approx(row.jumpRate.targetUtilizationPct, 80, 1e-6, 'SOL targetUtilizationPct');
  approx(row.jumpRate.minRateAprPct, 10, 1e-6, 'SOL minRateAprPct');
  approx(row.jumpRate.maxRateAprPct, 150, 1e-6, 'SOL maxRateAprPct');
  approx(row.jumpRate.targetRateAprPct, 35, 1e-6, 'SOL targetRateAprPct');
  approx(row.modelAprPct, 13.0761, 0.01, 'SOL modelAprPct (jump-rate curve at live utilization)');
  approx(row.modelPctPerHour, 0.001493, 1e-6, 'SOL modelPctPerHour');
  assert(row.rawHourlyFundingDbps === 0, 'SOL hourlyFundingDbps is 0 (legacy field unused live)');
});

// --- %/h conversion math -----------------------------------------------------------------
test('custodyToBorrowRow: app-convention hourlyFundingDbps -> %/h (value/1_000_000, then *100)', () => {
  const fake = {
    address: 'FakeCustody11111111111111111111111111111',
    data: {
      mint: 'So11111111111111111111111111111111111111112',
      fundingRateState: { hourlyFundingDbps: 2000n, cumulativeInterestRate: 0n, lastUpdate: 0n },
      jumpRateState: null,
      assets: { owned: 100n, locked: 10n },
    },
  };
  const row = custodyToBorrowRow('SOL', fake);
  // 2000 / 1_000_000 = 0.002 (fraction) * 100 = 0.2 percent/h under the app's own convention.
  approx(row.appPercentPerHour, 0.2, 1e-9, 'appPercentPerHour');
  approx(row.utilizationPct, 10, 1e-9, 'utilizationPct from assets.locked/owned');
});

test('jumpRateAprAt: linear below target utilization', () => {
  const jr = { minRateAprPct: 10, maxRateAprPct: 150, targetRateAprPct: 35, targetUtilizationPct: 80 };
  approx(jumpRateAprAt(0, jr), 10, 1e-9, 'at 0% util = minRate');
  approx(jumpRateAprAt(80, jr), 35, 1e-9, 'at target util = targetRate');
  approx(jumpRateAprAt(40, jr), 10 + (35 - 10) * 0.5, 1e-9, 'at half of target util');
});

test('jumpRateAprAt: steeper linear leg above target utilization', () => {
  const jr = { minRateAprPct: 10, maxRateAprPct: 150, targetRateAprPct: 35, targetUtilizationPct: 80 };
  approx(jumpRateAprAt(100, jr), 150, 1e-9, 'at 100% util = maxRate');
  approx(jumpRateAprAt(90, jr), 35 + (150 - 35) * 0.5, 1e-9, 'halfway between target and 100%');
});

test('jumpRateAprAt: degenerate targetUtilizationPct (0 or 100) falls back to targetRate', () => {
  approx(jumpRateAprAt(50, { minRateAprPct: 1, maxRateAprPct: 2, targetRateAprPct: 1.5, targetUtilizationPct: 0 }), 1.5, 1e-9, 'targetUtil=0');
  approx(jumpRateAprAt(50, { minRateAprPct: 1, maxRateAprPct: 2, targetRateAprPct: 1.5, targetUtilizationPct: 100 }), 1.5, 1e-9, 'targetUtil=100');
});

// --- CLI end-to-end (fixture path, no network) --------------------------------------------
test('CLI --fixture writes var/research/wp6-borrow/borrow.json with 5 symbols, no RPC call', () => {
  const scriptPath = path.join(__dirname, 'scripts/research/edge/jupiter-borrow.js');
  const out = execFileSync('node', [scriptPath, '--fixture', FIXTURE], { cwd: __dirname, encoding: 'utf8' });
  assert(/SOL: model=/.test(out), `expected SOL summary line, got: ${out}`);
  const outFile = path.join(__dirname, 'var/research/wp6-borrow/borrow.json');
  assert(fs.existsSync(outFile), 'borrow.json not written');
  const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert(json.rpc.startsWith('fixture:'), `expected fixture rpc tag, got ${json.rpc}`);
  assert(Object.keys(json.custodies).sort().join(',') === 'BTC,ETH,SOL,USDC,USDT', `got ${Object.keys(json.custodies)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failures:', failures.join(', '));
  process.exitCode = 1;
}
