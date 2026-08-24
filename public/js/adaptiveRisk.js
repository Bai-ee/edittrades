/**
 * EditTrades Adaptive Risk Engine
 * -------------------------------
 * An ADAPTIVE layer built ON TOP of the deterministic risk manager
 * (`./riskManager.js`). It does not replace it and it does not re-derive its
 * arithmetic: stop distance, position size, margin, liquidation, portfolio
 * risk, exposure and directional concentration all come from that module.
 *
 * What this layer adds is the answer to a different question:
 *
 *   riskManager.js  "I want to risk 1%. How big is the position?"
 *   adaptiveRisk.js "Given what this account has actually done, HOW MUCH
 *                    should it be risking right now — and should it be
 *                    trading at all?"
 *
 * ==========================================================================
 * NON-NEGOTIABLES
 * ==========================================================================
 *  - PURE. No network, no clock, no randomness, no AI. `now` is always a
 *    parameter. Same inputs produce the same output, forever.
 *  - DECISION SUPPORT. Nothing here places, modifies or closes a trade.
 *  - NOT A PREDICTION. Every output is a statement about risk capacity, never
 *    about where price is going.
 *  - SLOW UP, FAST DOWN. Earning risk capacity takes many trades. Losing it
 *    takes one bad drawdown.
 *
 * ==========================================================================
 * UNITS
 * ==========================================================================
 * Percentages are PERCENT NUMBERS (1 = 1%), matching riskManager.js. Fractions
 * appear only inside a calculation and are converted once at the boundary.
 * "R" is a multiple of the risk taken on that trade: R = realisedPnl /
 * riskAmount. +1R means the trade made exactly what it risked.
 *
 * ==========================================================================
 * THE DECISION HIERARCHY (hard constraints win)
 * ==========================================================================
 *   1. LEVEL              what the account has earned            (slow)
 *   2. STRATEGY           which preset the user selected
 *   3. CONFIDENCE         the slider, INSIDE the envelope only
 *   4. WALLET PERFORMANCE recent results and drawdown, one-way DOWN
 *   5. OPEN RISK          heat, exposure, concentration, margin
 *   6. NO-TRADE GATE      evaluated last, overrides everything above
 *
 * Confidence can never raise risk above the envelope, never raise leverage
 * above the cap, and never clear a NO_TRADE.
 */

import {
  DEFAULT_RISK_POLICY,
  calculateStopDistance,
  calculatePositionSize,
  calculateRequiredMargin,
  estimateLiquidation,
  calculatePortfolioRisk,
  calculateExposure,
  detectCorrelatedExposure
} from './riskManager.js';

export const STRATEGY_VERSION = '1.0.0';

/* ========================================================================
 * TUNABLE CONSTANTS
 *
 * Every number here is documented in docs/ADAPTIVE_RISK_ENGINE.md with its
 * rationale. They are deliberately gathered in one block so a reviewer can
 * audit the whole ruleset without reading the algorithms.
 * ===================================================================== */

export const ADAPTIVE_CONSTANTS = {
  /** Trades in the "recent performance" window. Strategy-level, not per-trade. */
  RECENT_WINDOW: 10,

  /**
   * Below this many closed trades in the window, recent performance is not a
   * measurement — it is noise. Callers must treat it as NEUTRAL, never as
   * positive. 5 is the smallest sample where a win rate carries any signal at
   * all, and it is still far too small to be trusted upward.
   */
  MIN_SAMPLE_FOR_PERFORMANCE: 5,

  /**
   * Upside winsorisation cap for progression, in R.
   *
   * A single +50R trade is luck, size, or a gap — not evidence of skill. Every
   * per-trade R is capped at +2R BEFORE it contributes to level progress, so
   * no one trade can carry an account up a level. The DOWNSIDE is deliberately
   * NOT winsorised: bad outcomes count in full.
   */
  WINSOR_R_CAP: 2,

  /**
   * The "normal band" for the consistency metric, in R.
   *
   * A trade is CONSISTENT when its result lands in [-1R, +2R]:
   *   - not worse than -1R  ->  the stop was respected
   *   - not better than +2R ->  the result did not depend on an outlier
   * consistency = share of the window inside that band, as a percent.
   */
  CONSISTENCY_BAND_LOW_R: -1,
  CONSISTENCY_BAND_HIGH_R: 2,

  /** Level bounds. */
  MIN_LEVEL: -2,
  MAX_LEVEL: 5,

  /**
   * Closed trades required BEFORE any level above 0 is reachable. A brand new
   * account is level 0 and cannot be anything higher, whatever it has done.
   */
  MIN_TRADES_FOR_POSITIVE_LEVEL: 5,

  /** Additional closed trades required since the last level change, keyed by the level being entered. */
  LEVEL_UP_TRADES: { '-1': 5, '0': 5, '1': 8, '2': 10, '3': 12, '4': 15, '5': 20 },

  /** Current drawdown must be below this to advance INTO the keyed level. Tightens as levels rise. */
  LEVEL_UP_MAX_DRAWDOWN_PCT: { '-1': 25, '0': 18, '1': 10, '2': 9, '3': 8, '4': 7, '5': 6 },

  /** Floors that must be cleared to advance at all. */
  LEVEL_UP_MIN_WIN_RATE_PCT: 40,
  LEVEL_UP_MIN_CONSISTENCY_PCT: 70,
  LEVEL_UP_MIN_AVG_R: 0.10,

  /**
   * Drawdown ceilings on the level. FAST DOWN: these are hard caps applied in
   * a single evaluation, so a level-5 account at 20% drawdown lands on -1
   * immediately. There is no grace period.
   */
  DRAWDOWN_LEVEL_CEILINGS: [
    { drawdownPct: 25, ceiling: -2 },
    { drawdownPct: 20, ceiling: -1 },
    { drawdownPct: 16, ceiling: 0 },
    { drawdownPct: 12, ceiling: 1 },
    { drawdownPct: 8, ceiling: 3 }
  ],

  /** Losing-streak demotions. Applied on top of the drawdown ceiling. */
  STREAK_DEMOTION: [
    { streak: -5, drop: 2 },
    { streak: -3, drop: 1 }
  ],

  /**
   * Open-risk pressure demotion, in percent of adjusted equity. Strategy
   * neutral on purpose: the level describes the trader, not the preset chosen
   * for one trade.
   */
  OPEN_RISK_PRESSURE_PCT: 10,
  UNREALIZED_LOSS_PRESSURE_PCT: 8,

  /** Progress weighting. Sums to 1. */
  PROGRESS_WEIGHT_TRADES: 0.5,
  PROGRESS_WEIGHT_PERFORMANCE: 0.3,
  PROGRESS_WEIGHT_CONSISTENCY: 0.2,
  /** Winsorised average R that scores full marks on the performance component. */
  PROGRESS_TARGET_AVG_R: 0.30,

  /** No closed trade in this many days makes the recent window stale. */
  INACTIVITY_DAYS: 45,
  /** Trades after a return from inactivity that still carry the haircut. */
  RETURN_TRADES: 3,
  /** The haircut itself, applied to the risk-percent band only. */
  RETURN_HAIRCUT: 0.75,

  /**
   * A position's consumed risk never falls below this share of its notional,
   * even with the stop beyond breakeven. Open positions consume capacity until
   * they are CLOSED: a locked-in stop still has gap risk, venue risk and the
   * simple fact that the capital is committed. 0.5% of notional matches the
   * maintenance-margin order of magnitude used by riskManager.js.
   */
  CLOSURE_RESERVE: 0.005,

  /**
   * Unrealised GAINS are discounted to 25% for account health and level
   * progression, and fund NO new risk at all. Unrealised LOSSES count at 100%
   * immediately. Asymmetric on purpose: a gain is a quote, a loss is a fact.
   */
  UNREALIZED_GAIN_CREDIT: 0.25,

  /** Drawdown at or above this blocks new trades outright, at every level. */
  DEFENSIVE_NO_TRADE_DRAWDOWN_PCT: 25,
  /** At level -2, this drawdown blocks new trades entirely rather than shrinking them. */
  LOCKDOWN_DRAWDOWN_PCT: 20,

  /** Recommended risk below this is not worth executing; treated as no budget. */
  MIN_VIABLE_RISK_PCT: 0.05,

  /** Open profit, in R, at which PROTECT_PROFIT is offered. */
  PROTECT_PROFIT_TRIGGER_R: 1.0,
  /** Open profit, in R, at which the rule locks half the open gain instead of breakeven. */
  PROTECT_PROFIT_LOCK_HALF_R: 2.0,
  /** Open loss, in R, at which evaluatePosition returns EXIT. */
  EXIT_LOSS_R: 1.5,
  /** Open profit, in R, required before ADD is even considered. */
  ADD_MIN_OPEN_R: 1.0,
  /** ADD is capped at this share of the existing notional. */
  ADD_MAX_SHARE_OF_NOTIONAL: 0.5,

  /** analyzeStrategyPerformance will not propose anything below this sample size. */
  MIN_SAMPLE_FOR_PROPOSAL: 20,
  /** Sample size required before an UPWARD proposal is allowed. */
  MIN_SAMPLE_FOR_UPWARD_PROPOSAL: 30,
  /** Expectancy in R that makes a group materially bad / materially good. */
  PROPOSAL_BAD_EXPECTANCY_R: -0.15,
  PROPOSAL_GOOD_EXPECTANCY_R: 0.35,

  /** Relative change below which a factor is not worth reporting. */
  FACTOR_MATERIALITY: 0.02
};

const C = ADAPTIVE_CONSTANTS;
const MS_PER_DAY = 86400000;

/* ========================================================================
 * LEVELS
 * ===================================================================== */

/**
 * The -2..5 ladder. Level 0 is the starting, unproven baseline and is anchored
 * to DEFAULT_RISK_POLICY so the adaptive engine and the base engine agree on
 * day one. Everything above 0 is EARNED; everything below 0 is DEFENSIVE.
 */
export const LEVELS = [
  {
    level: -2,
    key: 'LOCKDOWN',
    label: 'Lockdown',
    posture: 'DEFENSIVE',
    description:
      'Severe drawdown. Minimal envelope, one position, no leverage. Beyond a drawdown threshold, new trades are blocked outright.'
  },
  {
    level: -1,
    key: 'DEFENSIVE',
    label: 'Defensive',
    posture: 'DEFENSIVE',
    description:
      'Meaningful drawdown or a losing run. Risk percentage and leverage cap are cut hard so recovery is not attempted with size.'
  },
  {
    level: 0,
    key: 'BASELINE',
    label: 'Baseline',
    posture: 'BASELINE',
    description:
      'Starting, unproven state. Anchored to the default risk policy: 1% base, 2% ceiling, 6% heat, 3x leverage. Every new account starts here.'
  },
  {
    level: 1,
    key: 'ESTABLISHED',
    label: 'Established',
    posture: 'EARNED',
    description: 'A first proven run: enough closed trades, positive adjusted growth, shallow drawdown.'
  },
  {
    level: 2,
    key: 'CONSISTENT',
    label: 'Consistent',
    posture: 'EARNED',
    description: 'Results hold up across a second window with the drawdown ceiling tightened.'
  },
  {
    level: 3,
    key: 'PROVEN',
    label: 'Proven',
    posture: 'EARNED',
    description: 'A long enough record that the sample carries some weight. Drawdown tolerance narrows again.'
  },
  {
    level: 4,
    key: 'SEASONED',
    label: 'Seasoned',
    posture: 'EARNED',
    description: 'Sustained discipline over many trades with a tight drawdown ceiling.'
  },
  {
    level: 5,
    key: 'MAXIMUM',
    label: 'Maximum',
    posture: 'EARNED',
    description:
      'The cap. The risk PERCENTAGE envelope stops expanding here — dollar sizes keep growing with the wallet, the percentage does not.'
  }
];

const LEVEL_INDEX = new Map(LEVELS.map((d) => [d.level, d]));

/** Definition for a level number, or null. */
export function getLevelDefinition(level) {
  return LEVEL_INDEX.get(clampLevel(level)) || null;
}

/* ========================================================================
 * HELPERS
 * ===================================================================== */

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFraction(percent) {
  return percent / 100;
}

function toPercent(fraction) {
  return fraction * 100;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function clampLevel(level) {
  const n = Number.isFinite(level) ? Math.round(level) : 0;
  return clamp(n, C.MIN_LEVEL, C.MAX_LEVEL);
}

function normalizeDirection(direction) {
  if (typeof direction !== 'string') return null;
  const upper = direction.trim().toUpperCase();
  if (upper === 'LONG' || upper === 'BUY') return 'LONG';
  if (upper === 'SHORT' || upper === 'SELL') return 'SHORT';
  return null;
}

/** Timestamps accept ISO strings, epoch millis, or Date. Never reads the clock. */
function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Winsorise a trade's R for progression. Upside capped, downside untouched. */
function winsoriseR(r) {
  if (!Number.isFinite(r)) return 0;
  return Math.min(r, C.WINSOR_R_CAP);
}

/** Canonical JSON — keys sorted recursively — so hashing is stable. */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(round(value, 8)) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return 'null';
}

/** FNV-1a 32-bit. Not cryptographic — an audit fingerprint, nothing more. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function hashInputs(payload) {
  return `ar${STRATEGY_VERSION.split('.')[0]}-${fnv1a(canonical(payload))}`;
}

/**
 * R for a trade record. Prefers an explicitly supplied rMultiple, otherwise
 * realisedPnl / riskAmount. A trade with no usable risk figure contributes 0R
 * and is flagged, rather than being silently dropped or guessed at.
 */
function tradeR(trade) {
  if (!trade || typeof trade !== 'object') return { r: 0, usable: false };
  if (isFiniteNumber(trade.rMultiple)) return { r: trade.rMultiple, usable: true };
  const risk = isPositiveNumber(trade.riskAmount)
    ? trade.riskAmount
    : isPositiveNumber(trade.plannedRisk)
      ? trade.plannedRisk
      : null;
  const pnl = isFiniteNumber(trade.realizedPnl)
    ? trade.realizedPnl
    : isFiniteNumber(trade.actualPnl)
      ? trade.actualPnl
      : null;
  if (risk === null || pnl === null) return { r: 0, usable: false };
  return { r: pnl / risk, usable: true };
}

function isClosed(trade) {
  return trade && typeof trade === 'object' && String(trade.status || '').toUpperCase() === 'CLOSED';
}

/** Closed trades, ascending by close time. Trades with no close time keep their input order, last. */
function closedTradesAscending(trades = []) {
  const list = (Array.isArray(trades) ? trades : []).filter(isClosed);
  return list
    .map((trade, index) => ({ trade, index, at: toTime(trade.closedAt ?? trade.updatedAt ?? trade.at) }))
    .sort((a, b) => {
      const aAt = a.at === null ? Number.POSITIVE_INFINITY : a.at;
      const bAt = b.at === null ? Number.POSITIVE_INFINITY : b.at;
      if (aAt !== bAt) return aAt - bAt;
      return a.index - b.index;
    })
    .map((entry) => entry.trade);
}

