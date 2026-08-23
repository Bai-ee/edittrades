/**
 * Bitcoin Economic Value
 * ----------------------
 * Deterministic valuation module for EditTrades.
 *
 * Answers: "How expensive or cheap is Bitcoin relative to the economic prices
 * that matter to holders, miners and long-term market structure?"
 *
 * This module is PURE. It performs no network I/O, reads no clock for its
 * outputs and contains no randomness. Given identical input rows it always
 * produces identical output, which makes the Economic Value series
 * historically reproducible and inspectable.
 *
 * Data acquisition lives in services/bitcoinDataProviders.js.
 *
 * IMPORTANT SEMANTICS
 * - "Economic Value" is a *reference*, not a true or guaranteed value of
 *   Bitcoin. It is a weighted blend of long-duration economic anchors.
 * - Anchors that are mathematically derived from one another are never both
 *   allowed to drive the composite (see DOUBLE COUNTING below).
 * - Missing inputs produce nulls. Nothing is fabricated or interpolated
 *   across large gaps.
 *
 * DOUBLE COUNTING
 * - MVRV = Market Cap / Realized Cap. It is a transform of Realized Price and
 *   spot price, so it is reported as *context only* and carries no weight in
 *   the composite.
 * - Puell Multiple is a miner *revenue condition* metric (issuance USD vs its
 *   own annual average). It is not a price level, so it is also context only
 *   and is kept conceptually separate from Estimated Miner Production Cost.
 * - The composite therefore draws on three structurally independent families:
 *     1. on-chain aggregate cost basis  (Realized Price)
 *     2. long-duration market structure (200-week moving average)
 *     3. production economics           (Estimated Miner Production Cost)
 */

/* ========================================================================
 * CONFIGURATION
 * All tunables live here so the methodology can be adjusted without
 * touching the calculations. Bump `version` whenever a change alters output.
 * ===================================================================== */
