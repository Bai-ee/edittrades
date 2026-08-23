#!/usr/bin/env node
/**
 * Live wallet pipeline probe — READ-ONLY OBSERVATION
 *
 *   node scripts/probe-live-wallet.js <public-solana-address>
 *   node scripts/probe-live-wallet.js <address> --base=https://<preview>.vercel.app
 *   node scripts/probe-live-wallet.js <address> --max=200 --json
 *
 * ==========================================================================
 * WHAT THIS IS FOR
 * ==========================================================================
 * Every other harness in scripts/ is fixture-driven and deliberately offline,
 * because a suite that needs a provider proves nothing when the provider is
 * down. That leaves one question none of them can answer: does the REAL
 * pipeline, against a REAL wallet, produce a coherent account state?
 *
 * This walks that pipeline end to end and prints the evidence:
 *
 *   public address
 *     -> GET /api/wallet/portfolio      equity snapshot
 *     -> GET /api/wallet/trades         reconstruction + cash-flow candidates
 *     -> adaptiveRisk.js                account state -> level -> recommendation
 *
 * It asserts the INVARIANTS that must hold regardless of what the wallet
 * contains, and reports everything else as an observation rather than a
 * verdict. A wallet with no history is not a failure; a wallet whose history
 * produces a confident recommendation from incomplete data is.
 *
 * ==========================================================================
 * WHAT THIS IS NOT
 * ==========================================================================
 *  - It takes a PUBLIC ADDRESS only. It has no use for a seed phrase or a
 *    private key, will not accept one, and signs nothing. If the argument
 *    looks like a mnemonic or a secret key, it refuses and exits.
 *  - It never places, modifies or closes a trade.
 *  - It writes nothing. No file, no localStorage, no remote state.
 *  - It prints a TRUNCATED address, so output can be pasted into a review
 *    without publishing which wallet was observed. `--full-address` opts out.
 *
 * Exit code 0 = every invariant held. Non-zero = an invariant was violated,
 * or the endpoints could not be reached (which proves nothing and says so).
 */

import {
  calculateAdjustedEquity,
  buildEquityCurve,
  calculateDrawdown,
  calculateRecentPerformance,
  calculateRiskLevel,
  calculateLevelProgress,
  calculateOpenRisk,
  recommendTrade
} from '../public/js/adaptiveRisk.js';

/* ======================================================================
 * ARGUMENTS
 * =================================================================== */

const argv = process.argv.slice(2);
const flags = new Map(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);
const positional = argv.filter((a) => !a.startsWith('--'));

const address = (positional[0] || process.env.WALLET_ADDRESS || '').trim();
const base = String(flags.get('base') || process.env.PROBE_BASE_URL || 'https://snapshottradingview.vercel.app').replace(/\/$/, '');
const maxTransactions = Number.parseInt(flags.get('max'), 10) || 200;
const asJson = flags.get('json') === true;
const showFullAddress = flags.get('full-address') === true;

/**
 * Refuse secret material outright rather than trying to handle it safely.
 * A base58 Solana address decodes to 32 bytes and is 32-44 characters; a
 * mnemonic has spaces; an exported keypair is a long digit array or an 87-88
 * character base58 string.
 */
function refuseSecrets(value) {
  if (/\s/.test(value)) {
    return 'That looks like a mnemonic phrase. This probe observes a PUBLIC address only — never give it a seed phrase.';
  }
  if (/^\[?\s*\d+\s*,/.test(value)) {
    return 'That looks like an exported secret key array. This probe observes a PUBLIC address only.';
  }
  if (value.length > 48) {
    return 'That is too long to be a public address and may be a secret key. Refusing to continue.';
  }
  return null;
}

function usage(message) {
  console.error(`\n${message}\n`);
  console.error('Usage: node scripts/probe-live-wallet.js <public-solana-address> [--base=URL] [--max=N] [--json]');
  console.error('       WALLET_ADDRESS=<address> node scripts/probe-live-wallet.js\n');
  process.exit(2);
}

if (!address) usage('No wallet address supplied.');
const refusal = refuseSecrets(address);
if (refusal) usage(refusal);
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
  usage('That is not a base58 Solana address (32-44 base58 characters).');
}

const shownAddress = showFullAddress ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;

/* ======================================================================
 * REPORTING
 * =================================================================== */

let failures = 0;
let checks = 0;
const observations = [];
const invariants = [];