/* ========================================================================
 * STRATEGY PRESETS
 *
 * Two presets, each carrying a full per-level envelope table. Every number is
 * derived from a stated rule rather than picked, so the whole table can be
 * audited from four anchors:
 *
 *  1. STANDARD level 0 IS DEFAULT_RISK_POLICY. 1% base / 2% max / 6% heat /
 *     4% directional / 200% notional / 30% margin / 3x leverage. This is the
 *     contract between the two engines: at level 0 on STANDARD they agree.
 *
 *  2. Earned levels widen the percentage envelope by 10% of the level-0 value
 *     per level: level n>=0 multiplies by (1 + 0.10n). Level 5 therefore sits
 *     at 1.5x the baseline and STOPS. Dollar sizes keep growing with the
 *     wallet; the percentage does not.
 *
 *  3. Defensive levels are cut hard, not scaled. -1 is roughly a third of
 *     baseline, -2 roughly a seventh, because a defensive level exists to make
 *     recovery-by-size impossible rather than merely discouraged.
 *
 *  4. AGGRESSIVE is 1.5x STANDARD on the percentage envelope, with two hard
 *     clamps: portfolio heat never exceeds 12% (the upper end of the honest
 *     6-12% range in the literature, the Turtle ~12-unit ceiling) and margin
 *     utilisation never exceeds 90%.
 *
 * Leverage does NOT follow the 1.5x rule. It is set explicitly per level
 * against the liquidation-distance argument in riskManager.js: at 3x the
 * estimated liquidation sits ~33% away, at 5x ~19.5%, at 6x ~16%. AGGRESSIVE
 * deliberately exceeds the 3x ESMA/FSA-anchored cap; that is the substance of
 * choosing it, and it is stated rather than hidden.
 * ===================================================================== */

const STANDARD_L0 = {
  minRiskPct: 0.50,
  baseRiskPct: 1.00,
  maxRiskPct: 2.00,
  maxLeverage: 3.0,
  maxPortfolioHeatPct: 6.00,
  maxNotionalExposurePct: 200,
  maxDirectionalRiskPct: 4.00,
  maxMarginUtilizationPct: 30,
  maxOpenPositions: 4
};

/** Explicit tables. Written out in full so a reviewer never has to run code to read them. */
const STANDARD_LEVELS = {
  '-2': { minRiskPct: 0.10, baseRiskPct: 0.15, maxRiskPct: 0.25, maxLeverage: 1.0, maxPortfolioHeatPct: 0.50, maxNotionalExposurePct: 25, maxDirectionalRiskPct: 0.50, maxMarginUtilizationPct: 10, maxOpenPositions: 1 },
  '-1': { minRiskPct: 0.20, baseRiskPct: 0.35, maxRiskPct: 0.50, maxLeverage: 1.5, maxPortfolioHeatPct: 1.50, maxNotionalExposurePct: 50, maxDirectionalRiskPct: 1.00, maxMarginUtilizationPct: 15, maxOpenPositions: 2 },
  '0':  { minRiskPct: 0.50, baseRiskPct: 1.00, maxRiskPct: 2.00, maxLeverage: 3.0, maxPortfolioHeatPct: 6.00, maxNotionalExposurePct: 200, maxDirectionalRiskPct: 4.00, maxMarginUtilizationPct: 30, maxOpenPositions: 4 },
  '1':  { minRiskPct: 0.55, baseRiskPct: 1.10, maxRiskPct: 2.20, maxLeverage: 3.0, maxPortfolioHeatPct: 6.60, maxNotionalExposurePct: 220, maxDirectionalRiskPct: 4.40, maxMarginUtilizationPct: 33, maxOpenPositions: 5 },
  '2':  { minRiskPct: 0.60, baseRiskPct: 1.20, maxRiskPct: 2.40, maxLeverage: 3.5, maxPortfolioHeatPct: 7.20, maxNotionalExposurePct: 240, maxDirectionalRiskPct: 4.80, maxMarginUtilizationPct: 36, maxOpenPositions: 5 },
  '3':  { minRiskPct: 0.65, baseRiskPct: 1.30, maxRiskPct: 2.60, maxLeverage: 3.5, maxPortfolioHeatPct: 7.80, maxNotionalExposurePct: 260, maxDirectionalRiskPct: 5.20, maxMarginUtilizationPct: 39, maxOpenPositions: 6 },
  '4':  { minRiskPct: 0.70, baseRiskPct: 1.40, maxRiskPct: 2.80, maxLeverage: 4.0, maxPortfolioHeatPct: 8.40, maxNotionalExposurePct: 280, maxDirectionalRiskPct: 5.60, maxMarginUtilizationPct: 42, maxOpenPositions: 6 },
  '5':  { minRiskPct: 0.75, baseRiskPct: 1.50, maxRiskPct: 3.00, maxLeverage: 4.0, maxPortfolioHeatPct: 9.00, maxNotionalExposurePct: 300, maxDirectionalRiskPct: 6.00, maxMarginUtilizationPct: 45, maxOpenPositions: 6 }
};

const AGGRESSIVE_LEVELS = {
  '-2': { minRiskPct: 0.15, baseRiskPct: 0.25, maxRiskPct: 0.40, maxLeverage: 1.0, maxPortfolioHeatPct: 0.80, maxNotionalExposurePct: 40, maxDirectionalRiskPct: 0.80, maxMarginUtilizationPct: 15, maxOpenPositions: 1 },
  '-1': { minRiskPct: 0.30, baseRiskPct: 0.60, maxRiskPct: 0.90, maxLeverage: 2.0, maxPortfolioHeatPct: 2.40, maxNotionalExposurePct: 80, maxDirectionalRiskPct: 1.80, maxMarginUtilizationPct: 25, maxOpenPositions: 2 },
  '0':  { minRiskPct: 0.75, baseRiskPct: 1.50, maxRiskPct: 3.00, maxLeverage: 5.0, maxPortfolioHeatPct: 9.00, maxNotionalExposurePct: 300, maxDirectionalRiskPct: 6.00, maxMarginUtilizationPct: 45, maxOpenPositions: 5 },
  '1':  { minRiskPct: 0.83, baseRiskPct: 1.65, maxRiskPct: 3.30, maxLeverage: 5.0, maxPortfolioHeatPct: 9.90, maxNotionalExposurePct: 330, maxDirectionalRiskPct: 6.60, maxMarginUtilizationPct: 50, maxOpenPositions: 6 },
  '2':  { minRiskPct: 0.90, baseRiskPct: 1.80, maxRiskPct: 3.60, maxLeverage: 5.5, maxPortfolioHeatPct: 10.80, maxNotionalExposurePct: 360, maxDirectionalRiskPct: 7.20, maxMarginUtilizationPct: 54, maxOpenPositions: 6 },
  '3':  { minRiskPct: 0.98, baseRiskPct: 1.95, maxRiskPct: 3.90, maxLeverage: 5.5, maxPortfolioHeatPct: 11.70, maxNotionalExposurePct: 390, maxDirectionalRiskPct: 7.80, maxMarginUtilizationPct: 59, maxOpenPositions: 7 },
  '4':  { minRiskPct: 1.05, baseRiskPct: 2.10, maxRiskPct: 4.20, maxLeverage: 6.0, maxPortfolioHeatPct: 12.00, maxNotionalExposurePct: 420, maxDirectionalRiskPct: 8.40, maxMarginUtilizationPct: 63, maxOpenPositions: 7 },
  '5':  { minRiskPct: 1.13, baseRiskPct: 2.25, maxRiskPct: 4.50, maxLeverage: 6.0, maxPortfolioHeatPct: 12.00, maxNotionalExposurePct: 450, maxDirectionalRiskPct: 9.00, maxMarginUtilizationPct: 68, maxOpenPositions: 8 }
};

export const STRATEGY_PRESETS = {
  STANDARD: {
    key: 'STANDARD',
    label: 'Standard',
    description:
      'Anchored to the default risk policy. Reacts to a bad run at full strength and keeps the top of the risk band out of reach of the slider.',
    ...STANDARD_L0,

    /**
     * Multiplier on the DOWNWARD performance haircut. 1.0 = full strength.
     * Recent performance in this engine is a ONE-WAY DOWNWARD adjustment: a
     * good run never increases risk, it only earns levels. So a higher
     * sensitivity means a more conservative reaction, which is what STANDARD
     * is for.
     */
    recentPerformanceSensitivity: 1.0,

    /**
     * The usable slider range. STANDARD stops at 90, so the top decile of the
     * envelope is unreachable by confidence alone — the 2% ceiling at level 0
     * stays a CEILING (max attainable 1.8%) instead of becoming a routine
     * setting. `neutral` is the slider value that maps exactly to baseRiskPct.
     */
    confidenceRange: { min: 0, max: 90, neutral: 50 },

    recentPerformanceWindow: 10,

    /**
     * Stop distance assumed when the user supplies no technical stop.
     * 5% is roughly one daily sigma for a major and well inside a normal
     * 4H structure move. Clamped to [2%, 12%] after level and confidence
     * adjustment.
     */
    derivedStop: { basePct: 5.0, minPct: 2.0, maxPct: 12.0 },

    levels: STANDARD_LEVELS
  },

  AGGRESSIVE: {
    key: 'AGGRESSIVE',
    label: 'Aggressive',
    description:
      'Permits more variance: 1.5x the STANDARD percentage envelope, higher leverage, the full slider range, and a softer reaction to a bad run. Exceeds the ESMA/FSA-anchored 3x leverage cap by choice.',
    minRiskPct: AGGRESSIVE_LEVELS['0'].minRiskPct,
    baseRiskPct: AGGRESSIVE_LEVELS['0'].baseRiskPct,
    maxRiskPct: AGGRESSIVE_LEVELS['0'].maxRiskPct,
    maxLeverage: AGGRESSIVE_LEVELS['0'].maxLeverage,
    maxPortfolioHeatPct: AGGRESSIVE_LEVELS['0'].maxPortfolioHeatPct,
    maxNotionalExposurePct: AGGRESSIVE_LEVELS['0'].maxNotionalExposurePct,
    maxDirectionalRiskPct: AGGRESSIVE_LEVELS['0'].maxDirectionalRiskPct,
    maxMarginUtilizationPct: AGGRESSIVE_LEVELS['0'].maxMarginUtilizationPct,
    maxOpenPositions: AGGRESSIVE_LEVELS['0'].maxOpenPositions,

    /** 0.6 = tolerates a bad run without cutting as hard. Never below zero. */
    recentPerformanceSensitivity: 0.6,

    confidenceRange: { min: 0, max: 100, neutral: 50 },

    recentPerformanceWindow: 10,

    /** Wider default assumption: aggressive setups are expected to breathe more. */
    derivedStop: { basePct: 7.0, minPct: 2.5, maxPct: 15.0 },

    levels: AGGRESSIVE_LEVELS
  }
};

function resolvePreset(strategy) {
  const key = typeof strategy === 'string' ? strategy.trim().toUpperCase() : '';
  return STRATEGY_PRESETS[key] || STRATEGY_PRESETS.STANDARD;
}

/* ========================================================================
 * ADJUSTED EQUITY AND THE PERFORMANCE CURVE
 * ===================================================================== */

/**
 * The capital base.
 *
 * adjustedEquity IS walletValue. The wallet's marked value is the capital the
 * account can actually risk, and no cash-flow adjustment changes that: a
 * $10,000 deposit gives you $10,000 more to risk the moment it lands.
 *
 * Cash flows are still summarised here, because they matter for the SEPARATE
 * question of how the account has PERFORMED (see buildEquityCurve). The two
 * must never be conflated: adjusting the capital base for deposits would size
 * trades against money that is not there.
 */
export function calculateAdjustedEquity({ walletValue, cashFlows = [] } = {}) {
  const flows = Array.isArray(cashFlows) ? cashFlows : [];

  let deposits = 0;
  let withdrawals = 0;
  let classified = 0;

  for (const flow of flows) {
    if (!flow || !isPositiveNumber(Math.abs(Number(flow.amount)))) continue;
    const type = String(flow.type || '').toUpperCase();
    const amount = Math.abs(Number(flow.amount));
    if (type === 'DEPOSIT') {
      deposits += amount;
      classified++;
    } else if (type === 'WITHDRAWAL') {
      withdrawals += amount;
      classified++;
    }
  }

  const valid = isPositiveNumber(walletValue);

  return {
    valid,
    // The capital base. Not adjusted, deliberately.
    adjustedEquity: valid ? walletValue : 0,
    walletValue: valid ? walletValue : null,
    deposits,
    withdrawals,
    netContributed: deposits - withdrawals,
    classifiedFlows: classified,
    totalFlows: flows.length,
    note: 'Adjusted equity equals wallet value. Cash flows are removed from the PERFORMANCE curve, never from the capital base.'
  };
}

/**
 * The performance curve, with every classified cash flow removed.
 *
 * A deposit or withdrawal at time T shifts the BASELINE, not performance.
 * Between two snapshots:
 *
 *   growth = (v1 - v0 - netFlowsInInterval) / v0
 *
 * and those growths chain multiplicatively into an index starting at 1.0. A
 * $10,000 wallet that receives a $10,000 deposit and ends at $20,000 has an
 * index of exactly 1.0 — no profit, no loss. This is the single property the
 * whole level system rests on, and it is tested explicitly.
 *
 * A flow is attributed to the interval (s0, s1] — strictly after the earlier
 * snapshot, up to and including the later one. Flows before the first snapshot
 * or after the last are outside the measured window and are reported but not
 * applied.
 *
 * UNCLASSIFIED wallet-value change counts as PERFORMANCE. That is the default
 * rule from the brief: if the user has not told us a movement was a transfer,
 * we do not invent one. The cost is that an unrecorded deposit reads as a win;
 * the alternative — guessing that large jumps are transfers — would silently
 * erase real profits, which is worse.
 */
