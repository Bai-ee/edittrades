#!/usr/bin/env node
// WP11-B (docs/research/harness/WP11_VALIDATE.md). Reads every docs/swing/<id>.json
// (read-only) and reports adaptive-vs-conservative same-bar stop/TP ordering ambiguity
// per rule, using `summarizeAmbiguity` (scripts/research/harness/adaptive-walk.js). Writes
// var/research/wp11/wp11b-ambiguity-report.json. No docs/swing file is modified.
//
//   node scripts/research/harness/rescore-swing-ambiguity.js [--swing-dir docs/swing] [--out var/research/wp11]

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeAmbiguity } from './adaptive-walk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function parseArgs(argv) {
  const args = { swingDir: 'docs/swing', out: 'var/research/wp11' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--swing-dir') args.swingDir = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const swingDir = path.isAbsolute(args.swingDir) ? args.swingDir : path.join(REPO_ROOT, args.swingDir);
  const outDir = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(swingDir).filter((f) => f.endsWith('.json')).sort();
  const perRule = [];
  let totalN = 0, totalLoss = 0, totalAmbiguous = 0;

  for (const f of files) {
    const ruleJson = JSON.parse(readFileSync(path.join(swingDir, f), 'utf8'));
    if (!ruleJson.perSymbol) continue; // skip empty rule files (0 signals)
    const s = summarizeAmbiguity(ruleJson);
    perRule.push(s);
    totalN += s.n;
    totalLoss += s.lossCount;
    totalAmbiguous += s.ambiguousCount;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'ambiguous===true on a loss-status signal is the complete set adaptive ordering could flip (see adaptive-walk.js header); no rules or files under docs/swing were modified.',
    totals: {
      rulesScanned: perRule.length,
      signals: totalN,
      lossSignals: totalLoss,
      ambiguousSignals: totalAmbiguous,
      ambiguityRatePctOfN: totalN ? Math.round((totalAmbiguous / totalN) * 100000) / 1000 : 0,
      ambiguityRatePctOfLosses: totalLoss ? Math.round((totalAmbiguous / totalLoss) * 100000) / 1000 : 0
    },
    perRule
  };

  writeFileSync(path.join(outDir, 'wp11b-ambiguity-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[rescore-swing-ambiguity] rules=${perRule.length} signals=${totalN} loss=${totalLoss} ambiguous=${totalAmbiguous}`);
  console.log(`[rescore-swing-ambiguity] wrote ${path.relative(REPO_ROOT, outDir)}/wp11b-ambiguity-report.json`);
}

main();
