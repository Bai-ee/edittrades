/**
 * Risk Manager — page controller
 * ------------------------------
 * Drives /risk.html.
 *
 * ==========================================================================
 * THE ONE RULE THIS FILE EXISTS TO OBEY
 * ==========================================================================
 * THIS FILE COMPUTES NO RISK NUMBERS.
 *
 * Position size, leverage, max loss, risk level, level progress, open risk,
 * drawdown, concentration, envelopes and every threshold come from
 * `./adaptiveRisk.js`. What happens here is: gather inputs, hand them to the
 * engine, and format what comes back. Where a displayed figure is a DIFFERENCE
 * between two engine outputs (the recovery line), both operands are shown
 * beside it and the derivation is called out in a comment — nothing derived
 * here is ever fed back into the engine.
 *
 * No AI call produces a number. The only AI in this page is the existing
 * screenshot parser, whose output is stored as a CLAIM about a trade and is
 * always outranked by on-chain data.
 *
 * ==========================================================================
 * LOADING IN LAYERS
 * ==========================================================================
 *   1. cached  — localStorage only. Paints immediately, labelled CACHED.
 *   2. wallet  — GET /api/wallet/portfolio. Live value or WALLET DATA UNAVAILABLE.
 *   3. level   — the engine re-runs against the fresh value; level state persists.
 *   4. history — GET /api/wallet/trades. Reconstruction, merged with local edits.
 *
 * Nothing blocks on anything later than it. A failure at any layer degrades
 * that layer only and says so; no layer invents a balance.
 *
 * ==========================================================================
 * SIMULATION
 * ==========================================================================
 * `state.simulation.active` swaps in a CLONED account and routes every write
 * through `persist()`, which refuses to run while simulating. Real history,
 * level state and recommendations cannot be touched from inside the sandbox.
 */

import {
  STRATEGY_PRESETS,
  LEVELS,
  STRATEGY_VERSION,
  recommendTrade,
  evaluatePosition,
  analyzeStrategyPerformance,
  calculateRiskLevel,
  calculateLevelProgress,
  calculateOpenRisk,
  calculateDirectionalConcentration,
  buildEquityCurve,
  calculateDrawdown,
  calculateRecentPerformance,
  calculateAdjustedEquity,
  getLevelDefinition
} from './adaptiveRisk.js';

import {
  loadWalletAddress,
  saveWalletAddress,
  clearWalletAddress,
  loadEquitySnapshots,
  appendEquitySnapshot,
  latestEquitySnapshot,
  classifiedCashFlows,
  pendingCashFlows,
  ingestCashFlowCandidates,
  classifyCashFlow,
  addManualCashFlow,
  loadLevelState,
  saveLevelState,
  loadLevelDisplay,
  loadLevelHistory,
  appendLevelTransition,
  loadStrategyVersions,
  currentStrategyVersion,
  decidedProposalIds,
  recordStrategyDecision,
  loadRecommendations,
  saveRecommendation,
  watchingRecommendations,
  linkRecommendationToTrade,
  upsertTradeRecord,
  mergeTradeRecords,
  saveScreenshotMeta,
  loadUiPrefs,
  saveUiPrefs
} from './riskStore.js';

/* ========================================================================
 * CONSTANTS
 * ===================================================================== */

/**
 * A wallet read older than this is STALE. The engine turns a stale read into
 * an INCOMPLETE decision with a STALE_WALLET_DATA blocker, so the
 * recommendation stops presenting itself as confident on its own.
 */
export const STALE_WALLET_MS = 10 * 60 * 1000;

/** Screenshot upload ceiling, before base64 expansion. */
const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;

const CONFIDENCE_DEFAULT = 50;

/**
 * Tickers this page can turn into a mint address WITHOUT guessing.
 *
 * A recommendation stores whatever ticker the user typed ("SOL"); the
 * reconstruction reports a base58 mint. Matching one to the other needs a
 * mapping, and the only mapping that can be trusted is one already relied on
 * elsewhere in this repo: these four are the constants the reconstruction
 * itself keys off (SOL_MINT and STABLE_MINTS in services/jupiterReconstruction.js).
 *
 * BTC and ETH are deliberately ABSENT. The only Solana addresses for them in
 * this repo (services/tokenMapping.js) are commented "placeholder — verify
 * address", and linking a recommendation to somebody else's trade is worse
 * than leaving it unmatched. An unlisted ticker simply never matches, which is
 * the behaviour this page already had.
 */
const KNOWN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
};

/* ========================================================================
 * PURE FORMATTERS
 *
 * Exported so they can be exercised under node with no DOM. Every one of
 * them takes engine output and returns a string; none of them decides
 * anything.
 * ===================================================================== */

/** HTML-escape. Everything interpolated into markup goes through this. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatUsd(value, { compact = false, dash = '—' } = {}) {
  if (!Number.isFinite(value)) return dash;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (compact && abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(2)}M`;
  if (compact && abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  const decimals = abs < 100 && abs % 1 !== 0 ? 2 : 0;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatSignedUsd(value, options = {}) {
  if (!Number.isFinite(value)) return options.dash ?? '—';
  const body = formatUsd(Math.abs(value), options);
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

export function formatPct(value, decimals = 2, dash = '—') {
  if (!Number.isFinite(value)) return dash;
  return `${value.toFixed(decimals)}%`;
}

export function formatSignedPct(value, decimals = 1, dash = '—') {
  if (!Number.isFinite(value)) return dash;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatLeverage(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2)}×`;
}

/**
 * A wallet address is 32-44 base58 characters and will overflow any phone
 * layout given the chance. Head and tail keep it identifiable.
 */
export function truncateAddress(address, head = 4, tail = 4) {
  if (typeof address !== 'string' || address.length === 0) return '—';
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!Number.isFinite(at)) return 'never';
  const delta = now - at;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDate(timestamp) {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!Number.isFinite(at)) return '—';
  const date = new Date(at);
  return `${String(date.getDate()).padStart(2, '0')} ${date.toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${String(date.getFullYear()).slice(-2)}`;
}

/**
 * The level rail: -2 -1 0 1 2 [3] 4 5.
 *
 * @param {number} currentLevel  levelState.level from calculateRiskLevel
 * @param {number|null} peakLevel  levelState.peakLevel
 * @returns {Array<{level:number, label:string, state:string, key:string}>}
 */
export function buildLevelRail(currentLevel, peakLevel = null) {
  return LEVELS.map((definition) => {
    const level = definition.level;
    let state;
    if (level === currentLevel) state = 'CURRENT';
    else if (level < 0) state = 'DEFENSIVE';
    else if (level < currentLevel) state = 'PASSED';
    else if (Number.isFinite(peakLevel) && level <= peakLevel) state = 'REACHED';
    else state = 'LOCKED';
    return {
      level,
      label: level > 0 ? `${level}` : `${level}`,
      key: definition.key,
      name: definition.label,
      state
    };
  });
}

/**
 * `LEVEL 3 · 68% TO LEVEL 4`, or `LEVEL -1 · RISK REDUCED` in a defensive
 * state, or `LEVEL 5 · MAXIMUM` at the cap.
 */
export function formatLevelLine(levelState, progress) {
  const level = levelState?.level ?? 0;
  const definition = getLevelDefinition(level);
  const head = `LEVEL ${level}`;

  if (definition && definition.posture === 'DEFENSIVE') {
    return `${head} · RISK REDUCED`;
  }
  if (progress?.atCap || level >= 5) {
    return `${head} · MAXIMUM`;
  }
  const pctValue = Number.isFinite(progress?.progressPct) ? Math.round(progress.progressPct) : 0;
  const next = progress?.nextLevel ?? level + 1;
  return `${head} · ${pctValue}% TO LEVEL ${next}`;
}

/**
 * `RECOVERY NEEDED: +3.8%`.
 *
 * DERIVED FOR DISPLAY ONLY. Both operands are engine output: `current` is the
 * drawdown calculateDrawdown() measured, `required` is the ceiling
 * calculateRiskLevel() applied to the next level. The gap between them is the
 * one arithmetic this file does, it is shown alongside both figures it came
 * from, and it is never handed back to the engine.
 *
 * @param {object} drawdownCheck the DRAWDOWN_CEILING entry of levelState.gates.checks
 */
export function formatRecoveryLine(drawdownCheck) {
  if (!drawdownCheck || drawdownCheck.passed) return null;
  const current = Number(drawdownCheck.current);
  const required = Number(drawdownCheck.required);
  if (!Number.isFinite(current) || !Number.isFinite(required)) return null;
  const gap = current - required;
  if (gap <= 0) return null;
  return {
    line: `RECOVERY NEEDED: +${gap.toFixed(1)}%`,
    detail: `DRAWDOWN ${current.toFixed(1)}% · CEILING FOR NEXT LEVEL ${required.toFixed(1)}%`
  };
}

/** ↑ / ↓ / · for an engine factor direction. */
export function directionGlyph(direction) {
  if (direction === 'UP') return '↑';
  if (direction === 'DOWN') return '↓';
  return '·';
}

/**
 * The pills under the rail. ONLY factors the engine reported as materially
 * influencing progression, plus the ONE gate that is currently binding.
 *
 * Capped deliberately. `gates.checks` can fail eight ways at once in a bad
 * drawdown, and a rail of nine red pills communicates less than three: the
 * full gate list belongs in the transition detail, not the headline visual.
 *
 * @returns {Array<{label:string, direction:string, detail:string}>}
 */
export const MAX_PROGRESSION_PILLS = 6;