export function buildEquityCurve({ snapshots = [], cashFlows = [] } = {}) {
  const raw = (Array.isArray(snapshots) ? snapshots : [])
    .map((s, index) => ({
      at: toTime(s && (s.at ?? s.timestamp)),
      walletValue: Number(s && (s.walletValue ?? s.balance)),
      index
    }))
    .filter((s) => s.at !== null && Number.isFinite(s.walletValue))
    .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.index - b.index));

  const flows = (Array.isArray(cashFlows) ? cashFlows : [])
    .map((f) => ({
      at: toTime(f && f.at),
      type: String((f && f.type) || '').toUpperCase(),
      amount: Math.abs(Number(f && f.amount)),
      id: (f && f.id) ?? null
    }))
    .filter((f) => f.at !== null && Number.isFinite(f.amount) && f.amount > 0 && (f.type === 'DEPOSIT' || f.type === 'WITHDRAWAL'))
    .sort((a, b) => a.at - b.at);

  if (raw.length === 0) {
    return {
      valid: false,
      reason: 'No usable snapshots',
      points: [],
      index: 1,
      totalGrowthPct: 0,
      flowsApplied: 0,
      flowsOutsideWindow: flows.length,
      netFlowApplied: 0
    };
  }

  const points = [
    {
      at: raw[0].at,
      walletValue: raw[0].walletValue,
      index: 1,
      growth: 0,
      growthPct: 0,
      netFlow: 0
    }
  ];

  let index = 1;
  let flowsApplied = 0;
  let netFlowApplied = 0;

  for (let i = 1; i < raw.length; i++) {
    const previous = raw[i - 1];
    const current = raw[i];

    // Flows in (previous.at, current.at]. Deposits add to the baseline,
    // withdrawals subtract from it.
    let netFlow = 0;
    for (const flow of flows) {
      if (flow.at > previous.at && flow.at <= current.at) {
        netFlow += flow.type === 'DEPOSIT' ? flow.amount : -flow.amount;
        flowsApplied++;
      }
    }
    netFlowApplied += netFlow;

    const v0 = previous.walletValue;
    // A non-positive starting value has no meaningful growth rate.
    const growth = v0 > 0 ? (current.walletValue - v0 - netFlow) / v0 : 0;

    // The index is a ratio and must stay positive; a -100% interval would
    // annihilate it and make every later ratio meaningless.
    index = Math.max(index * (1 + growth), 1e-9);

    points.push({
      at: current.at,
      walletValue: current.walletValue,
      index,
      growth,
      growthPct: toPercent(growth),
      netFlow
    });
  }

  return {
    valid: true,
    points,
    index,
    totalGrowthPct: toPercent(index - 1),
    flowsApplied,
    flowsOutsideWindow: flows.length - flowsApplied,
    netFlowApplied,
    firstAt: points[0].at,
    lastAt: points[points.length - 1].at,
    note: 'Growth is measured after removing classified cash flows. Deposits and withdrawals can never register as profit or loss.'
  };
}

/**
 * Peak-to-current drawdown on the ADJUSTED index — never on raw wallet value,
 * or a withdrawal would read as a drawdown.
 */
export function calculateDrawdown({ equityCurve } = {}) {
  const points = equityCurve && Array.isArray(equityCurve.points) ? equityCurve.points : [];

  if (points.length === 0) {
    return {
      valid: false,
      currentDrawdownPct: 0,
      maxDrawdownPct: 0,
      currentDrawdown: 0,
      maxDrawdown: 0,
      peak: 1,
      peakAt: null,
      currentIndex: 1,
      inDrawdown: false,
      reason: 'No equity curve'
    };
  }

  let peak = points[0].index;
  let peakAt = points[0].at;
  let runningPeak = points[0].index;
  let runningPeakAt = points[0].at;
  let maxDrawdown = 0;

  for (const point of points) {
    if (point.index > runningPeak) {
      runningPeak = point.index;
      runningPeakAt = point.at;
    }
    const drawdown = runningPeak > 0 ? (runningPeak - point.index) / runningPeak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    peak = runningPeak;
    peakAt = runningPeakAt;
  }

  const currentIndex = points[points.length - 1].index;
  const currentDrawdown = peak > 0 ? Math.max(0, (peak - currentIndex) / peak) : 0;

  const currentPct = toPercent(currentDrawdown);
  const maxPct = toPercent(maxDrawdown);

  return {
    valid: true,
    currentDrawdownPct: currentPct,
    maxDrawdownPct: maxPct,
    // Aliases carrying the identical percent numbers, for callers that read
    // the shorter names. Both are PERCENT NUMBERS, not fractions.
    currentDrawdown: currentPct,
    maxDrawdown: maxPct,
    peak,
    peakAt,
    currentIndex,
    inDrawdown: currentPct > 0
  };
}

/**
 * Inactivity detection.
 *
 * Not trading is not the same as trading badly, so a gap must NEVER demote.
 * What it does do is invalidate the recent window as evidence, which stops
 * promotion and applies a conservatism haircut for the first few trades back.
 */
function detectInactivity(closed, now) {
  const gapDays = C.INACTIVITY_DAYS;
  if (closed.length === 0) {
    // No history is NOT inactivity. A brand-new account is already held at
    // level 0 and flagged INSUFFICIENT_SAMPLE; adding a returning-trader
    // haircut on top would put STANDARD level 0 out of step with
    // DEFAULT_RISK_POLICY, which is the one number the two engines must share.
    return { stale: false, returning: false, gapDays: null, lastClosedAt: null, tradesSinceReturn: 0 };
  }

  const times = closed.map((t) => toTime(t.closedAt ?? t.updatedAt ?? t.at)).filter((t) => t !== null);
  const lastClosedAt = times.length ? times[times.length - 1] : null;

  // Trades closed since the most recent inactivity gap inside the history.
  let tradesSinceReturn = closed.length;
  let gapFound = false;
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] > gapDays * MS_PER_DAY) {
      tradesSinceReturn = times.length - i;
      gapFound = true;
      break;
    }
  }

  const stale = now !== null && lastClosedAt !== null && now - lastClosedAt > gapDays * MS_PER_DAY;

  return {
    stale,
    gapFound,
    /**
     * Stale right now, or not yet enough trades since a REAL gap in the
     * history. A brand-new account with two trades has not returned from
     * anything and must not carry this haircut — it is already held at level 0.
     */
    returning: stale || (gapFound && tradesSinceReturn < C.RETURN_TRADES),
    gapDays: now !== null && lastClosedAt !== null ? (now - lastClosedAt) / MS_PER_DAY : null,
    lastClosedAt,
    tradesSinceReturn
  };
}

/**
 * The last N closed trades, in R.
 *
 * Below MIN_SAMPLE_FOR_PERFORMANCE this returns `sufficient: false` and every
 * caller must treat it as NEUTRAL — never as positive. A 3-trade winning run
 * is not evidence and must not buy size.
 */
export function calculateRecentPerformance({ trades = [], window = C.RECENT_WINDOW, now = null, includeInactivity = true } = {}) {
  const size = isPositiveNumber(window) ? Math.floor(window) : C.RECENT_WINDOW;
  const closed = closedTradesAscending(trades);
  const nowTime = toTime(now);
  const inactivity = includeInactivity ? detectInactivity(closed, nowTime) : { stale: false, returning: false, gapDays: null, lastClosedAt: null, tradesSinceReturn: closed.length };

  const windowTrades = closed.slice(-size);
  const count = windowTrades.length;

  const results = windowTrades.map((trade) => {
    const { r, usable } = tradeR(trade);
    return { trade, r, usable, winsorised: winsoriseR(r) };
  });

  const unusable = results.filter((x) => !x.usable).length;
  const wins = results.filter((x) => x.r > 0).length;
  const losses = results.filter((x) => x.r < 0).length;
  const scratches = count - wins - losses;

  const netR = results.reduce((sum, x) => sum + x.r, 0);
  const winsorisedNetR = results.reduce((sum, x) => sum + x.winsorised, 0);
  const avgR = count > 0 ? netR / count : 0;
  const winsorisedAvgR = count > 0 ? winsorisedNetR / count : 0;

  const winRate = count > 0 ? toPercent(wins / count) : 0;

  // Trailing signed streak. +3 = three wins in a row, -2 = two losses.
  let streak = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i].r;
    if (r === 0) break;
    if (streak === 0) streak = r > 0 ? 1 : -1;
    else if ((streak > 0 && r > 0) || (streak < 0 && r < 0)) streak += streak > 0 ? 1 : -1;
    else break;
  }

  // Tharp expectancy in R, computed from raw (non-winsorised) results so it
  // stays a faithful description of what actually happened.
  const winList = results.filter((x) => x.r > 0).map((x) => x.r);
  const lossList = results.filter((x) => x.r < 0).map((x) => Math.abs(x.r));
  const avgWin = winList.length ? winList.reduce((a, b) => a + b, 0) / winList.length : 0;
  const avgLoss = lossList.length ? lossList.reduce((a, b) => a + b, 0) / lossList.length : 0;
  const winFraction = count > 0 ? wins / count : 0;
  const lossFraction = count > 0 ? losses / count : 0;
  const expectancy = winFraction * avgWin - lossFraction * avgLoss;

  // Consistency: share of the window inside the normal band [-1R, +2R].
  const inBand = results.filter(
    (x) => x.r >= C.CONSISTENCY_BAND_LOW_R && x.r <= C.CONSISTENCY_BAND_HIGH_R
  ).length;
  const consistency = count > 0 ? toPercent(inBand / count) : 0;

  const sufficient = count >= C.MIN_SAMPLE_FOR_PERFORMANCE;

  return {
    count,
    window: size,
    totalClosed: closed.length,
    wins,
    losses,
    scratches,
    unusable,
    winRate,
    netR,
    // "Pct" here means R expressed in percent of 1R: +2.5R -> 250.
    netRPct: toPercent(netR),
    avgRPct: toPercent(avgR),
    avgR,
    winsorisedNetR,
    winsorisedAvgR,
    streak,
    expectancy,
    avgWinR: avgWin,
    avgLossR: avgLoss,
    consistency,
    sufficient,
    /** When false, treat every performance signal as NEUTRAL. Never as positive. */
    neutral: !sufficient,
    stale: inactivity.stale,
    returning: inactivity.returning,
    inactivity,
    note: sufficient
      ? 'Recent window is a small sample. It can reduce risk; it can never increase it.'
      : `Fewer than ${C.MIN_SAMPLE_FOR_PERFORMANCE} closed trades — treated as NEUTRAL, not as evidence.`
  };
}

/* ========================================================================
 * RISK LEVEL  (-2 .. 5)
 *
 * The centrepiece. Levels are earned on PERCENTAGE performance, drawdown,
 * trade count and consistency. No absolute dollar milestone appears anywhere,
 * so a $2,000, a $20,000 and a $200,000 wallet with proportionally identical
 * histories progress identically. That is asserted in the harness.
 * ===================================================================== */

function normalizeLevelState(previousLevelState) {
  const prev = previousLevelState && typeof previousLevelState === 'object' ? previousLevelState : {};
  return {
    level: clampLevel(Number.isFinite(prev.level) ? prev.level : 0),
    since: prev.since ?? null,
    tradesAtLevelChange: Number.isFinite(prev.tradesAtLevelChange) ? Math.max(0, Math.floor(prev.tradesAtLevelChange)) : 0,
    indexAtLevelChange: Number.isFinite(prev.indexAtLevelChange) ? prev.indexAtLevelChange : null,
    peakLevel: Number.isFinite(prev.peakLevel) ? clampLevel(prev.peakLevel) : null
  };
}

/** Highest level the current drawdown permits, or null when no tier applies. */
function drawdownCeiling(currentDrawdownPct) {
  for (const tier of C.DRAWDOWN_LEVEL_CEILINGS) {
    if (currentDrawdownPct >= tier.drawdownPct) return tier;
  }
  return null;
}

/** Level-up gates for the step above `level`. Pure; used for both the decision and the progress bar. */
function computeLevelGates({ level, tradesSinceLevelChange, totalClosed, recent, drawdown, curveGrowthOk }) {
  const nextLevel = level >= C.MAX_LEVEL ? null : level + 1;
  if (nextLevel === null) {
    return { nextLevel: null, required: 0, checks: [], met: false, atCap: true };
  }

  const key = String(nextLevel);
  const required = C.LEVEL_UP_TRADES[key] ?? 10;
  const maxDrawdown = C.LEVEL_UP_MAX_DRAWDOWN_PCT[key] ?? 10;

  const checks = [
    {
      code: 'TRADES_SINCE_LEVEL',
      label: `Closed trades since the last level change`,
      current: tradesSinceLevelChange,
      required,
      passed: tradesSinceLevelChange >= required
    },
    {
      code: 'MIN_HISTORY',
      label: 'Total closed trades',
      current: totalClosed,
      required: C.MIN_TRADES_FOR_POSITIVE_LEVEL,
      passed: totalClosed >= C.MIN_TRADES_FOR_POSITIVE_LEVEL
    },
    {
      code: 'SAMPLE_SUFFICIENT',
      label: 'Recent window is a usable sample',
      current: recent.count,
      required: C.MIN_SAMPLE_FOR_PERFORMANCE,
      passed: recent.sufficient === true
    },
    {
      code: 'POSITIVE_GROWTH',
      label: 'Winsorised average R over the window',
      current: round(recent.winsorisedAvgR, 3),
      required: C.LEVEL_UP_MIN_AVG_R,
      passed: recent.sufficient === true && recent.winsorisedAvgR >= C.LEVEL_UP_MIN_AVG_R
    },
    {
      code: 'ADJUSTED_EQUITY_GROWTH',
      label: 'Adjusted equity has not fallen since the last level change',
      current: curveGrowthOk === null ? 'not measurable' : curveGrowthOk,
      required: true,
      // Unmeasurable does not block: with no snapshot history the R-based gate
      // above is the only honest evidence available.
      passed: curveGrowthOk !== false
    },
    {
      code: 'DRAWDOWN_CEILING',
      label: 'Current drawdown below the ceiling for the next level',
      current: round(drawdown.currentDrawdownPct, 2),
      required: maxDrawdown,
      passed: drawdown.currentDrawdownPct < maxDrawdown
    },
    {
      code: 'WIN_RATE_FLOOR',
      label: 'Win rate over the window',
      current: round(recent.winRate, 1),
      required: C.LEVEL_UP_MIN_WIN_RATE_PCT,
      passed: recent.sufficient === true && recent.winRate >= C.LEVEL_UP_MIN_WIN_RATE_PCT
    },
    {
      code: 'CONSISTENCY_FLOOR',
      label: 'Share of trades inside the normal band',
      current: round(recent.consistency, 1),
      required: C.LEVEL_UP_MIN_CONSISTENCY_PCT,
      passed: recent.sufficient === true && recent.consistency >= C.LEVEL_UP_MIN_CONSISTENCY_PCT
    },
    {
      code: 'ACTIVE',
      label: 'Recent window is not stale',
      current: recent.stale ? 'stale' : 'active',
      required: 'active',
      passed: recent.stale !== true
    },
    {
      // SLOW UP means you are not promoted in the middle of a losing run. Two
      // consecutive losses is the same threshold at which the envelope starts
      // taking a haircut, and being haircut and promoted in the same
      // evaluation is incoherent. A single loss does not count as a run.
      code: 'NO_ACTIVE_LOSING_STREAK',
      label: 'Not currently on a losing run',
      current: recent.streak,
      required: '> -2',
      passed: recent.streak > -2
    }
  ];

  return {
    nextLevel,
    required,
    maxDrawdownPct: maxDrawdown,
    checks,
    met: checks.every((c) => c.passed),
    atCap: false
  };
}