export const ECONOMIC_VALUE_CONFIG = {
  version: '1.0.0',

  /**
   * Composite weights, applied in log space (weighted geometric mean).
   * Weights are renormalised over whichever anchors are available on a
   * given date, so history before an anchor exists is still usable.
   *
   * Rationale for the split:
   *  - realizedPrice carries the most weight: it is a measured aggregate
   *    cost basis, not a derived estimate.
   *  - ma200w is a pure market-structure anchor with a long, clean history.
   *  - minerCost is the most assumption-heavy anchor, so it carries least.
   *  - sth/lth cost basis are OFF by default: no free, reliable provider
   *    exists. Give them weight only if a genuine provider is wired up.
   */
  weights: {
    realizedPrice: 0.45,
    ma200w: 0.35,
    minerCost: 0.20,
    lthRealizedPrice: 0,
    sthRealizedPrice: 0
  },

  /** A composite is only emitted when at least this many anchors are present. */
  minAnchorsForComposite: 2,

  /** 200-week moving average, computed from completed weekly closes. */
  ma200w: {
    weeks: 200,
    /** Week boundary. 1 = Monday (ISO). */
    weekStartsOn: 1
  },

  smoothing: {
    /**
     * Miner cost moves in steps (difficulty retargets, halvings, hashrate
     * spikes). A trailing average removes the sawtooth without shifting the
     * level. Trailing only — never centred — so no look-ahead is introduced.
     */
    minerCostDays: 30,
    /** Light final pass so the composite reads as a slow economic baseline. */
    compositeDays: 14
  },

  /**
   * Estimated Miner Production Cost assumptions. These are ESTIMATES and are
   * surfaced in the API response so the page can show its own workings.
   */
  minerCost: {
    /**
     * Energy cost is only meaningful once mining is industrial. Before the
     * ASIC era the hardware mix (CPU/GPU/FPGA) makes any single efficiency
     * figure misleading, so no miner cost is emitted before this date.
     */
    startDate: '2013-01-01',

    /**
     * Network-average fleet efficiency in joules per terahash.
     * Fleet average, NOT best-in-class: a new flagship ASIC is roughly twice
     * as efficient as the network average that surrounds it.
     * Interpolated log-linearly between anchors, clamped outside the range.
     * Cross-check: 2025 anchor (24 J/TH) x ~800 EH/s implies ~170 TWh/yr,
     * consistent with the Cambridge CBECI best-guess estimate.
     */
    /*
     * SOURCES AND BASIS — this is a MODEL, not network accounting.
     *
     * No exchange or chain publishes fleet-average efficiency; it is not
     * directly observable. Each anchor below is a judgement about the mix of
     * hardware plausibly running that year, bracketed by the flagship machines
     * available at the time (fleet average runs roughly 1.5-2x worse than
     * best-in-class, because old machines stay online while they clear
     * marginal cost):
     *
     *   Antminer S1   (2013-14)  ~2,000 J/TH
     *   Antminer S3   (2014)     ~  771 J/TH
     *   Antminer S5   (2015)     ~  510 J/TH
     *   Antminer S7   (2016)     ~  273 J/TH
     *   Antminer S9   (2016-17)  ~   98 J/TH
     *   Antminer S17  (2019)     ~   45 J/TH
     *   Antminer S19  (2020)     ~   30 J/TH
     *   Antminer S21  (2024)     ~   15 J/TH
     *
     * Only the AGGREGATE is falsifiable: the 2025 anchor (24 J/TH) against
     * ~800 EH/s implies ~170 TWh/yr, which the validation harness checks
     * against a CBECI-scale band. Per-year values cannot be validated to
     * better than roughly +/-30%, which is why the output is labelled
     * EST. MINER COST everywhere and carries 0.20 weight rather than more.
     *
     * The 2013 anchor was 8,000 J/TH, which is far too efficient for its date:
     * in January 2013 the network was still overwhelmingly GPU and FPGA, on
     * the order of 50,000-300,000 J/TH, and the first Avalon ASICs (~9,400
     * J/TH) did not ship until late that month. 30,000 is a defensible
     * transitional figure for a mixed GPU/FPGA/early-ASIC fleet. It sits at
     * the startDate boundary where the model is least trustworthy in any case.
     */
    efficiencyCurveJPerTh: [
      { date: '2013-01-01', value: 30000 },
      { date: '2013-07-01', value: 8000 },
      { date: '2014-01-01', value: 1800 },
      { date: '2015-01-01', value: 750 },
      { date: '2016-01-01', value: 320 },
      { date: '2017-01-01', value: 160 },
      { date: '2018-01-01', value: 110 },
      { date: '2019-01-01', value: 90 },
      { date: '2020-01-01', value: 65 },
      { date: '2021-01-01', value: 50 },
      { date: '2022-01-01', value: 40 },
      { date: '2023-01-01', value: 33 },
      { date: '2024-01-01', value: 28 },
      { date: '2025-01-01', value: 24 },
      { date: '2026-01-01', value: 20 },
      { date: '2027-01-01', value: 18 }
    ],

    /**
     * Representative industrial electricity price in USD per kWh. Miners have
     * migrated toward cheaper power over time, so this is a curve rather than
     * a single present-day figure applied retroactively.
     */
    /*
     * Within the $0.03-0.07/kWh industrial band commonly cited for hosted
     * mining from 2016 onward. The 2013 figure is above that band on purpose:
     * 2013 miners were largely on small-commercial or residential power.
     *
     * NOTE: the last anchor is 2025-01-01, so any date after it is CLAMPED,
     * not interpolated — the curve has been flat for the whole of 2026. The
     * API reports `minerAssumptions.extrapolated` when this is happening.
     */
    electricityCurveUsdPerKwh: [
      { date: '2013-01-01', value: 0.080 },
      { date: '2016-01-01', value: 0.065 },
      { date: '2019-01-01', value: 0.055 },
      { date: '2022-01-01', value: 0.050 },
      { date: '2025-01-01', value: 0.045 }
    ],

    /**
     * Non-energy costs as a multiplier on energy cost: hardware amortisation,
     * hosting, pool fees, staff.
     *
     * Raised from 1.25 to 1.40. Public miner disclosures generally put energy
     * at roughly 60-75% of cash cost, implying 1.35-1.65x; 1.25 implied ~80%,
     * which sits outside that range at the optimistic end. The bias direction
     * matters and was systematic: a low multiplier gives a low miner cost,
     * hence a low Economic Value, hence a HIGH reported premium. At 0.20
     * weight the composite effect is on the order of a few percent.
     *
     * Still an assumption, not a measurement.
     */
    overheadMultiplier: 1.40,

    /**
     * Miner revenue includes fees, but production *cost* should not be
     * credited with them. Fees are excluded by design; issuance alone is the
     * denominator. Documented here so the choice is explicit.
     */
    includeFeesInIssuance: false
  },

  /** Puell Multiple: daily issuance USD divided by its own trailing average. */
  puell: {
    windowDays: 365
  },

  /**
   * Valuation states.
   *
   * Thresholds are NOT hand-picked price percentages. They are percentile cut
   * points of the asset's own historical premium/discount distribution, so
   * the bands self-calibrate to how far Bitcoin has actually traded from its
   * economic anchors. The resolved percentage values are returned in the API
   * response so the calibration is inspectable.
   */
  valuationStates: {
    /** Percentile cut points (0-100) of the historical premium distribution. */
    percentiles: {
      deepDiscount: 5,
      discount: 20,
      nearValue: 55,
      premium: 80,
      extended: 95
    },
    /**
     * Percentile calibration window, in trailing days. null = full history.
     *
     * Defaults to 2,920 days (8 years, two halving cycles) because Bitcoin's
     * pre-2014 deviations come from a structurally different asset and
     * otherwise dominate the distribution. Measured on real Coin Metrics data:
     *
     *   era        median premium   max premium
     *   2010-2013        +941%          +4186%
     *   2014-2017         +97%           +917%
     *   2018-2021         +90%           +611%
     *   2022-2026         +63%           +170%
     *
     * Calibrating on full history pushes the DEEP DISCOUNT band up to +1.6%,
     * which would label Bitcoin trading at a premium a "deep discount". An
     * eight-year window puts every known market moment in the right band:
     * the 2018 and 2022 bear bottoms and the COVID crash read DEEP DISCOUNT,
     * the 2021 top reads EUPHORIC, and the 2024 high reads EXTENDED.
     *
     * Note percentiles are order statistics, so transforming the deviation
     * (log ratio instead of percentage) does not move these cut points at all
     * — only the window does.
     */
    lookbackDays: 2920,
    /** Minimum observations before percentile bands are considered valid. */
    minObservations: 365
  },

  /**
   * Economic convergence: how tightly the underlying anchors cluster.
   * Tight clustering means the anchors agree and the composite is well
   * supported; wide dispersion means it should be read with less confidence.
   */
  convergence: {
    /** An anchor "agrees" when within this fraction of the composite. */
    agreementBand: 0.12,
    /** Spread = (max anchor / min anchor) - 1. */
    highAgreement: { minRatioWithin: 0.75, maxSpread: 0.25 },
    moderateAgreement: { minRatioWithin: 0.50, maxSpread: 0.50 }
  },

  /**
   * Gap handling. Short provider outages are forward-filled; anything longer
   * stays null rather than drawing a misleading straight line through it.
   */
  maxForwardFillDays: 3
};