export function buildProgressionFactors({ levelState, progress, equityCurve }) {
  const pills = [];
  const seen = new Set();

  const push = (code, label, direction, detail) => {
    if (seen.has(code)) return;
    seen.add(code);
    pills.push({ code, label, direction, detail });
  };

  // Trades-since-level-change: the heaviest component of the progress bar
  // (50%), so it is always material.
  const tradesCheck = (levelState?.gates?.checks || []).find((c) => c.code === 'TRADES_SINCE_LEVEL');
  if (tradesCheck) {
    // Keyed by the gate's own code so the blocked-gate pass below cannot emit
    // the same fact a second time under a different name.
    push(
      'TRADES_SINCE_LEVEL',
      `RECENT TRADES ${tradesCheck.current}/${tradesCheck.required}`,
      tradesCheck.passed ? 'UP' : 'NEUTRAL',
      `${tradesCheck.label}: ${tradesCheck.current} of ${tradesCheck.required}.`
    );
  }

  // Adjusted-equity growth, cash flows removed, straight from buildEquityCurve.
  if (equityCurve?.valid && Number.isFinite(equityCurve.totalGrowthPct) && Math.abs(equityCurve.totalGrowthPct) >= 0.1) {
    push(
      'WALLET_GROWTH',
      `WALLET ${formatSignedPct(equityCurve.totalGrowthPct)}`,
      equityCurve.totalGrowthPct > 0 ? 'UP' : 'DOWN',
      'Adjusted trading equity since the first snapshot, with classified deposits and withdrawals removed.'
    );
  }

  // Everything calculateRiskLevel decided was worth reporting.
  for (const factor of levelState?.factors || []) {
    push(factor.code, factorPillLabel(factor), factor.direction, factor.detail);
  }

  // Drawdown when it is low enough not to have raised a factor at all — the
  // absence of a drawdown factor is itself information the rail should show.
  if (!seen.has('DRAWDOWN') && Number.isFinite(levelState?.currentDrawdownPct)) {
    push(
      'DRAWDOWN',
      `DRAWDOWN LOW ${formatPct(levelState.currentDrawdownPct, 1)}`,
      'UP',
      'Current drawdown is below the level where the engine reports it as a factor.'
    );
  }

  // The binding gate — ONE, the first not already represented above.
  for (const code of progress?.blockedBy || []) {
    if (seen.has(code)) continue;
    const check = (levelState?.gates?.checks || []).find((c) => c.code === code);
    if (!check) continue;
    push(code, `BLOCKED: ${humanCode(code)}`, 'DOWN', `${check.label}: ${check.current} against a requirement of ${check.required}.`);
    break;
  }

  return pills.slice(0, MAX_PROGRESSION_PILLS);
}

/** Turns an engine factor into a short rail label. */
function factorPillLabel(factor) {
  switch (factor.code) {
    case 'DRAWDOWN':
      return 'DRAWDOWN HIGH';
    case 'OPEN_RISK':
      return factor.direction === 'DOWN' ? 'OPEN RISK HIGH' : 'OPEN RISK NEUTRAL';
    case 'LOSING_STREAK':
      return 'LOSING RUN';
    case 'WINNING_STREAK':
      return 'WINNING RUN';
    case 'INSUFFICIENT_SAMPLE':
      return 'SAMPLE TOO SMALL';
    case 'STALE_RECENT_DATA':
      return 'INACTIVE';
    default:
      return humanCode(factor.code);
  }
}

export function humanCode(code) {
  return String(code || '').replace(/_/g, ' ');
}

/**
 * The dominant line of the page.
 * TRADE  -> `TRADE $1,850 @ 2×`
 * others -> `NO TRADE` / `INCOMPLETE`
 */
export function formatHeadline(recommendation) {
  if (!recommendation) return { headline: 'NO RECOMMENDATION', tone: 'NEUTRAL' };

  if (recommendation.decision === 'TRADE') {
    const notional = formatUsd(recommendation.position?.notional);
    const lev = formatLeverage(recommendation.position?.leverage);
    return {
      headline: lev ? `TRADE ${notional} @ ${lev}` : `TRADE ${notional}`,
      tone: 'LONG'
    };
  }
  if (recommendation.decision === 'NO_TRADE') {
    return { headline: 'NO TRADE', tone: 'SHORT' };
  }
  return { headline: 'CANNOT SIZE', tone: 'NEUTRAL' };
}

/**
 * `MAX LOSS 1.20% · $111` — both figures straight off recommendation.maxLoss.
 *
 * Returns null unless the decision is actually TRADE. The engine still fills
 * in maxLoss on a blocked recommendation (it is the size that WOULD have been
 * permitted), and printing a dollar figure beside NO TRADE reads as a
 * permission slip. A blocked recommendation gets a blocker, not a number.
 */
export function formatMaxLossLine(recommendation) {
  if (!recommendation || recommendation.decision !== 'TRADE') return null;
  const maxLoss = recommendation.maxLoss;
  if (!maxLoss || !Number.isFinite(maxLoss.amount) || maxLoss.amount <= 0) return null;
  return `MAX LOSS ${formatPct(maxLoss.pct)} · ${formatUsd(maxLoss.amount)}`;
}

/** The one blocker the user should act on first. */
export function primaryBlocker(recommendation) {
  const blockers = recommendation?.blockers || [];
  if (blockers.length === 0) return null;
  // STALE_WALLET_DATA outranks everything: nothing below it can be trusted.
  return blockers.find((b) => b.code === 'STALE_WALLET_DATA') || blockers[0];
}

export function formatDataConfidence(value) {
  if (value === 'VERIFIED') return { label: 'VERIFIED', tone: 'LONG' };
  if (value === 'PARTIAL') return { label: 'PARTIAL', tone: 'NEUTRAL' };
  if (value === 'NEEDS_REVIEW') return { label: 'NEEDS REVIEW', tone: 'SHORT' };
  if (value === 'MANUAL') return { label: 'MANUAL', tone: 'NEUTRAL' };
  return { label: 'UNKNOWN', tone: 'NEUTRAL' };
}

export function toneClass(tone) {
  if (tone === 'LONG' || tone === 'UP') return 'eco-tone-long';
  if (tone === 'SHORT' || tone === 'DOWN') return 'eco-tone-short';
  return 'eco-tone-neutral';
}

/** Short asset label. Mints are 32-44 chars and must never set a column width. */
export function formatAsset(asset) {
  if (typeof asset !== 'string' || !asset) return '—';
  if (asset.length > 12) return truncateAddress(asset, 4, 4);
  return asset.toUpperCase();
}

/* ========================================================================
 * STATE
 * ===================================================================== */

const state = {
  address: null,

  wallet: {
    status: 'IDLE', // IDLE | LOADING | OK | UNAVAILABLE | CACHED
    value: null,
    complete: true,
    at: null,
    warnings: [],
    error: null
  },

  history: {
    status: 'IDLE',
    /**
     * The reconstruction EXACTLY as the endpoint returned it, kept separate
     * from `trades`. Re-merging an already-merged record would compare a local
     * override against itself and quietly report agreement where there is a
     * real conflict, so every merge starts from this untouched copy.
     */
    onchain: [],
    trades: [],
    positions: [],
    cashFlowCandidates: [],
    warnings: [],
    methodology: null
  },

  request: {
    asset: '',
    strategy: 'STANDARD',
    confidence: CONFIDENCE_DEFAULT,
    entry: null,
    stop: null,
    direction: null
  },

  simulation: {
    active: false,
    walletValue: null,
    hypotheticalTrades: [] // clones only; never persisted
  },

  evaluation: null,
  selectedPositionId: null,
  positionEvaluation: null,
  selectedTransitionId: null,
  openTradeId: null,
  proposals: []
};

/** Every write goes through here. Simulation is sandboxed by refusing them. */
function persist(action) {
  if (state.simulation.active) return null;
  try {
    return action();
  } catch (error) {
    console.warn('[RiskPage] Persist failed:', error.message);
    return null;
  }
}

/* ========================================================================
 * ACCOUNT ASSEMBLY
 *
 * The single place the engine's `account` argument is built. Everything the
 * engine sees passes through here, which is what makes the simulation sandbox
 * a one-line switch rather than a set of scattered conditionals.
 * ===================================================================== */

/** Trade records in the shape adaptiveRisk reads. */
function tradesForEngine() {
  const merged = state.history.trades;
  const base = merged.map((trade) => ({
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    status: trade.status,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    realizedPnl: trade.realizedPnl,
    // riskAmount is user-supplied: the chain does not record what a trader
    // intended to risk. Without it the engine reads the trade as 0R and says
    // so, rather than inferring a risk figure from the outcome.
    riskAmount: trade.riskAmount ?? trade.plannedRisk ?? null,
    rMultiple: trade.rMultiple ?? null,
    strategy: trade.strategy ?? null,
    confidence: trade.confidence ?? null,
    level: trade.level ?? null,
    leverage: trade.leverage ?? null,
    drawdownStateAtEntry: trade.drawdownStateAtEntry ?? null
  }));

  if (state.simulation.active && state.simulation.hypotheticalTrades.length) {
    return [...base, ...state.simulation.hypotheticalTrades];
  }
  return base;
}

function openPositionsForEngine() {
  return state.history.trades
    .filter((trade) => trade.status === 'OPEN')
    .map((trade) => ({
      id: trade.id,
      asset: trade.asset,
      direction: trade.direction || 'LONG',
      notional: trade.notional,
      entry: trade.entry,
      stop: trade.stop ?? null,
      leverage: trade.leverage ?? null,
      margin: trade.margin ?? null,
      riskAmount: trade.riskAmount ?? null,
      // The reconstruction never estimates unrealised P&L, so this stays null
      // unless a human has entered a mark.
      unrealizedPnl: Number.isFinite(trade.unrealizedPnl) ? trade.unrealizedPnl : 0,
      markPrice: trade.markPrice ?? null
    }));
}

function walletValueForEngine() {
  if (state.simulation.active && Number.isFinite(state.simulation.walletValue)) {
    return state.simulation.walletValue;
  }
  return state.wallet.value;
}

function isWalletStale() {
  if (state.simulation.active) return false;
  if (state.wallet.status !== 'CACHED') return false;
  const at = state.wallet.at ? Date.parse(state.wallet.at) : null;
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > STALE_WALLET_MS;
}

function buildAccount() {
  const snapshots = loadEquitySnapshots().map((s) => ({ at: s.at, walletValue: s.walletValue }));

  // A live read that has not been written to the store yet (simulation, or the
  // instant before persistence) still belongs on the curve's tail.
  const walletValue = walletValueForEngine();
  const last = snapshots[snapshots.length - 1];
  if (Number.isFinite(walletValue) && (!last || last.walletValue !== walletValue)) {
    snapshots.push({ at: state.wallet.at || new Date().toISOString(), walletValue });
  }

  return {
    walletValue: Number.isFinite(walletValue) ? walletValue : null,
    walletAvailable: state.wallet.status !== 'UNAVAILABLE',
    dataStale: isWalletStale(),
    snapshots,
    cashFlows: classifiedCashFlows(),
    trades: tradesForEngine(),
    openPositions: openPositionsForEngine(),
    previousLevelState: loadLevelState(),
    now: Date.now()
  };
}

/* ========================================================================
 * ENGINE EVALUATION
 *
 * One call site. Everything rendered afterwards reads from `state.evaluation`.
 * ===================================================================== */

