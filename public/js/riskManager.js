/**
 * EditTrades Risk Manager
 * -----------------------
 * The pre-trade risk layer. Answers one question fast:
 *
 *   "I have $X in my trading wallet. I want to enter here and stop here.
 *    How large should this position be?"
 *
 * This module is PURE. No network, no clock, no randomness, no AI. Given the
 * same inputs it always produces the same numbers, which is what makes it
 * safe to base sizing decisions on.
 *
 * It is DECISION SUPPORT ONLY. Nothing here places a trade, connects to an
 * exchange, or modifies a position.
 *
 * ==========================================================================
 * RISK vs EXPOSURE — the distinction the whole module is built around
 * ==========================================================================
 *
 *   EXPOSURE  the market value the position controls.        e.g. $10,000
 *   RISK      what is lost if the planned stop executes.     e.g.    $250
 *   MARGIN    the capital posted to hold the position.       e.g.  $5,000
 *
 * A $10,000 position is NOT $10,000 of risk. Conflating position size with
 * capital at risk is the single most common sizing error, so these three are
 * computed separately and never collapsed into one number.
 *
 * LEVERAGE reduces the MARGIN required to hold a position. It does not change
 * the loss taken at the stop, and it is never a reason to size up. What it
 * does change is how close the liquidation price sits to the entry.
 *
 * ==========================================================================
 * UNITS
 * ==========================================================================
 * Percentages in config and in policy are PERCENT NUMBERS (1 = 1%), because
 * that is how the settings are written and read by a person. Internally every
 * calculation converts once via toFraction(). Outputs carry both a percent
 * field and an absolute dollar field so callers never have to guess.
 */

/* ========================================================================
 * DEFAULT POLICY
 *
 * Starting presets, not universal truths. Every value is user-configurable.
 * These reflect widely taught conventions rather than anything proprietary,
 * and no claim is made that they are optimal for any particular trader.
 * ===================================================================== */
export const DEFAULT_RISK_POLICY = {
  version: '1.0.0',

  /**
   * Risk applied to a new trade unless the user overrides it, in percent.
   *
   * 1% is Van Tharp's canonical percent-risk value and the Turtles' unit size
   * (1 unit = 1N = 1% of equity). At 1% risk of ruin is negligible for any
   * positive-expectancy strategy and the account survives a long losing run.
   *
   * Note this is deep fractional Kelly, NOT growth-optimal. It is a survival
   * and parameter-uncertainty choice, and is not claimed to maximise returns.
   */
  defaultRiskPerTradePct: 1.0,

  /**
   * Hard ceiling for a single trade's risk, in percent.
   *
   * Elder's 2% Rule. Note the two values above play genuinely different roles
   * and are not a range to split: 1% is a steady-state TARGET, 2% is a
   * CEILING (Elder frames it against prior month-end equity). Above 2%,
   * probability of ruin turns exponential rather than linear.
   */
  maxRiskPerTradePct: 2.0,

  /**
   * "Portfolio heat": combined risk across every open and planned position if
   * they all stopped out at once, in percent of the trading wallet.
   *
   * 6% is Elder's 6% Rule — the canonical figure, and exactly 6x the 1%
   * default. The honest range in the literature is 6-12%: the Turtle lineage
   * permits up to ~12 units (~12%) in one direction. 6% is the conservative
   * end, and brackets sensibly against prop-firm 5% daily-loss limits.
   */
  maxTotalOpenRiskPct: 6.0,

  /**
   * Ceiling on combined risk pointing the SAME direction, in percent.
   *
   * Implements the Turtle structure: a correlated basket is allowed 6 units
   * against 4 for a single market — 1.5x, not additive. Same-direction crypto
   * perps are assumed correlated with NO diversification credit, because
   * correlations converge toward 1.0 precisely during drawdowns (BTC-SOL has
   * printed 0.99 on a weekly window during stress). Granting credit from a
   * calm-window correlation would understate heat exactly when it binds.
   */
  maxCorrelatedDirectionRiskPct: 4.0,

  /**
   * Ceiling on capital committed as margin, in percent of wallet.
   * NOTE this governs MARGIN UTILISATION, not notional. Notional exposure is
   * tracked separately (see maxNotionalExposurePct) because with leverage the
   * two diverge sharply and a single "exposure" number would be ambiguous.
   */
  maxMarginUtilizationPct: 30.0,

  /**
   * Ceiling on total notional as percent of wallet. null disables it.
   *
   * 200% (2x effective) follows the only citable authorities on crypto
   * leverage for retail: ESMA's product intervention caps crypto CFDs at 2:1,
   * and Japan's FSA moved to a 2x cap. There is no equivalent figure in the
   * trading literature — Tharp, Elder and the Turtles say nothing about
   * aggregate notional — so this is borrowed from securities regulation and
   * should be read as a backstop rather than a derived optimum.
   *
   * It earns its place by catching a case every other check passes: a very
   * tight stop sizes to an enormous notional at nominally "1% risk", leaving
   * the position one ordinary wick from liquidation.
   */
  maxNotionalExposurePct: 200,

  /**
   * Ceiling on leverage for any single position.
   *
   * 3x. ESMA (2:1) and Japan FSA (2x) are the anchors; retail CFD brokers sit
   * at 2:1-5:1. The quantitative case: liquidation distance is roughly
   * (1/leverage - maintenance rate), so at 3x liquidation sits ~33% away —
   * about 8 daily sigma for SOL — whereas at 20x it sits ~4.5% away, roughly
   * ONE ordinary daily move for SOL. That is the honest definition of
   * dangerous, and it is what the October 2025 cascade (~$19B liquidated
   * across ~1.6M accounts in hours) actually looked like.
   */
  maxLeverage: 3.0,

  /** Concentration detection. */
  concentration: {
    /**
     * BREADTH rule: this many positions pointing the same way. Catches the
     * classic "BTC long + ETH long + SOL long" book.
     */
    minPositions: 3,
    /**
     * DEPTH rule: same-direction risk at or above this share of total open
     * risk, with at least 2 positions. Catches a couple of oversized
     * correlated bets that the count rule would miss.
     *
     * Set high (80%) deliberately. In any three-position book, two
     * same-direction positions will almost always carry more than 60% of the
     * risk, so a lower threshold degenerates into "you hold two positions the
     * same way" and fires on ordinary, partially-hedged books. At 80% it means
     * something specific: four fifths of open risk points one direction.
     */
    riskShareThresholdPct: 80,
    minPositionsForShareRule: 2
  },

  /** Liquidation safety buffer. */
  liquidation: {
    /**
     * Estimated maintenance margin rate, in percent of notional. Real rates
     * are tiered by position size and differ per venue and instrument, which
     * is exactly why the output is labelled an ESTIMATE.
     */
    maintenanceMarginRatePct: 0.5,
    /**
     * The stop should sit meaningfully before liquidation. If the gap between
     * stop and estimated liquidation is under this share of the stop
     * distance, warn.
     */
    minBufferAsShareOfStopDistancePct: 25
  },

  /**
   * Optional execution assumptions. A planned stop is not a guaranteed
   * maximum loss, and these let the user see roughly how far off it can be.
   * All default to zero so the headline number stays the clean planned figure
   * until the user opts in. See SUGGESTED_COST_ASSUMPTIONS for researched
   * values the ADVANCED panel can apply in one click.
   */
  costs: {
    takerFeePct: 0,
    slippagePct: 0,
    fundingPctPerDay: 0
  }
};

