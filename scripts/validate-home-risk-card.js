#!/usr/bin/env node
/**
 * Home-page Risk card — validation harness
 *
 *   node scripts/validate-home-risk-card.js
 *
 * Two things are checked here, and they are different things.
 *
 * 1. THE CARD IS HONEST. public/js/riskHomeCard.js is a pure function of the
 *    display cache, so every degraded state the home page can be in — never
 *    evaluated, wallet outage, stale cache, corrupt record — is reachable as
 *    a plain object. Nothing here needs a browser, a wallet, an RPC or a
 *    price provider, which is the point: the card must be provably correct
 *    when every provider is down, and that is exactly when it cannot be
 *    tested against one.
 *
 * 2. THE CACHE IS COMPLETE. The card can only be honest about facts it is
 *    given, so this harness also runs the REAL engine over a fixture account,
 *    builds the display block exactly as riskPage.js does, and asserts the
 *    card can render it. If riskPage.js and riskHomeCard.js ever disagree
 *    about what the cache contains, this fails.
 *
 * The invariant behind almost every assertion: NO ABSENT FIGURE MAY EVER
 * RENDER AS A ZERO. A zero is a claim about an account. A dash is not.
 *
 * Exit code 0 = all assertions hold.
 */

import {
  buildRiskHomeCard,
  formatWalletValue,
  formatRiskPct,
  formatAge,
  HOME_CARD_STATE,
  HOME_CACHE_STALE_MS
} from '../public/js/riskHomeCard.js';

import {
  calculateAdjustedEquity,
  buildEquityCurve,
  calculateDrawdown,
  calculateRecentPerformance,
  calculateRiskLevel,
  calculateLevelProgress,
  calculateOpenRisk,
  calculateDirectionalConcentration,
  calculateStrategyEnvelope,
  evaluateNoTradeConstraints,
  getLevelDefinition
} from '../public/js/adaptiveRisk.js';

import { formatLevelLine, isReadStale, resolveAccountDecision, STALE_WALLET_MS } from '../public/js/riskPage.js';

let failures = 0;
let assertions = 0;