function evaluate() {
  const account = buildAccount();

  const equityState = calculateAdjustedEquity({
    walletValue: account.walletValue,
    cashFlows: account.cashFlows
  });

  const equityCurve = buildEquityCurve({
    snapshots: account.snapshots,
    cashFlows: account.cashFlows
  });

  const drawdown = calculateDrawdown({ equityCurve });

  const recent = calculateRecentPerformance({
    trades: account.trades,
    now: account.now
  });

  const levelState = calculateRiskLevel({
    adjustedEquity: equityState.adjustedEquity,
    equityCurve,
    trades: account.trades,
    openPositions: account.openPositions,
    previousLevelState: account.previousLevelState,
    now: account.now
  });

  const progress = calculateLevelProgress(levelState);

  const openRisk = calculateOpenRisk({
    openPositions: account.openPositions,
    adjustedEquity: equityState.adjustedEquity
  });

  const concentration = calculateDirectionalConcentration({ openPositions: account.openPositions });

  const recommendation = recommendTrade({
    account,
    request: {
      asset: state.request.asset || null,
      strategy: state.request.strategy,
      confidence: state.request.confidence,
      entry: state.request.entry,
      stop: state.request.stop,
      direction: state.request.direction,
      now: account.now
    }
  });

  state.evaluation = {
    account,
    equityState,
    equityCurve,
    drawdown,
    recent,
    levelState,
    progress,
    openRisk,
    concentration,
    recommendation
  };

  /**
   * Carry the level forward, and record any transition with the evidence that
   * caused it frozen alongside.
   *
   * ONLY when the trade history has actually loaded. A level computed before
   * the reconstruction lands is computed from an account with no trades in it,
   * which the engine correctly caps at 0 — persisting that would overwrite a
   * genuinely earned level with an artefact of load order. With no wallet
   * attached there is no history to wait for, so local records are the whole
   * truth and the write is safe.
   */
  state.proposals = analyzeStrategyPerformance({ trades: account.trades });

  const historyIsAuthoritative = state.history.status === 'OK' || !state.address;
  if (!historyIsAuthoritative) return state.evaluation;

  // Blocked while simulating.
  persist(() => {
    // The display block is what the home-page widget reads. It is a cache of
    // this evaluation's engine output, never an input to another one.
    saveLevelState(levelState, {
      progressPct: progress.progressPct,
      nextLevel: progress.nextLevel,
      atCap: progress.atCap === true,
      posture: getLevelDefinition(levelState.level)?.posture ?? null,
      currentDrawdownPct: drawdown.currentDrawdownPct,
      openRiskPct: openRisk.consumedRiskPct,
      openPositions: openRisk.count,
      walletValue: state.wallet.value,
      totalClosedTrades: levelState.totalClosedTrades
    });
    for (const transition of levelState.transitions) {
      appendLevelTransition(transition, {
        at: new Date().toISOString(),
        totalClosedTrades: levelState.totalClosedTrades,
        tradesSinceLevelChange: levelState.tradesSinceLevelChange,
        drawdownPct: drawdown.currentDrawdownPct,
        maxDrawdownPct: drawdown.maxDrawdownPct,
        winRate: recent.winRate,
        avgR: recent.winsorisedAvgR,
        consistency: recent.consistency,
        streak: recent.streak,
        equityIndex: drawdown.currentIndex,
        thresholds: (levelState.gates?.checks || []).map((c) => ({
          code: c.code,
          current: c.current,
          required: c.required,
          passed: c.passed
        })),
        tradeIds: account.trades.filter((t) => t.status === 'CLOSED').slice(-10).map((t) => t.id)
      });
    }
    return true;
  });

  return state.evaluation;
}

/* ========================================================================
 * DOM PLUMBING
 * ===================================================================== */

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function setHTML(id, html) {
  const node = $(id);
  if (node) node.innerHTML = html;
}

function show(id, visible) {
  const node = $(id);
  if (node) node.hidden = !visible;
}

/* ========================================================================
 * RENDER — 1. LEVEL AND PROGRESS  (the major visual)
 * ===================================================================== */

/**
 * Which level the card should show.
 *
 * While a wallet is attached but its history has not loaded, the live
 * evaluation is running against an account with no trades in it — the engine
 * correctly caps that at level 0, which is not this account's level. So the
 * card shows the LAST COMPLETE evaluation instead, says so, and switches to
 * live the moment the reconstruction lands.
 */
function levelView() {
  const { levelState, progress, equityCurve } = state.evaluation;
  const historyPending = Boolean(state.address) && state.history.status !== 'OK';
  const cached = historyPending && !state.simulation.active ? loadLevelDisplay() : null;

  if (cached && Number.isFinite(cached.progressPct)) {
    return {
      awaitingHistory: true,
      levelState: { level: cached.level, peakLevel: cached.peakLevel, gates: { checks: [] }, factors: [], currentDrawdownPct: cached.currentDrawdownPct },
      progress: {
        progressPct: cached.progressPct,
        nextLevel: cached.nextLevel,
        atCap: cached.atCap === true,
        tradesToNext: null,
        blockedBy: []
      },
      equityCurve
    };
  }

  return { awaitingHistory: false, levelState, progress, equityCurve };
}