/** Anchors that participate in the composite, in display order. */
export const COMPOSITE_ANCHOR_KEYS = [
  'realizedPrice',
  'ma200w',
  'minerCost',
  'lthRealizedPrice',
  'sthRealizedPrice'
];

export const ANCHOR_LABELS = {
  realizedPrice: 'REALIZED PRICE',
  ma200w: '200W MA',
  minerCost: 'EST. MINER COST',
  lthRealizedPrice: 'LTH COST BASIS',
  sthRealizedPrice: 'STH COST BASIS'
};

/* ========================================================================
 * SMALL HELPERS
 * ===================================================================== */

const MS_PER_DAY = 86400000;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A usable price level: finite and strictly positive (log space requires it). */
function isPositive(value) {
  return isFiniteNumber(value) && value > 0;
}

/** 'YYYY-MM-DD' -> epoch ms at UTC midnight. */
export function dateToTimestamp(date) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** epoch ms -> 'YYYY-MM-DD' (UTC). */
export function timestampToDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function roundTo(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Trailing simple moving average. Emits null until the window is full, so no
 * partial-window value is ever presented as a complete one.
 */
function trailingSMA(values, window) {
  const out = new Array(values.length).fill(null);
  if (window <= 1) return values.slice();

  let sum = 0;
  let count = 0;
  const buffer = [];

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    buffer.push(value);
    if (isFiniteNumber(value)) {
      sum += value;
      count++;
    }
    if (buffer.length > window) {
      const dropped = buffer.shift();
      if (isFiniteNumber(dropped)) {
        sum -= dropped;
        count--;
      }
    }
    // Require the window to be full AND complete: a smoothed value built from
    // half a window is a different statistic and must not masquerade as one.
    if (buffer.length === window && count === window) {
      out[i] = sum / window;
    }
  }
  return out;
}

/**
 * Linear percentile (type 7, the standard "inclusive" definition used by
 * NumPy and Excel's PERCENTILE.INC) over a pre-sorted ascending array.
 */
export function percentileOfSorted(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const rank = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Log-linear interpolation over a dated curve of assumptions.
 * Clamps to the first/last anchor outside the defined range rather than
 * extrapolating an exponential trend into territory nobody measured.
 */
export function interpolateDatedCurve(curve, date) {
  if (!Array.isArray(curve) || curve.length === 0) return null;

  const target = dateToTimestamp(date);
  if (!Number.isFinite(target)) return null;

  const points = curve
    .map((point) => ({ t: dateToTimestamp(point.date), value: point.value }))
    .filter((point) => Number.isFinite(point.t) && isPositive(point.value))
    .sort((a, b) => a.t - b.t);

  if (points.length === 0) return null;
  if (target <= points[0].t) return points[0].value;
  if (target >= points[points.length - 1].t) return points[points.length - 1].value;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (target <= next.t) {
      const span = next.t - prev.t;
      const fraction = span === 0 ? 0 : (target - prev.t) / span;
      // Efficiency and power prices decay multiplicatively, so interpolate in
      // log space; a straight line in linear space would overstate the middle.
      return Math.exp(
        Math.log(prev.value) * (1 - fraction) + Math.log(next.value) * fraction
      );
    }
  }
  return points[points.length - 1].value;
}

/* ========================================================================
 * SERIES PREPARATION
 * ===================================================================== */

/**
 * Normalise raw provider rows into a contiguous, ascending daily series.
 *
 * - Rows are de-duplicated by UTC date (last write wins).
 * - Calendar days missing from the providers are inserted as empty rows so the
 *   time axis stays honest.
 * - Short gaps (<= maxForwardFillDays) are forward-filled per field; longer
 *   gaps stay null. Interpolating across a multi-week provider outage would
 *   invent history.
 *
 * @param {Array<Object>} rows - raw rows carrying at least { date }
 * @param {Object} [options]
 * @returns {Array<Object>} normalised daily rows
 */
export function normalizeDailySeries(rows, options = {}) {
  const maxFill = options.maxForwardFillDays ?? ECONOMIC_VALUE_CONFIG.maxForwardFillDays;
  const fields = options.fields ?? [
    'price',
    'realizedCap',
    'supply',
    'hashRate',
    'issuanceNtv',
    'issuanceUsd',
    'revenueUsd',
    'sthRealizedPrice',
    'lthRealizedPrice'
  ];

  if (!Array.isArray(rows) || rows.length === 0) return [];

  const byDate = new Map();
  for (const row of rows) {
    if (!row) continue;
    const date =
      typeof row.date === 'string'
        ? row.date.slice(0, 10)
        : isFiniteNumber(row.timestamp)
          ? timestampToDate(row.timestamp)
          : null;
    if (!date || !Number.isFinite(dateToTimestamp(date))) continue;

    const existing = byDate.get(date) || { date };
    for (const field of fields) {
      const value = row[field];
      if (isFiniteNumber(value)) existing[field] = value;
    }
    byDate.set(date, existing);
  }

  const dates = Array.from(byDate.keys()).sort();
  if (dates.length === 0) return [];

  const startTs = dateToTimestamp(dates[0]);
  const endTs = dateToTimestamp(dates[dates.length - 1]);

  const series = [];
  const gapCount = {};
  const lastSeen = {};

  for (let ts = startTs; ts <= endTs; ts += MS_PER_DAY) {
    const date = timestampToDate(ts);
    const source = byDate.get(date);
    const out = { date, timestamp: ts };

    for (const field of fields) {
      const raw = source ? source[field] : undefined;
      if (isFiniteNumber(raw)) {
        out[field] = raw;
        lastSeen[field] = raw;
        gapCount[field] = 0;
      } else {
        gapCount[field] = (gapCount[field] || 0) + 1;
        // Only carry a value forward across a short outage.
        out[field] =
          isFiniteNumber(lastSeen[field]) && gapCount[field] <= maxFill
            ? lastSeen[field]
            : null;
      }
    }
    series.push(out);
  }

  return series;
}