/**
 * Researched, citable execution assumptions. Offered as a preset rather than
 * a default so the headline risk figure stays the clean planned number until
 * the user asks for cost-adjusted output.
 */
export const SUGGESTED_COST_ASSUMPTIONS = {
  majors: {
    label: 'BTC / ETH majors',
    // Binance and OKX base-tier perp taker is 0.050%, Bybit 0.055%.
    takerFeePct: 0.05,
    // Weakest-sourced input. Published figures are mostly slippage TOLERANCE
    // settings rather than expected cost; this is an assumption, not a
    // measurement.
    slippagePct: 0.05,
    // 0.01% per 8h = 0.03%/day. This is Binance's structural interest
    // component AND within ~10% of BTC perp's 2024 realised mean (10.24%
    // annualised), which makes it unusually well anchored.
    fundingPctPerDay: 0.03
  },
  alts: {
    label: 'Alts',
    takerFeePct: 0.055,
    slippagePct: 0.25,
    fundingPctPerDay: 0.03
  },
  stress: {
    label: 'Stress case',
    takerFeePct: 0.055,
    slippagePct: 0.5,
    // Funding is clamped at +/-0.05% per 8h on most contracts = 0.15%/day.
    fundingPctPerDay: 0.15
  }
};

/** Valuation-style status labels. Deliberately never "SAFE". */
export const RISK_STATUS = {
  WITHIN_PLAN: 'WITHIN PLAN',
  CAUTION: 'CAUTION',
  ABOVE_PLAN: 'ABOVE PLAN',
  INCOMPLETE: 'INCOMPLETE'
};

export const TRADE_STATUS = ['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED'];

/* ========================================================================
 * HELPERS
 * ===================================================================== */

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Percent number (1 = 1%) to fraction (0.01). */
function toFraction(percent) {
  return percent / 100;
}