function renderLevel() {
  const view = levelView();
  const { levelState, progress, equityCurve } = view;
  const definition = getLevelDefinition(levelState.level);

  // Rail
  const rail = buildLevelRail(levelState.level, levelState.peakLevel);
  setHTML(
    'levelRail',
    rail
      .map(
        (node) => `
        <div class="rm-rail-node is-${node.state.toLowerCase()}" data-level="${node.level}"
             title="Level ${node.level} — ${esc(node.name)}">
          <span class="rm-rail-num">${node.level}</span>
        </div>`
      )
      .join('')
  );

  setText('levelLine', formatLevelLine(levelState, progress));
  setText(
    'levelName',
    [
      definition ? `${definition.label.toUpperCase()} · ${definition.posture}` : '',
      view.awaitingHistory ? 'AS OF LAST CHECK — AWAITING TRADE HISTORY' : ''
    ]
      .filter(Boolean)
      .join('  ·  ')
  );

  // Defensive framing follows the posture, so a demotion is legible at a glance.
  $('levelCard')?.classList.toggle('is-defensive', definition?.posture === 'DEFENSIVE');

  // Progress bar
  const bar = $('levelBar');
  if (bar) {
    const value = Number.isFinite(progress.progressPct) ? Math.max(0, Math.min(100, progress.progressPct)) : 0;
    bar.style.width = `${value}%`;
    bar.parentElement?.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  // Defensive state gets the recovery line instead of a "next level" promise.
  const drawdownCheck = (levelState.gates?.checks || []).find((c) => c.code === 'DRAWDOWN_CEILING');
  const recovery = formatRecoveryLine(drawdownCheck);
  if (recovery && definition && definition.posture === 'DEFENSIVE') {
    setText('levelRecovery', recovery.line);
    setText('levelRecoveryDetail', recovery.detail);
    show('levelRecoveryWrap', true);
  } else {
    show('levelRecoveryWrap', false);
  }

  // Trades to next, when there is a next.
  if (view.awaitingHistory) {
    setText('levelTradesToNext', 'READING TRADE HISTORY…');
  } else if (progress.atCap) {
    setText('levelTradesToNext', 'RISK PERCENTAGE STOPS EXPANDING AT LEVEL 5');
  } else if (Number.isFinite(progress.tradesToNext) && progress.tradesToNext > 0) {
    setText('levelTradesToNext', `${progress.tradesToNext} MORE CLOSED TRADE${progress.tradesToNext === 1 ? '' : 'S'} REQUIRED`);
  } else {
    setText('levelTradesToNext', progress.blockedBy.length ? 'TRADE COUNT MET — OTHER GATES OPEN' : 'ALL GATES MET');
  }

  // Factor pills
  const factors = buildProgressionFactors({ levelState, progress, equityCurve });
  setHTML(
    'levelFactors',
    factors
      .map(
        (factor) => `
        <span class="rm-pill ${toneClass(factor.direction)}" title="${esc(factor.detail)}">
          ${esc(factor.label)} <span class="rm-pill-glyph">${directionGlyph(factor.direction)}</span>
        </span>`
      )
      .join('')
  );

  setText('levelDescription', definition ? definition.description : '');
}

/* ========================================================================
 * RENDER — 2. WALLET / ACCOUNT HEALTH
 * ===================================================================== */

function renderHealth() {
  const { equityState, openRisk, drawdown, levelState } = state.evaluation;

  if (state.wallet.status === 'UNAVAILABLE') {
    setText('healthWallet', 'UNAVAILABLE');
    $('healthWallet')?.classList.add('eco-tone-short');
  } else {
    setText('healthWallet', formatUsd(state.wallet.value, { compact: true }));
    $('healthWallet')?.classList.remove('eco-tone-short');
  }

  setText('healthEquity', formatUsd(equityState.adjustedEquity, { compact: true }));
  setText('healthOpenRisk', formatPct(openRisk.consumedRiskPct));
  setText('healthDrawdown', formatPct(drawdown.currentDrawdownPct));
  setText('healthPositions', String(openRisk.count));
  setText('healthExposure', formatPct(openRisk.notionalExposurePct, 0));

  const pending = pendingCashFlows();
  const pendingCount = pending.length;
  setText(
    'healthFlows',
    `TRANSFERS: ${
      equityState.classifiedFlows > 0
        ? `${equityState.classifiedFlows} CLASSIFIED · ${formatUsd(equityState.netContributed, { compact: true })} NET`
        : 'NONE CLASSIFIED'
    }${pendingCount ? `  ·  ${pendingCount} AWAITING REVIEW` : ''}`
  );

  show('flowReviewWrap', pendingCount > 0);
  if (pendingCount > 0) {
    setHTML(
      'flowReview',
      pending
        .slice(0, 8)
        .map(
          (flow) => `
        <div class="rm-flow-row" data-flow-id="${esc(flow.id)}">
          <div class="rm-flow-main">
            <span class="eco-value">${esc(flow.type === 'DEPOSIT' ? 'IN' : 'OUT')}</span>
            <span class="rm-flow-when">${esc(formatDate(flow.at))}</span>
            <span class="rm-flow-move">${esc((flow.movements || []).map((m) => `${m.amount} ${truncateAddress(m.mint, 3, 3)}`).join(', ') || 'unknown movement')}</span>
          </div>
          <div class="rm-flow-actions">
            <input class="rm-input rm-flow-amount" type="number" inputmode="decimal" placeholder="USD" min="0" step="any" aria-label="USD amount for this transfer">
            <button class="rm-mini-btn" type="button" data-flow-action="DEPOSIT">Deposit</button>
            <button class="rm-mini-btn" type="button" data-flow-action="WITHDRAWAL">Withdrawal</button>
            <button class="rm-mini-btn" type="button" data-flow-action="NOT_A_TRANSFER">Not a transfer</button>
          </div>
        </div>`
        )
        .join('')
    );
  }

  // Data provenance line. Never silent about which layer the number came from.
  const bits = [];
  if (state.wallet.status === 'CACHED') bits.push(`CACHED · READ ${formatRelativeTime(state.wallet.at)}`);
  if (state.wallet.status === 'LOADING') bits.push('READING WALLET…');
  if (state.wallet.status === 'OK') bits.push(`LIVE · ${formatRelativeTime(state.wallet.at)}`);
  if (state.wallet.status === 'UNAVAILABLE') bits.push('WALLET DATA UNAVAILABLE');
  if (state.wallet.complete === false) bits.push('PARTIAL PRICING');
  if (state.history.status === 'LOADING') bits.push('RECONSTRUCTING TRADES…');
  if (state.history.status === 'UNAVAILABLE') bits.push('TRADE HISTORY UNAVAILABLE');
  if (state.history.status === 'OK') bits.push(`${levelState.totalClosedTrades} CLOSED TRADES`);
  setText('healthProvenance', bits.join('  ·  '));
}

/* ========================================================================
 * RENDER — 3/4. RECOMMENDER AND THE PRIMARY RECOMMENDATION
 * ===================================================================== */

function renderRecommendation() {
  const rec = state.evaluation.recommendation;
  const { headline, tone } = formatHeadline(rec);

  const headlineEl = $('recHeadline');
  if (headlineEl) {
    headlineEl.textContent = headline;
    headlineEl.className = `rm-rec-headline eco-value ${toneClass(tone)}`;
  }

  const maxLoss = formatMaxLossLine(rec);
  setText('recMaxLoss', maxLoss || '');
  show('recMaxLossWrap', Boolean(maxLoss));

  // Chips: strategy · confidence · level. All engine echoes.
  const preset = STRATEGY_PRESETS[rec.strategy] || STRATEGY_PRESETS.STANDARD;
  const chips = [
    `${preset.label.toUpperCase()}`,
    `CONFIDENCE ${rec.confidence ?? '—'}`,
    `LEVEL ${rec.level ?? '—'}`
  ];
  if (rec.stop?.source) chips.push(`STOP ${rec.stop.source}`);
  if (Number.isFinite(rec.stop?.distancePct)) chips.push(`${formatPct(rec.stop.distancePct)} AWAY`);
  if (Number.isFinite(rec.position?.margin) && rec.position.margin > 0) chips.push(`MARGIN ${formatUsd(rec.position.margin)}`);
  setHTML('recChips', chips.map((chip) => `<span class="rm-chip">${esc(chip)}</span>`).join(''));

  // NO TRADE / INCOMPLETE: the blocking constraint, its value, its limit and
  // what has to change. Rendered from the blocker the engine produced.
  const blocker = primaryBlocker(rec);
  if (blocker) {
    setHTML(
      'recBlocker',
      `<div class="rm-blocker-label">${esc(blocker.label)}</div>
       <div class="rm-blocker-figures">
         <span><span class="eco-label">NOW</span><span class="eco-value eco-tone-short">${esc(blocker.current)}</span></span>
         <span><span class="eco-label">LIMIT</span><span class="eco-value">${esc(blocker.limit)}</span></span>
       </div>
       <p class="rm-blocker-remedy">${esc(blocker.remedy)}</p>
       ${
         rec.blockers.length > 1
           ? `<p class="rm-blocker-more">${rec.blockers.length - 1} further constraint${rec.blockers.length === 2 ? '' : 's'}: ${esc(rec.blockers.slice(1).map((b) => b.label).join('; '))}</p>`
           : ''
       }`
    );
    show('recBlockerWrap', true);
  } else {
    show('recBlockerWrap', false);
  }

  // Warnings from the engine, verbatim.
  if (rec.warnings.length) {
    setHTML('recWarnings', rec.warnings.map((w) => `<li>${esc(w)}</li>`).join(''));
    show('recWarningsWrap', true);
  } else {
    show('recWarningsWrap', false);
  }

  const takeBtn = $('takeTrade');
  if (takeBtn) {
    takeBtn.disabled = rec.decision !== 'TRADE' || state.simulation.active;
    takeBtn.textContent = state.simulation.active ? 'SIMULATION — NOT RECORDED' : 'I TOOK THIS TRADE';
  }

  setText('recVersion', `ENGINE ${rec.strategyVersion} · INPUTS ${rec.inputsHash}`);

  renderFactors();
}

/* ========================================================================
 * RENDER — 5. DECISION FACTORS
 * ===================================================================== */

function renderFactors() {
  const rec = state.evaluation.recommendation;
  const factors = rec.factors || [];

  if (factors.length === 0) {
    setHTML('factorList', '<p class="rm-prose">The engine reported no factor as materially moving this recommendation. It sits on the level envelope and the confidence setting alone.</p>');
    return;
  }

  setHTML(
    'factorList',
    factors
      .map(
        (factor) => `
      <div class="rm-factor">
        <div class="rm-factor-head">
          <span class="rm-pill ${toneClass(factor.direction)}">${esc(humanCode(factor.code))} <span class="rm-pill-glyph">${directionGlyph(factor.direction)}</span></span>
          <span class="rm-factor-label">${esc(factor.label)}</span>
        </div>
        <p class="rm-factor-detail">${esc(factor.detail)}</p>
      </div>`
      )
      .join('')
  );
}

/* ========================================================================
 * RENDER — 6. EQUITY CURVE WITH LEVEL MARKERS
 *
 * Drawn at 1:1 pixel units against the measured container width, so a marker
 * is the same physical size at 320px as at 1200px and stays a real tap target.
 * ===================================================================== */

function renderChart() {
  const host = $('equityChart');
  if (!host) return;

  const curve = state.evaluation.equityCurve;
  const width = Math.max(280, host.clientWidth || 320);
  const height = width < 420 ? 200 : 260;
  const padding = { top: 18, right: 12, bottom: 22, left: 12 };

  if (!curve.valid || curve.points.length < 2) {
    host.innerHTML = `<p class="rm-prose rm-chart-empty">${
      state.history.status === 'LOADING'
        ? 'Building the performance curve…'
        : 'Not enough wallet snapshots yet. The curve needs at least two observed values; it is never drawn from a single point.'
    }</p>`;
    setHTML('transitionDetail', '');
    return;
  }

  const points = curve.points;
  const indices = points.map((p) => p.index);
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  const span = max - min || Math.max(max * 0.02, 0.02);
  const times = points.map((p) => p.at);
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const tSpan = t1 - t0 || 1;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const x = (at) => padding.left + ((at - t0) / tSpan) * plotW;
  const y = (index) => padding.top + plotH - ((index - (min - span * 0.1)) / (span * 1.2)) * plotH;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.index).toFixed(1)}`).join(' ');
  const area = `${path} L${x(t1).toFixed(1)},${(height - padding.bottom).toFixed(1)} L${x(t0).toFixed(1)},${(height - padding.bottom).toFixed(1)} Z`;

  // Level markers: each stored transition placed at the curve point nearest in
  // time. Position is approximate to the snapshot grid; the transition data
  // itself is exact and frozen.
  const history = loadLevelHistory();
  const markers = history
    .map((entry) => {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at)) return null;
      const nearest = points.reduce((best, p) => (Math.abs(p.at - at) < Math.abs(best.at - at) ? p : best), points[0]);
      return { entry, cx: x(Math.min(Math.max(at, t0), t1)), cy: y(nearest.index) };
    })
    .filter(Boolean);

  const startIndex = points[0].index;
  const baselineY = y(startIndex);

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
         aria-label="Adjusted trading equity with level transitions" class="rm-chart-svg">
      <defs>
        <linearGradient id="rmCurveFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-yellow-75)" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="var(--color-yellow-75)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${padding.left}" y1="${baselineY.toFixed(1)}" x2="${width - padding.right}" y2="${baselineY.toFixed(1)}"
            stroke="var(--eco-anchor-line)" stroke-width="1" stroke-dasharray="3 4"/>
      <path d="${area}" fill="url(#rmCurveFill)"/>
      <path d="${path}" fill="none" stroke="var(--color-yellow-75)" stroke-width="1.75"
            stroke-linejoin="round" stroke-linecap="round"/>
      ${markers
        .map(
          (m) => `
        <g class="rm-marker ${m.entry.type === 'PROMOTION' ? 'is-up' : 'is-down'} ${
            state.selectedTransitionId === m.entry.id ? 'is-selected' : ''
          }" data-transition-id="${esc(m.entry.id)}" role="button" tabindex="0"
           aria-label="Level ${m.entry.from} to ${m.entry.to}. Tap for detail.">
          <line x1="${m.cx.toFixed(1)}" y1="${padding.top}" x2="${m.cx.toFixed(1)}" y2="${(height - padding.bottom).toFixed(1)}"
                class="rm-marker-line"/>
          <circle cx="${m.cx.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="5.5" class="rm-marker-dot"/>
          <circle cx="${m.cx.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="24" class="rm-marker-hit"/>
        </g>`
        )
        .join('')}
    </svg>
    <div class="rm-chart-axis">
      <span>${esc(formatDate(t0))}</span>
      <span class="rm-chart-axis-mid">${esc(formatSignedPct(curve.totalGrowthPct))} ADJUSTED</span>
      <span>${esc(formatDate(t1))}</span>
    </div>
    ${markers.length === 0 ? '<p class="rm-chart-note">No level transitions recorded yet.</p>' : '<p class="rm-chart-note">Tap a marker for the transition detail.</p>'}
  `;

  renderTransitionDetail();
}

function renderTransitionDetail() {
  if (!state.selectedTransitionId) {
    setHTML('transitionDetail', '');
    return;
  }
  const entry = loadLevelHistory().find((e) => e.id === state.selectedTransitionId);
  if (!entry) {
    setHTML('transitionDetail', '');
    return;
  }

  const thresholds = (entry.thresholds || [])
    .map(
      (t) => `<div class="rm-threshold ${t.passed ? 'is-pass' : 'is-fail'}">
        <span class="rm-threshold-mark">${t.passed ? '✓' : '✕'}</span>
        <span class="rm-threshold-code">${esc(humanCode(t.code))}</span>
        <span class="rm-threshold-value">${esc(t.current)} / ${esc(t.required)}</span>
      </div>`
    )
    .join('');

  setHTML(
    'transitionDetail',
    `<div class="rm-transition">
      <div class="rm-transition-head">
        <span class="eco-value ${entry.type === 'PROMOTION' ? 'eco-tone-long' : 'eco-tone-short'}">
          ${entry.type === 'PROMOTION' ? 'LEVEL UP' : 'LEVEL DOWN'} ${entry.from} → ${entry.to}
        </span>
        <span class="rm-transition-date">${esc(formatDate(entry.at))}</span>
        <button class="rm-mini-btn" type="button" id="closeTransition">Close</button>
      </div>
      <p class="rm-factor-detail">${esc(entry.reason)}</p>
      <div class="rm-transition-stats">
        <div><span class="eco-label">Closed trades</span><span class="eco-value">${esc(entry.totalClosedTrades ?? '—')}</span></div>
        <div><span class="eco-label">Since last change</span><span class="eco-value">${esc(entry.tradesSinceLevelChange ?? '—')}</span></div>
        <div><span class="eco-label">Win rate</span><span class="eco-value">${formatPct(entry.winRate, 1)}</span></div>
        <div><span class="eco-label">Avg R</span><span class="eco-value">${Number.isFinite(entry.avgR) ? entry.avgR.toFixed(2) : '—'}</span></div>
        <div><span class="eco-label">Consistency</span><span class="eco-value">${formatPct(entry.consistency, 0)}</span></div>
        <div><span class="eco-label">Drawdown</span><span class="eco-value">${formatPct(entry.drawdownPct, 1)}</span></div>
      </div>
      <div class="rm-thresholds">${thresholds || '<p class="rm-prose">No threshold snapshot stored for this transition.</p>'}</div>
    </div>`
  );
}

