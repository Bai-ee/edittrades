/**
 * Pyth mark price (P1, schema 1.16.0) - read-only reference beside the candle close.
 *
 * Jupiter perps mark, fill, stop and liquidate on the Pyth oracle, while the payload's
 * `price` is the close of the newest closed Kraken 1m candle. This module fetches the
 * live Pyth price for every requested symbol in ONE Hermes request so a consumer can
 * check stops and liquidation against what the venue actually uses.
 *
 * Rules:
 *   - Never throws. Any failure (no key, HTTP error, timeout, bad body, missing feed)
 *     reads `status: "unavailable"` with null fields for that symbol.
 *   - No `PYTH_API_KEY` -> every symbol unavailable and no request is made.
 *   - The key is sent only as `Authorization: Bearer <key>` (Hermes rejects other
 *     header names) and is never logged or returned. Log lines carry a short reason,
 *     never the URL or a header.
 *   - An unavailable mark never changes `dataStatus` and never adds a warning; the
 *     caller (services/scalpContext.js) keeps it out of `warnings`, same as the wallet.
 */

import { ENGINE_CONFIG } from '../config/engine.js';

export const HERMES_BASE_URL = 'https://hermes.pyth.network';

const DEFAULTS = {
  feedIds: ENGINE_CONFIG.mark.pyth.feedIds,
  maxAgeSec: ENGINE_CONFIG.mark.pyth.maxAgeSec,
  timeoutMs: ENGINE_CONFIG.mark.pyth.timeoutMs
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizeId(id) {
  return typeof id === 'string' ? id.toLowerCase().replace(/^0x/, '') : '';
}

/**
 * Scale a Pyth integer by its exponent. Dividing by an exact power of ten gives the
 * correctly rounded double, so 8445290000000 at expo -8 is exactly 84452.9.
 * @param {string|number} value
 * @param {number} expo
 * @returns {number|null}
 */
export function scaleByExpo(value, expo) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(expo)) return null;
  return expo < 0 ? n / 10 ** -expo : n * 10 ** expo;
}

/** Raw per-symbol read when nothing usable came back. */
function unavailableRaw(reason) {
  return { status: 'unavailable', price: null, conf: null, publishTime: null, reason };
}

/**
 * Parse one Hermes `parsed[]` entry into { price, conf, publishTime (unix s) }.
 * @param {Object} entry
 * @returns {{status:string, price:number|null, conf:number|null, publishTime:number|null, reason:string|null}}
 */
export function parseParsedEntry(entry) {
  const p = entry && entry.price;
  if (!p || typeof p !== 'object') return unavailableRaw('no price in feed entry');
  const expo = Number(p.expo);
  const price = scaleByExpo(p.price, expo);
  const conf = scaleByExpo(p.conf, expo);
  const publishTime = Number(p.publish_time);
  if (!isFiniteNumber(price) || price <= 0 || !isFiniteNumber(publishTime) || publishTime <= 0) {
    return unavailableRaw('invalid price in feed entry');
  }
  return { status: 'ok', price, conf: isFiniteNumber(conf) ? conf : null, publishTime, reason: null };
}

/**
 * Fetch the latest Pyth price for every symbol in one Hermes request.
 *
 * @param {Array<string>} symbols - e.g. ['BTC', 'SOL', 'ETH']
 * @param {Object} [deps]
 * @param {string} [deps.apiKey=process.env.PYTH_API_KEY]
 * @param {Function} [deps.fetchImpl=fetch] - injectable for tests
 * @param {number} [deps.timeoutMs]
 * @param {Object} [deps.feedIds] - { SYMBOL: feedId }
 * @returns {Promise<Object>} { SYMBOL: {status, price, conf, publishTime, reason} }; never rejects
 */
