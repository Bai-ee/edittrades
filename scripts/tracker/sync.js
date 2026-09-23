#!/usr/bin/env node
/**
 * Copy the tracker into a local checkout of the tracker repo (default
 * ../edittrades-tracker): scripts/tracker/*.js (not this file) -> <target>/scripts/,
 * repo-template/* (README, package.json, .gitignore, workflows) -> <target>/, and
 * build an empty-state docs/index.html there if none exists yet. Never copies .env*.
 *
 * Usage: node scripts/tracker/sync.js [--target ../edittrades-tracker]
 */

import { readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir } from './store.js';
import { buildPage } from './build-page.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function copyTree(src, dest, copied) {
  for (const name of readdirSync(src)) {
    if (name.startsWith('.env')) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (statSync(from).isDirectory()) { ensureDir(to); copyTree(from, to, copied); continue; }
    copyFileSync(from, to);
    copied.push(path.relative(dest, to) || name);
  }
}

function main() {
  const opts = parseArgs();
  const target = path.resolve(typeof opts.target === 'string' ? opts.target : path.join(here, '..', '..', '..', 'edittrades-tracker'));
  if (!existsSync(target)) throw new Error(`target checkout not found: ${target}`);

  const scriptsDir = path.join(target, 'scripts');
  ensureDir(scriptsDir);
  const scripts = readdirSync(here).filter((f) => f.endsWith('.js') && f !== 'sync.js');
  for (const f of scripts) copyFileSync(path.join(here, f), path.join(scriptsDir, f));

  const copied = [];
  copyTree(path.join(here, 'repo-template'), target, copied);

  const page = path.join(target, 'docs', 'index.html');
  if (!existsSync(page)) buildPage(path.join(target, 'data'), path.join(target, 'docs'));

  console.log(`[tracker:sync] ${target}: scripts/${scripts.join(', scripts/')}; template ${copied.length} file(s); page ${existsSync(page) ? 'present' : 'missing'}`);
}

try { main(); } catch (err) {
  console.error(`[tracker:sync] ${err.message}`);
  process.exit(1);
}