/**
 * 200-week moving average built from COMPLETED weekly closes.
 *
 * This deliberately does not take a 1400-period average of daily candles, and
 * it does not take a 200-period average of whatever timeframe happens to be on
 * screen. Weekly closes are extracted first, then averaged.
 *
 * For each day, the value is the mean of the last N weekly closes that were
 * complete as of that day, which is exactly what the weekly chart shows.
 *
 * @param {Array<Object>} series - normalised daily rows with `price`
 * @returns {Array<number|null>} aligned with `series`
 */
export function calculate200WeekMA(series, config = ECONOMIC_VALUE_CONFIG) {
  const weeks = config.ma200w.weeks;
  const weekStartsOn = config.ma200w.weekStartsOn;
  const out = new Array(series.length).fill(null);

  /** UTC midnight of the week containing `timestamp`. */
  const weekKey = (timestamp) => {
    const date = new Date(timestamp);
    const day = date.getUTCDay(); // 0 = Sunday
    const offset = (day - weekStartsOn + 7) % 7;
    return timestamp - offset * MS_PER_DAY;
  };

  const closedWeekCloses = [];
  let currentWeek = null;
  let currentWeekClose = null;
  let rollingSum = 0;

  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    const week = weekKey(row.timestamp);

    if (currentWeek === null) {
      currentWeek = week;
    } else if (week !== currentWeek) {
      // The previous week just completed: commit its final close.
      if (isPositive(currentWeekClose)) {
        closedWeekCloses.push(currentWeekClose);
        rollingSum += currentWeekClose;
        if (closedWeekCloses.length > weeks) {
          rollingSum -= closedWeekCloses.shift();
        }
      }
      currentWeek = week;
      currentWeekClose = null;
    }

    if (isPositive(row.price)) currentWeekClose = row.price;

    // Emit only once a full 200 completed weeks are behind us.
    if (closedWeekCloses.length === weeks) {
      out[i] = rollingSum / weeks;
    }
  }

  return out;
}

/**
 * Realized Price = Realized Cap / circulating supply.
 *
 * This is the aggregate on-chain cost basis of the supply, valuing every coin
 * at the price it last moved. It is a measured quantity, never approximated
 * here with a moving average.
 */
export function calculateRealizedPrice(realizedCap, supply) {
  if (!isPositive(realizedCap) || !isPositive(supply)) return null;
  return realizedCap / supply;
}

/**
 * Estimated Miner Production Cost for a single day.
 *
 * cost per BTC = (energy J/day -> kWh x $/kWh) x overhead / BTC issued that day
 *
 * This is an ESTIMATE of the marginal cash cost of production. It is not a
 * floor: miners routinely produce below cost, and hashrate leaves the network
 * when they do.
 *
 * @returns {{ costPerBtc: number, ...assumptions }|null}
 */
export function estimateMinerProductionCost(inputs, config = ECONOMIC_VALUE_CONFIG) {
  const { date, hashRate, issuanceNtv } = inputs;
  const settings = config.minerCost;

  if (!date) return null;
  if (dateToTimestamp(date) < dateToTimestamp(settings.startDate)) return null;
  // hashRate is expected in TERAHASHES PER SECOND, matching the unit the
  // provider layer normalises to (Coin Metrics `HashRate` is already TH/s).
  if (!isPositive(hashRate) || !isPositive(issuanceNtv)) return null;

  const efficiencyJPerTh = interpolateDatedCurve(settings.efficiencyCurveJPerTh, date);
  const electricityUsdPerKwh = interpolateDatedCurve(settings.electricityCurveUsdPerKwh, date);
  if (!isPositive(efficiencyJPerTh) || !isPositive(electricityUsdPerKwh)) return null;

  const terahashesPerDay = hashRate * 86400;          // TH/s -> TH per day
  const joulesPerDay = terahashesPerDay * efficiencyJPerTh;
  const kwhPerDay = joulesPerDay / 3.6e6;             // 1 kWh = 3.6 MJ
  const energyCostUsdPerDay = kwhPerDay * electricityUsdPerKwh;
  const totalCostUsdPerDay = energyCostUsdPerDay * settings.overheadMultiplier;

  const costPerBtc = totalCostUsdPerDay / issuanceNtv;
  if (!isPositive(costPerBtc)) return null;

  return {
    costPerBtc,
    efficiencyJPerTh,
    electricityUsdPerKwh,
    overheadMultiplier: settings.overheadMultiplier,
    energyCostUsdPerDay,
    kwhPerDay,
    issuanceNtv
  };
}

/**
 * MVRV = Market Cap / Realized Cap, which reduces to price / realized price.
 * Context metric only: it is a transform of an anchor already in the composite
 * and must not be weighted alongside it.
 */
