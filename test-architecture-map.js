/**
 * Consistency tests for docs/ARCHITECTURE_MAP.json, the source of truth for the tracker
 * site's system map page (scripts/tracker/changelog-page.js).
 *
 * Fails when: the JSON shape is wrong; a file under lib/, services/, api/, config/ or
 * scripts/tracker/*.js is missing from the map or listed twice; the map names a file that
 * no longer exists; the current payload schemaVersion (services/scalpContext.js) has no
 * CHANGELOG.md entry; a listed test script is not in package.json; a flow or output
 * names something no module publishes. On every run it writes
 * docs/ARCHITECTURE_MAP.verify.json ({checkedAt, files, ok}), which tracker:sync carries
 * to the site's consistency strip.
 *
 * Run: node test-architecture-map.js
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAP_FILE = path.join(root, 'docs', 'ARCHITECTURE_MAP.json');
const VERIFY_FILE = path.join(root, 'docs', 'ARCHITECTURE_MAP.verify.json');
const COVERED_DIRS = ['lib', 'services', 'api', 'config'];
const OUTPUT_WHERE = ['REST', 'MCP', 'tracker', 'GPT'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

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
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    if (name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...listFiles(rel));
    else out.push(rel);
  }
  return out;
}

/** Every file the map must cover: lib/, services/, api/, config/ (recursive) and scripts/tracker/*.js. */
export function coveredFiles() {
  const files = COVERED_DIRS.flatMap(listFiles);
  for (const name of readdirSync(path.join(root, 'scripts', 'tracker'))) {
    if (name.endsWith('.js')) files.push(`scripts/tracker/${name}`);
  }
  return files.sort();
}