function ok(name, condition, detail = '') {
  assertions++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

/** Every string the card can put on screen, for the "no stray zero" sweeps. */
function renderedStrings(view) {
  return [
    view.levelLine,
    view.levelName,
    view.decision,
    view.strategy,
    view.note,
    view.ariaLabel,
    ...view.figures.map((f) => f.value),
    ...view.figures.map((f) => f.label)
  ].filter((s) => typeof s === 'string');
}

const NOW = Date.parse('2026-06-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60000;

/**
 * A complete, fresh display block — the shape riskPage.js writes. Every test
 * below starts from this and removes or corrupts exactly one thing, so a
 * failure names the field that caused it.
 */
function displayFixture(overrides = {}) {
  return {
    level: 1,
    peakLevel: 1,
    progressPct: 42,
    nextLevel: 2,
    atCap: false,
    posture: 'EARNED',
    currentDrawdownPct: 3.2,
    openRiskPct: 1.25,
    openPositions: 2,
    walletValue: 24800,
    totalClosedTrades: 14,
    levelLine: 'LEVEL 1 · 42% TO LEVEL 2',
    levelLabel: 'Established',
    strategy: 'STANDARD',
    decision: 'TRADE',
    blockerCount: 0,
    primaryBlocker: null,
    walletStatus: 'OK',
    walletAt: ago(2 * MINUTE),
    at: ago(2 * MINUTE),
    ...overrides
  };
}

/* ======================================================================
 * 1. FORMATTERS NEVER INVENT A NUMBER
 * =================================================================== */

section('1. Formatters return a dash for absent data, never a zero');

for (const [label, value] of [
  ['null', null],
  ['undefined', undefined],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a string', '24800'],
  ['an object', {}]
]) {
  ok(`formatWalletValue(${label}) is a dash`, formatWalletValue(value) === '—', `got ${formatWalletValue(value)}`);
  ok(`formatRiskPct(${label}) is a dash`, formatRiskPct(value) === '—', `got ${formatRiskPct(value)}`);
}

ok('formatWalletValue formats thousands', formatWalletValue(24800) === '$24.8K', formatWalletValue(24800));
ok('formatWalletValue formats millions', formatWalletValue(1250000) === '$1.25M', formatWalletValue(1250000));
ok('formatWalletValue formats small balances', formatWalletValue(940) === '$940', formatWalletValue(940));
ok('formatWalletValue keeps cents under $100', formatWalletValue(12.5) === '$12.50', formatWalletValue(12.5));
ok('formatWalletValue signs a negative', formatWalletValue(-2400).startsWith('-$'), formatWalletValue(-2400));
ok('formatWalletValue renders a real zero as $0', formatWalletValue(0) === '$0', formatWalletValue(0));
ok('formatRiskPct keeps two decimals', formatRiskPct(1.25) === '1.25%', formatRiskPct(1.25));

ok('formatAge on a missing stamp says never', formatAge(null, NOW) === 'never');
ok('formatAge on a corrupt stamp says never', formatAge('not-a-date', NOW) === 'never');
ok('formatAge in minutes', formatAge(ago(5 * MINUTE), NOW) === '5m ago', formatAge(ago(5 * MINUTE), NOW));
ok('formatAge in hours', formatAge(ago(3 * 60 * MINUTE), NOW) === '3h ago', formatAge(ago(3 * 60 * MINUTE), NOW));
ok('formatAge in days', formatAge(ago(50 * 60 * MINUTE), NOW) === '2d ago', formatAge(ago(50 * 60 * MINUTE), NOW));
ok('a future stamp does not render a negative age', formatAge(new Date(NOW + MINUTE).toISOString(), NOW) === 'just now');

/* ======================================================================
 * 2. NEVER EVALUATED — the home page before /risk has ever been opened
 * =================================================================== */

section('2. Before the Risk Manager has ever been opened');

for (const [label, display] of [
  ['null cache', null],
  ['undefined cache', undefined],
  ['a non-object cache', 'corrupt'],
  ['an empty object', {}],
  ['a cache with no level line', displayFixture({ levelLine: undefined })],
  ['a cache whose level line is not a string', displayFixture({ levelLine: 42 })]
]) {
  const view = buildRiskHomeCard({ display, now: NOW });
  ok(`${label} yields NEVER_EVALUATED`, view.state === HOME_CARD_STATE.NEVER_EVALUATED, view.state);
  ok(`${label} shows no level line`, view.levelLine === null);
  ok(`${label} reports INCOMPLETE`, view.decision === 'INCOMPLETE', view.decision);
  ok(`${label} shows no progress figure`, view.progressPct === null);
  ok(
    `${label} shows a dash for every figure, not a zero`,
    view.figures.every((f) => f.value === '—'),
    JSON.stringify(view.figures)
  );
  ok(`${label} says why`, typeof view.note === 'string' && /open the risk manager/i.test(view.note), String(view.note));
}

/* ======================================================================
 * 3. A FRESH, COMPLETE EVALUATION
 * =================================================================== */

section('3. A fresh, complete evaluation');

{
  const view = buildRiskHomeCard({ display: displayFixture(), now: NOW });
  ok('is FRESH', view.state === HOME_CARD_STATE.FRESH, view.state);
  ok('shows the engine level line verbatim', view.levelLine === 'LEVEL 1 · 42% TO LEVEL 2', String(view.levelLine));
  ok('shows the level name', view.levelName === 'ESTABLISHED', String(view.levelName));
  ok('shows progress', view.progressPct === 42, String(view.progressPct));
  ok('shows the wallet', view.figures[0].value === '$24.8K', view.figures[0].value);
  ok('shows open risk', view.figures[1].value === '1.25%', view.figures[1].value);
  ok('shows the position count', view.figures[2].value === '2', view.figures[2].value);
  ok('labels the third figure Positions', view.figures[2].label === 'Positions', view.figures[2].label);
  ok('shows the strategy', view.strategy === 'STANDARD', String(view.strategy));
  ok('reports TRADE', view.decision === 'TRADE', view.decision);
  ok('tones TRADE positive', view.decisionTone === 'POSITIVE', view.decisionTone);
  ok('adds no note when there is nothing to explain', view.note === null, String(view.note));
  ok('the aria label carries the level and the decision', /LEVEL 1/.test(view.ariaLabel) && /TRADE/.test(view.ariaLabel), view.ariaLabel);
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ decision: 'NO_TRADE', primaryBlocker: 'Defensive drawdown state' }), now: NOW });
  ok('NO_TRADE is spaced for display', view.decision === 'NO TRADE', view.decision);
  ok('NO_TRADE tones negative', view.decisionTone === 'NEGATIVE', view.decisionTone);
  ok('NO_TRADE surfaces the binding blocker', view.note === 'Defensive drawdown state', String(view.note));
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ strategy: 'AGGRESSIVE' }), now: NOW });
  ok('carries the AGGRESSIVE strategy through', view.strategy === 'AGGRESSIVE', String(view.strategy));
}