export function calculateMVRV(price, realizedPrice) {
  if (!isPositive(price) || !isPositive(realizedPrice)) return null;
  return price / realizedPrice;
}

/**
 * Puell Multiple = daily issuance value (USD) / 365-day average of the same.
 * A miner *revenue condition* metric, deliberately separate from production
 * cost: it says whether miner income is unusually high or low, not what
 * mining costs.
 */
export function calculatePuellSeries(series, config = ECONOMIC_VALUE_CONFIG) {
  const issuanceUsd = series.map((row) => {
    if (isPositive(row.issuanceUsd)) return row.issuanceUsd;
    // Fall back to issuance x price when the provider omits the USD field.
    if (isPositive(row.issuanceNtv) && isPositive(row.price)) {
      return row.issuanceNtv * row.price;
    }
    return null;
  });

  const average = trailingSMA(issuanceUsd, config.puell.windowDays);
  return issuanceUsd.map((value, i) =>
    isPositive(value) && isPositive(average[i]) ? value / average[i] : null
  );
}

/**
 * Weighted geometric mean of the available anchors.
 *
 * Geometric rather than arithmetic because these are price levels compared as
 * ratios: an anchor 50% above and one 50% below should average to the middle
 * multiplicatively, and the result must be invariant to which anchor you treat
 * as the base. Weights are renormalised over present anchors only.
 *
 * @returns {{ value: number, anchorsUsed: string[], weightsApplied: Object }|null}
 */
export function combineAnchors(anchors, config = ECONOMIC_VALUE_CONFIG) {
  const weights = config.weights;
  const present = [];
  let totalWeight = 0;

  for (const key of COMPOSITE_ANCHOR_KEYS) {
    const weight = weights[key];
    const value = anchors[key];
    if (!isFiniteNumber(weight) || weight <= 0) continue;
    if (!isPositive(value)) continue;
    present.push({ key, value, weight });
    totalWeight += weight;
  }

  if (present.length < config.minAnchorsForComposite || totalWeight <= 0) {
    return null;
  }

  let logSum = 0;
  const weightsApplied = {};
  for (const anchor of present) {
    const normalised = anchor.weight / totalWeight;
    weightsApplied[anchor.key] = normalised;
    logSum += Math.log(anchor.value) * normalised;
  }

  return {
    value: Math.exp(logSum),
    anchorsUsed: present.map((anchor) => anchor.key),
    weightsApplied
  };
}

/**
 * Premium / discount of market price against Economic Value.
 * (price - economicValue) / economicValue x 100
 */
export function calculatePremiumDiscount(price, economicValue) {
  if (!isPositive(price) || !isPositive(economicValue)) return null;
  return ((price - economicValue) / economicValue) * 100;
}

/**
 * Percentile cut points of the historical premium/discount distribution.
 * These become the valuation-state thresholds, so the bands describe how far
 * Bitcoin has actually traded from its anchors rather than a chosen number.
 */
export function calculateStateThresholds(premiums, config = ECONOMIC_VALUE_CONFIG) {
  const settings = config.valuationStates;
  const clean = premiums.filter(isFiniteNumber);

  if (clean.length < settings.minObservations) {
    return { available: false, observations: clean.length, thresholds: null };
  }

  const sorted = clean.slice().sort((a, b) => a - b);
  const thresholds = {};
  for (const [name, percentile] of Object.entries(settings.percentiles)) {
    thresholds[name] = percentileOfSorted(sorted, percentile);
  }

  return {
    available: true,
    observations: clean.length,
    percentiles: { ...settings.percentiles },
    thresholds,
    range: { min: sorted[0], max: sorted[sorted.length - 1] },
    median: percentileOfSorted(sorted, 50)
  };
}

/**
 * Map a premium/discount reading onto a valuation state using the
 * percentile-derived thresholds.
 */
export function calculateValuationState(premium, thresholdSet) {
  if (!isFiniteNumber(premium)) {
    return { state: 'UNAVAILABLE', tone: 'neutral', basis: 'no premium reading' };
  }
  if (!thresholdSet || !thresholdSet.available) {
    return {
      state: 'UNCALIBRATED',
      tone: 'neutral',
      basis: 'insufficient history to calibrate state bands'
    };
  }

  const t = thresholdSet.thresholds;
  // Ordered low to high; first match wins.
  const bands = [
    { state: 'DEEP DISCOUNT', tone: 'long', max: t.deepDiscount },
    { state: 'DISCOUNT', tone: 'long', max: t.discount },
    { state: 'NEAR VALUE', tone: 'neutral', max: t.nearValue },
    { state: 'PREMIUM', tone: 'neutral', max: t.premium },
    { state: 'EXTENDED', tone: 'short', max: t.extended },
    { state: 'EUPHORIC', tone: 'short', max: Infinity }
  ];

  for (const band of bands) {
    if (premium <= band.max) {
      return {
        state: band.state,
        tone: band.tone,
        basis: `percentile-calibrated over ${thresholdSet.observations} daily observations`
      };
    }
  }
  return { state: 'EUPHORIC', tone: 'short', basis: 'above top percentile band' };
}

/**
 * How tightly the underlying anchors cluster around the composite.
 *
 * Tight clustering means several independent economic measures point at the
 * same place. Wide dispersion means they disagree and the composite should be
 * read with less confidence. This is a description of agreement, not a
 * statistical confidence interval.
 */
