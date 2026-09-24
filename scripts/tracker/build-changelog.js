#!/usr/bin/env node
/**
 * EditTrades call tracker - build the "System map + changelog" page (<out>/changelog.html).
 *
 * Reads <data>/engine/ARCHITECTURE_MAP.json, <data>/engine/ARCHITECTURE_MAP.verify.json and
 * <data>/engine/CHANGELOG.md (copied from the engine repo by sync.js), plus
 * schemaVersion/configVersion from the newest capture row in <data>/calls, and renders
 * ./changelog-page.js. Missing inputs render as bracketed empty states, never a failure.
 *
 * Usage: node scripts/build-changelog.js [--data data] [--out docs]
 *        node scripts/tracker/build-changelog.js --engine . --out <dir>   (engine-repo preview:
 *        reads docs/ARCHITECTURE_MAP*.json and CHANGELOG.md from the engine root instead)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir } from './store.js';
import { renderChangelogPage } from './changelog-page.js';

function readText(file) {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

function readJsonSafe(file) {
  const t = readText(file);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** schemaVersion/configVersion/capturedAt of the newest capture row in <data>/calls, or nulls. */
export function latestVersions(dataDir) {
  const empty = { schemaVersion: null, configVersion: null, capturedAt: null };
  const dir = path.join(dataDir, 'calls');
  if (!existsSync(dir)) return empty;
  const days = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  for (const day of days) {
    const lines = readText(path.join(dir, day)).split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && (row.schemaVersion || row.configVersion)) {
          return { schemaVersion: row.schemaVersion ?? null, configVersion: row.configVersion ?? null, capturedAt: row.capturedAt ?? null };
        }
      } catch { /* skip a torn line */ }
    }
  }
  return empty;
}

/**
 * @param {string} dataDir - tracker data dir (engine files under <dataDir>/engine)
 * @param {string} outDir
 * @param {number} [nowMs]
 * @param {{engineRoot?: string}} [opts] - read the map/changelog from an engine checkout instead
 */
export function buildChangelog(dataDir, outDir, nowMs = Date.now(), opts = {}) {
  const src = opts.engineRoot
    ? { map: path.join(opts.engineRoot, 'docs', 'ARCHITECTURE_MAP.json'), verify: path.join(opts.engineRoot, 'docs', 'ARCHITECTURE_MAP.verify.json'), log: path.join(opts.engineRoot, 'CHANGELOG.md') }
    : { map: path.join(dataDir, 'engine', 'ARCHITECTURE_MAP.json'), verify: path.join(dataDir, 'engine', 'ARCHITECTURE_MAP.verify.json'), log: path.join(dataDir, 'engine', 'CHANGELOG.md') };
  const map = readJsonSafe(src.map);
  const html = renderChangelogPage({
    map, changelog: readText(src.log), verify: readJsonSafe(src.verify), versions: latestVersions(dataDir), nowMs
  });
  ensureDir(outDir);
  const file = path.join(outDir, 'changelog.html');
  writeFileSync(file, html);
  return { file, map };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { file, map } = buildChangelog(opts.data, opts.out, nowMs, { engineRoot: typeof opts.engine === 'string' ? opts.engine : undefined });
  const n = map && Array.isArray(map.stages) ? map.stages.reduce((k, s) => k + (s.modules || []).length, 0) : 0;
  console.log(`[tracker:changelog] ${n} module(s) -> ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:changelog] ${err.message}`);
    process.exit(1);
  }
}