/** Shape errors of a parsed map (empty array = valid). */
export function shapeErrors(map) {
  const errs = [];
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!map || typeof map !== 'object') return ['map is not an object'];
  if (!isStr(map.version)) errs.push('version missing');
  if (!DATE_RE.test(map.updatedAt || '')) errs.push('updatedAt not YYYY-MM-DD');
  if (!Array.isArray(map.stages) || !map.stages.length) errs.push('stages empty');
  const ids = new Set();
  for (const [i, s] of (map.stages || []).entries()) {
    const at = `stages[${i}]`;
    for (const k of ['id', 'title', 'purpose']) if (!isStr(s[k])) errs.push(`${at}.${k} missing`);
    if (ids.has(s.id)) errs.push(`${at}.id duplicate ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.modules) || !s.modules.length) { errs.push(`${at}.modules empty`); continue; }
    for (const [j, m] of s.modules.entries()) {
      const mat = `${at}.modules[${j}] (${m && m.path})`;
      for (const k of ['path', 'name', 'role']) if (!isStr(m[k])) errs.push(`${mat}.${k} missing`);
      for (const k of ['publishes', 'consumes', 'tests']) if (!isStrArr(m[k])) errs.push(`${mat}.${k} not a string array`);
      if (!DATE_RE.test(m.since || '')) errs.push(`${mat}.since not YYYY-MM-DD`);
      if (!(m.schemaSince === null || SEMVER_RE.test(m.schemaSince || ''))) errs.push(`${mat}.schemaSince not null or x.y.z`);
      if (isStr(m.role) && (/\n/.test(m.role) || !/[.!?]$/.test(m.role.trim()) || /[.!?]\s+[A-Z]/.test(m.role))) errs.push(`${mat}.role is not one sentence`);
    }
  }
  if (!Array.isArray(map.flows)) errs.push('flows not an array');
  for (const [i, f] of (map.flows || []).entries()) {
    for (const k of ['from', 'to', 'label']) if (!isStr(f && f[k])) errs.push(`flows[${i}].${k} missing`);
  }
  if (!Array.isArray(map.outputs) || !map.outputs.length) errs.push('outputs empty');
  for (const [i, o] of (map.outputs || []).entries()) {
    if (!isStr(o.name)) errs.push(`outputs[${i}].name missing`);
    if (!OUTPUT_WHERE.includes(o.where)) errs.push(`outputs[${i}].where not one of ${OUTPUT_WHERE.join(' | ')}`);
    if (!isStrArr(o.fields) || !o.fields.length) errs.push(`outputs[${i}].fields empty`);
  }
  return errs;
}

export function currentSchemaVersion() {
  const src = readFileSync(path.join(root, 'services', 'scalpContext.js'), 'utf8');
  const m = src.match(/schemaVersion:\s*'(\d+\.\d+\.\d+)'/);
  return m ? m[1] : null;
}

function run() {
  const raw = readFileSync(MAP_FILE, 'utf8');
  let map = null;
  const files = coveredFiles();
  const modules = () => (map.stages || []).flatMap((s) => s.modules || []);

  test('map parses as JSON', () => { map = JSON.parse(raw); });
  if (!map) return finish(files.length);

  test('map shape is valid', () => {
    const errs = shapeErrors(map);
    assert(!errs.length, errs.join('; '));
  });

  test('every covered file appears exactly once', () => {
    const counts = new Map();
    for (const m of modules()) counts.set(m.path, (counts.get(m.path) || 0) + 1);
    const missing = files.filter((f) => !counts.has(f));
    const dupes = [...counts].filter(([, n]) => n > 1).map(([p]) => p);
    assert(!missing.length, `missing from map: ${missing.join(', ')}`);
    assert(!dupes.length, `listed more than once: ${dupes.join(', ')}`);
  });

  test('every mapped file exists', () => {
    const gone = modules().map((m) => m.path).filter((p) => !existsSync(path.join(root, p)));
    assert(!gone.length, `map names missing files: ${gone.join(', ')}`);
  });

  test('module names are unique (flows reference them)', () => {
    const seen = new Set();
    const dupes = [];
    for (const m of modules()) { if (seen.has(m.name)) dupes.push(m.name); seen.add(m.name); }
    assert(!dupes.length, `duplicate names: ${dupes.join(', ')}`);
  });

  test('current schemaVersion has a CHANGELOG.md entry', () => {
    const v = currentSchemaVersion();
    assert(v, 'schemaVersion not found in services/scalpContext.js');
    const log = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert(log.includes(v), `CHANGELOG.md never mentions schema ${v}`);
  });

  test('every listed test script exists in package.json', () => {
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
    const unknown = [...new Set(modules().flatMap((m) => m.tests))].filter((t) => !(t in scripts));
    assert(!unknown.length, `unknown scripts: ${unknown.join(', ')}`);
  });

  test('flows connect mapped modules', () => {
    const names = new Set(modules().map((m) => m.name));
    const bad = map.flows.filter((f) => !names.has(f.from) || !names.has(f.to)).map((f) => `${f.from}->${f.to}`);
    assert(!bad.length, `unknown flow ends: ${bad.join(', ')}`);
  });

  test('every output field is published by some module', () => {
    const published = new Set(modules().flatMap((m) => m.publishes));
    const orphan = [...new Set(map.outputs.flatMap((o) => o.fields))].filter((f) => !published.has(f));
    assert(!orphan.length, `no module publishes: ${orphan.join(', ')}`);
  });

  test('shapeErrors rejects a broken map', () => {
    assert(shapeErrors({}).length > 0, 'empty object must fail');
    const bad = { version: '1', updatedAt: '2026-09-24', stages: [{ id: 'a', title: 'A', purpose: 'p', modules: [{ path: 'x', name: 'x', role: 'Two. Sentences.', publishes: [], consumes: [], tests: [], since: 'soon', schemaSince: 'v1' }] }], flows: [], outputs: [{ name: 'o', where: 'FTP', fields: ['a'] }] };
    const errs = shapeErrors(bad).join('; ');
    for (const frag of ['since', 'schemaSince', 'one sentence', 'where']) assert(errs.includes(frag), `expected a ${frag} error, got: ${errs}`);
  });

  finish(files.length);
}

function finish(fileCount) {
  const ok = failed === 0;
  writeFileSync(VERIFY_FILE, `${JSON.stringify({ checkedAt: new Date().toISOString(), files: fileCount, ok }, null, 2)}\n`);
  console.log(`\n${passed} passed, ${failed} failed (${fileCount} files covered)`);
  if (!ok) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