function section(title) {
  if (asJson) return;
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

/**
 * An INVARIANT must hold whatever the wallet contains. A failure is a defect.
 * `detail` explains a FAILURE and is printed only when one occurs — a detail
 * string printed beside "ok" reads as a passing failure.
 */
function invariant(name, condition, detail = '') {
  checks++;
  const held = Boolean(condition);
  if (!held) failures++;
  invariants.push({ name, held, detail: held ? '' : detail });
  if (!asJson) console.log(`  ${held ? 'ok  ' : 'FAIL'}  ${name}${!held && detail ? '  — ' + detail : ''}`);
}

/** An OBSERVATION is a fact about this wallet. It is never a pass or a fail. */
function observe(label, value) {
  observations.push({ label, value });
  if (!asJson) console.log(`  ·     ${label.padEnd(34)} ${value}`);
}

/** Money for the observation column. Absent stays absent — never "$NaN", never "$0". */
function money(value, absent = 'n/a') {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : absent;
}

/**
 * Did we actually reach the application?
 *
 * The endpoints answer with a JSON body on every status they define. A reply
 * that carries none of their fields came from something in front of the app —
 * an egress proxy, a WAF, Vercel's deployment protection — and proves nothing
 * about the pipeline. Reporting that as a product defect would be worse than
 * reporting nothing, so it exits distinctly instead.
 */
const APP_STATUSES = new Set([200, 400, 405, 500, 503]);

function reachedTheApp(response) {
  if (response.status === 0) return false;
  if (!APP_STATUSES.has(response.status)) return false;
  const body = response.body;
  if (!body || typeof body !== 'object' || body.parseError) return false;
  return 'address' in body || 'error' in body || 'totalUsdValue' in body || 'trades' in body;
}

function unreachable(what, response) {
  // Two different failures, and conflating them sends the reader to the wrong
  // place: nothing answered at all, versus something that is not this
  // application answered on its behalf.
  const cause =
    response.status === 0
      ? `no response at all (${response.error || 'connection failed'}).\n\n` +
        'Nothing answered, so the host is unreachable from here — DNS, an egress\n' +
        'policy, or the wrong --base URL.'
      : `HTTP ${response.status}, which is not a response this endpoint defines.\n\n` +
        'Something in front of the deployment answered instead — an egress proxy, a\n' +
        'WAF, or Vercel deployment protection on a preview URL.';

  console.log(
    `\n${what} did not reach the application: ${cause}\n\n` +
    'This probe has therefore verified NOTHING about the live pipeline. Re-run it\n' +
    'from a network that can reach the deployment, against a URL that does not\n' +
    'require auth, before treating live wallet data as validated.\n'
  );
  process.exit(3);
}

async function timedFetch(url) {
  const started = Date.now();
  try {
    const response = await fetch(url);
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { parseError: text.slice(0, 400) };
    }
    return { ok: response.ok, status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error.message, ms: Date.now() - started };
  }
}

/* ======================================================================
 * RUN
 * =================================================================== */

if (!asJson) {
  console.log('='.repeat(70));
  console.log('LIVE WALLET PIPELINE PROBE — READ-ONLY');
  console.log('='.repeat(70));
  console.log(`  wallet    ${shownAddress}`);
  console.log(`  base      ${base}`);
  console.log(`  window    ${maxTransactions} transactions`);
  console.log(`  at        ${new Date().toISOString()}`);
}

/* ---- 1. Portfolio ---------------------------------------------------- */

section('1. GET /api/wallet/portfolio');

const portfolio = await timedFetch(`${base}/api/wallet/portfolio?address=${encodeURIComponent(address)}`);

observe('status', `${portfolio.status || 'NETWORK ERROR'}${portfolio.error ? ' — ' + portfolio.error : ''}`);
observe('latency', `${portfolio.ms} ms`);

if (!reachedTheApp(portfolio)) unreachable('GET /api/wallet/portfolio', portfolio);

const outage = portfolio.status === 503;