/* ======================================================================
 * 4. STALENESS — the decision expires with the balance it was computed from
 * =================================================================== */

section('4. Staleness');

{
  const justInside = buildRiskHomeCard({ display: displayFixture({ walletAt: ago(HOME_CACHE_STALE_MS - MINUTE), at: ago(HOME_CACHE_STALE_MS - MINUTE) }), now: NOW });
  ok('just inside the horizon stays FRESH', justInside.state === HOME_CARD_STATE.FRESH, justInside.state);
  ok('just inside the horizon keeps the decision', justInside.decision === 'TRADE', justInside.decision);

  const justOutside = buildRiskHomeCard({ display: displayFixture({ walletAt: ago(HOME_CACHE_STALE_MS + MINUTE), at: ago(HOME_CACHE_STALE_MS + MINUTE) }), now: NOW });
  ok('past the horizon is STALE', justOutside.state === HOME_CARD_STATE.STALE, justOutside.state);
  ok('a stale cache forces INCOMPLETE', justOutside.decision === 'INCOMPLETE', justOutside.decision);
  ok('a stale cache tones neutral', justOutside.decisionTone === 'NEUTRAL', justOutside.decisionTone);
  ok('a stale cache still shows the level', justOutside.levelLine === 'LEVEL 1 · 42% TO LEVEL 2', String(justOutside.levelLine));
  ok('a stale cache stamps its age', typeof justOutside.note === 'string' && /^As of/.test(justOutside.note), String(justOutside.note));
}

{
  // A cached NO_TRADE must not be softened by ageing out. Both stale and
  // NO_TRADE mean "do not act on this"; INCOMPLETE is the weaker of the two
  // only in that it says the input, not the account, is the problem.
  const view = buildRiskHomeCard({ display: displayFixture({ decision: 'NO_TRADE', walletAt: ago(5 * 60 * MINUTE), at: ago(5 * 60 * MINUTE) }), now: NOW });
  ok('an aged-out NO_TRADE does not become TRADE', view.decision !== 'TRADE', view.decision);
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ walletAt: null, at: ago(2 * MINUTE) }), now: NOW });
  ok('with no wallet read, the evaluation stamp decides freshness', view.state === HOME_CARD_STATE.FRESH, view.state);

  const noStamp = buildRiskHomeCard({ display: displayFixture({ walletAt: null, at: null }), now: NOW });
  ok('an unstamped cache is treated as stale', noStamp.state === HOME_CARD_STATE.STALE, noStamp.state);
  ok('an unstamped cache is INCOMPLETE', noStamp.decision === 'INCOMPLETE', noStamp.decision);

  const badStamp = buildRiskHomeCard({ display: displayFixture({ walletAt: 'not-a-date', at: 'not-a-date' }), now: NOW });
  ok('a corrupt stamp is treated as stale', badStamp.state === HOME_CARD_STATE.STALE, badStamp.state);

  // Clock skew, or a machine whose time moved backwards. A cache stamped in
  // the future has an age the freshness test cannot trust.
  const future = buildRiskHomeCard({ display: displayFixture({ walletAt: new Date(NOW + 60 * MINUTE).toISOString(), at: new Date(NOW + 60 * MINUTE).toISOString() }), now: NOW });
  ok('a future-stamped cache is treated as stale, not fresh', future.state === HOME_CARD_STATE.STALE, future.state);
}

/* ======================================================================
 * 5. PROVIDER FAILURE — the whole point of the card being cache-only
 * =================================================================== */

section('5. Wallet and price-provider failure');

for (const [label, walletValue] of [
  ['an unavailable wallet (null)', null],
  ['an undefined wallet', undefined],
  ['a NaN wallet', NaN],
  ['an Infinite wallet', Infinity]
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ walletValue, walletStatus: 'UNAVAILABLE' }), now: NOW });
  ok(`${label} renders as Unavailable`, view.figures[0].value === 'Unavailable', view.figures[0].value);
  ok(`${label} never renders as $0`, view.figures[0].value !== '$0');
  ok(`${label} says so in the note`, typeof view.note === 'string' && /unavailable/i.test(view.note), String(view.note));
}

