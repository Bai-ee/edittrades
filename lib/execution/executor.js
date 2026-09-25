/**
 * Guarded Jupiter perp executor (T-3 A, docs/PLAN_TELEGRAM_EXECUTION.md "Contract between agents").
 *
 * Path: api/telegram-webhook.js -> lib/execution/* -> services/jupiterPerps.js. MCP, the
 * GPT Action and services/scalpContext.js never import this (test-execution.js asserts).
 *
 * Every entry point returns reasons and never throws. Gates (lib/execution/gates.js):
 * TRADE_EXECUTION_ENABLED, EXECUTION_MODE, owner allowlist, PIN on every confirm / close /
 * update / arm, single-use 60 s nonce, kill switch (env or Blob) checked in preflight,
 * confirm, close and update, and all caps (missing cap -> refuse). Dry mode runs the same
 * path (preflight, quote, ticket, PIN, nonce, audit) but never calls a signing function:
 * it returns a dryRunId, audits mode:"dry" and journals a `note`.
 *
 * Live capability gate: services/jupiterPerps.js does not yet place SL/TP on chain with
 * the open (openPerpPosition takes them but builds no TP/SL request), and
 * closePerpPosition / updatePerpPosition are placeholders. LIVE_CAPABILITIES says so, and
 * live open / close / update refuse (`live_*_unsupported`) until those are implemented
 * and the flags flipped. Dry mode is unaffected.
 *
 * Everything is injected (createExecutor(deps)) so tests run with no network and no key.
 * The default deps load services/jupiterPerps.js and services/walletManager.js lazily, on
 * first use past the gates, never at import.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet, head as blobHead } from '@vercel/blob';
import { readBlob, parseJsonlObjects } from '../blobJsonl.js';
import { validateJournalEntry, journalDayPath } from '../journalSchema.js';
import { maxLeverageForStop } from '../riskEngine.js';
import { ENGINE_CONFIG } from '../../config/engine.js';
import {
  readExecutionConfig, pinMatches, isOwner, readKillState, killStatus, setKill, clearKill,
  recordWrongPin, resetWrongPin
} from './gates.js';
import { appendAudit, auditDayPath } from './audit.js';
import { storeTicket, peekTicket, consumeTicket, TICKET_TTL_MS } from './tickets.js';

export const SCALP_STOP_CAP_PCT = 3;
export const SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const LIVE_CAPABILITIES = Object.freeze({ openWithStops: false, close: false, update: false });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => isNum(v) && v > 0;
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (isNum(v) ? Math.round(v * 10000) / 10000 : null);
const errName = (err) => String((err && err.name) || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40);
const errMsg = (err) => String((err && err.message) || err || 'error').replace(/(https?|wss?):\/\/\S+/gi, '[url]').slice(0, 160);

/** 'btc' | 'BTCUSDT' | 'BTC-PERP' -> 'BTC' (or null). */
export function baseSymbol(symbol) {
  const s = typeof symbol === 'string' ? symbol.trim().toUpperCase().replace(/[-_/]?(USDT|USDC|USD|PERP)$/, '') : '';
  return SYMBOLS.includes(s) ? s : null;
}

/**
 * Pure intent checks: shape, SL/TP sides, stop cap, caps, max loss, liquidation buffer.
 * @returns {{reasons:string[], derived:Object}}
 */
