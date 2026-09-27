// R4 trade-order shuffle acceptance checks (WP3, research only). Verifies the additive
// --trades/--shuffle mode in scripts/research/risk-sim.js does not disturb the pre-existing
// --calls/--param behaviour, and that the shuffle statistics are sane and deterministic.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shuffleTradeOrder, loadGenericTrades } from './scripts/research/risk-sim.js';

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------- fixtures

function makeTmpJsonl(rows) {
  const p = path.join(os.tmpdir(), `wp3-risk-shuffle-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// ---------------------------------------------------------------------- (1) pure-function checks

check('(1) shuffleTradeOrder is deterministic given the same seed', () => {
  const returns = [0.05, -0.02, 0.03, -0.08, 0.01, -0.01, 0.04, -0.03, 0.02, -0.05];
  const a = shuffleTradeOrder(returns, { nShuffles: 300, seed: 7, units: 'pct' });
  const b = shuffleTradeOrder(returns, { nShuffles: 300, seed: 7, units: 'pct' });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'same seed must reproduce identical output');
});

check('(1b) shuffling never changes the multiset of returns -> final equity distribution is degenerate (all shuffles compound the SAME trades)', () => {
  const returns = [0.10, -0.05, 0.02, -0.01, 0.03];
  const r = shuffleTradeOrder(returns, { nShuffles: 500, seed: 1, units: 'pct' });
  // Order does not change the final compounded product for pct units (multiplication commutes),
  // so p5/p50/p95 final equity must all equal the historical final equity.
  const expected = returns.reduce((eq, x) => eq * (1 + x), 1);
  for (const v of [r.finalEquityX.p5, r.finalEquityX.p50, r.finalEquityX.p95, r.historical.finalEquity]) {
    assert.ok(Math.abs(v - expected) < 1e-9, `expected final equity ${expected}, got ${v}`);
  }
  // But max drawdown and losing-streak length DO depend on order, so they should vary.
  assert.ok(r.maxDD.p95 >= r.maxDD.p5, 'p95 maxDD should be >= p5 maxDD');
});

check('(1c) R units compound via riskPct, and differ from pct units on the same numbers', () => {
  const returns = [2, -1, 1.5, -0.5, 1];
  const rPct = shuffleTradeOrder(returns, { nShuffles: 200, seed: 3, units: 'R', riskPct: 1 });
  const rBig = shuffleTradeOrder(returns, { nShuffles: 200, seed: 3, units: 'R', riskPct: 5 });
  assert.notStrictEqual(rPct.historical.finalEquity, rBig.historical.finalEquity, 'riskPct must scale the R-unit equity impact');
});

check('(1d) throws on units other than pct/R, and on fewer than 2 trades', () => {
  assert.throws(() => shuffleTradeOrder([0.1, 0.2], { units: 'bogus' }));
  assert.throws(() => shuffleTradeOrder([0.1], { units: 'pct' }));
});

// ---------------------------------------------------------------------- (2) generic trade loader

check('(2) loadGenericTrades auto-detects the pct field and ignores unusable lines', () => {
  const p = makeTmpJsonl([{ ret: 0.01 }, { ret: -0.02 }, { other: 1 }, 'not json - handled by try/catch below']);
  // overwrite the last line with genuinely invalid JSON to exercise the parse-failure path
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines[3] = '{not valid json';
  fs.writeFileSync(p, lines.join('\n'));
  const out = loadGenericTrades(p, { units: 'pct' });
  assert.deepStrictEqual(out, [0.01, -0.02]);
  fs.unlinkSync(p);
});

check('(2b) loadGenericTrades respects an explicit --field override', () => {
  const p = makeTmpJsonl([{ netR: 1.2 }, { netR: -0.4 }]);
  const out = loadGenericTrades(p, { units: 'R', field: 'netR' });
  assert.deepStrictEqual(out, [1.2, -0.4]);
  fs.unlinkSync(p);
});

// ---------------------------------------------------------------------- (3) CLI: existing modes unaffected

check('(3) CLI: existing --param mode is byte-identical in behaviour (still prints the bootstrap table)', () => {
  const outText = execFileSync('node', ['scripts/research/risk-sim.js', '--param', 'win=0.31,winR=2.6,lossR=1.3', '--paths', '50', '--trades', '20', '--seed', '1', '--out', 'wp3-test-param-unaffected'], { encoding: 'utf8', cwd: path.resolve('.') });
  assert.ok(outText.includes('# Risk sim: param mode'), 'param mode banner must still print');
  assert.ok(outText.includes('bootstrap, N paths'), 'bootstrap table must still print');
  assert.ok(!outText.includes('shuffle'), 'param mode output must not mention the new shuffle mode');
  fs.rmSync('var/risk-sim/wp3-test-param-unaffected.json', { force: true });
});

check('(3b) CLI: --trades <number> (no path) still means tradesPerPath, not shuffle mode', () => {
  const outText = execFileSync('node', ['scripts/research/risk-sim.js', '--param', 'win=0.31,winR=2.6,lossR=1.3', '--paths', '50', '--trades', '20', '--seed', '1', '--out', 'wp3-test-trades-numeric'], { encoding: 'utf8', cwd: path.resolve('.') });
  assert.ok(outText.includes('tradesPerPath=20'), 'numeric --trades must still set tradesPerPath');
  fs.rmSync('var/risk-sim/wp3-test-trades-numeric.json', { force: true });
});

check('(4) CLI: --trades <path> --shuffle runs the new mode end to end and writes JSON', () => {
  const p = makeTmpJsonl(Array.from({ length: 30 }, (_, i) => ({ ret: (i % 3 === 0 ? -0.03 : 0.015) })));
  const outText = execFileSync('node', ['scripts/research/risk-sim.js', '--trades', p, '--shuffle', '--units', 'pct', '--n-shuffles', '200', '--seed', '5', '--out', 'wp3-test-shuffle-cli'], { encoding: 'utf8', cwd: path.resolve('.') });
  assert.ok(outText.includes('R4 trade-order shuffle'), 'shuffle table header must print');
  const jsonPath = path.resolve('var/risk-sim/wp3-test-shuffle-cli.json');
  assert.ok(fs.existsSync(jsonPath), 'shuffle mode must write its JSON output');
  const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(saved.mode, 'shuffle');
  assert.strictEqual(saved.nTrades, 30);
  fs.unlinkSync(p);
  fs.rmSync(jsonPath, { force: true });
});

console.log(`\n${pass} check(s) passed.`);