{
  // A genuinely empty wallet is a real reading of zero and must be shown as
  // one — this is the case that makes "never show 0" too blunt a rule.
  const view = buildRiskHomeCard({ display: displayFixture({ walletValue: 0, walletStatus: 'OK', decision: 'INCOMPLETE' }), now: NOW });
  ok('a real, measured zero balance shows as $0', view.figures[0].value === '$0', view.figures[0].value);
  ok('an empty wallet is not presented as tradeable', view.decision !== 'TRADE', view.decision);
  ok('open risk against zero equity is a dash, not 0.00%', view.figures[1].value === '—', view.figures[1].value);
}

/*
 * The regression this section exists for.
 *
 * calculateOpenRisk returns 0 for every percentage when it has no equity to
 * divide by, and marks the result `valid: false`. Those zeroes are written to
 * the display cache like any other. Rendering them beside an unavailable
 * wallet produced the single most misleading state this card can reach:
 *
 *     Wallet  Unavailable    Open Risk  0.00%    Positions  3
 *
 * — three open positions and, apparently, nothing at risk.
 */
section('5b. A percentage whose denominator is missing is never rendered');

for (const [label, walletValue] of [
  ['an unavailable wallet', null],
  ['a NaN wallet', NaN],
  ['a zero wallet', 0]
]) {
  const view = buildRiskHomeCard({
    display: displayFixture({ walletValue, openRiskPct: 0, openPositions: 3, walletStatus: 'UNAVAILABLE' }),
    now: NOW
  });
  ok(`${label} does not report 0.00% open risk`, view.figures[1].value !== '0.00%', view.figures[1].value);
  ok(`${label} renders open risk as a dash`, view.figures[1].value === '—', view.figures[1].value);
  ok(`${label} still reports the real position count`, view.figures[2].value === '3', view.figures[2].value);
}

{
  // No wallet attached is not an outage. The Risk Manager works on local
  // records alone, and reporting "Unavailable" for an account that never had a
  // wallet sends the operator hunting for a failure that did not happen.
  const view = buildRiskHomeCard({
    display: displayFixture({ walletValue: null, walletStatus: 'IDLE', decision: 'INCOMPLETE', walletAt: null }),
    now: NOW
  });
  ok('no wallet attached reads "Not set", not "Unavailable"', view.figures[0].value === 'Not set', view.figures[0].value);
  ok('no wallet attached says no wallet is connected', view.note === 'No wallet connected', String(view.note));
  ok('no wallet attached is still INCOMPLETE', view.decision === 'INCOMPLETE', view.decision);
  ok('no wallet attached still shows the level earned from local records', view.levelLine === 'LEVEL 1 · 42% TO LEVEL 2', String(view.levelLine));

  // A failed READ must still say so — the two states must not collapse.
  const outage = buildRiskHomeCard({
    display: displayFixture({ walletValue: null, walletStatus: 'UNAVAILABLE' }),
    now: NOW
  });
  ok('a failed read still reads "Unavailable"', outage.figures[0].value === 'Unavailable', outage.figures[0].value);
  ok('a failed read is worded differently from no wallet', outage.note !== view.note, String(outage.note));
}

{
  // The engine's placeholder zero must not survive even when it looks plausible.
  const view = buildRiskHomeCard({
    display: displayFixture({ walletValue: null, openRiskPct: 4.2, openPositions: 3 }),
    now: NOW
  });
  ok(
    'a non-zero open risk is also suppressed when the equity it divides is gone',
    view.figures[1].value === '—',
    view.figures[1].value
  );
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ walletValue: 24800, openRiskPct: 0 }), now: NOW });
  ok('a measured zero open risk against a real balance still shows as 0.00%', view.figures[1].value === '0.00%', view.figures[1].value);
}

for (const [label, openRiskPct] of [
  ['null open risk', null],
  ['NaN open risk', NaN],
  ['undefined open risk', undefined]
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ openRiskPct }), now: NOW });
  ok(`${label} renders as a dash`, view.figures[1].value === '—', view.figures[1].value);
  ok(`${label} never renders as 0.00%`, view.figures[1].value !== '0.00%');
}