/**
 * Evaluate the account's risk level.
 *
 * SLOW UP: at most ONE level per evaluation, and only when every gate passes.
 * FAST DOWN: a single evaluation can drop several levels at once when the
 * drawdown is severe. There is no grace period and no averaging.
 *
 * INACTIVITY NEVER DEMOTES. A gap sets `staleRecentData`, freezes promotion,
 * and applies a conservatism haircut to the envelope for the first few trades
 * back — the earned level itself is preserved.
 */
export function calculateRiskLevel({
  adjustedEquity,
  equityCurve = null,
  trades = [],
  openPositions = [],
  previousLevelState = null,
  now = null
} = {}) {
  const closed = closedTradesAscending(trades);
  const totalClosed = closed.length;

  const nowTime = toTime(now);
  const drawdown = calculateDrawdown({ equityCurve });
  const recent = calculateRecentPerformance({ trades, window: C.RECENT_WINDOW, now: nowTime });
  const openRisk = calculateOpenRisk({ openPositions, adjustedEquity });

  const prev = normalizeLevelState(previousLevelState);
  const startLevel = prev.level;
  const tradesSinceLevelChange = Math.max(0, totalClosed - prev.tradesAtLevelChange);

  const currentIndex = drawdown.valid ? drawdown.currentIndex : null;
  const curveGrowthOk =
    prev.indexAtLevelChange !== null && currentIndex !== null
      ? currentIndex >= prev.indexAtLevelChange
      : null;

  const transitions = [];
  const factors = [];
  let level = startLevel;

  /* ---- FAST DOWN, evaluated first ---------------------------------- */

  const ceiling = drawdownCeiling(drawdown.currentDrawdownPct);
  if (ceiling && level > ceiling.ceiling) {
    transitions.push({
      code: 'DRAWDOWN_DEMOTION',
      type: 'DEMOTION',
      from: level,
      to: ceiling.ceiling,
      reason: `Drawdown ${round(drawdown.currentDrawdownPct, 2)}% is at or beyond the ${ceiling.drawdownPct}% tier, which caps the level at ${ceiling.ceiling}.`
    });
    level = ceiling.ceiling;
  }

  // Inactivity must never demote, so streak-driven demotion is skipped on a
  // stale window. Drawdown and open-risk pressure are live facts about capital
  // and still apply.
  if (!recent.stale) {
    for (const tier of C.STREAK_DEMOTION) {
      if (recent.streak <= tier.streak) {
        const to = clampLevel(level - tier.drop);
        if (to < level) {
          transitions.push({
            code: 'LOSING_STREAK_DEMOTION',
            type: 'DEMOTION',
            from: level,
            to,
            reason: `${Math.abs(recent.streak)} consecutive losing trades.`
          });
          level = to;
        }
        break;
      }
    }
  }

  if (openRisk.consumedRiskPct > C.OPEN_RISK_PRESSURE_PCT) {
    const to = clampLevel(level - 1);
    if (to < level) {
      transitions.push({
        code: 'OPEN_RISK_PRESSURE',
        type: 'DEMOTION',
        from: level,
        to,
        reason: `Open risk ${round(openRisk.consumedRiskPct, 2)}% of equity is beyond the ${C.OPEN_RISK_PRESSURE_PCT}% pressure threshold.`
      });
      level = to;
    }
  }

  if (openRisk.unrealizedLossPct > C.UNREALIZED_LOSS_PRESSURE_PCT) {
    const to = clampLevel(level - 1);
    if (to < level) {
      transitions.push({
        code: 'UNREALIZED_LOSS_PRESSURE',
        type: 'DEMOTION',
        from: level,
        to,
        reason: `Unrealised losses are ${round(openRisk.unrealizedLossPct, 2)}% of equity, beyond the ${C.UNREALIZED_LOSS_PRESSURE_PCT}% threshold.`
      });
      level = to;
    }
  }

  /* ---- Bootstrap cap ------------------------------------------------ */

  if (totalClosed < C.MIN_TRADES_FOR_POSITIVE_LEVEL && level > 0) {
    transitions.push({
      code: 'UNPROVEN_ACCOUNT',
      type: 'DEMOTION',
      from: level,
      to: 0,
      reason: `Fewer than ${C.MIN_TRADES_FOR_POSITIVE_LEVEL} closed trades. An unproven account cannot hold a level above 0.`
    });
    level = 0;
  }

  /* ---- SLOW UP: at most one level, and only with no demotion ------- */

  const startGates = computeLevelGates({
    level: startLevel,
    tradesSinceLevelChange,
    totalClosed,
    recent,
    drawdown,
    curveGrowthOk
  });

  const demoted = level < startLevel;
  if (!demoted && !startGates.atCap && startGates.met) {
    transitions.push({
      code: 'LEVEL_UP',
      type: 'PROMOTION',
      from: level,
      to: startGates.nextLevel,
      reason: `All ${startGates.checks.length} level-up gates cleared over ${tradesSinceLevelChange} closed trades since the last level change.`
    });
    level = startGates.nextLevel;
  }

  const levelChanged = level !== startLevel;
  const finalTradesSince = levelChanged ? 0 : tradesSinceLevelChange;
  const finalTradesAtLevelChange = levelChanged ? totalClosed : prev.tradesAtLevelChange;
  const finalIndexAtLevelChange = levelChanged
    ? (currentIndex ?? null)
    : (prev.indexAtLevelChange ?? currentIndex ?? null);

  const gates = computeLevelGates({
    level,
    tradesSinceLevelChange: finalTradesSince,
    totalClosed,
    recent,
    drawdown,
    curveGrowthOk: levelChanged ? null : curveGrowthOk
  });

  /* ---- Reportable factors (only materially-influencing ones) -------- */

  if (drawdown.currentDrawdownPct >= 1) {
    factors.push({
      code: 'DRAWDOWN',
      label: 'Adjusted-equity drawdown',
      direction: 'DOWN',
      detail: `${round(drawdown.currentDrawdownPct, 2)}% below the adjusted peak (max seen ${round(drawdown.maxDrawdownPct, 2)}%).`
    });
  }
  if (recent.sufficient && recent.streak <= -2) {
    factors.push({
      code: 'LOSING_STREAK',
      label: 'Losing streak',
      direction: 'DOWN',
      detail: `${Math.abs(recent.streak)} consecutive losses.`
    });
  }
  if (recent.sufficient && recent.streak >= 3) {
    factors.push({
      code: 'WINNING_STREAK',
      label: 'Winning streak',
      direction: 'UP',
      detail: `${recent.streak} consecutive wins. Counts toward level progress only — it does not increase risk directly.`
    });
  }
  if (!recent.sufficient) {
    factors.push({
      code: 'INSUFFICIENT_SAMPLE',
      label: 'Recent window too small to read',
      direction: 'NEUTRAL',
      detail: `${recent.count} closed trades against a ${C.MIN_SAMPLE_FOR_PERFORMANCE}-trade minimum. Treated as neutral.`
    });
  }
  if (recent.stale) {
    factors.push({
      code: 'STALE_RECENT_DATA',
      label: 'No recent trading activity',
      direction: 'NEUTRAL',
      detail: `No closed trade in the last ${C.INACTIVITY_DAYS} days. The level is preserved; promotion is paused and a conservatism haircut applies for the first ${C.RETURN_TRADES} trades back.`
    });
  }
  if (openRisk.consumedRiskPct > 0) {
    factors.push({
      code: 'OPEN_RISK',
      label: 'Open risk in the book',
      direction: openRisk.consumedRiskPct > C.OPEN_RISK_PRESSURE_PCT ? 'DOWN' : 'NEUTRAL',
      detail: `${round(openRisk.consumedRiskPct, 2)}% of equity consumed by ${openRisk.count} open position(s).`
    });
  }

  const state = {
    level,
    previousLevel: startLevel,
    definition: getLevelDefinition(level),
    transitions,
    factors,
    staleRecentData: recent.stale === true,

    totalClosedTrades: totalClosed,
    tradesSinceLevelChange: finalTradesSince,
    tradesAtLevelChange: finalTradesAtLevelChange,
    indexAtLevelChange: finalIndexAtLevelChange,
    since: levelChanged ? (nowTime ?? recent.inactivity.lastClosedAt ?? null) : prev.since,
    peakLevel: Math.max(level, prev.peakLevel ?? level),

    nextLevel: gates.nextLevel,
    tradesRequiredForNext: gates.required,
    gates,
    gatesMet: gates.met,

    currentDrawdownPct: drawdown.currentDrawdownPct,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    recentPerformance: recent,
    openRisk,

    evaluatedAt: nowTime
  };

  const progress = calculateLevelProgress(state);
  state.progressPct = progress.progressPct;
  state.tradesToNext = progress.tradesToNext;
  state.progress = progress;

  return state;
}

/**
 * Progress toward the next level, 0..100.
 *
 * A weighted composite of three components, so the bar reflects what actually
 * has to happen rather than only counting trades:
 *
 *   50%  trades since the last level change, against the requirement
 *   30%  winsorised average R against PROGRESS_TARGET_AVG_R (+0.30R)
 *   20%  consistency — share of the window inside the normal band
 *
 * Per-trade R is winsorised at +2R BEFORE it reaches this calculation, so one
 * outsized winner cannot fill the bar. Within a level the trades component is
 * non-decreasing as trades accumulate, which is what makes the bar readable.
 * When every gate is met the bar reads 100.
 */
export function calculateLevelProgress(levelState) {
  const state =
    levelState && typeof levelState === 'object' && levelState.levelState
      ? levelState.levelState
      : levelState && typeof levelState === 'object'
        ? levelState
        : {};

  const level = clampLevel(state.level);
  const recent = state.recentPerformance || {};
  const gates = state.gates || { checks: [], met: false, nextLevel: level >= C.MAX_LEVEL ? null : level + 1, required: 0 };

  if (level >= C.MAX_LEVEL) {
    return {
      level,
      nextLevel: null,
      progressPct: 100,
      tradesToNext: null,
      components: { trades: 1, performance: 1, consistency: 1 },
      blockedBy: [],
      atCap: true,
      note: 'Level 5 is the cap. The risk percentage stops expanding here; dollar size still grows with the wallet.'
    };
  }

  const required = isPositiveNumber(gates.required) ? gates.required : 1;
  const since = Number.isFinite(state.tradesSinceLevelChange) ? state.tradesSinceLevelChange : 0;

  const tradesComponent = clamp(since / required, 0, 1);
  const sufficient = recent.sufficient === true;
  const performanceComponent = sufficient
    ? clamp((recent.winsorisedAvgR || 0) / C.PROGRESS_TARGET_AVG_R, 0, 1)
    : 0;
  const consistencyComponent = sufficient ? clamp((recent.consistency || 0) / 100, 0, 1) : 0;

  const raw =
    C.PROGRESS_WEIGHT_TRADES * tradesComponent +
    C.PROGRESS_WEIGHT_PERFORMANCE * performanceComponent +
    C.PROGRESS_WEIGHT_CONSISTENCY * consistencyComponent;

  const progressPct = gates.met ? 100 : clamp(toPercent(raw), 0, 100);

  return {
    level,
    nextLevel: gates.nextLevel ?? level + 1,
    progressPct,
    tradesToNext: Math.max(0, required - since),
    components: {
      trades: tradesComponent,
      performance: performanceComponent,
      consistency: consistencyComponent
    },
    blockedBy: (gates.checks || []).filter((c) => !c.passed).map((c) => c.code),
    atCap: false
  };
}

/* ========================================================================
 * OPEN RISK AND RISK RECYCLING
 * ===================================================================== */

/**
 * Risk consumed by the open book.
 *
 * Two rules that most sizing tools get wrong:
 *
 * 1. AN OPEN POSITION CONSUMES CAPACITY UNTIL IT IS CLOSED. Moving the stop to
 *    breakeven does not hand the risk budget back. A floor of CLOSURE_RESERVE
 *    (0.5% of notional) applies even when the stop is beyond breakeven,
 *    because a stop is not a guarantee: gaps, thin books and venue outages all
 *    price through it. Only closing the position frees the capacity fully.
 *
 * 2. UNREALISED P&L IS ASYMMETRIC. An unrealised LOSS reduces capacity
 *    immediately and at full weight — it is money already gone. An unrealised
 *    GAIN is a quote, not a result: it is credited at UNREALIZED_GAIN_CREDIT
 *    (25%) toward account health and level progression, and funds NO new risk
 *    at all.
 */
export function calculateOpenRisk({ openPositions = [], adjustedEquity } = {}) {
  const equity = isPositiveNumber(adjustedEquity) ? adjustedEquity : null;
  const list = Array.isArray(openPositions) ? openPositions.filter((p) => p && typeof p === 'object') : [];

  const positions = list.map((p) => {
    const direction = normalizeDirection(p.direction);
    const notional = isPositiveNumber(p.notional) ? p.notional : 0;
    const entry = isPositiveNumber(p.entry) ? p.entry : null;
    const stop = isPositiveNumber(p.stop) ? p.stop : null;

    // Direction-aware distance to the stop. A stop beyond breakeven is not
    // negative risk — it is zero risk to the stop, and then the floor applies.
    let riskToStop = null;
    if (direction && entry !== null && stop !== null && notional > 0) {
      const adverse = direction === 'LONG' ? entry - stop : stop - entry;
      riskToStop = adverse > 0 ? (notional * adverse) / entry : 0;
    } else if (isPositiveNumber(p.riskAmount)) {
      riskToStop = p.riskAmount;
    } else {
      riskToStop = 0;
    }

    const floor = notional * C.CLOSURE_RESERVE;
    const floorApplied = floor > riskToStop;
    const stopRisk = Math.max(riskToStop, floor);

    const unrealized = isFiniteNumber(p.unrealizedPnl) ? p.unrealizedPnl : 0;
    const unrealizedLoss = unrealized < 0 ? Math.abs(unrealized) : 0;
    const unrealizedGain = unrealized > 0 ? unrealized : 0;

    return {
      id: p.id ?? null,
      asset: p.asset ?? p.symbol ?? null,
      direction,
      notional,
      entry,
      stop,
      margin: isPositiveNumber(p.margin) ? p.margin : (isPositiveNumber(p.leverage) && notional > 0 ? notional / p.leverage : 0),
      leverage: isPositiveNumber(p.leverage) ? p.leverage : null,
      riskToStop,
      closureReserve: floor,
      floorApplied,
      stopRisk,
      unrealizedPnl: unrealized,
      unrealizedLoss,
      unrealizedGain,
      // What this position actually takes out of the budget.
      consumed: stopRisk + unrealizedLoss
    };
  });

  const stopRisk = positions.reduce((sum, p) => sum + p.stopRisk, 0);
  const unrealizedLossTotal = positions.reduce((sum, p) => sum + p.unrealizedLoss, 0);
  const unrealizedGainTotal = positions.reduce((sum, p) => sum + p.unrealizedGain, 0);
  const unrealizedGainCredited = unrealizedGainTotal * C.UNREALIZED_GAIN_CREDIT;
  const consumedRisk = stopRisk + unrealizedLossTotal;
  const notionalExposure = positions.reduce((sum, p) => sum + p.notional, 0);
  const marginUsed = positions.reduce((sum, p) => sum + p.margin, 0);

  return {
    valid: equity !== null,
    adjustedEquity: equity,
    count: positions.length,
    positions,
    stopRisk,
    consumedRisk,
    consumedRiskPct: equity ? toPercent(consumedRisk / equity) : 0,
    unrealizedLossTotal,
    unrealizedLossPct: equity ? toPercent(unrealizedLossTotal / equity) : 0,
    unrealizedGainTotal,
    unrealizedGainCredited,
    unrealizedGainCreditedPct: equity ? toPercent(unrealizedGainCredited / equity) : 0,
    notionalExposure,
    notionalExposurePct: equity ? toPercent(notionalExposure / equity) : 0,
    marginUsed,
    marginUtilizationPct: equity ? toPercent(marginUsed / equity) : 0,
    availableCapital: equity ? Math.max(0, equity - marginUsed) : 0,
    floorsApplied: positions.filter((p) => p.floorApplied).length,
    note: 'Open positions consume capacity until closed. Unrealised losses count in full; unrealised gains are credited at 25% and fund no new risk.'
  };
}

