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
  legacyRiskProfile: 'userRiskProfile'
};

const SCHEMA_VERSION = 1;

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
  importAll
};