for (const [label, openPositions] of [
  ['a null position count', null],
  ['a NaN position count', NaN],
  ['an undefined position count', undefined]
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ openPositions }), now: NOW });
  ok(`${label} renders as a dash`, view.figures[2].value === '—', view.figures[2].value);
  ok(`${label} never renders as 0`, view.figures[2].value !== '0');
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ openPositions: 0 }), now: NOW });
  ok('a measured zero positions shows as 0', view.figures[2].value === '0', view.figures[2].value);
}

/* ======================================================================
 * 6. CORRUPT CACHE — localStorage is user-writable and survives deploys
 * =================================================================== */

section('6. Corrupt or partial cache records');

for (const [label, display] of [
  ['an unknown decision string', displayFixture({ decision: 'DEFINITELY_TRADE' })],
  ['a null decision', displayFixture({ decision: null })],
  ['a numeric decision', displayFixture({ decision: 7 })],
  ['a lowercase decision', displayFixture({ decision: 'trade' })]
]) {
  const view = buildRiskHomeCard({ display, now: NOW });
  ok(`${label} falls back to INCOMPLETE`, view.decision === 'INCOMPLETE', view.decision);
  ok(`${label} never becomes TRADE`, view.decision !== 'TRADE');
}

for (const [label, progressPct, expected] of [
  ['progress above 100', 140, 100],
  ['negative progress', -20, 0],
  ['NaN progress', NaN, null],
  ['null progress', null, null],
  ['a string progress', '42', null]
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ progressPct }), now: NOW });
  ok(`${label} clamps to ${expected}`, view.progressPct === expected, String(view.progressPct));
}

for (const [label, strategy] of [
  ['a null strategy', null],
  ['an empty strategy', ''],
  ['a numeric strategy', 3]
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ strategy }), now: NOW });
  ok(`${label} renders nothing rather than a wrong preset`, view.strategy === null, String(view.strategy));
}

for (const [label, levelLabel] of [
  ['a null level label', null],
  ['a numeric level label', 5],
  ['an empty level label', '']
]) {
  const view = buildRiskHomeCard({ display: displayFixture({ levelLabel }), now: NOW });
  ok(`${label} yields no level name`, view.levelName === null, String(view.levelName));
  ok(`${label} still shows the level line`, typeof view.levelLine === 'string');
}

{
  const view = buildRiskHomeCard({ display: displayFixture({ decision: 'NO_TRADE', primaryBlocker: 42 }), now: NOW });
  ok('a non-string blocker is not rendered', view.note === null, String(view.note));
}

/* ======================================================================
 * 7. NOTHING THE CARD RENDERS IS EVER NaN, undefined OR Infinity
 * =================================================================== */

section('7. No NaN, undefined or Infinity reaches the screen');