export function calculateEconomicConvergence(anchors, economicValue, config = ECONOMIC_VALUE_CONFIG) {
  const settings = config.convergence;
  const values = [];

  for (const key of COMPOSITE_ANCHOR_KEYS) {
    const value = anchors[key];
    if (isPositive(value)) values.push({ key, value });
  }

  if (values.length === 0 || !isPositive(economicValue)) {
    return {
      available: false,
      total: values.length,
      within: 0,
      agreement: 'UNAVAILABLE'
    };
  }

  const deviations = values.map((anchor) => ({
    key: anchor.key,
    value: anchor.value,
    deviation: anchor.value / economicValue - 1
  }));

  const within = deviations.filter(
    (item) => Math.abs(item.deviation) <= settings.agreementBand
  ).length;

  const min = Math.min(...values.map((v) => v.value));
  const max = Math.max(...values.map((v) => v.value));
  const spread = max / min - 1;
  const ratioWithin = within / values.length;

  let agreement = 'LOW AGREEMENT';
  if (
    ratioWithin >= settings.highAgreement.minRatioWithin &&
    spread <= settings.highAgreement.maxSpread
  ) {
    agreement = 'HIGH AGREEMENT';
  } else if (
    // `within >= 1` is a new precondition. The OR meant a tight spread alone
    // could report MODERATE AGREEMENT with ZERO anchors inside the band —
    // observed as "0/2 anchors - MODERATE AGREEMENT", which is a contradiction
    // rendered as a confidence statement.
    within >= 1 &&
    (ratioWithin >= settings.moderateAgreement.minRatioWithin ||
      spread <= settings.moderateAgreement.maxSpread)
  ) {
    agreement = 'MODERATE AGREEMENT';
  }

  return {
    available: true,
    within,
    total: values.length,
    ratioWithin,
    spread,
    agreementBand: settings.agreementBand,
    agreement,
    deviations
  };
}

/* ========================================================================
 * ORCHESTRATION
 * ===================================================================== */

/**
 * Build the full historical Economic Value series plus today's reading.
 *
 * @param {Array<Object>} rawRows - provider rows: { date, price, realizedCap,
 *        supply, hashRate, issuanceNtv, issuanceUsd, sthRealizedPrice,
 *        lthRealizedPrice }
 * @param {Object} [options]
 * @param {number} [options.spotPrice] - live spot price, used only for the
 *        `current` block so the headline number is not a stale daily close.
 * @param {Object} [options.config]
 * @returns {Object} { config, history, current, distribution, anchorStatus }
 */
export function calculateHistoricalEconomicValue(rawRows, options = {}) {
  const config = options.config ?? ECONOMIC_VALUE_CONFIG;
  const series = normalizeDailySeries(rawRows, { maxForwardFillDays: config.maxForwardFillDays });

  if (series.length === 0) {
    return {
      config: describeConfig(config),
      history: [],
      current: null,
      distribution: { available: false, observations: 0, thresholds: null },
      anchorStatus: emptyAnchorStatus()
    };
  }

  // --- Anchor 1: Realized Price -----------------------------------------
  const realizedPrice = series.map((row) =>
    calculateRealizedPrice(row.realizedCap, row.supply)
  );

  // --- Anchor 2: 200-week moving average --------------------------------
  const ma200w = calculate200WeekMA(series, config);

  // --- Anchor 3: Estimated Miner Production Cost ------------------------
  const minerDetail = series.map((row) =>
    estimateMinerProductionCost(
      { date: row.date, hashRate: row.hashRate, issuanceNtv: row.issuanceNtv },
      config
    )
  );
  const minerCostRaw = minerDetail.map((detail) => (detail ? detail.costPerBtc : null));
  // Smooth away difficulty-retarget and halving step changes.
  const minerCost = trailingSMA(minerCostRaw, config.smoothing.minerCostDays);

  // --- Optional anchors (only if a genuine provider supplied them) -------
  const sthRealizedPrice = series.map((row) =>
    isPositive(row.sthRealizedPrice) ? row.sthRealizedPrice : null
  );
  const lthRealizedPrice = series.map((row) =>
    isPositive(row.lthRealizedPrice) ? row.lthRealizedPrice : null
  );

  // --- Context metrics ---------------------------------------------------
  const mvrv = series.map((row, i) => calculateMVRV(row.price, realizedPrice[i]));
  const puell = calculatePuellSeries(series, config);

  // --- Composite ---------------------------------------------------------
  const combined = series.map((row, i) =>
    combineAnchors(
      {
        realizedPrice: realizedPrice[i],
        ma200w: ma200w[i],
        minerCost: minerCost[i],
        sthRealizedPrice: sthRealizedPrice[i],
        lthRealizedPrice: lthRealizedPrice[i]
      },
      config
    )
  );
  const compositeRaw = combined.map((item) => (item ? item.value : null));
  const economicValue = trailingSMA(compositeRaw, config.smoothing.compositeDays);

  // --- History rows ------------------------------------------------------
  const history = series.map((row, i) => {
    const value = economicValue[i];
    return {
      date: row.date,
      timestamp: row.timestamp,
      price: roundTo(row.price, 2),
      economicValue: roundTo(value, 2),
      premiumDiscount: roundTo(calculatePremiumDiscount(row.price, value), 2),
      ma200w: roundTo(ma200w[i], 2),
      realizedPrice: roundTo(realizedPrice[i], 2),
      sthRealizedPrice: roundTo(sthRealizedPrice[i], 2),
      lthRealizedPrice: roundTo(lthRealizedPrice[i], 2),
      minerCost: roundTo(minerCost[i], 2),
      mvrv: roundTo(mvrv[i], 4),
      puell: roundTo(puell[i], 4),
      anchorsUsed: combined[i] ? combined[i].anchorsUsed : []
    };
  });

  // --- Valuation-state calibration --------------------------------------
  const lookbackDays = config.valuationStates.lookbackDays;
  const calibrationRows =
    isFiniteNumber(lookbackDays) && lookbackDays > 0 ? history.slice(-lookbackDays) : history;
  const distribution = calculateStateThresholds(
    calibrationRows.map((row) => row.premiumDiscount),
    config
  );

  // --- Current reading ---------------------------------------------------
  const current = buildCurrentReading({
    history,
    series,
    combined,
    minerDetail,
    distribution,
    spotPrice: options.spotPrice,
    config,
    asOf: options.asOf ?? Date.now()
  });

  return {
    config: describeConfig(config),
    history,
    current,
    distribution,
    anchorStatus: summariseAnchorCoverage({
      realizedPrice,
      ma200w,
      minerCost,
      sthRealizedPrice,
      lthRealizedPrice,
      economicValue
    })
  };
}