export function checkIntent(intent, caps, risk = ENGINE_CONFIG.risk) {
  const reasons = [];
  const i = intent && typeof intent === 'object' ? intent : {};
  const symbol = baseSymbol(i.symbol);
  const direction = i.direction === 'long' || i.direction === 'short' ? i.direction : null;
  if (!symbol) reasons.push('symbol_unsupported');
  if (!direction) reasons.push('direction_invalid');
  if (!pos(i.sizeUsd)) reasons.push('size_invalid');
  if (!(isNum(i.leverage) && i.leverage >= 1)) reasons.push('leverage_invalid');
  if (!pos(i.entry)) reasons.push('entry_required');
  if (!pos(i.stop)) reasons.push('stop_required');
  if (!pos(i.tp1)) reasons.push('tp_required');
  if (!(i.tp2 === undefined || i.tp2 === null || pos(i.tp2))) reasons.push('tp2_invalid');

  const derived = { symbol, market: symbol ? `${symbol}USDT` : null, direction };
  if (reasons.length) return { reasons, derived };

  const long = direction === 'long';
  if (long ? !(i.stop < i.entry) : !(i.stop > i.entry)) reasons.push('stop_wrong_side');
  if (long ? !(i.tp1 > i.entry) : !(i.tp1 < i.entry)) reasons.push('tp_wrong_side');
  if (pos(i.tp2) && (long ? !(i.tp2 > i.tp1) : !(i.tp2 < i.tp1))) reasons.push('tp2_wrong_side');

  const stopPct = (Math.abs(i.entry - i.stop) / i.entry) * 100;
  const stopCapPct = i.planId && pos(i.planMaxStopPct) ? i.planMaxStopPct : SCALP_STOP_CAP_PCT;
  if (stopPct > stopCapPct) reasons.push('stop_too_wide');

  if (caps.maxSizeUsd !== null && i.sizeUsd > caps.maxSizeUsd) reasons.push('size_over_cap');
  if (caps.maxLeverage !== null && i.leverage > caps.maxLeverage) reasons.push('leverage_over_cap');

  const costBps = risk && risk.costBpsByDirection && isNum(risk.costBpsByDirection[direction]) ? risk.costBpsByDirection[direction] : 34;
  const feesUsd = (i.sizeUsd * costBps) / 10_000;
  const maxLossUsd = (i.sizeUsd * stopPct) / 100 + feesUsd;
  if (caps.maxLossUsdPerTrade !== null && maxLossUsd > caps.maxLossUsdPerTrade) reasons.push('loss_over_cap');

  const liqLeverageCap = maxLeverageForStop(stopPct, risk);
  if (liqLeverageCap === null || i.leverage > liqLeverageCap) reasons.push('liquidation_inside_stop');

  Object.assign(derived, {
    stopPct: r4(stopPct), stopCapPct, costBps, feesUsd: r2(feesUsd), maxLossUsd: r2(maxLossUsd),
    marginUsd: r2(i.sizeUsd / i.leverage), liqLeverageCap
  });
  return { reasons, derived };
}

/** Realized loss today (USD, >= 0) from journal closes + audit closes not journaled. */
export async function dailyLossUsd(store, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  try {
    const [j, a] = await Promise.all([readBlob(store.get, journalDayPath(day)), readBlob(store.get, auditDayPath(day))]);
    const journal = parseJsonlObjects(j && j.text).filter((r) => r.kind === 'close' && isNum(r.resultUsd));
    const journalIds = new Set(journal.map((r) => r.id));
    let pnl = journal.reduce((s, r) => s + r.resultUsd, 0);
    for (const r of parseJsonlObjects(a && a.text)) {
      if (r.event === 'close' && r.mode === 'live' && isNum(r.realizedPnlUsd) && !journalIds.has(r.journalId)) pnl += r.realizedPnlUsd;
    }
    return { ok: true, lossUsd: r2(Math.max(0, -pnl)) };
  } catch (err) {
    return { ok: false, lossUsd: null, error: errName(err) };
  }
}

function orderSummary(order, nonce) {
  const arrow = order.direction === 'long' ? '▲ LONG' : '▼ SHORT';
  const banner = order.mode === 'live' ? 'LIVE' : 'DRY RUN';
  if (order.action === 'close') {
    return [`CLOSE · ${order.symbol} ${arrow} · ${banner}`, `close ${order.sizeUsd ? `$${order.sizeUsd}` : 'all'} of $${order.positionSizeUsd}`, `confirm: /confirm ${nonce} <PIN> within ${TICKET_TTL_MS / 1000}s`].join('\n');
  }
  if (order.action === 'update') {
    return [`SET SL/TP · ${order.symbol} ${arrow} · ${banner}`, `SL ${order.stop ?? '-'} · TP ${order.tp ?? '-'}`, `confirm: /confirm ${nonce} <PIN> within ${TICKET_TTL_MS / 1000}s`].join('\n');
  }
  return [
    `ORDER · ${order.symbol} ${arrow} · ${banner}`,
    `size $${order.sizeUsd} · ${order.leverage}x · margin $${order.marginUsd}`,
    `entry ~${order.expectedFill} · SL ${order.stop} (${order.stopPct}%) · TP1 ${order.tp1}${order.tp2 ? ` · TP2 ${order.tp2}` : ''}`,
    `max loss $${order.maxLossUsd} · fees ~$${order.feesUsd}`,
    `confirm: /confirm ${nonce} <PIN> within ${TICKET_TTL_MS / 1000}s`
  ].join('\n');
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.jupiter] - {getPerpMarkets, checkCustodyCapacity, getPerpQuote, openPerpPosition, closePerpPosition, updatePerpPosition, getPerpPositions}
 * @param {{getAddress: () => Promise<string>|string}} [deps.wallet]
 * @param {{get:Function, put:Function, head?:Function}} [deps.store]
 * @param {(record:Object) => Promise<Object>} [deps.appendJournal]
 * @param {() => Promise<Object<string,number>>} [deps.getMarkPrices] - BTC|ETH|SOL -> mark
 * @param {() => Promise<number|null>} [deps.getMarginUsd]
 * @param {() => number} [deps.now]
 * @param {Object} [deps.env]
 * @param {Function} [deps.randomBytes]
 * @param {Object} [deps.capabilities] - overrides LIVE_CAPABILITIES (tests)
 * @param {Object} [deps.risk] - ENGINE_CONFIG.risk
 */