{
  const corruptions = [
    {},
    { levelLine: 'LEVEL 0 · BASELINE' },
    displayFixture({ walletValue: NaN, openRiskPct: NaN, openPositions: NaN, progressPct: NaN }),
    displayFixture({ walletValue: Infinity, openRiskPct: -Infinity, openPositions: Infinity }),
    displayFixture({ levelLabel: undefined, strategy: undefined, decision: undefined, primaryBlocker: undefined }),
    displayFixture({ walletAt: undefined, at: undefined }),
    null,
    undefined
  ];

  let clean = true;
  const offenders = [];
  for (const display of corruptions) {
    const view = buildRiskHomeCard({ display, now: NOW });
    for (const s of renderedStrings(view)) {
      if (/NaN|undefined|Infinity|\[object/.test(s)) {
        clean = false;
        offenders.push(s);
      }
    }
    // The DOM writer indexes figures[0..2] unconditionally.
    if (view.figures.length !== 3) {
      clean = false;
      offenders.push(`figures.length=${view.figures.length}`);
    }
  }
  ok(`${corruptions.length} corrupt caches produce no NaN/undefined/Infinity on screen`, clean, offenders.join(' | '));
}

/* ======================================================================
 * 8. THE CACHE CONTRACT — riskPage.js writes what riskHomeCard.js reads
 *
 * This is the assertion that actually protects the integration. The block
 * below is assembled with the SAME engine calls, in the SAME order, that
 * riskPage.js's evaluate() uses, and then fed to the card. If a field is
 * renamed on one side only, this fails.
 * =================================================================== */

section('8. The display cache riskPage.js writes is renderable');

{
  const DAY = 86400000;
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const at = (d) => new Date(T0 + d * DAY).toISOString();

  // Ten closed winners at 1% risk on a $25k wallet, with a snapshot after
  // each so the equity curve and the trade record agree.
  const wallet = 25000;
  const risk = wallet * 0.01;
  const snapshots = [{ at: at(0), walletValue: wallet }];
  const trades = [];
  let equity = wallet;
  for (let i = 0; i < 10; i++) {
    equity += risk;
    trades.push({
      id: `t${i}`,
      status: 'CLOSED',
      asset: 'BTC',
      direction: 'LONG',
      riskAmount: risk,
      realizedPnl: risk,
      openedAt: at(i),
      closedAt: at(i + 1)
    });
    snapshots.push({ at: at(i + 1), walletValue: equity });
  }

  const account = {
    walletValue: equity,
    walletAvailable: true,
    dataStale: false,
    snapshots,
    cashFlows: [],
    trades,
    openPositions: [],
    previousLevelState: null,
    now: Date.parse(at(11))
  };

  // ---- exactly the sequence in riskPage.js evaluate() ------------------
  const equityState = calculateAdjustedEquity({ walletValue: account.walletValue, cashFlows: account.cashFlows });
  const equityCurve = buildEquityCurve({ snapshots: account.snapshots, cashFlows: account.cashFlows });
  const drawdown = calculateDrawdown({ equityCurve });
  const recent = calculateRecentPerformance({ trades: account.trades, now: account.now });
  const levelState = calculateRiskLevel({
    adjustedEquity: equityState.adjustedEquity,
    equityCurve,
    trades: account.trades,
    openPositions: account.openPositions,
    previousLevelState: account.previousLevelState,
    now: account.now
  });
  const progress = calculateLevelProgress(levelState);
  const openRisk = calculateOpenRisk({ openPositions: account.openPositions, adjustedEquity: equityState.adjustedEquity });
  const concentration = calculateDirectionalConcentration({ openPositions: account.openPositions });
  const accountGate = evaluateNoTradeConstraints({
    envelope: calculateStrategyEnvelope({ level: levelState.level, strategy: 'STANDARD', recentPerformance: recent, drawdown }),
    openRiskState: openRisk,
    concentration,
    adjustedEquity: equityState.adjustedEquity,
    drawdown,
    level: levelState.level,
    direction: null
  });
  const accountDecision =
    account.walletAvailable === false || !(account.walletValue > 0)
      ? 'INCOMPLETE'
      : account.dataStale === true
        ? 'INCOMPLETE'
        : accountGate.allowed
          ? 'TRADE'
          : 'NO_TRADE';

  // ---- the display block, field for field as riskPage.js writes it -----
  const display = {
    level: levelState.level,
    peakLevel: levelState.peakLevel,
    progressPct: progress.progressPct,
    nextLevel: progress.nextLevel,
    atCap: progress.atCap === true,
    posture: getLevelDefinition(levelState.level)?.posture ?? null,
    currentDrawdownPct: drawdown.currentDrawdownPct,
    openRiskPct: openRisk.consumedRiskPct,
    openPositions: openRisk.count,
    walletValue: account.walletValue,
    totalClosedTrades: levelState.totalClosedTrades,
    levelLine: formatLevelLine(levelState, progress),
    levelLabel: getLevelDefinition(levelState.level)?.label ?? null,
    strategy: 'STANDARD',
    decision: accountDecision,
    blockerCount: accountGate.blockers.length,
    primaryBlocker: accountGate.blockers[0]?.label ?? null,
    walletStatus: 'OK',
    walletAt: new Date(account.now).toISOString(),
    at: new Date(account.now).toISOString()
  };

  const view = buildRiskHomeCard({ display, now: account.now });

  ok('a real engine evaluation renders as FRESH', view.state === HOME_CARD_STATE.FRESH, view.state);
  ok('the level line survives the round trip', view.levelLine === formatLevelLine(levelState, progress), String(view.levelLine));
  ok('the level line names a level', /^LEVEL -?\d/.test(view.levelLine), String(view.levelLine));
  ok('the level name is present', typeof view.levelName === 'string' && view.levelName.length > 0, String(view.levelName));
  ok('the wallet figure is not a dash', view.figures[0].value !== '—', view.figures[0].value);
  ok('the open-risk figure is not a dash', view.figures[1].value !== '—', view.figures[1].value);
  ok('the position count is not a dash', view.figures[2].value !== '—', view.figures[2].value);
  ok('a clean account with no open positions is tradeable', view.decision === 'TRADE', view.decision);
  ok('progress is a finite percentage', Number.isFinite(view.progressPct), String(view.progressPct));
  ok(
    'nothing in the rendered card is NaN/undefined/Infinity',
    renderedStrings(view).every((s) => !/NaN|undefined|Infinity|\[object/.test(s)),
    renderedStrings(view).join(' | ')
  );

  // The card must show the level the ENGINE produced, not a re-derivation.
  ok(
    'the card shows the engine level, not a recomputed one',
    view.levelLine.startsWith(`LEVEL ${levelState.level}`),
    `${view.levelLine} vs level ${levelState.level}`
  );

  // ---- the same account, but the wallet read failed --------------------
  const outage = buildRiskHomeCard({
    display: { ...display, walletValue: null, walletStatus: 'UNAVAILABLE', decision: 'INCOMPLETE' },
    now: account.now
  });
  ok('a wallet outage keeps the earned level visible', outage.levelLine === display.levelLine, String(outage.levelLine));
  ok('a wallet outage reports INCOMPLETE', outage.decision === 'INCOMPLETE', outage.decision);
  ok('a wallet outage shows Unavailable, not $0', outage.figures[0].value === 'Unavailable', outage.figures[0].value);
}

/* ======================================================================
 * 8b. THE TWO RULES THAT DECIDE WHAT GETS CACHED
 *
 * Both were defects found while validating this integration, both are on the
 * path between a live wallet read and the card, and both are pure.
 * =================================================================== */

section('8b. A wallet reading ages regardless of how it was obtained');

{
  const fresh = new Date(NOW - 2 * MINUTE).toISOString();
  const old = new Date(NOW - 40 * MINUTE).toISOString();

  // The regression: a LIVE read used to be exempt from ageing entirely, so a
  // tab left open kept sizing against the balance it loaded with.
  ok('a live read older than the horizon IS stale',
    isReadStale({ status: 'OK', value: 25000, at: old, now: NOW }) === true,
    'a live read must expire like any other');
  ok('a live read inside the horizon is not stale',
    isReadStale({ status: 'OK', value: 25000, at: fresh, now: NOW }) === false);
  ok('a cached read older than the horizon is stale',
    isReadStale({ status: 'CACHED', value: 25000, at: old, now: NOW }) === true);
  ok('a cached read inside the horizon is not stale',
    isReadStale({ status: 'CACHED', value: 25000, at: fresh, now: NOW }) === false);
  ok('a loading read still ages',
    isReadStale({ status: 'LOADING', value: 25000, at: old, now: NOW }) === true);

  ok('the horizon is exactly STALE_WALLET_MS',
    isReadStale({ status: 'OK', value: 1, at: new Date(NOW - STALE_WALLET_MS).toISOString(), now: NOW }) === false &&
    isReadStale({ status: 'OK', value: 1, at: new Date(NOW - STALE_WALLET_MS - 1).toISOString(), now: NOW }) === true);

  ok('nothing read is nothing to age (no wallet attached)',
    isReadStale({ status: 'IDLE', value: null, at: null, now: NOW }) === false);
  ok('an unavailable read with no value does not report as stale',
    isReadStale({ status: 'UNAVAILABLE', value: null, at: old, now: NOW }) === false,
    'the engine already refuses this via walletAvailable');
  ok('a reading that cannot say when it was taken is stale',
    isReadStale({ status: 'OK', value: 25000, at: null, now: NOW }) === true);
  ok('a reading with a corrupt timestamp is stale',
    isReadStale({ status: 'OK', value: 25000, at: 'not-a-date', now: NOW }) === true);
  ok('the simulation sandbox never goes stale',
    isReadStale({ status: 'OK', value: 25000, at: old, simulating: true, now: NOW }) === false);
}

section('8c. A read that did not see the whole account cannot be confident');

{
  const complete = {
    walletAvailable: true,
    walletValue: 25000,
    dataStale: false,
    walletComplete: true,
    historyComplete: true
  };

  ok('a complete account with an open gate is TRADE', resolveAccountDecision(complete, true) === 'TRADE');
  ok('a complete account with a closed gate is NO_TRADE', resolveAccountDecision(complete, false) === 'NO_TRADE');

  ok('an unavailable wallet is INCOMPLETE',
    resolveAccountDecision({ ...complete, walletAvailable: false }, true) === 'INCOMPLETE');
  ok('a null wallet value is INCOMPLETE',
    resolveAccountDecision({ ...complete, walletValue: null }, true) === 'INCOMPLETE');
  ok('a zero wallet value is INCOMPLETE',
    resolveAccountDecision({ ...complete, walletValue: 0 }, true) === 'INCOMPLETE');
  ok('a NaN wallet value is INCOMPLETE',
    resolveAccountDecision({ ...complete, walletValue: NaN }, true) === 'INCOMPLETE');
  ok('a stale balance is INCOMPLETE',
    resolveAccountDecision({ ...complete, dataStale: true }, true) === 'INCOMPLETE');

  // The two new rules.
  ok('a partially priced wallet is INCOMPLETE, not TRADE',
    resolveAccountDecision({ ...complete, walletComplete: false }, true) === 'INCOMPLETE',
    'equity is understated when a holding could not be priced');
  ok('a truncated transaction history is INCOMPLETE, not TRADE',
    resolveAccountDecision({ ...complete, historyComplete: false }, true) === 'INCOMPLETE',
    'a cut window omits real trades and invents unmatched-sell scratches');

  // Incompleteness must not soften a closed gate into anything permissive.
  ok('an incomplete read never upgrades a NO_TRADE to TRADE',
    resolveAccountDecision({ ...complete, historyComplete: false }, false) !== 'TRADE');

  // Precedence: availability outranks everything.
  ok('availability outranks the gate',
    resolveAccountDecision({ ...complete, walletAvailable: false }, false) === 'INCOMPLETE');

  ok('an empty account object is INCOMPLETE', resolveAccountDecision({}, true) === 'INCOMPLETE');
  ok('no argument at all is INCOMPLETE', resolveAccountDecision() === 'INCOMPLETE');

  // And the whole point: that decision is what the card renders.
  const view = buildRiskHomeCard({
    display: displayFixture({ decision: resolveAccountDecision({ ...complete, historyComplete: false }, true) }),
    now: NOW
  });
  ok('a truncated history reaches the card as INCOMPLETE', view.decision === 'INCOMPLETE', view.decision);
}

/* ======================================================================
 * 9. THE CARD CANNOT REACH THE NETWORK OR THE ENGINE
 *
 * riskHomeCard.js is asserted to have no imports at all. That is what makes
 * "the home page derives no risk numbers" a structural fact rather than a
 * convention someone has to remember.
 * =================================================================== */

section('9. The card module is structurally incapable of deriving risk');

{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const raw = readFileSync(fileURLToPath(new URL('../public/js/riskHomeCard.js', import.meta.url)), 'utf8');

  // Comments are checked out of, not into, these assertions: the file's header
  // discusses fetch, the DOM and Date.now() at length, and a prose mention is
  // not a capability.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  ok('has no static imports', !/^\s*import\s/m.test(source));
  ok('has no dynamic imports', !/\bimport\s*\(/.test(source));
  ok('has no require', !/\brequire\s*\(/.test(source));
  ok('never calls fetch', !/\bfetch\s*\(/.test(source));
  ok('never touches localStorage', !/localStorage/.test(source));
  ok('never touches the DOM', !/\bdocument\b/.test(source));

  // `now` must always arrive as an argument, so every assertion above is
  // deterministic and a test can place the clock wherever it likes. The only
  // permitted mention of the wall clock is the `now = Date.now()` parameter
  // default that makes the browser call site read naturally.
  const clockReads = source.match(/Date\.now\(\)/g) || [];
  const clockDefaults = source.match(/now = Date\.now\(\)/g) || [];
  ok(
    'reads the wall clock only as a parameter default',
    clockReads.length === clockDefaults.length,
    `${clockReads.length} Date.now() call(s), ${clockDefaults.length} of them parameter defaults`
  );
}

/* ==================================================================== */

console.log(`\n${'='.repeat(62)}`);
if (failures === 0) {
  console.log(`All ${assertions} assertions passed.`);
  console.log('NOTE: the card is provider-independent by construction, so this');
  console.log('harness proves nothing about live wallet data. See');
  console.log('scripts/probe-live-wallet.js for that.');
} else {
  console.log(`${failures} of ${assertions} assertions FAILED.`);
}
console.log('='.repeat(62));

process.exit(failures === 0 ? 0 : 1);
