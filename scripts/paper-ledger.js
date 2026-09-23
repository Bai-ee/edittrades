#!/usr/bin/env node
/**
 * Forward-paper ledger (signal-reliability minimum plan, work package 3.3-3.4).
 *
 * Local, append-only, file-based. No server write API, no Blob journal, no scheduler,
 * no live order flow - `record` only ever appends lines to a JSONL file on disk, and
 * `score` only ever reads that file and writes a separate, independently-derived
 * outcomes file. Neither command makes a network request; both take an already-saved
 * scalpContext payload (or 1m history) as local input.
 *
 * Every recorded row is a snapshot of `flagTradePlan` for one symbol at one build -
 * `ready`/`conditional`/`rejected`, or the symbol having no confirmed candidate at all
 * (a genuine no-trade call, recorded, not skipped, per work package 3.4). Never the
 * account/wallet block: this file reads only `payload.symbols[symbol].flagTradePlan`,
 * `payload.{generatedAt,closedThrough,schemaVersion,configVersion}`, and never
 * `payload.account`.
 *
 * Usage:
 *   node scripts/paper-ledger.js record <context.json> [--out <ledger.jsonl>]
 *   node scripts/paper-ledger.js score <ledger.jsonl> <historyDir> [--out <outcomes.jsonl>]
 *
 * `record` refuses a duplicate `ledgerId` (the plan's own `planId|status|reasonCode`, or
 * a synthetic `SYMBOL:no-plan:closedThrough` id when there is no plan) - it is skipped, logged, and
 * the file is never rewritten. `score` never opens the ledger file for writing; it
 * reads it, walks each walkable row against `historyDir`'s saved 1m candles (via
 * scripts/replay-outcomes.js's own walkOutcome, no re-derivation), and writes a fresh
 * outcomes file, one row per ledger row it could score.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { walkOutcome } from './replay-outcomes.js';
import { readHistoryFile } from './replay.js';
import { ENGINE_CONFIG } from '../config/engine.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Read a JSONL file into an array of parsed rows, or [] if it does not exist yet. */
function readJsonlOrEmpty(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * The ledger's own dedup key for one symbol's flagTradePlan: the plan's `planId` plus
 * its `status` and `reasonCode` when a plan exists (review fix 7: a plan that moves
 * rejected -> ready inside the same closedThrough window keeps both rows), else a
 * synthetic id from the symbol and this build's closedThrough - so two recordings of
 * the same no-trade snapshot still dedupe.
 * @param {string} symbol
 * @param {Object|null} plan
 * @param {string|null} closedThrough
 * @returns {string}
 */
export function ledgerIdFor(symbol, plan, closedThrough) {
  if (plan && typeof plan.planId === 'string') return `${plan.planId}|${plan.status || 'unknown'}|${plan.reasonCode || 'none'}`;
  return `${symbol}:no-plan:${closedThrough || 'unknown'}`;
}

/**
 * SHA-256 of the market-only fields that define this call - never account/wallet data,
 * never a credential. Two identical plans (or two identical no-trade snapshots) hash
 * identically; the smallest change to a level changes the hash.
 * @param {string} symbol
 * @param {Object|null} plan
 * @param {string|null} closedThrough
 * @returns {string}
 */
export function marketInputHash(symbol, plan, closedThrough) {
  const material = JSON.stringify({ symbol, closedThrough, plan });
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Build one ledger row per symbol from a saved buildScalpContext payload. Pure: never
 * reads `payload.account`.
 * @param {Object} payload - a saved scalpContext build (buildScalpContext output)
 * @param {number} [recordedAtMs=Date.now()]
 * @returns {Array<Object>}
 */
export function rowsFromPayload(payload, recordedAtMs = Date.now()) {
  const symbols = payload && payload.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
  const rows = [];
  for (const [symbol, sym] of Object.entries(symbols)) {
    const plan = sym && sym.flagTradePlan ? sym.flagTradePlan : null;
    const closedThrough = payload.closedThrough || null;
    rows.push({
      ledgerId: ledgerIdFor(symbol, plan, closedThrough),
      recordedAt: new Date(recordedAtMs).toISOString(),
      generatedAt: payload.generatedAt || null,
      closedThrough,
      schemaVersion: payload.schemaVersion || null,
      configVersion: payload.configVersion || null,
      symbol,
      plan,
      marketInputHash: marketInputHash(symbol, plan, closedThrough)
    });
  }
  return rows;
}

/**
 * Append the new (non-duplicate) rows from `payload` to `ledgerFile`, never rewriting
 * existing lines. Duplicate `ledgerId`s (already present in the file) are skipped, not
 * an error - the caller sees which via the returned summary.
 * @param {string} ledgerFile
 * @param {Object} payload
 * @param {number} [recordedAtMs=Date.now()]
 * @returns {{recorded:Array<string>, duplicates:Array<string>}}
 */
export function appendCalls(ledgerFile, payload, recordedAtMs = Date.now()) {
  const existing = new Set(readJsonlOrEmpty(ledgerFile).map((r) => r.ledgerId));
  const rows = rowsFromPayload(payload, recordedAtMs);

  const recorded = [];
  const duplicates = [];
  const toAppend = [];
  for (const row of rows) {
    if (existing.has(row.ledgerId)) {
      duplicates.push(row.ledgerId);
      continue;
    }
    toAppend.push(row);
    recorded.push(row.ledgerId);
    existing.add(row.ledgerId); // guards duplicates within the same payload too
  }

  if (toAppend.length > 0) {
    const dir = path.dirname(ledgerFile);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const text = toAppend.map((r) => JSON.stringify(r)).join('\n') + '\n';
    appendFileSync(ledgerFile, text);
  }

  return { recorded, duplicates };
}

/**
 * Score every walkable ledger row (status ready, so the published closed-candle
 * retest/hold condition has already been observed) against `historyBySymbol`'s saved
 * 1m candles. A ready plan is filled at the ready close at its entry level (review fix
 * 8: the retest candle already traded the level and held), so the walk starts at the
 * first 1m candle after `closedThrough` with no touch search. Never touches the ledger
 * file itself - this only reads rows and produces gross diagnostic records.
 * @param {Array<Object>} ledgerRows
 * @param {Object<string, Array<Object>>} historyBySymbol - symbol -> ascending 1m candles
 * @param {Object} [cfg=ENGINE_CONFIG.replay.outcomes]
 * @returns {Array<Object>}
 */
export function scoreLedgerRows(ledgerRows, historyBySymbol, cfg = ENGINE_CONFIG.replay.outcomes) {
  const out = [];
  for (const row of ledgerRows) {
    const plan = row.plan;
    if (!plan || plan.status !== 'ready') continue;
    if (!isFiniteNumber(plan.entry) || !isFiniteNumber(plan.stop) || !isFiniteNumber(plan.tp1)) continue;

    const candles1m = historyBySymbol[row.symbol];
    const fromMs = Date.parse(row.closedThrough);
    if (!Array.isArray(candles1m) || !isFiniteNumber(fromMs)) {
      out.push({ ledgerId: row.ledgerId, symbol: row.symbol, status: 'no_history', scoredAt: new Date().toISOString() });
      continue;
    }

    const outcome = walkOutcome({
      candles1m,
      fromMs,
      direction: plan.direction,
      entryMin: plan.entry,
      entryMax: plan.entry,
      stop: plan.stop,
      target: plan.tp1,
      fillWindowCandles: cfg.fillWindowCandles,
      maxHoldCandles: cfg.maxHoldCandles,
      prefilled: true
    });

    out.push({
      ledgerId: row.ledgerId,
      symbol: row.symbol,
      direction: plan.direction,
      planStatus: plan.status,
      outcomeStatus: outcome.status,
      r: isFiniteNumber(outcome.r) ? outcome.r : null,
      outcomeMode: 'gross_level_touch',
      rUnits: 'gross_R_before_fees_slippage',
      holdCandles: isFiniteNumber(outcome.holdCandles) ? outcome.holdCandles : null,
      scoredAt: new Date().toISOString()
    });
  }
  return out;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'record') {
    const [contextFile, ...opts] = rest;
    if (!contextFile) throw new Error('usage: paper-ledger.js record <context.json> [--out <ledger.jsonl>]');
    const flags = {};
    for (let i = 0; i < opts.length; i++) if (opts[i].startsWith('--')) flags[opts[i].slice(2)] = opts[++i];
    const ledgerFile = flags.out || path.join('paper-ledger', 'calls.jsonl');

    const payload = JSON.parse(readFileSync(contextFile, 'utf8'));
    const { recorded, duplicates } = appendCalls(ledgerFile, payload);

    console.log(`[paper-ledger] recorded ${recorded.length} row(s) to ${ledgerFile}`);
    for (const id of recorded) console.log(`  + ${id}`);
    if (duplicates.length > 0) {
      console.log(`[paper-ledger] skipped ${duplicates.length} duplicate ledgerId(s) (never rewritten):`);
      for (const id of duplicates) console.log(`  = ${id}`);
    }
    return;
  }

  if (cmd === 'score') {
    const [ledgerFile, historyDir, ...opts] = rest;
    if (!ledgerFile || !historyDir) throw new Error('usage: paper-ledger.js score <ledger.jsonl> <historyDir> [--out <outcomes.jsonl>]');
    const flags = {};
    for (let i = 0; i < opts.length; i++) if (opts[i].startsWith('--')) flags[opts[i].slice(2)] = opts[++i];
    const outFile = flags.out || path.join(path.dirname(ledgerFile), 'outcomes.jsonl');

    const rows = readJsonlOrEmpty(ledgerFile);
    const symbols = [...new Set(rows.map((r) => r.symbol))];
    const historyBySymbol = {};
    for (const symbol of symbols) {
      const file = path.join(historyDir, `${symbol}_1m.json`);
      if (existsSync(file)) historyBySymbol[symbol] = readHistoryFile(file);
    }

    const outcomes = scoreLedgerRows(rows, historyBySymbol);
    writeFileSync(outFile, outcomes.map((o) => JSON.stringify(o)).join('\n') + (outcomes.length ? '\n' : ''));

    console.log(`[paper-ledger] scored ${outcomes.length} of ${rows.length} ledger row(s) (only ready plans are walkable; gross level-touch diagnostic)`);
    console.log(`[paper-ledger] wrote ${outFile}`);
    console.log(JSON.stringify(outcomes, null, 2));
    return;
  }

  throw new Error('usage: paper-ledger.js <record|score> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[paper-ledger] ${err.message}`);
    process.exit(1);
  });
}

export default { ledgerIdFor, marketInputHash, rowsFromPayload, appendCalls, scoreLedgerRows };