/** Fraction (0.01) to percent number (1). */
function toPercent(fraction) {
  return fraction * 100;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeDirection(direction) {
  if (typeof direction !== 'string') return null;
  const upper = direction.trim().toUpperCase();
  if (upper === 'LONG' || upper === 'BUY') return 'LONG';
  if (upper === 'SHORT' || upper === 'SELL') return 'SHORT';
  return null;
}

/* ========================================================================
 * CORE CALCULATIONS
 * ===================================================================== */

/**
 * Distance from entry to stop, as a fraction of entry.
 *
 * Validates that the stop is on the correct side of entry: a long stops
 * BELOW entry, a short stops ABOVE. A stop on the wrong side is a real user
 * error (usually a typo or a confused direction) and must be rejected rather
 * than silently absolute-valued into a plausible-looking number.
 *
 * @returns {{ valid: boolean, distance?: number, distancePct?: number, error?: string }}
 */
export function calculateStopDistance({ entry, stop, direction }) {
  const dir = normalizeDirection(direction);
  if (!dir) return { valid: false, error: 'Direction must be LONG or SHORT' };
  if (!isPositiveNumber(entry)) return { valid: false, error: 'Entry must be a positive number' };
  if (!isPositiveNumber(stop)) return { valid: false, error: 'Stop must be a positive number' };
  if (entry === stop) return { valid: false, error: 'Stop cannot equal entry' };

  if (dir === 'LONG' && stop > entry) {
    return { valid: false, error: 'For a LONG, the stop must be below entry' };
  }
  if (dir === 'SHORT' && stop < entry) {
    return { valid: false, error: 'For a SHORT, the stop must be above entry' };
  }

  const perUnit = Math.abs(entry - stop);
  const distance = perUnit / entry;

  return {
    valid: true,
    direction: dir,
    perUnit,
    distance,
    distancePct: toPercent(distance)
  };
}

/**
 * The dollar amount the policy permits losing on this trade.
 *
 * @returns {{ valid: boolean, allowedRisk?: number, riskPct?: number, cappedByPolicy?: boolean }}
 */
export function calculateAllowedRisk({ walletBalance, riskPct, policy = DEFAULT_RISK_POLICY }) {
  if (!isPositiveNumber(walletBalance)) {
    return { valid: false, error: 'Trading wallet balance must be a positive number' };
  }

  const requested = isPositiveNumber(riskPct) ? riskPct : policy.defaultRiskPerTradePct;
  if (!isPositiveNumber(requested)) {
    return { valid: false, error: 'Risk percent must be a positive number' };
  }

  // The requested risk is honoured as-is. Exceeding the policy ceiling is
  // surfaced as a warning by evaluateRiskPolicy rather than silently clamped:
  // quietly resizing someone's trade is worse than telling them.
  const exceedsPolicy = requested > policy.maxRiskPerTradePct;

  return {
    valid: true,
    riskPct: requested,
    allowedRisk: walletBalance * toFraction(requested),
    policyMaxPct: policy.maxRiskPerTradePct,
    exceedsPolicy
  };
}

/**
 * Position size implied by the risk budget and the stop distance.
 *
 *   notional = allowedRisk / stopDistance
 *
 * which guarantees, by construction, that the loss at the stop equals the
 * risk budget:  notional x stopDistance = allowedRisk.
 *
 * Note the stop distance drives size, NOT leverage. A tighter stop permits a
 * larger position for identical dollar risk. That is the correct behaviour,
 * though a very tight stop trades sizing efficiency for a higher chance of
 * being stopped out by noise, which the caller surfaces as a warning.
 */
export function calculatePositionSize({ allowedRisk, stopDistance, entry }) {
  if (!isPositiveNumber(allowedRisk)) {
    return { valid: false, error: 'Allowed risk must be a positive number' };
  }
  if (!isPositiveNumber(stopDistance)) {
    return { valid: false, error: 'Stop distance must be a positive number' };
  }
  if (!isPositiveNumber(entry)) {
    return { valid: false, error: 'Entry must be a positive number' };
  }

  const notional = allowedRisk / stopDistance;
  const units = notional / entry;

  return {
    valid: true,
    notional,
    units,
    // Recomputed from units rather than reusing allowedRisk, so any drift in
    // the arithmetic shows up instead of being assumed away.
    lossAtStop: units * entry * stopDistance
  };
}

/**
 * Margin required to hold a notional position at a given leverage.
 * Leverage reduces capital posted. It does not reduce the loss at the stop.
 */
export function calculateRequiredMargin({ notional, leverage = 1 }) {
  if (!isPositiveNumber(notional)) {
    return { valid: false, error: 'Notional must be a positive number' };
  }
  if (!isPositiveNumber(leverage)) {
    return { valid: false, error: 'Leverage must be a positive number' };
  }
  return {
    valid: true,
    margin: notional / leverage,
    leverage,
    notional
  };
}

/**
 * Estimated liquidation price.
 *
 * Deliberately an ESTIMATE. Real liquidation depends on the venue's
 * maintenance-margin tiers, isolated vs cross margin, mark-price versus
 * last-price marking, accrued funding, and unrealised PnL from other
 * positions. No single formula covers those, so this returns an approximation
 * for an ISOLATED position and flags itself as such. Callers must label it
 * "EST. LIQUIDATION" and must not present it with false precision.
 *
 * Isolated approximation:
 *   LONG   liq ~= entry x (1 - 1/leverage + maintenanceRate)
 *   SHORT  liq ~= entry x (1 + 1/leverage - maintenanceRate)
 *
 * At 1x there is no liquidation for a long (price would have to reach zero),
 * so null is returned with a reason rather than a misleading number.
 */
export function estimateLiquidation({ entry, direction, leverage = 1, policy = DEFAULT_RISK_POLICY }) {
  const dir = normalizeDirection(direction);
  if (!dir) return { available: false, reason: 'Direction must be LONG or SHORT' };
  if (!isPositiveNumber(entry)) return { available: false, reason: 'Entry must be a positive number' };
  if (!isPositiveNumber(leverage)) return { available: false, reason: 'Leverage must be a positive number' };

  const maintenanceRate = toFraction(policy.liquidation.maintenanceMarginRatePct);

  if (leverage <= 1) {
    return {
      available: false,
      reason: dir === 'LONG'
        ? 'No liquidation at 1x — an unleveraged long is only lost if price reaches zero'
        : 'Unleveraged short liquidation depends on the venue and collateral model',
      isEstimate: true
    };
  }

  const move = 1 / leverage - maintenanceRate;
  const price = dir === 'LONG' ? entry * (1 - move) : entry * (1 + move);

  if (!isPositiveNumber(price)) {
    return { available: false, reason: 'Leverage too high to estimate a meaningful liquidation price', isEstimate: true };
  }

  return {
    available: true,
    isEstimate: true,
    price,
    distance: Math.abs(entry - price) / entry,
    distancePct: toPercent(Math.abs(entry - price) / entry),
    assumptions: {
      marginMode: 'isolated',
      maintenanceMarginRatePct: policy.liquidation.maintenanceMarginRatePct,
      /**
       * Each caveat maps to a specific mechanism that breaks the closed form,
       * not defensive boilerplate. Exchanges call their own displayed figure
       * an estimate; a third-party pre-trade tool cannot do better.
       */
      caveats: [
        'Assumes isolated margin and a single position. Under cross margin, liquidation is an account-level quantity that moves whenever any other position moves.',
        `Assumes a ${policy.liquidation.maintenanceMarginRatePct}% maintenance margin rate. Real rates are tiered by position size and differ per venue and symbol.`,
        'Exchanges liquidate on mark price, not last price. During a wick these diverge exactly when it matters.',
        'Excludes funding and fees, so the real liquidation price drifts over time even with no price movement.',
        'Never use this as a stop-loss.'
      ]
    }
  };
}

/**
 * Risk / reward from the planned target.
 *
 * Secondary to account risk by design: a high R:R does not make an oversized
 * or badly-structured trade acceptable.
 */
export function calculateRiskReward({ entry, stop, target, direction }) {
  const dir = normalizeDirection(direction);
  if (!dir) return { available: false, reason: 'Direction must be LONG or SHORT' };
  if (!isPositiveNumber(target)) return { available: false, reason: 'No target supplied' };

  const stopCheck = calculateStopDistance({ entry, stop, direction: dir });
  if (!stopCheck.valid) return { available: false, reason: stopCheck.error };

  // The target has a correct side too: above entry for a long, below for a short.
  if (dir === 'LONG' && target <= entry) {
    return { available: false, reason: 'For a LONG, the target must be above entry' };
  }
  if (dir === 'SHORT' && target >= entry) {
    return { available: false, reason: 'For a SHORT, the target must be below entry' };
  }

  const riskPerUnit = stopCheck.perUnit;
  const rewardPerUnit = Math.abs(target - entry);
  const ratio = rewardPerUnit / riskPerUnit;

  return {
    available: true,
    riskPerUnit,
    rewardPerUnit,
    ratio,
    label: `1 : ${round(ratio, 1)}`,
    targetDistancePct: toPercent(rewardPerUnit / entry)
  };
}

/**
 * Optional execution-cost estimate.
 *
 * Makes explicit that a planned stop is not a guaranteed maximum loss. Fees
 * are charged on entry and exit; slippage is applied at the stop; funding
 * accrues on notional while the position is held.
 */
export function estimateExecutionCosts({ notional, holdingDays = 0, policy = DEFAULT_RISK_POLICY }) {
  const { takerFeePct, slippagePct, fundingPctPerDay } = policy.costs;
  if (!isPositiveNumber(notional)) return { applied: false, total: 0 };

  const fees = notional * toFraction(takerFeePct) * 2; // entry + exit
  const slippage = notional * toFraction(slippagePct);
  const funding = notional * toFraction(fundingPctPerDay) * Math.max(0, holdingDays);
  const total = fees + slippage + funding;

  return {
    applied: total > 0,
    fees,
    slippage,
    funding,
    total,
    note: 'Planned stop loss is not a guaranteed maximum loss. Gaps and thin liquidity can exceed it.'
  };
}

/* ========================================================================
 * PORTFOLIO LEVEL
 * ===================================================================== */

/**
 * Aggregate risk across positions.
 *
 * "Open risk" is the loss if EVERY position stops out at once. It is the
 * number that actually constrains how many trades can be on at the same time.
 *
 * @param {Array} positions - objects carrying { plannedRisk, direction, status }
 */
export function calculatePortfolioRisk({ positions = [], walletBalance, policy = DEFAULT_RISK_POLICY }) {
  const live = positions.filter(
    (p) => p && (p.status === 'PLANNED' || p.status === 'OPEN') && isPositiveNumber(p.plannedRisk)
  );

  const openRisk = live.reduce((sum, p) => sum + p.plannedRisk, 0);
  const openRiskPct = isPositiveNumber(walletBalance) ? toPercent(openRisk / walletBalance) : null;

  return {
    positionCount: live.length,
    openRisk,
    openRiskPct,
    policyMaxPct: policy.maxTotalOpenRiskPct,
    exceedsPolicy: openRiskPct !== null && openRiskPct > policy.maxTotalOpenRiskPct,
    positions: live
  };
}

/**
 * Capital committed and market value controlled.
 *
 * Reported as two separate figures on purpose. With leverage they diverge,
 * and collapsing them into one "exposure" number would hide precisely the
 * thing the user needs to see.
 */
export function calculateExposure({ positions = [], walletBalance, policy = DEFAULT_RISK_POLICY }) {
  const live = positions.filter((p) => p && (p.status === 'PLANNED' || p.status === 'OPEN'));

  const marginUsed = live.reduce((sum, p) => sum + (isPositiveNumber(p.margin) ? p.margin : 0), 0);
  const notionalExposure = live.reduce((sum, p) => sum + (isPositiveNumber(p.notional) ? p.notional : 0), 0);

  const marginUtilizationPct = isPositiveNumber(walletBalance)
    ? toPercent(marginUsed / walletBalance)
    : null;
  const notionalExposurePct = isPositiveNumber(walletBalance)
    ? toPercent(notionalExposure / walletBalance)
    : null;

  const available = isPositiveNumber(walletBalance) ? walletBalance - marginUsed : null;

  return {
    marginUsed,
    notionalExposure,
    marginUtilizationPct,
    notionalExposurePct,
    available,
    policyMaxMarginPct: policy.maxMarginUtilizationPct,
    exceedsMarginPolicy:
      marginUtilizationPct !== null && marginUtilizationPct > policy.maxMarginUtilizationPct,
    exceedsNotionalPolicy:
      policy.maxNotionalExposurePct !== null &&
      notionalExposurePct !== null &&
      notionalExposurePct > policy.maxNotionalExposurePct
  };
}

/**
 * Directional concentration.
 *
 * Three crypto longs are not three independent bets. v1 deliberately does not
 * attempt a correlation matrix; it detects the obvious case — several
 * positions pointing the same way — which is what actually bites. Measured
 * rolling correlations can replace this later without changing the interface.
 */
export function detectCorrelatedExposure({ positions = [], policy = DEFAULT_RISK_POLICY }) {
  const live = positions.filter(
    (p) => p && (p.status === 'PLANNED' || p.status === 'OPEN') && isPositiveNumber(p.plannedRisk)
  );

  if (live.length === 0) {
    return { concentrated: false, direction: null, count: 0, riskSharePct: null, positions: [] };
  }

  const settings = policy.concentration;
  const totalRisk = live.reduce((sum, p) => sum + p.plannedRisk, 0);

  // Always report the dominant direction's stats, whether or not it trips a
  // rule. The correlated heat cap is evaluated against directionRisk
  // independently, so it must be populated even for an unflagged book.
  let dominant = {
    concentrated: false,
    direction: null,
    count: 0,
    directionRisk: 0,
    riskSharePct: null,
    positions: []
  };

  for (const direction of ['LONG', 'SHORT']) {
    const matching = live.filter((p) => normalizeDirection(p.direction) === direction);
    if (matching.length === 0) continue;

    const directionRisk = matching.reduce((sum, p) => sum + p.plannedRisk, 0);
    const riskSharePct = totalRisk > 0 ? toPercent(directionRisk / totalRisk) : 0;

    // Breadth: several positions the same way.
    const byCount = matching.length >= settings.minPositions;

    // Depth: a couple carrying overwhelming one-way risk.
    //
    // Requires at least three positions in the book overall. In a two-position
    // book the dominant direction is trivially 100% whenever both point the
    // same way, so without this the rule would warn on essentially every small
    // crypto book and become noise. Size is not lost by skipping it: two
    // oversized correlated positions are caught by the correlated heat cap
    // (maxCorrelatedDirectionRiskPct), which is the condition that actually
    // matters. This rule is about composition, not magnitude.
    const bookIsDiverseEnoughToJudgeShare = live.length >= settings.minPositions;
    const byShare =
      bookIsDiverseEnoughToJudgeShare &&
      matching.length >= settings.minPositionsForShareRule &&
      riskSharePct >= settings.riskShareThresholdPct;

    const concentrated = byCount || byShare;

    // The dominant direction is the one carrying the most risk, so the heat
    // cap is always judged against the heavier side.
    if (directionRisk > dominant.directionRisk) {
      dominant = {
        concentrated,
        direction,
        count: matching.length,
        directionRisk,
        riskSharePct,
        trigger: concentrated ? (byCount ? 'position-count' : 'risk-share') : null,
        label: concentrated ? `CORRELATED ${direction} EXPOSURE` : null,
        positions: matching.map((p) => p.asset || p.symbol).filter(Boolean)
      };
    }
  }

  return dominant;
}

/* ========================================================================
 * POLICY EVALUATION
 * ===================================================================== */

/**
 * Deterministic pre-trade checklist.
 *
 * Never blocks. This is decision support: it states plainly what is outside
 * the user's own policy and leaves the decision with them.
 *
 * @returns {{ status, passed, total, checks: Array }}
 */
export function evaluateRiskPolicy({
  trade,
  portfolioAfter,
  exposureAfter,
  concentration,
  liquidation,
  walletBalance,
  policy = DEFAULT_RISK_POLICY
}) {
  const checks = [];

  const add = (id, label, state, detail) => checks.push({ id, label, state, detail });

  // 1. Single-trade risk
  if (trade && Number.isFinite(trade.riskPct)) {
    const over = trade.riskPct > policy.maxRiskPerTradePct;
    add(
      'position-risk',
      'Position risk within policy',
      over ? 'fail' : 'pass',
      `${round(trade.riskPct, 2)}% of wallet vs ${policy.maxRiskPerTradePct}% max`
    );
  } else {
    add('position-risk', 'Position risk within policy', 'unknown', 'Risk not calculated');
  }

  // 2. Total open risk including this trade
  if (portfolioAfter && Number.isFinite(portfolioAfter.openRiskPct)) {
    const over = portfolioAfter.openRiskPct > policy.maxTotalOpenRiskPct;
    add(
      'portfolio-risk',
      'Total open risk within policy',
      over ? 'fail' : 'pass',
      `${round(portfolioAfter.openRiskPct, 2)}% vs ${policy.maxTotalOpenRiskPct}% max`
    );
  } else {
    add('portfolio-risk', 'Total open risk within policy', 'unknown', 'Portfolio risk unavailable');
  }

  // 3. Margin utilisation
  if (exposureAfter && Number.isFinite(exposureAfter.marginUtilizationPct)) {
    const over = exposureAfter.marginUtilizationPct > policy.maxMarginUtilizationPct;
    add(
      'exposure',
      'Exposure within policy',
      over ? 'fail' : 'pass',
      `${round(exposureAfter.marginUtilizationPct, 1)}% margin used vs ${policy.maxMarginUtilizationPct}% max`
    );
  } else {
    add('exposure', 'Exposure within policy', 'unknown', 'Exposure unavailable');
  }

  // 4. Leverage
  if (trade && Number.isFinite(trade.leverage)) {
    const over = trade.leverage > policy.maxLeverage;
    add(
      'leverage',
      'Leverage within policy',
      over ? 'fail' : 'pass',
      `${round(trade.leverage, 2)}x vs ${policy.maxLeverage}x max`
    );
  } else {
    add('leverage', 'Leverage within policy', 'unknown', 'Leverage not set');
  }

  // 5. Stop before estimated liquidation
  if (liquidation && liquidation.available && trade && isPositiveNumber(trade.stop)) {
    const dir = normalizeDirection(trade.direction);
    // A long liquidates below the stop; a short liquidates above it.
    const stopIsFirst = dir === 'LONG' ? trade.stop > liquidation.price : trade.stop < liquidation.price;
    const gap = Math.abs(trade.stop - liquidation.price) / trade.entry;
    const stopDistance = Math.abs(trade.entry - trade.stop) / trade.entry;
    const bufferShare = stopDistance > 0 ? toPercent(gap / stopDistance) : 0;
    const tooClose = bufferShare < policy.liquidation.minBufferAsShareOfStopDistancePct;

    add(
      'liquidation',
      'Stop before estimated liquidation',
      !stopIsFirst ? 'fail' : tooClose ? 'warn' : 'pass',
      !stopIsFirst
        ? `Est. liquidation ${round(liquidation.price, 2)} would trigger before the stop`
        : `Est. liquidation ${round(liquidation.price, 2)}, buffer ${round(bufferShare, 0)}% of stop distance`
    );
  } else {
    add(
      'liquidation',
      'Stop before estimated liquidation',
      'unknown',
      liquidation && liquidation.reason ? liquidation.reason : 'Liquidation not estimable'
    );
  }

  // 6. Margin available
  if (trade && Number.isFinite(trade.margin) && isPositiveNumber(walletBalance) && exposureAfter) {
    const insufficient = exposureAfter.marginUsed > walletBalance;
    add(
      'margin-available',
      'Margin available',
      insufficient ? 'fail' : 'pass',
      insufficient
        ? `Requires ${round(exposureAfter.marginUsed, 2)} against a ${round(walletBalance, 2)} wallet`
        : `${round(exposureAfter.available, 2)} remaining after this trade`
    );
  } else {
    add('margin-available', 'Margin available', 'unknown', 'Margin not calculated');
  }

  // 7. Directional concentration.
  // Two distinct conditions: the cluster being flagged at all (a warning),
  // and same-direction heat exceeding the correlated cap (a breach). The
  // second is stronger because it says the correlated basket is oversized in
  // absolute terms, not merely lopsided relative to the rest of the book.
  if (concentration) {
    const directionRiskPct =
      isPositiveNumber(walletBalance) && Number.isFinite(concentration.directionRisk)
        ? toPercent(concentration.directionRisk / walletBalance)
        : null;
    const overCorrelatedCap =
      directionRiskPct !== null && directionRiskPct > policy.maxCorrelatedDirectionRiskPct;

    add(
      'concentration',
      'Directional concentration',
      overCorrelatedCap ? 'fail' : concentration.concentrated ? 'warn' : 'pass',
      overCorrelatedCap
        ? `${round(directionRiskPct, 2)}% of wallet risked ${concentration.direction} vs ${policy.maxCorrelatedDirectionRiskPct}% correlated cap`
        : concentration.concentrated
          ? `${concentration.count} ${concentration.direction} positions, ${round(concentration.riskSharePct, 0)}% of open risk`
          : 'No obvious directional concentration'
    );
  } else {
    add('concentration', 'Directional concentration', 'unknown', 'Positions unavailable');
  }

  const passed = checks.filter((c) => c.state === 'pass').length;
  const failed = checks.filter((c) => c.state === 'fail').length;
  const warned = checks.filter((c) => c.state === 'warn').length;
  const unknown = checks.filter((c) => c.state === 'unknown').length;

  // Status precedence: a hard breach outranks a warning, and missing inputs
  // outrank a clean pass so an incomplete form never reads as approved.
  let status;
  if (failed > 0) status = RISK_STATUS.ABOVE_PLAN;
  else if (unknown > 0 && passed < 3) status = RISK_STATUS.INCOMPLETE;
  else if (warned > 0 || unknown > 0) status = RISK_STATUS.CAUTION;
  else status = RISK_STATUS.WITHIN_PLAN;

  return { status, passed, failed, warned, unknown, total: checks.length, checks };
}

/* ========================================================================
 * ORCHESTRATION
 * ===================================================================== */

/**
 * The main entry point: plan one trade against the wallet, policy and any
 * existing positions, and return everything the UI needs in one object.
 *
 * @param {Object} input
 * @param {number} input.walletBalance
 * @param {Object} input.trade   { asset, direction, entry, stop, target, leverage, riskPct, notionalOverride }
 * @param {Array}  input.positions existing PLANNED/OPEN positions
 * @param {Object} input.policy
 * @param {number} input.holdingDays for optional funding estimate
 */
export function planTrade({
  walletBalance,
  trade = {},
  positions = [],
  policy = DEFAULT_RISK_POLICY,
  holdingDays = 0
}) {
  const errors = [];
  const direction = normalizeDirection(trade.direction);
  const leverage = isPositiveNumber(trade.leverage) ? trade.leverage : 1;

  // --- Validate and size -------------------------------------------------
  const stopCheck = calculateStopDistance({
    entry: trade.entry,
    stop: trade.stop,
    direction: trade.direction
  });
  if (!stopCheck.valid) errors.push(stopCheck.error);

  const riskCheck = calculateAllowedRisk({ walletBalance, riskPct: trade.riskPct, policy });
  if (!riskCheck.valid) errors.push(riskCheck.error);

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      status: RISK_STATUS.INCOMPLETE,
      policy
    };
  }

  let sizing = calculatePositionSize({
    allowedRisk: riskCheck.allowedRisk,
    stopDistance: stopCheck.distance,
    entry: trade.entry
  });
  if (!sizing.valid) {
    return { valid: false, errors: [sizing.error], status: RISK_STATUS.INCOMPLETE, policy };
  }

  // The user may drive size directly instead of risk. When they do, notional
  // becomes the input and the resulting dollar risk is derived from it, so the
  // slider always shows the true consequence of the size they chose.
  let effectiveRiskPct = riskCheck.riskPct;
  let allowedRisk = riskCheck.allowedRisk;

  if (isPositiveNumber(trade.notionalOverride)) {
    const notional = trade.notionalOverride;
    const units = notional / trade.entry;
    const lossAtStop = units * stopCheck.perUnit;
    sizing = { valid: true, notional, units, lossAtStop };
    allowedRisk = lossAtStop;
    effectiveRiskPct = toPercent(lossAtStop / walletBalance);
  }

  const marginCheck = calculateRequiredMargin({ notional: sizing.notional, leverage });
  const liquidation = estimateLiquidation({ entry: trade.entry, direction, leverage, policy });
  const riskReward = calculateRiskReward({
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    direction
  });
  const costs = estimateExecutionCosts({ notional: sizing.notional, holdingDays, policy });

  // --- Portfolio impact, before and after -------------------------------
  const prospective = {
    asset: trade.asset || trade.symbol || null,
    direction,
    plannedRisk: allowedRisk,
    margin: marginCheck.margin,
    notional: sizing.notional,
    status: 'PLANNED'
  };

  const portfolioBefore = calculatePortfolioRisk({ positions, walletBalance, policy });
  const exposureBefore = calculateExposure({ positions, walletBalance, policy });

  const withTrade = [...positions, prospective];
  const portfolioAfter = calculatePortfolioRisk({ positions: withTrade, walletBalance, policy });
  const exposureAfter = calculateExposure({ positions: withTrade, walletBalance, policy });
  const concentration = detectCorrelatedExposure({ positions: withTrade, policy });

  const tradeSummary = {
    asset: prospective.asset,
    direction,
    entry: trade.entry,
    stop: trade.stop,
    target: isPositiveNumber(trade.target) ? trade.target : null,
    leverage,
    riskPct: effectiveRiskPct,
    riskAmount: allowedRisk,
    notional: sizing.notional,
    units: sizing.units,
    margin: marginCheck.margin,
    stopDistance: stopCheck.distance,
    stopDistancePct: stopCheck.distancePct,
    lossAtStop: sizing.lossAtStop
  };

  const evaluation = evaluateRiskPolicy({
    trade: tradeSummary,
    portfolioAfter,
    exposureAfter,
    concentration,
    liquidation,
    walletBalance,
    policy
  });

  return {
    valid: true,
    status: evaluation.status,
    trade: tradeSummary,
    liquidation,
    riskReward,
    costs,
    portfolio: { before: portfolioBefore, after: portfolioAfter },
    exposure: { before: exposureBefore, after: exposureAfter },
    concentration,
    evaluation,
    policy,
    walletBalance
  };
}

