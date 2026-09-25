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
 * Live capability gate: LIVE_CAPABILITIES is now all true (T-3 F). A live open is a
 * two-phase flow (docs/PLAN_LIVE_PERPS_TEST.md "Keeper fill is asynchronous"): submit the
 * increase WITHOUT stops -> land (services/jupiterPerps.js sendSigned/landTransaction,
 * rebroadcast + expiry) -> waitForFill (poll the keeper fill) -> build + land the SL/TP
 * trigger requests -> verify (on-chain position read + trigger-request existence) -> audit
 * phase events `submitted`, `filled`, `stops_attached`, `verified` -> journal `open` only
 * once verified, with the fill price read off the position account. If stop attachment (or
 * verification) fails after the position is filled, the executor immediately submits a full
 * market close (`emergencyClose`) so no position is ever left without a stop; if that close
 * also fails it engages the kill switch and retries the close every 5 s for up to 2 min
 * (`deps.sleep`, real timers in production, injectable in tests), alerting via
 * `deps.onAlert` at each turning point. Live close / update stay on the existing
 * build -> simulate -> sendSigned path (jupiterPerps.js's legacy wrappers), which now lands
 * through the same rebroadcast/expiry machinery for free, plus a post-send on-chain verify
 * before journaling.
 *
 * Exactly-once: every live open/close/update run gets an actionId (ticket-nonce derived,
 * so a fresh ticket is always a fresh id). Its terminal result is recorded in Blob
 * `execution/actions.json` (ETag-guarded) the first time it is reached; if the SAME
 * actionId is ever resolved again (e.g. a crash-recovery replay), the recorded result is
 * returned verbatim and nothing is rebuilt, resent or re-journaled.
 *
 * Fill freshness: preflight (and so confirm, which re-runs it) prices the order at the
 * symbol's live mark (payload symbols.X.mark.price when mark.status is 'ok', else the
 * Kraken close), taken from `ctx.mark` when the caller passes it or from the injected
 * engine build (deps.buildContext). It refuses `fill_drift` when the fill is more than
 * EXECUTION_MAX_ENTRY_DRIFT_BPS (default 15) from intent.entry, and re-checks stop side,
 * the 3% stop cap and max loss against that fill. The Jupiter quote (getPerpQuote) is
 * still a placeholder estimate until agent D lands a real venue quote; it only feeds
 * margin / fee display, never the fill.
 *
 * Public Blob: audit lines carry positionIdHash / txSignatureHash (idHash), never the
 * full values or a Telegram user id; tickets carry an owner hash and, for close / update,
 * the positionIdHash only (resolved against the chain read at execution).
 *
 * Everything is injected (createExecutor(deps)) so tests run with no network and no key.
 * The default deps load services/jupiterPerps.js and services/walletManager.js lazily, on
 * first use past the gates, never at import.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet, head as blobHead } from '@vercel/blob';
import { readBlob, updateBlob, parseJsonlObjects } from '../blobJsonl.js';
import { validateJournalEntry, journalDayPath } from '../journalSchema.js';
import { maxLeverageForStop } from '../riskEngine.js';
import { ENGINE_CONFIG } from '../../config/engine.js';
import {
  readExecutionConfig, pinMatches, isOwner, readKillState, killStatus, setKill, clearKill,
  recordWrongPin, resetWrongPin, autoKillActive, autoKillUntil, AUTO_KILL_REASON, WRONG_PIN_WINDOW_MS
} from './gates.js';
import { appendAudit, auditDayPath, idHash, redact } from './audit.js';
import { storeTicket, peekTicket, consumeTicket, TICKET_TTL_MS } from './tickets.js';

export const SCALP_STOP_CAP_PCT = 3;
export const SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const LIVE_CAPABILITIES = Object.freeze({ openWithStops: true, close: true, update: true });
export const DEFAULT_MAX_ENTRY_DRIFT_BPS = 15;
/** Days of journal scanned for the open entry a close / adjust links to. */
export const OPEN_LOOKUP_DAYS = 7;

/** Exactly-once ledger of terminal live action results (T-3 F). */
export const ACTIONS_PATH = 'execution/actions.json';
export const ACTIONS_SCHEMA = 'execution-actions-1';
export const ACTIONS_PRUNE_AFTER_MS = 7 * 86_400_000;
/** Emergency-close retry cadence when a naked position's close itself fails (T-3 F). */
export const EMERGENCY_CLOSE_RETRY_MS = 5000;
export const EMERGENCY_CLOSE_MAX_MS = 2 * 60_000;

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

/** EXECUTION_MAX_ENTRY_DRIFT_BPS (positive number) or the default 15. */
export function maxEntryDriftBps(env) {
  const n = Number(env && env.EXECUTION_MAX_ENTRY_DRIFT_BPS);
  return env && env.EXECUTION_MAX_ENTRY_DRIFT_BPS !== undefined && env.EXECUTION_MAX_ENTRY_DRIFT_BPS !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ENTRY_DRIFT_BPS;
}

/**
 * Fill reference from a payload symbol (or a ctx.mark object): the mark when
 * status 'ok', else the Kraken close. {price, source:'mark'|'kraken_close'} or null.
 */