/** The most recent row where a given field is present. */
function lastWith(history, field) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (isFiniteNumber(history[i][field])) return history[i];
  }
  return null;
}

function buildCurrentReading({
  history,
  series,
  combined,
  minerDetail,
  distribution,
  spotPrice,
  config,
  // Injected so the module stays pure: the only wall-clock read in the
  // calculation core would otherwise make every historical test non-reproducible.
  asOf = Date.now()
}) {
  if (history.length === 0) return null;

  const latestValueRow = lastWith(history, 'economicValue');
  const latestPriceRow = lastWith(history, 'price');
  if (!latestValueRow) return null;

  // Prefer the live spot price for the headline; fall back to the last daily
  // close when the ticker is unavailable, and say which was used.
  const usedSpot = isPositive(spotPrice);
  const price = usedSpot ? spotPrice : latestPriceRow ? latestPriceRow.price : null;

  const economicValue = latestValueRow.economicValue;
  const premiumDiscount = calculatePremiumDiscount(price, economicValue);

  const anchors = {
    realizedPrice: latestValueRow.realizedPrice,
    ma200w: latestValueRow.ma200w,
    minerCost: latestValueRow.minerCost,
    sthRealizedPrice: latestValueRow.sthRealizedPrice,
    lthRealizedPrice: latestValueRow.lthRealizedPrice
  };

  const convergence = calculateEconomicConvergence(anchors, economicValue, config);
  const valuation = calculateValuationState(premiumDiscount, distribution);

  const index = history.indexOf(latestValueRow);
  const minerAssumptions = index >= 0 && minerDetail[index]
    ? {
        efficiencyJPerTh: roundTo(minerDetail[index].efficiencyJPerTh, 2),
        electricityUsdPerKwh: roundTo(minerDetail[index].electricityUsdPerKwh, 4),
        overheadMultiplier: minerDetail[index].overheadMultiplier,
        estimatedNetworkKwhPerDay: roundTo(minerDetail[index].kwhPerDay, 0),
        /**
         * True when the reading's date is past the last anchor on either
         * curve, so the value is a CLAMPED extrapolation rather than an
         * interpolation. The electricity curve ends 2025-01-01, so this is
         * already true today and the "curve" has been a constant for months.
         * Surfaced because a frozen assumption presented as a curve is the
         * quiet kind of wrong.
         */
        extrapolated: (() => {
          const lastEff = config.minerCost.efficiencyCurveJPerTh.at(-1)?.date;
          const lastElec = config.minerCost.electricityCurveUsdPerKwh.at(-1)?.date;
          const d = latestValueRow.date;
          return Boolean((lastEff && d > lastEff) || (lastElec && d > lastElec));
        })(),
        note:
          'Modelled, not measured. Fleet-average efficiency is not observable; ' +
          'only the implied network energy draw is externally checkable. Not a price floor.'
      }
    : null;

  // MVRV against the live price, so the context metric matches the headline.
  const mvrv = calculateMVRV(price, anchors.realizedPrice);

  return {
    date: latestValueRow.date,
    timestamp: latestValueRow.timestamp,
    price: roundTo(price, 2),
    priceSource: usedSpot ? 'live-ticker' : 'daily-close',
    economicValue: roundTo(economicValue, 2),
    difference: roundTo(isPositive(price) ? price - economicValue : null, 2),
    premiumDiscount: roundTo(premiumDiscount, 2),
    direction: isFiniteNumber(premiumDiscount)
      ? premiumDiscount >= 0
        ? 'PREMIUM'
        : 'DISCOUNT'
      : 'UNAVAILABLE',
    state: valuation.state,
    stateTone: valuation.tone,
    stateBasis: valuation.basis,
    anchors: {
      realizedPrice: anchors.realizedPrice,
      ma200w: anchors.ma200w,
      minerCost: anchors.minerCost,
      sthRealizedPrice: anchors.sthRealizedPrice,
      lthRealizedPrice: anchors.lthRealizedPrice
    },
    weightsApplied: index >= 0 && combined[index] ? combined[index].weightsApplied : null,

    /**
     * Anchor availability FOR THIS READING.
     *
     * meta.anchorStatus reports whether an anchor was ever present across the
     * whole history — `present > 0` over ~5,900 rows. That is a different
     * question from which anchors drove today's number, and the page bound its
     * UNAVAILABLE tiles to the history-wide flag. So an anchor could vanish for
     * the current day only, the composite would silently renormalise over the
     * remaining two, and nothing surfaced: the tile stayed "available" and
     * rendered an em-dash, the notice banner stayed hidden, and source status
     * stayed ok. Measured on a realized-cap dropout for the last 30 days,
     * Economic Value moved 35% and the premium went from +582% to +949% with
     * every honesty affordance green.
     *
     * These three fields describe the reading actually being displayed.
     */
    anchorsUsed: index >= 0 && combined[index] ? combined[index].anchorsUsed : [],
    anchorsExpected: COMPOSITE_ANCHOR_KEYS.filter(
      (key) => isFiniteNumber(config.weights[key]) && config.weights[key] > 0
    ).length,
    /**
     * True when this reading was built from fewer anchors than the model
     * defines. A renormalised composite is a DIFFERENT MODEL, not a slightly
     * noisier version of the same one — and its premium is then scored against
     * a percentile distribution built almost entirely from full-anchor
     * readings, so the state label is comparing across models.
     */
    degraded: (() => {
      const used = index >= 0 && combined[index] ? combined[index].anchorsUsed.length : 0;
      const expected = COMPOSITE_ANCHOR_KEYS.filter(
        (key) => isFiniteNumber(config.weights[key]) && config.weights[key] > 0
      ).length;
      return used > 0 && used < expected;
    })(),
    context: {
      mvrv: roundTo(mvrv, 4),
      puell: latestValueRow.puell
    },
    convergence: {
      available: convergence.available,
      within: convergence.within,
      total: convergence.total,
      spread: roundTo(convergence.spread, 4),
      agreementBand: convergence.agreementBand,
      agreement: convergence.agreement,
      label: convergence.available ? `${convergence.within}/${convergence.total}` : null
    },
    minerAssumptions,

    /**
     * Gap between the newest row in the series and the newest row that
     * produced a composite — i.e. how many trailing days have data but no
     * usable anchor set.
     *
     * Renamed from dataAgeDays because it was documented and validated as
     * "on-chain feed behind price feed", which it structurally cannot measure:
     * both operands come from the SAME series, and normalizeDailySeries spans
     * only observed dates, so when Coin Metrics stops publishing the series
     * simply ends earlier and this stays 0. A feed 13 days behind reported
     * zero staleness while the headline paired a live spot price against a
     * 13-day-old Economic Value.
     */
    anchorGapDays: series.length
      ? Math.max(0, Math.round((series[series.length - 1].timestamp - latestValueRow.timestamp) / MS_PER_DAY))
      : null,

    /**
     * Real feed age, measured against the wall clock.
     *
     * `asOf` is injected by the caller so this module stays pure and
     * deterministic under test; it defaults to now for ordinary use.
     */
    dataAgeDays: Math.max(
      0,
      Math.round((asOf - latestValueRow.timestamp) / MS_PER_DAY)
    ),
    latestDataDate: new Date(latestValueRow.timestamp).toISOString().slice(0, 10)
  };
}

