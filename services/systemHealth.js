/**
 * System Health
 * -------------
 * One deterministic object describing whether each layer of the decision desk
 * is actually working.
 *
 * This is not decoration. Its purpose is to stop a downstream layer from
 * behaving as though everything is fine when it is not — specifically, to stop
 * the AI layer from writing confident commentary over a stale macro reading or
 * a dead price feed, and to give the home page something honest to display.
 *
 * Design rules:
 *
 *  - Health is DERIVED, never asserted. Every status here is computed from
 *    provenance and error objects the layers already produce. Nothing sets its
 *    own status to OK.
 *  - Absence is a state, not a blank. A layer that could not be evaluated is
 *    UNKNOWN, which is distinct from OK and from FAILED.
 *  - Only meaningful states surface. The UI indicator shows nothing when
 *    everything is OK; alarm fatigue makes a warning system worthless.
 */

import { FRESHNESS } from './dataProvenance.js';

/** @enum {string} */
export const HEALTH = Object.freeze({
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  STALE: 'STALE',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  DISABLED: 'DISABLED'
});

/** Worst-first, so `rank` can pick the headline state. */
const SEVERITY = [HEALTH.FAILED, HEALTH.STALE, HEALTH.DEGRADED, HEALTH.UNKNOWN, HEALTH.DISABLED, HEALTH.OK];

function worst(statuses) {
  for (const level of SEVERITY) {
    if (statuses.includes(level)) return level;
  }
  return HEALTH.UNKNOWN;
}

/**
 * Market-data health from a multi-timeframe provenance map.
 *
 * @param {Object} provenanceByInterval  from marketData.multiTimeframeProvenance
 */
export function assessMarketData(provenanceByInterval) {
  const entries = Object.entries(provenanceByInterval || {});
  if (entries.length === 0) {
    return { status: HEALTH.UNKNOWN, detail: 'No market data was requested', staleInputs: [], failedProviders: [] };
  }

  const staleInputs = [];
  const failedProviders = new Set();
  const unavailable = [];
  let anyLive = false;

  for (const [interval, prov] of entries) {
    if (!prov || prov.freshness === FRESHNESS.UNAVAILABLE) {
      unavailable.push(interval);
      for (const failure of prov?.providerFailures || []) failedProviders.add(failure.provider);
      continue;
    }
    if (prov.freshness === FRESHNESS.STALE) staleInputs.push(`${interval} (${prov.source}, ${prov.ageSeconds}s old)`);
    if (prov.freshness === FRESHNESS.LIVE) anyLive = true;
    for (const failure of prov.providerFailures || []) failedProviders.add(failure.provider);
  }

  let status;
  let detail;
  if (unavailable.length === entries.length) {
    status = HEALTH.FAILED;
    detail = `No market data for any requested timeframe (${unavailable.join(', ')})`;
  } else if (unavailable.length > 0) {
    status = HEALTH.DEGRADED;
    detail = `${unavailable.length} of ${entries.length} timeframes unavailable: ${unavailable.join(', ')}`;
  } else if (staleInputs.length > 0) {
    status = HEALTH.STALE;
    detail = `${staleInputs.length} timeframe(s) past their freshness window`;
  } else if (failedProviders.size > 0) {
    // Everything resolved, but not from the first-choice provider.
    status = HEALTH.DEGRADED;
    detail = `Serving from a fallback provider; failed: ${[...failedProviders].join(', ')}`;
  } else {
    status = anyLive ? HEALTH.OK : HEALTH.OK;
    detail = 'All requested timeframes served from a real provider';
  }

  return { status, detail, staleInputs, failedProviders: [...failedProviders], unavailable };
}

/**
 * Bitcoin macro health from the economic-value API's `meta` and `current`.
 *
 * The important case is the one that is easy to miss: the composite silently
 * renormalising over fewer anchors. A two-anchor Economic Value is a different
 * model from a three-anchor one, and it must not present identically.
 */
export function assessBitcoinMacro({ meta, current, expectedAnchors = 3 } = {}) {
  if (!meta && !current) {
    return { status: HEALTH.UNKNOWN, detail: 'Macro layer not evaluated', anchorsUsed: null, expectedAnchors };
  }
  if (!current) {
    return { status: HEALTH.FAILED, detail: 'No current macro reading available', anchorsUsed: 0, expectedAnchors };
  }

  const anchorsUsed = current.weightsApplied ? Object.keys(current.weightsApplied).length : null;
  const warnings = [];

  const providerFailed = meta?.sources
    ? Object.entries(meta.sources)
        .filter(([, info]) => info?.status === 'failed')
        .map(([name]) => name)
    : [];

  if (meta?.stale) warnings.push('Serving a stale cached series');
  if (providerFailed.length > 0) warnings.push(`Provider(s) failed: ${providerFailed.join(', ')}`);

  let status = HEALTH.OK;
  let detail = `Composite running on ${anchorsUsed ?? '?'} of ${expectedAnchors} anchors`;

  if (anchorsUsed !== null && anchorsUsed < expectedAnchors) {
    // The headline degradation case the brief calls out explicitly.
    status = HEALTH.DEGRADED;
    detail = `ECONOMIC VALUE DEGRADED — ${anchorsUsed} / ${expectedAnchors} CORE ANCHORS AVAILABLE`;
    warnings.push(
      'The composite has renormalised over fewer anchors. This is a different model from the full one; ' +
        'the valuation state is scored against a distribution built mostly from full-anchor readings.'
    );
  }
  if (meta?.stale) status = worst([status, HEALTH.STALE]);
  if (providerFailed.length > 0) status = worst([status, HEALTH.DEGRADED]);

  return {
    status,
    detail,
    anchorsUsed,
    expectedAnchors,
    warnings,
    failedProviders: providerFailed,
    dataFetchedAt: meta?.dataFetchedAt ?? null
  };
}