/**
 * Directional concentration.
 *
 * Reuses `detectCorrelatedExposure` from riskManager.js, fed with the CONSUMED
 * risk from `calculateOpenRisk` so the closure-reserve floor is respected.
 *
 * The label is deliberately DIRECTIONAL CONCENTRATION, not "correlated". This
 * engine measures no correlation at all — it counts positions pointing the
 * same way. Three crypto longs are not three independent bets, and saying so
 * needs no correlation matrix; claiming a measured correlation would be a
 * false statement about the method.
 */
export function calculateDirectionalConcentration({ openPositions = [] } = {}) {
  const open = calculateOpenRisk({ openPositions, adjustedEquity: 1 });

  const asPolicyPositions = open.positions.map((p) => ({
    asset: p.asset,
    direction: p.direction,
    plannedRisk: p.consumed,
    margin: p.margin,
    notional: p.notional,
    status: 'OPEN'
  }));

  const detected = detectCorrelatedExposure({ positions: asPolicyPositions, policy: DEFAULT_RISK_POLICY });

  return {
    concentrated: detected.concentrated === true,
    direction: detected.direction,
    count: detected.count,
    directionRisk: detected.directionRisk,
    riskSharePct: detected.riskSharePct,
    trigger: detected.trigger ?? null,
    label: detected.concentrated
      ? `DIRECTIONAL CONCENTRATION — ${detected.count} ${detected.direction}`
      : null,
    positions: detected.positions || [],
    note: 'Direction-only. This is a count of same-way positions, NOT a measured correlation.'
  };
}

/* ========================================================================
 * STRATEGY ENVELOPE
 * ===================================================================== */

/**
 * The resolved risk envelope for a level and strategy, after performance,
 * drawdown and inactivity haircuts.
 *
 * ONE-WAY DOWN. Recent performance in this engine can only REDUCE the
 * envelope. A good run buys nothing immediately; it earns levels, slowly, and
 * the level is what widens the envelope. This is what makes the adversarial
 * property hold: a worsening history can never produce a larger recommended
 * risk percentage.
 *
 * Haircuts apply to the risk-percent band only (min/base/max). Leverage, heat,
 * notional, directional and margin caps are STRUCTURAL and move only with the
 * level — a demotion is what tightens them, which is the point of demotion.
 */
export function calculateStrategyEnvelope({ level, strategy, recentPerformance = null, drawdown = null } = {}) {
  const preset = resolvePreset(strategy);
  const resolvedLevel = clampLevel(level);
  const base = preset.levels[String(resolvedLevel)];

  const recent = recentPerformance && typeof recentPerformance === 'object' ? recentPerformance : null;
  const dd = drawdown && typeof drawdown === 'object' ? drawdown : null;
  const sensitivity = clamp(preset.recentPerformanceSensitivity, 0, 2);

  /* ---- Performance haircut (downward only) ------------------------- */
  const performanceReasons = [];
  let rawPerformance = 1;

  // Insufficient sample is NEUTRAL: no haircut and, since there is no upward
  // path at all, no benefit either.
  if (recent && recent.sufficient === true) {
    if (recent.streak <= -4) {
      rawPerformance *= 0.55;
      performanceReasons.push(`${Math.abs(recent.streak)} consecutive losses`);
    } else if (recent.streak <= -3) {
      rawPerformance *= 0.70;
      performanceReasons.push('3 consecutive losses');
    } else if (recent.streak <= -2) {
      rawPerformance *= 0.85;
      performanceReasons.push('2 consecutive losses');
    }
    if (recent.winRate < 30) {
      rawPerformance *= 0.80;
      performanceReasons.push(`win rate ${round(recent.winRate, 0)}% below 30%`);
    }
    if (recent.winsorisedAvgR < 0) {
      rawPerformance *= 0.85;
      performanceReasons.push('negative average R over the window');
    }
    if (recent.consistency < 50) {
      rawPerformance *= 0.85;
      performanceReasons.push(`only ${round(recent.consistency, 0)}% of trades inside the normal band`);
    }
  }

  // Sensitivity scales the SEVERITY of the cut. STANDARD takes it at full
  // strength; AGGRESSIVE at 0.6, which is what "permits more variance" means.
  const performanceHaircut = 1 - (1 - rawPerformance) * sensitivity;

  /* ---- Drawdown haircut (deepest tier only, never scaled) ----------- */
  let drawdownHaircut = 1;
  let drawdownReason = null;
  const currentDrawdownPct = dd && Number.isFinite(dd.currentDrawdownPct) ? dd.currentDrawdownPct : 0;
  if (currentDrawdownPct >= 15) {
    drawdownHaircut = 0.60;
    drawdownReason = 'drawdown at or beyond 15%';
  } else if (currentDrawdownPct >= 10) {
    drawdownHaircut = 0.75;
    drawdownReason = 'drawdown at or beyond 10%';
  } else if (currentDrawdownPct >= 5) {
    drawdownHaircut = 0.90;
    drawdownReason = 'drawdown at or beyond 5%';
  }

  /* ---- Return-from-inactivity haircut ------------------------------- */
  const returning = recent ? recent.returning === true : false;
  const returnHaircut = returning ? C.RETURN_HAIRCUT : 1;

  const combined = performanceHaircut * drawdownHaircut * returnHaircut;

  const minRiskPct = base.minRiskPct * combined;
  const baseRiskPct = base.baseRiskPct * combined;
  const maxRiskPct = base.maxRiskPct * combined;

  return {
    level: resolvedLevel,
    levelDefinition: getLevelDefinition(resolvedLevel),
    strategy: preset.key,
    strategyLabel: preset.label,

    minRiskPct,
    baseRiskPct,
    maxRiskPct,

    maxLeverage: base.maxLeverage,
    maxPortfolioHeatPct: base.maxPortfolioHeatPct,
    maxNotionalExposurePct: base.maxNotionalExposurePct,
    maxDirectionalRiskPct: base.maxDirectionalRiskPct,
    maxMarginUtilizationPct: base.maxMarginUtilizationPct,
    maxOpenPositions: base.maxOpenPositions,

    confidenceRange: preset.confidenceRange,
    recentPerformanceSensitivity: preset.recentPerformanceSensitivity,
    derivedStop: preset.derivedStop,

    /** The un-haircut table row, so the UI can show what was given up. */
    base: { ...base },

    haircut: {
      performance: performanceHaircut,
      performanceRaw: rawPerformance,
      performanceReasons,
      drawdown: drawdownHaircut,
      drawdownReason,
      returning: returnHaircut,
      returningApplied: returning,
      combined
    },

    note: 'Recent performance is a one-way DOWNWARD adjustment. It never increases the envelope; only the level does.'
  };
}

/* ========================================================================
 * CONFIDENCE
 * ===================================================================== */

/**
 * Map the 0-100 slider to a risk percentage INSIDE the envelope.
 *
 * Piecewise linear, anchored so the slider's neutral point maps exactly to
 * baseRiskPct:
 *
 *   c <= neutral :  min  + (base - min) * (c / neutral)
 *   c >  neutral :  base + (max - base) * ((c - neutral) / (100 - neutral))
 *
 * The slider is then clamped to the strategy's usable range. STANDARD stops at
 * 90, so the top of the band is unreachable by confidence alone and the 2%
 * ceiling at level 0 stays a ceiling.
 *
 * Confidence can NEVER: exceed envelope.maxRiskPct, raise leverage, or clear a
 * NO_TRADE. It moves one number inside one band and nothing else.
 */
export function calculateConfidenceMultiplier({ confidence, strategy, envelope } = {}) {
  const preset = resolvePreset(strategy || (envelope && envelope.strategy));
  const range = (envelope && envelope.confidenceRange) || preset.confidenceRange;

  const requested = isFiniteNumber(confidence) ? confidence : range.neutral;
  const inBounds = clamp(requested, 0, 100);
  const clamped = clamp(inBounds, range.min, range.max);
  const clampedByStrategy = clamped !== inBounds;

  const min = envelope ? envelope.minRiskPct : preset.minRiskPct;
  const mid = envelope ? envelope.baseRiskPct : preset.baseRiskPct;
  const max = envelope ? envelope.maxRiskPct : preset.maxRiskPct;
  const neutral = range.neutral;

  let riskPct;
  if (clamped <= neutral) {
    riskPct = neutral > 0 ? min + (mid - min) * (clamped / neutral) : mid;
  } else {
    const span = 100 - neutral;
    riskPct = span > 0 ? mid + (max - mid) * ((clamped - neutral) / span) : mid;
  }

  // Belt and braces: the envelope maximum is a hard ceiling regardless of the map.
  const capped = Math.min(riskPct, max);

  return {
    confidence: requested,
    clampedConfidence: clamped,
    clampedByStrategy,
    riskPct: capped,
    multiplier: mid > 0 ? capped / mid : 1,
    minRiskPct: min,
    baseRiskPct: mid,
    maxRiskPct: max,
    range,
    note: clampedByStrategy
      ? `${preset.label} caps the usable slider at ${range.max}, so the top of the envelope is not reachable by confidence alone.`
      : 'Confidence moves risk inside the envelope only. It cannot raise the ceiling, raise leverage, or clear a no-trade.'
  };
}

/* ========================================================================
 * NO-TRADE CONSTRAINTS
 *
 * NO_TRADE is a first-class result, not a failure. Every blocker carries
 * { code, label, current, limit, remedy } so the UI can render a sentence a
 * person can act on:
 *
 *   "Open risk 5.4%  ·  Standard limit 5.0%  ·  available again below 5.0%"
 * ===================================================================== */

function blocker(code, label, current, limit, remedy) {
  return { code, label, current, limit, remedy };
}

const pct = (n) => `${round(n, 2)}%`;
const usd = (n) =>
  Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : 'n/a';

/**
 * Account-level gate. Runs LAST in the decision hierarchy, after the envelope,
 * confidence and portfolio clamps have all had their say — because a hard
 * constraint must be able to overrule every one of them.
 */
