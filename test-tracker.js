/**
 * Deterministic tests for scripts/tracker/ (T1 call tracker, docs/PLAN_CALL_TRACKER.md):
 * collector strip (fails closed), dedupe, candle store, vendored walkOutcome parity,
 * scorer on a synthetic day, idempotency, aggregate math, the page from an empty
 * store, the wallet whitelist (data/wallet.jsonl), call filter dimensions, the charts, and the
 * T2 journal (pull via an injected fetch, scoring, "your trades" line, wallet ticks, Engine vs
 * you, journal log). All file I/O is under os.tmpdir(); no network.
 *
 * Run: node test-tracker.js
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitiveKey, stripSensitive, findSensitiveKeys, recordsFromPayload, candlesFromPayload, ingestPayload,
  candlesFromKraken, walletRowFromPayload, WALLET_KEYS, pullJournal, blobBaseFromToken, resolveJournalBase, journalRecordsFromLines,
  pullServed, servedRowsFromLines, servedKey, slimCandidate
} from './scripts/tracker/collect.js';
import { runAlerts, findNewGood, alertKey, alertsFile, chartTimeframe, saveChart, ALERT_MAX_AGE_MIN } from './scripts/tracker/alerts.js';
import {
  readAllCalls, readCandles, readJsonl, writeJsonl, readJson, writeJson, outcomesFile, aggregatesFile, parseArgs, walletFile, readWallet,
  readJournal, appendJournal, journalOutcomesFile, appendCalls, appendCandles, telegramStatusFile
} from './scripts/tracker/store.js';
import { extractCalls, scoreCalls, scoreDataDir, callDims, scoreJournal, scoreJournalDataDir, rFromExit, candidateLevels } from './scripts/tracker/score.js';
import { chartKit, equityRows, journalEquityRows, setupEquityRows, walletMarks, filterValues, driftBucket, hourBucket, callVia, FILTER_DIMS } from './scripts/tracker/charts.js';
import { statsFor, computeAggregates, classCheck, aggregateDataDir, configBoundary } from './scripts/tracker/aggregate.js';
import { FEE_BPS, SLIPPAGE_BPS, COST_BPS_BY_DIRECTION, costR, netR } from './scripts/tracker/costs.js';
import {
  buildPage, renderHtml, rStatus, engineVsYou, systemStatus, nextRunMs, expectedRuns, SCHEDULE_MINUTES, PROVISIONAL, EDGE_NOTE, NO_SCORED,
  NO_CALIBRATION, CALIBRATION_MIN_N, EMPTY_CALIBRATION, NO_SHADOW, SHADOW_TOO_FEW, PHASE_NAME,
  NO_V3_SHADOW, V3_SHADOW_TOO_FEW
} from './scripts/tracker/build-page.js';
import { walkOutcome as vendoredWalk } from './scripts/tracker/walk-outcome.js';
import { walkOutcome as sourceWalk } from './scripts/replay-outcomes.js';
import { featuresAt } from './scripts/tracker/flag-paths.js';
import {
  pathsDataDir, computePathsRows, extractTighteningPoints, candidatesInRow, pathsFile, pathsSummary, derive3mFrom1m
} from './scripts/tracker/paths.js';
import {
  calibrationFile, calibrationDataDir, joinCalibrationRows, firstPathOutlookSightings, multiClassBrier, baselineWeights, baselineBrier,
  phaseStats, reliabilityTable, likelyHitRate, chaseStats, computeCalibration
} from './scripts/tracker/calibration.js';
import {
  SHADOW_CFG, shadowOutcomesFile, shadowSummaryFile, breakoutCloseAt, chaseTagFor, computeShadowRows, shadowDataDir, shadowSummary
} from './scripts/tracker/shadow.js';
import {
  v3ShadowOutcomesFile, v3ShadowSummaryFile, computeV3ShadowRows, v3ShadowSummary, v3ShadowDataDir
} from './scripts/tracker/v3-shadow.js';
import {
  NF_RULE, nfShadowOutcomesFile, nfShadowSummaryFile, atr15mAt, backfillNetFloor, liveReadyCalls, computeNfShadowRows, nfShadowSummary, nfShadowDataDir
} from './scripts/tracker/nf-shadow.js';
import { netFloorStopDistance, netRiskReward } from './lib/flagTradePlan.js';
import { ENGINE_CONFIG } from './config/engine.js';
import { writeFileSync } from 'node:fs';
import { esc } from './scripts/tracker/bento.js';
import { liveBoard, parseBias } from './scripts/tracker/live-board.js';
import { parseBiasString, buildHeadline, buildLede, rightNowCards, homeHero, HOME_HERO_CSS } from './scripts/tracker/home-hero.js';
import { latestCallPerSymbol } from './scripts/tracker/store.js';
import { computeProfileCurves, computeProfileCurvesDataDir, BOT_WALLET_START_EQUITY_USD } from './scripts/tracker/profiles.js';
import { renderStrategies } from './scripts/tracker/strategies-page.js';
import { PROFILES as VENDORED_PROFILES, PROFILE_KEYS as VENDORED_PROFILE_KEYS, tieredPolicyConfig as vendoredTieredPolicyConfig } from './scripts/tracker/profileConfig.js';
import { PROFILES as ENGINE_PROFILES, PROFILE_KEYS as ENGINE_PROFILE_KEYS, tieredPolicyConfig as engineTieredPolicyConfig } from './lib/execution/riskPolicy.js';
import {
  renderChangelogPage, parseChangelog, renderMarkdown, renderInline, isNew, groupFields,
  NO_MAP, NO_ENTRIES, NO_VERIFY, NO_CAPTURE, NEW_DAYS, NO_BOARD, BOARD_BREAKPOINT, boardModel, layoutBoard
} from './scripts/tracker/changelog-page.js';
import { buildChangelog, latestVersions } from './scripts/tracker/build-changelog.js';
import { pullTelegramLogs, telegramAlertRowsFromLines, transitionRowsFromLines, TELEGRAM_ALERT_FIELDS } from './scripts/tracker/collect.js';
import { readTelegramAlerts, readTransitions, appendTelegramAlerts, appendTransitions, alertOutcomesFile } from './scripts/tracker/store.js';
import { scoreAlerts, scoreAlertsDataDir, alertLatencyMin } from './scripts/tracker/score.js';
import { computeAlertAggregates } from './scripts/tracker/aggregate.js';
import { alertsZoneTiles, NO_ALERT_LOG, NO_TRANSITIONS } from './scripts/tracker/build-page.js';
import { emaSeries, dailyStates, flipsFrom, symbolReturns, dailyFromKraken, updateSpotTrend, spotDir } from './scripts/tracker/spot-trend.js';
import { findNewSpotFlips, formatSpotAlert, spotAlertKey } from './scripts/tracker/alerts.js';
import { renderSpot, readSpotData } from './scripts/tracker/spot-page.js';
import { ema as researchEma } from './scripts/research/edge/lib.js';
import { portfolioSeries as researchPortfolioSeries } from './scripts/research/edge/spot-portfolio.js';
import {
  goodCallsFromAlertLines, goodCallsFromCaptureRows, mergeGoodCalls, goodEndedTimesFromAlertLines,
  retestCallsFromAlertLines, retestExitTimesFromAlertLines, htfCallsFromAlertLines, htfExitTimesFromAlertLines
} from './scripts/tracker/collect.js';
import {
  scoreGoodCalls, scoreGoodCallsDataDir, goodCallId, scoreRetestCalls, scoreRetestCallsDataDir, retestCallId,
  scoreHtfCalls, scoreHtfCallsDataDir, htfCallId
} from './scripts/tracker/score.js';
import { goodCallOutcomesFile, retestCallOutcomesFile, htfCallOutcomesFile } from './scripts/tracker/store.js';
import { retestStats, bootstrapMeanLowerBound90, maxDrawdownR, htfStats } from './scripts/tracker/aggregate.js';
import { renderProduct } from './scripts/tracker/product-page.js';
import {
  deriveEpochs, deriveEpochsFrom, firstCaptureAtVersion, firstAlertOfKind,
  FLAG_CONFIG_VERSION, HTF_CONFIG_VERSION, FLAG_EPOCH_FALLBACK, HTF_EPOCH_FALLBACK, SPOT_EPOCH_FALLBACK, WALLET_EPOCH_ISO
} from './scripts/tracker/epochs.js';
import { epochStats, spotScoreboardStats, walletScoreboardStats, computeScoreboard } from './scripts/tracker/aggregate.js';
import { predictionsDir, readPredictions, appendPredictions, predictionRowKey } from './scripts/tracker/store.js';
import {
  PREDICTION_SYMBOLS, PREDICTION_TIMEFRAMES, predictionRowsFromLines, pullPredictions, joinPredictions, predictionCellKey,
  computePredictionsAggregate, EMPTY_PREDICTIONS_AGGREGATE, predCellBeats, predictionsGridHtml, predictionsSummaryLine, predictionsZoneBody,
  predictionsPanelHtml, predictionsOverallHtml, predictionsCurrentTableHtml, predictionNextGlyph, PREDICTIONS_CSS,
  NO_PREDICTIONS
} from './scripts/tracker/predictions.js';
import { renderPredictionsPage } from './scripts/tracker/predictions-page.js';

let passed = 0;
let failed = 0;
const failures = [];
const tmpDirs = [];

async function test(name, fn) {
  try {
    await fn();
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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tracker-test-'));
  tmpDirs.push(dir);
  return dir;
}

function allText(dir, skip = () => false) {
  let text = '';
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    text += statSync(p).isDirectory() ? allText(p, skip) : readFileSync(p, 'utf8');
  }
  return text;
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-20T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** 1m candles from `startMs`, each from fn(i) -> {h, l} (o/c = mid). */
function candles(startMs, n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const { h, l } = fn(i);
    return { timestamp: startMs + i * MIN, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 };
  });
}

const plan = (over = {}) => ({
  candidateId: 'BTC:1m:long:2026-09-19T23:40:00.000Z', timeframe: '1m', direction: 'long',
  status: 'ready', reasonCode: null, entryType: 'retest', entryCondition: 'closed candle retests 100 and holds',
  entry: 100, stop: 99, tp1: 103, tp2: null, grossRR: 3, netRR: 2.8, stopDistancePct: 1,
  planId: 'x', ...over
});

const rec = (klass, over = {}) => ({
  class: klass, setupId: 's', candidateId: 'BTC:1m:long:2026-09-19T23:40:00.000Z', asOf: 'x',
  primaryReason: { code: klass === 'GOOD' ? 'ready_flag_plan' : 'rr_below_min', text: 't' },
  readiness: 'ready', supports: [], opposes: [], unknowns: [], changeConditions: [], trace: {}, ...over
});

const captureRow = (symbol, ms, flagTradePlan, flagRecommendation) => ({
  capturedAt: iso(ms + 2000), closedThrough: iso(ms), schemaVersion: '1.18.0', configVersion: 'CFG',
  dataStatus: 'complete', symbol, price: 100, mark: { price: 100.01, driftBps: 1, status: 'ok' },
  flagTradePlan, flagRecommendation, candidateSetups: [], bias: 'b'
});

function payloadWithSecrets() {
  const c1 = (i) => ({ t: iso(T0 - (20 - i) * MIN), o: 1, h: 2, l: 0.5, c: 1.5, v: 3 });
  const tf = (n, closedThrough) => ({ candles: Array.from({ length: n }, (_, i) => c1(i)), closedThrough });
  return {
    schemaVersion: '1.18.0', configVersion: 'CFG', generatedAt: iso(T0 + 1500), closedThrough: iso(T0), dataStatus: 'complete',
    account: {
      status: 'available', reason: 'REASONSENTINEL', address: 'SECRET_ADDR_1', fetchedAt: 'FETCHEDSENTINEL',
      margin: { usd: 999, byAsset: { USDC: 31337 } },
      holdings: [{ symbol: 'HOLDSENTINEL', amount: 1, usdValue: 4242 }], holdingsUsd: 7777,
      unpriced: ['UNPRICEDSENTINEL'], gas: { sol: 0.654321, minSol: 0.01, sufficient: true },
      performance: { baselineUsd: 900, netPnlUsd: 99, returnPct: 11, source: 'SOURCESENTINEL' }
    },
    wallet: { balance: 123 },
    performance: { pnl: 42 },
    symbols: {
      BTC: {
        price: 100,
        mark: { price: 100.1, driftBps: 2, status: 'ok', walletBalance: 5 },
        timeframes: {
          '1m': { ...tf(20, iso(T0)), candles: [...tf(20).candles, { t: iso(T0), o: 1, h: 1, l: 1, c: 1, v: 1 }] }, // last one still forming
          '5m': tf(4, iso(T0)),
          '15m': tf(2, iso(T0))
        },
        candidateSetups: [{ candidateId: 'c1', timeframe: '1m', direction: 'long', state: 'confirmed', breakoutLevel: 100, invalidation: 99, measuredRR: 3.2, qual: { quality: 'high' }, risk: { lossAtStopPctOfWallet: 0.1, collateralUsd: 10 } }],
        decisionTrace: { bias: 'scalp:L1', walletAddress: 'SECRET_ADDR_2' },
        flagTradePlan: plan({ margin: { usd: 1 }, balanceUsd: 3, nested: { depositAddress: 'SECRET_ADDR_3' } }),
        flagRecommendation: rec('GOOD', { performance: { x: 1 }, trace: { holdingsUsd: 1, walletStatus: 'ok' } })
      },
      ETH: { price: 50, timeframes: {}, flagTradePlan: null, flagRecommendation: rec('WATCH', { candidateId: null }) }
    }
  };
}

async function run() {
  await test('candlesFromKraken: converts rows, drops the open last candle, skips bad rows', () => {
    const result = { XXBTZUSD: [
      [1790200000, '100.1', '101.2', '99.5', '100.9', '100.5', '12.5', 40],
      [1790200060, 'x', '1', '1', '1', '1', '1', 1],
      [1790200120, '100.9', '102', '100', '101.5', '101', '3', 9],
      [1790200180, '101.5', '101.6', '101.4', '101.5', '101.5', '0.1', 1]
    ], last: 1790200120 };
    const rows = candlesFromKraken('BTC', result);
    assertEqual(rows.length, 2, 'two closed valid candles');
    assertEqual(rows[0].t, new Date(1790200000 * 1000).toISOString(), 'first t');
    assertEqual(rows[0].h, 101.2, 'high parsed');
    assertEqual(rows[1].v, 3, 'volume parsed');
    assertEqual(candlesFromKraken('BTC', null).length, 0, 'null result is empty');
  });

  console.log('\nscripts/tracker\n');

  await test('isSensitiveKey: account/wallet/performance/margin/holdings* and *wallet*/*balance*/*address*', () => {
    for (const k of ['account', 'wallet', 'performance', 'margin', 'holdings', 'holdingsUsd', 'walletAddress', 'lossAtStopPctOfWallet', 'balanceUsd', 'depositAddress', 'Balance']) {
      assert(isSensitiveKey(k), `${k} should be sensitive`);
    }
    for (const k of ['price', 'mark', 'flagTradePlan', 'entry', 'stop', 'tp1', 'class']) assert(!isSensitiveKey(k), `${k} should pass`);
  });

  await test('collector: no account/wallet/balance/address key or value reaches disk (wallet.jsonl whitelisted only)', () => {
    const dir = tmp();
    ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const text = allText(dir, (p) => p === walletFile(dir));
    for (const needle of ['"account"', '"wallet"', '"performance"', '"margin"', '"holdings', 'allet', 'alance', 'ddress', 'SECRET_ADDR', '7777', '999']) {
      assert(!text.includes(needle), `found ${needle} outside wallet.jsonl`);
    }
    const everything = allText(dir);
    for (const needle of ['SECRET_ADDR', 'ddress', '"holdings"', 'HOLDSENTINEL', '4242', 'byAsset', '31337', 'REASONSENTINEL', 'FETCHEDSENTINEL',
      'UNPRICEDSENTINEL', 'unpriced', '"gas"', '0.654321', 'SOURCESENTINEL', 'netPnlUsd', 'returnPct', '"reason"']) {
      assert(!everything.includes(needle), `found ${needle} anywhere on disk`);
    }
    const rows = readAllCalls(dir);
    assertEqual(rows.length, 2, 'one row per symbol');
    assertEqual(findSensitiveKeys(rows).length, 0, 'no sensitive keys in stored rows');
    const btc = rows.find((r) => r.symbol === 'BTC');
    assertEqual(btc.flagTradePlan.entry, 100, 'plan kept');
    assertEqual(btc.flagRecommendation.class, 'GOOD', 'rec kept');
    assertEqual(btc.bias, 'scalp:L1', 'bias string kept');
    assertEqual(JSON.stringify(Object.keys(btc.mark)), '["price","driftBps","status"]', 'mark slimmed');
    assertEqual(JSON.stringify(Object.keys(btc.candidateSetups[0])),
      '["id","tf","dir","state","breakout","invalidation","measuredRR","qual","measuredTarget","compressionScore","durationCandles","impulseStrength","flagHigh","flagLow"]',
      'candidate slimmed (T4-additive fields included)');
  });

  await test('wallet.jsonl: rows carry exactly the whitelisted keys, numbers only, deduped by t', () => {
    const dir = tmp();
    const a = ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const b = ingestPayload(dir, payloadWithSecrets(), T0 + 60_000);
    assertEqual(a.wallet, 1, 'first capture writes a sample');
    assertEqual(b.wallet, 0, 'same closedThrough writes none');
    const raw = readFileSync(walletFile(dir), 'utf8').trim().split('\n');
    assertEqual(raw.length, 1, 'one line');
    const row = JSON.parse(raw[0]);
    assertEqual(JSON.stringify(Object.keys(row)), JSON.stringify(WALLET_KEYS), 'exact whitelist, in order');
    assertEqual(JSON.stringify(row), JSON.stringify({ t: iso(T0), status: 'available', marginUsd: 999, holdingsUsd: 7777, totalUsd: 8776, baselineUsd: 900, pnlUsd: 99, pnlPct: 11 }), 'values');
    for (const k of WALLET_KEYS.slice(2)) assert(row[k] === null || typeof row[k] === 'number', `${k} numeric`);
  });

  await test('wallet row: not available -> status kept, every number null; no account -> absent', () => {
    for (const status of ['partial', 'unavailable', 'disabled']) {
      const p = payloadWithSecrets();
      p.account.status = status;
      const row = walletRowFromPayload(p);
      assertEqual(JSON.stringify(Object.keys(row)), JSON.stringify(WALLET_KEYS), `${status} keys`);
      assertEqual(row.status, status, 'status kept');
      assert(WALLET_KEYS.slice(2).every((k) => row[k] === null), `${status} writes nulls`);
    }
    const p = payloadWithSecrets();
    delete p.account;
    assertEqual(walletRowFromPayload(p).status, 'absent', 'no account block');
    p.account = { status: 'Available <script>', margin: { usd: 5 } };
    assertEqual(walletRowFromPayload(p).status, 'unknown', 'odd status word not copied');
    p.account = { status: 'available', margin: { usd: '5' }, holdingsUsd: 2, performance: { baselineUsd: 'x' } };
    const r = walletRowFromPayload(p);
    assert(r.marginUsd === null && r.totalUsd === null && r.baselineUsd === null && r.holdingsUsd === 2, 'non-numbers become null');
    assertEqual(walletRowFromPayload({ closedThrough: 'nope' }), null, 'no valid closedThrough -> no row');
  });

  await test('collector: row fields match the plan list', () => {
    const [row] = recordsFromPayload(payloadWithSecrets(), T0);
    for (const k of ['capturedAt', 'closedThrough', 'schemaVersion', 'configVersion', 'symbol', 'price', 'mark', 'flagTradePlan', 'flagRecommendation', 'candidateSetups', 'bias', 'pathOutlook', 'breakoutEntry']) {
      assert(k in row, `missing ${k}`);
    }
  });

  // ---------------------------------------------------------------- T4 P3 records.js additions (pathOutlook, breakoutEntry)

  await test('records.js: pathOutlook and breakoutEntry are whitelisted-key copies, null when absent', () => {
    const p = payloadWithSecrets();
    p.symbols.BTC.pathOutlook = {
      id: 'BTC:5m:long:x', tf: '5m', dir: 'long', at: 'tightening', lean: 'breakout', likely: 'runner', chase: 'elevated',
      w: { retest_go: 40, runner: 35, false_break: 15, fail_first: 5, chop: 5 }, n: 140, cal: true, key: 'tf=5m',
      extraneousField: 'DROP_ME', walletAddress: 'SECRET_LEAK'
    };
    p.symbols.BTC.breakoutEntry = {
      id: 'BTC:5m:long:x', tf: '5m', dir: 'long', at: 'broken', entry: 101, stop: 99.5, tp1: 105, grossRR: 2.7, netRR: 2.5, status: 'ready',
      extraneousField: 'DROP_ME', margin: { usd: 1 }
    };
    const [btc, eth] = recordsFromPayload(p, T0);
    assertEqual(JSON.stringify(Object.keys(btc.pathOutlook)), JSON.stringify(['id', 'tf', 'dir', 'at', 'lean', 'likely', 'chase', 'w', 'n', 'cal', 'key']), 'pathOutlook whitelist, exact keys');
    assertEqual(btc.pathOutlook.likely, 'runner', 'value copied');
    assertEqual(btc.pathOutlook.w.runner, 35, 'nested w copied');
    assert(!('extraneousField' in btc.pathOutlook), 'non-whitelisted key dropped');
    assert(!('walletAddress' in btc.pathOutlook), 'sensitive key dropped even inside pathOutlook');
    assertEqual(JSON.stringify(Object.keys(btc.breakoutEntry)), JSON.stringify(['id', 'tf', 'dir', 'at', 'entry', 'stop', 'tp1', 'grossRR', 'netRR', 'status']), 'breakoutEntry whitelist, exact keys');
    assertEqual(btc.breakoutEntry.entry, 101, 'value copied');
    assert(!('extraneousField' in btc.breakoutEntry) && !('margin' in btc.breakoutEntry), 'non-whitelisted keys dropped');
    assertEqual(eth.pathOutlook, null, 'absent pathOutlook -> null (ETH symbol carries none)');
    assertEqual(eth.breakoutEntry, null, 'absent breakoutEntry -> null');
    assertEqual(findSensitiveKeys([btc, eth]).length, 0, 'no sensitive keys survive anywhere in the rows');
  });

  // ---------------------------------------------------------------- T6 completion plan D-variant (flagTradePlan.shadow)

  await test('records.js: flagTradePlan.shadow (v3) is copied through whole - not sliced like pathOutlook/breakoutEntry - and still passes the sensitive-key strip', () => {
    const p = payloadWithSecrets();
    p.symbols.BTC.flagTradePlan = plan({
      status: 'rejected', reasonCode: 'rr_below_min', grossRR: 2.9,
      shadow: { v3: { candidateId: 'x', status: 'ready', reasonCode: null, entry: 100, stop: 99, tp1: 108.7, grossRR: 2.9, netRR: 2.25, planId: 'x|y|z' } }
    });
    const [btc] = recordsFromPayload(p, T0);
    assert(btc.flagTradePlan.shadow && btc.flagTradePlan.shadow.v3, 'shadow.v3 survives the whole-object copy');
    assertEqual(btc.flagTradePlan.shadow.v3.status, 'ready', 'nested value copied intact');
    assertEqual(btc.flagTradePlan.shadow.v3.grossRR, 2.9, 'nested numeric value copied intact');
    assertEqual(findSensitiveKeys(btc).length, 0, 'no sensitive keys inside a well-formed shadow object');

    const leaky = payloadWithSecrets();
    leaky.symbols.BTC.flagTradePlan = plan({ shadow: { v3: { walletAddress: 'SECRET_LEAK', status: 'ready' } } });
    const [leakyBtc] = recordsFromPayload(leaky, T0);
    assert(!('walletAddress' in leakyBtc.flagTradePlan.shadow.v3), 'a sensitive key nested inside shadow is stripped, same as anywhere else in the row (deep strip, not a shallow copy)');
    assertEqual(findSensitiveKeys(leakyBtc).length, 0, 'nothing sensitive survives inside shadow');
  });

  await test('collector: strip fails closed (findSensitiveKeys sees any survivor; strip is deep)', () => {
    const found = findSensitiveKeys({ a: [{ b: { walletX: 1 } }], account: 1 });
    assertEqual(found.length, 2, 'both found');
    assertEqual(findSensitiveKeys(stripSensitive({ a: [{ b: { walletX: 1, ok: 2 } }], account: 1 })).length, 0, 'strip removes all');
  });

  await test('dedupe: same symbol+closedThrough twice writes nothing the second time', () => {
    const dir = tmp();
    const a = ingestPayload(dir, payloadWithSecrets(), T0 + 3000);
    const b = ingestPayload(dir, payloadWithSecrets(), T0 + 60_000);
    assertEqual(a.calls.added, 2, 'first run adds');
    assertEqual(b.calls.added, 0, 'second run adds none');
    assertEqual(b.calls.duplicates, 2, 'second run sees duplicates');
    assertEqual(b.candles['1m'], 0, 'no duplicate candles');
    assertEqual(readAllCalls(dir).length, 2, 'still two rows');
    assert(existsSync(path.join(dir, 'calls', '2026-09-20.jsonl')), 'day file named by closedThrough UTC day');
  });

  await test('candle store: only closed candles, keyed by symbol+t, ascending', () => {
    const dir = tmp();
    const byTf = candlesFromPayload(payloadWithSecrets());
    assertEqual(byTf['1m'].length, 20, 'forming 1m candle dropped');
    ingestPayload(dir, payloadWithSecrets(), T0);
    const c = readCandles(dir, '1m').BTC;
    assertEqual(c.length, 20, '20 stored');
    assert(c.every((x, i) => i === 0 || x.timestamp > c[i - 1].timestamp), 'ascending');
    assertEqual(c[19].timestamp, T0 - MIN, 'last stored candle is the one closing at closedThrough');
    assertEqual(readCandles(dir, '15m').BTC.length, 2, '15m stored');
  });

  await test('walk-outcome.js: vendored walkOutcome matches scripts/replay-outcomes.js', () => {
    const cs = candles(T0, 60, (i) => ({ h: 100 + (i % 7) * 0.6, l: 99.4 + (i % 5) * 0.3 }));
    const cases = [
      { direction: 'long', entryMin: 100, entryMax: 100, stop: 99, target: 103, prefilled: true },
      { direction: 'long', entryMin: 100.5, entryMax: 100.5, stop: 99.5, target: 102.5, prefilled: false },
      { direction: 'short', entryMin: 101, entryMax: 101, stop: 102, target: 99.5, prefilled: false },
      { direction: 'short', entryMin: 101, entryMax: 101, stop: 103, target: 90, prefilled: true },
      { direction: 'long', entryMin: null, entryMax: 1, stop: 1, target: 2 }
    ];
    for (const c of cases) {
      const args = { candles1m: cs, fromMs: T0 + 3 * MIN, fillWindowCandles: 15, maxHoldCandles: 40, ...c };
      assertEqual(JSON.stringify(vendoredWalk(args)), JSON.stringify(sourceWalk(args)), `parity ${JSON.stringify(c)}`);
    }
  });

  await test('profileConfig.js: vendored PROFILES/tieredPolicyConfig match lib/execution/riskPolicy.js', () => {
    assertEqual(JSON.stringify(VENDORED_PROFILE_KEYS), JSON.stringify(ENGINE_PROFILE_KEYS), 'PROFILE_KEYS parity');
    assertEqual(JSON.stringify(VENDORED_PROFILES), JSON.stringify(ENGINE_PROFILES), 'PROFILES parity');
    for (const key of ENGINE_PROFILE_KEYS) {
      for (const tier of ['A', 'B', 'C', 'unknown']) {
        assertEqual(JSON.stringify(vendoredTieredPolicyConfig(key, tier)), JSON.stringify(engineTieredPolicyConfig(key, tier)), `tieredPolicyConfig(${key}, ${tier}) parity`);
      }
    }
  });

  // ---- synthetic day
  const condId = 'SOL:5m:long:2026-09-19T23:00:00.000Z';
  const rows = [
    captureRow('BTC', T0, plan(), rec('GOOD')),
    captureRow('BTC', T0 + 10 * MIN, plan(), rec('GOOD')), // same call, no new row
    captureRow('ETH', T0, plan({ candidateId: 'ETH:1m:short:x', direction: 'short', entry: 50, stop: 51, tp1: 47 }), null),
    captureRow('SOL', T0, plan({ candidateId: condId, timeframe: '5m', status: 'conditional', reasonCode: 'awaiting_retest', entry: 20, stop: 19, tp1: 23 }), rec('WATCH', { candidateId: condId, primaryReason: { code: 'entry_condition' } })),
    captureRow('SOL', T0 + 10 * MIN, plan({ candidateId: condId, timeframe: '5m', status: 'ready', entry: 20, stop: 19, tp1: 23 }), rec('GOOD', { candidateId: condId })),
    captureRow('XRP', T0, plan({ candidateId: 'XRP:c', status: 'rejected', reasonCode: 'rr_below_min', entry: 10, stop: 9, tp1: 11 }), rec('BAD', { candidateId: 'XRP:c' })),
    captureRow('ADA', T0, plan({ candidateId: 'ADA:c', status: 'conditional', reasonCode: 'awaiting_breakout' }), rec('DATA_UNAVAILABLE', { candidateId: null, primaryReason: { code: 'market_data_unavailable' } })),
    captureRow('DOT', T0, plan({ candidateId: 'DOT:c', entry: 5, stop: 4, tp1: 8 }), null)
  ];
  const candleSet = {
    BTC: candles(T0, 30, (i) => (i < 10 ? { h: 101, l: 99.5 } : { h: 103.5, l: 101 })), // tp1 at i=10
    ETH: candles(T0, 30, (i) => (i === 3 ? { h: 51.2, l: 49.8 } : { h: 50.2, l: 49.8 })), // stop at i=3
    SOL: candles(T0, 120, (i) => (i < 60 ? { h: 21, l: 19.5 } : { h: 23.5, l: 21 })), // ready at +10m, tp1 at i=60
    XRP: candles(T0, 30, () => ({ h: 13, l: 12 })), // BAD levels never touched
    DOT: candles(T0, 30, () => ({ h: 5.5, l: 4.5 })) // filled, unresolved
  };

  await test('extractCalls: one call per signature change, plan and rec separately', () => {
    const calls = extractCalls(rows);
    assertEqual(calls.filter((c) => c.symbol === 'BTC').length, 2, 'BTC: one plan + one rec despite two captures');
    assertEqual(calls.filter((c) => c.symbol === 'SOL').length, 4, 'SOL: conditional, ready, WATCH, GOOD');
    const bad = calls.find((c) => c.symbol === 'XRP' && c.kind === 'rec');
    assertEqual(bad.entry, 10, 'BAD rec linked to its plan levels');
    assertEqual(bad.netRR, 2.8, 'netRR carried');
  });

  await test('scorer: synthetic day (long tp1, short stop, not_filled, open, expired, conditional, rejected)', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const get = (sym, kind, status) => out.find((r) => r.symbol === sym && r.kind === kind && (!status || r.planStatus === status || r.class === status));
    const btc = get('BTC', 'plan');
    assertEqual(btc.outcome, 'tp1', 'long tp1');
    assertEqual(btc.r, 3, 'gross R to TP1');
    assertEqual(btc.filledAt, iso(T0), 'ready fills at the ready close');
    assertEqual(btc.minutesToResolution, 11, 'minutes to TP1');
    assertEqual(btc.netRR, 2.8, 'net carried from plan');
    assertEqual(get('BTC', 'rec').outcome, 'tp1', 'GOOD rec scored like its ready plan');
    assertEqual(get('BTC', 'rec').mode, 'ready_prefilled', 'GOOD mode');
    const eth = get('ETH', 'plan');
    assertEqual(eth.outcome, 'stop', 'short stop');
    assertEqual(eth.r, -1, 'stop is -1R');
    assertEqual(get('XRP', 'plan').outcome, 'rejected', 'rejected plan not walked');
    const bad = get('XRP', 'rec');
    assertEqual(bad.outcome, 'not_filled', 'BAD counterfactual never touched');
    assertEqual(bad.mode, 'counterfactual_level_touch', 'BAD mode');
    assertEqual(get('ADA', 'rec').outcome, 'no_levels', 'no levels');
    assertEqual(get('DOT', 'plan').outcome, 'open', 'filled, unresolved, window open');
    const cond = get('SOL', 'plan', 'conditional');
    const ready = get('SOL', 'plan', 'ready');
    assertEqual(ready.outcome, 'tp1', 'SOL ready tp1');
    assertEqual(cond.becameReady, true, 'conditional linked to its ready plan');
    assertEqual(cond.readyCallId, ready.callId, 'linked by candidateId');
    assertEqual(cond.outcome, 'tp1', 'conditional takes the ready outcome');
    const watch = get('SOL', 'rec', 'WATCH');
    assertEqual(watch.outcome, 'tp1', 'WATCH counterfactual touch then tp1');
    assertEqual(get('ADA', 'plan').outcome, 'pending', 'conditional never ready, window open');
  });

  // ---------------------------------------------------------------- T6 completion plan C2 (SETUP tier)

  function setupCaptureRow(symbol, ms, setup) {
    return captureRow(symbol, ms, null, setup ? { class: 'WATCH', setupId: null, candidateId: null, primaryReason: { code: 'x', text: 'x' }, readiness: 'no_plan', setup } : null);
  }

  function setupFields(over = {}) {
    return { candidateId: 'BTC:1m:long:setup1', timeframe: '1m', direction: 'long', entry: 100, stop: 99, tp1: 103, grossRR: 3, netRR: 2.8, entryCondition: 'a closed candle closes above 100, then a later closed candle\'s low reaches within 0.1 ATR of 100 and closes at or above it', ...over };
  }

  /** {timestamp, open, high, low, close} candles starting at `startMs`, one per `stepMs`. */
  function setupCandles(startMs, stepMs, cs) {
    return cs.map((r, i) => ({ timestamp: startMs + i * stepMs, open: r.o, high: r.h, low: r.l, close: r.c }));
  }

  // Long entry 100/stop 99/tp1 103: candle 0 hovers between stop and entry (no touch of
  // either), candle 1 touches/crosses entry cleanly (low 99.5, safely above stop),
  // candle 2 reaches tp1. Short mirrors around 100/101/97.
  const LONG_SETUP_CANDLES = [{ o: 99.5, h: 99.8, l: 99.3, c: 99.6 }, { o: 99.6, h: 100.2, l: 99.5, c: 100.1 }, { o: 100.1, h: 103.2, l: 100, c: 103.1 }];
  const SHORT_SETUP_CANDLES = [{ o: 100.5, h: 100.7, l: 100.2, c: 100.4 }, { o: 100.4, h: 100.5, l: 99.8, c: 100 }, { o: 100, h: 100.2, l: 96.9, c: 97 }];

  await test('extractCalls + scoreCalls: SETUP tier scored what-if (never prefilled - touched then walked), mirrored long/short', () => {
    const longRow = setupCaptureRow('BTC', T0, setupFields());
    const longCandles = setupCandles(T0, MIN, LONG_SETUP_CANDLES);
    const longCalls = extractCalls([longRow]);
    const longSetupCalls = longCalls.filter((c) => c.kind === 'setup');
    assertEqual(longSetupCalls.length, 1, 'one setup call extracted');
    assertEqual(longSetupCalls[0].candidateId, 'BTC:1m:long:setup1', 'candidateId carried');
    assertEqual(longSetupCalls[0].levelSource, 'setup', 'levelSource');
    const longScored = scoreCalls(longCalls, { BTC: longCandles }, [], T0 + 60 * MIN);
    const longSetup = longScored.find((r) => r.kind === 'setup');
    assertEqual(longSetup.mode, 'counterfactual_setup', 'mode');
    assertEqual(longSetup.outcome, 'tp1', 'trigger touched (candle 1 crosses 100), then walked to tp1');

    const shortRow = setupCaptureRow('ETH', T0, setupFields({ candidateId: 'ETH:1m:short:setup1', direction: 'short', entry: 100, stop: 101, tp1: 97 }));
    const shortCandles = setupCandles(T0, MIN, SHORT_SETUP_CANDLES);
    const shortCalls = extractCalls([shortRow]);
    const shortScored = scoreCalls(shortCalls, { ETH: shortCandles }, [], T0 + 60 * MIN);
    const shortSetup = shortScored.find((r) => r.kind === 'setup');
    assertEqual(shortSetup.mode, 'counterfactual_setup', 'mode (short)');
    assertEqual(shortSetup.outcome, 'tp1', 'short trigger touched then walked to tp1');
  });

  await test('SETUP call stream: no new call once flagRecommendation.setup disappears from a later capture (covers a SETUP becoming ready or voiding, from the tracker\'s side) - the already-created call still scores on its own window', () => {
    const row1 = setupCaptureRow('BTC', T0, setupFields());
    const row2 = setupCaptureRow('BTC', T0 + MIN, null); // setup gone next capture - became ready (own plan/rec call, separate) or voided
    const calls = extractCalls([row1, row2]);
    assertEqual(calls.filter((c) => c.kind === 'setup').length, 1, 'still exactly one setup call - no duplicate, no call for the disappearance itself');
    const candles = setupCandles(T0, MIN, LONG_SETUP_CANDLES);
    const scored = scoreCalls(calls, { BTC: candles }, [], T0 + 60 * MIN);
    assertEqual(scored.find((r) => r.kind === 'setup').outcome, 'tp1', 'the one setup call is still walked and scored normally');
  });

  await test('callDims: filter dimensions copied from the capture row; final rows backfilled once', () => {
    const r = captureRow('BTC', T0, plan(), rec('GOOD', {
      candidate: { timeframe: '1m', direction: 'long', state: 'confirmed' },
      supports: ['td:bull:3/4', 'divergence_agrees'], opposes: ['ema200:1m:below', 'ema200:4h:above'], unknowns: ['ema200:1w:missing']
    }));
    const d = callDims(r);
    assertEqual(d.recClass, 'GOOD', 'class');
    assertEqual(d.recReason, 'ready_flag_plan', 'reason');
    assertEqual(d.planStatusAtCall, 'ready', 'plan status');
    assertEqual(d.candidateState, 'confirmed', 'candidate state');
    assertEqual(d.topDown, 'supports', 'td side');
    assertEqual(d.topDownToken, 'td:bull:3/4', 'td token');
    assertEqual(d.ema200Side, 'below', 'EMA200 side on the call timeframe');
    assertEqual(d.divergence, 'agrees', 'divergence');
    assertEqual(d.closedThrough, iso(T0), 'closedThrough');
    assertEqual(JSON.stringify(d.unknowns), '["ema200:1w:missing"]', 'codes copied');
    assertEqual(callDims(captureRow('BTC', T0, null, null)).divergence, 'none', 'no rec -> none');
    const calls = extractCalls([r]);
    assert(calls.every((c) => c.dims && c.dims.recClass === 'GOOD'), 'every call carries dims');
    const old = scoreCalls(calls, candleSet, [], T0 + 2 * 60 * MIN).map(({ dims, ...rest }) => rest);
    const again = scoreCalls(calls, candleSet, old, T0 + 3 * 60 * MIN);
    const plan1 = again.find((c) => c.kind === 'plan');
    assertEqual(plan1.outcome, 'tp1', 'final outcome kept');
    assertEqual(plan1.dims.topDown, 'supports', 'dims backfilled');
    assertEqual(plan1.scoredAt, old.find((c) => c.kind === 'plan').scoredAt, 'scoredAt kept');
  });

  await test('scorer: 24 h window -> expired / not_filled', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 25 * 60 * MIN);
    assertEqual(out.find((r) => r.symbol === 'DOT').outcome, 'expired', 'unresolved after 24 h');
    assertEqual(out.find((r) => r.symbol === 'ADA' && r.kind === 'plan').outcome, 'not_filled', 'conditional never ready');
    assertEqual(out.find((r) => r.symbol === 'ADA' && r.kind === 'plan').becameReady, false, 'becameReady false');
  });

  await test('scorer: idempotent; final rows never rewritten, open rows re-scored', () => {
    const calls = extractCalls(rows);
    const first = scoreCalls(calls, candleSet, [], T0 + 2 * 60 * MIN);
    const again = scoreCalls(calls, candleSet, first, T0 + 3 * 60 * MIN);
    assertEqual(JSON.stringify(again), JSON.stringify(first), 'no change -> identical, scoredAt kept');
    const moved = { ...candleSet, BTC: candles(T0, 30, () => ({ h: 100.5, l: 98 })), DOT: candles(T0, 30, (i) => (i === 20 ? { h: 8.5, l: 5 } : { h: 5.5, l: 4.5 })) };
    const third = scoreCalls(calls, moved, first, T0 + 3 * 60 * MIN);
    assertEqual(third.find((r) => r.symbol === 'BTC' && r.kind === 'plan').outcome, 'tp1', 'final kept');
    const dot = third.find((r) => r.symbol === 'DOT');
    assertEqual(dot.outcome, 'tp1', 'open re-scored');
    assertEqual(dot.scoredAt, iso(T0 + 3 * 60 * MIN), 'scoredAt moves only on change');
  });

  await test('scoreDataDir: end-to-end through the store, stable on rerun', () => {
    const dir = tmp();
    ingestPayload(dir, payloadWithSecrets(), T0);
    const a = scoreDataDir(dir, T0 + MIN);
    const b = scoreDataDir(dir, T0 + 2 * MIN);
    assertEqual(readJsonl(outcomesFile(dir)).length, a.length, 'written');
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'rerun identical');
  });

  // ---------------------------------------------------------------- T5 S1 costs.js (net R, fees + slippage)

  await test('costs.js: cost math hand example - entry 100, stop 99, FEE_BPS=SLIPPAGE_BPS=5 -> cost 0.2R; stop nets -1.2, tp1(r=3) nets 2.8', () => {
    assertEqual(FEE_BPS, 5, 'FEE_BPS');
    assertEqual(SLIPPAGE_BPS, 5, 'SLIPPAGE_BPS');
    assertEqual(costR(100, 99), 0.2, 'cost = 2*(5+5)/10000 * entry / |entry-stop| = 0.002 * 100 / 1');
    assertEqual(netR(100, 99, -1), -1.2, 'stop leg nets -1 - cost');
    assertEqual(netR(100, 99, 3), 2.8, 'tp1 leg (r=3) nets r - cost');
    assertEqual(costR(100, 100), null, 'zero risk (entry === stop) -> null');
    assertEqual(netR(100, 100, 3), null, 'no cost -> no net R');
    assertEqual(costR(null, 99), null, 'non-finite entry -> null');
    assertEqual(netR(100, 99, null), null, 'non-finite gross R -> null');
  });

  await test('costs.js: FEE_BPS/SLIPPAGE_BPS/COST_BPS_BY_DIRECTION match config/engine.json risk (documented, tested source of truth)', () => {
    const engineCfg = JSON.parse(readFileSync('config/engine.json', 'utf8'));
    assertEqual(FEE_BPS, engineCfg.risk.feeBps, 'feeBps');
    assertEqual(SLIPPAGE_BPS, engineCfg.risk.slippageBps, 'slippageBps');
    assertEqual(COST_BPS_BY_DIRECTION.long, engineCfg.risk.costBpsByDirection.long, 'costBpsByDirection.long');
    assertEqual(COST_BPS_BY_DIRECTION.short, engineCfg.risk.costBpsByDirection.short, 'costBpsByDirection.short');
  });

  await test('costs.js: T6 completion plan C1 - costR/netR are direction-dependent when direction is passed (long 34bps, short 14bps), unchanged when omitted', () => {
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    assertEqual(r6(costR(100, 99, 'long')), 0.34, 'long: 34/10000 * 100 / 1');
    assertEqual(r6(costR(100, 99, 'short')), 0.14, 'short: 14/10000 * 100 / 1');
    assertEqual(costR(100, 99), 0.2, 'omitted direction still falls back to the flat 20bps cost');
    assertEqual(costR(100, 99, 'flat'), 0.2, 'an unrecognized direction token also falls back to flat');
    assertEqual(r6(netR(100, 99, 3, 'long')), 2.66, 'long tp1 (r=3) nets 3 - 0.34');
    assertEqual(r6(netR(100, 99, -1, 'short')), -1.14, 'short stop nets -1 - 0.14');
  });

  await test('aggregate: win rate, expectancy, losing streak, median time', () => {
    const r = (outcome, rv, mins, at) => ({ kind: 'plan', planStatus: 'ready', outcome, r: rv, filledAt: at, resolvedAt: at, calledAt: at, minutesToResolution: mins, netRR: 3 });
    const s = statsFor([
      r('stop', -1, 5, iso(T0)), r('stop', -1, 5, iso(T0 + MIN)), r('tp1', 3, 10, iso(T0 + 2 * MIN)),
      r('stop', -1, 5, iso(T0 + 3 * MIN)), r('tp1', 4, 30, iso(T0 + 4 * MIN)), r('open', null, null, iso(T0 + 5 * MIN))
    ]);
    assertEqual(s.calls, 6, 'calls');
    assertEqual(s.fills, 6, 'fills');
    assertEqual(s.winRate, 0.4, 'win rate 2/5');
    assertEqual(s.expectancy, 0.8, 'expectancy (3+4-3)/5');
    assertEqual(s.avgWinR, 3.5, 'avg win R');
    assertEqual(s.maxLosingStreak, 2, 'streak');
    assertEqual(s.medianMinutesToTP1, 20, 'median min to TP1');
    assertEqual(s.avgNetRR, 3, 'avg net');
    assertEqual(s.avgCostR, null, 'no entry/stop on these rows -> no cost');
    assertEqual(s.netExpectancy, null, 'no entry/stop on these rows -> no net expectancy');
  });

  await test('aggregate: net expectancy (fees + slippage, costs.js) derived per-row from entry/stop', () => {
    const r = (outcome, rv, entry, stop) => ({
      kind: 'plan', planStatus: 'ready', outcome, r: rv, entry, stop,
      filledAt: iso(T0), resolvedAt: iso(T0), calledAt: iso(T0), minutesToResolution: 5, netRR: 3
    });
    const s = statsFor([
      r('stop', -1, 100, 99), r('stop', -1, 100, 99), r('tp1', 3, 100, 99),
      r('stop', -1, 100, 99), r('tp1', 4, 100, 99)
    ]);
    assertEqual(s.expectancy, 0.8, 'gross expectancy (3+4-1-1-1)/5, same math as costR-free stats');
    assertEqual(s.avgCostR, 0.2, 'cost = 2*(5+5)/10000 * 100 / 1 = 0.2R on every row here');
    assertEqual(s.netExpectancy, 0.6, 'net expectancy = gross 0.8 - avgCostR 0.2 (constant cost across rows)');
    const noLevels = statsFor([{ kind: 'plan', planStatus: 'ready', outcome: 'tp1', r: 3, entry: null, stop: null, filledAt: iso(T0), resolvedAt: iso(T0), calledAt: iso(T0) }]);
    assertEqual(noLevels.netExpectancy, null, 'missing levels -> net expectancy null, never a crash');
  });

  await test('aggregate: tiles, classes, capture gaps', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const caps = [...rows, captureRow('BTC', T0 + 60 * MIN, plan(), rec('GOOD'))];
    const agg = computeAggregates(out, caps, candleSet, T0 + 2 * 60 * MIN);
    assertEqual(agg.tiles.goodToday, 2, 'GOOD today (BTC + SOL)');
    assertEqual(agg.tiles.callsToday, 5, 'rec calls today (BTC GOOD, SOL WATCH+GOOD, XRP BAD, ADA DATA_UNAVAILABLE)');
    assertEqual(agg.tiles.fills7d, 4, 'ready plan fills');
    assertEqual(agg.captures.gaps, 1, 'BTC 10m -> 60m gap');
    assertEqual(agg.captures.dataUnavailable, 1, 'DATA_UNAVAILABLE capture');
    assert(agg.windows['7d'].byClass.some((g) => g.key === 'BAD'), 'by class');
    assertEqual(agg.windows['7d'].reasonCounts.rr_below_min, 2, 'rr_below_min plan + rec');
  });

  await test('T6 completion plan C3: configBoundary null with a single configVersion, detects the most recent transition otherwise, splits gross+net stats before/after', () => {
    const row = (cv, outcome, rVal, at) => ({ kind: 'plan', planStatus: 'ready', outcome, r: rVal, entry: 100, stop: 99, configVersion: cv, calledAt: at });
    const single = [row('v1', 'tp1', 3, iso(T0)), row('v1', 'stop', null, iso(T0 + MIN))];
    assertEqual(configBoundary(single), null, 'single configVersion -> null');
    assertEqual(configBoundary([row('v1', 'tp1', 3, iso(T0))]), null, 'fewer than 2 rows -> null');

    const mixed = [
      row('v1', 'tp1', 3, iso(T0)),
      row('v1', 'stop', null, iso(T0 + MIN)),
      row('v2', 'tp1', 4, iso(T0 + 2 * MIN)),
      row('v2', 'tp1', 2, iso(T0 + 3 * MIN)),
      { kind: 'rec', class: 'GOOD', configVersion: 'v2', calledAt: iso(T0 + 4 * MIN) } // not tradable - excluded
    ];
    const cb = configBoundary(mixed);
    assert(cb, 'boundary detected');
    assertEqual(cb.fromVersion, 'v1', 'fromVersion');
    assertEqual(cb.toVersion, 'v2', 'toVersion');
    assertEqual(cb.at, iso(T0 + 2 * MIN), 'boundary at the first v2 row');
    assertEqual(cb.before.calls, 2, 'before: the two v1 tradable rows');
    assertEqual(cb.after.calls, 2, 'after: the two v2 tradable rows (rec row excluded)');
    assertEqual(cb.before.expectancy, statsFor(mixed.slice(0, 2)).expectancy, 'before gross expectancy matches statsFor over the same slice');
    assertEqual(cb.after.expectancy, statsFor(mixed.slice(2, 4)).expectancy, 'after gross expectancy matches statsFor over the same slice');
    assertEqual(cb.before.netExpectancy, statsFor(mixed.slice(0, 2)).netExpectancy, 'before net expectancy carried too');
    assertEqual(cb.after.netExpectancy, statsFor(mixed.slice(2, 4)).netExpectancy, 'after net expectancy carried too');
  });

  await test('T6 completion plan C3: page shows the config-boundary note only when a real transition exists', () => {
    const dir1 = tmp();
    const { htmlFile: h1 } = buildPage(path.join(dir1, 'data'), path.join(dir1, 'docs'), T0);
    assert(!readFileSync(h1, 'utf8').includes('id="testing-phase-config-boundary-note"'), 'empty data dir - no boundary note');

    const dir2 = tmp();
    // Reuse the shared scorer/aggregate pipeline: one capture under v1, one under v2.
    // No candles needed - configBoundary only reads planStatus (from the capture
    // itself), not the walked outcome.
    const dataDir = path.join(dir2, 'data');
    appendCalls(dataDir, [
      { ...captureRow('BTC', T0, plan({ status: 'ready' }), null), configVersion: 'v1' },
      { ...captureRow('BTC', T0 + 60 * MIN, plan({ status: 'ready', candidateId: 'BTC:1m:long:cfg2' }), null), configVersion: 'v2' }
    ]);
    scoreDataDir(dataDir, T0 + 2 * 60 * MIN);
    const { htmlFile: h2 } = buildPage(dataDir, path.join(dir2, 'docs'), T0 + 2 * 60 * MIN);
    const html2 = readFileSync(h2, 'utf8');
    assert(html2.includes('id="testing-phase-config-boundary-note"'), 'two distinct configVersions - boundary note present');
    assert(html2.includes('CONFIG v1'), 'names the from-version');
    assert(html2.includes('v2'), 'names the to-version');
  });

  await test('T6 completion plan C3: aggregate tiles - goodPerHour7d and setupsPerDay7d over the 7-day window', () => {
    const r = (kind, klass, at) => ({ kind, class: klass, calledAt: at });
    const outcomes = [
      r('rec', 'GOOD', iso(T0)),
      r('rec', 'GOOD', iso(T0 + 60 * MIN)),
      r('rec', 'WATCH', iso(T0 + 90 * MIN)), // not GOOD - excluded
      r('setup', null, iso(T0)),
      r('setup', null, iso(T0 + 30 * MIN)),
      r('setup', null, iso(T0 + 2 * 24 * 60 * MIN)) // 2 days old, still inside the 7d window
    ];
    const agg = computeAggregates(outcomes, [], {}, T0 + 3 * 24 * 60 * MIN);
    const round4 = (v) => Math.round(v * 1e4) / 1e4;
    const round3 = (v) => Math.round(v * 1e3) / 1e3;
    assertEqual(agg.tiles.goodPerHour7d, round4(2 / (7 * 24)), '2 GOOD calls over 7*24 hours');
    assertEqual(agg.tiles.setupsPerDay7d, round3(3 / 7), '3 setup calls over 7 days');
  });

  await test('T6 completion plan C3: goodPerHour7d/setupsPerDay7d are 0 (not null) with no qualifying rows, from an empty data dir', () => {
    const agg = aggregateDataDir(tmp(), T0);
    assertEqual(agg.tiles.goodPerHour7d, 0, 'no GOOD calls -> 0');
    assertEqual(agg.tiles.setupsPerDay7d, 0, 'no setup calls -> 0');
  });

  await test('page: renders from an empty data dir with hero, phase block, and one provisional tag per section', () => {
    const dir = tmp();
    const out = path.join(dir, 'docs');
    const { htmlFile, mdFile } = buildPage(path.join(dir, 'data'), out, T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['tile-last-capture', 'tile-expectancy-7d', 'hero-sample-size', 'tile-win-rate-7d', 'tile-fills-7d', 'tile-good-7d', 'tile-losing-streak-7d', 'tile-avg-r-7d', 'tile-good-per-hour-7d', 'tile-setups-per-day-7d', 'testing-phase-section', 'testing-phase-status', 'testing-phase-days-bar', 'testing-phase-plans-bar', 'what-we-track-section', 'open-calls-section', 'window-7d-section', 'window-30d-section', 'daily-log-section', 'capture-health-summary']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(!html.includes('id="testing-phase-restart-note"'), 'D-variant revised (2026-09-24): the manually-maintained restart note is removed - the window continues, it does not restart');
    assert(html.includes(PHASE_NAME.toUpperCase()), 'phase name reflects the current rule (2.5R gross, net gate off)');
    const sections = (html.match(/<section /g) || []).length;
    assertEqual((html.match(/class="prov-tag"/g) || []).length, sections, 'one provisional tag per section');
    assertEqual(html.split(EDGE_NOTE.replace(/'/g, '&#39;')).length - 1, 1, 'edge note once');
    assert(html.includes(NO_SCORED), 'empty-state text');
    assert(html.includes('n=0 scored calls'), 'sample size');
    assert(/\[(RUNNING|SCHEDULED|READY FOR REVIEW)\]/.test(html), 'phase status word');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'exactly one executable inline script');
    assert(scripts.every((t) => !/\bsrc=/i.test(t)), 'no external scripts');
    assert(!/fetch\(|XMLHttpRequest|import\(/.test(html), 'no network in the script');
    for (const id of ['equity-chart-section', 'equity-chart-svg', 'equity-readout', 'equity-filter-table', 'wallet-chart-section', 'wallet-chart-svg', 'wallet-range-control', 'wallet-current-value', 'tracker-calls-data', 'tracker-wallet-data']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.indexOf('id="testing-phase-section"') < html.indexOf('id="equity-chart-section"')
      && html.indexOf('id="equity-chart-section"') < html.indexOf('id="wallet-chart-section"')
      && html.indexOf('id="wallet-chart-section"') < html.indexOf('id="what-we-track-section"'), 'chart order');
    assert(html.includes('[NO WALLET SAMPLES YET]'), 'wallet empty state');
    assert(/<svg id="equity-chart-svg"[^>]*>[\s\S]*?\[NO SCORED CALLS YET\]/.test(html), 'equity empty state inside the chart frame');
    assert(!/gradient|box-shadow|drop-shadow/i.test(html), 'no gradients or shadows');
    assert(html.includes('.chart-svg{') && html.includes('.seg-btn{'), 'chart styles on the page');
    assert(html.includes('prefers-color-scheme: dark') && html.includes('prefers-color-scheme: light'), 'both schemes');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes(PROVISIONAL) && md.includes('## Testing phase'), 'report labelled, phase block');
  });

  await test('page: how-to page is written beside index, linked both ways, static, no account fields', () => {
    const dir = tmp();
    const { htmlFile, howToFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const index = readFileSync(htmlFile, 'utf8');
    const howTo = readFileSync(howToFile, 'utf8');
    assert(/<a href="how-to.html"[^>]*id="tracker-how-to-link"/.test(index), 'index links to how-to');
    assert(howTo.includes('href="index.html"'), 'how-to links back');
    for (const cmd of ['signals', 'flags', 'forming', 'why SYM', 'trades', 'log text', 'journal', 'balance', 'data check', 'track']) {
      assert(howTo.includes(`data-command="${cmd}"`), `command ${cmd}`);
    }
    assert(howTo.includes('&quot;trades&quot; gives the same answer'), 'trades = signals');
    for (const id of ['howto-what-section', 'howto-routine-section', 'howto-telegram-section', 'howto-chatgpt-section', 'howto-rules-section', 'howto-studies-section', 'howto-tracker-section', 'howto-journal-section', 'howto-limits-section',
      'howto-telegram-menu-tile', 'howto-telegram-levels-tile', 'howto-telegram-buttons-tile', 'howto-classes-tile', 'howto-data-block-tile', 'howto-rules-table', 'howto-studies-tile', 'howto-studies-list']) {
      assert(howTo.includes(`id="${id}"`), `missing #${id}`);
      if (id.endsWith('-section')) assert(howTo.includes(`href="#${id}"`), `jump nav to #${id}`);
    }
    assert(/<a href="spot.html"[^>]*id="howto-nav-spot-trend-link"/.test(howTo), 'how-to links to spot trend');
    // Research so far: every 2026-09-26/27 study doc linked to its GitHub blob, one per line.
    for (const doc of ['FREQUENCY_STUDY_2026-09-26.md', 'GAP_CHECK_2026-09-26.md', 'COST_GATE_STUDY_2026-09-26.md', 'CONDITIONS_STUDY_2026-09-26.md', 'RISK_SIZING_STUDY_2026-09-26.md',
      'EXITS_STUDY_2026-09-26.md', 'VARIANTS_STUDY_2026-09-26.md', 'SWING_STUDY_2026-09-26.md', 'MEANREV_STUDY_2026-09-26.md', 'HISTORY_2Y_2026-09-26.md', 'EDGE_SEARCH_2026-09-27.md', 'RETEST_ENTRY_STUDY_2026-09-27.md']) {
      assert(howTo.includes(`https://github.com/Bai-ee/snapshot_tradingview/blob/upgrade-signal-engine/docs/${doc}`), `study link: ${doc}`);
    }
    for (const key of ['Signals', 'Flags', 'Why BTC', 'Why ETH', 'Why SOL', 'Charts', 'Wallet', 'Journal', 'Status', 'Alerts']) {
      assert(howTo.includes(`data-menu-key="${key}"`), `menu key ${key}`);
    }
    for (const cmd of ['/signals', '/why SYM', '/flags [SYM]', '/chart SYM TF', '/wallet', '/journal [n]', '/log text', '/status', '/alerts']) {
      assert(howTo.includes(`data-tg-command="${cmd}"`), `telegram command ${cmd}`);
    }
    // Rules in force must match the owner decisions (docs/OWNER_DECISIONS_2026-09-24.md).
    for (const fact of ['≥ 2.5R to TP1, gross', 'net_rr_low', 'gross 3.0', 'must not wick through the stop', '≤ 3% from entry', 'Long 0.34% · short 0.14%', '0.20% when direction is unresolved',
      '4H → 1m / 3m / 5m (main) · 1H → 1m / 3m · 1D → 15m / 1H', '2026-09-23 → 2026-10-07', 'frozen until 2026-10-08', '01:00-05:00 America/Chicago', 'Took it', 'Skipped',
      'getScalpContext', 'postJournal', 'getJournal', '1.27.x', 'open, close, adjust, skip, note', 'MISS_004']) {
      assert(howTo.includes(esc(fact)), `how-to states: ${fact}`);
    }
    // Live execution state (T-15, 2026-09-27): mode is live, caps raised, trailing stop and
    // trade-chart v2 documented; the old dry-run-default / 2x-leverage / not-yet-merged
    // copy this replaced must be gone.
    for (const fact of ['Mode: LIVE', '$150 size, 100x leverage, $5 loss/trade, $25/day, 1 open position', 'Automatic trailing stop', '100x — matches the venue', 'config 2026.09.27-3']) {
      assert(howTo.includes(esc(fact)), `how-to states: ${fact}`);
    }
    // T-20: HTF ENTRY row describes the live, wider-stop signal family and its /htf command.
    for (const fact of ['HTF ENTRY (live)', 'DIRECTION', 'ENTRY', '1h swing', '/htf shows all three symbols']) {
      assert(howTo.includes(esc(fact)), `how-to states (T-20): ${fact}`);
    }
    assert(!/net R:R ≥ 2\.0|restarted/i.test(howTo), 'no stale net-gate or restart copy');
    assert(!/Mode is DRY RUN until|Do at least 3 dry orders before going live|2x today · 100x at the venue|Planned: scoring GOOD calls straight from a 1-minute|not yet merged into this build/i.test(howTo), 'no stale dry-run/leverage/1-minute-log copy');
    assert(!/<script/i.test(howTo), 'no scripts');
    assert(!/SCALP_CONTEXT_API_KEY|Bearer|walletAddress/i.test(howTo), 'no secrets or wallet fields');
    assert(howTo.includes('prefers-color-scheme: dark') && howTo.includes('prefers-color-scheme: light'), 'both schemes');
  });

  await test('page: risk page is written beside index, linked from index and how-to, static, no secrets', () => {
    const dir = tmp();
    const { htmlFile, howToFile, riskFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const index = readFileSync(htmlFile, 'utf8');
    const howTo = readFileSync(howToFile, 'utf8');
    const risk = readFileSync(riskFile, 'utf8');
    assert(/<a href="risk.html"[^>]*id="tracker-risk-link"/.test(index), 'index links to risk');
    assert(/<a href="risk.html"[^>]*id="howto-nav-risk-link"/.test(howTo), 'how-to links to risk');
    assert(risk.includes('href="index.html"') && risk.includes('href="how-to.html"'), 'risk links back to both');
    for (const id of ['risk-intro-section', 'risk-layers-section', 'risk-example-section', 'risk-net-r-section', 'risk-steps-section', 'risk-growing-section', 'risk-tracker-section',
      'risk-layer-venue-tile', 'risk-layer-env-tile', 'risk-layer-wallet-tile', 'risk-sizing-table', 'risk-net-floor-tile', 'risk-steps-list']) {
      assert(risk.includes(`id="${id}"`), `missing #${id}`);
      if (id.endsWith('-section')) assert(risk.includes(`href="#${id}"`), `jump nav to #${id}`);
    }
    assert(/<a href="spot.html"[^>]*id="risk-nav-spot-trend-link"/.test(risk), 'risk links to spot trend');
    // Every cap/default cited must match its live source (lib/execution/gates.js CAP_ENV,
    // lib/execution/riskPolicy.js RISK_DEFAULTS, config/engine.json risk,
    // docs/PLAN_TELEGRAM_EXECUTION.md's 30-trade-evaluation caps line, 2026-09-26+).
    for (const fact of ['100x', '0.34%', '0.14%', '$150', '$5', '$25', 'RISK_PCT_PER_TRADE', '0.5%', '25%', '15%', '3%', '8%', '0.05 SOL', 'Peak-drawdown kill',
      '+0.47R gross', '-2.37R net', '0.02–0.07%', 'JEAzPi', '523.14']) {
      assert(risk.includes(esc(fact)), `risk states: ${fact}`);
    }
    assert(!/EXECUTION_MAX_SIZE_USD<\/dt><dd>\$20|EXECUTION_MAX_LEVERAGE<\/dt><dd>2x|EXECUTION_MAX_LOSS_USD_PER_TRADE<\/dt><dd>\$2</.test(risk), 'no stale env-cap values');
    assert(!/<script/i.test(risk), 'no scripts');
    assert(!/SCALP_CONTEXT_API_KEY|Bearer|SOLANA_PRIVATE_KEY|EXECUTION_PIN=|RPC_URL/i.test(risk), 'no secrets or key material');
    assert(risk.includes('prefers-color-scheme: dark') && risk.includes('prefers-color-scheme: light'), 'both schemes');
  });

  await test('page: index states current rules, frozen-until date, Telegram alerts line; no stale net-gate copy', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const index = readFileSync(htmlFile, 'utf8');
    assert(index.includes('id="testing-phase-frozen-row"') && index.includes('FROZEN UNTIL 2026-10-08'), 'frozen-until row');
    assert(index.includes('GROSS MINRR 2.5, NET FLOOR LIVE') && index.includes('CONFIG BOUNDARY MARKED'), 'live rules + boundary note');
    assert(/id="system-alerts-channel-note"[^>]*>Alerts: Telegram @EditTrades_Bot/.test(index), 'alerts channel line');
    assert(index.includes('href="how-to.html#howto-telegram-section"'), 'links to how-to Telegram section');
    assert(!/net R:R ≥ 2\.0|Window restarted|net gate on at 2\.0/i.test(index), 'no stale strategy copy');
  });

  await test('alerts: new GOOD call alerts once per symbol+candidate, fresh only, owner mentioned', async () => {
    const dir = tmp();
    const data = path.join(dir, 'data');
    const now = Date.parse('2026-09-24T06:10:00Z');
    const row = (symbol, cls, at, candidateId, extra = {}) => ({
      capturedAt: at, closedThrough: at.replace(/:\d\d\.\d{3}Z$/, ':00.000Z'), symbol, price: 100, source: 'cron',
      flagRecommendation: { class: cls, candidateId, primaryReason: { code: 'ok', text: 'aligned 21/200' } },
      flagTradePlan: cls === 'GOOD' ? { status: 'ready', direction: 'long', timeframe: '5m', entry: 100, stop: 99, tp1: 103, tp2: 105, grossRR: 3, netRR: 2.8, candidateId } : null,
      ...extra
    });
    appendCalls(data, [
      row('BTC', 'GOOD', '2026-09-24T06:07:05.000Z', 'BTC:5m:long:a'),
      row('ETH', 'WATCH', '2026-09-24T06:07:05.000Z', 'ETH:5m:long:b'),
      row('SOL', 'GOOD', '2026-09-24T03:00:05.000Z', 'SOL:5m:long:old')
    ]);
    const first = await runAlerts(data, { nowMs: now, mention: 'owner-x' });
    assertEqual(first.length, 1, 'one fresh GOOD');
    assert(first[0].title.includes('BTC LONG 5m') && first[0].title.includes('entry 100') && first[0].title.includes('TP1 103'), 'title levels');
    assert(first[0].body.includes('@owner-x') && first[0].body.includes('aligned 21/200'), 'mention + reason');
    assertEqual(readJsonl(alertsFile(data)).length, 1, 'recorded');
    appendCalls(data, [row('BTC', 'GOOD', '2026-09-24T06:08:05.000Z', 'BTC:5m:long:a')]);
    assertEqual((await runAlerts(data, { nowMs: now + 60_000 })).length, 0, 'same candidate not re-alerted');
    appendCalls(data, [row('BTC', 'GOOD', '2026-09-24T06:09:05.000Z', 'BTC:5m:long:c', { source: 'served' })]);
    const second = await runAlerts(data, { nowMs: now + 120_000 });
    assertEqual(second.length, 1, 'new candidate alerts');
    assert(second[0].body.includes('seen via chat'), 'served labelled chat');
    assertEqual(findNewGood([row('SOL', 'GOOD', new Date(now - (ALERT_MAX_AGE_MIN + 1) * 60_000).toISOString(), 'x')], [], now).length, 0, 'stale ignored');
    assertEqual(alertKey({ symbol: 'BTC', closedThrough: 't', flagRecommendation: {} }), 'BTC|t', 'key falls back to close');
  });

  await test('alerts: chart at alert time is saved and embedded; failures never block the alert', async () => {
    const dir = tmp();
    const data = path.join(dir, 'data');
    const chartsDir = path.join(dir, 'alerts');
    const now = Date.parse('2026-09-24T06:10:00Z');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const calls = [];
    const okFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, arrayBuffer: async () => png }; };
    const good = (symbol, candidateId, tf) => ({
      capturedAt: '2026-09-24T06:07:05.000Z', closedThrough: '2026-09-24T06:07:00.000Z', symbol, price: 100, source: 'cron',
      flagRecommendation: { class: 'GOOD', candidateId, candidate: { timeframe: tf, direction: 'short' } },
      flagTradePlan: { status: 'ready', entry: 100, stop: 101, tp1: 97, candidateId }
    });
    appendCalls(data, [good('ETH', 'ETH:15m:short:a', '15m')]);
    const chart = { chartsDir, rawBase: 'https://raw.example/alerts', url: 'https://engine.example/api/scalp-context', key: 'k', fetchImpl: okFetch };
    const [a] = await runAlerts(data, { nowMs: now, chart });
    assertEqual(calls.length, 1, 'one chart fetch');
    assert(calls[0].url.endsWith('?chart=ETH%3A15m'), 'plan/candidate timeframe charted');
    assertEqual(calls[0].init.headers['X-EditTrades-Client'], 'tracker', 'identifies as tracker');
    assert(a.chartUrl && a.chartUrl.startsWith('https://raw.example/alerts/') && a.chartUrl.endsWith('-ETH-15m-' + a.chartUrl.slice(-12)), 'chart url');
    assert(a.body.includes(`](${a.chartUrl})`), 'image embedded in body');
    assert(existsSync(path.join(chartsDir, a.chartUrl.split('/').pop())), 'png saved');
    assert(a.title.includes('ETH SHORT 15m'), 'direction from candidate');

    appendCalls(data, [{ ...good('BTC', 'BTC:5m:short:b', '5m'), capturedAt: '2026-09-24T06:08:05.000Z', closedThrough: '2026-09-24T06:08:00.000Z' }]);
    const [b] = await runAlerts(data, { nowMs: now, chart: { ...chart, fetchImpl: async () => { throw new Error('down'); } } });
    assert(b && !b.chartUrl && !b.body.includes('!['), 'network failure: alert without image');
    assertEqual(await saveChart({ symbol: 'BTC', timeframe: '5m', nowMs: now, chartsDir, key: 'k', fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>') }) }), null, 'non-PNG rejected');
    assertEqual(await saveChart({ symbol: 'BTC', timeframe: '5m', nowMs: now, chartsDir, key: 'k', fetchImpl: async () => ({ ok: false }) }), null, 'HTTP error rejected');
    assertEqual(await saveChart({ symbol: 'BTC', timeframe: '5m', nowMs: now, chartsDir, key: null, fetchImpl: okFetch }), null, 'no key, no fetch');
    assertEqual(chartTimeframe({ flagRecommendation: {} }), '5m', 'default timeframe');
  });

  await test('status: LIVE / DELAYED / STALLED bands, next run on the schedule, cron in sync', () => {
    const at = Date.parse('2026-09-24T02:00:00Z');
    assertEqual(systemStatus(null, at).word, 'WAITING', 'no captures');
    assertEqual(systemStatus('2026-09-24T01:30:00Z', at).word, 'LIVE', '30 min');
    assertEqual(systemStatus('2026-09-24T00:50:00Z', at).word, 'DELAYED', '70 min');
    assertEqual(systemStatus('2026-09-23T23:00:00Z', at).word, 'STALLED', '3 h');
    assertEqual(new Date(nextRunMs(at)).toISOString(), '2026-09-24T02:07:00.000Z', 'next :07');
    assertEqual(new Date(nextRunMs(Date.parse('2026-09-24T02:07:00Z'))).toISOString(), '2026-09-24T02:17:00.000Z', 'strictly after');
    assertEqual(new Date(nextRunMs(Date.parse('2026-09-24T02:58:00Z'))).toISOString(), '2026-09-24T03:07:00.000Z', 'wraps the hour');
    assertEqual(expectedRuns(Date.parse('2026-09-24T05:00:00Z'), Date.parse('2026-09-24T06:00:00Z')), 2, '30-min cadence before the switch');
    assertEqual(expectedRuns(Date.parse('2026-09-24T06:00:00Z'), Date.parse('2026-09-24T07:00:00Z')), 6, '10-min cadence after');
    assertEqual(expectedRuns(Date.parse('2026-09-24T05:30:00Z'), Date.parse('2026-09-24T06:30:00Z')), 4, 'mixed span');
    const yml = readFileSync('scripts/tracker/repo-template/.github/workflows/track.yml', 'utf8');
    assert(yml.includes(`cron: '${SCHEDULE_MINUTES.join(',')} * * * *'`), 'page schedule matches workflow cron');
  });

  await test('page: system zone sits first with status, heartbeat, timeline and activity', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['zone-system', 'system-status-section', 'system-status-word', 'system-heartbeat', 'system-next-run', 'system-runs-24h', 'testing-phase-day', 'testing-phase-plans-eta', 'activity-24h-section']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.indexOf('id="zone-system"') < html.indexOf('id="zone-performance"'), 'system zone first');
    assert(html.includes('>WAITING<'), 'empty store shows WAITING');
    assert(html.includes('data-last-capture=""'), 'status tile carries last capture for the browser');
  });

  await test('page: hero shows signed expectancy with status color and phase progress counts', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const agg = computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN, { phaseStartMs: T0 - 60 * MIN });
    const html = renderHtml(agg);
    const e = agg.tiles.expectancy7d;
    assert(typeof e === 'number', 'synthetic day has an expectancy');
    assert(html.includes(`class="hero-value ${rStatus(e)}" id="tile-expectancy-7d"`), 'hero status class');
    const t = agg.windows['7d'].tradable;
    assert(html.includes(`n=${t.wins + t.losses} scored call`), 'hero sample size');
    assertEqual(agg.phase.tradable.wins + agg.phase.tradable.losses, t.wins + t.losses, 'phase scored plans');
    assertEqual(rStatus(0), 'st-good', '0R is green');
    assertEqual(rStatus(-0.3), 'st-warn', 'amber band');
    assertEqual(rStatus(-0.6), 'st-bad', 'red below -0.5R');
  });

  await test('page: hero shows net expectancy beside gross, labelled "net of fees" (T5 S1)', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const agg = computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN, { phaseStartMs: T0 - 60 * MIN });
    const html = renderHtml(agg);
    const net = agg.tiles.netExpectancy7d;
    assert(typeof net === 'number', 'synthetic day has a net expectancy (entry/stop present on every decided ready plan)');
    assert(net < agg.tiles.expectancy7d, 'net is lower than gross once fees + slippage are charged');
    const m = html.match(/id="hero-net-expectancy-7d">([^<]+)R net of fees<\/div>/);
    assert(m, 'hero shows a net-of-fees line beside the gross hero value');
    assert(html.indexOf('id="tile-expectancy-7d"') < html.indexOf('id="hero-net-expectancy-7d"'), 'net line follows the gross hero value');
  });

  const LIVE_ROWS = [
    { symbol: 'ETH', closedThrough: '2026-09-29T00:57:00.000Z', price: 2679.28, mark: { price: 2678.09, driftBps: -4.4, status: 'ok' },
      bias: 'scalp:L48,S8,N44|swing:L80,S0,N20|tf:1m=S,3m=N,5m=N,15m=L,1h=L,4h=L,1d=L|ct:2|td:bull:4/4|a200:4/7|mark:-4.4',
      flagRecommendation: { class: 'WATCH', candidate: { direction: 'short', timeframe: '1m', state: 'forming', breakout: 2677.48 },
        action: { call: 'WAIT', etaMin: 1, note: '1m close below 2,677.48, then a retest that holds it' },
        clarity: { gate: { passable: false, text: 'a 15m level blocks the measured target' }, killIf: { text: 'close back above 2,677.48 = stand down' }, otherSide: { text: 'rotation to 2,678.82-2,685.43' } } },
      pathOutlook: { w: { retest_go: 20, runner: 11, false_break: 12, fail_first: 50, chop: 8 }, n: 121, cal: true, chase: 'low' },
      candidateSetups: [
        { id: 'a', tf: '1m', dir: 'short', state: 'forming', breakout: 2677.48, measuredRR: 4.58, qual: { decision: 'watch' } },
        { id: 'b', tf: '5m', dir: 'long', state: 'triggering', breakout: 2690, measuredRR: 3.1, qual: { decision: 'watch' } },
        { id: 'c', tf: '3m', dir: 'long', state: 'failed', breakout: 2700, measuredRR: 2, qual: { decision: 'dont' } }
      ] },
    { symbol: 'BTC', closedThrough: '2026-09-29T00:57:00.000Z', price: 83990, mark: { price: 83988.78, driftBps: -0.1, status: 'ok' }, bias: 'tf:1m=L', flagRecommendation: { class: 'BAD' }, candidateSetups: [] }
  ];

  await test('page: home hero is the headline plus the live board, no performance card, above the jump nav', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const agg = computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN, { phaseStartMs: T0 - 60 * MIN });
    const html = renderHtml(agg, { liveRows: LIVE_ROWS });
    for (const id of [
      'home-hero-shell', 'home-hero-headline-panel', 'home-hero-title', 'home-hero-lede',
      'home-hero-side-column', 'home-hero-prediction-panel',
      'live-board-card', 'live-board-tabs', 'live-board-panel-all', 'live-board-panel-eth', 'live-board-panel-btc', 'live-board-asof-line'
    ]) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(!html.includes('id="home-hero-result-card"') && !html.includes('id="home-hero-net-r"'), 'performance card is gone from the hero');
    assert(html.includes(`id="home-hero-title">${esc(buildHeadline(LIVE_ROWS))}</h1>`), 'headline is the data-driven sentence, server-rendered (T-23)');
    assert(!html.includes('id="home-hero-title-data"'), 'no client-side title-rotation payload any more (headline is data-driven, not stacked words)');
    assert(html.includes(`id="home-hero-lede">${esc(buildLede(LIVE_ROWS))}</p>`), 'lede states the data-as-of time from the latest closed candle');
    assert(!html.includes('id="home-hero-right-now"') && !html.includes('id="home-hero-now-btc"'), 'no per-coin Right-now cards on the homepage (owner 2026-09-29)');
    assert(html.indexOf('id="home-hero-prediction-panel"') < html.indexOf('id="live-board-card"'), 'prediction panel sits above the live board in the side column');
    assert(html.indexOf('id="tracker-top-edge-strip"') < html.indexOf('id="home-hero-shell"'), 'hero follows the top edge');
    assert(html.indexOf('id="home-hero-shell"') < html.indexOf('id="tracker-jump-nav"'), 'hero sits above the jump nav');
    assert(html.includes('src:url("fonts/mathias-bold.ttf")'), 'Mathias loaded from docs/fonts');
    assert(html.includes('.live-board{') && html.includes('max-height:40vh'), 'live board is hard-capped at 40vh');
    const net = agg.totals.tradable.netExpectancy;
    assert(typeof net === 'number', 'synthetic day has a net expectancy');
    const sign = net > 0 ? '+' : net < 0 ? '−' : '';
    assert(html.includes(`id="live-board-net-r">${sign}${Math.abs(net).toFixed(2)}<span class="lb-net-unit">R</span>`), 'ALL tab leads with signed net R, not gross');
    assert(html.includes('id="live-board-fees-line">') && html.includes('R gross · fees and slippage'), 'fees line sits under the net figure');
    for (const id of ['live-board-summary-stats', 'live-board-stat-record', 'live-board-stat-wallet', 'live-board-stat-progress', 'live-board-stat-active-flags']) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.indexOf('id="live-board-pnl-block"') < html.indexOf('id="live-board-radar-list"'), 'PnL summary sits above the flag radar');
    assert(html.includes('id="live-board-stat-active-flags"><dt>Active flags now</dt><dd>2</dd>'), 'active flag count skips failed flags');
    const noRows = renderHtml(computeAggregates([], [], {}, T0));
    assert(noRows.includes('id="live-board-net-r">0.00') && noRows.includes('[NO SCORED CALLS YET]'), 'empty store shows an empty PnL, never NaN');
    assert(noRows.includes('id="live-board-empty"') && noRows.includes('No live capture yet'), 'no capture rows shows an empty board, never NaN');
  });

  await test('live board: radar sorts break-out states first, symbol panel shows call, lean, odds, gate; failed flags stay off the radar', () => {
    const html = liveBoard(LIVE_ROWS, '2026-09-29T01:00:00.000Z');
    const radar = html.slice(html.indexOf('id="live-board-panel-all"'), html.indexOf('id="live-board-panel-eth"'));
    assert(radar.indexOf('BREAKING') < radar.indexOf('FORMING'), 'triggering (BREAKING) ranks above forming');
    assert(!radar.includes('FAILED'), 'failed flag is not on the radar');
    assert(html.includes('id="live-board-eth-price">2,679.28<') && html.includes('Pyth 2,678.09 · -4.4 bps'), 'price and Pyth mark with drift');
    assert(html.includes('>WATCH<') && html.includes('SHORT 1m FORMING') && html.includes('WAIT ~1m'), 'called direction, state and action with ETA');
    assert(html.includes('<i>15m</i>L') && html.includes('<i>1m</i>S'), 'timeframe lean cells parsed from the bias string');
    assert(html.includes('fail first 50%') && html.includes('n=121') && !html.includes('uncalibrated'), 'path odds legend, calibrated');
    assert(html.includes('Blocked</b> a 15m level blocks') && html.includes('Kill if</b>') && html.includes('Other side</b>'), 'gate, kill and other-side lines');
    assert(html.includes('Closed 00:57Z · 3m old at build'), 'as-of stamp states the age at build');
    assert(html.includes('id="live-board-btc-flags"') === false, 'symbol with no flags renders no empty flag list');
    assert(!/NaN|undefined|null/.test(html.replace(/dash/g, '')), 'no NaN/undefined/null leaks into the board');
  });

  await test('live board: parseBias handles missing and partial strings; latestCallPerSymbol keeps the newest row per symbol', () => {
    assert(JSON.stringify(parseBias(undefined)) === JSON.stringify({ tf: {}, scalp: null, swing: null }), 'non-string bias parses to empty');
    assert(parseBias('scalp:L1,S2,N3|tf:1m=L,5m=S').tf['5m'] === 'S' && parseBias('scalp:L1,S2,N3').scalp === 'L1,S2,N3', 'partial strings parse');
    const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
    mkdirSync(path.join(dir, 'calls'));
    writeFileSync(path.join(dir, 'calls', '2026-09-29.jsonl'), [
      { symbol: 'BTC', closedThrough: '2026-09-29T00:10:00.000Z', price: 1 },
      { symbol: 'BTC', closedThrough: '2026-09-29T00:20:00.000Z', price: 2 },
      { symbol: 'ETH', closedThrough: '2026-09-29T00:20:00.000Z', price: 3 }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const latest = latestCallPerSymbol(dir);
    assert(latest.length === 2 && latest.find((r) => r.symbol === 'BTC').price === 2, 'newest BTC row wins, one row per symbol');
    assert(latestCallPerSymbol(path.join(dir, 'missing')).length === 0, 'missing data dir returns no rows');
  });

  await test('home-hero: parseBiasString parses the full token set, tolerates missing tokens, and treats garbage as empty (T-23)', () => {
    const full = parseBiasString('scalp:L48,S8,N44|swing:L80,S0,N20|tf:1m=S,3m=N,5m=N,15m=L,1h=L,4h=L,1d=L|ct:2|td:bull:4/4|a200:4/7|mark:-4.4');
    assert(full.tf['1h'] === 'L' && full.tf['1m'] === 'S' && full.scalp === 'L48,S8,N44' && full.swing === 'L80,S0,N20', 'timeframe, scalp and swing tokens parse');
    assert(full.ct === 2 && JSON.stringify(full.td) === JSON.stringify({ sentiment: 'bull', n: 4, of: 4 }) && JSON.stringify(full.a200) === JSON.stringify({ n: 4, of: 7 }) && full.mark === -4.4, 'ct, td, a200 and mark tokens parse');

    const partial = parseBiasString('tf:1h=L');
    assert(partial.tf['1h'] === 'L' && partial.scalp === null && partial.td === null && partial.a200 === null && partial.ct === null && partial.mark === null, 'missing tokens parse to null, never throw');

    const EMPTY_BIAS = { tf: {}, scalp: null, swing: null, ct: null, td: null, a200: null, mark: null };
    assert(JSON.stringify(parseBiasString(undefined)) === JSON.stringify(EMPTY_BIAS), 'non-string bias parses to the empty shape');
    assert(JSON.stringify(parseBiasString('garbage;;;not a bias string')) === JSON.stringify(EMPTY_BIAS), 'a string with no key:value tokens parses to the same empty shape, never NaN/undefined');
  });

  await test('home-hero: buildHeadline names 1h+4h alignment, a triggering/confirmed candidate (never an unearned class), and falls back with no rows (T-23)', () => {
    const up = (s) => ({ symbol: s, bias: 'tf:1h=L,4h=L', flagRecommendation: { class: 'BAD' } });
    assert(buildHeadline(['BTC', 'ETH', 'SOL'].map(up)) === 'BTC, ETH and SOL: 1h and 4h trend up, no flag ready.', 'all three aligned up on 1h+4h, no flag ready');

    const mixed = [
      { symbol: 'BTC', bias: 'tf:4h=L' }, { symbol: 'ETH', bias: 'tf:4h=L' }, { symbol: 'SOL', bias: 'tf:4h=S' }
    ];
    assert(buildHeadline(mixed) === '2 of 3 coins trending up on 4h, no flag ready.', 'no 1h+4h alignment falls back to a 4h lean count');

    const withTriggering = ['BTC', 'SOL'].map(up).concat([{
      symbol: 'ETH', bias: 'tf:1h=L,4h=L',
      flagRecommendation: { class: 'WATCH', candidate: { timeframe: '1m', direction: 'short', state: 'triggering', breakout: 2677.48, invalidation: 2681.03, measuredRR: 4.6 } }
    }]);
    assert(buildHeadline(withTriggering) === 'BTC, ETH and SOL: 1h and 4h trend up · ETH 1m short flag triggering.', 'a triggering candidate is named once alignment is stated');

    const confirmed = JSON.parse(JSON.stringify(withTriggering));
    confirmed[2].flagRecommendation.candidate.state = 'confirmed';
    assert(buildHeadline(confirmed).includes('ETH 1m short flag breaking out.'), 'a confirmed candidate reads "breaking out"');

    const formingOnly = JSON.parse(JSON.stringify(withTriggering));
    formingOnly[2].flagRecommendation.candidate.state = 'forming';
    assert(buildHeadline(formingOnly) === 'BTC, ETH and SOL: 1h and 4h trend up, no flag ready.', 'a merely-forming candidate is not named (only triggering/confirmed)');

    const notWatch = JSON.parse(JSON.stringify(withTriggering));
    notWatch[2].flagRecommendation.class = 'BAD';
    assert(buildHeadline(notWatch) === 'BTC, ETH and SOL: 1h and 4h trend up, no flag ready.', 'never claims a candidate the row\'s own class does not show (BAD hides its candidate)');

    assert(buildHeadline([]) === 'Reading the market. No live capture yet.', 'no rows falls back cleanly');
    assert(buildHeadline(undefined) === 'Reading the market. No live capture yet.', 'undefined rows falls back the same way');
  });

  await test('home-hero: rightNowCards renders all three symbols with stable ids, tags a partial row without hiding it, truncates the reason, and never claims GOOD for a WATCH row (T-23)', () => {
    const NOW_ROWS = [
      { symbol: 'BTC', price: 83990, mark: { price: 83988.78, driftBps: -0.1, status: 'ok' }, dataStatus: 'complete',
        bias: 'tf:1m=L,3m=L,5m=L,15m=L,1h=L,4h=L,1d=L|a200:4/7|td:bull:4/4', flagRecommendation: { class: 'BAD', primaryReason: { text: 'rr_below_min' } } },
      { symbol: 'ETH', price: 2679.28, mark: { price: 2678.09, driftBps: -4.4, status: 'ok' }, dataStatus: 'complete',
        bias: 'tf:1m=S,3m=N,5m=N,15m=L,1h=L,4h=L,1d=L|a200:4/7|td:bull:4/4',
        flagRecommendation: {
          class: 'WATCH', action: { call: 'WAIT' }, primaryReason: { text: 'x'.repeat(160) },
          candidate: { timeframe: '1m', direction: 'short', state: 'forming', breakout: 2677.48, invalidation: 2681.03, measuredRR: 4.6 }
        } },
      { symbol: 'SOL', price: 210.5, mark: { price: 210.2, driftBps: 1.4, status: 'ok' }, dataStatus: 'partial', bias: 'tf:1h=N', flagRecommendation: { class: 'WATCH' } }
    ];
    const html = rightNowCards(NOW_ROWS);
    for (const id of [
      'home-hero-right-now', 'home-hero-now-btc', 'home-hero-now-eth', 'home-hero-now-sol',
      'home-hero-now-btc-trend', 'home-hero-now-eth-trend', 'home-hero-now-sol-trend',
      'home-hero-now-eth-stance', 'home-hero-now-eth-candidate', 'home-hero-now-eth-context'
    ]) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert(html.includes('83,988.78') && html.includes('Pyth mark') && html.includes('Kraken close') && html.includes('-0.1 bps'), 'price row shows Pyth mark, Kraken close and drift in bps');
    assert(html.includes('▲') && html.includes('▼'), 'trend strip shows long and short arrows from the bias tf tokens');
    assert(html.includes('id="home-hero-now-sol-data-tag">data: partial<'), 'a partial dataStatus shows a small grey tag, never hides the card');
    assert(!html.includes('id="home-hero-now-btc-data-tag"'), 'a complete/ok row carries no data tag');
    const eth = html.slice(html.indexOf('id="home-hero-now-eth"'), html.indexOf('id="home-hero-now-sol"'));
    assert(eth.includes('WATCH · WAIT') && !eth.includes('GOOD'), 'ETH stance shows its own class + action call, never claims GOOD for a WATCH row');
    assert(eth.includes('…') && !eth.includes('x'.repeat(160)), 'primaryReason.text is truncated around 140 chars, not shown verbatim in full');
    assert(eth.includes('1m short flag forming · break 2,677.48 · void 2,681.03 · 4.6R'), 'active candidate line reads timeframe, direction, state, break, void and measured R');
    assert(!/NaN|undefined/.test(html), 'no NaN/undefined leaks into the Right-now cards');
  });

  await test('page: window stat tables show a net-of-fees column beside gross expectancy (T5 S1)', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const agg = computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN, { phaseStartMs: T0 - 60 * MIN });
    const html = renderHtml(agg);
    assert((html.match(/Net exp\. \(net of fees\)/g) || []).length >= 2, 'net-of-fees column header appears across the window stat tables');
  });

  await test('page: populated render escapes values', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    out[0].symbol = '<b>BTC</b>';
    const html = renderHtml(computeAggregates(out, rows, candleSet, T0 + 2 * 60 * MIN));
    assert(!html.includes('<b>BTC</b>') && html.includes('&lt;b&gt;BTC&lt;/b&gt;'), 'escaped');
  });

  await test('charts: equity curve math, filters, open point, by-filter table', () => {
    const out = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const eq = equityRows(out);
    assertEqual(eq.length, 4, 'ready plans at tp1/stop/open (BTC, ETH, SOL ready, DOT); conditional + rejected + recs excluded');
    const kit = chartKit();
    const s = kit.equityStats(eq);
    assertEqual(s.n, 3, 'decided');
    assertEqual(s.open, 1, 'open');
    assertEqual(s.cum, 5, 'cum = 3 - 1 + 3');
    assertEqual(Math.round(s.winRate * 100), 67, 'win rate');
    assertEqual(s.maxLosingStreak, 1, 'streak');
    const svg = kit.equitySvg('eq', eq, 360, T0 + 2 * 60 * MIN, 'x');
    assert(svg.includes('class="pt-open"') && (svg.match(/class="pt"/g) || []).length === 3, 'three points + hollow open point');
    assert(!svg.includes('NaN'), 'no NaN');
    const eth = eq.filter((r) => r.f.symbol === 'ETH');
    assertEqual(kit.equityStats(eth).cum, -1, 'filtered to ETH');
    const table = kit.filterTableHtml(eq, { symbol: ['ETH', 'BTC'], dir: [] }, FILTER_DIMS);
    assert(table.includes('Selection') && table.includes('Symbol: ETH') && table.includes('Symbol: BTC'), 'selection rows');
    assert(filterValues(eq).symbol.join() === 'BTC,DOT,ETH,SOL', 'filter values');
    assertEqual(driftBucket(-7), '5–10', 'drift bucket');
    assertEqual(driftBucket(null), 'none', 'drift none');
    assertEqual(hourBucket('2026-09-20T13:59:00Z'), '12–15', 'hour bucket');
    assert(kit.equitySvg('eq', [], 360, T0, '[NO SCORED CALLS YET]').includes('[NO SCORED CALLS YET]'), 'empty');
  });

  await test('charts: wallet line with gaps, baseline, GOOD ticks, range; page renders the value', () => {
    const kit = chartKit();
    const w = (h, total, status = 'available') => ({ t: iso(T0 + h * 60 * MIN), status, marginUsd: total === null ? null : total - 10, holdingsUsd: total === null ? null : 10, totalUsd: total, baselineUsd: total === null ? null : 90, pnlUsd: total === null ? null : total - 100, pnlPct: null });
    const ws = [w(0, 100), w(1, 101), w(2, null, 'unavailable'), w(3, 104), w(4, 103)];
    const svg = kit.walletSvg('ws', ws, [iso(T0 + 60 * MIN)], 640, 'all', T0 + 4 * 60 * MIN, 'x');
    assertEqual((svg.match(/class="line-main"/g) || []).length, 1, 'one total path');
    assert(/class="line-main" d="M[^"]*M/.test(svg), 'gap splits the total path');
    assert(svg.includes('id="ws-baseline"'), 'baseline rule');
    assertEqual((svg.match(/class="good-tick"/g) || []).length, 1, 'GOOD tick');
    assert(!svg.includes('NaN'), 'no NaN');
    assert(kit.walletSvg('ws', ws, [], 640, '24h', T0 + 60 * 60 * MIN, 'x').includes('[NO WALLET SAMPLES IN RANGE]'), 'range filters samples');
    const agg = computeAggregates([], [], {}, T0 + 4 * 60 * MIN);
    const html = renderHtml(agg, { outcomes: [], wallet: ws });
    assert(/id="wallet-current-value">\$103\.00</.test(html), 'current value');
    assert(html.includes('class="wallet-value st-good"'), 'status color by sign of pnl');
    assert(html.includes('coincidence only'), 'coincidence caption');
  });

  // ---------------------------------------------------------------- journal (T2)

  const jrec = (id, kind, ms, over = {}) => ({
    id, schemaVersion: 'journal-1', receivedAt: iso(ms + 5000), saidAt: iso(ms), kind, symbol: 'BTC', direction: null,
    entry: null, stop: null, tp1: null, sizeUsd: null, leverage: null, exitPrice: null, resultR: null, resultUsd: null,
    engineRef: null, text: `${kind} ${id}`, ...over
  });

  await test('journal pull: manifest + day files via fetch (cache-busted), deduped by id, sensitive keys stripped', async () => {
    const dir = tmp();
    const base = 'https://store1.public.blob.vercel-storage.com';
    const files = {
      [`${base}/journal/manifest.json`]: JSON.stringify({ schemaVersion: 'journal-manifest-1', baseUrl: base, days: ['2026-09-20', '2026-09-21', 'bad'] }),
      [`${base}/journal/2026-09-20.jsonl`]: [JSON.stringify(jrec('j1', 'open', T0)), '{torn', JSON.stringify({ ...jrec('j2', 'note', T0 + MIN), walletAddress: 'SECRET_ADDR_J' })].join('\n'),
      [`${base}/journal/2026-09-21.jsonl`]: JSON.stringify(jrec('j3', 'close', T0 + 24 * 60 * MIN)) + '\n'
    };
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      const key = url.split('?')[0];
      return files[key] === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => files[key] };
    };
    const r1 = await pullJournal(dir, base, fakeFetch, 123);
    assertEqual(r1.added, 3, 'added');
    assertEqual(r1.days, 2, 'valid days only');
    assert(urls.every((u) => u.endsWith('?t=123')), 'cache-busted');
    const r2 = await pullJournal(dir, base, fakeFetch, 124);
    assertEqual(r2.added, 0, 'dedupe');
    assertEqual(r2.duplicates, 3, 'duplicates');
    assertEqual(readJournal(dir).map((r) => r.id).join(), 'j1,j2,j3', 'stored, oldest first');
    assert(existsSync(path.join(dir, 'journal', '2026-09-21.jsonl')), 'day file by receivedAt');
    assert(!allText(dir).includes('SECRET_ADDR_J'), 'sensitive key stripped');
    const none = await pullJournal(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assertEqual(none.added, 0, 'no manifest -> nothing');
    assertEqual(journalRecordsFromLines([{ id: 'x' }, null, [1]]).length, 0, 'records need id + receivedAt');
  });

  await test('journal base: explicit > JOURNAL_BLOB_BASE > store id from the token (token itself never used)', () => {
    assertEqual(blobBaseFromToken('vercel_blob_rw_AbCd123_secretpart'), 'https://abcd123.public.blob.vercel-storage.com', 'derived');
    assertEqual(blobBaseFromToken('nope'), null, 'bad token');
    assertEqual(resolveJournalBase({ 'journal-base': 'https://x.example/' }, {}), 'https://x.example', 'explicit');
    assertEqual(resolveJournalBase({}, { JOURNAL_BLOB_BASE: 'https://y.example' }), 'https://y.example', 'env');
    assert(!resolveJournalBase({}, { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_S1_secretpart' }).includes('secretpart'), 'no secret in URL');
    assertEqual(resolveJournalBase({}, {}), null, 'unset');
  });

  // BTC rises 1/min from 100: long 100/99/103 hits TP1 on the 3rd candle.
  const jCandles = { BTC: candles(T0, 200, (i) => ({ h: 100 + i + 0.5, l: 100 + i - 0.5 })) };
  const cid = 'BTC:1m:long:2026-09-19T23:40:00.000Z';
  const engineOutcomes = [
    { callId: 'rec|g1', kind: 'rec', class: 'GOOD', candidateId: cid, calledAt: iso(T0), outcome: 'tp1', r: 3, dims: { recClass: 'GOOD', recReason: 'ready_flag_plan', candidateTimeframe: '1m', topDown: 'supports' } },
    { callId: 'rec|g2', kind: 'rec', class: 'GOOD', candidateId: 'ETH:skip', calledAt: iso(T0), outcome: 'stop', r: -1, dims: { recClass: 'GOOD' } },
    { callId: 'rec|g3', kind: 'rec', class: 'GOOD', candidateId: 'SOL:quiet', calledAt: iso(T0), outcome: 'tp1', r: 2, dims: { recClass: 'GOOD' } }
  ];
  const journalSet = [
    jrec('o1', 'open', T0, { direction: 'long', entry: 100, stop: 99, tp1: 103, engineRef: { candidateId: cid, planId: 'p', recClass: 'GOOD', reasonCode: 'ready_flag_plan' } }),
    jrec('o2', 'open', T0 + 10 * MIN, { symbol: 'ETH', direction: 'short', entry: 50, stop: 51, tp1: 47, engineRef: { candidateId: 'ETH:watch', planId: null, recClass: 'WATCH', reasonCode: 'rr_below_min' } }),
    jrec('c2', 'close', T0 + 30 * MIN, { symbol: 'ETH', exitPrice: 49 }),
    jrec('o3', 'open', T0 + 40 * MIN, { symbol: 'SOL', direction: 'long' }),
    jrec('c3', 'close', T0 + 50 * MIN, { symbol: 'SOL', resultR: -0.5 }),
    jrec('s1', 'skip', T0 + 5 * MIN, { symbol: 'ETH', engineRef: { candidateId: 'ETH:skip', planId: null, recClass: 'GOOD', reasonCode: null } }),
    jrec('n1', 'note', T0 + 6 * MIN, { text: '<b>x</b>' })
  ];

  await test('journal score: open walked like a ready plan; close overrides with resultR or exitPrice; dims from the linked call', () => {
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    assertEqual(rows.length, 3, 'one row per open');
    const [a, b, c] = rows;
    assertEqual(a.outcome, 'tp1', 'walked to TP1');
    assertEqual(a.r, 3, 'R to TP1');
    assertEqual(a.mode, 'ready_prefilled', 'mode');
    assertEqual(a.dims.topDown, 'supports', 'dims copied from the linked engine call');
    assertEqual(a.linkedCallId, 'rec|g1', 'link');
    assertEqual(b.outcome, 'closed', 'ETH closed');
    assertEqual(b.r, 1, 'short R from exitPrice (50-49)/1');
    assertEqual(b.mode, 'reported_exit_price', 'mode');
    assertEqual(b.dims.recClass, 'WATCH', 'minimal dims from engineRef');
    assertEqual(c.outcome, 'closed', 'SOL closed without levels');
    assertEqual(c.r, -0.5, 'reported resultR');
    assertEqual(rFromExit('long', 100, 99, 101.5), 1.5, 'rFromExit long');
    const again = scoreJournal(journalSet, jCandles, engineOutcomes, rows, T0 + 4 * 60 * MIN);
    assertEqual(again[0].scoredAt, rows[0].scoredAt, 'scoredAt stable when unchanged');
    const noClose = scoreJournal([journalSet[3]], jCandles, [], [], T0);
    assertEqual(noClose[0].outcome, 'no_levels', 'no levels, no close');
  });

  await test('T6 completion plan C1/C3: equityStats computes netExpectancy (dir-cost) beside gross, shown in readoutHtml/filterTableHtml - "net and gross R labeled side by side"', () => {
    const kit = chartKit();
    // long tp1 r=3 (entry 100/stop 99, 34bps cost) + short stop r=-1 (entry 100/stop 101, 14bps cost).
    const rows = [
      { t: iso(T0), at: iso(T0 + MIN), o: 'tp1', r: 3, entry: 100, stop: 99, dir: 'long', f: {} },
      { t: iso(T0 + MIN), at: iso(T0 + 2 * MIN), o: 'stop', r: -1, entry: 100, stop: 101, dir: 'short', f: {} }
    ];
    const s = kit.equityStats(rows);
    assertEqual(s.expectancy, 1, 'gross expectancy (3 + -1) / 2');
    // long net: 3 - 0.34 = 2.66; short net: -1 - 0.14 = -1.14; avg = 0.76
    assertEqual(s.netExpectancy, 0.76, 'net expectancy at dir-cost (34bps long, 14bps short)');

    const readout = kit.readoutHtml(s);
    assert(readout.includes('id="equity-readout-net"'), 'readout carries a NET span beside EXP');
    assert(readout.includes('+0.76R'), 'net value rendered');

    const table = kit.filterTableHtml(rows, {}, FILTER_DIMS, [], []);
    assert(table.includes('Net exp. (dir-cost)'), 'filter table carries the net exp. column header');
    assert(table.includes('+0.76R'), 'filter table shows the same net value');
  });

  await test('T6 completion plan C2: setupEquityRows filters to kind:setup tp1/stop/open only, filterable and shown in the equity filter table (not the drawn line)', () => {
    const scored = [
      { kind: 'setup', outcome: 'tp1', r: 2.5, calledAt: iso(T0), resolvedAt: iso(T0 + 10 * MIN), dims: { candidateDirection: 'long' }, symbol: 'BTC', direction: 'long' },
      { kind: 'setup', outcome: 'stop', r: null, calledAt: iso(T0 + MIN), resolvedAt: iso(T0 + 5 * MIN), dims: { candidateDirection: 'short' }, symbol: 'ETH', direction: 'short' },
      { kind: 'setup', outcome: 'not_filled', r: null, calledAt: iso(T0 + 2 * MIN), dims: {}, symbol: 'SOL', direction: 'long' }, // excluded - never triggered
      { kind: 'plan', outcome: 'tp1', r: 3, calledAt: iso(T0), symbol: 'BTC' } // different kind - excluded
    ];
    const setupRows = setupEquityRows(scored);
    assertEqual(setupRows.length, 2, 'tp1 and stop only - not_filled and the plan-kind row excluded');
    assertEqual(setupRows.map((r) => r.o).join(), 'tp1,stop', 'outcomes, oldest first');
    assertEqual(setupRows[0].r, 2.5, 'tp1 r carried');
    assertEqual(setupRows[1].r, -1, 'stop is -1R');

    const kit = chartKit();
    const table = kit.filterTableHtml([], {}, FILTER_DIMS, [], setupRows);
    assert(table.includes('SETUPs, what-if'), 'filter table carries a SETUPs row when setup rows exist');
    assert(!kit.filterTableHtml([], {}, FILTER_DIMS, [], []).includes('SETUPs, what-if'), 'no row at all when there are no setup rows');
  });

  await test('journal chart rows, wallet marks (up/down, colored by R), your-trades line, Engine vs you', () => {
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    const you = journalEquityRows(rows);
    assertEqual(you.length, 3, 'three scored trades');
    assertEqual(you.map((r) => r.o).join(), 'tp1,closed,closed', 'outcomes');
    assertEqual(you[0].f.class, 'GOOD', 'filter dims');
    const kit = chartKit();
    const st = kit.equityStats(you);
    assertEqual(st.cum, 3.5, 'cum 3 + 1 - 0.5');
    assertEqual(st.wins, 2, 'wins = R > 0');
    const eq = [{ t: iso(T0), at: iso(T0 + MIN), o: 'tp1', r: 2, f: you[0].f }];
    const svg = kit.equitySvg('eq', eq, 640, T0 + 60 * MIN, 'x', you);
    assert(svg.includes('id="eq-you-line"') && svg.includes('class="line-main'), 'both lines');
    assert(!svg.includes('NaN'), 'no NaN');
    assert(kit.equitySvg('eq', [], 640, T0, 'x', you).includes('eq-you-line'), 'your line alone still draws');
    assert(kit.filterTableHtml(eq, {}, FILTER_DIMS, you).includes('Your trades'), 'filter table row');
    const marks = walletMarks(journalSet, rows);
    assertEqual(marks.map((m) => m.k).join(), 'open,open,close,open,close', 'opens and closes only');
    assertEqual(marks[0].r, 3, 'open colored by its trade R');
    assertEqual(marks[4].r, -0.5, 'close colored by reported R');
    const w = (h, total) => ({ t: iso(T0 + h * 60 * MIN), status: 'available', marginUsd: total, holdingsUsd: 0, totalUsd: total, baselineUsd: null, pnlUsd: null, pnlPct: null });
    const wsvg = kit.walletSvg('ws', [w(0, 100), w(1, 101)], [], 640, 'all', T0 + 60 * MIN, 'x', marks);
    assert(/class="j-tick j-open pos"/.test(wsvg), 'open tick up, green');
    assert(/class="j-tick j-close neg"/.test(wsvg), 'close tick down, red');
    const ev = engineVsYou(engineOutcomes, journalSet, rows);
    assertEqual(ev.goodCalls, 3, 'GOOD calls');
    assertEqual(ev.goodTaken, 1, 'taken');
    assertEqual(ev.goodSkipped, 1, 'skipped');
    assertEqual(ev.goodNotLogged, 1, 'not logged');
    assertEqual(ev.overrides.length, 1, 'WATCH taken');
    assertEqual(ev.skippedEngineStats.cum, -1, "skipped GOOD: the engine's own result");
    assertEqual(ev.unlinked, 1, 'SOL open had no engine link');
  });

  await test('page: journal sections render populated and empty (bracketed empty states), text escaped', () => {
    const agg = computeAggregates([], [], {}, T0 + 3 * 60 * MIN);
    const empty = renderHtml(agg, { outcomes: [], wallet: [] });
    assert(empty.includes('id="engine-vs-you-section"') && empty.includes('id="journal-log-section"'), 'sections');
    assert(empty.includes('id="engine-vs-you-empty">[NO JOURNAL RECORDS YET]'), 'engine vs you empty');
    assert(empty.includes('id="journal-log-table-empty">[NO JOURNAL RECORDS YET]'), 'log empty');
    assert(empty.includes('YOUR TRADES [NO JOURNAL TRADES YET]'), 'your-trades readout empty');
    const rows = scoreJournal(journalSet, jCandles, engineOutcomes, [], T0 + 3 * 60 * MIN);
    const html = renderHtml(agg, { outcomes: engineOutcomes, wallet: [], journal: journalSet, journalOutcomes: rows });
    assert(html.includes('id="journal-log-table"') && html.includes('id="engine-vs-you-overrides-table"'), 'tables');
    assert(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'), 'journal text escaped');
    assert(html.includes('"you":[{'), 'your-trades rows in the page data');
    assert(html.includes('"marks":[{'), 'marks in the page data');
    assertEqual((html.match(/class="prov-tag">PROVISIONAL</g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section');
  });

  await test('scoreJournalDataDir + buildPage end to end from the store', () => {
    const dir = tmp();
    appendJournal(dir, journalSet);
    const rows = scoreJournalDataDir(dir, T0 + 3 * 60 * MIN);
    assertEqual(rows.length, 3, 'scored');
    assertEqual(readJsonl(journalOutcomesFile(dir)).length, 3, 'written');
    const out = path.join(dir, 'site');
    buildPage(dir, out, T0 + 3 * 60 * MIN);
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert(html.includes('id="journal-log-table"'), 'journal log on the built page');
  });

  console.log('\nT-9 v2 P5: wallet strategy profile curves + strategies.html');

  const isoAt = (mins) => new Date(T0 + mins * MIN).toISOString();

  await test('computeProfileCurves: live curve sized off execRef.profiles.riskUsd stamped at open, real curve off resultUsd', () => {
    const journalRecords = [
      { id: 'o1', kind: 'open', source: 'execution', symbol: 'BTC', receivedAt: isoAt(0), execRef: { profiles: { steady: { tier: 'B', riskUsd: 5, ok: true, reasons: [] }, aggressive: { tier: 'B', riskUsd: 10, ok: true, reasons: [] } } } },
      { id: 'c1', kind: 'close', source: 'execution', resultUsd: 12, receivedAt: isoAt(120) },
      { id: 'o2', kind: 'open', source: 'telegram', symbol: 'ETH', receivedAt: isoAt(5) } // non-execution open, never counted
    ];
    const journalOutcomes = [{ journalId: 'o1', outcome: 'closed', r: 2, calledAt: isoAt(0) }];
    const out = computeProfileCurves({ journalRecords, journalOutcomes, callOutcomes: [] });
    assertEqual(out.startEquityUsd, BOT_WALLET_START_EQUITY_USD);
    assertEqual(out.real.points.length, 2, 'start + one execution close');
    assertEqual(out.real.points[1].equityUsd, BOT_WALLET_START_EQUITY_USD + 12, 'real: start + resultUsd');
    assertEqual(out.profiles.steady.live.trades, 1);
    assertEqual(out.profiles.steady.live.points[1].equityUsd, BOT_WALLET_START_EQUITY_USD + 5 * 2, 'steady: riskUsd(5) x r(2)');
    assertEqual(out.profiles.aggressive.live.points[1].equityUsd, BOT_WALLET_START_EQUITY_USD + 10 * 2, 'aggressive: riskUsd(10) x r(2)');
    assertEqual(out.profiles.steady.live.expectancyR, 2);
  });

  await test('computeProfileCurves: a closed trade with no execRef.profiles (e.g. manual /order) is skipped from the live curve, not crashed on', () => {
    const journalRecords = [
      { id: 'o1', kind: 'open', source: 'execution', symbol: 'BTC', receivedAt: isoAt(0) }, // no execRef at all
      { id: 'c1', kind: 'close', source: 'execution', resultUsd: 3, receivedAt: isoAt(60) }
    ];
    const journalOutcomes = [{ journalId: 'o1', outcome: 'closed', r: 1, calledAt: isoAt(0) }];
    const out = computeProfileCurves({ journalRecords, journalOutcomes, callOutcomes: [] });
    assertEqual(out.profiles.steady.live.trades, 0, 'no profiles stamp -> not counted');
    assertEqual(out.profiles.steady.live.points.length, 1, 'curve stays flat at the start');
    assertEqual(out.real.points[1].equityUsd, BOT_WALLET_START_EQUITY_USD + 3, 'real curve is unaffected (resultUsd only)');
  });

  await test('computeProfileCurves: as-if curve sizes every scored GOOD call at tier B, whether or not it was ever taken', () => {
    const callOutcomes = [
      { class: 'GOOD', outcome: 'tp1', r: 2, calledAt: isoAt(0) },
      { class: 'GOOD', outcome: 'stop', r: -1, calledAt: isoAt(60) },
      { class: 'WATCH', outcome: 'tp1', r: 5, calledAt: isoAt(30) } // not GOOD -> excluded
    ];
    const out = computeProfileCurves({ journalRecords: [], journalOutcomes: [], callOutcomes });
    assertEqual(out.profiles.steady.asIf.trades, 2, 'only the two GOOD calls');
    assertEqual(out.profiles.steady.asIf.expectancyR, 0.5, '(2 + -1) / 2');
    assert(out.profiles.aggressive.asIf.points.at(-1).equityUsd !== out.profiles.steady.asIf.points.at(-1).equityUsd, 'aggressive and steady size differently');
  });

  await test('computeProfileCurves: empty inputs never throw, curves start flat at BOT_WALLET_START_EQUITY_USD', () => {
    const out = computeProfileCurves();
    assertEqual(out.startEquityUsd, BOT_WALLET_START_EQUITY_USD);
    assertEqual(out.real.points.length, 1);
    for (const key of ['steady', 'aggressive']) {
      assertEqual(out.profiles[key].live.trades, 0);
      assertEqual(out.profiles[key].asIf.trades, 0);
      assertEqual(out.profiles[key].live.points[0].equityUsd, BOT_WALLET_START_EQUITY_USD);
    }
  });

  await test('computeProfileCurvesDataDir reads the same store buildPage does', async () => {
    const dir = tmp();
    appendJournal(dir, [
      { id: 'o1', schemaVersion: 'journal-1', receivedAt: isoAt(0), kind: 'open', symbol: 'BTC', source: 'execution', execRef: { profiles: { steady: { tier: 'B', riskUsd: 5, ok: true, reasons: [] }, aggressive: { tier: 'B', riskUsd: 10, ok: true, reasons: [] } } } },
      { id: 'c1', schemaVersion: 'journal-1', receivedAt: isoAt(60), kind: 'close', symbol: 'BTC', source: 'execution', resultUsd: 10 }
    ]);
    writeJsonl(journalOutcomesFile(dir), [{ journalId: 'o1', outcome: 'closed', r: 2, calledAt: isoAt(0) }]);
    const out = await computeProfileCurvesDataDir(dir);
    assertEqual(out.profiles.steady.live.trades, 1);
    assertEqual(out.real.points[1].equityUsd, BOT_WALLET_START_EQUITY_USD + 10);
  });

  await test('renderStrategies: no data -> zero-state text, not a crash; the profile table, live badge and evaluation rule always render', () => {
    const empty = renderStrategies(null, null);
    assert(empty.includes('<!doctype html>') && empty.includes('id="strategies-page-title"'), 'page shell');
    assert(empty.includes('id="strategies-profile-table"') && empty.includes('>Steady<') && empty.includes('>Aggressive<'), 'profile table');
    assert(empty.includes('strategies-curve-empty'), 'zero-state chart text');
    assert(empty.includes('id="strategies-live-profile-name">Steady<'), 'defaults to steady with no liveProfileKey');
    assert(empty.includes('id="strategies-evaluation-text"') && empty.includes('40% wins'), 'evaluation rule');
  });

  await test('renderStrategies: with curve data, shows the live profile, curve legend and trade counts', () => {
    const data = computeProfileCurves({
      journalRecords: [
        { id: 'o1', kind: 'open', source: 'execution', symbol: 'BTC', receivedAt: isoAt(0), execRef: { profiles: { steady: { tier: 'B', riskUsd: 5, ok: true, reasons: [] }, aggressive: { tier: 'B', riskUsd: 10, ok: true, reasons: [] } } } },
        { id: 'c1', kind: 'close', source: 'execution', resultUsd: 10, receivedAt: isoAt(60) }
      ],
      journalOutcomes: [{ journalId: 'o1', outcome: 'closed', r: 2, calledAt: isoAt(0) }],
      callOutcomes: []
    });
    const html = renderStrategies(data, 'aggressive');
    assert(html.includes('id="strategies-live-profile-name">Aggressive<'), 'live badge shows the active profile');
    assert(html.includes('strategies-curve-legend') && !html.includes('strategies-curve-empty'), 'chart rendered, not the zero state');
    assert(html.includes('1 / 30'), 'trade count toward the 30-trade evaluation');
  });

  await test('buildPage writes strategies.html alongside index.html, risk.html and how-to.html, linked from all three', () => {
    const dir = tmp();
    appendJournal(dir, [
      { id: 'o1', schemaVersion: 'journal-1', receivedAt: isoAt(0), kind: 'open', symbol: 'BTC', source: 'execution', execRef: { profiles: { steady: { tier: 'B', riskUsd: 5, ok: true, reasons: [] }, aggressive: { tier: 'B', riskUsd: 10, ok: true, reasons: [] } } } },
      { id: 'c1', schemaVersion: 'journal-1', receivedAt: isoAt(60), kind: 'close', symbol: 'BTC', source: 'execution', resultUsd: 10 }
    ]);
    writeJsonl(journalOutcomesFile(dir), [{ journalId: 'o1', outcome: 'closed', r: 2, calledAt: isoAt(0) }]);
    writeJson(telegramStatusFile(dir), { cronLastRunAt: null, alertsDay: null, alertsToday: 0, lastAlert: null, riskProfile: 'aggressive' });
    const out = path.join(dir, 'site');
    const { strategiesFile } = buildPage(dir, out, T0 + 3 * 60 * MIN);
    assertEqual(strategiesFile, path.join(out, 'strategies.html'), 'buildPage reports the strategies file path');
    const strategies = readFileSync(strategiesFile, 'utf8');
    assert(strategies.includes('id="strategies-live-profile-name">Aggressive<'), 'telegram-status riskProfile flows through to strategies.html');
    const index = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert(index.includes('id="wallet-strategies-tile"') && index.includes('href="strategies.html"'), 'index.html teaser + link');
    assert(index.includes('id="wallet-strategies-live-name">Aggressive<'), 'index teaser also reflects the live profile');
    const howTo = readFileSync(path.join(out, 'how-to.html'), 'utf8');
    assert(howTo.includes('href="strategies.html"') && howTo.includes('/risk profile'), 'how-to.html links to strategies.html and documents the switch');
    assert(/<a href="spot.html"[^>]*id="strategies-nav-spot-trend-link"/.test(strategies), 'strategies links to spot trend');
  });

  // ------------------------------------------------ rec calls scored on candidate levels
  const cand = (over = {}) => ({ candidateId: 'C', timeframe: '5m', direction: 'long', state: 'forming', breakout: 100, invalidation: 99, measuredRR: 2, ...over });
  const candRec = (klass, over = {}) => rec(klass, { candidateId: null, readiness: 'no_plan', candidate: cand(over) });
  const candCandles = {
    LNG: candles(T0, 40, (i) => (i < 3 ? { h: 99.8, l: 99.5 } : i === 3 ? { h: 100.2, l: 99.9 } : i === 10 ? { h: 102.5, l: 101 } : { h: 100.5, l: 99.6 })),
    SHT: candles(T0, 40, (i) => (i < 2 ? { h: 99.8, l: 99.5 } : i === 2 ? { h: 100.2, l: 99.8 } : i === 8 ? { h: 101.5, l: 100.5 } : { h: 100.4, l: 99.5 })),
    NOF: candles(T0, 40, () => ({ h: 99.6, l: 99.2 }))
  };
  const candRows = [
    captureRow('LNG', T0, null, candRec('WATCH')),
    captureRow('SHT', T0, null, candRec('BAD', { direction: 'short', invalidation: 101 })),
    captureRow('NOF', T0, null, candRec('WATCH'))
  ];

  await test('candidateLevels: long/short mirrored, measuredTarget preferred, bad geometry or no RR -> null', () => {
    assertEqual(JSON.stringify(candidateLevels(candRec('WATCH'))), '{"direction":"long","entry":100,"stop":99,"tp1":102}', 'long from measuredRR');
    assertEqual(JSON.stringify(candidateLevels(candRec('WATCH', { direction: 'short', invalidation: 101 }))), '{"direction":"short","entry":100,"stop":101,"tp1":98}', 'short mirrored');
    assertEqual(candidateLevels(candRec('WATCH', { measuredTarget: 105 })).tp1, 105, 'measuredTarget preferred');
    assertEqual(candidateLevels(candRec('WATCH', { invalidation: 101 })), null, 'long with stop above entry');
    assertEqual(candidateLevels(candRec('WATCH', { measuredTarget: 99.5 })), null, 'long target below entry');
    assertEqual(candidateLevels(candRec('WATCH', { measuredRR: null })), null, 'no measuredRR');
    assertEqual(candidateLevels(candRec('WATCH', { measuredRR: 0 })), null, 'measuredRR 0');
    assertEqual(candidateLevels(rec('WATCH')), null, 'no candidate');
  });

  await test('scorer: rec with no plan but a candidate walks candidate levels (tp1 long, stop short, not_filled)', () => {
    const out = scoreCalls(extractCalls(candRows), candCandles, [], T0 + 2 * 60 * MIN);
    const get = (s) => out.find((r) => r.symbol === s);
    const lng = get('LNG');
    assertEqual(lng.outcome, 'tp1', 'long tp1');
    assertEqual(lng.r, 2, 'R = measuredRR');
    assertEqual(lng.filledAt, iso(T0 + 3 * MIN), 'touch fill');
    assertEqual(lng.levelSource, 'candidate', 'levelSource');
    assertEqual(lng.mode, 'counterfactual_candidate', 'mode');
    assertEqual(lng.kind, 'rec', 'stays a rec row');
    assertEqual(lng.timeframe, '5m', 'candidate timeframe');
    const sht = get('SHT');
    assertEqual(sht.outcome, 'stop', 'short stop');
    assertEqual(sht.r, -1, '-1R');
    assertEqual(sht.levelSource, 'candidate', 'short levelSource');
    assertEqual(get('NOF').outcome, 'not_filled', 'entry never touched in 15 candles');
    assertEqual(get('NOF').mode, 'counterfactual_candidate', 'not_filled mode');
    const base = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    assertEqual(base.find((r) => r.symbol === 'ADA' && r.kind === 'rec').levelSource, null, 'no levels -> null');
    assertEqual(base.find((r) => r.symbol === 'XRP' && r.kind === 'rec').levelSource, 'plan', 'plan levels -> plan');
    assert(base.filter((r) => r.kind === 'plan').every((r) => r.levelSource === 'plan'), 'plan rows -> plan');
  });

  await test('scorer: old no_levels rec row re-scored on candidate levels; other final rows untouched', () => {
    const calls = extractCalls([...candRows, captureRow('BTC', T0, plan(), rec('GOOD'))]);
    const strip = ({ levelSource, ...rest }) => rest;
    const fresh = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, [], T0 + 2 * 60 * MIN);
    const prev = fresh.map((r) => (r.symbol === 'LNG'
      ? { ...strip(r), outcome: 'no_levels', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null, mode: 'not_walked', scoredAt: 'OLD' }
      : r.symbol === 'BTC' ? { ...strip(r), outcome: 'stop', r: -1, scoredAt: 'OLD' } : r));
    const again = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, prev, T0 + 3 * 60 * MIN);
    const lng = again.find((r) => r.symbol === 'LNG');
    assertEqual(lng.outcome, 'tp1', 're-scored');
    assertEqual(lng.levelSource, 'candidate', 'levelSource set');
    assertEqual(lng.scoredAt, iso(T0 + 3 * 60 * MIN), 'scoredAt moved');
    const btc = again.filter((r) => r.symbol === 'BTC');
    assert(btc.every((r) => r.outcome === 'stop' && r.scoredAt === 'OLD'), 'other final rows kept as written');
    assert(btc.every((r) => r.levelSource === 'plan'), 'levelSource backfilled on kept rows');
    const third = scoreCalls(calls, { ...candCandles, BTC: candleSet.BTC }, again, T0 + 4 * 60 * MIN);
    assertEqual(JSON.stringify(third), JSON.stringify(again), 'stable after the one re-score');
  });

  await test('aggregate: candidate rows never move tradable, phase or 7d tiles', () => {
    const base = scoreCalls(extractCalls(rows), candleSet, [], T0 + 2 * 60 * MIN);
    const extra = scoreCalls(extractCalls(candRows), candCandles, [], T0 + 2 * 60 * MIN);
    const opts = { phaseStartMs: T0 - 60 * MIN };
    const a = computeAggregates(base, rows, candleSet, T0 + 2 * 60 * MIN, opts);
    const b = computeAggregates([...base, ...extra], rows, candleSet, T0 + 2 * 60 * MIN, opts);
    assertEqual(JSON.stringify(b.phase), JSON.stringify(a.phase), 'phase');
    assertEqual(JSON.stringify(b.windows['7d'].tradable), JSON.stringify(a.windows['7d'].tradable), '7d tradable');
    assertEqual(JSON.stringify(b.totals.tradable), JSON.stringify(a.totals.tradable), 'totals tradable');
    for (const k of ['fills7d', 'winRate7d', 'expectancy7d', 'losingStreak7d']) assertEqual(b.tiles[k], a.tiles[k], k);
    assert(b.classCheck.rows.find((r) => r.key === 'WATCH').fromCandidate === 1, 'candidate rows land in classCheck');
  });

  await test('aggregate: classCheck shape and numbers', () => {
    const r = (klass, outcome, rv, levelSource, at = T0) => ({ kind: 'rec', class: klass, outcome, r: rv, levelSource, calledAt: iso(at), resolvedAt: iso(at), filledAt: rv === null ? null : iso(at) });
    const out = [
      r('BAD', 'stop', -1, 'candidate'), r('BAD', 'stop', -1, 'plan'), r('BAD', 'tp1', 2, 'candidate'), r('BAD', 'no_levels', null, null),
      r('BAD', 'not_filled', null, 'candidate'), r('BAD', 'expired', null, 'candidate'), r('BAD', 'open', null, 'candidate'), r('BAD', 'pending', null, 'plan'),
      r('WATCH', 'tp1', 3, 'candidate'), r('WATCH', 'stop', -1, 'candidate', T0 - 2 * 60 * MIN),
      { kind: 'plan', planStatus: 'ready', outcome: 'tp1', r: 3, levelSource: 'plan', calledAt: iso(T0) }
    ];
    const cc = classCheck(out);
    assertEqual(cc.since, null, 'no phase -> null');
    assertEqual(cc.rows.map((x) => x.key).join(','), 'GOOD,WATCH,BAD', 'GOOD/WATCH/BAD always, no DATA_UNAVAILABLE');
    const good = cc.rows[0];
    assertEqual(good.calls, 0, 'GOOD zero');
    assertEqual(good.winRate, null, 'GOOD winRate null');
    assertEqual(good.expectancy, null, 'GOOD expectancy null');
    const bad = cc.rows[2];
    assertEqual(JSON.stringify([bad.calls, bad.scored, bad.wins, bad.losses, bad.open, bad.notFilled, bad.noLevels, bad.fromPlan, bad.fromCandidate]),
      '[8,3,1,2,2,2,1,1,2]', 'BAD counts');
    assertEqual(bad.winRate, 0.3333, 'BAD win rate 1/3');
    assertEqual(bad.expectancy, 0, 'BAD expectancy (2-1-1)/3');
    assertEqual(cc.rows[1].scored, 2, 'WATCH all time');
    const since = classCheck([...out, r('DATA_UNAVAILABLE', 'no_levels', null, null)], T0 - 60 * MIN);
    assertEqual(since.since, iso(T0 - 60 * MIN), 'since ISO');
    assertEqual(since.rows[1].scored, 1, 'WATCH before phase excluded');
    assertEqual(since.rows[3].key, 'DATA_UNAVAILABLE', 'DATA_UNAVAILABLE when present');
    assertEqual(JSON.stringify(Object.keys(since.rows[0])),
      JSON.stringify(['key', 'calls', 'scored', 'wins', 'losses', 'open', 'notFilled', 'noLevels', 'winRate', 'expectancy', 'fromPlan', 'fromCandidate',
        'oneMinLogCalls', 'capturedCalls', 'medianGoodWindowMin']), 'row keys (T-12 GOOD-row columns included)');
    assert(since.rows[1].oneMinLogCalls === undefined, 'non-GOOD rows carry no T-12 columns');
    assertEqual(JSON.stringify([since.rows[0].oneMinLogCalls, since.rows[0].capturedCalls, since.rows[0].medianGoodWindowMin]), '[0,0,null]',
      'no goodCallOutcomes supplied -> falls back to capture-only recs, T-12 columns read zero/null');
    assert(computeAggregates([], [], {}, T0).classCheck.rows.length === 3, 'computeAggregates carries classCheck');
  });

  // ---- served calls (T3)
  const servedRow = (row, servedMs) => ({ ...row, capturedAt: iso(servedMs), source: 'served', servedAt: iso(servedMs) });

  await test('served pull: manifest + day files, source served, cron close dropped, class change kept, deduped, stripped', async () => {
    const dir = tmp();
    const base = 'https://store1.public.blob.vercel-storage.com';
    appendCalls(dir, [captureRow('BTC', T0, plan(), rec('GOOD'))]); // cron already has BTC @ T0
    const day1 = [
      servedRow(captureRow('BTC', T0, plan(), rec('GOOD')), T0 + 20_000), // cron duplicate -> dropped
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 30_000),
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('GOOD', { candidateId: null })), T0 + 15 * MIN + 40_000), // class differs -> kept
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 50_000), // same key -> dropped
      { ...servedRow(captureRow('SOL', T0 + 16 * MIN, null, rec('BAD', { candidateId: null, walletAddress: 'SECRET_ADDR_S' })), T0 + 16 * MIN), account: { address: 'SECRET_ADDR_T' } },
      servedRow(captureRow('SOL', T0 + 17 * MIN, null, null), T0 + 17 * MIN) // no recommendation -> skipped
    ];
    const files = {
      [`${base}/served/manifest.json`]: JSON.stringify({ schemaVersion: 'served-manifest-1', baseUrl: base, days: ['2026-09-20', 'bad'] }),
      [`${base}/served/2026-09-20.jsonl`]: [...day1.map((r) => JSON.stringify(r)), '{torn'].join('\n')
    };
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      const key = url.split('?')[0];
      return files[key] === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => files[key] };
    };
    const r1 = await pullServed(dir, base, fakeFetch, 123);
    assertEqual(r1.days, 1, 'valid days only');
    assertEqual(r1.added, 3, 'added ETH WATCH, ETH GOOD, SOL BAD');
    assertEqual(r1.duplicates, 2, 'cron close + same served key');
    assert(urls.every((u) => u.endsWith('?t=123')), 'cache-busted');
    const all = readAllCalls(dir);
    assertEqual(all.filter((r) => r.source === 'served').length, 3, 'served rows');
    assertEqual(all.filter((r) => r.source === 'cron').length, 1, 'old cron row reads as cron');
    assert(!allText(dir).includes('SECRET_ADDR'), 'sensitive keys stripped');
    const r2 = await pullServed(dir, base, fakeFetch, 124);
    assertEqual(r2.added, 0, 'second pull adds nothing');
    assertEqual(servedKey(day1[1]), `ETH|${iso(T0 + 15 * MIN)}|WATCH|-`, 'served key');
    assertEqual(servedRowsFromLines([{ symbol: 'BTC' }, null, [1], { symbol: 'X', closedThrough: iso(T0) }]).length, 0, 'rows need symbol, close, recommendation');
    const none = await pullServed(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assertEqual(none.added, 0, 'no manifest -> nothing');
  });

  await test('served pull: only days from the newest stored served day minus one are fetched', async () => {
    const dir = tmp();
    const base = 'https://store2.public.blob.vercel-storage.com';
    const day = (d) => `2026-09-${d}`;
    const files = { [`${base}/served/manifest.json`]: JSON.stringify({ baseUrl: base, days: [day(18), day(19), day(20), day(21)] }) };
    for (const d of [18, 19, 20, 21]) {
      const ms = Date.parse(`${day(d)}T12:00:00.000Z`);
      files[`${base}/served/${day(d)}.jsonl`] = JSON.stringify(servedRow(captureRow('BTC', ms, null, rec('WATCH', { candidateId: null })), ms + 1000)) + '\n';
    }
    const urls = [];
    const fakeFetch = async (url) => { urls.push(url.split('?')[0]); const t = files[url.split('?')[0]]; return t === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => t }; };
    assertEqual((await pullServed(dir, base, fakeFetch, 1)).days, 4, 'first pull reads every day');
    urls.length = 0;
    assertEqual((await pullServed(dir, base, fakeFetch, 2)).days, 2, 'then newest stored day minus one');
    assert(!urls.some((u) => u.includes(day(18)) || u.includes(day(19))), 'older days skipped');
  });

  await test('served GOOD call on a ready plan scores ready_prefilled exactly like cron; dims.source split', () => {
    const cronRows = [captureRow('BTC', T0, plan(), rec('GOOD'))];
    const servedRows = [servedRow(captureRow('BTC', T0, plan(), rec('GOOD')), T0 + 30_000)];
    const strip = (r) => { const { dims, capturedAt, ...rest } = r; const { source, ...d } = dims; return JSON.stringify({ ...rest, d }); };
    const a = scoreCalls(extractCalls(cronRows), candleSet, [], T0 + 2 * 60 * MIN);
    const b = scoreCalls(extractCalls(servedRows), candleSet, [], T0 + 2 * 60 * MIN);
    const goodA = a.find((r) => r.kind === 'rec');
    const goodB = b.find((r) => r.kind === 'rec');
    assertEqual(goodB.mode, 'ready_prefilled', 'mode');
    assertEqual(goodB.outcome, 'tp1', 'outcome');
    assertEqual(goodA.dims.source, 'cron', 'cron source');
    assertEqual(goodB.dims.source, 'served', 'served source');
    assertEqual(callDims({}).source, 'cron', 'rows without source read as cron');
    assertEqual(a.length, b.length, 'same calls');
    for (let i = 0; i < a.length; i++) assertEqual(strip(b[i]), strip(a[i]), `call ${i} identical apart from source`);
    assertEqual(callVia(goodB), 'chat', 'via chat');
    assertEqual(callVia({ dims: {} }), 'cron', 'via cron default');
    assert(FILTER_DIMS.some(([k]) => k === 'via'), 'via filter dim');
    assertEqual(equityRows(b).find(() => true).f.via, 'chat', 'equity row carries via');
  });

  await test('aggregate: served rows counted in activity, never as runs, last capture or capture health', () => {
    const nowMs = T0 + 60 * MIN;
    const capture = [
      captureRow('BTC', T0, plan(), rec('WATCH')),
      servedRow(captureRow('BTC', T0 + 15 * MIN, plan(), rec('GOOD')), T0 + 15 * MIN + 10_000),
      servedRow(captureRow('ETH', T0 + 15 * MIN, null, rec('WATCH', { candidateId: null })), T0 + 15 * MIN + 10_000),
      servedRow(captureRow('ETH', T0 - 30 * 60 * MIN, null, rec('GOOD', { candidateId: null })), T0 - 30 * 60 * MIN) // older than 24 h
    ];
    const out = scoreCalls(extractCalls(capture), candleSet, [], nowMs);
    const agg = computeAggregates(out, capture, {}, nowMs);
    assertEqual(agg.activity.served24h, 2, 'served 24h');
    assertEqual(agg.activity.servedGood24h, 1, 'served GOOD 24h');
    assertEqual(agg.activity.runs, 1, 'runs = cron capture minutes only');
    assertEqual(agg.tiles.lastCapture, iso(T0 + 2000), 'last capture from cron');
    assertEqual(agg.captures.captures, 1, 'capture health counts cron rows');
    const html = renderHtml(agg, { outcomes: out });
    assert(html.includes('id="activity-served-row"'), 'served activity row');
    assert(/id="activity-served-row"><dt>Seen in chat · 24 h<\/dt><dd[^>]*>2 <span class="st-good">\(1 GOOD\)<\/span>/.test(html), 'served count and GOOD count');
    assert(/<th>Via<\/th>/.test(html), 'Via column');
    assert(/<td[^>]*>chat<\/td><\/tr>/.test(html), 'served call shows chat');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'exactly one executable inline script');
    assert(!/gradient|box-shadow|drop-shadow/i.test(html), 'no gradients or shadows');
  });

  await test('aggregate: net-R stats (T5 S1) are additive only - outcomes.jsonl on disk stays byte-identical after aggregateDataDir runs', () => {
    const dir = tmp();
    ingestPayload(dir, payloadWithSecrets(), T0);
    scoreDataDir(dir, T0 + MIN);
    const before = readFileSync(outcomesFile(dir), 'utf8');
    const agg = aggregateDataDir(dir, T0 + 2 * MIN);
    assertEqual(readFileSync(outcomesFile(dir), 'utf8'), before, 'outcomes.jsonl untouched by aggregate.js (read-only)');
    assert('netExpectancy' in agg.totals.tradable && 'avgCostR' in agg.totals.tradable, 'statsFor output gained the additive net-R fields');
    assert('netExpectancy7d' in agg.tiles, 'tiles gained netExpectancy7d');
  });

  // ---------------------------------------------------------------- T4 flag paths (paths.js, docs/PLAN_FLAG_PATHS.md P0)

  const tfRows = (startMs, stepMs, cs) => cs.map((r, i) => ({ timestamp: startMs + i * stepMs, open: r.o, high: r.h, low: r.l, close: r.c }));
  const toStoreCandles = (symbol, arr) => arr.map((c) => ({ symbol, t: iso(c.timestamp), o: c.open, h: c.high, l: c.low, c: c.close, v: 0 }));
  const allStoreCandles = (bySymbol) => Object.entries(bySymbol).flatMap(([sym, arr]) => toStoreCandles(sym, arr));
  const slimCand = (over = {}) => ({
    id: 'BTC:5m:long:tight', tf: '5m', dir: 'long', state: 'proto', breakout: 100, invalidation: 99, measuredRR: 2, qual: null,
    measuredTarget: null, compressionScore: null, durationCandles: null, impulseStrength: null, flagHigh: null, flagLow: null, ...over
  });
  const candCaptureRow = (symbol, ms, candidateSetups, flagRecommendation = null, over = {}) =>
    ({ ...captureRow(symbol, ms, null, flagRecommendation), candidateSetups, ...over });

  await test('derive3mFrom1m: full UTC-aligned 3-minute buckets only, partial trailing bucket dropped', () => {
    const c1m = candles(T0, 7, () => ({ h: 1, l: 0 }));
    const out = derive3mFrom1m({ BTC: c1m }).BTC;
    assertEqual(out.length, 2, 'two full buckets from 7 one-minute candles');
    assertEqual(out[0].timestamp, T0, 'first bucket starts at T0');
    assertEqual(out[1].timestamp, T0 + 3 * MIN, 'second bucket starts 3m later');
    assertEqual(out[0].close, c1m[2].close, 'bucket close is its third 1m candle close');
  });

  await test('candidatesInRow: candidateSetups preferred over the flagRecommendation.candidate summary; legacy rows (no T4 fields) still parse to null', () => {
    const rich = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [slimCand({ measuredTarget: 103, compressionScore: 0.8, durationCandles: 6, impulseStrength: 3 })], flagRecommendation: null };
    const c = candidatesInRow(rich).get('BTC:5m:long:tight');
    assertEqual(c.measuredTarget, 103, 'richer candidateSetups value wins');
    const legacy = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [{ id: 'legacy1', tf: '5m', dir: 'long', state: 'proto', breakout: 100, invalidation: 99, measuredRR: 2, qual: null }], flagRecommendation: null };
    const lc = candidatesInRow(legacy).get('legacy1');
    assert(lc, 'legacy candidate (no T4 fields) parsed');
    for (const k of ['measuredTarget', 'compressionScore', 'durationCandles', 'impulseStrength', 'flagHigh', 'flagLow']) assertEqual(lc[k], null, `${k} null on a legacy row`);
    const feats = featuresAt({ ...lc, timeframe: lc.tf }, {});
    assertEqual(feats.compression, 'unknown', 'compression unknown for a legacy row');
    assertEqual(feats.duration, 'unknown', 'duration unknown for a legacy row');
    assertEqual(feats.impulseStrength, 'unknown', 'impulseStrength unknown for a legacy row');
    const summaryOnly = { symbol: 'BTC', closedThrough: iso(T0), candidateSetups: [], flagRecommendation: { class: 'WATCH', candidateId: 'sum1', candidate: { candidateId: 'sum1', timeframe: '3m', direction: 'short', state: 'forming', breakout: 50, invalidation: 51, measuredRR: 2 } } };
    const su = candidatesInRow(summaryOnly).get('sum1');
    assertEqual(su.tf, '3m', 'flagRecommendation.candidate summary fills in an id candidateSetups did not carry');
    assertEqual(su.measuredTarget, null, 'summary carries no measuredTarget');
  });

  await test('extractTighteningPoints / computePathsRows: pure in-memory unit (no disk), earliest forming/proto sighting only, any input order', () => {
    const cid = 'SOL:3m:short:unit';
    const r1 = candCaptureRow('SOL', T0, [slimCand({ id: cid, tf: '3m', dir: 'short', state: 'forming', breakout: 20, invalidation: 21 })]);
    const r2 = candCaptureRow('SOL', T0 + 3 * MIN, [slimCand({ id: cid, tf: '3m', dir: 'short', state: 'triggering', breakout: 20, invalidation: 21 })]);
    const tightened = extractTighteningPoints([r2, r1]); // reversed input order
    assertEqual(tightened.length, 1, 'one candidate');
    assertEqual(tightened[0].tighteningAt, iso(T0), 'earliest forming/proto capture, regardless of input order');
    assertEqual(tightened[0].symbol, 'SOL', 'symbol');
    assertEqual(tightened[0].source, 'cron', 'default source');
    const out = computePathsRows([r1, r2], { '3m': {}, '1m': {} }, [], T0 + 50 * MIN);
    assertEqual(out.length, 1, 'computePathsRows finds it too');
    assertEqual(out[0].status, 'pending', 'no candle data at all -> chop -> pending, window (24 x 3m = 72min) not yet elapsed');
    assertEqual(out[0].path, 'chop', 'no data to resolve against');
  });

  await test('paths.js: tightening point detection, served-first-sighting source, runner path resolved, idempotent (frozen labelledAt)', () => {
    const dir = tmp();
    const cid = 'BTC:5m:long:tight';
    const pCandles5m = tfRows(T0, 5 * MIN, [
      { o: 99.6, h: 99.9, l: 99.4, c: 99.7 }, // forming
      { o: 99.7, h: 100.5, l: 99.6, c: 100.4 }, // breakout close
      { o: 100.4, h: 101.2, l: 100.3, c: 101.0 }
    ]);
    const p1m = tfRows(T0 + 5 * MIN, MIN, [
      { o: 100.4, h: 100.5, l: 100.35, c: 100.45 },
      { o: 100.45, h: 100.7, l: 100.4, c: 100.65 },
      { o: 100.65, h: 100.9, l: 100.6, c: 100.85 },
      { o: 100.85, h: 101.05, l: 100.8, c: 101.0 }, // target touch (+1R = 101)
      { o: 101.0, h: 101.2, l: 100.95, c: 101.15 }
    ]);
    appendCandles(dir, '5m', toStoreCandles('BTC', pCandles5m));
    appendCandles(dir, '1m', toStoreCandles('BTC', p1m));
    appendCalls(dir, [
      candCaptureRow('BTC', T0, [slimCand({ id: cid, state: 'proto' })], { class: 'WATCH', candidateId: cid, candidate: { candidateId: cid } }, { source: 'served' }),
      candCaptureRow('BTC', T0 + 5 * MIN, [slimCand({ id: cid, state: 'confirmed' })])
    ]);
    const out = pathsDataDir(dir, T0 + 30 * MIN);
    assertEqual(out.length, 1, 'one row per candidate despite two captures');
    const r = out[0];
    assertEqual(r.candidateId, cid, 'candidateId');
    assertEqual(r.symbol, 'BTC', 'symbol');
    assertEqual(r.tf, '5m', 'tf');
    assertEqual(r.direction, 'long', 'direction');
    assertEqual(r.tighteningAt, iso(T0), 'tightening at the first proto sighting, not the later confirmed one');
    assertEqual(r.source, 'served', 'first sighting source recorded');
    assertEqual(r.recClass, 'WATCH', 'recClass at tightening (flagRecommendation names this candidate)');
    assertEqual(r.status, 'resolved', 'runner resolves on its own (has its own resolvedAt); window need not elapse');
    assertEqual(r.path, 'runner', 'runner path');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt (ms, labelPath field)');
    assertEqual(r.resolvedAt, T0 + 8 * MIN, 'resolvedAt at the target touch (ms)');
    assertEqual(r.minutes, 8, 'minutes from tightening to resolution');
    assert(r.labelledAt, 'labelledAt set once resolved');
    assertEqual(r.features.tf, '5m', 'featuresAt tf (candidate.timeframe alias)');
    assertEqual(r.features.direction, 'long', 'featuresAt direction');

    const again = pathsDataDir(dir, T0 + 60 * MIN);
    assertEqual(JSON.stringify(again), JSON.stringify(out), 'resolved row frozen byte-for-byte on rerun (idempotent, like score.js)');
  });

  await test('paths.js: pending while the window has not elapsed, resolved chop once it has, then frozen', () => {
    const dir = tmp();
    const cid = 'ETH:5m:long:flat';
    const flatCandles = tfRows(T0, 5 * MIN, Array.from({ length: 6 }, () => ({ o: 49.5, h: 49.6, l: 49.4, c: 49.5 })));
    appendCandles(dir, '5m', toStoreCandles('ETH', flatCandles));
    appendCalls(dir, [candCaptureRow('ETH', T0, [slimCand({ id: cid, tf: '5m', dir: 'long', breakout: 50, invalidation: 49 })])]);

    const soon = pathsDataDir(dir, T0 + 30 * MIN);
    assertEqual(soon.length, 1, 'one candidate');
    assertEqual(soon[0].status, 'pending', 'window (24 x 5m = 120min) has not elapsed yet');
    assertEqual(soon[0].path, 'chop', 'nothing has happened yet');
    assertEqual(soon[0].labelledAt, null, 'not labelled while pending');

    const late = pathsDataDir(dir, T0 + 130 * MIN);
    assertEqual(late[0].status, 'resolved', 'window has now elapsed - final chop');
    assertEqual(late[0].path, 'chop', 'still chop');
    assert(late[0].labelledAt, 'labelledAt set on the run that resolves it');
    const firstLabelledAt = late[0].labelledAt;

    const evenLater = pathsDataDir(dir, T0 + 999 * MIN);
    assertEqual(JSON.stringify(evenLater), JSON.stringify(late), 'resolved chop frozen, labelledAt never moves again');
    assertEqual(evenLater[0].labelledAt, firstLabelledAt, 'labelledAt unchanged');
  });

  await test('pathsSummary: base rates over resolved rows only, windowed by tighteningAt, by tf; uncalibrated under n=100', () => {
    const mk = (id, tf, tighteningAt, p) => ({
      candidateId: id, symbol: 'BTC', tf, direction: 'long', tighteningAt, source: 'cron', recClass: null, status: 'resolved',
      path: p, breakoutAt: null, retestAt: null, resolvedAt: null, mfeR: null, targetR: null, minutes: null, features: {}, labelledAt: tighteningAt
    });
    const nowMs = T0 + 10 * 24 * 60 * MIN;
    const rows2 = [
      mk('a', '5m', iso(nowMs - 1 * 24 * 60 * MIN), 'runner'),
      mk('b', '5m', iso(nowMs - 2 * 24 * 60 * MIN), 'retest_go'),
      mk('c', '3m', iso(nowMs - 3 * 24 * 60 * MIN), 'chop'),
      mk('d', '5m', iso(nowMs - 10 * 24 * 60 * MIN), 'runner'), // outside 7d, inside 30d
      { ...mk('e', '5m', iso(nowMs - 1 * 24 * 60 * MIN), 'runner'), status: 'pending' } // excluded, not resolved
    ];
    const s = pathsSummary(rows2, nowMs);
    assertEqual(s.d7.n, 3, '7d: a, b, c (d is outside 7d, e is pending)');
    assertEqual(s.d7.overall.n, 3, 'overall n');
    assertEqual(s.d7.overall.calibrated, false, 'n < 100 -> uncalibrated');
    assertEqual(s.d7.overall.shares.runner, 33.33, 'runner share 1/3');
    const tf5 = s.d7.byTf.find((g) => g.key === '5m');
    assertEqual(tf5.n, 2, '5m bucket n (a, b)');
    assertEqual(s.d30.n, 4, '30d also includes d');
    const empty = pathsSummary([], nowMs);
    assertEqual(empty.d7.n, 0, 'empty rows -> n 0');
    assertEqual(empty.d7.overall.calibrated, false, 'empty -> uncalibrated');
  });

  await test('paths.js + calibration.js + shadow.js: outcomes.jsonl and aggregates.json byte-identical whether or not the steps run', () => {
    const dirA = tmp();
    const dirB = tmp();
    const cid = 'BTC:5m:long:byte-check';
    const extraRow = candCaptureRow('BTC', T0 + 50 * MIN, [slimCand({ id: cid, state: 'proto' })]);
    const allRows = [...rows, extraRow];
    for (const d of [dirA, dirB]) {
      appendCalls(d, allRows);
      appendCandles(d, '1m', allStoreCandles(candleSet));
    }
    scoreDataDir(dirA, T0 + 2 * 60 * MIN);
    scoreDataDir(dirB, T0 + 2 * 60 * MIN);
    aggregateDataDir(dirA, T0 + 2 * 60 * MIN);
    aggregateDataDir(dirB, T0 + 2 * 60 * MIN);
    const outcomesBefore = readFileSync(outcomesFile(dirB), 'utf8');
    const aggBefore = readFileSync(aggregatesFile(dirB), 'utf8');

    const pathsOut = pathsDataDir(dirB, T0 + 2 * 60 * MIN);
    assert(pathsOut.length >= 1, 'paths.js found the injected tightening candidate');

    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), outcomesBefore, 'outcomes.jsonl byte-identical after running paths.js');
    assertEqual(readFileSync(aggregatesFile(dirB), 'utf8'), aggBefore, 'aggregates.json byte-identical after running paths.js');
    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), readFileSync(outcomesFile(dirA), 'utf8'), 'outcomes.jsonl identical vs a dir that never ran paths.js');

    const calOut = calibrationDataDir(dirB, T0 + 2 * 60 * MIN);
    assert(existsSync(calibrationFile(dirB)), 'calibration.json written');
    assert(calOut.n >= 0, 'calibration output shape');

    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), outcomesBefore, 'outcomes.jsonl byte-identical after running calibration.js too');
    assertEqual(readFileSync(aggregatesFile(dirB), 'utf8'), aggBefore, 'aggregates.json byte-identical after running calibration.js too');
    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), readFileSync(outcomesFile(dirA), 'utf8'), 'outcomes.jsonl identical vs a dir that never ran paths.js/calibration.js');
    assert(!existsSync(calibrationFile(dirA)), 'dir A never ran calibration.js either');

    const pathsBefore = readFileSync(pathsFile(dirB), 'utf8');
    const calBefore = readFileSync(calibrationFile(dirB), 'utf8');
    const shadowOut = shadowDataDir(dirB, T0 + 2 * 60 * MIN);
    assert(existsSync(shadowOutcomesFile(dirB)) && existsSync(shadowSummaryFile(dirB)), 'shadow-outcomes.jsonl and shadow.json written');
    assert(shadowOut.rows.length >= 0, 'shadow output shape');

    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), outcomesBefore, 'outcomes.jsonl byte-identical after running shadow.js too');
    assertEqual(readFileSync(aggregatesFile(dirB), 'utf8'), aggBefore, 'aggregates.json byte-identical after running shadow.js too');
    assertEqual(readFileSync(pathsFile(dirB), 'utf8'), pathsBefore, 'paths.jsonl byte-identical after running shadow.js');
    assertEqual(readFileSync(calibrationFile(dirB), 'utf8'), calBefore, 'calibration.json byte-identical after running shadow.js');
    assertEqual(readFileSync(outcomesFile(dirB), 'utf8'), readFileSync(outcomesFile(dirA), 'utf8'), 'outcomes.jsonl identical vs a dir that never ran paths.js/calibration.js/shadow.js');
    assert(!existsSync(shadowOutcomesFile(dirA)), 'dir A never ran shadow.js either');
  });

  await test('page: flag-paths tile renders with ids and the empty state from an empty data dir', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['flag-paths-section', 'flag-paths-empty']) assert(html.includes(`id="${id}"`), `missing #${id}`);
    assert(html.includes('[NO RESOLVED FLAG PATHS YET]'), 'empty state text');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section (paths tile included)');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'still exactly one executable inline script');
    assert(html.indexOf('id="class-check-section"') < html.indexOf('id="flag-paths-section"'), 'placed after class check in the performance zone');
  });

  await test('page: flag-paths tile renders populated rows with the path mix and an uncalibrated tag under n=100', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const resolvedRow = {
      candidateId: 'BTC:5m:long:x', symbol: 'BTC', tf: '5m', direction: 'long', tighteningAt: iso(T0), source: 'cron',
      recClass: 'WATCH', status: 'resolved', path: 'runner', breakoutAt: T0 + 5 * MIN, retestAt: null, resolvedAt: T0 + 8 * MIN,
      mfeR: 1.5, targetR: 2, minutes: 8,
      features: {
        compression: 'tight', duration: 'short', impulseStrength: 'moderate', tf: '5m', direction: 'long', levelTests: 'unknown',
        structureSteps: 'unknown', stochSide: 'unknown', stochSlope: 'unknown', tfAgreement: 'unknown', tdSide: 'unknown', ema200Side: 'unknown', roomR: 'unknown', hourUtc: '00-06'
      },
      labelledAt: iso(T0 + 8 * MIN)
    };
    writeJsonl(pathsFile(dataDir), [resolvedRow]);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="flag-paths-7d-table"'), 'populated 7d table renders');
    assert(html.includes('UNCALIBRATED'), 'n=1 < 100 -> flagged uncalibrated');
    assert(html.includes('100%'), 'runner share visible (1/1 = 100%)');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'still one provisional tag per section');
  });

  // ---------------------------------------------------------------- T4 P3 calibration.js (docs/PLAN_FLAG_PATHS.md P3)

  const poRow = (id, at, w, extra = {}) => ({ pathOutlook: { id, tf: '5m', dir: 'long', at, lean: 'breakout', likely: 'runner', chase: 'elevated', w, n: 140, cal: true, key: 'tf=5m', ...extra } });
  const wOf = (over = {}) => ({ retest_go: 40, runner: 30, false_break: 15, fail_first: 10, chop: 5, ...over });
  const calPathRow = (id, calPath, over = {}) => ({
    candidateId: id, symbol: 'BTC', tf: '5m', direction: 'long', tighteningAt: iso(T0), source: 'cron', recClass: null,
    status: 'resolved', path: calPath, breakoutAt: null, retestAt: null, resolvedAt: null, mfeR: null, targetR: null, minutes: null, features: {}, labelledAt: iso(T0), ...over
  });

  await test('firstPathOutlookSightings: first capture per candidateId per phase kept, later same-phase captures ignored, rows with no pathOutlook skipped', () => {
    const callRows = [
      poRow('a', 'tightening', wOf({ runner: 20 })),
      poRow('a', 'tightening', wOf({ runner: 99 })), // later tightening capture for 'a' - ignored (first sighting is fixed)
      poRow('a', 'broken', wOf({ runner: 60 })),
      { pathOutlook: null }, // absent pathOutlook - skipped
      { flagRecommendation: {} } // no pathOutlook field at all - skipped
    ];
    const seen = firstPathOutlookSightings(callRows);
    assertEqual(seen.size, 1, 'only candidate a seen');
    assertEqual(seen.get('a').tightening.w.runner, 20, 'first tightening kept, later ignored');
    assertEqual(seen.get('a').broken.w.runner, 60, 'broken kept separately from tightening');
  });

  await test('joinCalibrationRows: tightening always compared; broken compared only when the realised path is not fail_first', () => {
    const callRows = [
      poRow('runner-id', 'tightening', wOf()), poRow('runner-id', 'broken', wOf({ runner: 70 })),
      poRow('failfirst-id', 'tightening', wOf()), poRow('failfirst-id', 'broken', wOf({ runner: 70 }))
    ];
    const pathRows = [calPathRow('runner-id', 'runner'), calPathRow('failfirst-id', 'fail_first')];
    const joined = joinCalibrationRows(pathRows, callRows);
    assertEqual(joined.length, 3, 'runner-id contributes 2 rows (broke out - both phases scored), failfirst-id contributes 1 (never broke out)');
    assertEqual(joined.filter((r) => r.candidateId === 'runner-id').length, 2, 'both phases for runner-id');
    const ffRows = joined.filter((r) => r.candidateId === 'failfirst-id');
    assertEqual(ffRows.length, 1, 'only tightening for failfirst-id');
    assertEqual(ffRows[0].phase, 'tightening', 'the broken sighting for failfirst-id is dropped, not scored');
  });

  await test('joinCalibrationRows: only resolved rows with a known path and a pathOutlook sighting are joined', () => {
    const callRows = [poRow('a', 'tightening', wOf())];
    const pathRows = [calPathRow('a', 'runner', { status: 'pending' }), calPathRow('b', 'runner')]; // a pending (unresolved), b has no sighting
    assertEqual(joinCalibrationRows(pathRows, callRows).length, 0, 'pending row and unsighted candidate both excluded');
  });

  await test('multiClassBrier: hand example - sum over paths (p - outcome)^2, p = w/100', () => {
    const rows = [{ predicted: wOf({ retest_go: 50, runner: 30, false_break: 10, fail_first: 5, chop: 5 }), realised: 'runner' }];
    // (.5-0)^2 + (.3-1)^2 + (.1-0)^2 + (.05-0)^2 + (.05-0)^2 = .25 + .49 + .01 + .0025 + .0025 = .755
    assertEqual(multiClassBrier(rows), 0.755, 'hand-computed Brier');
    assertEqual(multiClassBrier([]), null, 'empty set -> null, not 0 (0 would read as perfectly calibrated)');
  });

  await test('baselineWeights / baselineBrier: naive baseline is the realised-path frequency of the same joined set', () => {
    const rows = [{ realised: 'runner' }, { realised: 'runner' }, { realised: 'chop' }, { realised: 'retest_go' }];
    const w = baselineWeights(rows);
    assertEqual(w.runner, 50, '2/4 runner');
    assertEqual(w.chop, 25, '1/4 chop');
    assertEqual(w.retest_go, 25, '1/4 retest_go');
    assertEqual(w.false_break, 0, '0/4 false_break');
    assertEqual(w.fail_first, 0, '0/4 fail_first');
    assertEqual(baselineBrier(rows), multiClassBrier(rows.map((r) => ({ ...r, predicted: w }))), 'baselineBrier == scoring the constant baseline weights against every row in the set');
    assertEqual(baselineWeights([]).runner, 0, 'empty set -> all zero');
    assertEqual(baselineBrier([]), null, 'empty set -> null');
  });

  await test('phaseStats: n, brier, baselineBrier and baseline together', () => {
    const rows = [
      { predicted: wOf({ runner: 100, retest_go: 0, false_break: 0, fail_first: 0, chop: 0 }), realised: 'runner' },
      { predicted: wOf({ runner: 0, retest_go: 100, false_break: 0, fail_first: 0, chop: 0 }), realised: 'retest_go' }
    ];
    const s = phaseStats(rows);
    assertEqual(s.n, 2, 'n');
    assertEqual(s.brier, 0, 'each row perfectly predicted its own realised path -> Brier 0');
    assertEqual(s.baselineBrier, 0.5, 'the 50/50 baseline scores 0.5 against two certain, opposite outcomes');
    assertEqual(phaseStats([]).n, 0, 'empty phase -> n 0, brier/baselineBrier null');
    assertEqual(phaseStats([]).brier, null, 'null brier on empty phase');
  });

  await test('reliabilityTable: ten fixed buckets by predicted probability for one path, mean predicted and realised rate per bucket', () => {
    const rows = [
      { predicted: wOf({ runner: 5 }), realised: 'chop' }, // bucket 0-10
      { predicted: wOf({ runner: 15 }), realised: 'runner' }, // bucket 10-20
      { predicted: wOf({ runner: 15 }), realised: 'chop' }, // bucket 10-20
      { predicted: wOf({ runner: 25 }), realised: 'runner' } // bucket 20-30
    ];
    const table = reliabilityTable(rows, 'runner');
    assertEqual(table.length, 10, 'always ten fixed buckets');
    const b0 = table.find((b) => b.bucket === '0-10');
    assertEqual(b0.n, 1, 'one row at 5%');
    assertEqual(b0.meanPredicted, 5, 'mean predicted in bucket');
    assertEqual(b0.realisedRate, 0, 'never became runner in this bucket');
    const b10 = table.find((b) => b.bucket === '10-20');
    assertEqual(b10.n, 2, 'two rows at 15%');
    assertEqual(b10.realisedRate, 50, 'half became runner');
    const b20 = table.find((b) => b.bucket === '20-30');
    assertEqual(b20.realisedRate, 100, 'the one row in this bucket became runner');
    const b90 = table.find((b) => b.bucket === '90-100');
    assertEqual(b90.n, 0, 'empty bucket');
    assertEqual(b90.meanPredicted, null, 'null mean predicted on an empty bucket');
    assertEqual(b90.realisedRate, null, 'null realised rate on an empty bucket');
  });

  await test('likelyHitRate: share of rows whose `likely` field matched the realised path', () => {
    const rows = [{ likely: 'runner', realised: 'runner' }, { likely: 'runner', realised: 'chop' }, { likely: null, realised: 'runner' }];
    const r = likelyHitRate(rows);
    assertEqual(r.n, 2, 'only rows carrying a likely value count');
    assertEqual(r.hitRate, 50, '1 of 2 hit');
    assertEqual(likelyHitRate([]).n, 0, 'empty -> n 0');
    assertEqual(likelyHitRate([]).hitRate, null, 'empty -> null hit rate');
  });

  await test('chaseStats: runner rate for chase high/elevated vs chase low', () => {
    const rows = [
      { chase: 'high', realised: 'runner' }, { chase: 'high', realised: 'chop' }, { chase: 'elevated', realised: 'runner' },
      { chase: 'low', realised: 'chop' }, { chase: 'low', realised: 'chop' }
    ];
    const c = chaseStats(rows);
    assertEqual(c.highElevated.n, 3, 'high and elevated pooled');
    assertEqual(c.highElevated.runnerRate, 66.7, 'two of three became runner');
    assertEqual(c.low.n, 2, 'low count');
    assertEqual(c.low.runnerRate, 0, 'none of the low group became runner');
  });

  await test('computeCalibration / calibrationDataDir: end-to-end shape, empty-set defaults', () => {
    const empty = computeCalibration([], []);
    assertEqual(empty.n, 0, 'no rows -> n 0');
    assertEqual(empty.phases.tightening.n, 0, 'no tightening rows');
    assertEqual(empty.phases.broken.n, 0, 'no broken rows');
    assertEqual(empty.reliability.runner.length, 10, 'reliability table always ten buckets, even empty');
    assertEqual(empty.likely.hitRate, null, 'no likely data');
    assertEqual(empty.chase.highElevated.n, 0, 'no chase data');

    const dir = tmp();
    appendCalls(dir, [{ symbol: 'BTC', closedThrough: iso(T0), ...poRow('e2e-id', 'tightening', wOf({ runner: 60, retest_go: 20, false_break: 10, fail_first: 5, chop: 5 })) }]);
    writeJsonl(pathsFile(dir), [calPathRow('e2e-id', 'runner')]);
    const out = calibrationDataDir(dir, T0 + 60 * MIN);
    assertEqual(out.n, 1, 'the one joined row (tightening)');
    assertEqual(out.phases.tightening.n, 1, 'tightening phase n');
    assertEqual(readJson(calibrationFile(dir)).n, 1, 'written to disk');
  });

  await test('page: path-calibration tile renders with ids and the empty state from an empty data dir', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['path-calibration-section', 'path-calibration-empty']) assert(html.includes(`id="${id}"`), `missing #${id}`);
    assert(html.includes(NO_CALIBRATION), 'empty state text');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section (calibration tile included)');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'still exactly one executable inline script');
    assert(html.indexOf('id="flag-paths-section"') < html.indexOf('id="path-calibration-section"'), 'placed after flag paths, near it, in the performance zone');
  });

  await test('page: path-calibration tile shows TOO FEW CALLS under n=30, populated summary rows and both reliability subs', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const cal = {
      generatedAt: iso(T0), n: 5,
      phases: {
        tightening: { n: 5, brier: 0.42, baselineBrier: 0.5, baseline: { retest_go: 20, runner: 40, false_break: 20, fail_first: 10, chop: 10 } },
        broken: { n: 0, brier: null, baselineBrier: null, baseline: {} }
      },
      reliability: { runner: reliabilityTable([{ predicted: { runner: 35 }, realised: 'runner' }], 'runner'), fail_first: reliabilityTable([], 'fail_first') },
      likely: { n: 5, hitRate: 60 },
      chase: { highElevated: { n: 3, runnerRate: 66.7 }, low: { n: 2, runnerRate: 0 } }
    };
    writeJson(calibrationFile(dataDir), cal);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="path-calibration-phases-table"'), 'phases table renders');
    // tightening (n=5), likely (n=5), chase high/elevated (n=3), chase low (n=2) are all below CALIBRATION_MIN_N; broken (n=0) reads a dash, not TOO FEW CALLS.
    assertEqual((html.match(/TOO FEW CALLS/g) || []).length, 4, `four stats under n=${CALIBRATION_MIN_N} all read TOO FEW CALLS`);
    assert(html.includes('id="path-calibration-runner-reliability-sub"') && html.includes('id="path-calibration-fail-first-reliability-sub"'), 'both reliability subs present');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'still one provisional tag per section');
  });

  await test('page: path-calibration tile shows numeric Brier once a phase reaches n=CALIBRATION_MIN_N', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const cal = {
      generatedAt: iso(T0), n: 30,
      phases: {
        tightening: { n: CALIBRATION_MIN_N, brier: 0.41, baselineBrier: 0.5, baseline: {} },
        broken: { n: 0, brier: null, baselineBrier: null, baseline: {} }
      },
      reliability: { runner: reliabilityTable([], 'runner'), fail_first: reliabilityTable([], 'fail_first') },
      likely: { n: 30, hitRate: 55 },
      chase: { highElevated: { n: 30, runnerRate: 40 }, low: { n: 30, runnerRate: 10 } }
    };
    writeJson(calibrationFile(dataDir), cal);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('>0.41<'), 'numeric brier shown at n=30, not TOO FEW CALLS');
    assert(html.includes('>0.5<'), 'baseline brier shown');
    assert(html.includes('55%'), 'likely hit rate visible at n=30');
    assert(html.includes('40%'), 'chase high/elevated runner rate visible at n=30');
    assert(!html.includes('TOO FEW CALLS'), 'nothing in this fixture is below the threshold');
  });

  // ---------------------------------------------------------------- T4 P4 shadow.js (breakout entry shadow scoring)

  await test('shadow.js: SHADOW_CFG matches config/engine.json (documented, tested source of truth)', () => {
    const engineCfg = JSON.parse(readFileSync('config/engine.json', 'utf8'));
    assertEqual(SHADOW_CFG.minRR, engineCfg.flagPlan.minRR, 'minRR');
    assertEqual(SHADOW_CFG.maxStopPct, engineCfg.scalp.maxStopDistancePct, 'maxStopPct');
    assertEqual(SHADOW_CFG.feeBps, engineCfg.risk.feeBps, 'feeBps');
    assertEqual(SHADOW_CFG.slippageBps, engineCfg.risk.slippageBps, 'slippageBps');
  });

  await test('shadow.js: breakoutCloseAt reads the close of the candle at breakoutAt on 1m/3m/5m (3m derived from 1m)', () => {
    const c1m = candles(T0, 9, (i) => ({ h: 100 + i, l: 99 + i }));
    const c5m = candles(T0, 3, (i) => ({ h: 200 + i, l: 199 + i }));
    const candlesByTf = { '1m': { BTC: c1m }, '3m': derive3mFrom1m({ BTC: c1m }), '5m': { BTC: c5m }, '15m': {} };
    assertEqual(breakoutCloseAt('BTC', '1m', T0 + 2 * MIN, candlesByTf), c1m[2].close, '1m lookup');
    assertEqual(breakoutCloseAt('BTC', '3m', T0 + 3 * MIN, candlesByTf), candlesByTf['3m'].BTC[1].close, '3m derived lookup');
    assertEqual(breakoutCloseAt('BTC', '5m', T0, candlesByTf), c5m[0].close, '5m lookup');
    assertEqual(breakoutCloseAt('BTC', '5m', T0 + 999 * MIN, candlesByTf), null, 'no candle at that timestamp -> null');
    assertEqual(breakoutCloseAt('ETH', '1m', T0, candlesByTf), null, 'unknown symbol -> null');
  });

  await test('shadow.js: chaseTagFor - engine row (breakoutEntry.id match) wins, else latest pathOutlook before breakoutAt (reconstructed), else unknown', () => {
    const cid = 'BTC:5m:long:chase-test';
    const breakoutAtMs = T0 + 10 * MIN;
    const rowEarly = { closedThrough: iso(T0), pathOutlook: { id: cid, chase: 'elevated' } };
    const rowLate = { closedThrough: iso(T0 + 5 * MIN), pathOutlook: { id: cid, chase: 'high' } };
    const rowAfter = { closedThrough: iso(breakoutAtMs + MIN), pathOutlook: { id: cid, chase: 'low' } };
    const rowEngine = { closedThrough: iso(breakoutAtMs + 5 * MIN), breakoutEntry: { id: cid }, pathOutlook: { id: cid, chase: 'high' } };

    assertEqual(JSON.stringify(chaseTagFor(cid, breakoutAtMs, [rowEarly, rowLate, rowAfter])),
      JSON.stringify({ chase: 'high', source: 'reconstructed' }), 'latest sighting strictly before breakoutAt wins; rowAfter (later) ignored');
    assertEqual(JSON.stringify(chaseTagFor(cid, breakoutAtMs, [rowEarly, rowLate, rowEngine])),
      JSON.stringify({ chase: 'high', source: 'engine' }), 'engine row (own live breakoutEntry) wins over the reconstructed fallback');
    assertEqual(JSON.stringify(chaseTagFor(cid, breakoutAtMs, [])), JSON.stringify({ chase: 'unknown', source: 'unknown' }), 'no data -> unknown');
    assertEqual(JSON.stringify(chaseTagFor(cid, breakoutAtMs, [{ closedThrough: iso(T0), pathOutlook: { id: 'other', chase: 'high' } }])),
      JSON.stringify({ chase: 'unknown', source: 'unknown' }), 'no matching candidateId -> unknown');
  });

  function buildShadowRunnerFixture() {
    const cid = 'SOL:5m:long:shadow-hand';
    const breakoutOpenMs = T0 + 5 * MIN;
    const candles5m = tfRows(T0, 5 * MIN, [
      { o: 114.5, h: 114.9, l: 114.4, c: 114.6 }, // tightening (forming) candle
      { o: 114.6, h: 115.0, l: 114.55, c: 114.99 } // breakout candle, closes 114.99 (> breakoutLevel 114.95)
    ]);
    const candles1m = tfRows(breakoutOpenMs + 5 * MIN, MIN, [ // starting at the breakout candle's own close time
      { o: 114.99, h: 115.2, l: 114.9, c: 115.1 },
      { o: 115.1, h: 115.6, l: 115.0, c: 115.5 },
      { o: 115.5, h: 116.1, l: 115.4, c: 116.0 } // touches measuredTarget 116.00, no retest first (runner)
    ]);
    const candlesByTf = { '1m': { SOL: candles1m }, '3m': {}, '5m': { SOL: candles5m }, '15m': {} };
    const callRows = [candCaptureRow('SOL', T0, [slimCand({ id: cid, tf: '5m', dir: 'long', state: 'forming', breakout: 114.95, invalidation: 114.71, measuredTarget: 116.00 })])];
    const pathsRow = {
      candidateId: cid, symbol: 'SOL', tf: '5m', direction: 'long', tighteningAt: iso(T0), source: 'cron', recClass: null,
      status: 'resolved', path: 'runner', breakoutAt: breakoutOpenMs, retestAt: null, resolvedAt: null, mfeR: null, targetR: null, minutes: null, features: {}, labelledAt: iso(T0)
    };
    return { pathsRow, callRows, candlesByTf };
  }

  await test('shadow.js: SOL-like runner hand case - shadow published and resolves tp1, retest none (no retest-hold on a runner)', () => {
    const { pathsRow, callRows, candlesByTf } = buildShadowRunnerFixture();
    const rows = computeShadowRows([pathsRow], callRows, candlesByTf, [], T0 + 60 * MIN);
    assertEqual(rows.length, 1, 'one shadow row');
    const r = rows[0];
    assertEqual(r.candidateId, pathsRow.candidateId, 'candidateId');
    assert(r.shadow, 'shadow entry published (RR and stop % pass)');
    assertEqual(r.shadow.entry, 114.99, 'entry = breakout close');
    assertEqual(r.shadow.stop, 114.71, 'stop = invalidation');
    assertEqual(r.shadow.tp1, 116, 'tp1 = measuredTarget');
    assertEqual(r.shadow.outcome, 'tp1', 'shadow walk resolves tp1');
    assertEqual(r.retest, null, 'no retest leg (runner path, paths.jsonl retestAt null)');
    assertEqual(r.status, 'resolved', 'terminal shadow outcome, no applicable retest -> resolved');
    assert(r.computedAt, 'computedAt set once resolved');
  });

  await test('shadow.js: idempotent - resolved rows kept byte-for-byte on rerun', () => {
    const { pathsRow, callRows, candlesByTf } = buildShadowRunnerFixture();
    const first = computeShadowRows([pathsRow], callRows, candlesByTf, [], T0 + 60 * MIN);
    const again = computeShadowRows([pathsRow], callRows, candlesByTf, first, T0 + 120 * MIN);
    assertEqual(JSON.stringify(again), JSON.stringify(first), 'resolved row frozen byte-for-byte, including computedAt');
  });

  await test('shadow.js: shadowSummary - win rate, expectancy, max losing streak, split shadow vs retest and by chase', () => {
    const leg = (outcome, r, resolvedAt) => ({ entry: 1, stop: 1, tp1: 1, grossRR: 3, netRR: 3, outcome, r, resolvedAt, minutes: 1 });
    const rows = [
      { candidateId: 'a', chase: 'high', shadow: leg('tp1', 3, T0), retest: null },
      { candidateId: 'b', chase: 'elevated', shadow: leg('stop', -1, T0 + MIN), retest: leg('tp1', 2, T0 + MIN) },
      { candidateId: 'c', chase: 'low', shadow: leg('stop', -1, T0 + 2 * MIN), retest: null },
      { candidateId: 'd', chase: 'unknown', shadow: null, retest: leg('stop', -1, T0 + 3 * MIN) },
      { candidateId: 'e', chase: 'high', shadow: leg('open', null, null), retest: null }
    ];
    const s = shadowSummary(rows);
    assertEqual(s.n, 5, 'total rows');

    assertEqual(s.shadow.overall.n, 4, 'four shadow legs published (a,b,c,e)');
    assertEqual(s.shadow.overall.wins, 1, 'one tp1 (a)');
    assertEqual(s.shadow.overall.losses, 2, 'two stops (b,c)');
    assertEqual(s.shadow.overall.open, 1, 'one open (e)');
    assertEqual(s.shadow.overall.winRate, 0.3333, 'win rate over decided (1 of 3)');
    assertEqual(s.shadow.overall.expectancy, 0.3333, 'expectancy (3-1-1)/3');
    assertEqual(s.shadow.overall.maxLosingStreak, 2, 'a(win) then b,c(stop,stop) back to back');

    assertEqual(s.retest.overall.n, 2, 'two retest legs (b,d)');
    assertEqual(s.retest.overall.wins, 1, 'b tp1');
    assertEqual(s.retest.overall.losses, 1, 'd stop');
    assertEqual(s.retest.overall.winRate, 0.5, 'retest win rate');
    assertEqual(s.retest.overall.expectancy, 0.5, 'retest expectancy (2-1)/2');
    assertEqual(s.retest.overall.maxLosingStreak, 1, 'b(win) then d(stop)');

    assertEqual(s.shadow.byChase.highElevated.n, 3, 'a,b,e are chase high/elevated');
    assertEqual(s.shadow.byChase.highElevated.wins, 1, 'a');
    assertEqual(s.shadow.byChase.highElevated.losses, 1, 'b');
    assertEqual(s.shadow.byChase.highElevated.open, 1, 'e');
    assertEqual(s.shadow.byChase.highElevated.winRate, 0.5, 'a win / b stop');
    assertEqual(s.shadow.byChase.highElevated.expectancy, 1, '(3-1)/2');
    assertEqual(s.shadow.byChase.lowUnknown.n, 1, 'only c has a shadow leg among low/unknown (c,d)');
    assertEqual(s.shadow.byChase.lowUnknown.losses, 1, 'c stop');
    assertEqual(s.shadow.byChase.lowUnknown.expectancy, -1, 'single loss');

    assertEqual(s.retest.byChase.highElevated.n, 1, 'only b has a retest leg among high/elevated (a,b,e)');
    assertEqual(s.retest.byChase.highElevated.wins, 1, 'b tp1');
    assertEqual(s.retest.byChase.lowUnknown.n, 1, 'only d has a retest leg among low/unknown (c,d)');
    assertEqual(s.retest.byChase.lowUnknown.losses, 1, 'd stop');

    const empty = shadowSummary([]);
    assertEqual(empty.n, 0, 'empty rows -> n 0');
    assertEqual(empty.shadow.overall.n, 0, 'empty shadow overall');
    assertEqual(empty.shadow.overall.winRate, null, 'null win rate on empty, not 0');
  });

  await test('shadow.js: shadow/retest legs carry an additive netR field, cost from costs.js (T5 S1)', () => {
    const { pathsRow, callRows, candlesByTf } = buildShadowRunnerFixture();
    const rows = computeShadowRows([pathsRow], callRows, candlesByTf, [], T0 + 60 * MIN);
    const shadow = rows[0].shadow;
    assertEqual(shadow.outcome, 'tp1', 'sanity: resolves tp1');
    const expectedCost = costR(shadow.entry, shadow.stop);
    const expectedNet = Math.round((shadow.r - expectedCost) * 10000) / 10000;
    assertEqual(shadow.netR, expectedNet, 'netR = gross r - costR(entry, stop), cost mirrors netRiskReward');
    assert(shadow.netR < shadow.r, 'net is lower than gross once fees + slippage are charged');
    assert(typeof shadow.netRR === 'number' && shadow.netRR !== shadow.netR, 'planned netRR field (netRiskReward ratio) is a distinct field from the new realised netR');
  });

  await test("shadow.js: shadowSummary netExpectancy averages each leg's own netR field (fees + slippage, T5 S1)", () => {
    const leg = (outcome, r, legNetR, resolvedAt) => ({ entry: 1, stop: 1, tp1: 1, grossRR: 3, netRR: 3, outcome, r, netR: legNetR, resolvedAt, minutes: 1 });
    const rows = [
      { candidateId: 'a', chase: 'high', shadow: leg('tp1', 3, 2.8, T0), retest: null },
      { candidateId: 'b', chase: 'elevated', shadow: leg('stop', -1, -1.2, T0 + MIN), retest: leg('tp1', 2, 1.9, T0 + MIN) },
      { candidateId: 'c', chase: 'low', shadow: leg('stop', -1, -1.2, T0 + 2 * MIN), retest: null }
    ];
    const s = shadowSummary(rows);
    assertEqual(s.shadow.overall.netExpectancy, 0.1333, 'net expectancy (2.8-1.2-1.2)/3, rounded to 4dp');
    assertEqual(s.retest.overall.netExpectancy, 1.9, 'single retest leg net R carried through');
  });

  await test('shadow.js + paths.js: shadowDataDir end to end through the store, stable on rerun', () => {
    const dir = tmp();
    const cid = 'BTC:5m:long:e2e';
    const candles5m = tfRows(T0, 5 * MIN, [
      { o: 114.75, h: 114.85, l: 114.72, c: 114.8 }, // tightening (proto) candle, between invalidation and breakout
      { o: 114.8, h: 115.0, l: 114.75, c: 114.99 } // breakout candle
    ]);
    const candles1m = tfRows(T0 + 10 * MIN, MIN, [
      { o: 114.99, h: 115.2, l: 114.9, c: 115.1 },
      { o: 115.1, h: 115.6, l: 115.0, c: 115.5 },
      { o: 115.5, h: 116.1, l: 115.4, c: 116.0 } // target touch
    ]);
    appendCandles(dir, '5m', toStoreCandles('BTC', candles5m));
    appendCandles(dir, '1m', toStoreCandles('BTC', candles1m));
    appendCalls(dir, [candCaptureRow('BTC', T0, [slimCand({ id: cid, tf: '5m', dir: 'long', state: 'proto', breakout: 114.95, invalidation: 114.71, measuredTarget: 116.00 })])]);
    pathsDataDir(dir, T0 + 60 * MIN);
    const first = shadowDataDir(dir, T0 + 60 * MIN);
    assert(existsSync(shadowOutcomesFile(dir)) && existsSync(shadowSummaryFile(dir)), 'both files written');
    assertEqual(first.rows.length, 1, 'one shadow-outcomes row for the tightened candidate');
    assertEqual(first.rows[0].shadow.outcome, 'tp1', 'walked through the store to tp1');
    assertEqual(first.summary.shadow.overall.n, 1, 'summary counts the one published shadow entry');
    const again = shadowDataDir(dir, T0 + 120 * MIN);
    assertEqual(JSON.stringify(again.rows), JSON.stringify(first.rows), 'rerun stable once resolved');
    assertEqual(readJsonl(shadowOutcomesFile(dir)).length, first.rows.length, 'stored rows match');
  });

  // ---------------------------------------------------------------- T6 completion plan D-variant revised (v3-shadow.js)

  function vbCaptureRow(symbol, ms, shadowV3) {
    return candCaptureRow(symbol, ms, [], null, { flagTradePlan: shadowV3 ? { status: 'rejected', reasonCode: 'rr_below_min', shadow: { v3: shadowV3 } } : null });
  }

  function vbFields(over = {}) {
    return { candidateId: 'BTC:1m:long:v3a', status: 'ready', reasonCode: null, timeframe: '1m', direction: 'long', entry: 100, stop: 99, tp1: 103, grossRR: 2.9, netRR: 2.25, planId: 'BTC:1m:long:v3a|x|y', ...over };
  }

  await test('computeV3ShadowRows: dedupes to the FIRST ready close per candidateId, ignores non-ready/absent shadow.v3 rows', () => {
    const rows = [
      vbCaptureRow('BTC', T0, null), // no plan at all
      vbCaptureRow('BTC', T0 + MIN, vbFields({ status: 'conditional', reasonCode: 'awaiting_retest' })), // shadow present, not ready yet
      vbCaptureRow('BTC', T0 + 2 * MIN, vbFields()), // first ready
      vbCaptureRow('BTC', T0 + 3 * MIN, vbFields()) // still ready later - must not create a second row
    ];
    const candles1m = tfRows(T0, MIN, [{ o: 100, h: 100.2, l: 99.9, c: 100.1 }, { o: 100.1, h: 100.3, l: 100, c: 100.2 }, { o: 100.2, h: 103.2, l: 100.1, c: 103.1 }]);
    const out = computeV3ShadowRows(rows, { BTC: candles1m });
    assertEqual(out.length, 1, 'one row for the one candidateId');
    assertEqual(out[0].readyAt, iso(T0 + 2 * MIN), 'keyed off the FIRST ready close, not a later one');
  });

  await test('computeV3ShadowRows: net R at the shipped flat 0.20% cost and the owner-answered per-direction cost (long 0.34%, short 0.14%)', () => {
    const longCandles = tfRows(T0, MIN, [{ o: 100, h: 100.2, l: 99.9, c: 100.1 }, { o: 100.1, h: 103.2, l: 100, c: 103.1 }]);
    const longRow = vbCaptureRow('BTC', T0, vbFields({ entry: 100, stop: 99, tp1: 103 }));
    const [longOut] = computeV3ShadowRows([longRow], { BTC: longCandles });
    assertEqual(longOut.outcome, 'tp1', 'long resolves to tp1');
    assertEqual(longOut.r, 3, 'gross R');
    assertEqual(longOut.netR, 2.8, 'flat 0.20% cost: 3 - 0.2');
    assertEqual(longOut.netRDirCost, 2.66, 'a long pays the 0.34% dir-cost rate: 3 - 0.34');

    const shortCandles = tfRows(T0, MIN, [{ o: 100, h: 100.1, l: 99.8, c: 99.9 }, { o: 99.9, h: 100, l: 96.9, c: 97 }]);
    const shortRow = vbCaptureRow('ETH', T0, vbFields({ candidateId: 'ETH:1m:short:v3a', direction: 'short', entry: 100, stop: 101, tp1: 97 }));
    const [shortOut] = computeV3ShadowRows([shortRow], { ETH: shortCandles });
    assertEqual(shortOut.outcome, 'tp1', 'short resolves to tp1');
    assertEqual(shortOut.netR, 2.8, 'flat 0.20% cost, same formula regardless of direction');
    assertEqual(shortOut.netRDirCost, 2.86, 'a short pays the cheaper 0.14% dir-cost rate: 3 - 0.14');
  });

  await test('computeV3ShadowRows: idempotent - a resolved row is kept byte-for-byte on a later run, an open one is re-walked', () => {
    const candles1m = tfRows(T0, MIN, [{ o: 100, h: 100.2, l: 99.9, c: 100.1 }, { o: 100.1, h: 103.2, l: 100, c: 103.1 }]);
    const row = vbCaptureRow('BTC', T0, vbFields());
    const first = computeV3ShadowRows([row], { BTC: candles1m }, [], T0 + 5 * MIN);
    assertEqual(first[0].outcome, 'tp1', 'resolved on the first run');
    const again = computeV3ShadowRows([row], { BTC: [] }, first, T0 + 60 * MIN); // no candles this time - would be wrong if re-walked
    assertEqual(JSON.stringify(again), JSON.stringify(first), 'resolved row kept exactly as written, never re-walked');
  });

  await test('v3ShadowSummary: n/resolvedN/winRate/grossExp/netExp/netExp-dirCost over a hand-built mix', () => {
    const rows = [
      { outcome: 'tp1', r: 3, netR: 2.8, netRDirCost: 2.66 },
      { outcome: 'stop', r: -1, netR: -1.2, netRDirCost: -1.34 },
      { outcome: 'open', r: null, netR: null, netRDirCost: null }
    ];
    const s = v3ShadowSummary(rows);
    assertEqual(s.n, 3, 'n counts every row, including open');
    assertEqual(s.resolvedN, 2, 'resolvedN is tp1+stop only');
    assertEqual(s.open, 1, 'open counted separately');
    assertEqual(s.winRate, 0.5, 'winRate over resolved only (fraction 0-1, matching build-page.js\'s pct())');
    assertEqual(s.grossExpectancyR, 1, '(3 + -1) / 2');
    assertEqual(s.netExpectancyR, 0.8, '(2.8 + -1.2) / 2');
    assertEqual(s.netExpectancyR_dirCost, 0.66, '(2.66 + -1.34) / 2');
  });

  await test('v3-shadow.js: v3ShadowDataDir end to end through the store, stable on rerun', () => {
    const dir = tmp();
    const candles1m = tfRows(T0, MIN, [
      { o: 100, h: 100.2, l: 99.9, c: 100.1 },
      { o: 100.1, h: 103.2, l: 100, c: 103.1 } // target touch
    ]);
    appendCandles(dir, '1m', toStoreCandles('BTC', candles1m));
    appendCalls(dir, [vbCaptureRow('BTC', T0, vbFields())]);
    const first = v3ShadowDataDir(dir, T0 + 60 * MIN);
    assert(existsSync(v3ShadowOutcomesFile(dir)) && existsSync(v3ShadowSummaryFile(dir)), 'both files written');
    assertEqual(first.rows.length, 1, 'one row for the one candidateId');
    assertEqual(first.rows[0].outcome, 'tp1', 'walked through the store to tp1');
    assertEqual(first.summary.n, 1, 'summary counts the one row');
    assertEqual(first.summary.resolvedN, 1, 'resolved');
    const again = v3ShadowDataDir(dir, T0 + 120 * MIN);
    assertEqual(JSON.stringify(again.rows), JSON.stringify(first.rows), 'rerun stable once resolved');
    assertEqual(readJsonl(v3ShadowOutcomesFile(dir)).length, first.rows.length, 'stored rows match');
  });

  // ---------------------------------------------------------------- T-13 net floor shadow (nf-shadow.js)

  const DAY = 24 * 60 * MIN;

  await test('nf-shadow: NF_RULE mirrors the LIVE engine floor (T-15, config/engine.json flagPlan.stopFloor); backfill floor/gates match lib/flagTradePlan.js', () => {
    const sf = ENGINE_CONFIG.flagPlan.stopFloor;
    assertEqual(`${NF_RULE.minRR}|${NF_RULE.minNetRR}|${NF_RULE.atrMult}|${NF_RULE.costMult}`, `${ENGINE_CONFIG.flagPlan.minRR}|${sf.minNetRR}|${sf.atrMult}|${sf.costMult}`, 'rule parity');
    for (const [dir, stop, tp1, atr] of [['long', 99.9, 104, 0.5], ['short', 100.1, 97, 0.5], ['long', 99.9, 104, 4], ['short', 100.02, 99.5, null]]) {
      const b = backfillNetFloor({ direction: dir, entry: 100, stop, tp1, atr15m: atr });
      const e = netFloorStopDistance({ direction: dir, entry: 100, stop, atr15m: atr, riskCfg: ENGINE_CONFIG.risk });
      const sign = dir === 'short' ? -1 : 1;
      assertEqual(b.stop, Math.round((100 - sign * e.distance) * 100) / 100, `${dir} stop parity`);
      assertEqual(b.floorPct, e.floorPct, `${dir} floorPct parity`);
      assertEqual(b.netRR, Math.round(netRiskReward(100, 100 - sign * e.distance, tp1, ENGINE_CONFIG.risk, dir) * 1000) / 1000, `${dir} netRR parity`);
    }
    const longTight = backfillNetFloor({ direction: 'long', entry: 100, stop: 99.9, tp1: 101, atr15m: 0.2 });
    assertEqual(`${longTight.ready}|${longTight.floorPct}|${longTight.grossRR}`, 'false|1.02|0.98', 'long: cost floor 1.02 % sinks a 1 % target');
    const shortOk = backfillNetFloor({ direction: 'short', entry: 100, stop: 100.1, tp1: 98, atr15m: 0.2 });
    assertEqual(`${shortOk.ready}|${shortOk.floorPct}|${shortOk.stop}`, 'true|0.42|100.42', 'short: 0.42 % floor, gross 4.76 ready');
  });

  await test('nf-shadow: atr15mAt reads only 15m candles closed by the ready moment; null under period + 1', () => {
    const c15 = tfRows(T0, 15 * MIN, Array.from({ length: 16 }, (_, i) => ({ o: 100, h: 101 + (i === 15 ? 50 : 0), l: 99, c: 100 })));
    assertEqual(atr15mAt(c15, T0 + 16 * 15 * MIN), atr15mAt(c15.slice(0, 16), T0 + 16 * 15 * MIN), 'all closed');
    assertEqual(atr15mAt(c15, T0 + 15 * 15 * MIN + 14 * MIN), 2, 'the still-open 16th candle (h+50) is ignored: TR 2 each');
    assertEqual(atr15mAt(c15.slice(0, 10), T0 + 30 * 15 * MIN), null, 'too few');
  });

  await test('nf-shadow: live ready calls from capture rows AND Telegram GOOD alerts, first ready moment per candidate, engine NF kept', () => {
    const plan = { candidateId: 'BTC:1m:long:nf1', status: 'ready', timeframe: '1m', direction: 'long', entry: 100, stop: 99.9, tp1: 104,
      shadow: { NF: { candidateId: 'BTC:1m:long:nf1', status: 'ready', ready: true, stop: 98.98, grossRR: 3.92, netRR: 2.69, stopPct: 1.02, floorPct: 1.02 } } };
    const rows = [candCaptureRow('BTC', T0 + 5 * MIN, [], null, { flagTradePlan: plan })];
    const alerts = [
      { kind: 'GOOD', candidateId: 'BTC:1m:long:nf1', symbol: 'BTC', timeframe: '1m', direction: 'long', entry: 100, stop: 99.9, tp1: 104, closedThrough: iso(T0 + 2 * MIN) },
      { kind: 'GOOD', candidateId: 'ETH:1m:short:nf2', symbol: 'ETH', timeframe: '1m', direction: 'short', entry: 100, stop: 100.1, tp1: 98, closedThrough: iso(T0 + 3 * MIN) },
      { kind: 'SETUP', candidateId: 'SOL:3m:long:x', symbol: 'SOL', closedThrough: iso(T0) }
    ];
    const calls = liveReadyCalls(rows, alerts);
    assertEqual(calls.map((c) => c.candidateId).join(), 'BTC:1m:long:nf1,ETH:1m:short:nf2', 'GOOD alerts only, deduped');
    assertEqual(calls[0].readyAt, iso(T0 + 2 * MIN), 'earliest ready (the per-minute alert beat the 10-minute capture)');
    assert(calls[0].engineNF && calls[0].engineNF.stop === 98.98, 'engine NF from the capture row kept');
  });

  await test('nf-shadow: rows walk live and NF legs; engine vs backfill labelled; summary side by side; idempotent through the store', () => {
    const dir = tmp();
    // Long: live stop 0.1 % (stopped), NF floor 1.02 % gross 3.92 -> NF ready, survives the dip, reaches TP1.
    const btc = tfRows(T0, MIN, [{ o: 100, h: 100.05, l: 99.8, c: 99.9 }, { o: 99.9, h: 104.1, l: 99.9, c: 104 }]);
    // Short: live stop 0.1 %, NF 0.42 %, TP1 98 -> both hit TP1.
    const eth = tfRows(T0, MIN, [{ o: 100, h: 100.05, l: 97.9, c: 98 }]);
    appendCandles(dir, '1m', [...toStoreCandles('BTC', btc), ...toStoreCandles('ETH', eth)]);
    const plan = { candidateId: 'BTC:1m:long:nf1', status: 'ready', timeframe: '1m', direction: 'long', entry: 100, stop: 99.9, tp1: 104,
      shadow: { NF: { candidateId: 'BTC:1m:long:nf1', status: 'ready', ready: true, stop: 98.98, grossRR: 3.92, netRR: 2.69, stopPct: 1.02, floorPct: 1.02 } } };
    appendCalls(dir, [candCaptureRow('BTC', T0, [], null, { flagTradePlan: plan })]);
    appendTelegramAlerts(dir, [{ id: 'a1', sentAt: iso(T0), kind: 'GOOD', candidateId: 'ETH:1m:short:nf2', symbol: 'ETH', timeframe: '1m', direction: 'short', entry: 100, stop: 100.1, tp1: 98, closedThrough: iso(T0) }]);
    const first = nfShadowDataDir(dir, T0 + DAY);
    assert(existsSync(nfShadowOutcomesFile(dir)) && existsSync(nfShadowSummaryFile(dir)), 'both files written');
    const [b, e] = first.rows;
    assertEqual(`${b.nfSource}|${b.live.outcome}|${b.nf.ready}|${b.nf.outcome}|${b.nf.stop}`, 'engine|stop|true|tp1|98.98', 'BTC: live stopped, NF rode it out');
    assertEqual(`${e.nfSource}|${e.atrSource}|${e.live.outcome}|${e.nf.ready}|${e.nf.outcome}|${e.nf.stop}`, 'backfill|none|tp1|true|tp1|100.42', 'ETH: backfilled, cost floor only');
    assertEqual(b.live.netR, -4.4, 'live net: -1 - 0.34/0.1');
    assert(Math.abs(b.nf.netR - (4 / 1.02 - 0.34 / 1.02)) < 0.001, `NF net: 3.92 - 0.33, got ${b.nf.netR}`);
    const sm = first.summary;
    assertEqual(`${sm.n}|${sm.live.calls}|${sm.nf.calls}|${sm.engineRows}|${sm.backfillRows}`, '2|2|2|1|1', 'counts');
    assertEqual(sm.live.winRate, 0.5, 'live win rate');
    assertEqual(sm.nf.winRate, 1, 'NF win rate');
    assertEqual(sm.live.callsPerDay, 2, 'calls per day over one day');
    const again = nfShadowDataDir(dir, T0 + 2 * DAY);
    assertEqual(JSON.stringify(again.rows), JSON.stringify(first.rows), 'terminal rows kept as written');
    assertEqual(nfShadowSummary([]).n, 0, 'empty summary');
    void computeNfShadowRows;
  });

  await test('page + report: NF shadow tile (live vs NF rows, last calls) and report section; empty state from an empty data dir', () => {
    const empty = tmp();
    const e = readFileSync(buildPage(path.join(empty, 'data'), path.join(empty, 'docs'), T0).htmlFile, 'utf8');
    assert(e.includes('id="nf-shadow-section"') && e.includes('id="nf-shadow-empty"'), 'empty tile');
    assert(e.indexOf('id="v3-shadow-section"') < e.indexOf('id="nf-shadow-section"'), 'placed after the 3R shadow');
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    writeJson(nfShadowSummaryFile(dataDir), { generatedAt: iso(T0), n: 2, spanDays: 1, engineRows: 1, backfillRows: 1,
      live: { calls: 2, callsPerDay: 2, fills: 2, resolvedN: 2, winRate: 0.5, grossExpectancyR: 1.5, netExpectancyR: -1.2 },
      nf: { calls: 1, callsPerDay: 1, fills: 1, resolvedN: 1, winRate: 1, grossExpectancyR: 3.9, netExpectancyR: 3.6 } });
    writeJsonl(nfShadowOutcomesFile(dataDir), [{ candidateId: 'BTC:1m:long:nf1', symbol: 'BTC', timeframe: '1m', direction: 'long', readyAt: iso(T0), source: 'capture', entry: 100, tp1: 104,
      live: { stop: 99.9, outcome: 'stop', r: -1, netR: -4.4, filled: true, stopPct: 0.1 }, nf: { ready: true, stop: 98.98, outcome: 'tp1', r: 3.92, netR: 3.59, floorPct: 1.02 }, nfSource: 'engine' }]);
    const { htmlFile, mdFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['nf-shadow-summary-table', 'nf-shadow-list-table', 'nf-shadow-sample-note']) assert(html.includes(`id="${id}"`), `missing #${id}`);
    assert(html.includes('NF (live since 2026-09-27)') && html.includes('Live (own stop)'), 'side by side rows');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes('## Net floor · NF (live since 2026-09-27)') && md.includes('| NF | 1 | 1 | 1 | 100% |'), md.slice(md.indexOf('## Net floor')));
  });

  await test('page: breakout-shadow tile renders with ids and the empty state from an empty data dir', () => {
    const dir = tmp();
    const { htmlFile } = buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    for (const id of ['breakout-shadow-section', 'breakout-shadow-empty', 'v3-shadow-section', 'v3-shadow-empty']) assert(html.includes(`id="${id}"`), `missing #${id}`);
    assert(html.includes(NO_SHADOW), 'empty state text');
    assert(html.includes(NO_V3_SHADOW), '3R shadow empty state text');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'one provisional tag per section (shadow tiles included)');
    assert(html.indexOf('id="path-calibration-section"') < html.indexOf('id="breakout-shadow-section"'), 'placed next to path calibration in the performance zone');
    assert(html.indexOf('id="breakout-shadow-section"') < html.indexOf('id="v3-shadow-section"'), '3R shadow placed right after breakout-entry shadow');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assertEqual(scripts.filter((t) => !/type="application\/json"/.test(t)).length, 1, 'still exactly one executable inline script');
  });

  await test('page: v3-shadow tile shows TOO FEW CALLS under n=20 and lists last entries', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const summary = { generatedAt: iso(T0), n: 5, resolvedN: 5, open: 0, expired: 0, winRate: 0.4, grossExpectancyR: 0.2, netExpectancyR: 0, netExpectancyR_dirCost: -0.1 };
    writeJson(v3ShadowSummaryFile(dataDir), summary);
    const rows = [{
      candidateId: 'BTC:1m:long:v3a', symbol: 'BTC', timeframe: '1m', direction: 'long', readyAt: iso(T0),
      entry: 100, stop: 99, tp1: 103, grossRR: 2.9, netRR: 2.25, outcome: 'tp1', r: 2.9, netR: 2.7, netRDirCost: 2.56,
      resolvedAt: iso(T0 + 10 * MIN), computedAt: iso(T0)
    }];
    writeJsonl(v3ShadowOutcomesFile(dataDir), rows);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="v3-shadow-summary-table"'), 'summary table renders');
    assert(html.includes(V3_SHADOW_TOO_FEW), 'n=5 < 20 -> too few calls shown');
    assert(html.includes('id="v3-shadow-list-table"'), 'last-entries list renders');
    assert(html.includes('>BTC<'), 'row shows symbol');
    assert(html.includes('>tp1<'), 'row shows outcome');
    assert(html.includes('Net exp. (dir-cost)'), 'summary table carries the dir-cost column');
  });

  await test('page: v3-shadow tile shows numeric win rate once a stat reaches n=V3_SHADOW_MIN_N', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const summary = { generatedAt: iso(T0), n: 20, resolvedN: 20, open: 0, expired: 0, winRate: 0.55, grossExpectancyR: 0.3, netExpectancyR: 0.15, netExpectancyR_dirCost: 0.05 };
    writeJson(v3ShadowSummaryFile(dataDir), summary);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('55%'), 'win rate shown numerically at n=20, not TOO FEW CALLS');
    assert(!html.includes(V3_SHADOW_TOO_FEW), 'nothing in this fixture is below the threshold');
    assert(html.includes('+0.05R'), 'net exp. (dir-cost) shown numerically once n=V3_SHADOW_MIN_N');
  });

  function shadowLegStats(n, wins, losses, open, winRate, expectancy, maxLosingStreak, netExpectancy = null) {
    return { n, wins, losses, open, winRate, expectancy, netExpectancy, maxLosingStreak };
  }

  await test('page: breakout-shadow tile shows TOO FEW CALLS under n=30 and lists last entries', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const summary = {
      generatedAt: iso(T0), n: 3,
      shadow: {
        overall: shadowLegStats(3, 1, 2, 0, 0.3333, 0.3333, 2),
        byChase: { highElevated: shadowLegStats(2, 1, 1, 0, 0.5, 1, 1), lowUnknown: shadowLegStats(1, 0, 1, 0, 0, -1, 1) }
      },
      retest: {
        overall: shadowLegStats(0, 0, 0, 0, null, null, 0),
        byChase: { highElevated: shadowLegStats(0, 0, 0, 0, null, null, 0), lowUnknown: shadowLegStats(0, 0, 0, 0, null, null, 0) }
      }
    };
    writeJson(shadowSummaryFile(dataDir), summary);
    const shadowRows = [{
      candidateId: 'BTC:5m:long:x', symbol: 'BTC', tf: '5m', direction: 'long', breakoutAt: T0, retestAt: null,
      chase: 'high', chaseSource: 'engine',
      shadow: { entry: 100, stop: 99, tp1: 104, grossRR: 4, netRR: 3.8, outcome: 'tp1', r: 4, resolvedAt: T0 + 10 * MIN, minutes: 10 },
      retest: null, status: 'resolved', computedAt: iso(T0)
    }];
    writeJsonl(shadowOutcomesFile(dataDir), shadowRows);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="breakout-shadow-summary-table"'), 'summary table renders');
    assert(html.includes(SHADOW_TOO_FEW), 'n=3 < 30 -> too few calls shown');
    assert(html.includes('id="breakout-shadow-list-table"'), 'last-entries list renders');
    assert(html.includes('>BTC<'), 'row shows symbol');
    assert(html.includes('>tp1<'), 'row shows outcome');
    assert(html.includes('Net exp. (net of fees)'), 'shadow summary table carries a net-of-fees column beside gross (T5 S1)');
    assertEqual((html.match(/class="prov-tag"/g) || []).length, (html.match(/<section /g) || []).length, 'still one provisional tag per section');
  });

  await test('page: breakout-shadow tile shows numeric win rate once a stat reaches n=SHADOW_MIN_N', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const summary = {
      generatedAt: iso(T0), n: 30,
      shadow: { overall: shadowLegStats(30, 15, 15, 0, 0.5, 0.1, 3, 0.05), byChase: { highElevated: shadowLegStats(0, 0, 0, 0, null, null, 0), lowUnknown: shadowLegStats(0, 0, 0, 0, null, null, 0) } },
      retest: { overall: shadowLegStats(0, 0, 0, 0, null, null, 0), byChase: { highElevated: shadowLegStats(0, 0, 0, 0, null, null, 0), lowUnknown: shadowLegStats(0, 0, 0, 0, null, null, 0) } }
    };
    writeJson(shadowSummaryFile(dataDir), summary);
    const { htmlFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('50%'), 'win rate shown numerically at n=30, not TOO FEW CALLS');
    assert(!html.includes(SHADOW_TOO_FEW), 'nothing in this fixture is below the threshold');
    assert(html.includes('+0.05R'), 'net expectancy shown numerically beside gross once n=SHADOW_MIN_N (T5 S1)');
  });

  await test('parseArgs: --data default ./data, --out default ./docs', () => {
    assertEqual(parseArgs([]).data, './data', 'data default');
    assertEqual(parseArgs([]).out, './docs', 'out default');
    assertEqual(parseArgs(['--data', '/x', '--out', '/y']).out, '/y', 'out');
  });

  // ---- system map + changelog page (changelog-page.js, build-changelog.js) ----
  const MAP_FIXTURE = {
    version: '9.9.9', updatedAt: '2026-09-19',
    stages: [
      { id: 'market-data', title: 'Market data', purpose: 'Candles in.', modules: [
        { path: 'services/marketData.js', name: 'marketData', role: 'Fetches candles.', publishes: ['price'], consumes: ['Kraken OHLC'], tests: ['test:scalp'], since: '2025-11-26', schemaSince: null },
        { path: 'lib/pythMark.js', name: 'pythMark', role: 'Reads the mark.', publishes: ['mark'], consumes: ['price'], tests: ['test:mark'], since: '2026-09-15', schemaSince: '1.16.0' }
      ] },
      { id: 'delivery', title: 'Delivery', purpose: 'Serves it.', modules: [
        { path: 'services/scalpContext.js', name: 'scalpContext', role: 'Builds the payload.', publishes: ['schemaVersion', 'symbols'], consumes: ['price', 'mark'], tests: ['test:scalp'], since: '2026-09-21', schemaSince: '1.0.0' }
      ] },
      { id: 'legacy', title: 'Off the live path', purpose: 'Old code.', offPath: true, modules: [
        { path: 'lib/levels.js', name: 'levels', role: 'Old levels.', publishes: [], consumes: [], tests: [], since: '2025-11-26', schemaSince: null }
      ] }
    ],
    flows: [{ from: 'marketData', to: 'scalpContext', label: 'candles' }],
    outputs: [{ name: 'REST payload', where: 'REST', fields: ['schemaVersion', 'price', 'mark', 'mystery'] }]
  };
  const CHANGELOG_FIXTURE = [
    '# Changelog', '',
    '## 2026-09-18 — Older entry', '', 'Body of the older one.', '',
    '## 2026-09-20 — Newer entry with `code` (branch `x`)', '',
    'Schema 1.22.0 → **1.23.0**, configVersion 2026.09.24-2 → 2026.09.24-3.', '',
    '- **bold** item', '  continued line', '- second [docs](https://example.com/a?b=1&c=2)', '',
    '### Sub heading', '', '```', '<raw> & code', '```', '',
    '## Previous Updates', '', 'No date here.'
  ].join('\n');
  const NOW = Date.parse('2026-09-20T12:00:00Z');

  await test('changelog page: isNew is true within NEW_DAYS of since, false outside or on bad input', () => {
    assertEqual(NEW_DAYS, 14, 'NEW window is 14 days');
    assert(isNew('2026-09-20', NOW), 'same day is new');
    assert(isNew('2026-09-07', NOW), '13.5 days old is new');
    assert(!isNew('2026-09-06', NOW), '14.5 days old is not new');
    assert(!isNew('2025-11-26', NOW), 'old module is not new');
    assert(!isNew('soon', NOW) && !isNew(null, NOW), 'bad date is not new');
    assert(!isNew('2026-10-20', NOW), 'far-future since is not new');
  });

  await test('changelog page: markdown subset renders headings, lists, bold, code, links and escapes the rest', () => {
    const html = renderMarkdown('# Head\n\nPara **bold** and `a<b>` and [x](https://e.com/?q=1&r=2).\n\n- one\n  two\n- [bad](javascript:alert(1))\n\n1. first\n2. second\n\n<script>x</script>');
    assert(html.includes('<h4 class="md-h">Head</h4>'), 'heading');
    assert(html.includes('<strong>bold</strong>'), 'bold');
    assert(html.includes('<code>a&lt;b&gt;</code>'), 'code is escaped');
    assert(html.includes('<a class="nav-link" href="https://e.com/?q=1&amp;r=2">x</a>'), 'safe link rendered with escaped href');
    assert(html.includes('<li>one two</li>'), 'indented continuation joins the list item');
    assert(!html.includes('javascript:'), 'javascript: link dropped to its label');
    assert(html.includes('<ol><li>first</li><li>second</li></ol>'), 'ordered list');
    assert(html.includes('&lt;script&gt;') && !html.includes('<script>'), 'raw HTML escaped');
    assertEqual(renderInline('**`x`**'), '<strong><code>x</code></strong>', 'code inside bold');
  });

  await test('changelog page: parseChangelog orders newest first and reads schema/config deltas', () => {
    const e = parseChangelog(CHANGELOG_FIXTURE);
    assertEqual(e.length, 3, 'three entries');
    assertEqual(e.map((x) => x.date).join(','), '2026-09-20,2026-09-18,', 'newest first, undated last');
    assertEqual(e[0].title, 'Newer entry with `code` (branch `x`)', 'title strips date and dash');
    assertEqual(JSON.stringify(e[0].schema), JSON.stringify({ from: '1.22.0', to: '1.23.0' }), 'schema delta through bold');
    assertEqual(JSON.stringify(e[0].config), JSON.stringify({ from: '2026.09.24-2', to: '2026.09.24-3' }), 'config delta');
    assertEqual(e[1].schema, null, 'no delta when none stated');
    assertEqual(e[2].title, 'Previous Updates', 'undated heading keeps its title');
    assertEqual(parseChangelog('').length, 0, 'empty changelog');
  });

  await test('changelog page: renders the board, module list, NEW tags, outputs and consistency strip from a map fixture', () => {
    const html = renderChangelogPage({
      map: MAP_FIXTURE, changelog: CHANGELOG_FIXTURE, nowMs: NOW,
      verify: { checkedAt: '2026-09-20T10:00:00.000Z', files: 89, ok: true },
      versions: { schemaVersion: '1.23.0', configVersion: '2026.09.24-4', capturedAt: '2026-09-20T11:50:00.000Z' }
    });
    assert(html.includes('id="map-board-wide"') && html.includes('id="map-board-narrow"'), 'both board layouts');
    assert(html.includes(`@media (min-width:${BOARD_BREAKPOINT}px){.board-wide{display:block}.board-narrow{display:none}}`), 'CSS picks one layout');
    assert(html.includes('id="board-card-marketdata"') && html.includes('id="board-card-pythmark"') && html.includes('id="board-card-scalpcontext"'), 'module cards');
    assert(!html.includes('board-card-levels'), 'off-path module not on the board');
    assert(html.includes('id="board-flow-marketdata-scalpcontext"'), 'map flow drawn as a line');
    assert(html.includes('id="board-flow-lane-market-data-scalpcontext"') === false, 'lane with an explicit engine flow gets no lane drop');
    assert(html.includes('id="board-card-output-rest-payload"') && html.includes('id="board-flow-scalpcontext-output-rest-payload"'), 'fallback outputs from map.outputs, fed by the engine');
    assert(html.includes('id="board-card-pythmark" data-card="pythMark" data-new="true"') && html.includes('id="board-card-marketdata" data-card="marketData" data-new="false"'), 'NEW only within NEW_DAYS');
    assertEqual((html.match(/class="new-tag"/g) || []).length, 2, 'NEW on pythMark and scalpContext only in the module list');
    assert(html.includes('id="map-module-market-data-pythmark-publishes"') && html.includes('<li class="chip in">price</li>'), 'publishes/consumes chips in the module list');
    assert(html.includes('href="#map-board-zone">Board<'), 'nav says Board');
    assert(html.includes('tests test:mark'), 'tests listed');
    assert(html.includes('id="map-offpath-legacy-tile"') && html.includes('Old levels.'), 'off-path modules in their own tile');
    assert(html.includes('id="map-output-rest-payload-tile"'), 'output tile');
    assert(html.includes('id="map-output-rest-payload-tile-delivery"') && html.includes('id="map-output-rest-payload-tile-other"'), 'fields grouped by publishing stage, unknown -> Other');
    assert(html.includes('id="map-version-schema">1.23.0<') && html.includes('2026.09.24-4'), 'current versions shown');
    assert(html.includes('Map <b>9.9.9</b>') && html.includes('Updated <b>2026-09-19</b>') && html.includes('Last changelog <b>2026-09-20</b>'), 'consistency strip');
    assert(html.includes('2026-09-20 OK</b> · 89 files'), 'verify stamp');
    assert(html.includes('Schema 1.22.0 → 1.23.0'), 'changelog delta chip');
    assert(html.indexOf('Newer entry') < html.indexOf('Older entry'), 'timeline newest first');
    assert(html.includes('&lt;raw&gt; &amp; code'), 'fenced code escaped');
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    assertEqual(scripts.length, 1, 'one inline script (board highlight only)');
    assert(scripts[0].split('\n').length <= 60 && !/fetch|XMLHttpRequest|src=/.test(scripts[0]), 'highlight script is small and offline');
    assert(html.includes('prefers-color-scheme: dark'), 'both color schemes');
    assert(html.includes('href="index.html"') && html.includes('href="how-to.html"'), 'nav to the other pages');
  });

  await test('changelog page: groupFields assigns each field to the first publishing stage', () => {
    const g = groupFields(['price', 'symbols', 'nope'], MAP_FIXTURE.stages);
    assertEqual(JSON.stringify(g), JSON.stringify([['Market data', ['price']], ['Delivery', ['symbols']], ['Other', ['nope']]]), 'grouping');
  });

  await test('changelog page: empty map / changelog / verify / capture render bracketed empty states', () => {
    const html = renderChangelogPage({ map: null, changelog: '', nowMs: NOW });
    for (const s of [NO_MAP, NO_ENTRIES, NO_VERIFY, NO_CAPTURE]) assert(html.includes(s), `shows ${s}`);
    assert(html.includes(NO_BOARD) && !html.includes('<svg class="board') && !html.includes('<script>'), 'empty map -> [NO MAP YET], no board, no script');
    assertEqual(boardModel(null, NOW), null, 'no model without a map');
    const bad = renderChangelogPage({ map: { stages: [] }, changelog: CHANGELOG_FIXTURE, nowMs: NOW });
    assert(bad.includes(NO_MAP), 'a map without stages counts as empty');
  });

  await test('build-changelog: reads data/engine + newest capture row, writes docs/changelog.html; empty data dir still builds', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const outDir = path.join(dir, 'docs');
    const empty = buildChangelog(dataDir, outDir, NOW);
    assert(readFileSync(empty.file, 'utf8').includes(NO_MAP), 'empty data dir -> empty-state page');
    assertEqual(JSON.stringify(latestVersions(dataDir)), JSON.stringify({ schemaVersion: null, configVersion: null, capturedAt: null }), 'no calls -> null versions');
    writeJson(path.join(dataDir, 'engine', 'ARCHITECTURE_MAP.json'), MAP_FIXTURE);
    writeJson(path.join(dataDir, 'engine', 'ARCHITECTURE_MAP.verify.json'), { checkedAt: '2026-09-20T10:00:00.000Z', files: 3, ok: false });
    writeFileSync(path.join(dataDir, 'engine', 'CHANGELOG.md'), CHANGELOG_FIXTURE);
    writeJsonl(path.join(dataDir, 'calls', '2026-09-19.jsonl'), [{ capturedAt: 'a', schemaVersion: '1.22.0', configVersion: 'c1' }]);
    writeJsonl(path.join(dataDir, 'calls', '2026-09-20.jsonl'), [{ capturedAt: 'b', schemaVersion: '1.23.0', configVersion: 'c2' }, { capturedAt: 'c', schemaVersion: '1.23.0', configVersion: 'c3' }]);
    assertEqual(latestVersions(dataDir).configVersion, 'c3', 'newest row of the newest day');
    const html = readFileSync(buildChangelog(dataDir, outDir, NOW).file, 'utf8');
    assert(html.includes('Map <b>9.9.9</b>') && html.includes('id="map-version-config">c3<'), 'map + versions read');
    assert(html.includes('FAILED'), 'a failed verify run is shown, not hidden');
  });

  await test('changelog page: the real engine map renders every module and both site pages link to it', () => {
    const map = JSON.parse(readFileSync('docs/ARCHITECTURE_MAP.json', 'utf8'));
    const html = renderChangelogPage({ map, changelog: readFileSync('CHANGELOG.md', 'utf8'), nowMs: NOW });
    for (const m of map.stages.flatMap((s) => s.modules)) assert(html.includes(`>${m.path.replace(/&/g, '&amp;')} · since`), `module ${m.path} rendered`);
    const slugOf = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (const s of map.stages) {
      for (const m of s.modules) {
        const on = [`id="board-card-${slugOf(m.name)}"`, `id="board-narrow-card-${slugOf(m.name)}"`].map((id) => html.includes(id));
        assert(s.offPath ? !on[0] && !on[1] : on[0] && on[1], `${m.name} ${s.offPath ? 'off' : 'on'} the board in both layouts`);
      }
    }
    for (const x of map.board.sources) assert(html.includes(`id="board-card-source-${x.id}"`), `source ${x.id} card`);
    for (const x of map.board.outputs) assert(html.includes(`id="board-card-output-${x.id}"`) && html.includes(`id="board-flow-scalpcontext-output-${x.id}"`), `output ${x.id} card + engine line`);
    for (const x of map.board.consumers) assert(html.includes(`id="board-card-consumer-${x.id}"`), `consumer ${x.id} card`);
    assert(html.includes('id="board-flow-consumer-tracker-output-calls"') && html.includes('class="flow tier-loop"'), 'tracker loops back to Calls, dotted');
    const model = boardModel(map, NOW);
    for (const fl of map.flows) assert(model.flows.some((x) => x.from === fl.from && x.to === fl.to), `map flow ${fl.from}->${fl.to} is on the board`);
    for (const mode of ['wide', 'narrow']) {
      const lay = layoutBoard(model, mode);
      assertEqual(lay.lines.length, model.flows.length, `${mode}: every flow routed`);
      const prefix = mode === 'wide' ? 'board-' : 'board-narrow-';
      for (const fl of model.flows) assert(html.includes(`id="${prefix}${fl.id}"`), `${mode}: line ${fl.id}`);
      for (const l of lay.lines) assert(l.pts.length >= 2 && l.pts.every(([x, y]) => x >= 0 && x <= lay.W && y >= 0 && y <= lay.H), `${mode}: ${l.id} stays inside the board`);
      for (const l of lay.lines) for (let i = 1; i < l.pts.length; i++) assert(l.pts[i][0] === l.pts[i - 1][0] || l.pts[i][1] === l.pts[i - 1][1], `${mode}: ${l.id} is orthogonal`);
    }
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((mm) => mm[1]);
    assertEqual(ids.length, new Set(ids).size, 'DOM ids are unique across both layouts');
    for (const t of ['CLOSED CANDLES', 'CLASS + REASONS', 'PLAN']) assert(html.includes(`>${t}</text>`), `bus label ${t}`);
    const dir = tmp();
    buildPage(path.join(dir, 'data'), path.join(dir, 'docs'), NOW);
    for (const f of ['index.html', 'how-to.html']) assert(readFileSync(path.join(dir, 'docs', f), 'utf8').includes('href="changelog.html"'), `${f} links to the system map`);
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log('\nTelegram sent-alert + transition logs\n');

  const D = '2026-09-24';
  const at = (hhmm, sec = 0) => `${D}T${hhmm}:${String(sec).padStart(2, '0')}.000Z`;
  const CA = 'BTC:3m:long:2026-09-24T14:00:00.000Z';
  const CB = 'ETH:5m:short:2026-09-24T13:50:00.000Z';
  const aLine = (id, sentAt, over = {}) => ({ id, sentAt, kind: 'TRIGGERING', event: null, symbol: 'BTC', timeframe: '3m', direction: 'long', candidateId: CA, signature: 'BTC|3m|long|84466.10',
    verdict: 'BE READY', etaMin: 2, breakout: 84466.1, invalidation: 84331.6, entry: 84466.1, stop: 84331.6, tp1: null, grossRR: null, netRR: null, roomR: null,
    closedThrough: at('14:07'), silent: false, level: 'watch', tracked: false, delivered: true, text: 'BTC 3m LONG · TRIGGERING', ...over });
  const tLine = (atIso, candidateId, from, to, planStatus = null, over = {}) => ({ at: atIso, closedThrough: atIso, symbol: candidateId.split(':')[0], timeframe: candidateId.split(':')[1], direction: candidateId.split(':')[2],
    candidateId, from, to, planStatus, planFrom: null, reasonCode: null, class: null, breakout: 1, invalidation: 0.5, measuredRR: 2.5, ...over });

  await test('telegram logs: pull both manifests into data/telegram-alerts + data/transitions, dedupe by id / candidateId+at, whitelist + strip', async () => {
    const dir = tmp();
    const base = 'https://store.public.blob.vercel-storage.com';
    const files = {
      [`${base}/telegram/alerts/manifest.json`]: JSON.stringify({ schemaVersion: 'telegram-alerts-manifest-1', baseUrl: base, days: [D] }),
      [`${base}/telegram/alerts/${D}.jsonl`]: [JSON.stringify({ ...aLine('a1', at('14:07', 21)), wallet: { address: 'x' }, extra: 'dropped' }), JSON.stringify(aLine('a2', at('14:12', 5), { verdict: 'GET IN NOW', kind: 'GOOD' })), '{torn'].join('\n'),
      [`${base}/telegram/transitions/manifest.json`]: JSON.stringify({ schemaVersion: 'telegram-transitions-manifest-1', baseUrl: base, days: [D] }),
      [`${base}/telegram/transitions/${D}.jsonl`]: [JSON.stringify(tLine(at('14:07'), CA, 'forming', 'triggering')), JSON.stringify(tLine(at('14:12'), CA, 'triggering', 'confirmed', 'ready'))].join('\n')
    };
    const fakeFetch = async (url) => { const t = files[url.split('?')[0]]; return t === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => t }; };
    const r1 = await pullTelegramLogs(dir, base, fakeFetch, 1);
    assert(r1.alerts.added === 2 && r1.transitions.added === 2, JSON.stringify(r1));
    const r2 = await pullTelegramLogs(dir, base, fakeFetch, 2);
    assert(r2.alerts.added === 0 && r2.alerts.duplicates === 2 && r2.transitions.duplicates === 2, JSON.stringify(r2));
    const stored = readTelegramAlerts(dir);
    assertEqual(Object.keys(stored[0]).join(), TELEGRAM_ALERT_FIELDS.join(), 'whitelisted keys');
    assert(!allText(dir).includes('address') && !allText(dir).includes('dropped'), 'strip');
    assertEqual(readTransitions(dir).length, 2, 'transitions stored');
    assert(existsSync(path.join(dir, 'telegram-alerts', `${D}.jsonl`)) && existsSync(path.join(dir, 'transitions', `${D}.jsonl`)), 'day files');
    const none = await pullTelegramLogs(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assert(none.alerts.days === 0 && none.transitions.added === 0, 'no manifest -> nothing');
    assertEqual(telegramAlertRowsFromLines([{ sentAt: at('14:00') }, { id: 'x', sentAt: 'nope' }]).length, 0, 'id + sentAt required');
    assertEqual(transitionRowsFromLines([{ at: at('14:00') }]).length, 0, 'candidateId required');
    assertEqual(appendTransitions(dir, [tLine(at('14:07'), CA, 'forming', 'triggering')]).duplicates, 1, 'store dedupe');
    assertEqual(appendTelegramAlerts(dir, [aLine('a1', at('14:07', 21))]).duplicates, 1, 'store dedupe by id');
  });

  await test('alert scoring on a synthetic day: latency from the timeframe close, outcome ladder, later GOOD, BE READY -> GET IN NOW, call join', () => {
    const alerts = [
      aLine('a1', at('14:07', 21)), // BE READY, CA; later ready at 14:12 (5 min) then TP1 hit 14:30
      aLine('a2', at('14:12', 5), { kind: 'TRACK', event: 'get_in_now', verdict: 'GET IN NOW', tracked: true, closedThrough: at('14:12') }),
      aLine('a3', at('14:30', 10), { kind: 'TRACK', event: 'tp1', verdict: null, tracked: true, closedThrough: at('14:30') }),
      aLine('b1', at('14:05', 40), { symbol: 'ETH', timeframe: '5m', direction: 'short', candidateId: CB, kind: 'WATCH', verdict: 'WAIT', closedThrough: at('14:05') }),
      aLine('d1', at('14:20', 3), { kind: 'DATA', symbol: null, timeframe: null, candidateId: null, verdict: null, closedThrough: at('14:20') })
    ];
    const transitions = [
      tLine(at('14:07'), CA, 'forming', 'triggering'),
      tLine(at('14:12'), CA, 'triggering', 'confirmed', 'ready'),
      tLine(at('14:10'), CB, 'forming', 'confirmed'),
      tLine(at('14:40'), CB, 'confirmed', 'gone')
    ];
    const outcomes = [{ callId: 'plan|BTC|x', kind: 'plan', planStatus: 'ready', candidateId: CA, calledAt: at('14:12'), outcome: 'tp1', r: 2.6, resolvedAt: at('14:29') }];
    const nowMs = Date.parse(`${D}T20:00:00.000Z`);
    const rows = scoreAlerts(alerts, transitions, outcomes, nowMs);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assertEqual(alertLatencyMin(alerts[0]), 1.4, '3m close 14:06 -> sent 14:07:21');
    assertEqual(by.b1.latencyMin, 0.7, '5m close 14:05 -> 14:05:40');
    assert(by.a1.outcome === 'tp1' && by.a1.laterGood === true && by.a1.readyAfterMin === 4.7 && by.a1.callId === 'plan|BTC|x' && by.a1.callOutcome === 'tp1' && by.a1.callR === 2.6, JSON.stringify(by.a1));
    assert(by.a2.outcome === 'tp1', `a2 ${by.a2.outcome}`);
    assert(by.b1.outcome === 'confirmed' && by.b1.laterGood === false && by.b1.callId === null, JSON.stringify(by.b1));
    assert(by.d1.outcome === null && by.d1.laterGood === null && by.d1.latencyMin === 0.1, JSON.stringify(by.d1));
    const fresh = scoreAlerts([aLine('p1', at('19:59'))], [], [], nowMs)[0];
    assertEqual(fresh.outcome, 'pending', 'inside 24 h, nothing yet');
    assertEqual(scoreAlerts([aLine('p1', at('00:01'))], [], [], nowMs + 2 * 86_400_000)[0].outcome, 'none', 'window closed');
    const agg = computeAlertAggregates(rows, transitions, nowMs);
    assert(agg.tiles.alerts7d === 5 && agg.tiles.medianLatencyMin === 0.2 && agg.tiles.laterGoodN === 2 && agg.tiles.laterGoodRate === 0.5, JSON.stringify(agg.tiles));
    assert(agg.tiles.beReadyN === 1 && agg.tiles.beReadyToGoRate === 1, JSON.stringify(agg.tiles));
    assertEqual(JSON.stringify(agg.tiles.transitionsPerHour), '{"3m":0.34,"5m":0.34}', 'per hour over the 5.9 h logged');
    assertEqual(agg.byDay[0].day, D, 'day row');
    assert(agg.byDay[0].alerts === 5 && agg.byDay[0].byKind.TRACK === 2 && agg.byDay[0].byVerdict['BE READY'] === 1 && agg.byDay[0].transitions === 4, JSON.stringify(agg.byDay[0]));
    // Data dir round trip.
    const dir = tmp();
    appendTelegramAlerts(dir, alerts);
    appendTransitions(dir, transitions);
    writeJsonl(outcomesFile(dir), outcomes);
    assertEqual(scoreAlertsDataDir(dir, nowMs).length, 5, 'written');
    assertEqual(readJsonl(alertOutcomesFile(dir)).length, 5, 'alert-outcomes.jsonl');
    const full = aggregateDataDir(dir, nowMs);
    assertEqual(full.alerts.tiles.alerts7d, 5, 'aggregates.json carries alerts');
  });

  await test('page Alerts zone: renders from empty data, jump nav + Status Alerts link, filled tiles and daily table', () => {
    const empty = alertsZoneTiles(computeAlertAggregates([], [], T0)).join('');
    for (const f of ['id="tile-alerts-7d"', 'id="tile-alert-latency"', 'id="tile-alert-later-good"', 'id="tile-be-ready-to-go"', NO_TRANSITIONS, NO_ALERT_LOG, 'PROVISIONAL']) assert(empty.includes(f), `empty missing ${f}`);
    const dir = tmp();
    const { htmlFile } = buildPage(dir, path.join(dir, 'docs'), T0);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="zone-alerts"') && html.includes('href="#zone-alerts">Alerts</a>') && html.includes('id="system-alerts-fact-link" href="#zone-alerts"'), 'zone + links');
    const agg = computeAlertAggregates(scoreAlerts([aLine('a1', at('14:07', 21))], [tLine(at('14:07'), CA, 'forming', 'triggering')], [], T0 + 5 * 86_400_000), [tLine(at('14:07'), CA, 'forming', 'triggering')], Date.parse(`${D}T15:00:00.000Z`));
    const filled = alertsZoneTiles(agg).join('');
    assert(filled.includes('id="alerts-daily-table"') && filled.includes('TRIGGERING 1') && filled.includes('id="alerts-transitions-3m-row"'), filled);
  });

  console.log('\nGOOD calls from the 1-minute alert log (T-12)\n');

  const gLine = (id, sentAt, over = {}) => ({
    id, sentAt, kind: 'GOOD', event: null, symbol: 'BTC', timeframe: '1m', direction: 'long', candidateId: 'BTC:1m:long:X',
    signature: 'BTC|1m|long|100', verdict: 'GET IN NOW', etaMin: null, breakout: 100, invalidation: 99, entry: 100, stop: 99, tp1: 103,
    grossRR: 3, netRR: 2.8, roomR: null, closedThrough: sentAt, silent: false, level: 'good', tracked: false, delivered: true, text: 'BTC GOOD', ...over
  });
  const gEnded = (id, sentAt, symbol = 'BTC') => ({
    id, sentAt, kind: 'GOOD_ENDED', event: null, symbol, timeframe: null, direction: null, candidateId: null,
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: null, stop: null, tp1: null,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, silent: false, level: 'good', tracked: false, delivered: true, text: `${symbol} GOOD ENDED`
  });

  await test('collect.js: goodCallsFromAlertLines / goodCallsFromCaptureRows / mergeGoodCalls - first line per symbol+candidateId, earlier calledAt wins, capture levels fill gaps only, no duplicates', () => {
    const CID = 'BTC:1m:long:2026-09-24T14:00:00.000Z';
    const alerts = [
      gLine('g1', at('14:03'), { candidateId: CID }),
      gLine('g2', at('14:04'), { candidateId: CID }), // repeat send (TRACK/NUDGE-style) - ignored, first sighting is the call
      gLine('g3', at('14:10'), { candidateId: 'ETH:1m:short:X', symbol: 'ETH', direction: 'short', entry: null, stop: null, tp1: null }) // alert line carried no levels
    ];
    const alertCalls = goodCallsFromAlertLines(alerts);
    assertEqual(alertCalls.length, 2, 'one per symbol+candidateId, first line only');
    const btcAlert = alertCalls.find((c) => c.symbol === 'BTC');
    assertEqual(btcAlert.calledAt, at('14:03'), 'first GOOD line is the call');
    assertEqual(btcAlert.entry, 100, 'levels come from the alert line');
    const ethAlert = alertCalls.find((c) => c.symbol === 'ETH');
    assertEqual(ethAlert.entry, null, 'this alert line carried no levels');

    const captureRows = [
      captureRow('BTC', Date.parse(at('14:07')), plan({ candidateId: CID, entry: 100, stop: 99, tp1: 103 }), rec('GOOD', { candidateId: CID })),
      captureRow('ETH', Date.parse(at('14:20')), plan({ candidateId: 'ETH:1m:short:X', direction: 'short', entry: 50, stop: 51, tp1: 47 }), rec('GOOD', { candidateId: 'ETH:1m:short:X' }))
    ];
    const captureCalls = goodCallsFromCaptureRows(captureRows);
    assertEqual(captureCalls.length, 2, 'one per symbol+candidateId from captures');
    assertEqual(captureCalls.find((c) => c.symbol === 'BTC').calledAt, at('14:07'), 'capture close is the calledAt');

    const merged = mergeGoodCalls(alertCalls, captureCalls);
    assertEqual(merged.length, 2, 'no duplicates - one row per symbol+candidateId');
    const btc = merged.find((c) => c.symbol === 'BTC');
    assertEqual(btc.calledAt, at('14:03'), 'earlier (alert) calledAt wins');
    assertEqual(JSON.stringify(btc.sources), '["alert-1m","capture"]', 'both sources recorded');
    assertEqual(btc.entry, 100, 'alert levels kept - it had its own');
    const eth = merged.find((c) => c.symbol === 'ETH');
    assertEqual(eth.calledAt, at('14:10'), 'earlier (alert) calledAt wins even though that line had no levels');
    assertEqual(eth.entry, 50, 'capture levels used only because the alert line had none');
    assertEqual(JSON.stringify(eth.sources), '["alert-1m","capture"]', 'both sources recorded');

    const captureOnly = mergeGoodCalls([], captureCalls);
    assertEqual(captureOnly.length, 2, 'capture-only fallback when there are no alert calls at all');
    assert(captureOnly.every((c) => JSON.stringify(c.sources) === '["capture"]'), 'sources is capture-only');
  });

  await test('score.js: scoreGoodCalls walks a merged GOOD call prefilled from its own calledAt (tp1/stop), and no_levels when neither source has levels', () => {
    const calledAt = at('14:03');
    const cs = candles(Date.parse(calledAt), 3, (i) => (i < 2 ? { h: 100.2, l: 99.8 } : { h: 103.5, l: 100 })); // TP1 (103) touched on candle 2
    const call = { symbol: 'BTC', candidateId: 'BTC:1m:long:X', calledAt, direction: 'long', entry: 100, stop: 99, tp1: 103, sources: ['alert-1m'] };
    const rows = scoreGoodCalls([call], { BTC: cs }, new Map(), [], Date.parse(calledAt) + 10 * MIN);
    assertEqual(rows.length, 1, 'one scored row');
    const row = rows[0];
    assertEqual(row.callId, goodCallId(call), 'callId shape good|symbol|candidateId');
    assertEqual(row.outcome, 'tp1', 'walked to tp1');
    assertEqual(row.r, 3, 'gross R = |tp1-entry|/|entry-stop|');
    assertEqual(row.filledAt, calledAt, 'prefilled at calledAt, same treatment as a captured ready plan');
    assertEqual(row.levelSource, 'plan', 'GOOD calls always score off real levels, never counterfactual');
    assertEqual(row.class, 'GOOD', 'carries class GOOD for classCheck');

    const noLevels = scoreGoodCalls(
      [{ symbol: 'ETH', candidateId: 'ETH:1m:short:X', calledAt, direction: 'short', entry: null, stop: null, tp1: null, sources: ['alert-1m'] }],
      {}, new Map(), [], Date.parse(calledAt) + 10 * MIN
    );
    assertEqual(noLevels[0].outcome, 'no_levels', 'neither the alert line nor a capture had levels');
  });

  await test('collect.js: goodEndedTimesFromAlertLines matches a GOOD_ENDED line (no candidateId of its own) to whichever candidate is open for its symbol; scoreGoodCalls turns it into endedAt + goodWindowMin', () => {
    const CID = 'BTC:1m:long:X';
    const alerts = [gLine('g1', at('14:03'), { candidateId: CID }), gEnded('e1', at('14:06'))];
    const ended = goodEndedTimesFromAlertLines(alerts);
    assertEqual(ended.size, 1, 'one closed candidate');
    assertEqual(ended.get(`BTC|${CID}`), at('14:06'), 'GOOD_ENDED time attributed to the symbol\'s open candidate');

    const merged = mergeGoodCalls(goodCallsFromAlertLines(alerts), []);
    const rows = scoreGoodCalls(merged, {}, ended, [], Date.parse(at('14:06')) + MIN);
    assertEqual(rows[0].endedAt, at('14:06'), 'endedAt on the scored row');
    assertEqual(rows[0].goodWindowMin, 3, 'GOOD window length in minutes (14:03 -> 14:06)');
  });

  await test('score.js: scoreGoodCallsDataDir - capture-only fallback when the alert log is missing, backfill idempotent once resolved', () => {
    const dir = tmp();
    const CID = 'BTC:1m:long:X';
    const calledAt = at('14:07');
    appendCalls(dir, [captureRow('BTC', Date.parse(calledAt), plan({ candidateId: CID, entry: 100, stop: 99, tp1: 103 }), rec('GOOD', { candidateId: CID }))]);
    // No data/telegram-alerts directory at all - the alert log is entirely missing.
    const cs = candles(Date.parse(calledAt), 2, () => ({ h: 100.2, l: 98.5 })); // stop (99) hit on the fill candle
    appendCandles(dir, '1m', toStoreCandles('BTC', cs));
    const first = scoreGoodCallsDataDir(dir, Date.parse(calledAt) + 5 * MIN);
    assertEqual(first.length, 1, 'capture-only fallback still produces one GOOD call');
    assertEqual(JSON.stringify(first[0].sources), '["capture"]', 'no alert-1m source when the log is missing');
    assertEqual(first[0].outcome, 'stop', 'walked to stop');
    const scoredAt1 = first[0].scoredAt;
    const second = scoreGoodCallsDataDir(dir, Date.parse(calledAt) + 60 * MIN);
    assertEqual(second[0].scoredAt, scoredAt1, 'idempotent - final row kept byte-for-byte (scoredAt unchanged) on rerun');
    assertEqual(readJsonl(goodCallOutcomesFile(dir)).length, 1, 'written to good-call-outcomes.jsonl');
  });

  await test('aggregate.js: classCheck GOOD row reads goodCallOutcomes (1-min log) when present - oneMinLogCalls/capturedCalls/medianGoodWindowMin - and feeds the phase 30-plan target', () => {
    const goodRows = [
      { kind: 'good', symbol: 'BTC', candidateId: 'BTC:1m:long:1', calledAt: iso(T0), outcome: 'tp1', r: 3, filledAt: iso(T0), resolvedAt: iso(T0 + 5 * MIN),
        minutesToResolution: 5, entry: 100, stop: 99, direction: 'long', levelSource: 'plan', sources: ['alert-1m', 'capture'], goodWindowMin: 4 },
      { kind: 'good', symbol: 'ETH', candidateId: 'ETH:1m:short:1', calledAt: iso(T0 + MIN), outcome: 'stop', r: -1, filledAt: iso(T0 + MIN), resolvedAt: iso(T0 + 2 * MIN),
        minutesToResolution: 1, entry: 50, stop: 51, direction: 'short', levelSource: 'plan', sources: ['alert-1m'], goodWindowMin: 2 }
    ];
    const cc = classCheck([], null, goodRows);
    const good = cc.rows.find((r) => r.key === 'GOOD');
    assertEqual(good.calls, 2, 'GOOD calls come from the merged set, not the (empty) rec rows');
    assertEqual(good.oneMinLogCalls, 2, 'both alert-sourced');
    assertEqual(good.capturedCalls, 1, 'one of the two was also captured');
    assertEqual(good.medianGoodWindowMin, 3, 'median of 4 and 2 minutes');

    const agg = computeAggregates([], [], {}, T0 + 10 * MIN, { phaseStartMs: T0, goodCallOutcomes: goodRows });
    assertEqual(agg.phase.tradable.calls, 2, '30-plan target now counts alert-sourced GOOD calls');
    assertEqual(agg.goodCallLogSince, iso(T0).slice(0, 10), 'earliest alert-sourced day, for the page note');
  });

  await test('build-page.js: class-check table shows the T-12 GOOD-row columns and the one-line 1-minute-log note when goodCallLogSince is set', () => {
    const dir = tmp();
    const CID = 'BTC:1m:long:X';
    const calledAt = '2026-09-28T00:00:00.000Z'; // inside the PHASE_START window (T-21: 2026-09-27, the flag epoch) build-page.js scopes classCheck to
    writeJsonl(goodCallOutcomesFile(dir), [{
      callId: goodCallId({ symbol: 'BTC', candidateId: CID }), kind: 'good', symbol: 'BTC', candidateId: CID, calledAt,
      timeframe: '1m', direction: 'long', entry: 100, stop: 99, tp1: 103, grossRR: 3, netRR: 2.8, levelSource: 'plan', class: 'GOOD',
      sources: ['alert-1m', 'capture'], endedAt: new Date(Date.parse(calledAt) + 4 * MIN).toISOString(), goodWindowMin: 4, outcome: 'tp1', r: 3,
      filledAt: calledAt, resolvedAt: new Date(Date.parse(calledAt) + 5 * MIN).toISOString(),
      minutesToResolution: 5, mode: 'ready_prefilled', rUnits: 'gross_R_before_fees_slippage', scoredAt: calledAt
    }]);
    const { htmlFile, mdFile } = buildPage(dir, path.join(dir, 'docs'), Date.parse(calledAt) + MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="class-check-good-log-note"') && html.includes('1-minute alert log since 2026-09-28'), 'note rendered with the first ingest date');
    assert(html.includes('Calls (1-min log)') && html.includes('Of which captured') && html.includes('Median GOOD window (min)'), 'new columns rendered');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes('1-minute alert log since 2026-09-28'), 'report.md carries the same note');
  });

  console.log('\nRETEST_1H calls from the 1-minute alert log (T-18)\n');

  const rLine = (id, sentAt, over = {}) => ({
    id, sentAt, kind: 'RETEST_1H', event: null, symbol: 'BTC', timeframe: '1h', direction: 'long', candidateId: 'retest1h_BTC_2026-09-27T15:00:00.000Z',
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: 100, stop: 99, tp1: 103,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, silent: false, level: null, tracked: false, delivered: true, text: 'RETEST 1H BTC', ...over
  });
  const rExitLine = (id, sentAt, candidateId, over = {}) => ({
    id, sentAt, kind: 'RETEST_1H_EXIT', event: null, symbol: 'BTC', timeframe: '1h', direction: 'long', candidateId,
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: 100, stop: 99, tp1: 103,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, silent: false, level: null, tracked: false, delivered: true, text: 'EXIT SIGNAL RETEST 1H BTC', ...over
  });
  const slowLine = (id, sentAt, symbol = 'BTC') => ({
    id, sentAt, kind: 'SLOW_TREND', event: null, symbol, timeframe: null, direction: null, candidateId: null,
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: null, stop: null, tp1: null,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, silent: false, level: null, tracked: false, delivered: true, text: `${symbol} SLOW TREND`
  });

  await test('collect.js: retestCallsFromAlertLines - first RETEST_1H line per symbol+candidateId, levels from trackLevels-fed fields; SLOW_TREND lines never match', () => {
    const CID = 'retest1h_BTC_2026-09-27T15:00:00.000Z';
    const alerts = [
      rLine('r1', at('14:03'), { candidateId: CID }),
      rLine('r2', at('14:04'), { candidateId: CID, entry: 999 }), // repeat send - ignored, first sighting is the call
      slowLine('s1', at('14:05')), // logged, never a RETEST_1H call
      rLine('r3', at('14:10'), { candidateId: 'retest1h_ETH_2026-09-27T15:00:00.000Z', symbol: 'ETH', direction: 'short', entry: 50, stop: 51, tp1: 47, timeframe: '1h' })
    ];
    const calls = retestCallsFromAlertLines(alerts);
    assertEqual(calls.length, 2, 'one per symbol+candidateId, SLOW_TREND excluded, first RETEST_1H line only');
    const btc = calls.find((c) => c.symbol === 'BTC');
    assertEqual(btc.calledAt, at('14:03'), 'first RETEST_1H line is the call');
    assertEqual(btc.entry, 100, 'levels come from the first line, not the repeat');
    assertEqual(btc.candidateId, CID);
    const eth = calls.find((c) => c.symbol === 'ETH');
    assertEqual(eth.direction, 'short');
    assertEqual(eth.entry, 50);
    assertEqual(retestCallsFromAlertLines([]).length, 0, 'empty in -> empty out, never throws');
    assertEqual(retestCallsFromAlertLines(null).length, 0, 'null in -> empty out, never throws');
  });

  await test('collect.js: retestExitTimesFromAlertLines - a RETEST_1H_EXIT line always carries its own candidateId (no per-symbol open-candidate walk needed, unlike GOOD_ENDED)', () => {
    const CID = 'retest1h_BTC_2026-09-27T15:00:00.000Z';
    const alerts = [rLine('r1', at('14:03'), { candidateId: CID }), rExitLine('x1', at('14:06'), CID)];
    const exited = retestExitTimesFromAlertLines(alerts);
    assertEqual(exited.size, 1);
    assertEqual(exited.get(`BTC|${CID}`), at('14:06'));
    // Earliest exit line wins on a repeat.
    const withRepeat = retestExitTimesFromAlertLines([...alerts, rExitLine('x2', at('14:07'), CID)]);
    assertEqual(withRepeat.get(`BTC|${CID}`), at('14:06'), 'earliest exit line wins');
  });

  await test('score.js: scoreRetestCalls walks a RETEST_1H call prefilled from its own calledAt (tp1/stop), class RETEST_1H, carries exitedAt; no_levels when the alert line had none', () => {
    const calledAt = at('14:03');
    const cs = candles(Date.parse(calledAt), 3, (i) => (i < 2 ? { h: 100.2, l: 99.8 } : { h: 103.5, l: 100 })); // TP1 (103) touched on candle 2
    const call = { symbol: 'BTC', candidateId: 'retest1h_BTC_X', calledAt, direction: 'long', entry: 100, stop: 99, tp1: 103 };
    const exitedAt = new Map([['BTC|retest1h_BTC_X', at('16:00')]]);
    const rows = scoreRetestCalls([call], { BTC: cs }, exitedAt, [], Date.parse(calledAt) + 10 * MIN);
    assertEqual(rows.length, 1);
    const row = rows[0];
    assertEqual(row.callId, retestCallId(call), 'callId shape retest1h|symbol|candidateId');
    assertEqual(row.outcome, 'tp1', 'walked to tp1');
    assertEqual(row.r, 3, 'gross R = |tp1-entry|/|entry-stop|');
    assertEqual(row.filledAt, calledAt, 'prefilled at calledAt - the retest signal fires ON the fill candle');
    assertEqual(row.class, 'RETEST_1H');
    assertEqual(row.kind, 'retest1h');
    assertEqual(row.exitedAt, at('16:00'), 'carries the info-only exit alert time, does not change the walked outcome');

    const noLevels = scoreRetestCalls(
      [{ symbol: 'ETH', candidateId: 'retest1h_ETH_X', calledAt, direction: 'short', entry: null, stop: null, tp1: null }],
      {}, new Map(), [], Date.parse(calledAt) + 10 * MIN
    );
    assertEqual(noLevels[0].outcome, 'no_levels');
    assertEqual(noLevels[0].exitedAt, null, 'no exit line for this key');
  });

  await test('score.js: scoreRetestCallsDataDir - no capture fallback (unlike GOOD), idempotent once resolved, written to retest-call-outcomes.jsonl', () => {
    const dir = tmp();
    const CID = 'retest1h_BTC_X';
    const calledAt = at('14:07');
    appendTelegramAlerts(dir, [rLine('r1', calledAt, { candidateId: CID })]);
    const cs = candles(Date.parse(calledAt), 2, () => ({ h: 100.2, l: 98.5 })); // stop (99) hit on the fill candle
    appendCandles(dir, '1m', toStoreCandles('BTC', cs));
    const first = scoreRetestCallsDataDir(dir, Date.parse(calledAt) + 5 * MIN);
    assertEqual(first.length, 1);
    assertEqual(first[0].outcome, 'stop', 'walked to stop');
    assertEqual(JSON.stringify(first[0].sources), '["alert-1m"]', 'the only source - no capture equivalent for retest-1h');
    const scoredAt1 = first[0].scoredAt;
    const second = scoreRetestCallsDataDir(dir, Date.parse(calledAt) + 60 * MIN);
    assertEqual(second[0].scoredAt, scoredAt1, 'idempotent - final row kept byte-for-byte on rerun');
    assertEqual(readJsonl(retestCallOutcomesFile(dir)).length, 1, 'written to retest-call-outcomes.jsonl');
  });

  await test('SLOW_TREND crosses are logged in the same alert-log store but never scored as RETEST_1H trades', () => {
    const dir = tmp();
    appendTelegramAlerts(dir, [rLine('r1', at('14:03')), slowLine('s1', at('14:05')), slowLine('s2', at('15:05'), 'ETH')]);
    const stored = readTelegramAlerts(dir);
    assertEqual(stored.filter((r) => r.kind === 'SLOW_TREND').length, 2, 'SLOW_TREND lines are stored (logged)');
    const rows = scoreRetestCallsDataDir(dir, Date.parse(at('14:03')) + MIN);
    assertEqual(rows.length, 1, 'only the RETEST_1H line becomes a scored call');
    assert(rows.every((r) => r.class === 'RETEST_1H'), 'SLOW_TREND never enters RETEST_1H class scoring');
  });

  await test('aggregate.js: bootstrapMeanLowerBound90 - deterministic (same seed -> same bound), the bound sits at or below the sample mean, null under 2 values', () => {
    const values = [1, -1, 2, -1, 1.5, -1, 3, -1, 0.5, -1];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const b1 = bootstrapMeanLowerBound90(values);
    const b2 = bootstrapMeanLowerBound90(values);
    assertEqual(b1, b2, 'same input + default seed -> byte-identical bound every run');
    assert(b1 <= mean + 1e-9, `lower bound (${b1}) should sit at or below the sample mean (${mean})`);
    const differentSeed = bootstrapMeanLowerBound90(values, { seed: 1 });
    assert(typeof differentSeed === 'number', 'a different seed still returns a finite number');
    assertEqual(bootstrapMeanLowerBound90([1]), null, 'fewer than 2 values -> null');
    assertEqual(bootstrapMeanLowerBound90([]), null);
    assertEqual(bootstrapMeanLowerBound90(null), null, 'never throws on garbage');
  });

  await test('aggregate.js: maxDrawdownR - largest peak-to-trough drop of the cumulative R curve, in R, taken in the order given', () => {
    // Cumulative: 2, 1, 0, 3, 2 -> peak 2 (i0), trough 0 (i2) => DD 2; new peak 3 (i3), trough 2 (i4) => DD 1. Max = 2.
    assertEqual(maxDrawdownR([2, -1, -1, 3, -1]), 2);
    assertEqual(maxDrawdownR([]), 0, 'empty -> 0');
    assertEqual(maxDrawdownR([1, 1, 1]), 0, 'monotonically up -> no drawdown');
    assertEqual(maxDrawdownR([-1, -1, -1]), 3, 'monotonically down from a zero-start peak: drawdown grows with every loss, ends at 3');
  });

  await test('aggregate.js: retestStats - calls/wins/losses/winRate, gross+net R mean AND median, bootstrap lower bound, max drawdown, towardThirty (resolved count)', () => {
    const mk = (outcome, r, entry = 100, stop = 99, direction = 'long', calledAt = at('14:00')) => ({ outcome, r, entry, stop, direction, calledAt, resolvedAt: calledAt });
    const rows = [
      mk('tp1', 3), mk('stop', null), mk('tp1', 2), mk('stop', null), mk('open', null) // 4 decided (2 wins, 2 losses), 1 still open
    ];
    const s = retestStats(rows);
    assertEqual(s.calls, 5, 'every fired signal, including the still-open one');
    assertEqual(s.resolved, 4, 'tp1/stop only');
    assertEqual(s.wins, 2);
    assertEqual(s.losses, 2);
    assertEqual(s.winRate, 0.5);
    assertEqual(s.towardThirty, 4, 'the count the promotion rule\'s mean/median/bootstrap is actually computed over');
    assertEqual(s.promotionTarget, 30);
    assert(typeof s.grossRMean === 'number' && typeof s.grossRMedian === 'number', 'gross R mean and median both reported');
    assert(typeof s.netRMean === 'number' && typeof s.netRMedian === 'number', 'net R mean and median both reported (net < gross - costs charged)');
    assert(s.netRMean < s.grossRMean, 'net R is charged a cost, so it sits below gross R');
    assert(typeof s.netRBootstrapLowerBound90 === 'number' && s.netRBootstrapLowerBound90 <= s.netRMean + 1e-9, 'bootstrap LB at/below the net R mean');
    assert(typeof s.maxDrawdownR === 'number' && s.maxDrawdownR >= 0, 'max drawdown reported, non-negative');
    assertEqual(s.promoted, false, 'fewer than 30 resolved signals -> not promoted regardless of the numbers');
    assertEqual(JSON.stringify(retestStats([])), JSON.stringify({
      calls: 0, resolved: 0, wins: 0, losses: 0, winRate: null, grossRMean: null, grossRMedian: null, netRMean: null, netRMedian: null,
      netRBootstrapLowerBound90: null, maxDrawdownR: 0, towardThirty: 0, promotionTarget: 30, promoted: false
    }), 'empty input renders every field, never throws');
  });

  await test('aggregate.js: computeAggregates wires opts.retestCallOutcomes into agg.retest1h', () => {
    const rows = [{ outcome: 'tp1', r: 3, entry: 100, stop: 99, direction: 'long', calledAt: iso(T0), resolvedAt: iso(T0) }];
    const agg = computeAggregates([], [], {}, T0 + MIN, { retestCallOutcomes: rows });
    assertEqual(agg.retest1h.calls, 1);
    assertEqual(agg.retest1h.resolved, 1);
    const empty = computeAggregates([], [], {}, T0 + MIN, {});
    assertEqual(empty.retest1h.calls, 0, 'omitted opts.retestCallOutcomes -> empty stats, never throws');
  });

  await test('page + report: RETEST 1H tile (next to Net floor) and report section; empty state from an empty data dir', () => {
    const empty = tmp();
    const e = readFileSync(buildPage(path.join(empty, 'data'), path.join(empty, 'docs'), T0).htmlFile, 'utf8');
    assert(e.includes('id="retest1h-section"') && e.includes('id="retest1h-empty"'), 'empty tile');
    assert(e.indexOf('id="nf-shadow-section"') < e.indexOf('id="retest1h-section"'), 'placed right after Net floor (Live/NF)');
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    writeJsonl(retestCallOutcomesFile(dataDir), [
      { callId: 'retest1h|BTC|c1', kind: 'retest1h', symbol: 'BTC', candidateId: 'c1', calledAt: iso(T0), timeframe: '1h', direction: 'long', entry: 100, stop: 99, tp1: 103, class: 'RETEST_1H', outcome: 'tp1', r: 3, resolvedAt: iso(T0 + 5 * MIN) },
      { callId: 'retest1h|ETH|c2', kind: 'retest1h', symbol: 'ETH', candidateId: 'c2', calledAt: iso(T0 + MIN), timeframe: '1h', direction: 'short', entry: 50, stop: 51, tp1: 47, class: 'RETEST_1H', outcome: 'stop', r: null, resolvedAt: iso(T0 + 2 * MIN) }
    ]);
    const { htmlFile, mdFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="retest1h-summary-table"') && html.includes('id="retest1h-status-note"'), 'summary table + status note rendered');
    assert(html.includes('paper') && html.includes('2 / 30'), 'still-paper status names the count toward the promotion rule');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes('## RETEST 1H · paper') && md.includes('2 / 30 toward the promotion rule'), md.slice(md.indexOf('## RETEST 1H')));
  });

  console.log('\nHTF_1M calls from the 1-minute alert log (T-20)\n');

  const hLine = (id, sentAt, over = {}) => ({
    id, sentAt, kind: 'HTF_ENTRY', event: null, symbol: 'BTC', timeframe: '5m', direction: 'long', candidateId: 'htf_BTC_5m_long_2026-09-27T15:05:00.000Z',
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: 100, stop: 99, tp1: 103,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, configVersion: '2026.09.27-3', silent: false, level: null, tracked: false, delivered: true, text: 'ENTRY BTC', ...over
  });
  const hExitLine = (id, sentAt, candidateId, over = {}) => ({
    id, sentAt, kind: 'HTF_EXIT', event: null, symbol: 'BTC', timeframe: '5m', direction: 'long', candidateId,
    signature: null, verdict: null, etaMin: null, breakout: null, invalidation: null, entry: 100, stop: 99, tp1: 103,
    grossRR: null, netRR: null, roomR: null, closedThrough: sentAt, configVersion: '2026.09.27-3', silent: false, level: null, tracked: false, delivered: true, text: 'EXIT BTC LONG structure', ...over
  });

  await test('collect.js: htfCallsFromAlertLines - first HTF_ENTRY line per symbol+candidateId, levels + configVersion from the alert line; SLOW_TREND lines never match', () => {
    const CID = 'htf_BTC_5m_long_2026-09-27T15:05:00.000Z';
    const alerts = [
      hLine('h1', at('14:03'), { candidateId: CID }),
      hLine('h2', at('14:04'), { candidateId: CID, entry: 999 }), // repeat send - ignored, first sighting is the call
      slowLine('s1', at('14:05')), // logged, never an HTF_1M call
      hLine('h3', at('14:10'), { candidateId: 'htf_ETH_1m_short_2026-09-27T15:10:00.000Z', symbol: 'ETH', direction: 'short', entry: 50, stop: 51, tp1: 47, timeframe: '1m' })
    ];
    const calls = htfCallsFromAlertLines(alerts);
    assertEqual(calls.length, 2, 'one per symbol+candidateId, SLOW_TREND excluded, first HTF_ENTRY line only');
    const btc = calls.find((c) => c.symbol === 'BTC');
    assertEqual(btc.calledAt, at('14:03'), 'first HTF_ENTRY line is the call');
    assertEqual(btc.entry, 100, 'levels come from the first line, not the repeat');
    assertEqual(btc.candidateId, CID);
    assertEqual(btc.configVersion, '2026.09.27-3', 'configVersion carried through for the config-boundary join');
    const eth = calls.find((c) => c.symbol === 'ETH');
    assertEqual(eth.direction, 'short');
    assertEqual(eth.entry, 50);
    assertEqual(htfCallsFromAlertLines([]).length, 0, 'empty in -> empty out, never throws');
    assertEqual(htfCallsFromAlertLines(null).length, 0, 'null in -> empty out, never throws');
  });

  await test('collect.js: htfExitTimesFromAlertLines - an HTF_EXIT line always carries its own candidateId (no per-symbol open-candidate walk needed)', () => {
    const CID = 'htf_BTC_5m_long_2026-09-27T15:05:00.000Z';
    const alerts = [hLine('h1', at('14:03'), { candidateId: CID }), hExitLine('x1', at('14:06'), CID)];
    const exited = htfExitTimesFromAlertLines(alerts);
    assertEqual(exited.size, 1);
    assertEqual(exited.get(`BTC|${CID}`), at('14:06'));
    const withRepeat = htfExitTimesFromAlertLines([...alerts, hExitLine('x2', at('14:07'), CID)]);
    assertEqual(withRepeat.get(`BTC|${CID}`), at('14:06'), 'earliest exit line wins');
  });

  await test('score.js: scoreHtfCalls walks an HTF_1M call prefilled from its own calledAt (tp1/stop), class HTF_1M, carries exitedAt + configVersion; no_levels when the alert line had none', () => {
    const calledAt = at('14:03');
    const cs = candles(Date.parse(calledAt), 3, (i) => (i < 2 ? { h: 100.2, l: 99.8 } : { h: 103.5, l: 100 })); // TP1 (103) touched on candle 2
    const call = { symbol: 'BTC', candidateId: 'htf_BTC_X', calledAt, direction: 'long', entry: 100, stop: 99, tp1: 103, configVersion: '2026.09.27-3' };
    const exitedAt = new Map([['BTC|htf_BTC_X', at('16:00')]]);
    const rows = scoreHtfCalls([call], { BTC: cs }, exitedAt, [], Date.parse(calledAt) + 10 * MIN);
    assertEqual(rows.length, 1);
    const row = rows[0];
    assertEqual(row.callId, htfCallId(call), 'callId shape htf1m|symbol|candidateId');
    assertEqual(row.outcome, 'tp1', 'walked to tp1');
    assertEqual(row.r, 3, 'gross R = |tp1-entry|/|entry-stop|');
    assertEqual(row.filledAt, calledAt, 'prefilled at calledAt - the HTF trigger fires ON the fill candle');
    assertEqual(row.class, 'HTF_1M');
    assertEqual(row.kind, 'htf1m');
    assertEqual(row.configVersion, '2026.09.27-3');
    assertEqual(row.exitedAt, at('16:00'), 'carries the info-only exit alert time, does not change the walked outcome');

    const noLevels = scoreHtfCalls(
      [{ symbol: 'ETH', candidateId: 'htf_ETH_X', calledAt, direction: 'short', entry: null, stop: null, tp1: null }],
      {}, new Map(), [], Date.parse(calledAt) + 10 * MIN
    );
    assertEqual(noLevels[0].outcome, 'no_levels');
    assertEqual(noLevels[0].exitedAt, null, 'no exit line for this key');
  });

  await test('score.js: scoreHtfCallsDataDir - no capture fallback (unlike GOOD), idempotent once resolved, written to htf-call-outcomes.jsonl', () => {
    const dir = tmp();
    const CID = 'htf_BTC_X';
    const calledAt = at('14:07');
    appendTelegramAlerts(dir, [hLine('h1', calledAt, { candidateId: CID })]);
    const cs = candles(Date.parse(calledAt), 2, () => ({ h: 100.2, l: 98.5 })); // stop (99) hit on the fill candle
    appendCandles(dir, '1m', toStoreCandles('BTC', cs));
    const first = scoreHtfCallsDataDir(dir, Date.parse(calledAt) + 5 * MIN);
    assertEqual(first.length, 1);
    assertEqual(first[0].outcome, 'stop', 'walked to stop');
    assertEqual(JSON.stringify(first[0].sources), '["alert-1m"]', 'the only source - no capture equivalent for HTF entries');
    const scoredAt1 = first[0].scoredAt;
    const second = scoreHtfCallsDataDir(dir, Date.parse(calledAt) + 60 * MIN);
    assertEqual(second[0].scoredAt, scoredAt1, 'idempotent - final row kept byte-for-byte on rerun');
    assertEqual(readJsonl(htfCallOutcomesFile(dir)).length, 1, 'written to htf-call-outcomes.jsonl');
  });

  await test('SLOW_TREND crosses are logged in the same alert-log store but never scored as HTF_1M trades', () => {
    const dir = tmp();
    appendTelegramAlerts(dir, [hLine('h1', at('14:03')), slowLine('s1', at('14:05')), slowLine('s2', at('15:05'), 'ETH')]);
    const rows = scoreHtfCallsDataDir(dir, Date.parse(at('14:03')) + MIN);
    assertEqual(rows.length, 1, 'only the HTF_ENTRY line becomes a scored call');
    assert(rows.every((r) => r.class === 'HTF_1M'), 'SLOW_TREND never enters HTF_1M class scoring');
  });

  await test('aggregate.js: htfStats - calls/wins/losses/winRate, gross+net R mean AND median, bootstrap lower bound, max drawdown, towardThirty (resolved count); mirrors retestStats\' shape', () => {
    const mk = (outcome, r, entry = 100, stop = 99, direction = 'long', calledAt = at('14:00')) => ({ outcome, r, entry, stop, direction, calledAt, resolvedAt: calledAt });
    const rows = [mk('tp1', 3), mk('stop', null), mk('tp1', 2), mk('stop', null), mk('open', null)];
    const s = htfStats(rows);
    assertEqual(s.calls, 5, 'every fired signal, including the still-open one');
    assertEqual(s.resolved, 4, 'tp1/stop only');
    assertEqual(s.wins, 2);
    assertEqual(s.losses, 2);
    assertEqual(s.winRate, 0.5);
    assertEqual(s.towardThirty, 4);
    assertEqual(s.promotionTarget, 30);
    assert(typeof s.grossRMean === 'number' && typeof s.grossRMedian === 'number');
    assert(typeof s.netRMean === 'number' && typeof s.netRMedian === 'number' && s.netRMean < s.grossRMean);
    assert(typeof s.netRBootstrapLowerBound90 === 'number' && s.netRBootstrapLowerBound90 <= s.netRMean + 1e-9);
    assert(typeof s.maxDrawdownR === 'number' && s.maxDrawdownR >= 0);
    assertEqual(s.promoted, false, 'fewer than 30 resolved signals -> promoted stays false (monitoring only for this already-live class)');
    assertEqual(JSON.stringify(htfStats([])), JSON.stringify(retestStats([])), 'identical empty shape to retestStats');
  });

  await test('aggregate.js: computeAggregates wires opts.htfCallOutcomes into agg.htf1m', () => {
    const rows = [{ outcome: 'tp1', r: 3, entry: 100, stop: 99, direction: 'long', calledAt: iso(T0), resolvedAt: iso(T0) }];
    const agg = computeAggregates([], [], {}, T0 + MIN, { htfCallOutcomes: rows });
    assertEqual(agg.htf1m.calls, 1);
    assertEqual(agg.htf1m.resolved, 1);
    const empty = computeAggregates([], [], {}, T0 + MIN, {});
    assertEqual(empty.htf1m.calls, 0, 'omitted opts.htfCallOutcomes -> empty stats, never throws');
  });

  await test('page + report: HTF ENTRY tile (next to RETEST 1H) and report section; empty state from an empty data dir', () => {
    const empty = tmp();
    const e = readFileSync(buildPage(path.join(empty, 'data'), path.join(empty, 'docs'), T0).htmlFile, 'utf8');
    assert(e.includes('id="htf1m-section"') && e.includes('id="htf1m-empty"'), 'empty tile');
    assert(e.indexOf('id="retest1h-section"') < e.indexOf('id="htf1m-section"'), 'placed right after RETEST 1H');
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    writeJsonl(htfCallOutcomesFile(dataDir), [
      { callId: 'htf1m|BTC|c1', kind: 'htf1m', symbol: 'BTC', candidateId: 'c1', calledAt: iso(T0), timeframe: '5m', direction: 'long', entry: 100, stop: 99, tp1: 103, class: 'HTF_1M', outcome: 'tp1', r: 3, resolvedAt: iso(T0 + 5 * MIN) },
      { callId: 'htf1m|ETH|c2', kind: 'htf1m', symbol: 'ETH', candidateId: 'c2', calledAt: iso(T0 + MIN), timeframe: '1m', direction: 'short', entry: 50, stop: 51, tp1: 47, class: 'HTF_1M', outcome: 'stop', r: null, resolvedAt: iso(T0 + 2 * MIN) }
    ]);
    const { htmlFile, mdFile } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    const html = readFileSync(htmlFile, 'utf8');
    assert(html.includes('id="htf1m-summary-table"') && html.includes('id="htf1m-status-note"'), 'summary table + status note rendered');
    assert(html.includes('live') && html.includes('2 resolved signal'), 'live status names the resolved count');
    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes('## HTF ENTRY · live') && md.includes('2 resolved signal(s) scored so far'), md.slice(md.indexOf('## HTF ENTRY')));
  });

  console.log('\nT-21 strategy scoreboard + archive (docs/PROMPT_T21_STRATEGY_SCOREBOARD.md)\n');

  await test('epochs.js: deriveEpochsFrom - flag/htf from the first matching capture row (earliest wins), retest1h from its own first RETEST_1H alert line, spot from meta.json startDate; falls back to documented constants when nothing derives', () => {
    const captureRows = [
      { configVersion: '2026.09.24-5', closedThrough: iso(T0) },
      { configVersion: FLAG_CONFIG_VERSION, closedThrough: iso(T0 + 10 * MIN) },
      { configVersion: FLAG_CONFIG_VERSION, closedThrough: iso(T0 + 20 * MIN) }, // later dupe - first must win
      { configVersion: HTF_CONFIG_VERSION, closedThrough: iso(T0 + 30 * MIN) }
    ];
    const alertRows = [
      { kind: 'GOOD', sentAt: iso(T0 + 5 * MIN) },
      { kind: 'RETEST_1H', sentAt: iso(T0 + 16 * MIN) }, // later dupe - first must win
      { kind: 'RETEST_1H', sentAt: iso(T0 + 15 * MIN) }
    ];
    assertEqual(firstCaptureAtVersion(captureRows, FLAG_CONFIG_VERSION), iso(T0 + 10 * MIN), 'firstCaptureAtVersion picks the earliest match');
    assertEqual(firstAlertOfKind(alertRows, 'RETEST_1H'), iso(T0 + 16 * MIN), 'firstAlertOfKind picks the first match in the given (already-ascending) order, not the earliest timestamp');

    const epochs = deriveEpochsFrom({
      captureRows,
      alertRows: [...alertRows].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt)),
      spotMeta: { startDate: '2026-09-19' }
    });
    assertEqual(epochs.flag.epochIso, iso(T0 + 10 * MIN));
    assertEqual(epochs.flag.source, 'capture');
    assertEqual(epochs.htf.epochIso, iso(T0 + 30 * MIN));
    assertEqual(epochs.htf.source, 'capture');
    assertEqual(epochs.retest1h.epochIso, iso(T0 + 15 * MIN));
    assertEqual(epochs.retest1h.source, 'alert');
    assertEqual(epochs.spot.epochIso, '2026-09-19T00:00:00.000Z', 'spot epoch normalized from a bare date to a full ISO instant');
    assertEqual(epochs.spot.source, 'meta');
    assertEqual(epochs.wallet.epochIso, WALLET_EPOCH_ISO, 'wallet epoch is the fixed constant, never derived');
    assertEqual(epochs.wallet.source, 'constant');

    const empty = deriveEpochsFrom({});
    assertEqual(empty.flag.epochIso, FLAG_EPOCH_FALLBACK, 'flag falls back to its documented constant with no data');
    assertEqual(empty.flag.source, 'constant');
    assertEqual(empty.htf.epochIso, HTF_EPOCH_FALLBACK, 'htf falls back to its own documented constant');
    assertEqual(empty.htf.source, 'constant');
    assertEqual(empty.retest1h.epochIso, empty.flag.epochIso, '"else same as flag": retest1h with no RETEST_1H line falls back to the flag epoch, not a second constant');
    assertEqual(empty.retest1h.source, 'constant');
    assertEqual(empty.spot.epochIso, SPOT_EPOCH_FALLBACK, 'spot falls back to its documented constant with no meta.json');
    assertEqual(empty.spot.source, 'constant');
  });

  await test('epochs.js: deriveEpochs(dataDir) reads data/calls, data/telegram-alerts and data/spot-trend/meta.json', () => {
    const dir = tmp();
    appendCalls(dir, [{ ...captureRow('BTC', T0, null, rec('WATCH')), configVersion: FLAG_CONFIG_VERSION }]);
    appendTelegramAlerts(dir, [rLine('r1', iso(T0 + MIN))]);
    writeJson(path.join(dir, 'spot-trend', 'meta.json'), { startDate: '2026-09-20' });
    const epochs = deriveEpochs(dir);
    assertEqual(epochs.flag.epochIso, iso(T0), 'flag epoch from the stored capture row');
    assertEqual(epochs.flag.source, 'capture');
    assertEqual(epochs.retest1h.epochIso, iso(T0 + MIN), 'retest1h epoch from the stored alert log');
    assertEqual(epochs.retest1h.source, 'alert');
    assertEqual(epochs.spot.epochIso, '2026-09-20T00:00:00.000Z', 'spot epoch from the stored meta.json');
    assertEqual(epochs.htf.source, 'constant', 'no HTF_CONFIG_VERSION capture row stored -> falls back');
  });

  await test('aggregate.js: epochStats/spotScoreboardStats/walletScoreboardStats - per-strategy stats exclude pre-epoch rows; empty/unresolved epoch renders the same empty shape as retestStats([])', () => {
    const rows = [
      { calledAt: iso(T0 - MIN), outcome: 'tp1', r: 5, entry: 100, stop: 99, direction: 'long', resolvedAt: iso(T0) }, // pre-epoch - excluded
      { calledAt: iso(T0 + MIN), outcome: 'tp1', r: 3, entry: 100, stop: 99, direction: 'long', resolvedAt: iso(T0 + 2 * MIN) },
      { calledAt: iso(T0 + 5 * MIN), outcome: 'stop', r: null, entry: 100, stop: 99, direction: 'long', resolvedAt: iso(T0 + 6 * MIN) }
    ];
    const s = epochStats(rows, iso(T0), T0 + 2 * 24 * 60 * MIN);
    assertEqual(s.calls, 2, 'only the two rows at/after the epoch');
    assertEqual(s.resolved, 2);
    assertEqual(s.wins, 1);
    assertEqual(s.losses, 1);
    assertEqual(s.epochIso, iso(T0));
    assertEqual(s.daysLive, 2, 'daysLive is nowMs minus the epoch, in days');
    assertEqual(JSON.stringify(epochStats([], null, T0)), JSON.stringify({ ...retestStats([]), epochIso: null, daysLive: null }), 'no epoch -> the same empty shape retestStats([]) has, plus null epoch fields');

    const spotEmpty = spotScoreboardStats(null, [], iso(T0), T0);
    assertEqual(spotEmpty.calls, 0, 'no ledger -> zero, never throws');
    const spot = spotScoreboardStats({ startDate: '2026-09-19', rows: [{ date: '2026-09-19', equity: 0.99, bh: 1.02 }] },
      [{ date: '2026-09-18', live: true }, { date: '2026-09-20', live: true }, { date: '2026-09-20', live: false }], iso(T0), T0 + 24 * 60 * MIN);
    assertEqual(spot.calls, 1, 'one ledger row');
    assertEqual(spot.equityPct, -0.01, 'equity - 1, rounded');
    assertEqual(spot.bhPct, 0.02);
    assertEqual(spot.flips, 1, 'only the live flip at/after the epoch counts (the earlier live one and the non-live one do not)');

    const walletRows = [
      { t: iso(T0 - MIN), totalUsd: 500 },
      { t: iso(T0), totalUsd: 505 },
      { t: iso(T0 + MIN), totalUsd: 510 }
    ];
    const journalRows = [
      { kind: 'close', source: 'execution', receivedAt: iso(T0 - MIN), resultUsd: -5 }, // pre-epoch - excluded
      { kind: 'close', source: 'execution', receivedAt: iso(T0 + MIN), resultUsd: 8 },
      { kind: 'note', source: 'execution', receivedAt: iso(T0 + MIN), resultUsd: 999 } // not a close - excluded
    ];
    const wallet = walletScoreboardStats(walletRows, journalRows, iso(T0), T0 + 2 * MIN);
    assertEqual(wallet.equityStartUsd, 505, 'first wallet sample at/after the epoch');
    assertEqual(wallet.equityNowUsd, 510, 'latest wallet sample overall');
    assertEqual(wallet.trades, 1, 'only the post-epoch execution close counts');
    assertEqual(wallet.realizedNetUsd, 8);
    assertEqual(wallet.killArmState, null, 'not present in synced tracker data - never guessed');
  });

  await test('aggregate.js: computeAggregates - opts.epochs filters the 7d/30d windows\' goodCallOutcomes to the flag epoch and adds epochs/scoreboard/archive; omitted opts.epochs is byte-for-byte the pre-T-21 behavior (epochs/scoreboard/archive all null)', () => {
    const epochs = deriveEpochsFrom({ captureRows: [{ configVersion: FLAG_CONFIG_VERSION, closedThrough: iso(T0) }], alertRows: [], spotMeta: null });
    const goodRows = [
      { symbol: 'BTC', candidateId: 'pre', calledAt: iso(T0 - 10 * MIN), outcome: 'stop', r: null, entry: 100, stop: 99, direction: 'long', resolvedAt: iso(T0 - 5 * MIN) },
      { symbol: 'ETH', candidateId: 'post', calledAt: iso(T0 + 10 * MIN), outcome: 'tp1', r: 3, entry: 50, stop: 49, direction: 'long', resolvedAt: iso(T0 + 12 * MIN) }
    ];
    const withEpochs = computeAggregates([], [], {}, T0 + 60 * MIN, { goodCallOutcomes: goodRows, epochs });
    assertEqual(withEpochs.windows['7d'].tradable.calls, 1, 'live 7d window excludes the pre-epoch GOOD call');
    assertEqual(withEpochs.windows['30d'].tradable.calls, 1, 'live 30d window excludes it too');
    assertEqual(withEpochs.scoreboard.flag.calls, 1, 'scoreboard flag card also excludes the pre-epoch row');
    assertEqual(withEpochs.epochs, epochs);
    assertEqual(withEpochs.archive.windows['7d'].tradable.calls, 2, 'archive keeps the OLD unfiltered window - both rows');
    assertEqual(withEpochs.archive.preEpochGoodCalls.length, 1, 'exactly the one pre-epoch GOOD call is archived');
    assertEqual(withEpochs.archive.preEpochGoodCalls[0].candidateId, 'pre');

    const withoutEpochs = computeAggregates([], [], {}, T0 + 60 * MIN, { goodCallOutcomes: goodRows });
    assertEqual(withoutEpochs.windows['7d'].tradable.calls, 2, 'no opts.epochs -> unfiltered, exactly the pre-T-21 shape');
    assertEqual(withoutEpochs.epochs, null);
    assertEqual(withoutEpochs.scoreboard, null);
    assertEqual(withoutEpochs.archive, null);
  });

  await test('page + report (T-21): scoreboard zone sits after Status/before Performance with stable ids and the uniform empty state; home hero reads the epoch-filtered flag numbers; archive holds the pre-epoch GOOD calls and the old unfiltered 7d/30d windows; report.md mirrors the scoreboard table', () => {
    const dir = tmp();
    const dataDir = path.join(dir, 'data');
    const epochAt = iso(T0 + 10 * MIN);
    appendCalls(dataDir, [{ ...captureRow('BTC', T0 + 10 * MIN, null, rec('WATCH')), configVersion: FLAG_CONFIG_VERSION }]);
    writeJsonl(goodCallOutcomesFile(dataDir), [
      {
        callId: 'good|BTC|pre', kind: 'good', symbol: 'BTC', candidateId: 'pre', calledAt: iso(T0 - 10 * MIN), timeframe: '1m', direction: 'long',
        entry: 100, stop: 99, tp1: 103, class: 'GOOD', sources: ['capture'], outcome: 'stop', r: null, filledAt: iso(T0 - 10 * MIN), resolvedAt: iso(T0 - 5 * MIN), minutesToResolution: 5
      },
      {
        callId: 'good|ETH|post', kind: 'good', symbol: 'ETH', candidateId: 'post', calledAt: iso(T0 + 20 * MIN), timeframe: '1m', direction: 'long',
        entry: 50, stop: 49, tp1: 53, class: 'GOOD', sources: ['alert-1m'], outcome: 'tp1', r: 3, filledAt: iso(T0 + 20 * MIN), resolvedAt: iso(T0 + 25 * MIN), minutesToResolution: 5
      }
    ]);
    const { htmlFile, mdFile, agg } = buildPage(dataDir, path.join(dir, 'docs'), T0 + 60 * MIN);
    assertEqual(agg.epochs.flag.epochIso, epochAt, 'flag epoch derived from the stored capture row');
    assertEqual(agg.scoreboard.flag.calls, 1, 'only the post-epoch GOOD call counted on the scoreboard');
    assertEqual(agg.archive.preEpochGoodCalls.length, 1, 'the pre-epoch GOOD call is archived, not dropped');

    const html = readFileSync(htmlFile, 'utf8');
    for (const key of ['flag', 'htf', 'retest1h', 'spot', 'wallet']) assert(html.includes(`id="scoreboard-${key}-tile"`), `missing scoreboard-${key}-tile`);
    assert(html.indexOf('id="zone-system"') < html.indexOf('id="zone-scoreboard"') && html.indexOf('id="zone-scoreboard"') < html.indexOf('id="zone-performance"'), 'scoreboard sits after Status, before Performance');
    assert(html.includes(`id="scoreboard-htf-tile-empty">[NO SIGNALS SINCE`), 'htf card (no data at all) shows the uniform empty-state bracket, never a blank');
    assert(html.includes(`id="scoreboard-retest1h-tile-empty">[NO SIGNALS SINCE`), 'retest1h card (no alert log) shows the same uniform empty state');
    assert(html.includes(`id="scoreboard-flag-tile-signals"><dt>Signals</dt><dd>1</dd>`), 'flag card shows exactly the one post-epoch signal');


    assert(html.includes('id="archive-section"'), 'archive section present, collapsed at the bottom');
    assert(html.includes('id="archive-pre-epoch-good-table"'), 'pre-epoch GOOD calls table present in the archive');
    assert(html.includes('1 pre-epoch GOOD call(s) total'), 'archive note counts the one pre-epoch GOOD call');
    assert(html.includes('id="archive-window-7d-tile"') && html.includes('id="archive-window-30d-tile"'), 'the old (unfiltered) 7d/30d windows are archived, unchanged');
    assert(html.indexOf('id="zone-reference"') < html.indexOf('id="archive-section"'), 'archive sits at the very bottom of the page');

    const md = readFileSync(mdFile, 'utf8');
    assert(md.includes('## Strategy scoreboard · each from its own start'), 'report.md mirrors the scoreboard zone');
    assert(md.includes('### Flag engine · net floor · LIVE · TRADABLE'), 'flag card mirrored in report.md');
    assert(md.includes('| Signals | Resolved | Wins | Win % | Net R mean | Net R median | Net R 90% LB | Max DD (R) | Toward 30 |'), 'scoreboard table header mirrored');
  });

  console.log('\nSpot trend filter (docs/PLAN_SPOT_TREND_2026-09-27.md P1)');
  // Seeded random walk: 300 closed UTC days.
  const spotDays = (() => {
    let seed = 7, px = 100;
    const out = [];
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      px *= 1 + ((seed / 2147483648) - 0.48) * 0.08;
      out.push({ t: Date.UTC(2025, 0, 1) + i * 86_400_000, c: Math.round(px * 100) / 100 });
    }
    return out;
  })();
  const spotBars = { n: spotDays.length, t: spotDays.map((d) => d.t), c: Float64Array.from(spotDays.map((d) => d.c)) };

  await test('spot-trend: emaSeries matches the research ema exactly', () => {
    const mine = emaSeries(spotDays.map((d) => d.c), 20), ref = researchEma(spotBars.c, 20);
    for (let i = 0; i < mine.length; i++) {
      if (Number.isNaN(ref[i])) { assert(Number.isNaN(mine[i]), `warmup NaN at ${i}`); continue; }
      assert(Math.abs(mine[i] - ref[i]) < 1e-9, `ema ${i}: ${mine[i]} vs ${ref[i]}`);
    }
  });

  await test('spot-trend: daily returns match research portfolioSeries (vol target 40% and 0/1)', () => {
    for (const vt of [0.4, null]) {
      const mine = symbolReturns(dailyStates('BTC', spotDays, vt));
      const ref = researchPortfolioSeries(spotBars, 20, vt);
      let compared = 0;
      for (let i = 22; i < spotDays.length; i++) {
        const a = mine.get(new Date(spotDays[i].t).toISOString().slice(0, 10)), b = ref.get(spotDays[i].t);
        assert(Math.abs(a.ret - b.ret) < 1e-12 && Math.abs(a.bh - b.bh) < 1e-12, `vt=${vt} day ${i}: ${a.ret} vs ${b.ret}`);
        compared++;
      }
      assertEqual(compared, spotDays.length - 22, 'every warmed day compared');
    }
  });

  await test('spot-trend: states, weights and flips follow close vs EMA20', () => {
    const rows = dailyStates('ETH', spotDays);
    assert(rows.every((r) => r.state === (r.close > r.ema20 ? 'IN' : 'OUT')), 'state = close above EMA20');
    assert(rows.every((r) => r.state === 'OUT' ? r.weight === 0 : r.weight === null || (r.weight > 0 && r.weight <= 1)), 'weight 0 when OUT, (0,1] when IN');
    const flips = flipsFrom(rows);
    assert(flips.length > 0, 'the random walk crosses its EMA');
    assert(flips.every((f) => f.from !== f.to), 'a flip changes state');
  });

  await test('spot-trend: dailyFromKraken keeps closed candles only and drops bad rows', () => {
    const t0 = Date.UTC(2026, 8, 25) / 1000;
    const result = { XXBTZUSD: [[t0, '1', '1', '1', '100', '0', '1', 1], [t0 + 86400, '1', '1', '1', 'x', '0', '1', 1], [t0 + 2 * 86400, '1', '1', '1', '102', '0', '1', 1]], last: 0 };
    const out = dailyFromKraken(result, (t0 + 2 * 86400 + 3600) * 1000);
    assertEqual(out.length, 1, 'bad close dropped, forming day dropped');
    assertEqual(out[0].c, 100, 'first closed day kept');
  });

  await test('spot-trend: updateSpotTrend is idempotent and starts the ledger at the first live day', () => {
    const dir = tmp();
    {
      const first = updateSpotTrend(dir, { BTC: spotDays.slice(0, 250) }, spotDays[250].t);
      assert(first.days > 200, `history rows written (${first.days})`);
      assertEqual(first.startDate, new Date(spotDays[249].t).toISOString().slice(0, 10), 'startDate = latest closed day at first run');
      assertEqual(first.ledgerDays, 0, 'nothing earned yet on the first live day');
      const again = updateSpotTrend(dir, { BTC: spotDays.slice(0, 250) }, spotDays[250].t);
      assertEqual(again.days, 0, 'second run adds no day rows');
      assertEqual(again.flips, 0, 'second run adds no flips');
      const next = updateSpotTrend(dir, { BTC: spotDays.slice(0, 252) }, spotDays[252].t);
      assertEqual(next.days, 2, 'two new closed days');
      const flipRows = readFileSync(path.join(spotDir(dir), 'flips.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert(flipRows.every((f) => f.live === f.date > first.startDate), 'live marks only flips after startDate');
      assertEqual(next.ledgerDays, 2, 'ledger earns from the day after startDate');
      const ledger = JSON.parse(readFileSync(path.join(spotDir(dir), 'ledger.json'), 'utf8'));
      assertEqual(ledger.startDate, first.startDate, 'startDate persisted');
      assert(ledger.rows.every((r) => Number.isFinite(r.equity) && Number.isFinite(r.bh)), 'equity and buy & hold are numbers');
    }
  });

  await test('spot alerts: only live, recent, not-yet-alerted flips; one per symbol+day', () => {
    const now = Date.parse('2026-10-02T00:20:00Z');
    const flips = [
      { date: '2026-09-15', symbol: 'SOL', from: 'IN', to: 'OUT', close: 96.8, ema20: 99.5, weight: 0, live: false, recordedAt: '2026-10-02T00:10:00Z' },
      { date: '2026-10-01', symbol: 'BTC', from: 'IN', to: 'OUT', close: 80000, ema20: 81000, weight: 0, live: true, recordedAt: '2026-10-02T00:10:00Z' },
      { date: '2026-09-29', symbol: 'ETH', from: 'OUT', to: 'IN', close: 4000, ema20: 3900, weight: 0.6, live: true, recordedAt: '2026-09-30T00:10:00Z' }
    ];
    const fresh = findNewSpotFlips(flips, [], now);
    assertEqual(fresh.map((f) => f.key).join(','), 'spot|BTC|2026-10-01', 'history and >24h-old flips skipped');
    assertEqual(findNewSpotFlips(flips, [spotAlertKey(flips[1])], now).length, 0, 'already alerted -> skipped');
    const a = formatSpotAlert(fresh[0], { mention: 'owner' });
    assert(a.title.startsWith('SPOT BTC → OUT (hold USDC)'), a.title);
    assert(a.body.includes('Paper tracking only') && a.body.includes('cc @owner') && a.body.includes('<!-- alert-key: spot|BTC|2026-10-01 -->'), 'body: paper note, mention, key');
    assert(a.telegram.startsWith('SPOT BTC: IN → OUT (hold USDC)') && a.telegram.includes('Suggested weight 0%') && a.telegram.includes('/spot.html'), 'plain-text Telegram message');
  });

  await test('spot page: renders empty state and live data with stable ids', () => {
    const empty = renderSpot();
    for (const id of ['spot-trend-state-row', 'spot-trend-equity-panel', 'spot-trend-flips-table', 'spot-trend-backtest-panel', 'spot-trend-state-btc']) assert(empty.includes(`id="${id}"`), `empty page has ${id}`);
    assert(empty.includes('[NO DAILY CLOSE YET]') && empty.includes('[NO FLIPS YET]'), 'empty states shown');
    assert(/<a href="how-to.html"[^>]*id="spot-trend-nav-how-to-link"/.test(empty), 'spot links to how-to');
    assert(/<a href="risk.html"[^>]*id="spot-trend-nav-risk-link"/.test(empty), 'spot links to risk');
    const dir = tmp();
    updateSpotTrend(dir, { BTC: spotDays.slice(0, 250) }, spotDays[250].t);
    updateSpotTrend(dir, { BTC: spotDays.slice(0, 260) }, spotDays[260].t);
    const html = renderSpot(readSpotData(dir));
    assert(html.includes('id="spot-trend-equity-svg"') && html.includes('id="spot-trend-equity-filter"'), 'equity chart and numbers once the ledger has days');
    assert(/id="spot-trend-state-btc-state">(IN · HOLD|OUT · USDC)</.test(html), 'BTC state rendered');
    assert(html.includes('id="spot-trend-flip-row-0"'), 'flip rows rendered');
  });

  await test('product page: renders every required section, no secrets, no scripts, both themes', () => {
    const html = renderProduct();
    assert(html.includes('<!doctype html>') && html.includes('id="product-page-title"'), 'page shell');
    for (const id of [
      'product-what-section', 'product-strategies-section', 'product-capabilities-section', 'product-limitations-section',
      'product-goals-section', 'product-howto-section', 'product-stack-section', 'product-revenue-section'
    ]) {
      assert(html.includes(`id="${id}"`), `missing #${id}`);
      assert(html.includes(`href="#${id}"`), `jump nav missing a link to #${id}`);
    }
    // Every performance number on this page must trace to a source: spot-check a few load-bearing
    // figures and their GitHub blob citations (Bai-ee/snapshot_tradingview @ upgrade-signal-engine).
    for (const fact of ['+0.47R gross', '−2.37R net', '523.14', '61.11%', '2,994', '1,041', '1,008', '945', '0.34%', '0.14%']) {
      assert(html.includes(fact), `product page states: ${fact}`);
    }
    assert(html.includes('github.com/Bai-ee/snapshot_tradingview/blob/upgrade-signal-engine/'), 'cites GitHub blob sources');
    assert(!/<script/i.test(html), 'no scripts');
    assert(!/SCALP_CONTEXT_API_KEY|Bearer |SOLANA_PRIVATE_KEY|EXECUTION_PIN=|RPC_URL/i.test(html), 'no secrets or key material');
    assert(html.includes('prefers-color-scheme: dark') && html.includes('prefers-color-scheme: light'), 'both schemes');
  });

  await test('product page: nav parity — every other page links to product.html, product.html links back', () => {
    const dir = tmp();
    const out = path.join(dir, 'site');
    const { htmlFile, howToFile, riskFile, strategiesFile, spotFile, productFile } = buildPage(path.join(dir, 'data'), out, T0);
    assertEqual(productFile, path.join(out, 'product.html'), 'buildPage reports the product file path');
    const index = readFileSync(htmlFile, 'utf8');
    const howTo = readFileSync(howToFile, 'utf8');
    const risk = readFileSync(riskFile, 'utf8');
    const strategies = readFileSync(strategiesFile, 'utf8');
    const spot = readFileSync(spotFile, 'utf8');
    const product = readFileSync(productFile, 'utf8');
    assert(/<a[^>]*href="product\.html"[^>]*id="tracker-product-link"/.test(index), 'index links to product');
    assert(/<a[^>]*id="home-hero-product-link"[^>]*href="product\.html"/.test(index), 'home hero links to product');
    assert(/<a[^>]*href="product\.html"[^>]*id="howto-nav-product-link"/.test(howTo), 'how-to nav links to product');
    assert(howTo.includes('id="howto-product-pointer"') && howTo.includes('href="product.html"'), 'how-to has a top-of-page Learn more pointer to product.html');
    assert(/<a[^>]*href="product\.html"[^>]*id="risk-nav-product-link"/.test(risk), 'risk links to product');
    assert(/<a[^>]*href="product\.html"[^>]*id="strategies-nav-product-link"/.test(strategies), 'strategies links to product');
    assert(/<a[^>]*href="product\.html"[^>]*id="spot-trend-nav-product-link"/.test(spot), 'spot links to product');
    assert(product.includes('href="index.html"') && product.includes('href="how-to.html"') && product.includes('href="risk.html"') && product.includes('href="strategies.html"') && product.includes('href="spot.html"'), 'product links back to every other page');
  });

  // ---------- T-24 prediction tracker (agent B, docs/PROMPT_T24_PREDICTION_TRACKER.md) ----------
  // Synthetic PREDICTION / PREDICTION_RESULT rows only - lib/predictionRule.js (agent A) and the
  // live writer (agent D) are separate worktrees, merged later; this codes strictly against the
  // shared row and aggregate contract.

  function predRow(id, symbol, timeframe, closedAt, refClose, direction) {
    return { id, kind: 'PREDICTION', symbol, timeframe, closedAt, refClose, direction, confidence: Math.abs({ over: 2, under: -2, no_call: 0 }[direction] || 0) / 5,
      inputs: {}, reason: 'test', configVersion: 'v-test', ruleVersion: 'pred-1.1', writtenAt: closedAt };
  }
  function resultRow(id, symbol, timeframe, closedAt, refClose, nextClose, hit, lastCandleDir) {
    return { id, kind: 'PREDICTION_RESULT', symbol, timeframe, closedAt, refClose, nextClose,
      moveBps: Math.round(((nextClose - refClose) / refClose) * 1e4 * 10) / 10, hit, lastCandleDir, writtenAt: closedAt };
  }
  const P5 = 5 * 60_000;
  function predPair(i, { symbol = 'BTC', timeframe = '5m', direction = 'over', hit = true, lastCandleDir, refClose = 100, move = 1 } = {}) {
    const t0 = new Date(Date.parse('2026-09-01T00:00:00Z') + i * P5).toISOString();
    const t1 = new Date(Date.parse('2026-09-01T00:00:00Z') + (i + 1) * P5).toISOString();
    const nextClose = hit === null ? refClose : (hit ? refClose * (1 + move / 100) : refClose * (1 - move / 100));
    const dir = lastCandleDir || (hit === false ? (direction === 'over' ? 'under' : 'over') : direction === 'no_call' ? 'flat' : direction);
    return [predRow(`${symbol}:${timeframe}:${t0}`, symbol, timeframe, t0, refClose, direction),
      resultRow(`${symbol}:${timeframe}:${t0}`, symbol, timeframe, t1, refClose, nextClose, hit, dir)];
  }

  await test('predictions store: appendPredictions/readPredictions dedupe by id+kind, not by id alone', () => {
    const dir = tmp();
    const [p, r] = predPair(0);
    const a1 = appendPredictions(dir, [p, r]);
    assertEqual(a1.added, 2, 'PREDICTION and its own PREDICTION_RESULT share an id but differ in kind - both kept');
    const a2 = appendPredictions(dir, [p, r]);
    assertEqual(a2.added, 0, 'repeat of the same id+kind is a duplicate');
    assertEqual(a2.duplicates, 2, 'both rows deduped');
    assertEqual(readPredictions(dir).length, 2, 'both rows stored');
    assert(existsSync(path.join(predictionsDir(dir), '2026-09-01.jsonl')), 'day file = UTC day of closedAt');
    assertEqual(predictionRowKey(p), `${p.id}|PREDICTION`, 'dedupe key is id+kind');
  });

  await test('predictions store: readPredictions sorts by closedAt across day files', () => {
    const dir = tmp();
    const [p1, r1] = predPair(0); // closes 2026-09-01T00:00 / 00:05
    const [p2, r2] = predPair(300, { symbol: 'ETH' }); // 25h later -> next day file
    appendPredictions(dir, [r2, p2, r1, p1]);
    const rows = readPredictions(dir);
    assertEqual(rows[0].id, p1.id, 'earliest closedAt first');
    assert(Date.parse(rows[0].closedAt) <= Date.parse(rows[rows.length - 1].closedAt), 'ascending by closedAt');
  });

  await test('predictionRowsFromLines: keeps only well-formed PREDICTION/PREDICTION_RESULT rows', () => {
    const [p] = predPair(0);
    const rows = predictionRowsFromLines([p, { ...p, id: undefined }, { ...p, kind: 'OTHER' }, { ...p, closedAt: 'not-a-date' }, null, [1], 'x']);
    assertEqual(rows.length, 1, 'only the valid row survives');
  });

  await test('predictions pull: manifest + day file, dedupe id+kind, second pull adds nothing, missing manifest is not an error', async () => {
    const dir = tmp();
    const base = 'https://storeX.public.blob.vercel-storage.com';
    const [p, r] = predPair(0);
    const files = {
      [`${base}/predictions/manifest.json`]: JSON.stringify({ schemaVersion: 'predictions-manifest-1', baseUrl: base, days: ['2026-09-01', 'bad'] }),
      [`${base}/predictions/2026-09-01.jsonl`]: [JSON.stringify(p), JSON.stringify(r), '{torn'].join('\n')
    };
    const fakeFetch = async (url) => {
      const key = url.split('?')[0];
      return files[key] === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => files[key] };
    };
    const r1 = await pullPredictions(dir, base, fakeFetch, 1);
    assertEqual(r1.days, 1, 'valid day only');
    assertEqual(r1.added, 2, 'PREDICTION + PREDICTION_RESULT');
    const r2 = await pullPredictions(dir, base, fakeFetch, 2);
    assertEqual(r2.added, 0, 'second pull adds nothing new');
    const none = await pullPredictions(tmp(), 'https://empty.public.blob.vercel-storage.com', fakeFetch);
    assertEqual(none.added, 0, 'missing manifest -> nothing, not an error');
  });

  await test('joinPredictions: pairs a PREDICTION with its PREDICTION_RESULT by id; unresolved stays null', () => {
    const [p1, r1] = predPair(0);
    const [p2] = predPair(1); // no result yet
    const joined = joinPredictions([p1, r1, p2]);
    assertEqual(joined.length, 2, 'one row per PREDICTION');
    assertEqual(joined.find((j) => j.id === p1.id).result.id, r1.id, 'resolved prediction carries its result');
    assertEqual(joined.find((j) => j.id === p2.id).result, null, 'unresolved prediction has a null result');
  });

  await test('joinPredictions: rows from an ignored rule version (pred-1, BTC-candle bug) are dropped', async () => {
    const good = predRow('ETH:5m:2026-09-29T05:00:00.000Z', 'ETH', '5m', '2026-09-29T05:00:00.000Z', 2650, 'over');
    const bad = { ...predRow('ETH:5m:2026-09-29T04:00:00.000Z', 'ETH', '5m', '2026-09-29T04:00:00.000Z', 83035.7, 'under'), ruleVersion: 'pred-1' };
    const joined = joinPredictions([bad, good]);
    assert(joined.length === 1 && joined[0].id === good.id, JSON.stringify(joined.map((r) => r.id)));
  });

  await test('computePredictionsAggregate: hitRate math - no_call excluded from n but counted in noCalls', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(...predPair(i, { hit: i < 14 }));
    const [pNo, rNo] = predPair(20, { direction: 'no_call', hit: null });
    rows.push(pNo, rNo);
    const agg = computePredictionsAggregate(rows, []);
    const c = agg.cells['BTC:5m'];
    assertEqual(c.n, 20, 'no_call excluded from n');
    assertEqual(c.hits, 14);
    assertEqual(c.misses, 6);
    assertEqual(c.noCalls, 1);
    assertEqual(c.hitRate, 0.7, '14/20');
    assertEqual(c.coinFlip, 0.5);
  });

  await test('computePredictionsAggregate: sameAsLastRate baseline from lastCandleDir vs the actual move direction', () => {
    const rows = [
      ...predPair(0, { hit: true, lastCandleDir: 'over' }), // actual over, last over -> baseline right
      ...predPair(1, { hit: true, lastCandleDir: 'under' }), // actual over, last under -> baseline wrong
      ...predPair(2, { hit: false, lastCandleDir: 'under' }), // actual under, last under -> baseline right
      ...predPair(3, { hit: false, lastCandleDir: 'over' }) // actual under, last over -> baseline wrong
    ];
    const agg = computePredictionsAggregate(rows, []);
    const c = agg.cells['BTC:5m'];
    assertEqual(c.n, 4);
    assertEqual(c.sameAsLastRate, 0.5, '2 of 4 decided results match their own last-candle direction');
  });

  await test('computePredictionsAggregate: meanMoveBpsHit/meanMoveBpsMiss are mean |moveBps| for correct vs incorrect calls', () => {
    const rows = [...predPair(0, { hit: true, move: 2 }), ...predPair(1, { hit: true, move: 4 }), ...predPair(2, { hit: false, move: 1 })];
    const agg = computePredictionsAggregate(rows, []);
    const c = agg.cells['BTC:5m'];
    assertEqual(c.meanMoveBpsHit, 300, 'mean of ~200 and ~400 bps');
    assertEqual(c.meanMoveBpsMiss, 100, 'single miss ~100 bps');
  });

  await test('computePredictionsAggregate: byTimeframe/bySymbol roll up the same underlying decided calls', () => {
    const rows = [
      ...predPair(0, { symbol: 'BTC', timeframe: '5m', hit: true }),
      ...predPair(1, { symbol: 'BTC', timeframe: '15m', hit: false }),
      ...predPair(2, { symbol: 'ETH', timeframe: '5m', hit: true })
    ];
    const agg = computePredictionsAggregate(rows, []);
    assertEqual(agg.bySymbol.BTC.n, 2, 'BTC across both timeframes');
    assertEqual(agg.bySymbol.ETH.n, 1);
    assertEqual(agg.bySymbol.SOL.n, 0, 'untouched symbol stays at zero, not missing');
    assertEqual(agg.byTimeframe['5m'].n, 2, '5m across both symbols');
    assertEqual(agg.byTimeframe['15m'].n, 1);
    assertEqual(agg.overall.n, 3, 'overall = every decided call');
  });

  await test('computePredictionsAggregate: duringGood restricts to result rows overlapping a scored GOOD call for that symbol', () => {
    const inside = predPair(0, { symbol: 'BTC' }); // closes 2026-09-01T00:00 / 00:05, inside the GOOD window below
    const outside = predPair(2000, { symbol: 'BTC' }); // ~1 week later, well outside
    const otherSymbol = predPair(0, { symbol: 'ETH' }); // same time window, different symbol
    const good = [{ symbol: 'BTC', calledAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:10:00Z' }];
    const agg = computePredictionsAggregate([...inside, ...outside, ...otherSymbol], good);
    assertEqual(agg.duringGood.n, 1, 'only the BTC call inside the GOOD window counts');
  });

  await test('computePredictionsAggregate: since is the first PREDICTION row; empty input matches the empty shape', () => {
    const rows = [...predPair(5), ...predPair(0), ...predPair(10)];
    const agg = computePredictionsAggregate(rows, []);
    assertEqual(agg.since, new Date(Date.parse('2026-09-01T00:00:00Z')).toISOString(), 'earliest PREDICTION closedAt, i=0');
    const empty = computePredictionsAggregate([], []);
    assertEqual(empty.since, null);
    assertEqual(empty.overall.n, 0);
    assertEqual(Object.keys(empty.cells).length, PREDICTION_SYMBOLS.length * PREDICTION_TIMEFRAMES.length, '3x4 = 12 cells always present');
    assertEqual(JSON.stringify(empty.overall), JSON.stringify(EMPTY_PREDICTIONS_AGGREGATE.overall), 'matches the exported empty shape');
  });

  await test('predCellBeats: coloured only at n >= 30 and beating both the coin flip and same-as-last baselines', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(...predPair(i, { hit: i < 20, lastCandleDir: i % 2 === 0 ? 'flat' : undefined }));
    const agg = computePredictionsAggregate(rows, []);
    const c = agg.cells['BTC:5m'];
    assertEqual(c.n, 30);
    assert(c.hitRate > 0.5 && c.hitRate > c.sameAsLastRate, 'fixture beats both baselines');
    assert(predCellBeats(c), 'n=30 and beats both -> coloured');
    const shy = computePredictionsAggregate(rows.slice(0, 58), []).cells['BTC:5m']; // 29 pairs = 58 rows
    assert(!predCellBeats(shy), 'n=29 -> not coloured even with the same rate');
    assert(!predCellBeats(null), 'no cell -> not coloured');
  });

  await test('predictions render: grid + summary line carry the stable ids for every symbol x timeframe cell', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(...predPair(i, { hit: i < 20 }));
    const agg = computePredictionsAggregate(rows, []);
    const grid = predictionsGridHtml(agg);
    assert(grid.includes('id="pred-grid"'), 'grid container id');
    for (const sym of PREDICTION_SYMBOLS) for (const tf of PREDICTION_TIMEFRAMES) assert(grid.includes(`id="pred-cell-${sym.toLowerCase()}-${tf}"`), `cell id for ${sym} ${tf}`);
    const summary = predictionsSummaryLine(agg);
    assert(summary.includes('Overall') && summary.includes('coin flip 50%') && summary.includes('same-as-last') && summary.includes('since 2026-09-01'), 'summary line shape');
    assertEqual(predictionsZoneBody(EMPTY_PREDICTIONS_AGGREGATE), `<p class="empty" id="zone-predictions-empty">${NO_PREDICTIONS}</p>`, 'empty aggregate renders the empty state, not the grid');
  });

  await test('T-24c: zone-predictions is absent from the homepage body; the prediction panel takes its place in the hero', () => {
    const dir = tmp();
    const out = path.join(dir, 'site');
    const { htmlFile, predictionsFile } = buildPage(path.join(dir, 'data'), out, T0);
    const html = readFileSync(htmlFile, 'utf8');
    assert(!html.includes('id="zone-predictions"'), 'zone-predictions block is gone from the homepage body');
    assert(html.includes('id="home-hero-prediction-panel"'), 'the prediction panel takes its place in the hero');
    assert(html.includes('id="tracker-predictions-link"') && html.includes('href="predictions.html"'), 'nav link to the predictions page');
    assert(existsSync(predictionsFile) && predictionsFile.endsWith('predictions.html'), 'buildPage writes docs/predictions.html');
  });

  await test('T-24c: predictions.html still carries the shared zone-predictions renderer (predictionsZoneBody), unchanged by the homepage move', () => {
    const dir = tmp();
    const out = path.join(dir, 'site');
    const { predictionsFile } = buildPage(path.join(dir, 'data'), out, T0);
    const predHtml = readFileSync(predictionsFile, 'utf8');
    assert(predHtml.includes('zone-predictions-empty'), 'predictions.html renders predictionsZoneBody\'s own empty-state id (no data dir here)');
    assert(!predHtml.includes('id="home-hero-prediction-panel"'), 'the hero panel itself is homepage-only, not on predictions.html');

    const dir2 = tmp();
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(...predPair(i, { hit: i < 3 }));
    appendPredictions(path.join(dir2, 'data'), rows);
    const { predictionsFile: predictionsFile2 } = buildPage(path.join(dir2, 'data'), path.join(dir2, 'site'), Date.parse('2026-09-05T00:00:00Z'));
    const predHtml2 = readFileSync(predictionsFile2, 'utf8');
    assert(predHtml2.includes('id="pred-grid"') && predHtml2.includes('id="pred-summary-line"'), 'with live data, predictionsZoneBody renders the grid + summary on predictions.html, same renderer as before');
  });

  await test('T-24c: computePredictionsAggregate current - unresolved latest per cell, falls back to the resolved one, null with no predictions', () => {
    const [pOld, rOld] = predPair(0, { hit: true }); // resolved, older
    const [pNew] = predPair(1); // no result yet, newer
    const agg1 = computePredictionsAggregate([pOld, rOld, pNew], []);
    const cur1 = agg1.current['BTC:5m'];
    assert(cur1 && cur1.resolved === undefined, 'the unresolved newer prediction wins over the older resolved one');
    assertEqual(cur1.direction, pNew.direction);
    assertEqual(cur1.refClose, pNew.refClose);
    assertEqual(cur1.closedAt, pNew.closedAt);

    const agg2 = computePredictionsAggregate([pOld, rOld], []);
    const cur2 = agg2.current['BTC:5m'];
    assert(cur2 && cur2.resolved === true, 'no pending prediction -> falls back to the latest resolved one');
    assertEqual(cur2.hit, true);
    assertEqual(cur2.closedAt, pOld.closedAt);

    assertEqual(EMPTY_PREDICTIONS_AGGREGATE.current['ETH:1h'], null, 'a cell with no predictions at all is null');
    assertEqual(computePredictionsAggregate([], []).current['BTC:5m'], null);
  });

  await test('T-24c: predictionsCurrentTableHtml renders all 12 rows in BTC/ETH/SOL x 5m/15m/1h/4h order with stable ids', () => {
    const html = predictionsCurrentTableHtml(EMPTY_PREDICTIONS_AGGREGATE);
    assert(html.includes('id="pred-current-table"'), 'table container id');
    const order = PREDICTION_SYMBOLS.flatMap((sym) => PREDICTION_TIMEFRAMES.map((tf) => `pred-row-${sym.toLowerCase()}-${tf}`));
    let cursor = -1;
    for (const id of order) {
      const idx = html.indexOf(`id="${id}"`);
      assert(idx > cursor, `${id} present and after the previous row`);
      cursor = idx;
    }
    assertEqual(order.length, 12, '3 coins x 4 timeframes = 12 rows');
    assertEqual(predictionNextGlyph(null), '·', 'no current prediction -> no-call middle dot');
    assertEqual(predictionNextGlyph({ direction: 'over' }), '▲', 'over -> up arrow');
    assertEqual(predictionNextGlyph({ direction: 'under' }), '▼', 'under -> down arrow');
    assertEqual(predictionNextGlyph({ direction: 'no_call' }), '·', 'no_call -> middle dot, not an arrow');
  });

  await test('T-24c: predictionsCurrentTableHtml "last" column reads the latest resolved result for that cell, even with a newer pending call', () => {
    const [pHit, rHit] = predPair(0, { hit: true }); // resolved hit, older
    const [pMiss, rMiss] = predPair(1, { hit: false }); // resolved miss, newer than the hit
    const [pPending] = predPair(2); // newest, no result yet -> becomes `current`, not `last`
    const agg = computePredictionsAggregate([pHit, rHit, pMiss, rMiss, pPending], []);
    assert(!agg.current['BTC:5m'].resolved, 'the newest pending prediction is `current`');
    const html = predictionsCurrentTableHtml(agg);
    const row = html.slice(html.indexOf('id="pred-row-btc-5m"'), html.indexOf('id="pred-row-eth-5m"'));
    assert(row.includes('class="pred-current-last">✗<'), 'last column shows the miss - the most recently RESOLVED result, not the still-pending newest call');

    const onlyHit = computePredictionsAggregate([pHit, rHit], []);
    const rowHit = predictionsCurrentTableHtml(onlyHit);
    assert(rowHit.slice(rowHit.indexOf('id="pred-row-btc-5m"')).includes('class="pred-current-last">✓<'), 'a resolved hit shows a checkmark');

    const none = predictionsCurrentTableHtml(EMPTY_PREDICTIONS_AGGREGATE);
    assert(none.includes('class="pred-current-last">–<'), 'no result yet -> dash');
  });

  await test('T-24c: predictionsOverallHtml formats the overall hit rate, n and since, plus both baselines', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(...predPair(i, { hit: i < 14 }));
    const agg = computePredictionsAggregate(rows, []);
    const html = predictionsOverallHtml(agg);
    assert(html.includes('id="pred-overall-rate">70%<'), 'overall hit rate, one-decimal percent formatting (70% here)');
    assert(html.includes('id="pred-overall-meta">n=20 · since 2026-09-01<'), 'n and since sit under the figure');
    assert(html.includes('id="pred-overall-baseline">coin flip 50% · same-as-last'), 'both baselines on their own line');
  });

  await test('T-24c: predictionsOverallHtml/predictionsPanelHtml empty state shows a dash and [NO PREDICTIONS YET]; panel never hidden', () => {
    const overall = predictionsOverallHtml(EMPTY_PREDICTIONS_AGGREGATE);
    assert(overall.includes('id="pred-overall-rate' ) && overall.includes('–'), 'empty overall figure is a dash');
    assert(overall.includes(NO_PREDICTIONS), 'empty state names [NO PREDICTIONS YET]');
    const panel = predictionsPanelHtml({});
    assert(panel.includes('id="home-hero-prediction-panel"'), 'panel renders with no aggregate at all');
    assert(panel.includes('id="pred-current-table"'), 'the 12-row table still renders in the empty state');
    assert(panel.includes('id="pred-panel-foot-link"') && panel.includes('href="predictions.html"'), 'footer links to predictions.html');
  });

  await test('T-24c/owner 2026-09-29: homeHero right column = prediction panel over the live board, both inside the hero shell', () => {
    const html = homeHero([], '2026-09-29T01:00:00.000Z', {});
    const iShellOpen = html.indexOf('id="home-hero-shell"');
    const iPanel = html.indexOf('id="home-hero-prediction-panel"');
    const iBoard = html.indexOf('id="live-board-card"');
    assert(iShellOpen > -1 && iPanel > iShellOpen, 'prediction panel sits inside home-hero-shell');
    assert(iBoard > iPanel, 'live board markup follows the prediction panel');
    // The panel is a single, self-contained block: the live board never nests inside it.
    const panelOnly = predictionsPanelHtml({});
    assert(!panelOnly.includes('id="live-board-card"'), 'live board is not part of the panel markup');
    assert(HOME_HERO_CSS.includes('.home-hero-side-column{grid-area:board'), 'the side column (panel over live board) claims the hero\'s board grid area (owner 2026-09-29)');
    assert(!PREDICTIONS_CSS.includes('grid-area:board') && !HOME_HERO_CSS.includes('.live-board{grid-area:board}'), 'neither the panel nor the board pins itself to the grid; the column does');
    assert(html.indexOf('id="home-hero-side-column"') < iPanel && html.lastIndexOf('</div>') > iBoard, 'panel and live board both sit inside the side column');
  });

  await test('predictions.html: full breakdown tables, last-50 results, method paragraph and the GitHub study link, empty and populated', () => {
    const empty = renderPredictionsPage(EMPTY_PREDICTIONS_AGGREGATE);
    assert(empty.includes(NO_PREDICTIONS), 'empty state');
    assert(empty.includes('id="predictions-method-note"'), 'method paragraph always present');
    assert(empty.includes('id="predictions-study-link"') && empty.includes('PREDICTION_STUDY_2026-09-28.md'), 'links to the replay study (may 404 until merge)');
    assert(!/<script/i.test(empty), 'no scripts, same as the other static pages');

    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(...predPair(i, { hit: i < 3 }));
    const agg = computePredictionsAggregate(rows, []);
    const full = renderPredictionsPage(agg);
    assert(full.includes('id="predictions-by-cell-table"'), 'by-cell table');
    assert(full.includes('id="predictions-by-timeframe-table"'), 'by-timeframe table');
    assert(full.includes('id="predictions-by-coin-table"'), 'by-coin table');
    assert(full.includes('id="predictions-overall-table"'), 'overall + during-GOOD table');
    assert(full.includes('id="predictions-last-table"'), 'last-50 results table');
    assert(full.includes('id="predictions-back-link"') && full.includes('href="index.html"'), 'links back to the tracker');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