/* ========================================================================
 * RENDER — 7. OPEN POSITIONS
 * ===================================================================== */

function renderPositions() {
  const positions = state.evaluation.openRisk.positions;

  if (positions.length === 0) {
    setHTML(
      'positionList',
      `<p class="rm-prose">${
        state.history.status === 'LOADING' ? 'Reading open positions…' : 'No open positions found for this wallet.'
      }</p>`
    );
    show('positionEvalWrap', false);
    return;
  }

  setHTML(
    'positionList',
    positions
      .map(
        (position) => `
      <button class="rm-position-row ${state.selectedPositionId === position.id ? 'is-selected' : ''}"
              type="button" data-position-id="${esc(position.id)}"
              aria-pressed="${state.selectedPositionId === position.id}">
        <span class="rm-position-asset">${esc(formatAsset(position.asset))}</span>
        <span class="rm-position-side ${toneClass(position.direction === 'SHORT' ? 'SHORT' : 'LONG')}">${esc(position.direction || '—')}</span>
        <span class="rm-position-figure"><span class="eco-label">Notional</span>${formatUsd(position.notional, { compact: true })}</span>
        <span class="rm-position-figure"><span class="eco-label">Consumed</span>${formatUsd(position.consumed, { compact: true })}</span>
        <span class="rm-position-figure"><span class="eco-label">Open P&amp;L</span><span class="${
          position.unrealizedPnl > 0 ? 'eco-tone-long' : position.unrealizedPnl < 0 ? 'eco-tone-short' : ''
        }">${formatSignedUsd(position.unrealizedPnl, { compact: true })}</span></span>
      </button>`
      )
      .join('')
  );

  const evalBtn = $('evaluatePosition');
  if (evalBtn) evalBtn.disabled = !state.selectedPositionId;

  renderPositionEvaluation();
}

function renderPositionEvaluation() {
  const result = state.positionEvaluation;
  if (!result) {
    show('positionEvalWrap', false);
    return;
  }
  show('positionEvalWrap', true);

  const actionTone =
    result.action === 'EXIT' || result.action === 'REDUCE' ? 'SHORT' : result.action === 'ADD' ? 'LONG' : 'NEUTRAL';

  const actions = ['ADD', 'HOLD', 'REDUCE', 'EXIT'];
  if (result.protectProfit) actions.push('PROTECT PROFIT');

  setHTML(
    'positionEval',
    `<div class="rm-eval-head">
      <span class="eco-label">Engine decision</span>
      <span class="rm-eval-action eco-value ${toneClass(actionTone)}">${esc(result.action)}</span>
    </div>
    <div class="rm-eval-actions">
      ${actions
        .map(
          (label) => `<span class="rm-eval-option ${
            label === result.action || (label === 'PROTECT PROFIT' && result.protectProfit) ? 'is-active' : ''
          }">${esc(label)}</span>`
        )
        .join('')}
    </div>
    <div class="rm-eval-stats">
      <div><span class="eco-label">Open R</span><span class="eco-value">${result.position.openR.toFixed(2)}R</span></div>
      <div><span class="eco-label">Position risk</span><span class="eco-value">${formatPct(result.position.riskPct)}</span></div>
      <div><span class="eco-label">Notional</span><span class="eco-value">${formatPct(result.position.notionalPct, 0)}</span></div>
      <div><span class="eco-label">Ceiling</span><span class="eco-value">${formatPct(result.envelope.maxRiskPct)}</span></div>
    </div>
    ${
      result.addition
        ? `<div class="rm-eval-block"><span class="eco-label">Addition permitted</span>
             <span class="eco-value">${formatUsd(result.addition.notional)} · risk ${formatUsd(result.addition.riskAmount)} (${formatPct(result.addition.riskPct)})</span>
             <p class="rm-factor-detail">Capped at ${esc(result.addition.cappedAt)}.</p></div>`
        : ''
    }
    ${
      result.protectProfit
        ? `<div class="rm-eval-block"><span class="eco-label">Protect profit</span>
             <span class="eco-value">Stop → ${result.protectProfit.proposedStop.toFixed(4)}</span>
             <p class="rm-factor-detail">Locks ${formatUsd(result.protectProfit.lockedProfit)}, leaves ${formatUsd(result.protectProfit.remainingRisk)} of give-back. ${esc(result.protectProfit.note)}</p></div>`
        : ''
    }
    ${
      result.blockers.length
        ? `<div class="rm-eval-block">${result.blockers
            .map(
              (b) =>
                `<div class="rm-blocker-inline"><span class="eco-label">${esc(b.label)}</span><span class="eco-value eco-tone-short">${esc(b.current)}</span><span class="rm-blocker-limit">limit ${esc(b.limit)}</span><p class="rm-factor-detail">${esc(b.remedy)}</p></div>`
            )
            .join('')}</div>`
        : ''
    }
    <ul class="rm-rationale">${result.rationale.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
  );
}

/* ========================================================================
 * RENDER — 8. TRADE HISTORY
 * ===================================================================== */

function renderHistory() {
  const trades = state.history.trades;

  if (trades.length === 0) {
    setHTML(
      'historyBody',
      `<tr><td colspan="8" class="rm-history-empty">${
        state.history.status === 'LOADING'
          ? 'Reconstructing trade history…'
          : state.history.status === 'UNAVAILABLE'
            ? 'Trade history unavailable — the RPC could not be reached. Nothing was inferred.'
            : 'No trades found for this wallet yet.'
      }</td></tr>`
    );
    setText('historyCount', '0 RECORDS');
    return;
  }

  setHTML(
    'historyBody',
    trades
      .map((trade) => {
        const confidence = formatDataConfidence(trade.dataConfidence);
        const pnl = trade.realizedPnl;
        return `
        <tr class="rm-history-row" data-trade-id="${esc(trade.id)}" tabindex="0" role="button"
            aria-label="Open record for ${esc(formatAsset(trade.asset))}">
          <td class="rm-col-asset">${esc(formatAsset(trade.asset))}${
            trade.hasConflicts ? '<span class="rm-conflict-dot" title="On-chain and local values disagree">!</span>' : ''
          }</td>
          <td class="rm-col-side ${toneClass(trade.direction === 'SHORT' ? 'SHORT' : 'LONG')}">${esc(trade.direction || '—')}</td>
          <td class="rm-col-pnl ${Number.isFinite(pnl) ? (pnl > 0 ? 'eco-tone-long' : pnl < 0 ? 'eco-tone-short' : '') : ''}">${
            Number.isFinite(pnl) ? formatSignedUsd(pnl, { compact: true }) : '—'
          }</td>
          <td class="rm-col-level">${Number.isFinite(trade.level) ? trade.level : '—'}</td>
          <td class="rm-col-strategy">${esc(trade.strategy || '—')}</td>
          <td class="rm-col-confidence">${Number.isFinite(trade.confidence) ? trade.confidence : '—'}</td>
          <td class="rm-col-status">${esc(trade.status || '—')}</td>
          <td class="rm-col-data"><span class="rm-data-flag ${toneClass(confidence.tone)}">${esc(confidence.label)}</span></td>
        </tr>`;
      })
      .join('')
  );

  const needsReview = trades.filter((t) => t.dataConfidence === 'NEEDS_REVIEW').length;
  const conflicts = trades.filter((t) => t.hasConflicts).length;
  setText(
    'historyCount',
    `${trades.length} RECORDS${needsReview ? ` · ${needsReview} NEED REVIEW` : ''}${conflicts ? ` · ${conflicts} CONFLICT` : ''}`
  );
}

/* ========================================================================
 * TRADE DETAIL SHEET
 * ===================================================================== */

