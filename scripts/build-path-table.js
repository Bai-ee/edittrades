#!/usr/bin/env node
/**
 * T4 P1 (docs/PLAN_FLAG_PATHS.md "P1 - pathOutlook in the payload"): builds the
 * hierarchical backoff table `config/engine.json`'s `pathOutlook` key holds, from the
 * labelled rows P0 produced (`scripts/replay-paths.js --out`, one row per candidate at
 * its tightening point - see docs/FLAG_PATHS_BASE_RATES.md for the measured dataset).
 *
 * Two tables, both keyed the same way:
 *   - `tightening`: every labelled row (a candidate still `forming`/`proto` at the
 *     moment it was labelled).
 *   - `broken`: only rows that broke out (`breakoutAt` not null) - a live candidate
 *     that has already triggered/confirmed can never resolve `fail_first` (that path
 *     requires an invalidation close BEFORE any breakout close), so every `broken`
 *     bucket's `fail_first` weight is exactly 0.
 *
 * Backoff key: `KEYS` in order (`tf`, `structureSteps`, `roomR`, `compression`), the
 * candidate's own `features.<key>` bucket label (scripts/tracker/flag-paths.js's
 * `featuresAt`) joined `key=value|key=value`. A live lookup (`lib/pathOutlook.js`)
 * starts at the full 4-feature key and drops the LAST feature until it finds a stored
 * bucket, ending at `tf=<tf>` alone, then the literal string `'all'`. Only buckets with
 * `n >= minN` (100) are ever stored - dropping the rest is what keeps this table small;
 * `'all'` is always stored (the guaranteed terminal fallback) regardless of its own n.
 *
 * Usage:
 *   node scripts/build-path-table.js --in <rows.jsonl> [--config config/engine.json]
 *     [--config-version 2026.09.24-1]
 *
 * `<rows.jsonl>` is P0's labelled dataset (not checked into this repo - see
 * docs/FLAG_PATHS_BASE_RATES.md "Reproduce" for how it is built). This script only
 * reads it and writes `config/engine.json`; it never touches the row file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from './tracker/flag-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'engine.json');

// Backoff feature order (docs/PLAN_FLAG_PATHS.md P1 item 1): the last one is dropped
// first. Kept here (not read from config) because this is the script that DEFINES the
// table's shape; `lib/pathOutlook.js` reads the order back from `pathOutlook.keys`.
export const KEYS = ['tf', 'structureSteps', 'roomR', 'compression'];
export const MIN_N = 100;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function readJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

/** Integer-percent path mix for one group of rows; every PATHS key present, 0 when absent. */
export function weightsFor(rows) {
  const n = rows.length;
  const counts = {};
  for (const p of PATHS) counts[p] = 0;
  for (const row of rows) if (counts[row.path] !== undefined) counts[row.path] += 1;
  const w = {};
  for (const p of PATHS) w[p] = n > 0 ? Math.round((counts[p] / n) * 100) : 0;
  return w;
}

/**
 * Every backoff-depth bucket (4 features down to 1) with n >= minN, plus the always-
 * present 'all' bucket. Depths never collide (each depth's key string carries a
 * different number of `key=value` segments), so a single flat object holds every depth.
 * @param {Array<Object>} rows - rows carrying `.features` (flag-paths.js featuresAt shape) and `.path`
 * @param {Array<string>} keys
 * @param {number} minN
 * @returns {Object<string,{n:number,w:Object}>}
 */
export function buildTable(rows, keys = KEYS, minN = MIN_N) {
  const out = {};
  for (let depth = keys.length; depth >= 1; depth--) {
    const groups = new Map();
    for (const row of rows) {
      if (!row || !row.features) continue;
      const key = keys.slice(0, depth).map((k) => `${k}=${row.features[k]}`).join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [key, groupRows] of groups) {
      if (groupRows.length < minN) continue;
      out[key] = { n: groupRows.length, w: weightsFor(groupRows) };
    }
  }
  out.all = { n: rows.length, w: weightsFor(rows) };
  return out;
}