if (outage) {
  // The outage path is itself an invariant worth proving: it is what the UI
  // renders as WALLET DATA UNAVAILABLE, and it must not carry a zero.
  invariant('a 503 reports totalUsdValue as null, not 0', portfolio.body?.totalUsdValue === null, String(portfolio.body?.totalUsdValue));
  invariant('a 503 reports solBalance as null, not 0', portfolio.body?.solBalance === null, String(portfolio.body?.solBalance));
  invariant('a 503 is marked incomplete', portfolio.body?.complete === false);
  invariant('a 503 says why', Array.isArray(portfolio.body?.warnings) && portfolio.body.warnings.length > 0);
} else {
  invariant('portfolio responds 200', portfolio.status === 200, `status ${portfolio.status}`);
  invariant('totalUsdValue is a finite number or an explicit null',
    portfolio.body?.totalUsdValue === null || Number.isFinite(portfolio.body?.totalUsdValue),
    String(portfolio.body?.totalUsdValue));
  invariant('solBalance is a finite number or an explicit null',
    portfolio.body?.solBalance === null || Number.isFinite(portfolio.body?.solBalance),
    String(portfolio.body?.solBalance));
  invariant('no holding carries a NaN value',
    (portfolio.body?.tokens || []).every((t) => t.usdValue === null || Number.isFinite(t.usdValue)));

  observe('SOL balance', portfolio.body?.solBalance === null ? 'null (unread)' : String(portfolio.body?.solBalance));
  observe('token holdings', String((portfolio.body?.tokens || []).length));
  observe('total USD value', money(portfolio.body?.totalUsdValue, 'null (unpriced)'));
  observe('complete', String(portfolio.body?.complete));

  const unpriced = (portfolio.body?.tokens || []).filter((t) => t.usdValue === null || t.usdValue === undefined);
  observe('holdings with no USD price', String(unpriced.length));
  if (unpriced.length > 0) {
    observe('  unpriced mints', unpriced.map((t) => (t.symbol || t.mint || '?').slice(0, 12)).join(', ').slice(0, 200));
    // Partial pricing must be declared, not averaged away.
    invariant('partial pricing is declared as incomplete', portfolio.body?.complete === false,
      'some holdings are unpriced but `complete` is true');
  }

  for (const warning of portfolio.body?.warnings || []) observe('  warning', String(warning).slice(0, 160));
}

/* ---- 2. Trades / reconstruction -------------------------------------- */

section('2. GET /api/wallet/trades');

const history = await timedFetch(
  `${base}/api/wallet/trades?address=${encodeURIComponent(address)}&maxTransactions=${maxTransactions}`
);

observe('status', `${history.status || 'NETWORK ERROR'}${history.error ? ' — ' + history.error : ''}`);
observe('latency', `${history.ms} ms`);

if (!reachedTheApp(history)) unreachable('GET /api/wallet/trades', history);

const trades = history.body?.trades || [];
const positions = history.body?.positions || [];
const cashFlows = history.body?.cashFlows || [];
const stats = history.body?.stats || {};
const window = history.body?.window || {};