function openTradeSheet(tradeId) {
  const trade = state.history.trades.find((t) => t.id === tradeId);
  if (!trade) return;
  state.openTradeId = tradeId;

  const field = (label, key, value, type = 'text', placeholder = '') => `
    <label class="rm-sheet-field">
      <span class="eco-label">${esc(label)}</span>
      <input class="rm-input" data-edit-field="${esc(key)}" type="${type}"
             ${type === 'number' ? 'inputmode="decimal" step="any"' : ''}
             value="${value === null || value === undefined ? '' : esc(value)}" placeholder="${esc(placeholder)}">
    </label>`;

  const conflictBlock = trade.hasConflicts
    ? `<div class="rm-sheet-conflicts">
         <div class="eco-label">Conflicts — on-chain vs local</div>
         ${trade.conflicts
           .map(
             (c) => `<div class="rm-conflict-row">
               <span class="rm-conflict-field">${esc(c.field)}</span>
               <span class="rm-conflict-values">chain <strong>${esc(c.onchain)}</strong> · yours <strong>${esc(c.local)}</strong></span>
               <span class="rm-conflict-res">${c.resolution === 'ONCHAIN' ? 'ON-CHAIN APPLIED' : 'YOURS APPLIED'}</span>
             </div>`
           )
           .join('')}
         <p class="rm-factor-detail">On-chain data outranks a manual or screenshot value wherever the chain observed it directly. The disagreement is shown, never resolved silently.</p>
       </div>`
    : '';

  setHTML(
    'sheetBody',
    `<div class="rm-sheet-head">
       <div>
         <div class="eco-label">${esc(trade.source || 'RECORD')} · ${esc(formatDataConfidence(trade.dataConfidence).label)}</div>
         <div class="rm-sheet-title eco-value">${esc(formatAsset(trade.asset))} ${esc(trade.direction || '')}</div>
       </div>
       <button class="rm-mini-btn" type="button" id="sheetClose" aria-label="Close record">Close</button>
     </div>
     ${conflictBlock}
     ${
       (trade.confidenceReasons || []).length
         ? `<p class="rm-factor-detail">${esc(trade.confidenceReasons.join('; '))}</p>`
         : ''
     }
     <div class="rm-sheet-grid">
       ${field('Asset', 'asset', trade.asset)}
       ${field('Entry', 'entry', trade.entry, 'number')}
       ${field('Exit', 'exit', trade.exit, 'number')}
       ${field('Stop', 'stop', trade.stop, 'number', 'the stop you actually used')}
       ${field('Realized P&L (USD)', 'realizedPnl', trade.realizedPnl, 'number')}
       ${field('Risk taken (USD)', 'riskAmount', trade.riskAmount, 'number', 'what you planned to lose')}
       ${field('Leverage', 'leverage', trade.leverage, 'number')}
       ${field('Confidence 0-100', 'confidence', trade.confidence, 'number')}
       ${field('Level at entry', 'level', trade.level, 'number')}
       <label class="rm-sheet-field">
         <span class="eco-label">Direction</span>
         <select class="rm-input" data-edit-field="direction">
           <option value="">—</option>
           <option value="LONG" ${trade.direction === 'LONG' ? 'selected' : ''}>LONG</option>
           <option value="SHORT" ${trade.direction === 'SHORT' ? 'selected' : ''}>SHORT</option>
         </select>
       </label>
       <label class="rm-sheet-field">
         <span class="eco-label">Strategy</span>
         <select class="rm-input" data-edit-field="strategy">
           <option value="">—</option>
           <option value="STANDARD" ${trade.strategy === 'STANDARD' ? 'selected' : ''}>STANDARD</option>
           <option value="AGGRESSIVE" ${trade.strategy === 'AGGRESSIVE' ? 'selected' : ''}>AGGRESSIVE</option>
         </select>
       </label>
       <label class="rm-sheet-field">
         <span class="eco-label">Status</span>
         <select class="rm-input" data-edit-field="status">
           <option value="OPEN" ${trade.status === 'OPEN' ? 'selected' : ''}>OPEN</option>
           <option value="CLOSED" ${trade.status === 'CLOSED' ? 'selected' : ''}>CLOSED</option>
           <option value="PLANNED" ${trade.status === 'PLANNED' ? 'selected' : ''}>PLANNED</option>
           <option value="CANCELLED" ${trade.status === 'CANCELLED' ? 'selected' : ''}>CANCELLED</option>
         </select>
       </label>
     </div>

     <label class="rm-sheet-field">
       <span class="eco-label">Notes</span>
       <textarea class="rm-input rm-textarea" data-edit-field="notes" rows="2">${esc(trade.notes || '')}</textarea>
     </label>

     <div class="rm-sheet-section">
       <div class="eco-label">Screenshot</div>
       <p class="rm-factor-detail">Parsed by the existing screenshot reader. What it extracts is a CLAIM about the trade: on-chain values always outrank it, and only the parsed fields are stored, never the image.</p>
       <input class="rm-file" type="file" accept="image/*" id="sheetScreenshot">
       <div id="sheetScreenshotResult" class="rm-factor-detail"></div>
     </div>

     <div class="rm-sheet-section">
       <div class="eco-label">Not a trade?</div>
       <p class="rm-factor-detail">Classifying this as a transfer cancels the trade record and adds a confirmed cash flow, which is removed from the performance curve but not from the capital base.</p>
       <div class="rm-sheet-flow">
         <input class="rm-input" type="number" inputmode="decimal" step="any" id="sheetFlowAmount" placeholder="USD amount">
         <button class="rm-mini-btn" type="button" data-sheet-flow="DEPOSIT">Deposit</button>
         <button class="rm-mini-btn" type="button" data-sheet-flow="WITHDRAWAL">Withdrawal</button>
       </div>
     </div>

     <div class="rm-sheet-actions">
       <button class="btn-base btn-primary rm-btn" type="button" id="sheetSave">Save corrections</button>
       <button class="btn-base btn-secondary rm-btn" type="button" id="sheetCancel">Cancel</button>
     </div>`
  );

  show('tradeSheet', true);
  document.body.classList.add('rm-sheet-open');
}

function closeTradeSheet() {
  state.openTradeId = null;
  show('tradeSheet', false);
  document.body.classList.remove('rm-sheet-open');
}

function collectSheetOverrides() {
  const overrides = {};
  document.querySelectorAll('#sheetBody [data-edit-field]').forEach((input) => {
    const key = input.getAttribute('data-edit-field');
    const raw = input.value;
    if (raw === '' || raw === null) return;
    if (input.type === 'number') {
      const value = Number(raw);
      if (Number.isFinite(value)) overrides[key] = value;
    } else {
      overrides[key] = raw;
    }
  });
  return overrides;
}

/* ========================================================================
 * RENDER — STRATEGY LEARNING PROPOSALS
 * ===================================================================== */

function renderProposals() {
  const decided = decidedProposalIds();
  const open = state.proposals.filter((p) => !decided.has(p.id));
  const versions = loadStrategyVersions();
  const current = currentStrategyVersion();

  setText(
    'strategyVersionLine',
    current
      ? `CONFIG ${current.configVersion} · ${versions.length} DECISION${versions.length === 1 ? '' : 'S'} RECORDED`
      : `ENGINE DEFAULT ${STRATEGY_VERSION} · NO OVERRIDES APPROVED`
  );

  if (open.length === 0) {
    setHTML(
      'proposalList',
      `<p class="rm-prose">No proposals. The engine will not suggest a change below 20 closed trades in a group, or below 30 for an increase — a smaller sample cannot be told apart from noise.</p>`
    );
    return;
  }

  setHTML(
    'proposalList',
    open
      .map(
        (proposal) => `
      <div class="rm-proposal" data-proposal-id="${esc(proposal.id)}">
        <div class="rm-proposal-head">
          <span class="eco-label">${esc(proposal.scope)}</span>
          <span class="rm-chip">${esc(proposal.sampleSize)} TRADES · ${esc(proposal.confidence)}</span>
        </div>
        <div class="rm-proposal-change">
          <span class="rm-proposal-current">${esc(proposal.current)}</span>
          <span class="rm-arrow">→</span>
          <span class="rm-proposal-proposed eco-value">${esc(proposal.proposed)}</span>
        </div>
        <p class="rm-factor-detail">${esc(proposal.reason)}</p>
        <div class="rm-proposal-actions">
          <button class="rm-mini-btn" type="button" data-proposal-action="APPROVED">Approve</button>
          <button class="rm-mini-btn" type="button" data-proposal-action="KEPT">Keep current</button>
        </div>
      </div>`
      )
      .join('')
  );
}

/* ========================================================================
 * RENDER — PLANNED VS ACTUAL
 * ===================================================================== */

function renderPlanned() {
  const records = loadRecommendations().filter((r) => !r.simulated).slice(-6).reverse();
  if (records.length === 0) {
    setHTML('plannedList', '<p class="rm-prose">Nothing recorded yet. After a recommendation, I TOOK THIS TRADE freezes what was recommended and starts watching for a matching on-chain execution.</p>');
    return;
  }

  setHTML(
    'plannedList',
    records
      .map(
        (record) => `
      <div class="rm-planned">
        <div class="rm-planned-head">
          <span class="eco-value">${esc(formatAsset(record.asset) || 'UNSPECIFIED')}</span>
          <span class="rm-chip">${esc(record.strategy)} · C${esc(record.confidence)} · L${esc(record.level)}</span>
          <span class="rm-chip ${record.matchState === 'MATCHED' ? 'eco-tone-long' : ''}">${esc(record.matchState)}</span>
        </div>
        <div class="rm-planned-cols">
          <div><span class="eco-label">Recommended</span><span class="eco-value">${formatUsd(record.recommended?.notional)} @ ${esc(formatLeverage(record.recommended?.leverage) || '—')}</span></div>
          <div><span class="eco-label">Actual</span><span class="eco-value">${
            record.actual ? formatUsd(record.actual.notional) : 'awaiting execution'
          }</span></div>
        </div>
        <div class="rm-planned-meta">${esc(formatDate(record.at))} · max loss ${formatUsd(record.recommended?.maxLossAmount)} · ${esc(record.inputsHash || '')}</div>
      </div>`
      )
      .join('')
  );
}

/* ========================================================================
 * MASTER RENDER
 * ===================================================================== */

function render() {
  if (!state.evaluation) return;
  renderLevel();
  renderHealth();
  renderRecommendation();
  renderChart();
  renderPositions();
  renderHistory();
  renderProposals();
  renderPlanned();
  renderWalletBar();
}

function refresh() {
  evaluate();
  render();
}

function renderWalletBar() {
  const address = state.address;
  setText('walletAddressLabel', address ? truncateAddress(address, 6, 6) : 'NO WALLET');
  show('walletConnected', Boolean(address));
  show('walletConnect', !address);

  const sim = $('simulationBanner');
  if (sim) sim.hidden = !state.simulation.active;
  setText(
    'simulationSummary',
    state.simulation.active
      ? `SANDBOX · WALLET ${formatUsd(state.simulation.walletValue, { compact: true })} · ${state.simulation.hypotheticalTrades.length} HYPOTHETICAL TRADES · NOTHING IS SAVED`
      : ''
  );
}

/* ========================================================================
 * LAYERED LOADING
 * ===================================================================== */

/** Layer 1 — cached. Synchronous, paints immediately, never blocks. */
function loadCachedLayer() {
  const stored = loadWalletAddress();
  state.address = stored?.address || null;

  const snapshot = latestEquitySnapshot();
  if (snapshot) {
    state.wallet = {
      status: 'CACHED',
      value: snapshot.walletValue,
      complete: snapshot.complete !== false,
      at: snapshot.at,
      warnings: [],
      error: null
    };
  }

  // Local corrections alone, until the reconstruction lands.
  state.history.trades = mergeTradeRecords([]);
  refresh();
}