export function createExecutor(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const store = deps.store || { get: blobGet, put: blobPut, head: blobHead };
  const caps = { ...LIVE_CAPABILITIES, ...(deps.capabilities || {}) };
  const risk = deps.risk || ENGINE_CONFIG.risk;

  let jupiterCache = deps.jupiter || null;
  const jupiter = async () => jupiterCache || (jupiterCache = await import('../../services/jupiterPerps.js'));
  const walletAddress = async () => {
    if (deps.wallet) return deps.wallet.getAddress();
    const wm = await import('../../services/walletManager.js');
    return wm.getWalletAddress();
  };
  const appendJournal = deps.appendJournal || (async (record) => {
    const { appendRecord } = await import('../../api/journal.js');
    return appendRecord(store, record);
  });

  const newId = (prefix) => `${prefix}_${Buffer.from(randomBytes(8)).toString('hex')}`;
  const audit = (event, fields, mode = null) => appendAudit(store, event, fields, { nowMs: now(), id: newId('ex'), mode, env });

  async function journal(body) {
    try {
      const checked = validateJournalEntry(body, { now: now(), newId: () => newId('x'), source: 'execution' });
      if (!checked.ok) return { ok: false, error: 'journal_invalid' };
      await appendJournal(checked.record);
      return { ok: true, id: checked.record.id };
    } catch (err) {
      return { ok: false, error: `journal_${errName(err)}` };
    }
  }

  /** Config + owner + kill. `reasons` empty = pass. */
  async function baseGates(ctx) {
    const cfg = readExecutionConfig(env);
    const reasons = [...cfg.reasons];
    if (!isOwner(cfg, ctx && ctx.userId)) reasons.push('not_owner');
    const kill = killStatus(cfg, await readKillState(store), now());
    if (kill.active) reasons.push(kill.source === 'unavailable' ? 'kill_state_unavailable' : 'kill_switch');
    return { cfg, kill, reasons };
  }

  async function readPositions() {
    try {
      const j = await jupiter();
      let addr;
      try { addr = await walletAddress(); } catch { addr = null; }
      // Dry mode with no signing key configured: read the tracked public wallet instead.
      if (!addr && readExecutionConfig(env).mode === 'dry' && typeof env.TRACKED_WALLET_ADDRESS === 'string' && env.TRACKED_WALLET_ADDRESS.trim()) addr = env.TRACKED_WALLET_ADDRESS.trim();
      if (!addr) return { ok: false, positions: [], error: 'wallet_unavailable' };
      let markPrices = {};
      if (deps.getMarkPrices) { try { markPrices = (await deps.getMarkPrices()) || {}; } catch { markPrices = {}; } }
      const r = await j.getPerpPositions(addr, { markPrices });
      if (Array.isArray(r)) return { ok: true, positions: r, error: null };
      return r && typeof r === 'object' ? { ok: Boolean(r.ok), positions: Array.isArray(r.positions) ? r.positions : [], error: r.error || null } : { ok: false, positions: [], error: 'positions_unavailable' };
    } catch (err) {
      return { ok: false, positions: [], error: `positions_${errName(err)}` };
    }
  }

  /** PIN check with the wrong-PIN counter; `null` = PIN ok. */
  async function pinGate(pin) {
    if (pinMatches(pin, env)) { await resetWrongPin(store); return null; }
    const w = await recordWrongPin(store, now());
    await audit('pin_wrong', { wrongAttempts: w.count, autoKilled: w.killed });
    return w.killed ? ['pin_wrong', 'auto_killed'] : ['pin_wrong'];
  }

  // ------------------------------------------------------------------ preflight

  async function preflight(intent, ctx = {}) {
    const out = { ok: false, reasons: [], quote: null, order: null };
    try {
      const { cfg, reasons } = await baseGates(ctx);
      const { reasons: intentReasons, derived } = checkIntent(intent, cfg.caps, risk);
      reasons.push(...intentReasons);
      if (cfg.mode === 'live' && !caps.openWithStops) reasons.push('live_sl_tp_unsupported');
      const i = intent || {};
      const auditIntent = { symbol: derived.symbol, direction: derived.direction, sizeUsd: i.sizeUsd ?? null, leverage: i.leverage ?? null, entry: i.entry ?? null, stop: i.stop ?? null, tp1: i.tp1 ?? null, tp2: i.tp2 ?? null, planId: i.planId ?? null, candidateId: i.candidateId ?? null, source: i.source ?? null };
      if (reasons.length) {
        out.reasons = [...new Set(reasons)];
        await audit('preflight', { intent: auditIntent, ok: false, reasons: out.reasons }, cfg.mode);
        return out;
      }

      // Live data: daily loss, open positions, market, custody, quote. Any failure refuses.
      const loss = await dailyLossUsd(store, now());
      if (!loss.ok) reasons.push('daily_loss_unavailable');
      else if (loss.lossUsd + derived.maxLossUsd > cfg.caps.maxDailyLossUsd) reasons.push('daily_loss_cap');

      const positions = await readPositions();
      if (!positions.ok) reasons.push('positions_unavailable');
      else if (positions.positions.length >= cfg.caps.maxOpenPositions) reasons.push('max_open_positions');

      const j = await jupiter();
      let markets = null;
      try { markets = await j.getPerpMarkets(); } catch { markets = null; }
      if (!markets || !markets[derived.market]) reasons.push('market_unavailable');

      let custody = null;
      try { custody = await j.checkCustodyCapacity(derived.market, i.sizeUsd); } catch { custody = null; }
      if (!custody) reasons.push('custody_unavailable');

      let quote = null;
      try { quote = await j.getPerpQuote(derived.market, derived.direction, i.sizeUsd, i.leverage); } catch { quote = null; }
      if (!quote) reasons.push('quote_unavailable');
      out.quote = quote ? {
        market: derived.market, direction: derived.direction, sizeUsd: i.sizeUsd, leverage: i.leverage,
        marginRequiredUsd: r2(quote.marginRequired), venueFeesUsd: r2(quote.estimatedFees), liquidationPrice: quote.liquidationPrice ?? null
      } : null;

      const order = {
        action: 'open', mode: cfg.mode, symbol: derived.symbol, market: derived.market, direction: derived.direction,
        sizeUsd: i.sizeUsd, leverage: i.leverage, entry: i.entry, expectedFill: i.entry, fillSource: 'intent',
        stop: i.stop, tp1: i.tp1, tp2: pos(i.tp2) ? i.tp2 : null, stopPct: derived.stopPct, stopCapPct: derived.stopCapPct,
        marginUsd: derived.marginUsd, feesUsd: derived.feesUsd, maxLossUsd: derived.maxLossUsd, liqLeverageCap: derived.liqLeverageCap,
        dailyLossUsd: loss.ok ? loss.lossUsd : null, openPositions: positions.ok ? positions.positions.length : null,
        custodyAssetsUsd: custody && isNum(custody.currentAssets) ? r2(custody.currentAssets) : null,
        planId: typeof i.planId === 'string' ? i.planId : null, candidateId: typeof i.candidateId === 'string' ? i.candidateId : null,
        planMaxStopPct: pos(i.planMaxStopPct) ? i.planMaxStopPct : null,
        recClass: typeof i.recClass === 'string' ? i.recClass : null,
        source: typeof i.source === 'string' ? i.source : 'telegram'
      };
      out.order = order;
      out.reasons = [...new Set(reasons)];
      out.ok = out.reasons.length === 0;
      await audit('preflight', { intent: auditIntent, ok: out.ok, reasons: out.reasons, quote: out.quote, order: out.ok ? order : null }, cfg.mode);
      return out;
    } catch (err) {
      out.reasons = [`preflight_error:${errName(err)}`];
      await audit('error', { stage: 'preflight', error: errMsg(err) });
      return out;
    }
  }

  // ------------------------------------------------------------------ tickets

  async function createTicket(order, ctx = {}) {
    try {
      if (!order || !['open', 'close', 'update'].includes(order.action)) return { ok: false, reasons: ['order_invalid'] };
      const t = await storeTicket(store, order, { nowMs: now(), userId: ctx.userId ?? null, randomBytes });
      if (!t.ok) return { ok: false, reasons: ['tickets_unavailable'] };
      await audit('ticket', { nonceTail: t.nonce.slice(-4), action: order.action, symbol: order.symbol || null, direction: order.direction || null, expiresAt: t.expiresAt }, order.mode || null);
      return { ok: true, nonce: t.nonce, expiresAt: t.expiresAt, summaryText: orderSummary(order, t.nonce) };
    } catch (err) {
      return { ok: false, reasons: [`ticket_error:${errName(err)}`] };
    }
  }

  // ------------------------------------------------------------------ open

  async function executeOpen(order, ctx) {
    const intent = {
      symbol: order.symbol, direction: order.direction, sizeUsd: order.sizeUsd, leverage: order.leverage, entry: order.entry,
      stop: order.stop, tp1: order.tp1, tp2: order.tp2, planId: order.planId, candidateId: order.candidateId,
      planMaxStopPct: order.planMaxStopPct, recClass: order.recClass, source: order.source
    };
    const pf = await preflight(intent, ctx);
    if (!pf.ok) {
      await audit('confirm', { action: 'open', ok: false, reasons: pf.reasons });
      return { ok: false, mode: pf.order ? pf.order.mode : readExecutionConfig(env).mode, reasons: pf.reasons, error: 'preflight_failed' };
    }
    const o = pf.order;
    const engineRef = { candidateId: o.candidateId, planId: o.planId, recClass: ['GOOD', 'WATCH', 'BAD', 'DATA_UNAVAILABLE'].includes(o.recClass) ? o.recClass : null, reasonCode: null };
    if (o.mode === 'dry') {
      const dryRunId = newId('dry');
      await audit('fill', { action: 'open', dryRunId, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage, expectedFill: o.expectedFill, stop: o.stop, tp1: o.tp1, maxLossUsd: o.maxLossUsd, planId: o.planId, candidateId: o.candidateId }, 'dry');
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, entry: o.expectedFill, stop: o.stop, tp1: o.tp1, sizeUsd: o.sizeUsd, leverage: o.leverage, engineRef, text: `DRY order ${o.symbol} ${o.direction} $${o.sizeUsd} ${o.leverage}x · SL ${o.stop} · TP1 ${o.tp1} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, order: o, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    try {
      const j = await jupiter();
      const r = await j.openPerpPosition(o.market, o.direction, o.sizeUsd, o.leverage, o.stop, o.tp1);
      const txSignature = r && typeof r.signature === 'string' ? r.signature : null;
      const position = { positionId: r && r.positionId ? String(r.positionId) : null, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage, stop: o.stop, tp1: o.tp1 };
      const jr = await journal({ kind: 'open', symbol: o.symbol, direction: o.direction, entry: o.expectedFill, stop: o.stop, tp1: o.tp1, sizeUsd: o.sizeUsd, leverage: o.leverage, engineRef, text: `LIVE order ${o.symbol} ${o.direction} $${o.sizeUsd} ${o.leverage}x · tx ${txSignature ? txSignature.slice(0, 12) : 'n/a'}` });
      await audit('fill', { action: 'open', txSignature, positionId: position.positionId, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage, stop: o.stop, tp1: o.tp1, journalId: jr.ok ? jr.id : null }, 'live');
      return { ok: true, mode: 'live', txSignature, position, order: o, journal: jr.ok ? jr.id : null, reasons: [] };
    } catch (err) {
      await audit('error', { stage: 'open', symbol: o.symbol, direction: o.direction, error: errMsg(err) }, 'live');
      return { ok: false, mode: 'live', error: errMsg(err), reasons: ['open_failed'] };
    }
  }

  // ------------------------------------------------------------------ close / update

  async function findPosition(positionId) {
    const p = await readPositions();
    if (!p.ok) return { reason: 'positions_unavailable' };
    const hit = p.positions.find((x) => x.positionId === positionId);
    return hit ? { position: hit } : { reason: 'position_not_found' };
  }

  async function prepareClose(positionId, sizeUsd = null, ctx = {}) {
    try {
      const { cfg, reasons } = await baseGates(ctx);
      if (cfg.mode === 'live' && !caps.close) reasons.push('live_close_unsupported');
      if (typeof positionId !== 'string' || !positionId) reasons.push('position_id_required');
      if (!(sizeUsd === null || sizeUsd === undefined || pos(sizeUsd))) reasons.push('size_invalid');
      if (reasons.length) return { ok: false, reasons: [...new Set(reasons)], order: null };
      const f = await findPosition(positionId);
      if (f.reason) return { ok: false, reasons: [f.reason], order: null };
      const p = f.position;
      if (pos(sizeUsd) && sizeUsd > p.sizeUsd) return { ok: false, reasons: ['size_over_position'], order: null };
      const partial = pos(sizeUsd) && sizeUsd < p.sizeUsd ? sizeUsd : null;
      return { ok: true, reasons: [], order: { action: 'close', mode: cfg.mode, positionId, symbol: p.symbol, direction: p.direction, sizeUsd: partial, positionSizeUsd: p.sizeUsd } };
    } catch (err) {
      return { ok: false, reasons: [`close_error:${errName(err)}`], order: null };
    }
  }

  async function prepareUpdate(positionId, stop = null, tp = null, ctx = {}) {
    try {
      const { cfg, reasons } = await baseGates(ctx);
      if (cfg.mode === 'live' && !caps.update) reasons.push('live_update_unsupported');
      if (typeof positionId !== 'string' || !positionId) reasons.push('position_id_required');
      if (!pos(stop) && !pos(tp)) reasons.push('stop_or_tp_required');
      if (!(stop === null || stop === undefined || pos(stop))) reasons.push('stop_invalid');
      if (!(tp === null || tp === undefined || pos(tp))) reasons.push('tp_invalid');
      if (reasons.length) return { ok: false, reasons: [...new Set(reasons)], order: null };
      const f = await findPosition(positionId);
      if (f.reason) return { ok: false, reasons: [f.reason], order: null };
      const p = f.position;
      const long = p.direction === 'long';
      const ref = pos(p.markPrice) ? p.markPrice : p.entryPrice;
      if (pos(stop) && pos(ref) && (long ? !(stop < ref) : !(stop > ref))) reasons.push('stop_wrong_side');
      if (pos(tp) && pos(ref) && (long ? !(tp > ref) : !(tp < ref))) reasons.push('tp_wrong_side');
      if (pos(stop) && pos(p.liquidationPrice) && (long ? !(stop > p.liquidationPrice) : !(stop < p.liquidationPrice))) reasons.push('stop_beyond_liquidation');
      if (reasons.length) return { ok: false, reasons, order: null };
      return { ok: true, reasons: [], order: { action: 'update', mode: cfg.mode, positionId, symbol: p.symbol, direction: p.direction, stop: pos(stop) ? stop : null, tp: pos(tp) ? tp : null } };
    } catch (err) {
      return { ok: false, reasons: [`update_error:${errName(err)}`], order: null };
    }
  }

  async function executeClose(order, ctx) {
    const prep = await prepareClose(order.positionId, order.sizeUsd, ctx);
    if (!prep.ok) {
      await audit('close', { ok: false, positionId: order.positionId, reasons: prep.reasons });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: prep.reasons, error: 'close_refused' };
    }
    const o = prep.order;
    const f = await findPosition(o.positionId);
    const p = f.position || {};
    const fraction = o.sizeUsd ? o.sizeUsd / o.positionSizeUsd : 1;
    const estPnl = isNum(p.unrealizedPnlUsd) ? r2(p.unrealizedPnlUsd * fraction) : null;
    const label = o.sizeUsd ? `$${o.sizeUsd}` : 'all';
    if (o.mode === 'dry') {
      const dryRunId = newId('dry');
      await audit('close', { ok: true, dryRunId, positionId: o.positionId, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, estPnlUsd: estPnl }, 'dry');
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, text: `DRY close ${o.symbol} ${o.direction} ${label} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    try {
      const j = await jupiter();
      const r = await j.closePerpPosition(o.positionId, o.sizeUsd);
      const txSignature = r && typeof r.signature === 'string' ? r.signature : null;
      if (!txSignature || /placeholder/i.test(txSignature)) throw new Error('close not executed on chain');
      const jr = await journal({ kind: 'close', symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd || o.positionSizeUsd, exitPrice: pos(p.markPrice) ? p.markPrice : null, resultUsd: estPnl, text: `LIVE close ${o.symbol} ${o.direction} ${label} · tx ${txSignature.slice(0, 12)}${estPnl !== null ? ` · est PnL $${estPnl}` : ''}` });
      await audit('close', { ok: true, txSignature, positionId: o.positionId, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, realizedPnlUsd: estPnl, journalId: jr.ok ? jr.id : null }, 'live');
      return { ok: true, mode: 'live', txSignature, journal: jr.ok ? jr.id : null, reasons: [] };
    } catch (err) {
      await audit('error', { stage: 'close', positionId: o.positionId, error: errMsg(err) }, 'live');
      return { ok: false, mode: 'live', error: errMsg(err), reasons: ['close_failed'] };
    }
  }

  async function executeUpdate(order, ctx) {
    const prep = await prepareUpdate(order.positionId, order.stop, order.tp, ctx);
    if (!prep.ok) {
      await audit('adjust', { ok: false, positionId: order.positionId, reasons: prep.reasons });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: prep.reasons, error: 'update_refused' };
    }
    const o = prep.order;
    if (o.mode === 'dry') {
      const dryRunId = newId('dry');
      await audit('adjust', { ok: true, dryRunId, positionId: o.positionId, symbol: o.symbol, direction: o.direction, stop: o.stop, tp: o.tp }, 'dry');
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, stop: o.stop, tp1: o.tp, text: `DRY set SL/TP ${o.symbol} ${o.direction} · SL ${o.stop ?? '-'} · TP ${o.tp ?? '-'} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    try {
      const j = await jupiter();
      const r = await j.updatePerpPosition(o.positionId, o.stop, o.tp);
      const txSignature = r && typeof r.signature === 'string' ? r.signature : null;
      if (!txSignature || /placeholder/i.test(txSignature)) throw new Error('update not executed on chain');
      const jr = await journal({ kind: 'adjust', symbol: o.symbol, direction: o.direction, stop: o.stop, tp1: o.tp, text: `LIVE set SL/TP ${o.symbol} ${o.direction} · SL ${o.stop ?? '-'} · TP ${o.tp ?? '-'} · tx ${txSignature.slice(0, 12)}` });
      await audit('adjust', { ok: true, txSignature, positionId: o.positionId, stop: o.stop, tp: o.tp, journalId: jr.ok ? jr.id : null }, 'live');
      return { ok: true, mode: 'live', txSignature, journal: jr.ok ? jr.id : null, reasons: [] };
    } catch (err) {
      await audit('error', { stage: 'update', positionId: o.positionId, error: errMsg(err) }, 'live');
      return { ok: false, mode: 'live', error: errMsg(err), reasons: ['update_failed'] };
    }
  }

  /** Gates + owner + kill + PIN (wrong-PIN counted). null = pass, else {ok:false, ...}. */
  async function pinnedGates(pin, ctx) {
    const { cfg, reasons } = await baseGates(ctx);
    if (reasons.length) return { ok: false, mode: cfg.mode, reasons: [...new Set(reasons)], error: 'gates_failed' };
    const bad = await pinGate(pin);
    if (bad) return { ok: false, mode: cfg.mode, reasons: bad, error: 'pin_wrong' };
    return null;
  }

  // ------------------------------------------------------------------ confirm

  async function confirm(nonce, pin, ctx = {}) {
    try {
      const { cfg, reasons } = await baseGates(ctx);
      if (reasons.length) {
        const rs = [...new Set(reasons)];
        await audit('confirm', { ok: false, reasons: rs }, cfg.mode);
        return { ok: false, mode: cfg.mode, reasons: rs, error: 'gates_failed' };
      }
      const peek = await peekTicket(store, nonce, { nowMs: now(), userId: ctx.userId ?? null });
      if (!peek.ok) {
        await audit('confirm', { ok: false, reasons: [peek.reason] }, cfg.mode);
        return { ok: false, mode: cfg.mode, reasons: [peek.reason], error: peek.reason };
      }
      const bad = await pinGate(pin);
      if (bad) return { ok: false, mode: cfg.mode, reasons: bad, error: 'pin_wrong' };
      const used = await consumeTicket(store, nonce, { nowMs: now(), userId: ctx.userId ?? null });
      if (!used.ok) {
        await audit('confirm', { ok: false, reasons: [used.reason] }, cfg.mode);
        return { ok: false, mode: cfg.mode, reasons: [used.reason], error: used.reason };
      }
      await audit('confirm', { ok: true, action: used.order.action, nonceTail: String(nonce).slice(-4) }, cfg.mode);
      if (used.order.action === 'open') return executeOpen(used.order, ctx);
      if (used.order.action === 'close') return executeClose(used.order, ctx);
      if (used.order.action === 'update') return executeUpdate(used.order, ctx);
      return { ok: false, mode: cfg.mode, reasons: ['order_invalid'], error: 'order_invalid' };
    } catch (err) {
      await audit('error', { stage: 'confirm', error: errMsg(err) });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: [`confirm_error:${errName(err)}`], error: errMsg(err) };
    }
  }

  async function closePosition(positionId, sizeUsd = null, pin, ctx = {}) {
    try {
      const fail = await pinnedGates(pin, ctx);
      if (fail) { await audit('close', { ok: false, positionId: typeof positionId === 'string' ? positionId : null, reasons: fail.reasons }, fail.mode); return fail; }
      return executeClose({ action: 'close', positionId, sizeUsd }, ctx);
    } catch (err) {
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: [`close_error:${errName(err)}`], error: errMsg(err) };
    }
  }

  async function updateStops(positionId, stop = null, tp = null, pin, ctx = {}) {
    try {
      const fail = await pinnedGates(pin, ctx);
      if (fail) { await audit('adjust', { ok: false, positionId: typeof positionId === 'string' ? positionId : null, reasons: fail.reasons }, fail.mode); return fail; }
      return executeUpdate({ action: 'update', positionId, stop, tp }, ctx);
    } catch (err) {
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: [`update_error:${errName(err)}`], error: errMsg(err) };
    }
  }

  // ------------------------------------------------------------------ reads, kill, arm

  async function listPositions() {
    const r = await readPositions();
    return { ok: r.ok, positions: r.positions, error: r.error };
  }

  async function status() {
    try {
      const cfg = readExecutionConfig(env);
      const kill = killStatus(cfg, await readKillState(store), now());
      const loss = await dailyLossUsd(store, now());
      let openCount = null;
      if (cfg.enabled) {
        const p = await readPositions();
        openCount = p.ok ? p.positions.length : null;
      }
      let walletMarginUsd = null;
      if (deps.getMarginUsd) { try { walletMarginUsd = r2(await deps.getMarginUsd()); } catch { walletMarginUsd = null; } }
      return {
        ok: true, enabled: cfg.enabled, mode: cfg.mode, configReasons: cfg.reasons,
        kill: { active: kill.active, source: kill.source, reason: kill.reason, until: kill.until },
        caps: cfg.caps, dailyLossUsd: loss.ok ? loss.lossUsd : null, openCount, walletMarginUsd,
        liveCapabilities: { ...caps }
      };
    } catch (err) {
      return { ok: false, error: `status_${errName(err)}` };
    }
  }

  /** /kill: owner only, no PIN, immediate. */
  async function kill(ctx = {}, reason = 'manual') {
    const cfg = readExecutionConfig(env);
    if (!isOwner(cfg, ctx.userId)) return { ok: false, reasons: ['not_owner'] };
    const r = await setKill(store, { reason: String(reason || 'manual').slice(0, 40) }, now());
    await audit('kill', { ok: r.ok, reason: String(reason || 'manual').slice(0, 40) }, cfg.mode);
    return r.ok ? { ok: true, reasons: [] } : { ok: false, reasons: ['kill_write_failed'] };
  }

  /** /arm <PIN>: owner + PIN; clears the Blob kill flag. Env kill stays. */
  async function arm(pin, ctx = {}) {
    const cfg = readExecutionConfig(env);
    if (!isOwner(cfg, ctx.userId)) return { ok: false, reasons: ['not_owner'] };
    if (!cfg.pinConfigured) return { ok: false, reasons: ['pin_not_configured'] };
    const bad = await pinGate(pin);
    if (bad) return { ok: false, reasons: bad };
    const r = await clearKill(store, now());
    await audit('arm', { ok: r.ok, envKill: cfg.killEnv }, cfg.mode);
    return r.ok ? { ok: true, reasons: [], envKillStill: cfg.killEnv } : { ok: false, reasons: ['kill_write_failed'] };
  }

  return { preflight, createTicket, confirm, closePosition, updateStops, listPositions, status, prepareClose, prepareUpdate, kill, arm };
}

let defaultExecutor = null;
const def = () => defaultExecutor || (defaultExecutor = createExecutor());

export const preflight = (intent, ctx) => def().preflight(intent, ctx);
export const createTicket = (order, ctx) => def().createTicket(order, ctx);
export const confirm = (nonce, pin, ctx) => def().confirm(nonce, pin, ctx);
export const closePosition = (positionId, sizeUsd, pin, ctx) => def().closePosition(positionId, sizeUsd, pin, ctx);
export const updateStops = (positionId, stop, tp, pin, ctx) => def().updateStops(positionId, stop, tp, pin, ctx);
export const listPositions = () => def().listPositions();
export const status = () => def().status();
export const prepareClose = (positionId, sizeUsd, ctx) => def().prepareClose(positionId, sizeUsd, ctx);
export const prepareUpdate = (positionId, stop, tp, ctx) => def().prepareUpdate(positionId, stop, tp, ctx);
export const kill = (ctx, reason) => def().kill(ctx, reason);
export const arm = (pin, ctx) => def().arm(pin, ctx);