export async function fetchPythMarks(symbols, deps = {}) {
  const {
    apiKey = process.env.PYTH_API_KEY,
    fetchImpl = fetch,
    timeoutMs = DEFAULTS.timeoutMs,
    feedIds = DEFAULTS.feedIds
  } = deps || {};

  const list = Array.isArray(symbols) ? symbols : [];
  const out = {};
  const idBySymbol = {};
  for (const sym of list) {
    const id = normalizeId(feedIds && feedIds[sym]);
    if (id) idBySymbol[sym] = id;
    else out[sym] = unavailableRaw('no feed id');
  }

  const requested = Object.keys(idBySymbol);
  if (requested.length === 0) return out;

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    for (const sym of requested) out[sym] = unavailableRaw('no api key');
    console.log('[PythMark] PYTH_API_KEY not set; mark unavailable');
    return out;
  }

  const query = requested.map((sym) => `ids[]=${idBySymbol[sym]}`).join('&');
  const url = `${HERMES_BASE_URL}/v2/updates/price/latest?${query}&parsed=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body = null;
  let failure = null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response || !response.ok) {
      failure = `hermes http ${response ? response.status : 'no response'}`;
    } else {
      body = await response.json();
    }
  } catch (err) {
    failure = err && err.name === 'AbortError' ? `hermes timeout after ${timeoutMs}ms` : 'hermes request failed';
  } finally {
    clearTimeout(timer);
  }

  if (failure || !body || !Array.isArray(body.parsed)) {
    const reason = failure || 'hermes body has no parsed[]';
    console.warn(`[PythMark] mark unavailable: ${reason}`);
    for (const sym of requested) out[sym] = unavailableRaw(reason);
    return out;
  }

  const byId = new Map();
  for (const entry of body.parsed) byId.set(normalizeId(entry && entry.id), entry);
  for (const sym of requested) {
    const entry = byId.get(idBySymbol[sym]);
    out[sym] = entry ? parseParsedEntry(entry) : unavailableRaw('feed missing from response');
  }
  return out;
}

/**
 * Build the published `mark` object for one symbol.
 *
 * @param {Object|null} raw - one fetchPythMarks(...) entry
 * @param {number|null} candlePrice - the symbol's `price` (closed 1m close)
 * @param {number} nowMs
 * @param {number} [maxAgeSec]
 * @returns {{price:number|null, conf:number|null, publishTime:string|null, source:string, ageSec:number|null, driftBps:number|null, status:string}}
 */
export function buildMark(raw, candlePrice, nowMs, maxAgeSec = DEFAULTS.maxAgeSec) {
  if (!raw || raw.status !== 'ok' || !isFiniteNumber(raw.price) || !isFiniteNumber(raw.publishTime)) {
    return { price: null, conf: null, publishTime: null, source: 'pyth', ageSec: null, driftBps: null, status: 'unavailable' };
  }
  const ageSec = Math.max(0, Math.round(nowMs / 1000 - raw.publishTime));
  const driftBps = isFiniteNumber(candlePrice) && candlePrice > 0
    ? Math.round(((raw.price - candlePrice) / candlePrice) * 10000 * 10) / 10
    : null;
  return {
    price: raw.price,
    conf: raw.conf,
    publishTime: new Date(raw.publishTime * 1000).toISOString(),
    source: 'pyth',
    ageSec,
    driftBps,
    status: ageSec > maxAgeSec ? 'stale' : 'ok'
  };
}

/**
 * decisionTrace.bias token: `mark:<driftBps>` or `mark:na`. Always under 12 chars:
 * |drift| >= 100 bps drops the decimal and the value is clamped to +-9999.
 * @param {Object|null} mark - buildMark(...) output
 * @returns {string}
 */
export function markTraceToken(mark) {
  const d = mark && mark.status !== 'unavailable' ? mark.driftBps : null;
  if (!isFiniteNumber(d)) return 'mark:na';
  const clamped = Math.max(-9999, Math.min(9999, d));
  return `mark:${Math.abs(clamped) >= 100 ? Math.round(clamped) : clamped}`;
}

/**
 * Compact-mode mark: `{ price, driftBps, status }`.
 * @param {Object} mark
 * @returns {Object}
 */
export function compactMark(mark) {
  if (!mark || typeof mark !== 'object') return mark;
  return { price: mark.price, driftBps: mark.driftBps, status: mark.status };
}

export default { fetchPythMarks, buildMark, markTraceToken, compactMark, parseParsedEntry, scaleByExpo, HERMES_BASE_URL };