/** Layer 2 — the live wallet value. */
async function loadWalletLayer() {
  if (!state.address) return;
  state.wallet.status = 'LOADING';
  renderHealth();
  renderWalletBar();

  try {
    const response = await fetch(`/api/wallet/portfolio?address=${encodeURIComponent(state.address)}`);
    const body = await response.json();

    if (!response.ok || body.totalUsdValue === null || body.totalUsdValue === undefined) {
      // 503 from the endpoint means no balances were read. Nothing is invented
      // here either: the last cached value stays visible, clearly labelled.
      state.wallet.status = state.wallet.value === null ? 'UNAVAILABLE' : 'CACHED';
      state.wallet.error = body.message || 'Wallet data unavailable';
      state.wallet.warnings = body.warnings || [];
      if (state.wallet.value === null) state.wallet.value = null;
      notice(`WALLET DATA UNAVAILABLE — ${state.wallet.error}`);
      refresh();
      return;
    }

    state.wallet = {
      status: 'OK',
      value: body.totalUsdValue,
      complete: body.complete !== false,
      at: body.at || new Date().toISOString(),
      warnings: body.warnings || [],
      error: null
    };

    persist(() =>
      appendEquitySnapshot(body.totalUsdValue, {
        at: state.wallet.at,
        source: 'WALLET_PORTFOLIO',
        complete: body.complete !== false
      })
    );

    clearNotice();
  } catch (error) {
    state.wallet.status = state.wallet.value === null ? 'UNAVAILABLE' : 'CACHED';
    state.wallet.error = error.message;
    notice(`WALLET DATA UNAVAILABLE — ${error.message}`);
  }

  // Layer 3 is simply the engine re-running against the fresh value.
  refresh();
}

/** Layer 4 — the deeper reconstruction. Slowest, least blocking. */
async function loadHistoryLayer() {
  if (!state.address) return;
  state.history.status = 'LOADING';
  renderHealth();
  renderHistory();

  try {
    const response = await fetch(`/api/wallet/trades?address=${encodeURIComponent(state.address)}&maxTransactions=200`);
    const body = await response.json();

    if (!response.ok) {
      state.history.status = 'UNAVAILABLE';
      state.history.warnings = body.warnings || [body.message || 'Trade history unavailable'];
      refresh();
      return;
    }

    state.history.status = 'OK';
    state.history.warnings = body.warnings || [];
    state.history.methodology = body.methodology || null;
    state.history.cashFlowCandidates = body.cashFlows || [];

    persist(() => ingestCashFlowCandidates(body.cashFlows || []));
    state.history.onchain = body.trades || [];
    state.history.trades = mergeTradeRecords(state.history.onchain);

    matchWatchedRecommendations();
  } catch (error) {
    state.history.status = 'UNAVAILABLE';
    state.history.warnings = [error.message];
  }

  refresh();
}

/**
 * Does the asset on a recommendation name the same thing as the asset on an
 * on-chain trade?
 *
 * WHY THIS EXISTS: `record.asset` is a ticker the user typed ("SOL");
 * `trade.asset` is a base58 mint address. A plain string compare is never true,
 * so before this every watching recommendation stayed WATCHING forever.
 *
 * COVERS: identical strings (two tickers, e.g. a MANUAL trade record, or a user
 * who pasted the mint itself) and the tickers listed in KNOWN_MINTS.
 * DOES NOT COVER: every other token, BTC and ETH included — see KNOWN_MINTS for
 * why. Those stay unmatched, which is the safe failure.
 */
function assetMatches(recordAsset, tradeAsset) {
  if (!recordAsset || !tradeAsset) return false;
  const record = String(recordAsset).trim();
  const trade = String(tradeAsset).trim();

  // Mints are case-SENSITIVE base58, so the exact compare comes first.
  if (record === trade) return true;
  if (KNOWN_MINTS[record.toUpperCase()] === trade) return true;

  // Tickers are case-insensitive. Only compare loosely when both sides are
  // short: formatAsset treats anything over 12 chars as a mint, and folding the
  // case of a mint would make two different mints look equal.
  return record.length <= 12 && trade.length <= 12 && record.toUpperCase() === trade.toUpperCase();
}

/**
 * Link a planned recommendation to an execution that has since appeared
 * on-chain. The match is deliberately narrow — same asset, same direction,
 * opened after the recommendation, and one trade per recommendation — and it
 * records what was ACTUALLY done beside what was recommended. A near-miss is
 * left unmatched rather than assumed.
 *
 * Matching also hands the engine back the ONE number the chain cannot know:
 * what the trader intended to risk. Without it every reconstructed trade grades
 * as 0R, so win rate, avgR and the level ladder all sit frozen on real data.
 */
function matchWatchedRecommendations() {
  const watching = watchingRecommendations();
  if (watching.length === 0) return;

  // One on-chain execution can back at most one recommendation. Seeded from
  // every recommendation ever linked, not just this pass, so a second watching
  // recommendation on the same asset cannot re-claim a trade that an earlier
  // refresh already linked.
  const claimed = new Set(loadRecommendations().map((r) => r.linkedTradeId).filter(Boolean));
  let linkedAny = false;

  for (const record of watching) {
    const recordedAt = Date.parse(record.at);
    const match = state.history.trades.find((trade) => {
      if (claimed.has(trade.id)) return false;
      if (!assetMatches(record.asset, trade.asset)) return false;
      // DIRECTION: only a disagreement rejects. The spot reconstruction
      // hardcodes LONG (a token balance cannot go negative) and reports null for
      // anything it could not decode, so a SHORT recommendation will never match
      // a spot trade — correct, because that short was not executed as spot. A
      // missing direction on either side is unknown, not a contradiction.
      if (record.direction && trade.direction &&
          String(record.direction).toUpperCase() !== String(trade.direction).toUpperCase()) return false;
      const opened = Date.parse(trade.openedAt);
      return Number.isFinite(opened) && Number.isFinite(recordedAt) && opened >= recordedAt;
    });
    if (!match) continue;

    claimed.add(match.id);

    persist(() =>
      linkRecommendationToTrade(record.id, match.id, {
        notional: match.notional,
        entry: match.entry,
        direction: match.direction,
        openedAt: match.openedAt,
        dataConfidence: match.dataConfidence
      })
    );

    // The engine grades closed trades in R, which needs a risk figure the chain
    // never reports. The engine already sized this trade, so hand that figure
    // back rather than leaving the trade to read as a 0R scratch. strategy /
    // confidence / level come along because analyzeStrategyPerformance buckets
    // everything without them into 'UNSPECIFIED'.
    //
    // A figure a human typed themselves is left alone: this fills a gap, it does
    // not overrule a person.
    // upsertTradeRecord deletes an override set to null or '', so a key that is
    // still present is a figure a human meant to put there.
    const existing = match.overrides || {};
    const overrides = {};
    if (existing.riskAmount === undefined) overrides.riskAmount = record.recommended?.maxLossAmount ?? null;
    if (existing.strategy === undefined) overrides.strategy = record.strategy ?? null;
    if (existing.confidence === undefined) overrides.confidence = record.confidence ?? null;
    if (existing.level === undefined) overrides.level = record.level ?? null;
    // A null here is dropped by the store, so a recommendation missing a figure
    // writes nothing for that field. persist() returns null inside the
    // simulation sandbox: nothing was written, so there is nothing to re-merge.
    if (persist(() => upsertTradeRecord({ id: match.id, source: 'ONCHAIN', overrides }))) linkedAny = true;
  }

  // state.history.trades was merged before those overrides existed. Re-merge
  // from the untouched reconstruction so this same refresh grades with the risk
  // figure present, instead of showing 0R until the next history load.
  if (linkedAny) state.history.trades = mergeTradeRecords(state.history.onchain);
}

/* ========================================================================
 * NOTICES
 * ===================================================================== */

function notice(message) {
  const node = $('rmNotice');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

function clearNotice() {
  const node = $('rmNotice');
  if (node) node.hidden = true;
}

/* ========================================================================
 * EVENTS
 * ===================================================================== */

function readRequestFromForm() {
  const asset = $('reqAsset')?.value?.trim() || '';
  const entry = Number($('reqEntry')?.value);
  const stop = Number($('reqStop')?.value);

  state.request.asset = asset;
  state.request.entry = Number.isFinite(entry) && entry > 0 ? entry : null;
  state.request.stop = Number.isFinite(stop) && stop > 0 ? stop : null;
  // Direction is inferred by the engine from entry vs stop when both exist;
  // this page does not guess one.
  state.request.direction = null;
}

function bindRecommender() {
  ['reqAsset', 'reqEntry', 'reqStop'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      readRequestFromForm();
      persist(() => saveUiPrefs({ lastAsset: state.request.asset }));
      refresh();
    });
  });

  document.querySelectorAll('[data-strategy]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-strategy');
      state.request.strategy = key;
      document.querySelectorAll('[data-strategy]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b === button));
      });
      updateConfidenceBounds();
      persist(() => saveUiPrefs({ strategy: key }));
      refresh();
    });
  });

  const slider = $('reqConfidence');
  slider?.addEventListener('input', () => {
    state.request.confidence = Number(slider.value);
    setText('confidenceValue', String(state.request.confidence));
    refresh();
  });
  slider?.addEventListener('change', () => {
    persist(() => saveUiPrefs({ confidence: state.request.confidence }));
  });

  $('takeTrade')?.addEventListener('click', () => {
    const rec = state.evaluation?.recommendation;
    if (!rec || rec.decision !== 'TRADE') return;
    persist(() =>
      saveRecommendation({
        asset: rec.asset,
        direction: state.evaluation.recommendation.detail?.direction ?? null,
        strategy: rec.strategy,
        confidence: rec.confidence,
        level: rec.level,
        decision: rec.decision,
        recommended: {
          notional: rec.position.notional,
          leverage: rec.position.leverage,
          margin: rec.position.margin,
          maxLossPct: rec.maxLoss.pct,
          maxLossAmount: rec.maxLoss.amount,
          stopPrice: rec.stop.price,
          stopDistancePct: rec.stop.distancePct,
          stopSource: rec.stop.source
        },
        matchState: 'WATCHING',
        strategyVersion: rec.strategyVersion,
        inputsHash: rec.inputsHash
      })
    );
    renderPlanned();
    notice('RECORDED. Watching for a matching on-chain execution on the next history refresh.');
  });
}

/** STANDARD caps its usable slider at 90; the endpoints must say so. */
function updateConfidenceBounds() {
  const preset = STRATEGY_PRESETS[state.request.strategy] || STRATEGY_PRESETS.STANDARD;
  setText('confidenceHigh', `HIGH ${preset.confidenceRange.max}`);
  setText('confidenceLow', `LOW ${preset.confidenceRange.min}`);
}

function bindWallet() {
  $('walletSave')?.addEventListener('click', () => {
    const input = $('walletInput');
    const value = input?.value?.trim();
    if (!value) return;
    // Anything that looks like a secret is refused outright, loudly.
    if (value.split(/\s+/).length > 2) {
      notice('That looks like a seed phrase. This page accepts a PUBLIC ADDRESS only and can never sign anything — never paste a seed phrase or private key anywhere.');
      input.value = '';
      return;
    }
    persist(() => saveWalletAddress(value));
    state.address = value;
    clearNotice();
    renderWalletBar();
    loadWalletLayer().then(loadHistoryLayer);
  });

  $('walletClear')?.addEventListener('click', () => {
    persist(() => clearWalletAddress());
    state.address = null;
    state.wallet = { status: 'IDLE', value: null, complete: true, at: null, warnings: [], error: null };
    state.history = {
      status: 'IDLE',
      onchain: [],
      trades: mergeTradeRecords([]),
      positions: [],
      cashFlowCandidates: [],
      warnings: [],
      methodology: null
    };
    refresh();
  });

  $('walletRefresh')?.addEventListener('click', () => {
    loadWalletLayer().then(loadHistoryLayer);
  });
}