function summariseAnchorCoverage(anchorSeries) {
  const status = {};
  for (const [key, values] of Object.entries(anchorSeries)) {
    const firstIndex = values.findIndex(isFiniteNumber);
    const present = values.filter(isFiniteNumber).length;
    status[key] = {
      available: present > 0,
      observations: present,
      firstIndex: firstIndex >= 0 ? firstIndex : null
    };
  }
  return status;
}

function emptyAnchorStatus() {
  return COMPOSITE_ANCHOR_KEYS.reduce((acc, key) => {
    acc[key] = { available: false, observations: 0, firstIndex: null };
    return acc;
  }, {});
}

/** Config echoed back to clients so the methodology is inspectable in the UI. */
function describeConfig(config) {
  return {
    version: config.version,
    weights: { ...config.weights },
    minAnchorsForComposite: config.minAnchorsForComposite,
    ma200wWeeks: config.ma200w.weeks,
    smoothing: { ...config.smoothing },
    minerCost: {
      startDate: config.minerCost.startDate,
      overheadMultiplier: config.minerCost.overheadMultiplier,
      includeFeesInIssuance: config.minerCost.includeFeesInIssuance,
      efficiencyCurveJPerTh: config.minerCost.efficiencyCurveJPerTh.map((p) => ({ ...p })),
      electricityCurveUsdPerKwh: config.minerCost.electricityCurveUsdPerKwh.map((p) => ({ ...p }))
    },
    puellWindowDays: config.puell.windowDays,
    maxForwardFillDays: config.maxForwardFillDays,
    valuationStates: {
      percentiles: { ...config.valuationStates.percentiles },
      lookbackDays: config.valuationStates.lookbackDays,
      minObservations: config.valuationStates.minObservations
    },
    convergence: { ...config.convergence },
    excludedFromComposite: {
      mvrv: 'Derived from Realized Price; would double-count the on-chain cost basis anchor.',
      puell: 'Miner revenue condition, not a valuation level. Kept separate from miner production cost.'
    }
  };
}

export default {
  ECONOMIC_VALUE_CONFIG,
  COMPOSITE_ANCHOR_KEYS,
  ANCHOR_LABELS,
  normalizeDailySeries,
  calculate200WeekMA,
  calculateRealizedPrice,
  estimateMinerProductionCost,
  calculateMVRV,
  calculatePuellSeries,
  combineAnchors,
  calculatePremiumDiscount,
  calculateStateThresholds,
  calculateValuationState,
  calculateEconomicConvergence,
  calculateHistoricalEconomicValue,
  interpolateDatedCurve,
  percentileOfSorted,
  dateToTimestamp,
  timestampToDate
};