if (history.status === 503) {
  invariant('a 503 returns an empty trade array, not a fabricated one', Array.isArray(history.body?.trades) && history.body.trades.length === 0);
  invariant('a 503 is marked incomplete', history.body?.complete === false);
} else if (history.status === 200) {
  observe('transactions scanned', String(window.transactionsScanned));
  observe('signatures seen', String(window.signaturesSeen));
  observe('more history beyond window', String(window.hasMore));
  observe('trades reconstructed', String(trades.length));
  observe('  open / closed', `${stats.openCount ?? '?'} / ${stats.closedCount ?? '?'}`);
  observe('VERIFIED', String(stats.verifiedCount));
  observe('PARTIAL', String(stats.partialCount));
  observe('NEEDS REVIEW', String(stats.needsReviewCount));
  observe('  of which Jupiter PERP stubs', String(stats.perpCount));
  observe('realized P&L (excl. NEEDS REVIEW)', money(stats.realizedPnl, 'null (not derivable)'));
  observe('  trades contributing to it', String(stats.realizedPnlTradeCount));
  observe('cash-flow candidates', String(cashFlows.length));
  observe('open positions', String(positions.length));
  observe('complete', String(history.body?.complete));

  for (const warning of history.body?.warnings || []) observe('  warning', String(warning).slice(0, 160));

  /* -- reconstruction invariants -- */

  invariant('every trade declares a confidence tier',
    trades.every((t) => ['VERIFIED', 'PARTIAL', 'NEEDS_REVIEW'].includes(t.dataConfidence)),
    trades.filter((t) => !['VERIFIED', 'PARTIAL', 'NEEDS_REVIEW'].includes(t.dataConfidence)).map((t) => t.dataConfidence).join(','));

  invariant('the confidence tiers account for every trade',
    (stats.verifiedCount || 0) + (stats.partialCount || 0) + (stats.needsReviewCount || 0) === trades.length,
    `${stats.verifiedCount}+${stats.partialCount}+${stats.needsReviewCount} vs ${trades.length}`);

  invariant('no NEEDS_REVIEW trade contributes to realized P&L',
    (stats.realizedPnlTradeCount || 0) <= trades.filter((t) => t.dataConfidence !== 'NEEDS_REVIEW').length);

  const perps = trades.filter((t) => t.kind === 'PERP');
  invariant('every Jupiter perp record is NEEDS_REVIEW with null numbers',
    perps.every((t) => t.dataConfidence === 'NEEDS_REVIEW' && t.realizedPnl === null && (t.entry === null || t.entry === undefined)),
    `${perps.length} perp record(s)`);
  invariant('the response does not claim perps are supported',
    history.body?.methodology?.perpsSupported === false,
    String(history.body?.methodology?.perpsSupported));

  invariant('no reconstructed number is NaN or Infinity',
    trades.every((t) => ['entry', 'exit', 'quantity', 'realizedPnl', 'notional'].every((k) => {
      const v = t[k];
      return v === null || v === undefined || Number.isFinite(v);
    })),
    'a trade carries a non-finite number');

  const ids = trades.map((t) => t.id).filter(Boolean);
  invariant('no duplicate trade ids', new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} duplicate(s)`);

  const sigs = trades.flatMap((t) => t.signatures || []).filter(Boolean);
  observe('signatures referenced by trades', String(sigs.length));

  invariant('cash-flow candidates are unclassified until a human decides',
    cashFlows.every((f) => f.classified !== true),
    `${cashFlows.filter((f) => f.classified === true).length} pre-classified`);

  // A truncated window changes the computed level, so it has to be visible.
  invariant('a truncated history is reported rather than presented as complete',
    window.hasMore !== true || history.body?.complete === false || window.nextBefore,
    'hasMore is true but nothing marks the history as partial');
} else {
  invariant('trades endpoint responds 200 or 503', false, `status ${history.status}`);
}

/* ---- 3. Account state -> level -> recommendation ---------------------- */

section('3. Engine — account state, level, recommendation');

const walletValue = outage ? null : portfolio.body?.totalUsdValue ?? null;
const walletAvailable = !outage && walletValue !== null;
const now = Date.now();

// The account the Risk Manager would build from these two responses. Cash
// flows are UNCLASSIFIED here, exactly as they reach the page before a human
// confirms them — the engine must not treat them as performance.
const account = {
  walletValue,
  walletAvailable,
  dataStale: false,
  snapshots: walletValue === null ? [] : [{ at: new Date(now).toISOString(), walletValue }],
  cashFlows: [],
  trades,
  openPositions: positions,
  previousLevelState: null,
  now
};

const equityState = calculateAdjustedEquity({ walletValue: account.walletValue, cashFlows: account.cashFlows });
const equityCurve = buildEquityCurve({ snapshots: account.snapshots, cashFlows: account.cashFlows });
const drawdown = calculateDrawdown({ equityCurve });
const recent = calculateRecentPerformance({ trades: account.trades, now });
const levelState = calculateRiskLevel({
  adjustedEquity: equityState.adjustedEquity,
  equityCurve,
  trades: account.trades,
  openPositions: account.openPositions,
  previousLevelState: null,
  now
});
const progress = calculateLevelProgress(levelState);
const openRisk = calculateOpenRisk({ openPositions: account.openPositions, adjustedEquity: equityState.adjustedEquity });
const recommendation = recommendTrade({ account, request: { strategy: 'STANDARD', confidence: 50, now } });

// Reported as unavailable rather than as the engine's 0 when there was no
// balance to base it on: the engine gates on walletAvailable long before this
// number is used, and printing "$0.00" beside an unread wallet is the exact
// fake zero this whole probe exists to catch.
observe('adjusted equity', walletAvailable ? money(equityState.adjustedEquity) : 'n/a (wallet unavailable)');
observe('equity curve points', String(equityCurve.points?.length ?? equityCurve.length ?? 0));
observe('current drawdown', `${Number(drawdown.currentDrawdownPct).toFixed(2)}%`);
observe('closed trades seen by the engine', String(levelState.totalClosedTrades));
observe('level', String(levelState.level));
observe('progress to next level', Number.isFinite(progress.progressPct) ? `${progress.progressPct.toFixed(0)}%` : 'n/a');
observe('open risk', `${Number(openRisk.consumedRiskPct).toFixed(2)}%`);
observe('decision', String(recommendation.decision));
for (const b of recommendation.blockers || []) observe('  blocker', `${b.code}: ${b.label}`);

invariant('the engine returns one of TRADE / NO_TRADE / INCOMPLETE',
  ['TRADE', 'NO_TRADE', 'INCOMPLETE'].includes(recommendation.decision), String(recommendation.decision));

invariant('an unavailable wallet cannot produce a sized position',
  walletAvailable || (recommendation.decision === 'INCOMPLETE' && recommendation.position.notional === 0),
  `decision ${recommendation.decision}, notional ${recommendation.position.notional}`);

invariant('an incomplete portfolio read never yields a confident TRADE',
  portfolio.body?.complete !== false || recommendation.decision !== 'TRADE' || recommendation.warnings.length > 0,
  'complete:false but a clean TRADE with no warning');

invariant('the level is within the engine range', levelState.level >= -2 && levelState.level <= 5, String(levelState.level));

invariant('no engine output is NaN',
  [equityState.adjustedEquity, drawdown.currentDrawdownPct, openRisk.consumedRiskPct, recommendation.maxLoss.pct, recommendation.maxLoss.amount]
    .every((v) => v === null || Number.isFinite(v)));

// The wallet total and the engine's capital base must be the same number.
// adjustedEquity IS walletValue by design; a divergence means a deposit or a
// withdrawal has been folded into the capital base.
invariant('adjusted equity equals the wallet value (deposits are not performance)',
  walletValue === null || Math.abs(equityState.adjustedEquity - walletValue) < 0.01,
  `${equityState.adjustedEquity} vs ${walletValue}`);

// A wallet the reconstruction could not fully read must not buy a level.
invariant('an incomplete history does not silently earn a level',
  history.body?.complete !== false || levelState.level <= 0 || recommendation.warnings.length > 0,
  `complete:false at level ${levelState.level}`);

/* ---- 4. Stale-data behaviour ----------------------------------------- */

section('4. Stale-data behaviour (same account, dataStale: true)');

const stale = recommendTrade({ account: { ...account, dataStale: true }, request: { strategy: 'STANDARD', confidence: 50, now } });
observe('decision with a stale balance', String(stale.decision));
invariant('a stale balance forces INCOMPLETE', stale.decision === 'INCOMPLETE', stale.decision);
invariant('a stale balance raises STALE_WALLET_DATA',
  (stale.blockers || []).some((b) => b.code === 'STALE_WALLET_DATA'),
  (stale.blockers || []).map((b) => b.code).join(','));

/* ---- 5. Determinism --------------------------------------------------- */

section('5. Determinism');

const again = recommendTrade({ account, request: { strategy: 'STANDARD', confidence: 50, now } });
invariant('the same inputs produce the same decision', again.decision === recommendation.decision);
invariant('the same inputs produce the same inputs hash', again.inputsHash === recommendation.inputsHash);
invariant('the same inputs produce the same size', again.position.notional === recommendation.position.notional);

/* ======================================================================
 * VERDICT
 * =================================================================== */

const report = {
  at: new Date().toISOString(),
  wallet: shownAddress,
  base,
  maxTransactions,
  endpoints: {
    portfolio: { status: portfolio.status, ms: portfolio.ms },
    trades: { status: history.status, ms: history.ms }
  },
  reconstruction: {
    transactionsScanned: window.transactionsScanned ?? null,
    hasMore: window.hasMore ?? null,
    tradeCount: trades.length,
    verified: stats.verifiedCount ?? null,
    partial: stats.partialCount ?? null,
    needsReview: stats.needsReviewCount ?? null,
    perpStubs: stats.perpCount ?? null,
    cashFlowCandidates: cashFlows.length
  },
  engine: {
    adjustedEquity: equityState.adjustedEquity,
    level: levelState.level,
    progressPct: progress.progressPct,
    openRiskPct: openRisk.consumedRiskPct,
    decision: recommendation.decision,
    blockers: (recommendation.blockers || []).map((b) => b.code)
  },
  invariants,
  observations,
  failures
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${'='.repeat(70)}`);
  if (failures === 0) {
    console.log(`All ${checks} live invariants held.`);
  } else {
    console.log(`${failures} of ${checks} live invariants FAILED.`);
  }
  console.log(
    'Observations above describe THIS wallet at THIS moment. They are evidence,\n' +
    'not coverage: a wallet with no Jupiter history exercises no reconstruction,\n' +
    'and Jupiter Perpetuals are not reconstructed at all by design.'
  );
  console.log('='.repeat(70));
}

process.exit(failures === 0 ? 0 : 1);
