/**
 * Risk Manager — persistence
 * --------------------------
 * Storage for the risk profile, trading-wallet history and planned trades.
 *
 * ==========================================================================
 * WHY LOCAL-FIRST
 * ==========================================================================
 * This was chosen after reviewing what the deployment actually offers:
 *
 *  - There is NO server-side persistence. server.js is not deployed at all;
 *    vercel.json serves public/ statically and api/*.js as stateless
 *    functions with an ephemeral filesystem. Adding one would mean a new
 *    database dependency.
 *
 *  - Firestore DOES exist (project edittrades-fd451, used by tracker.html for
 *    the `trades` collection) but it runs with NO authentication and rules of
 *    `allow read, write: if true`. The database is world-readable and
 *    world-writable, and the API key ships in page source.
 *
 * Trade signals already live under those rules. A trading-wallet balance is
 * materially more sensitive: it says how much money the operator has. So the
 * default backend here is localStorage — private to the browser, durable
 * enough for a single-operator tool, and adding no new public exposure.
 *
 * Cloud sync is available but OPT-IN (enableCloudSync). Turning it on gives
 * multi-device access at the cost of putting account size in a publicly
 * readable database. That trade is the user's to make, not ours to make
 * silently, so it is off until chosen.
 *
 * LIMITATIONS OF THE DEFAULT (localStorage):
 *  - Per-browser. No sync across devices.
 *  - Cleared by clearing site data; not backed up.
 *  - Roughly 5MB, far beyond what this stores.
 * exportAll() exists so the user can take a backup themselves.
 */

const KEYS = {
  profile: 'riskProfile',
  walletHistory: 'riskWalletHistory',
  trades: 'riskPlannedTrades',
  cloudSync: 'riskCloudSyncEnabled',
  /**
   * Pre-existing key already READ by index.html and tracker.html to set
   * riskScore, but never written by anything. Writing it here makes those two
   * call sites start working with no change to their logic.
   */
  legacyRiskProfile: 'userRiskProfile',

  /* --------------------------------------------------------------------
   * ADAPTIVE RISK MANAGER  (added for the /risk rework)
   *
   * Every key below is LOCAL ONLY and is never mirrored to Firestore, even
   * when cloud sync is enabled. Firestore for this project runs on
   * `allow read, write: if true` — world readable and world writable — and
   * these records say what wallet the operator owns, what it is worth, and
   * what it has done. That is not a trade the user can be asked to make
   * silently, so the mirror is simply not wired up for them.
   * ----------------------------------------------------------------- */
  walletAddress: 'riskWalletAddress',
  equitySnapshots: 'riskEquitySnapshots',
  cashFlows: 'riskCashFlows',
  levelState: 'riskLevelState',
  levelHistory: 'riskLevelHistory',
  strategyVersions: 'riskStrategyVersions',
  recommendations: 'riskRecommendations',
  tradeRecords: 'riskTradeRecords',
  screenshots: 'riskScreenshotMeta',
  uiPrefs: 'riskUiPrefs'
};

const SCHEMA_VERSION = 1;

/**
 * Keys that must never leave the browser. Asserted in mirrorToCloud so a
 * future call site cannot start syncing account size by accident.
 */
const LOCAL_ONLY_COLLECTIONS = new Set([
  'riskWalletAddress',
  'riskEquitySnapshots',
  'riskCashFlows',
  'riskLevelState',
  'riskLevelHistory',
  'riskRecommendations',
  'riskTradeRecords',
  'riskScreenshotMeta',
  'riskUiPrefs'
]);

/* ========================================================================
 * LOW-LEVEL
 * ===================================================================== */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    // Corrupt entries must not take the page down. Fall back and move on.
    console.warn(`[RiskStore] Could not read ${key}:`, error.message);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`[RiskStore] Could not write ${key}:`, error.message);
    return false;
  }
}

/** Monotonic-ish id. Matches the tracker's Date.now() convention. */
function newId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function nowISO() {
  return new Date().toISOString();
}

/* ========================================================================
 * CLOUD SYNC (opt-in)
 * ===================================================================== */

export function isCloudSyncEnabled() {
  return readJSON(KEYS.cloudSync, false) === true;
}

export function setCloudSyncEnabled(enabled) {
  writeJSON(KEYS.cloudSync, enabled === true);
}

/**
 * Firestore handle, only if sync is enabled AND the SDK is actually present.
 * Returns null otherwise so every caller degrades to local silently.
 */
function getCloudDb() {
  if (!isCloudSyncEnabled()) return null;
  try {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    return firebase.firestore();
  } catch (error) {
    console.warn('[RiskStore] Cloud sync unavailable:', error.message);
    return null;
  }
}

/**
 * Mirror a write to Firestore. Never throws and never blocks the local write:
 * local is the source of truth, cloud is a convenience copy.
 */