/**
 * Account-level snapshot for the home-page module and the page header.
 */
export function summarizeAccount({ walletBalance, positions = [], policy = DEFAULT_RISK_POLICY }) {
  const portfolio = calculatePortfolioRisk({ positions, walletBalance, policy });
  const exposure = calculateExposure({ positions, walletBalance, policy });
  const concentration = detectCorrelatedExposure({ positions, policy });

  let status = RISK_STATUS.WITHIN_PLAN;
  if (!isPositiveNumber(walletBalance)) status = RISK_STATUS.INCOMPLETE;
  else if (portfolio.exceedsPolicy || exposure.exceedsMarginPolicy || exposure.exceedsNotionalPolicy) {
    status = RISK_STATUS.ABOVE_PLAN;
  } else if (concentration.concentrated) status = RISK_STATUS.CAUTION;

  return {
    walletBalance: isPositiveNumber(walletBalance) ? walletBalance : null,
    available: exposure.available,
    marginUsed: exposure.marginUsed,
    marginUtilizationPct: exposure.marginUtilizationPct,
    notionalExposure: exposure.notionalExposure,
    notionalExposurePct: exposure.notionalExposurePct,
    openRisk: portfolio.openRisk,
    openRiskPct: portfolio.openRiskPct,
    positionCount: portfolio.positionCount,
    concentration,
    status,
    policy
  };
}

export default {
  DEFAULT_RISK_POLICY,
  RISK_STATUS,
  TRADE_STATUS,
  calculateStopDistance,
  calculateAllowedRisk,
  calculatePositionSize,
  calculateRequiredMargin,
  estimateLiquidation,
  calculateRiskReward,
  estimateExecutionCosts,
  calculatePortfolioRisk,
  calculateExposure,
  detectCorrelatedExposure,
  evaluateRiskPolicy,
  planTrade,
  summarizeAccount
};