export function evaluateNoTradeConstraints({
  envelope,
  openRiskState,
  concentration = null,
  adjustedEquity,
  drawdown = null,
  level,
  /**
   * Direction of the trade being considered, when known. A book already at the
   * one-way limit blocks a trade that ADDS to that side; it must not block a
   * trade pointing the other way, which reduces the concentration. When the
   * direction is unknown the blocker applies, which is the conservative read.
   */
  direction = null
} = {}) {
  const blockers = [];
  const resolvedLevel = clampLevel(level);
  const equity = isPositiveNumber(adjustedEquity) ? adjustedEquity : 0;

  /* ---- Missing state is a BLOCK, not a permission -------------------
   *
   * This function's contract is that it runs last and overrules everything
   * above it. A last-resort gate must therefore fail CLOSED.
   *
   * It used to substitute `{consumedRiskPct: 0, count: 0, ...}` for an absent
   * openRiskState — an empty, safe-looking book — and every envelope-dependent
   * blocker was additionally guarded by `if (envelope && ...)`, so a null
   * envelope silently disabled five of the seven blockers. Calling it with no
   * state at all returned `{allowed: true, blockers: []}`: an unconditional
   * permission produced by the absence of any evidence.
   *
   * Non-finite fields are rejected for the same reason. Every threshold test
   * here is of the form `value >= limit`, and `NaN >= limit` is false, so a
   * corrupt book passed all of them silently.
   */
  const openFieldsValid =
    openRiskState &&
    ['consumedRiskPct', 'count', 'notionalExposurePct', 'marginUtilizationPct']
      .every((k) => Number.isFinite(openRiskState[k]));

  if (!envelope || !openFieldsValid) {
    const missing = [];
    if (!envelope) missing.push('risk envelope');
    if (!openRiskState) missing.push('open risk state');
    else if (!openFieldsValid) missing.push('open risk state (non-numeric fields)');

    blockers.push(
      blocker(
        'INCOMPLETE_STATE',
        'Account state is incomplete',
        missing.join(', '),
        'complete, numeric state',
        'Reload the Risk Manager so the wallet, open positions and level are all read before sizing a position.'
      )
    );

    return { allowed: false, blockers, level: resolvedLevel };
  }

  const open = openRiskState;
  const dd = drawdown && Number.isFinite(drawdown.currentDrawdownPct) ? drawdown.currentDrawdownPct : 0;

  if (equity <= 0) {
    blockers.push(
      blocker(
        'NO_CAPITAL',
        'No usable capital',
        usd(adjustedEquity),
        '> $0',
        'Fund or refresh the trading wallet before sizing a position.'
      )
    );
  }

  if (dd >= C.DEFENSIVE_NO_TRADE_DRAWDOWN_PCT) {
    blockers.push(
      blocker(
        'DEFENSIVE_DRAWDOWN',
        'Defensive drawdown state',
        pct(dd),
        pct(C.DEFENSIVE_NO_TRADE_DRAWDOWN_PCT),
        `New trades resume below ${C.DEFENSIVE_NO_TRADE_DRAWDOWN_PCT}% drawdown. Closing positions or recovering equity is the only route back.`
      )
    );
  }

  if (resolvedLevel <= C.MIN_LEVEL && dd >= C.LOCKDOWN_DRAWDOWN_PCT) {
    blockers.push(
      blocker(
        'LOCKDOWN',
        'Level -2 lockdown',
        `level ${resolvedLevel} at ${pct(dd)} drawdown`,
        `level > -2 or drawdown below ${C.LOCKDOWN_DRAWDOWN_PCT}%`,
        `At level -2 with drawdown at or beyond ${C.LOCKDOWN_DRAWDOWN_PCT}%, no new position is permitted at any size.`
      )
    );
  }

  if (envelope && open.consumedRiskPct >= envelope.maxPortfolioHeatPct) {
    blockers.push(
      blocker(
        'OPEN_RISK_LIMIT',
        'Open risk over the portfolio heat limit',
        pct(open.consumedRiskPct),
        pct(envelope.maxPortfolioHeatPct),
        `Available again below ${pct(envelope.maxPortfolioHeatPct)} — close or reduce an open position.`
      )
    );
  }

  if (envelope && open.count >= envelope.maxOpenPositions) {
    blockers.push(
      blocker(
        'MAX_OPEN_POSITIONS',
        'Maximum open positions reached',
        open.count,
        envelope.maxOpenPositions,
        `Level ${envelope.level} on ${envelope.strategy} permits ${envelope.maxOpenPositions} open position(s). Close one to open another.`
      )
    );
  }

  if (envelope && open.notionalExposurePct >= envelope.maxNotionalExposurePct) {
    blockers.push(
      blocker(
        'EXPOSURE_LIMIT',
        'Notional exposure over the limit',
        pct(open.notionalExposurePct),
        pct(envelope.maxNotionalExposurePct),
        `Available again below ${pct(envelope.maxNotionalExposurePct)} of equity in notional.`
      )
    );
  }

  const addsToConcentration =
    direction === null || (concentration && concentration.direction === normalizeDirection(direction));

  if (envelope && concentration && concentration.direction && equity > 0 && addsToConcentration) {
    const directionRiskPct = toPercent(concentration.directionRisk / equity);
    if (directionRiskPct >= envelope.maxDirectionalRiskPct) {
      blockers.push(
        blocker(
          'DIRECTIONAL_LIMIT',
          `Directional concentration — ${concentration.direction}`,
          pct(directionRiskPct),
          pct(envelope.maxDirectionalRiskPct),
          `${concentration.count} position(s) point ${concentration.direction}. Available again below ${pct(envelope.maxDirectionalRiskPct)} one-way risk. Direction-only; not a measured correlation.`
        )
      );
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    level: resolvedLevel
  };
}

/* ========================================================================
 * recommendTrade — PRIMARY ENTRY POINT
 * ===================================================================== */

function pushFactor(factors, code, label, direction, detail) {
  factors.push({ code, label, direction, detail });
}

/**
 * The derived stop distance used when the user supplies no technical stop.
 *
 * Deterministic in level + strategy + confidence:
 *   - the preset's base assumption (5% STANDARD, 7% AGGRESSIVE)
 *   - widened 5% per earned level, because a longer-horizon, proven account is
 *     assumed to be working structure rather than noise. A WIDER assumed stop
 *     means a SMALLER notional for the same dollar risk, so this is a
 *     conservative direction of travel.
 *   - widened up to 40% at low confidence. Confidence can only WIDEN the
 *     derived stop, never tighten it: tightening would inflate notional, which
 *     is exactly the failure mode confidence must not be able to cause.
 */
function deriveStopDistancePct({ preset, level, confidence }) {
  const range = preset.confidenceRange;
  const neutral = range.neutral;
  const c = clamp(clamp(isFiniteNumber(confidence) ? confidence : neutral, 0, 100), range.min, range.max);

  const levelFactor = 1 + 0.05 * Math.max(0, clampLevel(level));
  const confidenceFactor = 1 + 0.40 * (Math.max(0, neutral - c) / neutral);

  return clamp(preset.derivedStop.basePct * levelFactor * confidenceFactor, preset.derivedStop.minPct, preset.derivedStop.maxPct);
}

/** Latest timestamp anywhere in the account data. Used only when the caller supplies no `now`. */
function inferNow(account) {
  const times = [];
  const push = (v) => {
    const t = toTime(v);
    if (t !== null) times.push(t);
  };
  (account.snapshots || []).forEach((s) => push(s && (s.at ?? s.timestamp)));
  (account.cashFlows || []).forEach((f) => push(f && f.at));
  (account.trades || []).forEach((t) => {
    push(t && t.closedAt);
    push(t && t.openedAt);
    push(t && t.updatedAt);
  });
  return times.length ? Math.max(...times) : null;
}

/**
 * Size one trade against everything the account has actually done.
 *
 * Order of operations IS the decision hierarchy:
 *   level -> envelope -> confidence (inside the envelope) -> performance
 *   haircuts (already folded into the envelope) -> portfolio clamps ->
 *   no-trade gate.
 *
 * The stop is never moved to fit a percentage. When a technical stop makes the
 * position too large for a cap, the NOTIONAL is reduced and the reduction is
 * reported as a factor.
 */
export function recommendTrade({ account = {}, request = {} } = {}) {
  const warnings = [];
  const factors = [];
  const blockers = [];

  const strategy = resolvePreset(request.strategy);
  const now = toTime(request.now ?? account.now) ?? inferNow(account);

  const inputsHash = hashInputs({
    v: STRATEGY_VERSION,
    now,
    walletValue: account.walletValue,
    dataStale: account.dataStale === true,
    walletAvailable: account.walletAvailable !== false,
    cashFlows: (account.cashFlows || []).map((f) => ({ id: f.id ?? null, type: f.type, amount: f.amount, at: toTime(f.at) })),
    snapshots: (account.snapshots || []).map((s) => ({ at: toTime(s.at ?? s.timestamp), v: s.walletValue ?? s.balance })),
    trades: closedTradesAscending(account.trades || []).map((t) => ({
      id: t.id ?? null,
      at: toTime(t.closedAt ?? t.updatedAt ?? t.at),
      r: round(tradeR(t).r, 6)
    })),
    openPositions: (account.openPositions || []).map((p) => ({
      id: p.id ?? null,
      asset: p.asset ?? null,
      direction: p.direction ?? null,
      notional: p.notional ?? null,
      entry: p.entry ?? null,
      stop: p.stop ?? null,
      unrealizedPnl: p.unrealizedPnl ?? null,
      riskAmount: p.riskAmount ?? null
    })),
    previousLevelState: account.previousLevelState ?? null,
    request: {
      asset: request.asset ?? null,
      strategy: strategy.key,
      confidence: request.confidence ?? null,
      entry: request.entry ?? null,
      stop: request.stop ?? null,
      direction: request.direction ?? null,
      override: request.override ?? null
    }
  });

  const incomplete = (reason, extra = {}) => ({
    decision: 'INCOMPLETE',
    asset: request.asset ?? null,
    strategy: strategy.key,
    confidence: isFiniteNumber(request.confidence) ? request.confidence : null,
    level: null,
    levelProgress: null,
    position: { notional: 0, leverage: null, margin: 0, units: null, entry: isPositiveNumber(request.entry) ? request.entry : null },
    maxLoss: { pct: 0, amount: 0 },
    stop: { price: null, distancePct: null, source: 'NONE' },
    blockers: [blocker('INCOMPLETE_INPUT', 'Cannot produce a number', reason, 'complete, fresh inputs', reason)],
    factors: [],
    envelope: null,
    warnings: [...warnings, reason],
    strategyVersion: STRATEGY_VERSION,
    inputsHash,
    ...extra
  });

  /* ---- 0. Data availability ---------------------------------------- */

  if (account.walletAvailable === false) {
    return incomplete(
      'Wallet data is unavailable — the balance could not be read. Sizing against a stale or guessed balance would be worse than showing nothing.'
    );
  }
  if (!isPositiveNumber(account.walletValue)) {
    return incomplete('No positive wallet value supplied.');
  }

  /* ---- 1. Capital base and performance ------------------------------ */

  const equityState = calculateAdjustedEquity({ walletValue: account.walletValue, cashFlows: account.cashFlows || [] });
  const adjustedEquity = equityState.adjustedEquity;

  const equityCurve = buildEquityCurve({ snapshots: account.snapshots || [], cashFlows: account.cashFlows || [] });
  const drawdown = calculateDrawdown({ equityCurve });
  const recent = calculateRecentPerformance({
    trades: account.trades || [],
    window: strategy.recentPerformanceWindow,
    now
  });

  /* ---- 2. Level ----------------------------------------------------- */

  const levelState = calculateRiskLevel({
    adjustedEquity,
    equityCurve,
    trades: account.trades || [],
    openPositions: account.openPositions || [],
    previousLevelState: account.previousLevelState || null,
    now
  });
  const level = levelState.level;

  /* ---- 3. Envelope (level + strategy + performance haircuts) -------- */

  const envelope = calculateStrategyEnvelope({
    level,
    strategy: strategy.key,
    recentPerformance: recent,
    drawdown
  });

  /* ---- 4. Confidence, strictly inside the envelope ------------------ */

  const confidenceState = calculateConfidenceMultiplier({
    confidence: request.confidence,
    strategy: strategy.key,
    envelope
  });

  let riskPct = confidenceState.riskPct;
  const preClampRiskPct = riskPct;

  /* ---- 5. Open risk, exposure, concentration ----------------------- */

  const openRiskState = calculateOpenRisk({ openPositions: account.openPositions || [], adjustedEquity });
  const concentration = calculateDirectionalConcentration({ openPositions: account.openPositions || [] });

  const direction =
    normalizeDirection(request.direction) ||
    (isPositiveNumber(request.entry) && isPositiveNumber(request.stop)
      ? request.stop < request.entry
        ? 'LONG'
        : 'SHORT'
      : null);

  /* ---- 6. Portfolio clamps on the risk percentage ------------------- */

  const remainingHeatPct = envelope.maxPortfolioHeatPct - openRiskState.consumedRiskPct;
  if (riskPct > remainingHeatPct) {
    riskPct = Math.max(0, remainingHeatPct);
  }

  let directionRiskPct = 0;
  if (direction && concentration.direction === direction && adjustedEquity > 0) {
    directionRiskPct = toPercent(concentration.directionRisk / adjustedEquity);
    const remainingDirectionalPct = envelope.maxDirectionalRiskPct - directionRiskPct;
    if (riskPct > remainingDirectionalPct) {
      riskPct = Math.max(0, remainingDirectionalPct);
    }
  }

  if (riskPct < preClampRiskPct - 1e-9) {
    pushFactor(
      factors,
      'PORTFOLIO_CLAMP',
      'Risk reduced by the open book',
      'DOWN',
      `Requested ${pct(preClampRiskPct)} cut to ${pct(riskPct)} by remaining heat (${pct(Math.max(0, remainingHeatPct))} of ${pct(envelope.maxPortfolioHeatPct)})${directionRiskPct > 0 ? ` and ${concentration.direction} concentration` : ''}.`
    );
  }

  /* ---- 7. The no-trade gate (runs last, overrules everything) ------- */

  const gate = evaluateNoTradeConstraints({
    envelope,
    openRiskState,
    concentration,
    adjustedEquity,
    drawdown,
    level,
    direction
  });
  blockers.push(...gate.blockers);

  if (riskPct < C.MIN_VIABLE_RISK_PCT && gate.allowed) {
    blockers.push(
      blocker(
        'HEAT_BUDGET_EXHAUSTED',
        'No usable risk budget left',
        pct(riskPct),
        `>= ${pct(C.MIN_VIABLE_RISK_PCT)}`,
        `Open risk ${pct(openRiskState.consumedRiskPct)} against a ${pct(envelope.maxPortfolioHeatPct)} limit leaves too little to size a position. Close or reduce an open position.`
      )
    );
  }

  /* ---- 8. Stop --------------------------------------------------- */

  const entry = isPositiveNumber(request.entry) ? request.entry : null;
  let stopSource = 'NONE';
  let stopDistance = null;
  let stopPrice = null;

  if (entry !== null && isPositiveNumber(request.stop)) {
    const check = calculateStopDistance({ entry, stop: request.stop, direction: direction || 'LONG' });
    if (!check.valid) {
      return incomplete(check.error, { levelProgress: levelState.progressPct, level });
    }
    stopSource = 'TECHNICAL';
    stopDistance = check.distance;
    stopPrice = request.stop;
  } else {
    // DERIVED. maxLossPct (the risk budget as a share of equity) is already
    // set by level + strategy + confidence above; this converts it to a size.
    const derivedPct = deriveStopDistancePct({ preset: strategy, level, confidence: request.confidence });
    stopSource = 'DERIVED';
    stopDistance = toFraction(derivedPct);
    if (entry !== null && direction) {
      stopPrice = direction === 'LONG' ? entry * (1 - stopDistance) : entry * (1 + stopDistance);
    }
    pushFactor(
      factors,
      'DERIVED_STOP',
      'No technical stop supplied',
      'NEUTRAL',
      `Sized against a derived ${pct(derivedPct)} adverse move from ${strategy.label}'s ${pct(strategy.derivedStop.basePct)} base, widened by level and low confidence. Supplying a real stop replaces this assumption entirely.`
    );
    warnings.push('No technical stop supplied — the stop distance is an assumption, not a level.');
  }

  /* ---- 9. Size ------------------------------------------------------ */

  const riskBudget = adjustedEquity * toFraction(Math.max(0, riskPct));
  let notional = 0;

  if (riskBudget > 0 && stopDistance > 0) {
    const sized = calculatePositionSize({
      allowedRisk: riskBudget,
      stopDistance,
      // calculatePositionSize needs a price only to derive units; when no entry
      // is known, 1 is a neutral placeholder and units are reported as null.
      entry: entry ?? 1
    });
    notional = sized.valid ? sized.notional : 0;
  }

  const notionalBeforeCaps = notional;

  // Notional cap — reduce SIZE, never widen the stop.
  const notionalHeadroom = Math.max(
    0,
    adjustedEquity * toFraction(envelope.maxNotionalExposurePct) - openRiskState.notionalExposure
  );
  if (notional > notionalHeadroom) {
    notional = notionalHeadroom;
    pushFactor(
      factors,
      'NOTIONAL_CAP',
      'Position size reduced by the exposure cap',
      'DOWN',
      `Sizing to the stop would need ${usd(notionalBeforeCaps)} of notional; the ${pct(envelope.maxNotionalExposurePct)} exposure cap leaves ${usd(notionalHeadroom)}. The stop was NOT widened — the size was cut.`
    );
  }

  /* ---- 10. Leverage: the lowest that fits, never above the cap ------ */

  const marginBudget = Math.max(
    0,
    Math.min(
      adjustedEquity * toFraction(envelope.maxMarginUtilizationPct) - openRiskState.marginUsed,
      openRiskState.availableCapital
    )
  );

  let leverage = 1;
  if (notional > 0) {
    if (isPositiveNumber(request.override && request.override.leverage)) {
      // Simulation: the caller pins leverage. Notional is NOT adjusted for it,
      // which is what keeps max loss strictly leverage-independent.
      //
      // The pin is still CLAMPED to the level's leverage cap. Without the
      // clamp this branch was a hole straight through the structural caps:
      // the only downstream leverage check is guarded by
      // `margin > marginBudget`, and raising leverage SHRINKS margin, so a
      // high enough pin skipped the check entirely. An override of 50 against
      // a cap of 3 returned decision TRADE with an empty blockers array, an
      // empty warnings array, and no factor — indistinguishable in the output
      // from a genuine 50x recommendation, with a liquidation estimate
      // computed at 50x to match.
      //
      // Leverage is the one input where a caller's request must never widen a
      // structural limit: it does not change max loss at the stop, but it does
      // change how close an ordinary wick sits to liquidation.
      const requestedLeverage = request.override.leverage;
      leverage = Math.min(requestedLeverage, envelope.maxLeverage);

      if (requestedLeverage > envelope.maxLeverage) {
        pushFactor(
          factors,
          'LEVERAGE_CAP',
          'Requested leverage exceeded the level cap',
          'DOWN',
          `Requested ${round(requestedLeverage, 2)}x, capped at ${envelope.maxLeverage}x by the level ${level} table. Leverage cannot be raised past the cap by an override.`
        );
        warnings.push(
          `Leverage override of ${round(requestedLeverage, 2)}x was reduced to the ${envelope.maxLeverage}x cap.`
        );
      } else {
        pushFactor(
          factors,
          'SIMULATION_OVERRIDE',
          'Leverage pinned for simulation',
          'NEUTRAL',
          `Leverage pinned at ${round(leverage, 2)}x. Max loss at the stop is unchanged by leverage; margin and liquidation distance are not.`
        );
        warnings.push('Simulation override active — this is not the engine\'s recommendation.');
      }
    } else if (marginBudget > 0) {
      const needed = notional / marginBudget;
      leverage = clamp(Math.ceil(Math.max(1, needed) * 100) / 100, 1, envelope.maxLeverage);
    } else {
      leverage = envelope.maxLeverage;
    }
  }

  if (isPositiveNumber(request.override && request.override.notional)) {
    notional = request.override.notional;
    pushFactor(
      factors,
      'SIMULATION_OVERRIDE',
      'Size overridden for simulation',
      'NEUTRAL',
      `Notional pinned at ${usd(notional)}. Max loss is derived from that size, not from the recommended risk percentage.`
    );
    warnings.push('Simulation override active — this is not the engine\'s recommendation.');
  }

  const marginState = notional > 0 ? calculateRequiredMargin({ notional, leverage }) : { valid: true, margin: 0 };
  const margin = marginState.valid ? marginState.margin : 0;

  if (notional > 0 && margin > marginBudget + 1e-9) {
    const requiredLeverage = marginBudget > 0 ? notional / marginBudget : Infinity;
    if (requiredLeverage > envelope.maxLeverage) {
      blockers.push(
        blocker(
          'LEVERAGE_CAP',
          'Required leverage over the cap',
          Number.isFinite(requiredLeverage) ? `${round(requiredLeverage, 2)}x` : 'unbounded',
          `${envelope.maxLeverage}x`,
          `Level ${level} on ${strategy.label} caps leverage at ${envelope.maxLeverage}x. Reduce the size or widen the stop yourself — the engine will not widen it for you.`
        )
      );
    } else {
      blockers.push(
        blocker(
          'MARGIN_INSUFFICIENT',
          'Not enough free margin',
          usd(margin),
          usd(marginBudget),
          `${usd(margin)} of margin is needed against ${usd(marginBudget)} available under the ${pct(envelope.maxMarginUtilizationPct)} utilisation cap. Close a position or reduce the size.`
        )
      );
    }
  }

  /* ---- 11. Max loss -------------------------------------------------- */

  const maxLossAmount = notional * stopDistance;
  const maxLossPct = adjustedEquity > 0 ? toPercent(maxLossAmount / adjustedEquity) : 0;

  if (notional <= 0 && blockers.length === 0) {
    blockers.push(
      blocker(
        'NO_RISK_BUDGET',
        'No risk budget available',
        pct(riskPct),
        `>= ${pct(C.MIN_VIABLE_RISK_PCT)}`,
        'Nothing can be sized at the current level, envelope and open book.'
      )
    );
  }

  /* ---- 12. Materially-influencing factors --------------------------- */

  if (level !== 0) {
    pushFactor(
      factors,
      'LEVEL',
      `Risk level ${level} — ${getLevelDefinition(level).label}`,
      level > 0 ? 'UP' : 'DOWN',
      level > 0
        ? `Earned envelope: base ${pct(envelope.base.baseRiskPct)}, ceiling ${pct(envelope.base.maxRiskPct)}, heat ${pct(envelope.maxPortfolioHeatPct)}.`
        : `Defensive envelope: base ${pct(envelope.base.baseRiskPct)}, ceiling ${pct(envelope.base.maxRiskPct)}, leverage ${envelope.maxLeverage}x, ${envelope.maxOpenPositions} position(s).`
    );
  }
  for (const transition of levelState.transitions) {
    pushFactor(
      factors,
      transition.code,
      transition.type === 'PROMOTION' ? 'Level up' : 'Level down',
      transition.type === 'PROMOTION' ? 'UP' : 'DOWN',
      `${transition.from} -> ${transition.to}. ${transition.reason}`
    );
  }
  if (envelope.haircut.performance < 1 - C.FACTOR_MATERIALITY) {
    pushFactor(
      factors,
      'RECENT_PERFORMANCE_HAIRCUT',
      'Recent results reduced the risk band',
      'DOWN',
      `Band cut to ${round(envelope.haircut.performance * 100, 0)}% of the level ${level} table: ${envelope.haircut.performanceReasons.join('; ')}. ${strategy.label} sensitivity ${strategy.recentPerformanceSensitivity}.`
    );
  }
  if (envelope.haircut.drawdown < 1 - C.FACTOR_MATERIALITY) {
    pushFactor(
      factors,
      'DRAWDOWN_HAIRCUT',
      'Drawdown reduced the risk band',
      'DOWN',
      `${envelope.haircut.drawdownReason} — band cut to ${round(envelope.haircut.drawdown * 100, 0)}% of the level ${level} table.`
    );
  }
  if (envelope.haircut.returningApplied) {
    pushFactor(
      factors,
      'RETURNING_FROM_INACTIVITY',
      'Conservatism haircut after a break',
      'DOWN',
      `No closed trade for over ${C.INACTIVITY_DAYS} days, or fewer than ${C.RETURN_TRADES} trades since returning. Level preserved; band cut to ${round(C.RETURN_HAIRCUT * 100, 0)}% for the first ${C.RETURN_TRADES} trades back.`
    );
  }
  if (confidenceState.clampedByStrategy) {
    pushFactor(
      factors,
      'CONFIDENCE_CLAMPED',
      'Confidence clamped by the strategy',
      'DOWN',
      confidenceState.note
    );
  }
  if (Math.abs(confidenceState.riskPct - envelope.baseRiskPct) > envelope.baseRiskPct * C.FACTOR_MATERIALITY) {
    pushFactor(
      factors,
      'CONFIDENCE',
      `Confidence ${confidenceState.clampedConfidence}`,
      confidenceState.riskPct > envelope.baseRiskPct ? 'UP' : 'DOWN',
      `Moves risk to ${pct(confidenceState.riskPct)} inside the ${pct(envelope.minRiskPct)}–${pct(envelope.maxRiskPct)} envelope. It cannot move the envelope itself.`
    );
  }
  if (concentration.concentrated) {
    pushFactor(
      factors,
      'DIRECTIONAL_CONCENTRATION',
      concentration.label,
      'DOWN',
      `${concentration.count} position(s) point ${concentration.direction}, ${round(concentration.riskSharePct, 0)}% of open risk. Direction-only, not a measured correlation.`
    );
  }
  if (openRiskState.floorsApplied > 0) {
    pushFactor(
      factors,
      'CLOSURE_RESERVE',
      'Breakeven stops still consume capacity',
      'DOWN',
      `${openRiskState.floorsApplied} open position(s) have a stop at or beyond breakeven and still reserve ${round(C.CLOSURE_RESERVE * 100, 2)}% of notional. Only closing frees the budget.`
    );
  }
  if (openRiskState.unrealizedLossTotal > 0) {
    pushFactor(
      factors,
      'UNREALIZED_LOSS',
      'Unrealised losses reduce capacity now',
      'DOWN',
      `${usd(openRiskState.unrealizedLossTotal)} of open loss counts at full weight against the ${pct(envelope.maxPortfolioHeatPct)} heat limit.`
    );
  }
  if (openRiskState.unrealizedGainTotal > 0) {
    pushFactor(
      factors,
      'UNREALIZED_GAIN',
      'Unrealised gains are discounted',
      'NEUTRAL',
      `${usd(openRiskState.unrealizedGainTotal)} of open profit is credited at ${round(C.UNREALIZED_GAIN_CREDIT * 100, 0)}% toward account health and funds no new risk.`
    );
  }

  /* ---- 13. Stale data ------------------------------------------------ */

  let decision = blockers.length > 0 ? 'NO_TRADE' : 'TRADE';

  if (account.dataStale === true) {
    warnings.push(
      'Wallet data is older than the freshness threshold. The numbers below are computed from a stale balance and are shown for reference, not as a recommendation.'
    );
    blockers.push(
      blocker(
        'STALE_WALLET_DATA',
        'Wallet data is stale',
        'older than the freshness threshold',
        'fresh wallet read',
        'Refresh the wallet balance. Sizing against a stale balance risks sizing against money that is no longer there.'
      )
    );
    decision = 'INCOMPLETE';
  }

  return {
    decision,
    asset: request.asset ?? null,
    strategy: strategy.key,
    confidence: confidenceState.clampedConfidence,
    level,
    levelProgress: levelState.progressPct,
    position: {
      notional,
      leverage: notional > 0 ? leverage : null,
      margin,
      units: entry !== null && notional > 0 ? notional / entry : null,
      entry
    },
    maxLoss: { pct: maxLossPct, amount: maxLossAmount },
    stop: {
      price: stopPrice,
      distancePct: stopDistance !== null ? toPercent(stopDistance) : null,
      source: stopSource
    },
    blockers,
    factors,
    envelope,
    warnings,
    strategyVersion: STRATEGY_VERSION,
    inputsHash,

    /* Supporting detail. Not part of the required contract, but the UI needs
     * somewhere to read the workings from without recomputing them. */
    detail: {
      adjustedEquity: equityState,
      equityCurve,
      drawdown,
      recentPerformance: recent,
      levelState,
      confidence: confidenceState,
      openRisk: openRiskState,
      concentration,
      direction,
      riskPct,
      requestedRiskPct: preClampRiskPct,
      riskBudget,
      notionalBeforeCaps,
      marginBudget,
      liquidation:
        entry !== null && direction && notional > 0
          ? estimateLiquidation({ entry, direction, leverage, policy: DEFAULT_RISK_POLICY })
          : { available: false, reason: 'Entry or direction not supplied' },
      portfolioAfter: calculatePortfolioRisk({
        positions: [
          ...openRiskState.positions.map((p) => ({ ...p, plannedRisk: p.consumed, status: 'OPEN' })),
          { asset: request.asset ?? null, direction, plannedRisk: maxLossAmount, margin, notional, status: 'PLANNED' }
        ],
        walletBalance: adjustedEquity,
        policy: DEFAULT_RISK_POLICY
      }),
      exposureAfter: calculateExposure({
        positions: [
          ...openRiskState.positions.map((p) => ({ ...p, status: 'OPEN' })),
          { direction, margin, notional, status: 'PLANNED' }
        ],
        walletBalance: adjustedEquity,
        policy: DEFAULT_RISK_POLICY
      })
    }
  };
}

/* ========================================================================
 * evaluatePosition
 *
 * Only ever called EXPLICITLY, on a position the user asks about. It never
 * runs in the background and never volunteers an opinion.
 *
 * These are RISK-MANAGEMENT outputs, not price predictions. REDUCE does not
 * mean the trade is wrong; it means the position is larger than the account's
 * current risk capacity supports. That sentence is returned in the rationale
 * on every call.
 * ===================================================================== */

export function evaluatePosition({ account = {}, position = {}, strategy } = {}) {
  const preset = resolvePreset(strategy);
  const now = toTime(account.now) ?? inferNow(account);
  const adjustedEquity = isPositiveNumber(account.walletValue) ? account.walletValue : 0;

  const equityCurve = buildEquityCurve({ snapshots: account.snapshots || [], cashFlows: account.cashFlows || [] });
  const drawdown = calculateDrawdown({ equityCurve });
  const recent = calculateRecentPerformance({ trades: account.trades || [], window: preset.recentPerformanceWindow, now });
  const levelState = calculateRiskLevel({
    adjustedEquity,
    equityCurve,
    trades: account.trades || [],
    openPositions: account.openPositions || [],
    previousLevelState: account.previousLevelState || null,
    now
  });
  const level = levelState.level;
  const envelope = calculateStrategyEnvelope({ level, strategy: preset.key, recentPerformance: recent, drawdown });

  const book = Array.isArray(account.openPositions) && account.openPositions.length
    ? account.openPositions
    : [position];
  const openRiskState = calculateOpenRisk({ openPositions: book, adjustedEquity });

  const direction = normalizeDirection(position.direction);
  const entry = isPositiveNumber(position.entry) ? position.entry : null;
  const stop = isPositiveNumber(position.stop) ? position.stop : null;
  const notional = isPositiveNumber(position.notional) ? position.notional : 0;
  const leverage = isPositiveNumber(position.leverage) ? position.leverage : 1;
  const unrealizedPnl = isFiniteNumber(position.unrealizedPnl) ? position.unrealizedPnl : 0;

  const sign = direction === 'SHORT' ? -1 : 1;

  // Mark price: taken when supplied, otherwise implied from unrealised P&L.
  // Never invented from anything else.
  let markPrice = isPositiveNumber(position.markPrice) ? position.markPrice : null;
  if (markPrice === null && entry !== null && notional > 0) {
    // pnl = notional * (mark - entry) * sign / entry  =>  mark = entry * (1 + sign * pnl / notional)
    markPrice = entry * (1 + (sign * unrealizedPnl) / notional);
  }

  const riskToStop =
    direction && entry !== null && stop !== null && notional > 0
      ? Math.max(0, ((direction === 'LONG' ? entry - stop : stop - entry) * notional) / entry)
      : isPositiveNumber(position.riskAmount)
        ? position.riskAmount
        : 0;

  const originalRisk = isPositiveNumber(position.riskAmount) ? position.riskAmount : riskToStop;
  const openR = originalRisk > 0 ? unrealizedPnl / originalRisk : 0;

  const positionRiskPct = adjustedEquity > 0 ? toPercent(riskToStop / adjustedEquity) : 0;
  const positionNotionalPct = adjustedEquity > 0 ? toPercent(notional / adjustedEquity) : 0;

  const rationale = [
    'This is a risk-management output, not a price prediction. It describes what the account can currently carry, not where the market is going.'
  ];
  const blockersOut = [];

  /* ---- Decision, highest severity first ---------------------------- */

  let action = 'HOLD';

  const stopInvalid =
    direction && entry !== null && stop !== null
      ? !calculateStopDistance({ entry, stop, direction }).valid
      : false;

  if (adjustedEquity <= 0) {
    action = 'HOLD';
    rationale.push('No usable equity figure — nothing can be judged against a capital base of zero.');
  } else if (stopInvalid) {
    action = 'EXIT';
    rationale.push('The recorded stop sits on the wrong side of entry. The position has no defined risk, which is a structural problem, not a market view.');
  } else if (openR <= -C.EXIT_LOSS_R) {
    action = 'EXIT';
    rationale.push(
      `Open loss is ${round(openR, 2)}R against a ${C.EXIT_LOSS_R}R threshold — beyond the loss the position was sized to take. The plan has already failed on its own terms.`
    );
  } else if (level <= C.MIN_LEVEL && drawdown.currentDrawdownPct >= C.LOCKDOWN_DRAWDOWN_PCT) {
    action = 'EXIT';
    rationale.push(
      `Level ${level} lockdown at ${pct(drawdown.currentDrawdownPct)} drawdown. At this level the account carries at most ${pct(envelope.maxPortfolioHeatPct)} of open risk.`
    );
    blockersOut.push(
      blocker('LOCKDOWN', 'Level -2 lockdown', pct(drawdown.currentDrawdownPct), pct(C.LOCKDOWN_DRAWDOWN_PCT), 'Open risk must come down before any position is carried.')
    );
  } else if (positionRiskPct > envelope.maxRiskPct || openRiskState.consumedRiskPct > envelope.maxPortfolioHeatPct || positionNotionalPct > envelope.maxNotionalExposurePct || leverage > envelope.maxLeverage) {
    action = 'REDUCE';
    if (positionRiskPct > envelope.maxRiskPct) {
      blockersOut.push(blocker('POSITION_RISK', 'Position risk over the single-trade ceiling', pct(positionRiskPct), pct(envelope.maxRiskPct), `Available again below ${pct(envelope.maxRiskPct)} of equity at risk.`));
    }
    if (openRiskState.consumedRiskPct > envelope.maxPortfolioHeatPct) {
      blockersOut.push(blocker('OPEN_RISK_LIMIT', 'Open risk over the heat limit', pct(openRiskState.consumedRiskPct), pct(envelope.maxPortfolioHeatPct), `Available again below ${pct(envelope.maxPortfolioHeatPct)}.`));
    }
    if (positionNotionalPct > envelope.maxNotionalExposurePct) {
      blockersOut.push(blocker('EXPOSURE_LIMIT', 'Notional over the exposure cap', pct(positionNotionalPct), pct(envelope.maxNotionalExposurePct), `Available again below ${pct(envelope.maxNotionalExposurePct)} of equity.`));
    }
    if (leverage > envelope.maxLeverage) {
      blockersOut.push(blocker('LEVERAGE_CAP', 'Leverage over the cap', `${round(leverage, 2)}x`, `${envelope.maxLeverage}x`, `Level ${level} on ${preset.label} caps leverage at ${envelope.maxLeverage}x.`));
    }
    rationale.push('The position is larger than the account\'s current risk capacity supports. This says nothing about whether the trade idea is right.');
  } else if (
    openR >= C.ADD_MIN_OPEN_R &&
    level >= 1 &&
    openRiskState.count < envelope.maxOpenPositions &&
    openRiskState.consumedRiskPct < envelope.maxPortfolioHeatPct
  ) {
    action = 'ADD';
    rationale.push(
      'ADD is conservative by construction: the existing position\'s risk is treated as NOT freed, so the addition is sized only from what heat remains.'
    );
  } else {
    action = 'HOLD';
    rationale.push('The position sits inside every level, strategy and portfolio limit. No change is required on risk grounds.');
  }

  /* ---- ADD sizing, obeying every cap -------------------------------- */

  let addition = null;
  if (action === 'ADD') {
    const remainingHeatPct = Math.max(0, envelope.maxPortfolioHeatPct - openRiskState.consumedRiskPct);
    const perTradeCapPct = Math.min(remainingHeatPct, envelope.maxRiskPct);
    const addRiskBudget = adjustedEquity * toFraction(perTradeCapPct);
    const stopDistance =
      direction && entry !== null && stop !== null
        ? Math.abs(entry - stop) / entry
        : toFraction(deriveStopDistancePct({ preset, level, confidence: 50 }));

    let addNotional = stopDistance > 0 ? addRiskBudget / stopDistance : 0;
    addNotional = Math.min(addNotional, notional * C.ADD_MAX_SHARE_OF_NOTIONAL);
    const notionalHeadroom = Math.max(0, adjustedEquity * toFraction(envelope.maxNotionalExposurePct) - openRiskState.notionalExposure);
    addNotional = Math.min(addNotional, notionalHeadroom);

    addition = {
      notional: addNotional,
      riskAmount: addNotional * stopDistance,
      riskPct: adjustedEquity > 0 ? toPercent((addNotional * stopDistance) / adjustedEquity) : 0,
      cappedAt: `${round(C.ADD_MAX_SHARE_OF_NOTIONAL * 100, 0)}% of the existing notional, the remaining ${pct(remainingHeatPct)} of heat, and the ${pct(envelope.maxNotionalExposurePct)} exposure cap`
    };
    if (addition.notional <= 0) {
      action = 'HOLD';
      addition = null;
      rationale.push('An addition would clear the profit test but leaves no room under the heat or exposure caps, so the answer is HOLD.');
    }
  }

  /* ---- PROTECT_PROFIT ----------------------------------------------- */

  let protectProfit = null;
  if (direction && entry !== null && notional > 0 && openR >= C.PROTECT_PROFIT_TRIGGER_R && markPrice !== null) {
    const improves = (candidate) =>
      stop === null ? true : direction === 'LONG' ? candidate > stop : candidate < stop;
    const isBehindPrice = (candidate) =>
      direction === 'LONG' ? candidate < markPrice : candidate > markPrice;

    // 1. A supplied technical level always wins, if it is genuinely usable.
    //    A level is never invented — absent one, the rule below applies.
    const technical = isPositiveNumber(position.technicalLevel) ? position.technicalLevel : null;
    let proposedStop = null;
    let source = null;

    if (technical !== null && isBehindPrice(technical) && improves(technical)) {
      proposedStop = technical;
      source = 'TECHNICAL';
    } else {
      // 2. Deterministic profit-locking rule.
      //      >= 1R  -> stop to entry (breakeven)
      //      >= 2R  -> lock half the open gain
      const candidate =
        openR >= C.PROTECT_PROFIT_LOCK_HALF_R ? entry + sign * Math.abs(markPrice - entry) * 0.5 : entry;
      if (improves(candidate) && isBehindPrice(candidate)) {
        proposedStop = candidate;
        source = 'RULE';
      }
    }

    if (proposedStop !== null) {
      const lockedProfit = (sign * (proposedStop - entry) * notional) / entry;
      const remainingRisk = (Math.abs(markPrice - proposedStop) * notional) / entry;
      protectProfit = {
        proposedStop,
        lockedProfit,
        remainingRisk,
        source,
        currentStop: stop,
        openR,
        note:
          source === 'TECHNICAL'
            ? 'Uses the technical level supplied with the position. No level was invented.'
            : `Rule-based: at ${round(openR, 2)}R the stop moves to ${openR >= C.PROTECT_PROFIT_LOCK_HALF_R ? 'lock half the open gain' : 'breakeven'}. This is a risk rule, not a read of structure.`
      };
      rationale.push(
        `PROTECT_PROFIT available: moving the stop to ${round(proposedStop, 4)} locks ${usd(lockedProfit)} and leaves ${usd(remainingRisk)} of give-back from the current mark.`
      );
    }
  }

  return {
    action,
    protectProfit,
    rationale,
    blockers: blockersOut,
    addition,
    level,
    levelProgress: levelState.progressPct,
    envelope,
    position: {
      id: position.id ?? null,
      asset: position.asset ?? null,
      direction,
      notional,
      entry,
      stop,
      leverage,
      markPrice,
      unrealizedPnl,
      openR,
      riskToStop,
      riskPct: positionRiskPct,
      notionalPct: positionNotionalPct
    },
    openRisk: openRiskState,
    drawdown,
    strategy: preset.key,
    strategyVersion: STRATEGY_VERSION,
    inputsHash: hashInputs({
      v: STRATEGY_VERSION,
      now,
      walletValue: account.walletValue ?? null,
      strategy: preset.key,
      position: {
        id: position.id ?? null,
        direction: position.direction ?? null,
        notional: position.notional ?? null,
        entry: position.entry ?? null,
        stop: position.stop ?? null,
        leverage: position.leverage ?? null,
        unrealizedPnl: position.unrealizedPnl ?? null,
        riskAmount: position.riskAmount ?? null,
        markPrice: position.markPrice ?? null,
        technicalLevel: position.technicalLevel ?? null
      }
    })
  };
}

/* ========================================================================
 * analyzeStrategyPerformance — LEARNING PROPOSALS ONLY
 *
 * Groups closed trades and reports where the account's own record disagrees
 * with the ruleset. It returns PROPOSALS. It mutates NOTHING: no constant, no
 * preset, no level, no envelope. Applying a proposal is a human decision made
 * outside this module, and there is deliberately no function here that applies
 * one.
 *
 * Nothing is proposed below MIN_SAMPLE_FOR_PROPOSAL (20) closed trades in the
 * group, and an UPWARD proposal needs 30. Small samples of trading results are
 * indistinguishable from noise, and a tool that "learns" from twelve trades is
 * curve-fitting with extra steps.
 * ===================================================================== */

function confidenceBand(confidence) {
  if (!isFiniteNumber(confidence)) return 'UNSPECIFIED';
  if (confidence <= 33) return 'LOW';
  if (confidence <= 66) return 'MEDIUM';
  return 'HIGH';
}

function leverageBand(leverage) {
  if (!isPositiveNumber(leverage)) return 'UNSPECIFIED';
  if (leverage <= 1) return '1x';
  if (leverage <= 2) return '1-2x';
  if (leverage <= 3) return '2-3x';
  if (leverage <= 5) return '3-5x';
  return '5x+';
}

function drawdownState(trade) {
  if (typeof trade.drawdownStateAtEntry === 'string') return trade.drawdownStateAtEntry.toUpperCase();
  if (isFiniteNumber(trade.drawdownPctAtEntry)) return trade.drawdownPctAtEntry >= 8 ? 'DRAWDOWN' : 'NORMAL';
  return 'UNSPECIFIED';
}

function proposalConfidence(n) {
  if (n >= 80) return 'HIGH';
  if (n >= 40) return 'MEDIUM';
  return 'LOW';
}

export function analyzeStrategyPerformance({ trades = [] } = {}) {
  const closed = closedTradesAscending(trades);
  if (closed.length === 0) return [];

  const dimensions = [
    { scope: 'strategy', key: (t) => String(t.strategy || 'UNSPECIFIED').toUpperCase() },
    { scope: 'confidenceBand', key: (t) => confidenceBand(t.confidence) },
    { scope: 'level', key: (t) => (Number.isFinite(t.level) ? `level ${clampLevel(t.level)}` : 'UNSPECIFIED') },
    { scope: 'leverageBand', key: (t) => leverageBand(t.leverage) },
    { scope: 'drawdownState', key: (t) => drawdownState(t) }
  ];

  const groups = [];
  for (const dimension of dimensions) {
    const buckets = new Map();
    for (const trade of closed) {
      const key = dimension.key(trade);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(trade);
    }
    for (const [key, list] of buckets) {
      if (key === 'UNSPECIFIED') continue;
      groups.push({ scope: dimension.scope, key, trades: list });
    }
  }

  const proposals = [];

  for (const group of groups) {
    const n = group.trades.length;
    if (n < C.MIN_SAMPLE_FOR_PROPOSAL) continue;

    const rs = group.trades.map((t) => tradeR(t).r);
    const winsorised = rs.map(winsoriseR);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r < 0);
    const winRate = toPercent(wins.length / n);
    const avgR = winsorised.reduce((a, b) => a + b, 0) / n;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
    const expectancy = (wins.length / n) * avgWin - (losses.length / n) * avgLoss;

    // Drawdown adjustment: the worst consecutive losing run inside the group,
    // in R. A group with the same average R but a deeper losing run is worse,
    // because that run is what actually forces a demotion.
    let worstRun = 0;
    let run = 0;
    for (const r of rs) {
      if (r < 0) {
        run += Math.abs(r);
        if (run > worstRun) worstRun = run;
      } else {
        run = 0;
      }
    }
    const drawdownAdjustedAvgR = avgR / (1 + worstRun / 10);

    const scopeLabel = `${group.scope} = ${group.key}`;
    const confidence = proposalConfidence(n);

    if (expectancy <= C.PROPOSAL_BAD_EXPECTANCY_R) {
      proposals.push({
        id: `reduce:${group.scope}:${group.key}`,
        scope: scopeLabel,
        current: 'Full envelope for this group',
        proposed: `Apply a 0.75x risk multiplier when ${scopeLabel}`,
        reason: `Expectancy ${round(expectancy, 3)}R over ${n} closed trades (win rate ${round(winRate, 1)}%, winsorised average ${round(avgR, 3)}R, drawdown-adjusted ${round(drawdownAdjustedAvgR, 3)}R, worst losing run ${round(worstRun, 2)}R). This group has been a net cost.`,
        sampleSize: n,
        confidence
      });
    } else if (expectancy >= C.PROPOSAL_GOOD_EXPECTANCY_R && n >= C.MIN_SAMPLE_FOR_UPWARD_PROPOSAL) {
      proposals.push({
        id: `increase:${group.scope}:${group.key}`,
        scope: scopeLabel,
        current: 'Full envelope for this group',
        proposed: `Consider a 1.15x risk multiplier when ${scopeLabel}, capped by the level envelope`,
        reason: `Expectancy ${round(expectancy, 3)}R over ${n} closed trades (win rate ${round(winRate, 1)}%, winsorised average ${round(avgR, 3)}R, drawdown-adjusted ${round(drawdownAdjustedAvgR, 3)}R). Upward proposals are deliberately small and never override the level envelope; a favourable sample of ${n} trades is still a small sample.`,
        sampleSize: n,
        confidence
      });
    }
  }

  // Deterministic ordering: largest sample first, then id.
  proposals.sort((a, b) => (b.sampleSize - a.sampleSize) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return proposals;
}

/* ========================================================================
 * DEFAULT EXPORT
 * ===================================================================== */

export default {
  STRATEGY_PRESETS,
  LEVELS,
  STRATEGY_VERSION,
  ADAPTIVE_CONSTANTS,
  getLevelDefinition,
  hashInputs,
  calculateAdjustedEquity,
  buildEquityCurve,
  calculateDrawdown,
  calculateRecentPerformance,
  calculateRiskLevel,
  calculateLevelProgress,
  calculateOpenRisk,
  calculateDirectionalConcentration,
  calculateStrategyEnvelope,
  calculateConfidenceMultiplier,
  evaluateNoTradeConstraints,
  recommendTrade,
  evaluatePosition,
  analyzeStrategyPerformance
};