async function mirrorToCloud(collection, docId, data) {
  if (LOCAL_ONLY_COLLECTIONS.has(collection)) {
    // Not an error the user needs to see, but it must never silently succeed.
    console.warn(`[RiskStore] ${collection} is local-only and was not mirrored.`);
    return false;
  }
  const db = getCloudDb();
  if (!db) return false;
  try {
    await db.collection(collection).doc(String(docId)).set(data);
    return true;
  } catch (error) {
    console.warn(`[RiskStore] Cloud mirror failed for ${collection}/${docId}:`, error.message);
    return false;
  }
}

async function removeFromCloud(collection, docId) {
  const db = getCloudDb();
  if (!db) return false;
  try {
    await db.collection(collection).doc(String(docId)).delete();
    return true;
  } catch (error) {
    console.warn(`[RiskStore] Cloud delete failed for ${collection}/${docId}:`, error.message);
    return false;
  }
}

/* ========================================================================
 * RISK PROFILE  (wallet balance + policy)
 * ===================================================================== */

/**
 * @returns {{ walletBalance: number|null, policy: Object|null, schemaVersion, updatedAt }}
 */
export function loadRiskProfile() {
  const stored = readJSON(KEYS.profile, null);
  if (!stored || typeof stored !== 'object') {
    return { walletBalance: null, policy: null, schemaVersion: SCHEMA_VERSION, updatedAt: null };
  }
  // Additive/loose schema, same posture as the tracker's loadTrades back-fill.
  return {
    walletBalance: Number.isFinite(stored.walletBalance) ? stored.walletBalance : null,
    policy: stored.policy && typeof stored.policy === 'object' ? stored.policy : null,
    schemaVersion: stored.schemaVersion || SCHEMA_VERSION,
    updatedAt: stored.updatedAt || null
  };
}

/**
 * Persist profile. Appends to wallet history whenever the balance changes, so
 * later analysis can tell what the account was worth when a trade was planned.
 */
export async function saveRiskProfile({ walletBalance, policy }) {
  const previous = loadRiskProfile();

  const profile = {
    walletBalance: Number.isFinite(walletBalance) ? walletBalance : previous.walletBalance,
    policy: policy || previous.policy,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowISO()
  };

  writeJSON(KEYS.profile, profile);

  if (Number.isFinite(profile.walletBalance) && profile.walletBalance !== previous.walletBalance) {
    appendWalletSnapshot(profile.walletBalance, previous.walletBalance === null ? 'initial' : 'updated');
  }

  // Keep the pre-existing userRiskProfile key in step. index.html and
  // tracker.html already read it to set riskScore; this makes those work.
  const coarse = derivePostureLabel(profile.policy);
  if (coarse) writeJSON(KEYS.legacyRiskProfile, coarse);

  await mirrorToCloud('riskProfile', 'default', profile);
  return profile;
}

/**
 * Coarse posture label for the legacy `userRiskProfile` consumers, which test
 * for the exact string 'risk-off'.
 */
function derivePostureLabel(policy) {
  if (!policy || !Number.isFinite(policy.defaultRiskPerTradePct)) return null;
  return policy.defaultRiskPerTradePct <= 0.5 ? 'risk-off' : 'risk-on';
}

/* ========================================================================
 * WALLET HISTORY
 * ===================================================================== */

export function loadWalletHistory() {
  const history = readJSON(KEYS.walletHistory, []);
  return Array.isArray(history) ? history : [];
}

export function appendWalletSnapshot(balance, note = '') {
  if (!Number.isFinite(balance)) return null;

  const history = loadWalletHistory();
  const entry = { id: newId(), balance, note, timestamp: nowISO() };
  history.push(entry);

  writeJSON(KEYS.walletHistory, history);
  mirrorToCloud('riskWalletHistory', entry.id, entry);
  return entry;
}

/* ========================================================================
 * PLANNED TRADES
 * ===================================================================== */

export function loadTrades() {
  const trades = readJSON(KEYS.trades, []);
  if (!Array.isArray(trades)) return [];
  // Back-fill loosely rather than rejecting older records.
  return trades.map((trade) => ({
    status: 'PLANNED',
    leverage: 1,
    macroContext: null,
    setupContext: null,
    exitPrice: null,
    actualPnl: null,
    ...trade
  }));
}

function persistTrades(trades) {
  writeJSON(KEYS.trades, trades);
}

/**
 * Save a planned trade. Captures the wallet balance at planning time so
 * historical analysis is not distorted by later account changes.
 */