/**
 * Risk-persistence health.
 * A rejected stored record matters: it means portfolio heat is being computed
 * over an incomplete book, which under-reports risk.
 */
export function assessRiskPersistence({ available, rejectedCount = 0, error = null } = {}) {
  if (error) return { status: HEALTH.FAILED, detail: `Risk storage error: ${error}` };
  if (available === false) return { status: HEALTH.FAILED, detail: 'Risk storage unavailable' };
  if (available === undefined) return { status: HEALTH.UNKNOWN, detail: 'Risk storage not evaluated' };
  if (rejectedCount > 0) {
    return {
      status: HEALTH.DEGRADED,
      detail: `${rejectedCount} stored trade(s) failed validation and are excluded from portfolio risk`
    };
  }
  return { status: HEALTH.OK, detail: 'Risk profile and trade history readable' };
}

/** AI health. Absent key is DISABLED, not FAILED — it is a configuration state. */
export function assessAI({ configured, lastError = null } = {}) {
  if (lastError) return { status: HEALTH.FAILED, detail: `AI call failed: ${lastError}` };
  if (configured === false) return { status: HEALTH.DISABLED, detail: 'No AI key configured; commentary is off' };
  if (configured === undefined) return { status: HEALTH.UNKNOWN, detail: 'AI layer not evaluated' };
  return { status: HEALTH.OK, detail: 'AI commentary available' };
}

/**
 * Assemble the whole-system health object.
 *
 * `overall` is the worst layer, so a caller can gate on one field. `warnings`
 * is deliberately flat and human-readable: it is what the home-page indicator
 * expands into and what gets injected into the AI's dataHealth block.
 */
export function buildSystemHealth({ marketData, bitcoinMacro, riskPersistence, ai } = {}) {
  const layers = {
    marketData: marketData || { status: HEALTH.UNKNOWN, detail: 'Not evaluated' },
    bitcoinMacro: bitcoinMacro || { status: HEALTH.UNKNOWN, detail: 'Not evaluated' },
    riskPersistence: riskPersistence || { status: HEALTH.UNKNOWN, detail: 'Not evaluated' },
    ai: ai || { status: HEALTH.UNKNOWN, detail: 'Not evaluated' }
  };

  const staleInputs = [...(layers.marketData.staleInputs || [])];
  const failedProviders = [
    ...(layers.marketData.failedProviders || []),
    ...(layers.bitcoinMacro.failedProviders || [])
  ];

  const warnings = [];
  for (const [name, layer] of Object.entries(layers)) {
    if (layer.status !== HEALTH.OK && layer.status !== HEALTH.UNKNOWN) {
      warnings.push(`${name}: ${layer.detail}`);
    }
    for (const w of layer.warnings || []) warnings.push(`${name}: ${w}`);
  }

  const overall = worst(Object.values(layers).map((l) => l.status));

  return {
    systemHealth: {
      overall,
      marketData: layers.marketData.status,
      bitcoinMacro: layers.bitcoinMacro.status,
      riskPersistence: layers.riskPersistence.status,
      ai: layers.ai.status,
      staleInputs,
      failedProviders: [...new Set(failedProviders)],
      warnings,
      detail: {
        marketData: layers.marketData.detail,
        bitcoinMacro: layers.bitcoinMacro.detail,
        riskPersistence: layers.riskPersistence.detail,
        ai: layers.ai.detail
      },
      evaluatedAt: new Date().toISOString()
    }
  };
}

/**
 * One short line for the home-page indicator, or null when there is nothing
 * worth saying. Returning null for a healthy system is the point.
 */
export function healthHeadline(systemHealth) {
  if (!systemHealth) return null;
  const h = systemHealth.systemHealth || systemHealth;

  if (h.marketData === HEALTH.FAILED) return 'MARKET DATA UNAVAILABLE';
  if (h.riskPersistence === HEALTH.FAILED) return 'RISK STORAGE ERROR';
  if (h.bitcoinMacro === HEALTH.DEGRADED) return 'MACRO DEGRADED';
  if (h.marketData === HEALTH.STALE) {
    const n = (h.staleInputs || []).length;
    return n === 1 ? '1 FEED STALE' : `${n} FEEDS STALE`;
  }
  if (h.marketData === HEALTH.DEGRADED) return 'FALLBACK PROVIDER IN USE';
  if (h.bitcoinMacro === HEALTH.STALE) return 'MACRO STALE';
  if (h.overall === HEALTH.OK) return null; // Nothing to say. Say nothing.
  return null;
}

export default {
  HEALTH,
  assessMarketData,
  assessBitcoinMacro,
  assessRiskPersistence,
  assessAI,
  buildSystemHealth,
  healthHeadline
};