export function fillFromSymbol(s) {
  if (!s || typeof s !== 'object') return null;
  const m = s.mark && typeof s.mark === 'object' ? s.mark : null;
  if (m && m.status === 'ok' && pos(m.price)) return { price: m.price, source: 'mark' };
  const close = pos(s.price) ? s.price : pos(s.close) ? s.close : null;
  return close ? { price: close, source: 'kraken_close' } : null;
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
  const stopCapPct = SCALP_STOP_CAP_PCT; // absolute: no plan can widen it
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
 * @param {Object} [deps.jupiter] - {getPerpMarkets, checkCustodyCapacity, getPerpQuote,
 *   openPerpPosition, closePerpPosition, updatePerpPosition, getPerpPositions,
 *   buildOpenPosition, waitForFill, buildUpdateStops, buildClosePosition,
 *   buildCancelIncreaseRequest, fetchAccountsExist, createKitSigner} (T-3 F additions)
 * @param {{getAddress: () => Promise<string>|string}} [deps.wallet]
 * @param {*} [deps.signer] - @solana/kit signer passed straight to `built.send(signer)`
 *   (T-3 F live open/emergency-close); default lazily builds one from the signing wallet
 *   via jupiter().createKitSigner
 * @param {{get:Function, put:Function, head?:Function}} [deps.store]
 * @param {(record:Object) => Promise<Object>} [deps.appendJournal]
 * @param {() => Promise<Object<string,number>>} [deps.getMarkPrices] - BTC|ETH|SOL -> mark
 * @param {() => Promise<number|null>} [deps.getMarginUsd]
 * @param {(opts:{symbols:string[]}) => Promise<Object>} [deps.buildContext] - engine build
 *   (payload with symbols.X.mark / price); default lazily loads buildScalpContext
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep] - real timers by default; tests inject
 *   an instant fake (T-3 F emergency-close retry loop)
 * @param {(text:string, meta?:Object) => Promise<void>} [deps.onAlert] - best-effort owner
 *   alert (T-3 F: naked-position / kill-engaged notices); no-op by default
 * @param {Object} [deps.env]
 * @param {Function} [deps.randomBytes]
 * @param {Object} [deps.capabilities] - overrides LIVE_CAPABILITIES (tests)
 * @param {Object} [deps.risk] - ENGINE_CONFIG.risk
 */