export async function saveTrade(trade) {
  const trades = loadTrades();
  const profile = loadRiskProfile();

  const record = {
    id: trade.id || newId(),
    schemaVersion: SCHEMA_VERSION,

    asset: trade.asset ?? null,
    direction: trade.direction ?? null,
    entry: trade.entry ?? null,
    stop: trade.stop ?? null,
    target: trade.target ?? null,
    leverage: trade.leverage ?? 1,

    notional: trade.notional ?? null,
    units: trade.units ?? null,
    margin: trade.margin ?? null,
    plannedRisk: trade.plannedRisk ?? null,
    plannedRiskPct: trade.plannedRiskPct ?? null,
    stopDistancePct: trade.stopDistancePct ?? null,
    riskReward: trade.riskReward ?? null,

    // Frozen at planning time.
    walletAtEntry: trade.walletAtEntry ?? profile.walletBalance ?? null,
    policyAtEntry: trade.policyAtEntry ?? profile.policy ?? null,
    riskStatusAtEntry: trade.riskStatusAtEntry ?? null,

    // Context captured for the future research hook. Recorded, never used to
    // adjust sizing — that would need backtesting first.
    macroContext: trade.macroContext ?? null,
    setupContext: trade.setupContext ?? null,

    status: trade.status || 'PLANNED',
    exitPrice: trade.exitPrice ?? null,
    actualPnl: trade.actualPnl ?? null,
    notes: trade.notes ?? '',

    createdAt: trade.createdAt || nowISO(),
    updatedAt: nowISO()
  };

  const index = trades.findIndex((t) => t.id === record.id);
  if (index >= 0) trades[index] = record;
  else trades.push(record);

  persistTrades(trades);
  await mirrorToCloud('riskPlannedTrades', record.id, record);
  return record;
}

export async function updateTradeStatus(id, status, extra = {}) {
  const valid = ['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED'];
  if (!valid.includes(status)) {
    throw new Error(`Invalid trade status: ${status}`);
  }

  const trades = loadTrades();
  const trade = trades.find((t) => t.id === id);
  if (!trade) return null;

  trade.status = status;
  trade.updatedAt = nowISO();
  if (Number.isFinite(extra.exitPrice)) trade.exitPrice = extra.exitPrice;
  if (Number.isFinite(extra.actualPnl)) trade.actualPnl = extra.actualPnl;
  if (typeof extra.notes === 'string') trade.notes = extra.notes;

  persistTrades(trades);
  await mirrorToCloud('riskPlannedTrades', trade.id, trade);
  return trade;
}

export async function deleteTrade(id) {
  const trades = loadTrades();
  const remaining = trades.filter((t) => t.id !== id);
  persistTrades(remaining);
  await removeFromCloud('riskPlannedTrades', id);
  return remaining.length !== trades.length;
}

/** Only PLANNED and OPEN trades consume risk and margin. */
export function loadLivePositions() {
  return loadTrades().filter((t) => t.status === 'PLANNED' || t.status === 'OPEN');
}

/* ========================================================================
 * HANDOFF  (index.html "CHECK RISK" -> /risk.html)
 * ===================================================================== */

const HANDOFF_KEY = 'pendingRiskSetup';

/**
 * Follows the existing index -> tracker handoff convention: write the payload
 * to localStorage, navigate with a flag, and have the consumer delete the key
 * and clean the URL. A distinct key avoids colliding with the tracker's
 * `pendingTradeToTrack` consumer.
 */
export function stageSetupForRiskCheck(setup) {
  return writeJSON(HANDOFF_KEY, { ...setup, stagedAt: nowISO() });
}

export function consumePendingSetup() {
  const setup = readJSON(HANDOFF_KEY, null);
  if (setup) {
    try {
      localStorage.removeItem(HANDOFF_KEY);
    } catch (error) {
      console.warn('[RiskStore] Could not clear staged setup:', error.message);
    }
  }
  return setup;
}

/* ========================================================================
 * BACKUP
 * ===================================================================== */

/** Everything the Risk Manager holds, for a manual backup. */
export function exportAll() {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowISO(),
    profile: loadRiskProfile(),
    walletHistory: loadWalletHistory(),
    trades: loadTrades()
  };
}

export function importAll(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid backup payload');
  if (payload.profile) writeJSON(KEYS.profile, payload.profile);
  if (Array.isArray(payload.walletHistory)) writeJSON(KEYS.walletHistory, payload.walletHistory);
  if (Array.isArray(payload.trades)) writeJSON(KEYS.trades, payload.trades);
  return true;
}

/* ========================================================================
 * ADAPTIVE RISK MANAGER — WALLET ADDRESS
 *
 * ONE read-only observed Solana address. No key, no seed phrase, no signing
 * capability is ever accepted or stored: the address alone is what every
 * wallet endpoint in this project takes.
 * ===================================================================== */

export function loadWalletAddress() {
  const stored = readJSON(KEYS.walletAddress, null);
  if (!stored) return null;
  if (typeof stored === 'string') return { address: stored, addedAt: null, label: null };
  if (typeof stored.address !== 'string' || !stored.address) return null;
  return { address: stored.address, addedAt: stored.addedAt || null, label: stored.label || null };
}

export function saveWalletAddress(address, label = null) {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (!trimmed) return null;
  const record = { address: trimmed, label, addedAt: nowISO(), readOnly: true };
  writeJSON(KEYS.walletAddress, record);
  return record;
}

export function clearWalletAddress() {
  try {
    localStorage.removeItem(KEYS.walletAddress);
    return true;
  } catch (error) {
    console.warn('[RiskStore] Could not clear wallet address:', error.message);
    return false;
  }
}

/* ========================================================================
 * EQUITY SNAPSHOTS
 *
 * The input to buildEquityCurve(). One row per observed wallet value. A
 * snapshot is only ever appended from a SUCCESSFUL read — an outage writes
 * nothing, so the curve never contains an invented point.
 * ===================================================================== */

