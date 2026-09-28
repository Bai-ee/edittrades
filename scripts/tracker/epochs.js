#!/usr/bin/env node
/**
 * EditTrades call tracker - strategy epochs (T-21, docs/PROMPT_T21_STRATEGY_SCOREBOARD.md).
 *
 * Owner decision 2026-09-28 ("i want the website to start from zero and track each
 * strategy's success separately"): the site counts each strategy from the moment IT went
 * live in its current form, not from when the tracker started capturing. `deriveEpochs`
 * derives that start date per strategy from already-stored data, falling back to a
 * documented constant when the derivation finds nothing (a fresh data dir, or a strategy
 * whose marker row has not landed yet - the fallback is the owner's own cutover date, never
 * a guess). Pure reads, no writes - scripts/tracker/aggregate.js calls this once per build
 * and stores the result in aggregates.json (`agg.epochs`) so the page and report.md agree.
 *
 * | key      | epoch (counts from)                                                          |
 * |----------|-------------------------------------------------------------------------------|
 * | flag     | first data/calls row at configVersion FLAG_CONFIG_VERSION (NF stop floor, 2026-09-27) |
 * | htf      | first data/calls row at configVersion HTF_CONFIG_VERSION (HTF-anchored entries, 2026-09-28) |
 * | retest1h | first data/telegram-alerts line of kind RETEST_1H, else the flag epoch        |
 * | spot     | data/spot-trend/meta.json startDate                                           |
 * | wallet   | WALLET_EPOCH_ISO (constant - evaluation start, docs/PLAN_LIVE_PERPS_TEST.md)  |
 *
 * `deriveEpochsFrom` is the pure core (already-read capture rows / alert rows / spot meta
 * in, epoch table out) so tests never need to write real files; `deriveEpochs(dataDir)` is
 * the thin file-reading wrapper aggregate.js calls at build time.
 *
 * Usage: node epochs.js [--data ./data] - prints the derived table and which (if any) fell
 * back to a constant; nothing is written here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readTelegramAlerts, readJson } from './store.js';
import { spotDir } from './spot-trend.js';

export const FLAG_CONFIG_VERSION = '2026.09.27-2';
export const HTF_CONFIG_VERSION = '2026.09.27-3';

// Documented constant fallbacks, used only when the data dir has no row to derive an epoch
// from yet (a fresh checkout, or a strategy whose first marker has not landed) - each is the
// owner's own decision/cutover date for that strategy, not an arbitrary guess.
export const FLAG_EPOCH_FALLBACK = '2026-09-27T00:00:00.000Z'; // NF stop floor deploy day
export const HTF_EPOCH_FALLBACK = '2026-09-28T00:00:00.000Z'; // HTF-anchored entries deploy day
export const SPOT_EPOCH_FALLBACK = '2026-09-26T00:00:00.000Z'; // spot-trend paper tracking start (docs/PLAN_SPOT_TREND_2026-09-27.md)
export const WALLET_EPOCH_ISO = '2026-09-26T22:08:00.000Z'; // evaluation start (docs/PLAN_LIVE_PERPS_TEST.md) - constant, never derived

/** First `captureRows` row (already ascending by closedThrough) at `configVersion`, or null. */
export function firstCaptureAtVersion(captureRows, configVersion) {
  const row = (captureRows || []).find((r) => r && r.configVersion === configVersion && r.closedThrough);
  return row ? row.closedThrough : null;
}

/** First `alertRows` row (already ascending by sentAt) of `kind`, or null. */
export function firstAlertOfKind(alertRows, kind) {
  const row = (alertRows || []).find((r) => r && r.kind === kind && r.sentAt);
  return row ? row.sentAt : null;
}

/** `spotMeta.startDate` (YYYY-MM-DD or ISO) as a full ISO instant, or null. */
function spotStartIso(spotMeta) {
  const d = spotMeta && typeof spotMeta.startDate === 'string' ? spotMeta.startDate : null;
  if (!d) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Pure core: derive every strategy's epoch from already-read data.
 * @param {{captureRows?: Array<Object>, alertRows?: Array<Object>, spotMeta?: Object|null}} [data]
 * @returns {{flag:Object, htf:Object, retest1h:Object, spot:Object, wallet:Object}} each
 *   `{label, epochIso, source: 'capture'|'alert'|'meta'|'constant'}`
 */
export function deriveEpochsFrom({ captureRows = [], alertRows = [], spotMeta = null } = {}) {
  const flagCapture = firstCaptureAtVersion(captureRows, FLAG_CONFIG_VERSION);
  const flag = flagCapture
    ? { label: 'Flag engine · net floor', epochIso: flagCapture, source: 'capture' }
    : { label: 'Flag engine · net floor', epochIso: FLAG_EPOCH_FALLBACK, source: 'constant' };

  const htfCapture = firstCaptureAtVersion(captureRows, HTF_CONFIG_VERSION);
  const htf = htfCapture
    ? { label: 'HTF-anchored entries', epochIso: htfCapture, source: 'capture' }
    : { label: 'HTF-anchored entries', epochIso: HTF_EPOCH_FALLBACK, source: 'constant' };

  const retestAlert = firstAlertOfKind(alertRows, 'RETEST_1H');
  // "else same as flag" (docs/PROMPT_T21_STRATEGY_SCOREBOARD.md): RETEST_1H predates its own
  // alert-log stamp on some historical rows, so falling back to the flag epoch (rather than a
  // second, unrelated constant) keeps it inside the same "since the net floor" window.
  const retest1h = retestAlert
    ? { label: 'RETEST 1H', epochIso: retestAlert, source: 'alert' }
    : { label: 'RETEST 1H', epochIso: flag.epochIso, source: flag.source };

  const spotIso = spotStartIso(spotMeta);
  const spot = spotIso
    ? { label: 'Spot EMA20 trend', epochIso: spotIso, source: 'meta' }
    : { label: 'Spot EMA20 trend', epochIso: SPOT_EPOCH_FALLBACK, source: 'constant' };

  const wallet = { label: 'Live wallet · Steady profile', epochIso: WALLET_EPOCH_ISO, source: 'constant' };

  return { flag, htf, retest1h, spot, wallet };
}

/** File-reading wrapper: reads data/calls, data/telegram-alerts and data/spot-trend/meta.json, then derives. */
export function deriveEpochs(dataDir) {
  return deriveEpochsFrom({
    captureRows: readAllCalls(dataDir),
    alertRows: readTelegramAlerts(dataDir),
    spotMeta: readJson(path.join(spotDir(dataDir), 'meta.json'), null)
  });
}

function main() {
  const opts = parseArgs();
  const epochs = deriveEpochs(opts.data);
  for (const [key, e] of Object.entries(epochs)) {
    console.log(`[tracker:epochs] ${key} <- ${e.epochIso} (${e.source})${e.source === 'constant' ? ' [fallback]' : ''}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:epochs] ${err.message}`);
    process.exit(1);
  }
}
