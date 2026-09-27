// Shared math helpers for the WP3 statistics harness (significance.js, montecarlo.js,
// trial-ledger.js). Research only. No new deps: seeded RNG, normal CDF / inverse CDF and
// central moments are hand-rolled.
//
// docs/research/harness/WP3_STATS.md documents where each function is used and cites sources.

// ---------------------------------------------------------------------------- seeded RNG
// mulberry32 - same generator already used by scripts/research/risk-sim.js, reused here for
// consistency across the research harness. Deterministic given a seed; NOT the same PRNG as
// numpy's default_rng (PCG64) used by Jesse, so raw bootstrap draws will not numerically match
// Jesse's reference implementation bit-for-bit even with "the same seed" - only the ALGORITHM
// (stationary block bootstrap, restart-probability construction) is replicated exactly.
// See docs/research/harness/WP3_STATS.md "Deviations from Jesse" for the full list.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------- basic moments

export function mean(arr) {
  const n = arr.length;
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  return s / n;
}

/** Sample variance (ddof=1) unless {population:true}. */
export function variance(arr, { population = false } = {}) {
  const n = arr.length;
  if (n < 2) return 0;
  const mu = mean(arr);
  let s = 0;
  for (let i = 0; i < n; i++) s += (arr[i] - mu) ** 2;
  return s / (population ? n : n - 1);
}

export function std(arr, opts) { return Math.sqrt(variance(arr, opts)); }

/** Population (moment) skewness: (1/n) sum(((x-mu)/sigma)^3), sigma = population std. */
export function skewness(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  const mu = mean(arr);
  const sigma = Math.sqrt(variance(arr, { population: true }));
  if (!(sigma > 0)) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += ((arr[i] - mu) / sigma) ** 3;
  return s / n;
}

/** Population (moment) kurtosis, NOT excess (a normal distribution has kurtosis = 3). */
export function kurtosis(arr) {
  const n = arr.length;
  if (n < 4) return 3;
  const mu = mean(arr);
  const sigma = Math.sqrt(variance(arr, { population: true }));
  if (!(sigma > 0)) return 3;
  let s = 0;
  for (let i = 0; i < n; i++) s += ((arr[i] - mu) / sigma) ** 4;
  return s / n;
}

/** Sharpe ratio of a return series, NOT annualized (per-period units). */
export function sharpeRatio(returns) {
  const sd = std(returns);
  return sd > 0 ? mean(returns) / sd : 0;
}

// ---------------------------------------------------------------------------- normal distribution
// Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, max error 1.5e-7).

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(x, mu = 0, sigma = 1) {
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/**
 * Inverse standard normal CDF (probit), Acklam's algorithm (rational approximation,
 * relative error < 1.15e-9 across (0,1)). Standard reference implementation, used here for
 * the deflated Sharpe ratio's expected-max-Sharpe formula (Bailey & Lopez de Prado 2014).
 */
export function normalInvCdf(p) {
  if (!(p > 0) || !(p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const EULER_MASCHERONI = 0.5772156649015329;

// ---------------------------------------------------------------------------- percentile / rank

export function fractionGte(sortedOrArr, value) {
  let count = 0;
  for (let i = 0; i < sortedOrArr.length; i++) if (sortedOrArr[i] >= value) count++;
  return count / sortedOrArr.length;
}

export function fractionLt(sortedOrArr, value) {
  let count = 0;
  for (let i = 0; i < sortedOrArr.length; i++) if (sortedOrArr[i] < value) count++;
  return count / sortedOrArr.length;
}

export function quantile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (!n) return NaN;
  const idx = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
  return sortedAsc[idx];
}

export function summarize(arr) {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: mean(sorted),
    std: std(sorted),
    p5: quantile(sorted, 0.05),
    p50: quantile(sorted, 0.50),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