const MAX_SNAPSHOTS = 2000;
/** Two snapshots closer together than this collapse into one. */
const SNAPSHOT_MIN_GAP_MS = 5 * 60 * 1000;

export function loadEquitySnapshots() {
  const list = readJSON(KEYS.equitySnapshots, []);
  return Array.isArray(list) ? list.filter((s) => s && Number.isFinite(s.walletValue)) : [];
}

/**
 * Append an observed wallet value.
 *
 * @param {number} walletValue  USD value actually read from the chain.
 * @param {{source?: string, complete?: boolean, at?: string}} meta
 * @returns {object|null} the stored snapshot, or null when nothing was stored.
 */
export function appendEquitySnapshot(walletValue, meta = {}) {
  if (!Number.isFinite(walletValue) || walletValue <= 0) return null;

  const list = loadEquitySnapshots();
  const at = meta.at || nowISO();
  const last = list[list.length - 1];

  if (last) {
    const gap = Date.parse(at) - Date.parse(last.at);
    // Same value, or a second read moments later: replace rather than append,
    // so a page refresh loop cannot inflate the curve with duplicate points.
    if (Number.isFinite(gap) && gap < SNAPSHOT_MIN_GAP_MS) {
      list[list.length - 1] = { ...last, walletValue, at, source: meta.source || last.source };
      writeJSON(KEYS.equitySnapshots, list);
      return list[list.length - 1];
    }
  }

  const entry = {
    id: newId(),
    at,
    walletValue,
    source: meta.source || 'WALLET_READ',
    complete: meta.complete !== false
  };

  list.push(entry);
  writeJSON(KEYS.equitySnapshots, list.slice(-MAX_SNAPSHOTS));
  return entry;
}

/** Most recent snapshot, or null. Used for the cached first paint. */
export function latestEquitySnapshot() {
  const list = loadEquitySnapshots();
  return list.length ? list[list.length - 1] : null;
}

/* ========================================================================
 * CASH FLOWS  (classified deposits / withdrawals)
 *
 * The reconstruction endpoint returns CANDIDATES with `classified: false`.
 * Only a flow a human has confirmed is applied to the performance curve —
 * `pendingCashFlows()` is what the UI queues up for review, and
 * `classifiedCashFlows()` is what is safe to hand to the engine.
 * ===================================================================== */

export function loadCashFlows() {
  const list = readJSON(KEYS.cashFlows, []);
  return Array.isArray(list) ? list : [];
}

/** Flows a human has confirmed. The ONLY ones the engine ever sees. */
export function classifiedCashFlows() {
  return loadCashFlows().filter(
    (flow) => flow && flow.classified === true && (flow.type === 'DEPOSIT' || flow.type === 'WITHDRAWAL')
  );
}

/** Candidates still awaiting a human decision. */
export function pendingCashFlows() {
  return loadCashFlows().filter((flow) => flow && flow.classified !== true && flow.dismissed !== true);
}

/**
 * Insert or refresh candidates discovered on-chain. An existing row keeps its
 * human classification — a refresh must never un-confirm a decision already
 * made, and must never auto-classify.
 */
export function ingestCashFlowCandidates(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return loadCashFlows();

  const list = loadCashFlows();
  const byId = new Map(list.map((flow) => [flow.id, flow]));

  for (const candidate of candidates) {
    if (!candidate || !candidate.id) continue;
    const existing = byId.get(candidate.id);
    if (existing) {
      byId.set(candidate.id, { ...candidate, ...existing, note: candidate.note || existing.note });
    } else {
      byId.set(candidate.id, {
        ...candidate,
        // Amount stays null until a human supplies it: the reconstruction
        // reports token movements, not a USD figure, and guessing one would
        // corrupt the performance curve.
        amount: Number.isFinite(candidate.amount) ? candidate.amount : null,
        classified: false,
        dismissed: false,
        addedAt: nowISO()
      });
    }
  }

  const merged = [...byId.values()];
  writeJSON(KEYS.cashFlows, merged);
  return merged;
}

/**
 * Record a human decision about one flow.
 *
 * @param {string} id
 * @param {'DEPOSIT'|'WITHDRAWAL'|'NOT_A_TRANSFER'} decision
 * @param {number|null} amount USD amount. Required to confirm a transfer.
 */
export function classifyCashFlow(id, decision, amount = null) {
  const list = loadCashFlows();
  const flow = list.find((f) => f.id === id);
  if (!flow) return null;

  if (decision === 'NOT_A_TRANSFER') {
    flow.classified = false;
    flow.dismissed = true;
  } else if (decision === 'DEPOSIT' || decision === 'WITHDRAWAL') {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('A confirmed cash flow needs a USD amount.');
    }
    flow.type = decision;
    flow.amount = Math.abs(amount);
    flow.classified = true;
    flow.dismissed = false;
  } else {
    throw new Error(`Unknown cash-flow decision: ${decision}`);
  }

  flow.classifiedAt = nowISO();
  writeJSON(KEYS.cashFlows, list);
  return flow;
}

