#!/usr/bin/env node
/**
 * Whole-desk validation.
 *
 *   npm run validate:all
 *
 * Runs every harness and reports one verdict. Suites are grouped by whether
 * they need the network, and that distinction is load-bearing rather than
 * cosmetic: an offline failure is a real defect, whereas a network suite that
 * cannot reach its provider has verified NOTHING and must not be counted as a
 * pass. It is reported as SKIPPED (no network), never folded into the green.
 *
 * Exit code reflects offline suites plus any network suite that actually ran
 * and failed.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The adaptive, wallet and home-card suites were reachable only through their
 * own npm scripts, so `validate:all` could report a green desk while none of
 * them had run. They are offline and fixture-driven like the rest; there was
 * no reason for them to sit outside the one command people actually type.
 */
const SUITES = [
  { name: 'Market data integrity', script: 'scripts/validate-market-data.js', network: false },
  { name: 'Risk Manager', script: 'scripts/validate-risk-manager.js', network: false },
  { name: 'Adaptive risk engine', script: 'scripts/validate-adaptive-risk.js', network: false },
  { name: 'Wallet reconstruction', script: 'scripts/validate-wallet-reconstruction.js', network: false },
  { name: 'Home-page risk card', script: 'scripts/validate-home-risk-card.js', network: false },
  { name: 'Decision desk integration', script: 'scripts/validate-decision-desk.js', network: false },
  { name: 'Bitcoin macro core', script: 'scripts/validate-macro-core.js', network: false },
  { name: 'Bitcoin Economic Value', script: 'scripts/validate-economic-value.js', network: true }
];

const results = [];

for (const suite of SUITES) {
  process.stdout.write(`\n${'#'.repeat(64)}\n# ${suite.name}\n${'#'.repeat(64)}\n`);
  const run = spawnSync(process.execPath, [join(root, suite.script)], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(output);

  // A network suite that could not reach any provider proves nothing either
  // way. Counting it as a pass would be exactly the "looks fine but isn't"
  // failure this whole effort exists to remove.
  const unreachable =
    suite.network &&
    run.status !== 0 &&
    /No data retrieved|ECONNREFUSED|ENOTFOUND|status code 4\d\d|EGRESS|getaddrinfo/i.test(output);

  results.push({
    name: suite.name,
    status: unreachable ? 'SKIPPED (no network)' : run.status === 0 ? 'PASS' : 'FAIL',
    counted: !unreachable
  });
}

console.log(`\n${'='.repeat(64)}`);
console.log('VALIDATION SUMMARY');
console.log('='.repeat(64));
for (const r of results) {
  console.log(`  ${r.status.padEnd(22)} ${r.name}`);
}

const failed = results.filter((r) => r.counted && r.status === 'FAIL');
const skipped = results.filter((r) => !r.counted);

console.log('='.repeat(64));
if (skipped.length > 0) {
  console.log(
    `\n${skipped.length} suite(s) could not reach their providers and verified NOTHING.\n` +
    'Re-run them from an environment with network access before treating the\n' +
    'system as validated. Do not read the summary above as full coverage.'
  );
}
console.log(failed.length === 0 ? '\nAll executed suites passed.\n' : `\n${failed.length} suite(s) FAILED.\n`);

process.exit(failed.length === 0 ? 0 : 1);
