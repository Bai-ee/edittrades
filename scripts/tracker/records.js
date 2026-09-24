/**
 * EditTrades call tracker - capture rows (T1, docs/PLAN_CALL_TRACKER.md; T3,
 * docs/PLAN_SERVED_CALLS.md).
 *
 * Pure: no fs, no network, no env. Shared by the collector (collect.js) and the engine's
 * served-calls recorder (lib/servedCalls.js), so a call served to the GPT is stored in
 * exactly the row shape the cron collector writes.
 *
 * Account data never passes: rows are built from an explicit field list, then every key
 * named account/wallet/performance/margin/holdings* or containing wallet/balance/address
 * is stripped at any depth, then the row is re-checked and refused (throw) if any such
 * key survived.
 */

/** True for a key that could carry account, wallet, or balance data. */
export function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  if (k === 'account' || k === 'wallet' || k === 'performance' || k === 'margin') return true;
  if (k.startsWith('holdings')) return true;
  return k.includes('wallet') || k.includes('balance') || k.includes('address');
}

/** Deep copy of `value` with every sensitive key removed at any depth. */
export function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

/** Paths of any sensitive keys left in `value` (empty = clean). */
export function findSensitiveKeys(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findSensitiveKeys(v, `${at}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) found.push(`${at}.${k}`);
      findSensitiveKeys(v, `${at}.${k}`, found);
    }
  }
  return found;
}

/**
 * The last six fields (measuredTarget onward) are T4-additive (docs/PLAN_FLAG_PATHS.md
 * P0 item 4, scripts/tracker/paths.js labelPath/featuresAt): kept only so the tracker can
 * label a candidate's realised path and bucket its features at the tightening point.
 * Additive only - the fields above them are unchanged, so a row stored before this
 * existed still reads identically; a candidate that never carried these upstream (or a
 * legacy stored row) just reads null here, same as any other missing field.
 */
export function slimCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    id: c.candidateId ?? null,
    tf: c.timeframe ?? null,
    dir: c.direction ?? null,
    state: c.state ?? null,
    breakout: c.breakoutLevel ?? null,
    invalidation: c.invalidation ?? null,
    measuredRR: c.measuredRR ?? null,
    qual: c.qual ?? null,
    measuredTarget: c.measuredTarget ?? null,
    compressionScore: c.compressionScore ?? null,
    durationCandles: c.durationCandles ?? null,
    impulseStrength: c.impulseStrength ?? null,
    flagHigh: c.flagHigh ?? null,
    flagLow: c.flagLow ?? null
  };
}

/**
 * One stripped call row per symbol from a scalp-context payload. Throws (nothing is
 * written) if any sensitive key survives the strip.
 * @param {Object} payload
 * @param {number} [capturedAtMs=Date.now()]
 * @returns {Array<Object>}
 */
export function recordsFromPayload(payload, capturedAtMs = Date.now()) {
  const symbols = payload && payload.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
  const rows = [];
  for (const [symbol, sym] of Object.entries(symbols)) {
    if (!sym || typeof sym !== 'object') continue;
    const mark = sym.mark && typeof sym.mark === 'object'
      ? { price: sym.mark.price ?? null, driftBps: sym.mark.driftBps ?? null, status: sym.mark.status ?? null }
      : null;
    const row = {
      capturedAt: new Date(capturedAtMs).toISOString(),
      closedThrough: payload.closedThrough ?? null,
      schemaVersion: payload.schemaVersion ?? null,
      configVersion: payload.configVersion ?? null,
      dataStatus: payload.dataStatus ?? null,
      symbol,
      price: sym.price ?? null,
      mark,
      flagTradePlan: sym.flagTradePlan ?? null,
      flagRecommendation: sym.flagRecommendation ?? null,
      candidateSetups: Array.isArray(sym.candidateSetups) ? sym.candidateSetups.map(slimCandidate).filter(Boolean) : [],
      bias: sym.decisionTrace && sym.decisionTrace.bias !== undefined ? sym.decisionTrace.bias : null
    };
    const clean = stripSensitive(row);
    const leaked = findSensitiveKeys(clean);
    if (leaked.length) throw new Error(`refusing to write: sensitive keys survived strip (${leaked.length})`);
    rows.push(clean);
  }
  return rows;
}

/**
 * Dedupe key of a served-call row (T3): symbol|closedThrough|class|planStatus. The GPT
 * often asks several times per chat; identical rows add nothing.
 */
export function servedKey(row) {
  const rec = row && row.flagRecommendation;
  const plan = row && row.flagTradePlan;
  return `${row && row.symbol}|${row && row.closedThrough}|${(rec && rec.class) || '-'}|${(plan && plan.status) || '-'}`;
}