/** A flow the user entered by hand, with no on-chain candidate behind it. */
export function addManualCashFlow({ type, amount, at }) {
  if (type !== 'DEPOSIT' && type !== 'WITHDRAWAL') throw new Error('Cash flow type must be DEPOSIT or WITHDRAWAL.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Cash flow amount must be a positive number.');

  const list = loadCashFlows();
  const flow = {
    id: newId(),
    type,
    amount: Math.abs(amount),
    at: at || nowISO(),
    classified: true,
    dismissed: false,
    source: 'MANUAL',
    classifiedAt: nowISO()
  };
  list.push(flow);
  writeJSON(KEYS.cashFlows, list);
  return flow;
}

export function deleteCashFlow(id) {
  const list = loadCashFlows();
  const remaining = list.filter((f) => f.id !== id);
  writeJSON(KEYS.cashFlows, remaining);
  return remaining.length !== list.length;
}

/* ========================================================================
 * LEVEL STATE AND HISTORY
 *
 * calculateRiskLevel() is pure and takes the PREVIOUS state as an input, so
 * the level ladder only behaves correctly if that state is carried forward
 * between page loads. This is where it is carried.
 * ===================================================================== */

export function loadLevelState() {
  const stored = readJSON(KEYS.levelState, null);
  if (!stored || typeof stored !== 'object') return null;
  return {
    level: Number.isFinite(stored.level) ? stored.level : 0,
    since: stored.since ?? null,
    tradesAtLevelChange: Number.isFinite(stored.tradesAtLevelChange) ? stored.tradesAtLevelChange : 0,
    indexAtLevelChange: Number.isFinite(stored.indexAtLevelChange) ? stored.indexAtLevelChange : null,
    peakLevel: Number.isFinite(stored.peakLevel) ? stored.peakLevel : null
  };
}

/**
 * Persist the carry-forward state produced by calculateRiskLevel().
 *
 * `loadLevelState()` returns ONLY the five fields the engine reads back, so
 * the engine can never be fed anything it did not itself produce. The extra
 * `display` block is a read-only cache for surfaces that must not re-derive a
 * level from partial data — the home-page widget has no trade history loaded,
 * and recomputing there would report a level that is simply wrong. It is
 * never an engine input.
 */
export function saveLevelState(levelState, display = null) {
  if (!levelState || typeof levelState !== 'object') return null;
  const record = {
    level: Number.isFinite(levelState.level) ? levelState.level : 0,
    since: levelState.since ?? null,
    tradesAtLevelChange: Number.isFinite(levelState.tradesAtLevelChange) ? levelState.tradesAtLevelChange : 0,
    indexAtLevelChange: Number.isFinite(levelState.indexAtLevelChange) ? levelState.indexAtLevelChange : null,
    peakLevel: Number.isFinite(levelState.peakLevel) ? levelState.peakLevel : null,
    updatedAt: nowISO(),
    display: display && typeof display === 'object' ? { ...display, at: nowISO() } : null
  };
  writeJSON(KEYS.levelState, record);
  return record;
}

/**
 * The last evaluation's display cache, or null.
 * Read-only. Never pass this to the engine.
 */
export function loadLevelDisplay() {
  const stored = readJSON(KEYS.levelState, null);
  if (!stored || typeof stored !== 'object' || !stored.display) return null;
  return { level: stored.level, peakLevel: stored.peakLevel, ...stored.display };
}