function bindSimulation() {
  $('simulateToggle')?.addEventListener('click', () => {
    state.simulation.active = !state.simulation.active;
    if (state.simulation.active) {
      state.simulation.walletValue = state.wallet.value;
      state.simulation.hypotheticalTrades = [];
      const input = $('simWallet');
      if (input) input.value = Number.isFinite(state.wallet.value) ? String(Math.round(state.wallet.value)) : '';
    } else {
      state.simulation.walletValue = null;
      state.simulation.hypotheticalTrades = [];
    }
    show('simulationPanel', state.simulation.active);
    $('simulateToggle').setAttribute('aria-pressed', String(state.simulation.active));
    refresh();
  });

  $('simWallet')?.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state.simulation.walletValue = Number.isFinite(value) && value > 0 ? value : null;
    refresh();
  });

  document.querySelectorAll('[data-sim-trade]').forEach((button) => {
    button.addEventListener('click', () => {
      const r = Number(button.getAttribute('data-sim-trade'));
      const index = state.simulation.hypotheticalTrades.length + 1;
      // A hypothetical trade is a labelled fiction that lives in memory only.
      state.simulation.hypotheticalTrades.push({
        id: `sim-${index}`,
        asset: 'SIMULATED',
        status: 'CLOSED',
        closedAt: new Date(Date.now() + index * 60000).toISOString(),
        rMultiple: r,
        realizedPnl: r,
        riskAmount: 1,
        strategy: state.request.strategy,
        confidence: state.request.confidence
      });
      refresh();
    });
  });

  $('simReset')?.addEventListener('click', () => {
    state.simulation.hypotheticalTrades = [];
    state.simulation.walletValue = state.wallet.value;
    refresh();
  });
}

function bindPositions() {
  $('positionList')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-position-id]');
    if (!row) return;
    const id = row.getAttribute('data-position-id');
    state.selectedPositionId = state.selectedPositionId === id ? null : id;
    state.positionEvaluation = null;
    renderPositions();
  });

  $('evaluatePosition')?.addEventListener('click', () => {
    if (!state.selectedPositionId) return;
    const position = state.evaluation.openRisk.positions.find((p) => p.id === state.selectedPositionId);
    if (!position) return;

    state.positionEvaluation = evaluatePosition({
      account: state.evaluation.account,
      position: {
        id: position.id,
        asset: position.asset,
        direction: position.direction,
        notional: position.notional,
        entry: position.entry,
        stop: position.stop,
        leverage: position.leverage,
        margin: position.margin,
        riskAmount: position.riskToStop,
        unrealizedPnl: position.unrealizedPnl
      },
      strategy: state.request.strategy
    });
    renderPositionEvaluation();
    // Progressive enhancement: the evaluation is already on screen and usable
    // whether or not the browser can scroll to it.
    const target = $('positionEvalWrap');
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

function bindChart() {
  $('equityChart')?.addEventListener('click', (event) => {
    const marker = event.target.closest('[data-transition-id]');
    if (!marker) return;
    const id = marker.getAttribute('data-transition-id');
    state.selectedTransitionId = state.selectedTransitionId === id ? null : id;
    renderChart();
  });

  // Keyboard parity: a marker is focusable, so Enter/Space must open it too.
  $('equityChart')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const marker = event.target.closest('[data-transition-id]');
    if (!marker) return;
    event.preventDefault();
    state.selectedTransitionId = marker.getAttribute('data-transition-id');
    renderChart();
  });

  $('transitionDetail')?.addEventListener('click', (event) => {
    if (event.target.id === 'closeTransition') {
      state.selectedTransitionId = null;
      renderChart();
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    const host = $('equityChart');
    if (host) {
      let lastWidth = host.clientWidth;
      new ResizeObserver(() => {
        if (Math.abs(host.clientWidth - lastWidth) < 12) return;
        lastWidth = host.clientWidth;
        if (state.evaluation) renderChart();
      }).observe(host);
    }
  }
}

function bindHistory() {
  $('historyBody')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-trade-id]');
    if (row) openTradeSheet(row.getAttribute('data-trade-id'));
  });

  $('historyBody')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-trade-id]');
    if (!row) return;
    event.preventDefault();
    openTradeSheet(row.getAttribute('data-trade-id'));
  });
}

function bindSheet() {
  const sheet = $('tradeSheet');
  if (!sheet) return;

  sheet.addEventListener('click', (event) => {
    const target = event.target;

    if (target.id === 'sheetClose' || target.id === 'sheetCancel' || target.hasAttribute('data-sheet-dismiss')) {
      closeTradeSheet();
      return;
    }

    if (target.id === 'sheetSave') {
      const overrides = collectSheetOverrides();
      persist(() => upsertTradeRecord({ id: state.openTradeId, source: 'ONCHAIN', overrides }));
      // Re-merge from the untouched reconstruction, so a correction that
      // contradicts the chain shows up as a conflict rather than as agreement.
      state.history.trades = mergeTradeRecords(state.history.onchain);
      closeTradeSheet();
      refresh();
      return;
    }

    const flowAction = target.getAttribute('data-sheet-flow');
    if (flowAction) {
      const amount = Number($('sheetFlowAmount')?.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        notice('A confirmed transfer needs a USD amount. Nothing is inferred from the token movement alone.');
        return;
      }
      persist(() => {
        addManualCashFlow({ type: flowAction, amount });
        upsertTradeRecord({ id: state.openTradeId, overrides: { status: 'CANCELLED' } });
        return true;
      });
      closeTradeSheet();
      refresh();
    }
  });

  sheet.addEventListener('change', async (event) => {
    if (event.target.id !== 'sheetScreenshot') return;
    const file = event.target.files?.[0];
    if (!file) return;
    await handleScreenshot(file, state.openTradeId);
  });
}

/**
 * Screenshot upload. Reuses the EXISTING /api/parse-trade-image endpoint —
 * there is deliberately no second parser here.
 *
 * What comes back is stored as parsed metadata and shown for the user to
 * accept into the record. It never overwrites an on-chain value on its own.
 */
async function handleScreenshot(file, tradeId) {
  const result = $('sheetScreenshotResult');
  if (file.size > MAX_SCREENSHOT_BYTES) {
    if (result) result.textContent = 'That image is too large to send. Try a smaller screenshot.';
    return;
  }
  if (result) result.textContent = 'Reading screenshot…';

  try {
    const imageData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.readAsDataURL(file);
    });

    const response = await fetch('/api/parse-trade-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData })
    });
    const body = await response.json();

    if (!response.ok || !body.success) {
      persist(() => saveScreenshotMeta({ tradeId, filename: file.name, byteSize: file.size, error: body.message || 'parse failed' }));
      if (result) result.textContent = `Could not read that screenshot: ${body.message || 'unknown error'}`;
      return;
    }

    const parsed = body.data || {};
    persist(() => saveScreenshotMeta({ tradeId, filename: file.name, byteSize: file.size, parsed }));

    if (result) {
      result.innerHTML = `Read: <strong>${esc(parsed.symbol || '—')} ${esc(parsed.direction || '')}</strong>, entry ${esc(parsed.entry ?? '—')}, stop ${esc(parsed.stopLoss ?? '—')}. These are a claim about the trade — on-chain values still outrank them. Fill them into the fields above if they are right.`;
    }
  } catch (error) {
    if (result) result.textContent = `Screenshot upload failed: ${error.message}`;
  }
}

function bindFlows() {
  $('flowReview')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-flow-action]');
    if (!button) return;
    const row = button.closest('[data-flow-id]');
    const id = row?.getAttribute('data-flow-id');
    const action = button.getAttribute('data-flow-action');
    const amountInput = row?.querySelector('.rm-flow-amount');
    const amount = Number(amountInput?.value);

    try {
      if (action !== 'NOT_A_TRANSFER' && (!Number.isFinite(amount) || amount <= 0)) {
        notice('Confirming a transfer needs its USD value. The reconstruction reports token movements, not dollars, and guessing one would corrupt the performance curve.');
        return;
      }
      persist(() => classifyCashFlow(id, action, amount));
      clearNotice();
      refresh();
    } catch (error) {
      notice(error.message);
    }
  });

  $('addFlow')?.addEventListener('click', () => {
    const type = $('manualFlowType')?.value;
    const amount = Number($('manualFlowAmount')?.value);
    try {
      persist(() => addManualCashFlow({ type, amount }));
      const input = $('manualFlowAmount');
      if (input) input.value = '';
      clearNotice();
      refresh();
    } catch (error) {
      notice(error.message);
    }
  });
}

function bindProposals() {
  $('proposalList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-proposal-action]');
    if (!button) return;
    const id = button.closest('[data-proposal-id]')?.getAttribute('data-proposal-id');
    const proposal = state.proposals.find((p) => p.id === id);
    if (!proposal) return;
    persist(() => recordStrategyDecision(button.getAttribute('data-proposal-action'), proposal, STRATEGY_VERSION));
    renderProposals();
  });
}

/* ========================================================================
 * INIT
 * ===================================================================== */

export function initRiskPage() {
  const prefs = loadUiPrefs();
  if (prefs.strategy && STRATEGY_PRESETS[prefs.strategy]) state.request.strategy = prefs.strategy;
  if (Number.isFinite(prefs.confidence)) state.request.confidence = prefs.confidence;
  if (typeof prefs.lastAsset === 'string') state.request.asset = prefs.lastAsset;

  const assetInput = $('reqAsset');
  if (assetInput) assetInput.value = state.request.asset;
  const slider = $('reqConfidence');
  if (slider) slider.value = String(state.request.confidence);
  setText('confidenceValue', String(state.request.confidence));
  document.querySelectorAll('[data-strategy]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-strategy') === state.request.strategy));
  });
  updateConfidenceBounds();

  bindWallet();
  bindRecommender();
  bindSimulation();
  bindPositions();
  bindChart();
  bindHistory();
  bindSheet();
  bindFlows();
  bindProposals();

  // Layer 1 paints synchronously; 2 and 4 chain after it without blocking it.
  loadCachedLayer();
  if (state.address) {
    loadWalletLayer().then(loadHistoryLayer);
  }
}

export default { initRiskPage };