export function createExecutor(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
  /** @solana/kit signer for a live send (build*().send(signer)); lazy, never at import. */
  const getSigner = async (j) => {
    if (deps.signer) return deps.signer;
    const wm = await import('../../services/walletManager.js');
    return j.createKitSigner(wm.getWallet());
  };
  const alert = async (text, meta = {}) => {
    if (!deps.onAlert) return;
    try { await deps.onAlert(text, meta); } catch { /* alerts are best effort, never block execution */ }
  };
  const appendJournal = deps.appendJournal || (async (record) => {
    const { appendRecord } = await import('../../api/journal.js');
    return appendRecord(store, record);
  });

  const buildContext = deps.buildContext || (async (opts) => {
    const m = await import('../../services/scalpContext.js');
    return m.buildScalpContext(opts);
  });
  // Per-instance fallback when the wrong-PIN counter cannot be written to Blob.
  const memPin = { count: 0, sinceMs: null, killUntilMs: null };
  const memKillActive = () => Number.isFinite(memPin.killUntilMs) && memPin.killUntilMs > now();
  const logWarn = (reason) => { try { console.warn(`[execution] reason=${reason}`); } catch { /* ignore */ } };

  const newId = (prefix) => `${prefix}_${Buffer.from(randomBytes(8)).toString('hex')}`;
  const audit = (event, fields, mode = null) => appendAudit(store, event, fields, { nowMs: now(), id: newId('ex'), mode, env });

  // ------------------------------------------------------------------ exactly-once ledger
  //
  // execution/actions.json {schemaVersion, actions:{<actionId>: <terminal result>}},
  // ETag-guarded (updateBlob). actionId = `${action}_${ticketNonce}` (a fresh ticket is
  // always a fresh id, since tickets are single-use -- see lib/execution/tickets.js); a
  // direct closePosition/updateStops call (no ticket) gets a fresh random id instead. A
  // second resolve of the SAME actionId (e.g. a crash-recovery replay) returns the
  // recorded result verbatim rather than rebuilding, resending or re-journaling.

  async function priorActionResult(actionId) {
    try {
      const b = await readBlob(store.get, ACTIONS_PATH);
      let doc; try { doc = b ? JSON.parse(b.text) : null; } catch { doc = null; }
      const actions = doc && doc.actions && typeof doc.actions === 'object' ? doc.actions : {};
      return actions[actionId] || null;
    } catch { return null; }
  }

  /**
   * Public Blob: the ledger never stores a raw tx signature or position id (idHash, same
   * policy as lib/execution/audit.js), and `redact()` strips anything secret-looking. The
   * caller (this run) still gets the FULL, unredacted `result` back -- only the STORED
   * copy is sanitized; a later replay of the same actionId returns the sanitized copy.
   */
  function sanitizeForLedger(result) {
    if (!result || typeof result !== 'object') return redact(result, env);
    const out = { ...result };
    if (typeof out.txSignature === 'string') { out.txSignatureHash = idHash(out.txSignature); delete out.txSignature; }
    if (out.position && typeof out.position === 'object' && typeof out.position.positionId === 'string') {
      out.position = { ...out.position, positionIdHash: idHash(out.position.positionId) };
      delete out.position.positionId;
    }
    if (out.emergencyClose && typeof out.emergencyClose === 'object' && typeof out.emergencyClose.txSignature === 'string') {
      out.emergencyClose = { ...out.emergencyClose, txSignatureHash: idHash(out.emergencyClose.txSignature) };
      delete out.emergencyClose.txSignature;
    }
    return redact(out, env);
  }

  async function recordActionResult(actionId, result) {
    let final = result;
    try {
      await updateBlob(store, ACTIONS_PATH, 'application/json', (text) => {
        let doc; try { doc = text ? JSON.parse(text) : null; } catch { doc = null; }
        const actions = doc && doc.actions && typeof doc.actions === 'object' ? { ...doc.actions } : {};
        if (actions[actionId]) { final = actions[actionId]; return null; }
        const nowMs = now();
        actions[actionId] = { ...sanitizeForLedger(result), at: new Date(nowMs).toISOString() };
        for (const [k, v] of Object.entries(actions)) { if (v && v.at && Date.parse(v.at) < nowMs - ACTIONS_PRUNE_AFTER_MS) delete actions[k]; }
        return `${JSON.stringify({ schemaVersion: ACTIONS_SCHEMA, actions })}\n`;
      }, { forceOnExhaust: false });
    } catch { /* best effort: the caller still gets the fresh outcome even if the ledger write failed */ }
    return final;
  }

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
    const killRead = await readKillState(store);
    const kill = killStatus(cfg, killRead, now());
    if (kill.active) reasons.push(kill.source === 'unavailable' ? 'kill_state_unavailable' : 'kill_switch');
    else if (memKillActive()) reasons.push('kill_switch');
    return { cfg, kill, killRead, reasons };
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

  // ------------------------------------------------------------------ live open: verify + emergency close

  /**
   * Post-fill, post-stops-attach verification (F3 "verify via getPerpPositions plus
   * trigger request accounts"): the position exists on chain with size > 0, and every
   * trigger-request PDA `buildUpdateStops` created still exists (landed).
   */
  async function verifyOpen(j, positionId, triggers) {
    try {
      const triggerIds = Object.values(triggers || {}).map((t) => t && t.positionRequestId).filter(Boolean);
      const [posRead, existsList] = await Promise.all([
        readPositions(),
        triggerIds.length && typeof j.fetchAccountsExist === 'function' ? j.fetchAccountsExist(triggerIds) : Promise.resolve(triggerIds.map(() => true)),
      ]);
      if (!posRead.ok) return { ok: false, reason: 'positions_unavailable' };
      const hit = posRead.positions.find((p) => p && p.positionId === positionId);
      if (!hit || !(hit.sizeUsd > 0)) return { ok: false, reason: 'position_not_found' };
      if (triggerIds.length && !existsList.every(Boolean)) return { ok: false, reason: 'triggers_missing' };
      return { ok: true, position: hit };
    } catch (err) {
      return { ok: false, reason: `verify_${errName(err)}` };
    }
  }

  /** Post-close verify: the position is gone (full close) or its size dropped (partial). */
  async function verifyClose(o) {
    try {
      const r = await readPositions();
      if (!r.ok) return { ok: false, reason: 'positions_unavailable' };
      const hit = r.positions.find((p) => p && p.positionId === o.positionId);
      if (!o.sizeUsd) return hit ? { ok: false, reason: 'position_still_open' } : { ok: true };
      return hit && !(hit.sizeUsd < o.positionSizeUsd) ? { ok: false, reason: 'size_unchanged' } : { ok: true };
    } catch (err) {
      return { ok: false, reason: `verify_${errName(err)}` };
    }
  }

  /** Post-update verify: the position is still open (an update must never have closed it). */
  async function verifyUpdate(o) {
    try {
      const r = await readPositions();
      if (!r.ok) return { ok: false, reason: 'positions_unavailable' };
      const hit = r.positions.find((p) => p && p.positionId === o.positionId);
      return hit ? { ok: true } : { ok: false, reason: 'position_not_found' };
    } catch (err) {
      return { ok: false, reason: `verify_${errName(err)}` };
    }
  }

  /**
   * A position was filled but its stops could not be attached (or verified): the naked
   * position is the highest-priority risk, so it is closed immediately at market. If that
   * close itself fails, the kill switch engages and the close is retried every
   * EMERGENCY_CLOSE_RETRY_MS for up to EMERGENCY_CLOSE_MAX_MS, auditing every attempt.
   * Always returns a failed executor result (the open never counts as successful).
   */
  async function emergencyClose(j, signer, addr, meta, o, actionId) {
    const startMs = now();
    let attempt = 0;
    let lastErr = null;
    for (;;) {
      attempt++;
      try {
        const built = await j.buildClosePosition({ positionId: meta.positionId, market: o.market, direction: o.direction, owner: addr, referencePrice: o.expectedFill });
        const sim = await built.simulate();
        if (sim.err) throw new Error(`emergency close simulation failed: ${JSON.stringify(sim.err)}`);
        const sent = await built.send(signer);
        if (!sent.simulated && !sent.signature) throw new Error('emergency close did not land');
        await audit('emergency_close', { ok: true, attempt, actionId, positionIdHash: idHash(meta.positionId), txSignatureHash: sent.signature ? idHash(sent.signature) : null }, 'live');
        await alert(`🛑 Naked position closed at market (stops attach failed) after ${attempt} attempt(s).`, { positionIdHash: idHash(meta.positionId) });
        return { ok: false, mode: 'live', reasons: ['stops_failed', 'emergency_closed'], error: 'stops_attach_failed', emergencyClose: { ok: true, attempt, txSignature: sent.signature || null } };
      } catch (err) {
        lastErr = err;
        await audit('emergency_close', { ok: false, attempt, actionId, positionIdHash: idHash(meta.positionId), error: errMsg(err) }, 'live');
        if (attempt === 1) {
          await setKill(store, { reason: 'emergency_close_failed' }, now()); // best effort
          await alert(`🛑 Naked position: emergency close FAILED, kill engaged. Retrying every ${EMERGENCY_CLOSE_RETRY_MS / 1000}s for up to ${Math.round(EMERGENCY_CLOSE_MAX_MS / 60000)} min.`, { positionIdHash: idHash(meta.positionId) });
        }
        if (now() - startMs >= EMERGENCY_CLOSE_MAX_MS) break;
        await sleep(EMERGENCY_CLOSE_RETRY_MS);
      }
    }
    await alert(`🛑 Naked position: emergency close still failing after ${attempt} attempts. Manual intervention required.`, { positionIdHash: idHash(meta.positionId) });
    return { ok: false, mode: 'live', reasons: ['stops_failed', 'emergency_close_failed', 'kill_engaged'], error: 'emergency_close_failed', emergencyClose: { ok: false, attempts: attempt, error: lastErr ? errMsg(lastErr) : null } };
  }

  /** PIN check with the wrong-PIN counter; `null` = PIN ok. */
  async function pinGate(pin) {
    if (pinMatches(pin, env)) {
      await resetWrongPin(store);
      Object.assign(memPin, { count: 0, sinceMs: null });
      return null;
    }
    const nowMs = now();
    const w = await recordWrongPin(store, nowMs);
    let { count, killed } = w;
    if (w.ok) {
      Object.assign(memPin, { count: w.count, sinceMs: memPin.sinceMs ?? nowMs });
    } else {
      // Blob write failed: the attempt still counts, in memory for this instance.
      logWarn('pin_count_write_failed');
      const inWindow = Number.isFinite(memPin.sinceMs) && nowMs - memPin.sinceMs < WRONG_PIN_WINDOW_MS;
      count = Math.max(inWindow ? memPin.count + 1 : 1, w.count || 0);
      Object.assign(memPin, { count, sinceMs: inWindow ? memPin.sinceMs : nowMs });
      const untilMs = autoKillUntil(count, memPin.killUntilMs, nowMs);
      killed = untilMs !== null;
      if (killed) {
        memPin.killUntilMs = untilMs;
        await setKill(store, { reason: AUTO_KILL_REASON, untilMs }, nowMs); // best effort
      }
    }
    await audit('pin_wrong', { wrongAttempts: count, autoKilled: killed, countStored: w.ok });
    return killed ? ['pin_wrong', 'auto_killed'] : ['pin_wrong'];
  }

  /** Live fill reference for `symbol`: ctx.mark (same symbol) or the engine build. */
  async function liveFill(symbol, ctx) {
    const m = ctx && ctx.mark && typeof ctx.mark === 'object' ? ctx.mark : null;
    if (m && (!m.symbol || baseSymbol(m.symbol) === symbol)) {
      const f = fillFromSymbol({ mark: m, price: m.close ?? m.krakenClose ?? null });
      if (f) return f;
    }
    try {
      const payload = await buildContext({ symbols: [symbol] });
      return fillFromSymbol(payload && payload.symbols ? payload.symbols[symbol] : null);
    } catch {
      return null;
    }
  }

  /** Custody headroom (USD) from checkCustodyCapacity, or null when it gives no numbers. */
  function custodyHeadroom(c) {
    if (!c || typeof c !== 'object') return null;
    if (isNum(c.headroomUsd)) return c.headroomUsd;
    if (isNum(c.availableUsd)) return c.availableUsd;
    const max = isNum(c.maxAssetsUsd) ? c.maxAssetsUsd : isNum(c.maxAssets) ? c.maxAssets : null;
    return max !== null && isNum(c.currentAssets) ? max - c.currentAssets : null;
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

      // Fill freshness: price the order at the live mark (Kraken close when the mark is not
      // ok); refuse on drift from the plan entry and re-check stop side, stop cap and max
      // loss at that fill (reasons suffixed `_at_fill`).
      const fill = await liveFill(derived.symbol, ctx);
      let atFill = null;
      let driftBps = null;
      if (!fill) reasons.push('fill_unavailable');
      else {
        driftBps = r2((Math.abs(fill.price - i.entry) / i.entry) * 10_000);
        if (driftBps > maxEntryDriftBps(env)) reasons.push('fill_drift');
        atFill = checkIntent({ ...i, entry: fill.price }, cfg.caps, risk);
        reasons.push(...atFill.reasons.map((r) => `${r}_at_fill`));
      }
      const worst = atFill && isNum(atFill.derived.maxLossUsd) && atFill.derived.maxLossUsd > derived.maxLossUsd ? atFill.derived : derived;

      // Live data: daily loss, open positions, market, custody, quote. Any failure refuses.
      const loss = await dailyLossUsd(store, now());
      if (!loss.ok) reasons.push('daily_loss_unavailable');
      else if (loss.lossUsd + worst.maxLossUsd > cfg.caps.maxDailyLossUsd) reasons.push('daily_loss_cap');

      const positions = await readPositions();
      if (!positions.ok) reasons.push('positions_unavailable');
      else if (positions.positions.length >= cfg.caps.maxOpenPositions) reasons.push('max_open_positions');

      const j = await jupiter();
      let markets = null;
      try { markets = await j.getPerpMarkets(); } catch { markets = null; }
      if (!markets || !markets[derived.market]) reasons.push('market_unavailable');

      let custody = null;
      try { custody = await j.checkCustodyCapacity(derived.market, i.sizeUsd); } catch { custody = null; }
      const headroom = custodyHeadroom(custody);
      if (!custody) reasons.push('custody_unavailable');
      else if (headroom === null) reasons.push(cfg.mode === 'live' ? 'custody_unknown' : 'warn:custody_unknown');
      else if (headroom < i.sizeUsd) reasons.push('custody_capacity');

      let quote = null;
      try { quote = await j.getPerpQuote(derived.market, derived.direction, i.sizeUsd, i.leverage); } catch { quote = null; }
      if (!quote) reasons.push('quote_unavailable');
      out.quote = quote ? {
        market: derived.market, direction: derived.direction, sizeUsd: i.sizeUsd, leverage: i.leverage,
        marginRequiredUsd: r2(quote.marginRequired), venueFeesUsd: r2(quote.estimatedFees), liquidationPrice: quote.liquidationPrice ?? null
      } : null;

      const order = {
        action: 'open', mode: cfg.mode, symbol: derived.symbol, market: derived.market, direction: derived.direction,
        sizeUsd: i.sizeUsd, leverage: i.leverage, entry: i.entry, expectedFill: fill ? fill.price : null, fillSource: fill ? fill.source : null, fillDriftBps: driftBps,
        stop: i.stop, tp1: i.tp1, tp2: pos(i.tp2) ? i.tp2 : null, stopPct: worst.stopPct, stopCapPct: derived.stopCapPct,
        marginUsd: derived.marginUsd, feesUsd: worst.feesUsd, maxLossUsd: worst.maxLossUsd, liqLeverageCap: worst.liqLeverageCap,
        dailyLossUsd: loss.ok ? loss.lossUsd : null, openPositions: positions.ok ? positions.positions.length : null,
        custodyAssetsUsd: custody && isNum(custody.currentAssets) ? r2(custody.currentAssets) : null,
        custodyHeadroomUsd: headroom !== null ? r2(headroom) : null,
        planId: typeof i.planId === 'string' ? i.planId : null, candidateId: typeof i.candidateId === 'string' ? i.candidateId : null,
        recClass: typeof i.recClass === 'string' ? i.recClass : null,
        source: typeof i.source === 'string' ? i.source : 'telegram'
      };
      out.order = order;
      out.reasons = [...new Set(reasons)];
      out.ok = out.reasons.every((r) => r.startsWith('warn:'));
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
      // Public store: a close / update ticket carries the position id hash, not the id.
      const stored = typeof order.positionId === 'string' && order.positionId
        ? (({ positionId, ...rest }) => ({ ...rest, positionIdHash: idHash(positionId) }))(order)
        : order;
      const t = await storeTicket(store, stored, { nowMs: now(), userId: ctx.userId ?? null, randomBytes });
      if (!t.ok) return { ok: false, reasons: ['tickets_unavailable'] };
      await audit('ticket', { nonceTail: t.nonce.slice(-4), action: order.action, symbol: order.symbol || null, direction: order.direction || null, expiresAt: t.expiresAt }, order.mode || null);
      return { ok: true, nonce: t.nonce, expiresAt: t.expiresAt, summaryText: orderSummary(order, t.nonce) };
    } catch (err) {
      return { ok: false, reasons: [`ticket_error:${errName(err)}`] };
    }
  }

  // ------------------------------------------------------------------ open

  async function executeOpen(order, ctx, nonce = null) {
    const intent = {
      symbol: order.symbol, direction: order.direction, sizeUsd: order.sizeUsd, leverage: order.leverage, entry: order.entry,
      stop: order.stop, tp1: order.tp1, tp2: order.tp2, planId: order.planId, candidateId: order.candidateId,
      recClass: order.recClass, source: order.source
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
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, entry: o.expectedFill, stop: o.stop, tp1: o.tp1, sizeUsd: o.sizeUsd, leverage: o.leverage, engineRef, execRef: { ticketNonce: nonce, fillSource: o.fillSource }, text: `DRY order ${o.symbol} ${o.direction} $${o.sizeUsd} ${o.leverage}x · SL ${o.stop} · TP1 ${o.tp1} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, order: o, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    // Two-phase live open (T-3 F, docs/PLAN_LIVE_PERPS_TEST.md "Keeper fill is
    // asynchronous"): submit the increase WITHOUT stops -> land -> waitForFill -> attach
    // SL/TP -> verify -> journal only once verified. actionId is ticket-nonce derived, so
    // a fresh ticket is always a fresh id; a prior terminal result for the same id is
    // replayed verbatim (exactly-once).
    const actionId = `open_${nonce || newId('a')}`;
    const prior = await priorActionResult(actionId);
    if (prior) return prior;
    try {
      const j = await jupiter();
      const signer = await getSigner(j);
      const addr = await walletAddress();

      await audit('phase', { action: 'open', phase: 'submitted', actionId, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage }, 'live');
      const openBuilt = await j.buildOpenPosition({
        market: o.market, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage,
        stopLoss: null, takeProfit: null, owner: addr, referencePrice: o.expectedFill,
      });
      const openSim = await openBuilt.simulate();
      if (openSim.err) throw new Error(`open simulation failed: ${JSON.stringify(openSim.err)}`);
      const sendResult = await openBuilt.send(signer);
      if (sendResult.simulated) {
        await audit('phase', { action: 'open', phase: 'simulate_only', actionId }, 'live');
        return await recordActionResult(actionId, { ok: true, mode: 'live', simulated: true, order: o, reasons: [] });
      }
      if (!sendResult.signature) throw new Error('open transaction did not land');
      await audit('phase', { action: 'open', phase: 'landed', actionId, positionIdHash: idHash(openBuilt.meta.positionId), txSignatureHash: idHash(sendResult.signature) }, 'live');

      const fillResult = await j.waitForFill(openBuilt.meta.positionRequestId, openBuilt.meta.positionId);
      if (!fillResult.filled) {
        let cancelled = null;
        if (fillResult.reason === 'timeout' && typeof j.buildCancelIncreaseRequest === 'function') {
          try {
            const cancelBuilt = await j.buildCancelIncreaseRequest({ positionId: openBuilt.meta.positionId, positionRequestId: openBuilt.meta.positionRequestId, market: o.market, direction: o.direction, owner: addr });
            const cancelSim = await cancelBuilt.simulate();
            cancelled = !cancelSim.err && Boolean(await cancelBuilt.send(signer).then((r) => r && (r.signature || r.simulated)).catch(() => false));
          } catch { cancelled = false; }
        }
        await audit('phase', { action: 'open', phase: 'fill_failed', actionId, positionIdHash: idHash(openBuilt.meta.positionId), reason: fillResult.reason, cancelled }, 'live');
        return await recordActionResult(actionId, { ok: false, mode: 'live', reasons: ['fill_failed', fillResult.reason], error: 'fill_failed', cancelled });
      }
      const fillPrice = fillResult.position.entryPrice;
      await audit('phase', { action: 'open', phase: 'filled', actionId, positionIdHash: idHash(openBuilt.meta.positionId), fillPrice }, 'live');

      let stopsBuilt;
      try {
        stopsBuilt = await j.buildUpdateStops({ positionId: openBuilt.meta.positionId, market: o.market, direction: o.direction, stop: o.stop, tp: o.tp1, positionSizeUsd: fillResult.position.sizeUsd, owner: addr });
        const stopsSim = await stopsBuilt.simulate();
        if (stopsSim.err) throw new Error(`stops simulation failed: ${JSON.stringify(stopsSim.err)}`);
        const stopsSend = await stopsBuilt.send(signer);
        if (!stopsSend.simulated && !stopsSend.signature) throw new Error('stops transaction did not land');
        await audit('phase', { action: 'open', phase: 'stops_attached', actionId, positionIdHash: idHash(openBuilt.meta.positionId), triggers: stopsBuilt.meta.triggers }, 'live');
      } catch (stopsErr) {
        await audit('error', { stage: 'stops_attach', actionId, positionIdHash: idHash(openBuilt.meta.positionId), error: errMsg(stopsErr) }, 'live');
        return await recordActionResult(actionId, await emergencyClose(j, signer, addr, openBuilt.meta, o, actionId));
      }

      const verified = await verifyOpen(j, openBuilt.meta.positionId, stopsBuilt.meta.triggers);
      if (!verified.ok) {
        await audit('error', { stage: 'verify', actionId, positionIdHash: idHash(openBuilt.meta.positionId), reason: verified.reason }, 'live');
        return await recordActionResult(actionId, await emergencyClose(j, signer, addr, openBuilt.meta, o, actionId));
      }
      await audit('phase', { action: 'open', phase: 'verified', actionId, positionIdHash: idHash(openBuilt.meta.positionId) }, 'live');

      const position = { positionId: openBuilt.meta.positionId, symbol: o.symbol, direction: o.direction, sizeUsd: fillResult.position.sizeUsd, leverage: o.leverage, stop: o.stop, tp1: o.tp1, entryPrice: fillPrice };
      const positionIdHash = idHash(position.positionId);
      const jr = await journal({
        kind: 'open', symbol: o.symbol, direction: o.direction, entry: fillPrice, stop: o.stop, tp1: o.tp1, sizeUsd: position.sizeUsd, leverage: o.leverage, engineRef,
        execRef: { positionIdHash, ticketNonce: nonce, fillSource: 'venue', actionId },
        text: `LIVE order ${o.symbol} ${o.direction} $${position.sizeUsd} ${o.leverage}x · fill ${fillPrice} (venue) · tx ${sendResult.signature.slice(0, 12)}`
      });
      await audit('fill', { action: 'open', txSignatureHash: idHash(sendResult.signature), positionIdHash, fillPrice, fillSource: 'venue', symbol: o.symbol, direction: o.direction, sizeUsd: position.sizeUsd, leverage: o.leverage, stop: o.stop, tp1: o.tp1, journalId: jr.ok ? jr.id : null }, 'live');
      return await recordActionResult(actionId, { ok: true, mode: 'live', txSignature: sendResult.signature, position, fillPrice, order: o, journal: jr.ok ? jr.id : null, reasons: [] });
    } catch (err) {
      await audit('error', { stage: 'open', actionId, symbol: o.symbol, direction: o.direction, error: errMsg(err) }, 'live');
      return await recordActionResult(actionId, { ok: false, mode: 'live', error: errMsg(err), reasons: ['open_failed'] });
    }
  }

  // ------------------------------------------------------------------ close / update

  async function findPosition(positionId) {
    const p = await readPositions();
    if (!p.ok) return { reason: 'positions_unavailable' };
    const hit = p.positions.find((x) => x.positionId === positionId);
    return hit ? { position: hit } : { reason: 'position_not_found' };
  }

  /** A ticket order carries positionIdHash only: resolve the id from the chain read. */
  async function resolvePositionId(order) {
    if (typeof order.positionId === 'string' && order.positionId) return order.positionId;
    if (typeof order.positionIdHash !== 'string') return null;
    const p = await readPositions();
    const hit = p.ok ? p.positions.find((x) => x && idHash(x.positionId) === order.positionIdHash) : null;
    return hit ? hit.positionId : null;
  }

  /** Journal id of the execution `open` for positionIdHash (last OPEN_LOOKUP_DAYS days), or null. */
  async function openJournalId(positionIdHash) {
    if (!positionIdHash) return null;
    try {
      for (let d = 0; d < OPEN_LOOKUP_DAYS; d++) {
        const day = new Date(now() - d * 86_400_000).toISOString().slice(0, 10);
        const b = await readBlob(store.get, journalDayPath(day));
        const hit = parseJsonlObjects(b && b.text).reverse().find((r) => r.kind === 'open' && r.source === 'execution' && r.execRef && r.execRef.positionIdHash === positionIdHash);
        if (hit) return hit.id;
      }
    } catch { /* link is best effort */ }
    return null;
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

  async function executeClose(order, ctx, actionIdSeed = null) {
    const positionId = await resolvePositionId(order);
    const prep = positionId ? await prepareClose(positionId, order.sizeUsd, ctx) : { ok: false, reasons: ['position_not_found'] };
    if (!prep.ok) {
      await audit('close', { ok: false, positionIdHash: order.positionIdHash || idHash(order.positionId), reasons: prep.reasons });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: prep.reasons, error: 'close_refused' };
    }
    const o = prep.order;
    const f = await findPosition(o.positionId);
    const p = f.position || {};
    const fraction = o.sizeUsd ? o.sizeUsd / o.positionSizeUsd : 1;
    const estPnl = isNum(p.unrealizedPnlUsd) ? r2(p.unrealizedPnlUsd * fraction) : null;
    const label = o.sizeUsd ? `$${o.sizeUsd}` : 'all';
    const positionIdHash = idHash(o.positionId);
    const execRef = { positionIdHash, openJournalId: await openJournalId(positionIdHash) };
    if (o.mode === 'dry') {
      const dryRunId = newId('dry');
      await audit('close', { ok: true, dryRunId, positionIdHash, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, estPnlUsd: estPnl }, 'dry');
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, execRef, text: `DRY close ${o.symbol} ${o.direction} ${label} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    const actionId = `close_${actionIdSeed || newId('a')}`;
    const prior = await priorActionResult(actionId);
    if (prior) return prior;
    try {
      const j = await jupiter();
      const r = await j.closePerpPosition(o.positionId, o.sizeUsd);
      const txSignature = r && typeof r.signature === 'string' ? r.signature : null;
      if (!txSignature || /placeholder/i.test(txSignature)) throw new Error('close not executed on chain');
      const verified = await verifyClose(o);
      if (!verified.ok) throw new Error(`close landed but did not verify on chain (${verified.reason})`);
      const jr = await journal({ kind: 'close', symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd || o.positionSizeUsd, exitPrice: pos(p.markPrice) ? p.markPrice : null, resultUsd: estPnl, execRef: { ...execRef, actionId }, text: `LIVE close ${o.symbol} ${o.direction} ${label} · tx ${txSignature.slice(0, 12)}${estPnl !== null ? ` · est PnL $${estPnl}` : ''}` });
      await audit('close', { ok: true, txSignatureHash: idHash(txSignature), positionIdHash, symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, realizedPnlUsd: estPnl, journalId: jr.ok ? jr.id : null }, 'live');
      return await recordActionResult(actionId, { ok: true, mode: 'live', txSignature, journal: jr.ok ? jr.id : null, reasons: [] });
    } catch (err) {
      await audit('error', { stage: 'close', actionId, positionIdHash, error: errMsg(err) }, 'live');
      return await recordActionResult(actionId, { ok: false, mode: 'live', error: errMsg(err), reasons: ['close_failed'] });
    }
  }

  async function executeUpdate(order, ctx, actionIdSeed = null) {
    const positionId = await resolvePositionId(order);
    const prep = positionId ? await prepareUpdate(positionId, order.stop, order.tp, ctx) : { ok: false, reasons: ['position_not_found'] };
    if (!prep.ok) {
      await audit('adjust', { ok: false, positionIdHash: order.positionIdHash || idHash(order.positionId), reasons: prep.reasons });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: prep.reasons, error: 'update_refused' };
    }
    const o = prep.order;
    const positionIdHash = idHash(o.positionId);
    const execRef = { positionIdHash, openJournalId: await openJournalId(positionIdHash) };
    if (o.mode === 'dry') {
      const dryRunId = newId('dry');
      await audit('adjust', { ok: true, dryRunId, positionIdHash, symbol: o.symbol, direction: o.direction, stop: o.stop, tp: o.tp }, 'dry');
      const jr = await journal({ kind: 'note', symbol: o.symbol, direction: o.direction, stop: o.stop, tp1: o.tp, execRef, text: `DRY set SL/TP ${o.symbol} ${o.direction} · SL ${o.stop ?? '-'} · TP ${o.tp ?? '-'} · ${dryRunId}` });
      return { ok: true, mode: 'dry', dryRunId, journal: jr.ok ? jr.id : null, reasons: [] };
    }
    const actionId = `update_${actionIdSeed || newId('a')}`;
    const prior = await priorActionResult(actionId);
    if (prior) return prior;
    try {
      const j = await jupiter();
      const r = await j.updatePerpPosition(o.positionId, o.stop, o.tp);
      const txSignature = r && typeof r.signature === 'string' ? r.signature : null;
      if (!txSignature || /placeholder/i.test(txSignature)) throw new Error('update not executed on chain');
      const verified = await verifyUpdate(o);
      if (!verified.ok) throw new Error(`update landed but did not verify on chain (${verified.reason})`);
      const jr = await journal({ kind: 'adjust', symbol: o.symbol, direction: o.direction, stop: o.stop, tp1: o.tp, execRef: { ...execRef, actionId }, text: `LIVE set SL/TP ${o.symbol} ${o.direction} · SL ${o.stop ?? '-'} · TP ${o.tp ?? '-'} · tx ${txSignature.slice(0, 12)}` });
      await audit('adjust', { ok: true, txSignatureHash: idHash(txSignature), positionIdHash, stop: o.stop, tp: o.tp, journalId: jr.ok ? jr.id : null }, 'live');
      return await recordActionResult(actionId, { ok: true, mode: 'live', txSignature, journal: jr.ok ? jr.id : null, reasons: [] });
    } catch (err) {
      await audit('error', { stage: 'update', actionId, positionIdHash, error: errMsg(err) }, 'live');
      return await recordActionResult(actionId, { ok: false, mode: 'live', error: errMsg(err), reasons: ['update_failed'] });
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
      if (used.order.action === 'open') return executeOpen(used.order, ctx, String(nonce));
      if (used.order.action === 'close') return executeClose(used.order, ctx, String(nonce));
      if (used.order.action === 'update') return executeUpdate(used.order, ctx, String(nonce));
      return { ok: false, mode: cfg.mode, reasons: ['order_invalid'], error: 'order_invalid' };
    } catch (err) {
      await audit('error', { stage: 'confirm', error: errMsg(err) });
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: [`confirm_error:${errName(err)}`], error: errMsg(err) };
    }
  }

  async function closePosition(positionId, sizeUsd = null, pin, ctx = {}) {
    try {
      const fail = await pinnedGates(pin, ctx);
      if (fail) { await audit('close', { ok: false, positionIdHash: typeof positionId === 'string' ? idHash(positionId) : null, reasons: fail.reasons }, fail.mode); return fail; }
      return executeClose({ action: 'close', positionId, sizeUsd }, ctx);
    } catch (err) {
      return { ok: false, mode: readExecutionConfig(env).mode, reasons: [`close_error:${errName(err)}`], error: errMsg(err) };
    }
  }

  async function updateStops(positionId, stop = null, tp = null, pin, ctx = {}) {
    try {
      const fail = await pinnedGates(pin, ctx);
      if (fail) { await audit('adjust', { ok: false, positionIdHash: typeof positionId === 'string' ? idHash(positionId) : null, reasons: fail.reasons }, fail.mode); return fail; }
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

  /** Cancel: consume the ticket (single use) without acting on it. Owner only, no PIN. */
  async function cancelTicket(nonce, ctx = {}) {
    try {
      const cfg = readExecutionConfig(env);
      if (!isOwner(cfg, ctx.userId)) return { ok: false, reasons: ['not_owner'] };
      const used = await consumeTicket(store, nonce, { nowMs: now(), userId: ctx.userId ?? null });
      await audit('cancel', { ok: used.ok, action: used.ok && used.order ? used.order.action : null, nonceTail: typeof nonce === 'string' && /^[0-9a-f]{8}$/.test(nonce) ? nonce.slice(-4) : null, reasons: used.ok ? [] : [used.reason] }, cfg.mode);
      return used.ok ? { ok: true, reasons: [] } : { ok: false, reasons: [used.reason] };
    } catch (err) {
      return { ok: false, reasons: [`cancel_error:${errName(err)}`] };
    }
  }

  /**
   * /arm <PIN>: owner + PIN; clears the Blob kill flag. Env kill stays. While a wrong-PIN
   * auto-kill is active (Blob or this instance's memory) it refuses WITHOUT evaluating the
   * PIN, so /arm cannot be used to keep guessing; an unreadable kill state refuses too.
   */
  async function arm(pin, ctx = {}) {
    const cfg = readExecutionConfig(env);
    if (!isOwner(cfg, ctx.userId)) return { ok: false, reasons: ['not_owner'] };
    if (!cfg.pinConfigured) return { ok: false, reasons: ['pin_not_configured'] };
    const killRead = await readKillState(store);
    if (!killRead.ok) return { ok: false, reasons: ['kill_state_unavailable'] };
    if (autoKillActive(killRead.state, now()) || memKillActive()) {
      await audit('arm', { ok: false, reasons: ['auto_kill_active'] }, cfg.mode);
      return { ok: false, reasons: ['auto_kill_active'], until: killRead.state.until || (memPin.killUntilMs ? new Date(memPin.killUntilMs).toISOString() : null) };
    }
    const bad = await pinGate(pin);
    if (bad) return { ok: false, reasons: bad };
    const r = await clearKill(store, now());
    await audit('arm', { ok: r.ok, envKill: cfg.killEnv }, cfg.mode);
    return r.ok ? { ok: true, reasons: [], envKillStill: cfg.killEnv } : { ok: false, reasons: ['kill_write_failed'] };
  }

  return { preflight, createTicket, cancelTicket, confirm, closePosition, updateStops, listPositions, status, prepareClose, prepareUpdate, kill, arm };
}

let defaultExecutor = null;
const def = () => defaultExecutor || (defaultExecutor = createExecutor());

export const preflight = (intent, ctx) => def().preflight(intent, ctx);
export const createTicket = (order, ctx) => def().createTicket(order, ctx);
export const cancelTicket = (nonce, ctx) => def().cancelTicket(nonce, ctx);
export const confirm = (nonce, pin, ctx) => def().confirm(nonce, pin, ctx);
export const closePosition = (positionId, sizeUsd, pin, ctx) => def().closePosition(positionId, sizeUsd, pin, ctx);
export const updateStops = (positionId, stop, tp, pin, ctx) => def().updateStops(positionId, stop, tp, pin, ctx);
export const listPositions = () => def().listPositions();
export const status = () => def().status();
export const prepareClose = (positionId, sizeUsd, ctx) => def().prepareClose(positionId, sizeUsd, ctx);
export const prepareUpdate = (positionId, stop, tp, ctx) => def().prepareUpdate(positionId, stop, tp, ctx);
export const kill = (ctx, reason) => def().kill(ctx, reason);
export const arm = (pin, ctx) => def().arm(pin, ctx);