export function loadLevelHistory() {
  const list = readJSON(KEYS.levelHistory, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Record one level transition, with everything needed to explain it later
 * when the user taps its marker on the equity chart. Idempotent per
 * (code, from, to, totalClosedTrades) so a re-render cannot duplicate it.
 */
export function appendLevelTransition(transition, context = {}) {
  if (!transition || typeof transition !== 'object') return null;

  const list = loadLevelHistory();
  const fingerprint = `${transition.code}|${transition.from}|${transition.to}|${context.totalClosedTrades ?? '?'}`;
  if (list.some((entry) => entry.fingerprint === fingerprint)) return null;

  const entry = {
    id: newId(),
    fingerprint,
    at: context.at || nowISO(),
    code: transition.code,
    type: transition.type,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    // Snapshot of the evidence, frozen. Recomputing it later against a
    // different history would tell a different story than the one that
    // actually moved the level.
    totalClosedTrades: context.totalClosedTrades ?? null,
    tradesSinceLevelChange: context.tradesSinceLevelChange ?? null,
    drawdownPct: context.drawdownPct ?? null,
    maxDrawdownPct: context.maxDrawdownPct ?? null,
    winRate: context.winRate ?? null,
    avgR: context.avgR ?? null,
    consistency: context.consistency ?? null,
    streak: context.streak ?? null,
    equityIndex: context.equityIndex ?? null,
    thresholds: context.thresholds ?? null,
    tradeIds: Array.isArray(context.tradeIds) ? context.tradeIds : []
  };

  list.push(entry);
  writeJSON(KEYS.levelHistory, list);
  return entry;
}

/* ========================================================================
 * STRATEGY CONFIG VERSIONS
 *
 * analyzeStrategyPerformance() returns PROPOSALS and mutates nothing. This
 * records the human decision on each one, and the version it produced. A KEPT
 * decision is stored too: knowing a proposal was seen and declined is what
 * stops it being re-presented forever.
 * ===================================================================== */

export function loadStrategyVersions() {
  const list = readJSON(KEYS.strategyVersions, []);
  return Array.isArray(list) ? list : [];
}

/** The version currently in force, or null when the engine default stands. */
export function currentStrategyVersion() {
  const list = loadStrategyVersions().filter((v) => v.decision === 'APPROVED');
  return list.length ? list[list.length - 1] : null;
}

/** Proposal ids the user has already ruled on, so they are not re-asked. */
export function decidedProposalIds() {
  return new Set(loadStrategyVersions().map((v) => v.proposalId).filter(Boolean));
}

/**
 * @param {'APPROVED'|'KEPT'} decision
 * @param {object} proposal  the record returned by analyzeStrategyPerformance
 * @param {string} engineVersion  STRATEGY_VERSION at the time of the decision
 */
export function recordStrategyDecision(decision, proposal, engineVersion) {
  if (decision !== 'APPROVED' && decision !== 'KEPT') {
    throw new Error(`Strategy decision must be APPROVED or KEPT, got ${decision}`);
  }

  const list = loadStrategyVersions();
  const approvedCount = list.filter((v) => v.decision === 'APPROVED').length;

  const entry = {
    id: newId(),
    at: nowISO(),
    decision,
    proposalId: proposal?.id ?? null,
    scope: proposal?.scope ?? null,
    current: proposal?.current ?? null,
    proposed: proposal?.proposed ?? null,
    reason: proposal?.reason ?? null,
    sampleSize: proposal?.sampleSize ?? null,
    proposalConfidence: proposal?.confidence ?? null,
    engineVersion: engineVersion ?? null,
    // Local revision counter. It versions the USER'S configuration, and is
    // deliberately separate from the engine's own STRATEGY_VERSION.
    configVersion: decision === 'APPROVED' ? `${engineVersion || '1.0.0'}+${approvedCount + 1}` : null
  };

  list.push(entry);
  writeJSON(KEYS.strategyVersions, list);
  return entry;
}

/* ========================================================================
 * PLANNED RECOMMENDATIONS  (recommended vs actual)
 * ===================================================================== */

export function loadRecommendations() {
  const list = readJSON(KEYS.recommendations, []);
  return Array.isArray(list) ? list : [];
}

/**
 * "I TOOK THIS TRADE": freeze what the engine recommended, then start
 * watching for a matching on-chain execution. Nothing about the actual fill
 * is invented — `actual` stays null until an execution is linked.
 */
export function saveRecommendation(recommendation) {
  const list = loadRecommendations();

  const record = {
    id: recommendation.id || newId(),
    at: recommendation.at || nowISO(),
    asset: recommendation.asset ?? null,
    direction: recommendation.direction ?? null,
    strategy: recommendation.strategy ?? null,
    confidence: recommendation.confidence ?? null,
    level: recommendation.level ?? null,
    decision: recommendation.decision ?? null,
    simulated: recommendation.simulated === true,

    recommended: recommendation.recommended ?? null,
    actual: recommendation.actual ?? null,

    linkedTradeId: recommendation.linkedTradeId ?? null,
    matchState: recommendation.matchState || 'WATCHING',

    strategyVersion: recommendation.strategyVersion ?? null,
    inputsHash: recommendation.inputsHash ?? null,
    updatedAt: nowISO()
  };

  const index = list.findIndex((r) => r.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);

  writeJSON(KEYS.recommendations, list);
  return record;
}

/**
 * Attach an observed execution to a planned recommendation.
 * `matchState` becomes MATCHED only when a real trade id is supplied.
 */
export function linkRecommendationToTrade(recommendationId, tradeId, actual = null) {
  const list = loadRecommendations();
  const record = list.find((r) => r.id === recommendationId);
  if (!record) return null;

  record.linkedTradeId = tradeId ?? null;
  record.actual = actual;
  record.matchState = tradeId ? 'MATCHED' : record.matchState;
  record.updatedAt = nowISO();

  writeJSON(KEYS.recommendations, list);
  return record;
}

/** Recommendations still waiting for an execution to appear on-chain. */
export function watchingRecommendations() {
  return loadRecommendations().filter((r) => r.matchState === 'WATCHING' && r.simulated !== true);
}

export function deleteRecommendation(id) {
  const list = loadRecommendations();
  const remaining = list.filter((r) => r.id !== id);
  writeJSON(KEYS.recommendations, remaining);
  return remaining.length !== list.length;
}

/* ========================================================================
 * TRADE RECORDS  (local corrections layered over on-chain reconstruction)
 * ===================================================================== */

/**
 * Fields the chain observed directly. On-chain wins on every one of these
 * when the record is VERIFIED; the disagreement is REPORTED, never dropped.
 */
const ONCHAIN_AUTHORITATIVE_FIELDS = [
  'asset',
  'direction',
  'entry',
  'exit',
  'quantity',
  'notional',
  'realizedPnl',
  'openedAt',
  'closedAt'
];

/** Fields only a human can supply. The chain has no opinion on any of them. */
const USER_OWNED_FIELDS = [
  'strategy',
  'confidence',
  'level',
  'leverage',
  'stop',
  'riskAmount',
  'plannedRisk',
  'rMultiple',
  'notes',
  'drawdownStateAtEntry'
];

export function loadTradeRecords() {
  const list = readJSON(KEYS.tradeRecords, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Store a user's corrections to one trade. Corrections live in `overrides`
 * rather than being written over the trade, so the on-chain reading is always
 * still there to compare against.
 */
export function upsertTradeRecord(record) {
  if (!record || !record.id) throw new Error('A trade record needs an id.');

  const list = loadTradeRecords();
  const index = list.findIndex((r) => r.id === record.id);
  const previous = index >= 0 ? list[index] : null;

  const merged = {
    id: record.id,
    source: record.source || previous?.source || 'MANUAL',
    overrides: { ...(previous?.overrides || {}), ...(record.overrides || {}) },
    screenshotId: record.screenshotId ?? previous?.screenshotId ?? null,
    createdAt: previous?.createdAt || nowISO(),
    updatedAt: nowISO()
  };

  // An override set back to null is a retraction, not a value.
  for (const key of Object.keys(merged.overrides)) {
    if (merged.overrides[key] === null || merged.overrides[key] === undefined || merged.overrides[key] === '') {
      delete merged.overrides[key];
    }
  }

  if (index >= 0) list[index] = merged;
  else list.push(merged);

  writeJSON(KEYS.tradeRecords, list);
  return merged;
}

export function deleteTradeRecord(id) {
  const list = loadTradeRecords();
  const remaining = list.filter((r) => r.id !== id);
  writeJSON(KEYS.tradeRecords, remaining);
  return remaining.length !== list.length;
}

/**
 * Combine on-chain reconstruction with local corrections.
 *
 * THE RULE: on-chain data is authoritative. Where a local correction
 * contradicts a VERIFIED on-chain value, the on-chain value is used and the
 * disagreement is attached to the record as a conflict for the user to
 * resolve. It is never silently resolved in either direction.
 *
 * Where the chain has nothing (a null field, or a NEEDS_REVIEW record such as
 * a Jupiter perp), the local value fills the gap and is marked as such.
 *
 * @returns {Array} merged records, each carrying `conflicts` and `fieldSources`
 */
export function mergeTradeRecords(onchainTrades = []) {
  const locals = loadTradeRecords();
  const byId = new Map(locals.map((record) => [record.id, record]));
  const consumed = new Set();
  const merged = [];

  for (const trade of Array.isArray(onchainTrades) ? onchainTrades : []) {
    if (!trade || !trade.id) continue;
    const local = byId.get(trade.id);
    consumed.add(trade.id);

    const result = { ...trade, source: 'ONCHAIN', conflicts: [], fieldSources: {}, overrides: local?.overrides || {} };
    const overrides = local?.overrides || {};
    const verified = trade.dataConfidence === 'VERIFIED';

    for (const field of ONCHAIN_AUTHORITATIVE_FIELDS) {
      const localValue = overrides[field];
      if (localValue === undefined || localValue === null) {
        result.fieldSources[field] = 'ONCHAIN';
        continue;
      }
      const onchainValue = trade[field];

      if (onchainValue === null || onchainValue === undefined) {
        result[field] = localValue;
        result.fieldSources[field] = 'LOCAL_FILLED_GAP';
        continue;
      }
      if (onchainValue === localValue) {
        result.fieldSources[field] = 'AGREED';
        continue;
      }

      result.conflicts.push({
        field,
        onchain: onchainValue,
        local: localValue,
        resolution: verified ? 'ONCHAIN' : 'LOCAL'
      });

      if (verified) {
        result.fieldSources[field] = 'ONCHAIN_WON';
      } else {
        result[field] = localValue;
        result.fieldSources[field] = 'LOCAL_WON';
      }
    }

    for (const field of USER_OWNED_FIELDS) {
      if (overrides[field] !== undefined && overrides[field] !== null) {
        result[field] = overrides[field];
        result.fieldSources[field] = 'LOCAL';
      }
    }

    // Status: the chain knows a spot episode is closed. It does NOT know for a
    // record it could not decode (meta.statusKnown === false), so there a
    // human's word stands.
    if (overrides.status && (trade.meta?.statusKnown === false || !verified)) {
      result.status = overrides.status;
      result.fieldSources.status = 'LOCAL';
    } else if (overrides.status && overrides.status !== trade.status) {
      result.conflicts.push({ field: 'status', onchain: trade.status, local: overrides.status, resolution: 'ONCHAIN' });
      result.fieldSources.status = 'ONCHAIN_WON';
    }

    result.hasConflicts = result.conflicts.length > 0;
    result.screenshotId = local?.screenshotId ?? null;
    merged.push(result);
  }

  // Purely local trades: nothing on-chain corresponds to them.
  for (const local of locals) {
    if (consumed.has(local.id)) continue;
    merged.push({
      id: local.id,
      source: local.source || 'MANUAL',
      dataConfidence: 'MANUAL',
      conflicts: [],
      hasConflicts: false,
      fieldSources: Object.fromEntries(Object.keys(local.overrides || {}).map((k) => [k, 'LOCAL'])),
      overrides: local.overrides || {},
      screenshotId: local.screenshotId ?? null,
      status: 'PLANNED',
      ...local.overrides
    });
  }

  return merged;
}

/* ========================================================================
 * SCREENSHOT METADATA
 *
 * METADATA ONLY. The image itself is not stored: localStorage is a ~5MB
 * budget shared with everything else here, and one screenshot can eat a
 * quarter of it. What is kept is what the parser read and when — enough to
 * show provenance and to compare against the chain.
 * ===================================================================== */

export function loadScreenshots() {
  const list = readJSON(KEYS.screenshots, []);
  return Array.isArray(list) ? list : [];
}

export function saveScreenshotMeta({ tradeId, parsed, filename, byteSize, error }) {
  const list = loadScreenshots();
  const entry = {
    id: newId(),
    tradeId: tradeId ?? null,
    at: nowISO(),
    filename: filename ?? null,
    byteSize: Number.isFinite(byteSize) ? byteSize : null,
    // Exactly what /api/parse-trade-image returned, unmodified.
    parsed: parsed ?? null,
    error: error ?? null,
    source: 'SCREENSHOT'
  };
  list.push(entry);
  writeJSON(KEYS.screenshots, list.slice(-200));
  return entry;
}

export function screenshotsForTrade(tradeId) {
  return loadScreenshots().filter((s) => s.tradeId === tradeId);
}

/* ========================================================================
 * UI PREFERENCES
 *
 * Last strategy / confidence / asset. Convenience only — nothing here feeds
 * a calculation.
 * ===================================================================== */

export function loadUiPrefs() {
  const stored = readJSON(KEYS.uiPrefs, null);
  return stored && typeof stored === 'object' ? stored : {};
}

export function saveUiPrefs(prefs) {
  const merged = { ...loadUiPrefs(), ...(prefs || {}), updatedAt: nowISO() };
  writeJSON(KEYS.uiPrefs, merged);
  return merged;
}

/* ========================================================================
 * ADAPTIVE BACKUP
 * ===================================================================== */

/** Everything the adaptive Risk Manager holds, for a manual backup. */
export function exportAdaptive() {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowISO(),
    walletAddress: loadWalletAddress(),
    equitySnapshots: loadEquitySnapshots(),
    cashFlows: loadCashFlows(),
    levelState: loadLevelState(),
    levelHistory: loadLevelHistory(),
    strategyVersions: loadStrategyVersions(),
    recommendations: loadRecommendations(),
    tradeRecords: loadTradeRecords(),
    screenshots: loadScreenshots(),
    uiPrefs: loadUiPrefs()
  };
}

export function importAdaptive(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid backup payload');
  const map = {
    walletAddress: KEYS.walletAddress,
    equitySnapshots: KEYS.equitySnapshots,
    cashFlows: KEYS.cashFlows,
    levelState: KEYS.levelState,
    levelHistory: KEYS.levelHistory,
    strategyVersions: KEYS.strategyVersions,
    recommendations: KEYS.recommendations,
    tradeRecords: KEYS.tradeRecords,
    screenshots: KEYS.screenshots,
    uiPrefs: KEYS.uiPrefs
  };
  for (const [field, key] of Object.entries(map)) {
    if (payload[field] !== undefined && payload[field] !== null) writeJSON(key, payload[field]);
  }
  return true;
}

export default {
  KEYS,
  loadRiskProfile,
  saveRiskProfile,
  loadWalletHistory,
  appendWalletSnapshot,
  loadTrades,
  saveTrade,
  updateTradeStatus,
  deleteTrade,
  loadLivePositions,
  stageSetupForRiskCheck,
  consumePendingSetup,
  isCloudSyncEnabled,
  setCloudSyncEnabled,
  exportAll,
  importAll,

  /* Adaptive Risk Manager */
  loadWalletAddress,
  saveWalletAddress,
  clearWalletAddress,
  loadEquitySnapshots,
  appendEquitySnapshot,
  latestEquitySnapshot,
  loadCashFlows,
  classifiedCashFlows,
  pendingCashFlows,
  ingestCashFlowCandidates,
  classifyCashFlow,
  addManualCashFlow,
  deleteCashFlow,
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
  linkRecommendationToTrade,
  watchingRecommendations,
  deleteRecommendation,
  loadTradeRecords,
  upsertTradeRecord,
  deleteTradeRecord,
  mergeTradeRecords,
  loadScreenshots,
  saveScreenshotMeta,
  screenshotsForTrade,
  loadUiPrefs,
  saveUiPrefs,
  exportAdaptive,
  importAdaptive
};