/** One bucket, one line: `{ "n": N, "w": { "retest_go": X, ... } }` - config/engine.json's own style for dense tables (e.g. `above200Weights`). */
function formatBucket(entry) {
  const w = entry.w;
  const wParts = PATHS.map((p) => `"${p}": ${w[p]}`).join(', ');
  return `{ "n": ${entry.n}, "w": { ${wParts} } }`;
}

/** One table (tightening or broken): one bucket per line, insertion order preserved. */
function formatTable(table, indent) {
  const lines = Object.keys(table).map((k) => `${indent}  ${JSON.stringify(k)}: ${formatBucket(table[k])}`);
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/** The full `pathOutlook` value, hand-formatted to match config/engine.json's existing style. */
function formatPathOutlookValue({ source, minN, keys, tightening, broken }) {
  const indent = '  ';
  return `{\n${indent}  "source": ${JSON.stringify(source)},\n${indent}  "minN": ${minN},\n`
    + `${indent}  "keys": ${JSON.stringify(keys)},\n`
    + `${indent}  "tightening": ${formatTable(tightening, `${indent}  `)},\n`
    + `${indent}  "broken": ${formatTable(broken, `${indent}  `)}\n${indent}}`;
}

/**
 * Text-level edit of `config/engine.json`, not a JSON.parse/stringify round-trip: the
 * file is hand-formatted (short arrays inline, e.g. `flag.timeframes`) and a full
 * re-stringify would reformat every unrelated block. This only rewrites the
 * `configVersion` value in place and appends a new `pathOutlook` top-level key before the
 * file's final `}`, leaving every other byte untouched.
 * @param {string} text - the current file contents
 * @param {string} configVersion
 * @param {Object} pathOutlookValue
 * @returns {string} the new file contents
 */
export function applyToConfigText(text, configVersion, pathOutlookValue) {
  const versionRe = /("configVersion":\s*")[^"]*(")/;
  if (!versionRe.test(text)) throw new Error('config file: "configVersion" field not found');
  const withVersion = text.replace(versionRe, `$1${configVersion}$2`);

  const trimmedEnd = withVersion.replace(/\s+$/, '');
  if (!trimmedEnd.endsWith('}')) throw new Error('config file: does not end with "}"');
  const withoutFinalBrace = trimmedEnd.slice(0, -1).replace(/\s+$/, '');

  return `${withoutFinalBrace},\n\n  "pathOutlook": ${formatPathOutlookValue(pathOutlookValue)}\n}\n`;
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return {
    in: typeof opts.in === 'string' ? opts.in : null,
    config: typeof opts.config === 'string' ? opts.config : DEFAULT_CONFIG_PATH,
    configVersion: typeof opts['config-version'] === 'string' ? opts['config-version'] : '2026.09.24-1',
    source: typeof opts.source === 'string' ? opts.source : 'replay deep-2026-09-24, 10997 flags, 2026-09-09..09-24'
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.in) throw new Error('need --in <rows.jsonl> (T4 P0 labelled dataset)');

  const rows = readJsonl(args.in);
  const brokenRows = rows.filter((r) => isFiniteNumber(r.breakoutAt));

  const tightening = buildTable(rows);
  const broken = buildTable(brokenRows);

  const text = readFileSync(args.config, 'utf8');
  const updated = applyToConfigText(text, args.configVersion, { source: args.source, minN: MIN_N, keys: KEYS, tightening, broken });
  JSON.parse(updated); // fail loudly before writing anything if the edit produced bad JSON
  writeFileSync(args.config, updated);

  console.log(`[build-path-table] tightening: ${rows.length} rows, ${Object.keys(tightening).length} buckets`);
  console.log(`[build-path-table] broken: ${brokenRows.length} rows, ${Object.keys(broken).length} buckets`);
  console.log(`[build-path-table] wrote ${args.config} (configVersion ${args.configVersion})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[build-path-table] ${err.stack || err.message}`);
    process.exit(1);
  }
}

export default { KEYS, MIN_N, readJsonl, weightsFor, buildTable, applyToConfigText, parseArgs, main };
