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
 *    the `trades` collection). Its rules are now committed as firestore.rules
 *    at the repo root: default-deny, per-uid isolation under /users/{uid}/.
 *    Note that committing rules is not deploying them — until
 *    `firebase deploy --only firestore:rules` has run against the project, the
 *    live database keeps whatever the console currently holds, which the repo's
 *    own FIREBASE_SETUP_GUIDE.md prescribes as `allow read, write: if true`.
 *
 * Trade signals already live under those rules. A trading-wallet balance is
 * materially more sensitive: it says how much money the operator has. So the
 * default backend here is localStorage — private to the browser, durable
 * enough for a single-operator tool, and adding no new public exposure.
 *
 * Cloud sync is available but OPT-IN (enableCloudSync). It now writes only
 * under /users/{uid}/, requires an authenticated session, and reports its
 * status rather than failing silently — previously getCloudDb() returned null
 * whenever the Firebase SDK was absent, and risk.html and index.html both load
 * riskStore WITHOUT the SDK, so every caller who enabled sync got a silent
 * no-op: no error, no warning, and the belief that their data was backed up.
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
 * The signed-in uid, or null.
 *
 * Every cloud write is scoped under this. Without it there is no per-user
 * isolation at the data layer and a write would land in a shared namespace,
 * so a missing uid disables sync rather than falling back to a flat path.
 */
function getCloudUid() {
  try {
    if (typeof firebase === 'undefined' || !firebase.auth) return null;
    return firebase.auth().currentUser?.uid || null;
  } catch (error) {
    return null;
  }
}

/**
 * Why cloud sync is not currently writing, or null when it is.
 * Callers should render this: the whole failure mode being fixed here is a
 * user believing their data is backed up when nothing is being written.
 */
export function cloudSyncStatus() {
  if (!isCloudSyncEnabled()) return { active: false, reason: 'Cloud sync is off' };
  if (typeof firebase === 'undefined' || !firebase.firestore) {
    return { active: false, reason: 'Firebase SDK is not loaded on this page' };
  }
  if (!getCloudUid()) {
    return { active: false, reason: 'Not signed in — cloud writes require an authenticated session' };
  }
  return { active: true, reason: null };
}

/**
 * Mirror a write to Firestore. Never throws and never blocks the local write:
 * local is the source of truth, cloud is a convenience copy.
 */
async function mirrorToCloud(collection, docId, data) {
  const db = getCloudDb();
  const uid = getCloudUid();
  if (!db || !uid) return false;
  try {
    // /users/{uid}/{collection}/{docId} — the path firestore.rules authorises.
    await db.collection('users').doc(uid).collection(collection).doc(String(docId)).set(data);
    return true;
  } catch (error) {
    console.warn(`[RiskStore] Cloud mirror failed for ${collection}/${docId}:`, error.message);
    return false;
  }
}

async function removeFromCloud(collection, docId) {
  const db = getCloudDb();
  const uid = getCloudUid();
  if (!db || !uid) return false;
  try {
    await db.collection('users').doc(uid).collection(collection).doc(String(docId)).delete();
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
  return {
    walletBalance: Number.isFinite(stored.walletBalance) && stored.walletBalance > 0
      ? stored.walletBalance
      : null,
    // Sanitised, not trusted. The stored policy holds the risk CEILINGS, and
    // it used to be accepted on nothing more than `typeof === 'object'` and
    // then shallow-spread over the defaults by risk.html. Anything on the
    // origin — a stale write, a bad import, an extension — could set
    // maxRiskPerTradePct to 9999 and every limit would read green forever
    // while sizing arbitrarily. A shallow spread also let a partial nested
    // object REPLACE a default wholesale, which threw inside planTrade.
    policy: sanitizePolicy(stored.policy),
    schemaVersion: stored.schemaVersion || SCHEMA_VERSION,
    updatedAt: stored.updatedAt || null
  };
}

/**
 * Bounds for every user-editable policy field.
 *
 * These are outer sanity rails, not the policy itself — the defaults live in
 * riskManager.js and are far tighter. The job here is only to guarantee that
 * whatever comes back off disk is a number in a range where the arithmetic and
 * the limits still mean something.
 */
const POLICY_BOUNDS = {
  defaultRiskPerTradePct: [0.01, 20],
  maxRiskPerTradePct: [0.01, 20],
  maxTotalOpenRiskPct: [0.01, 50],
  maxCorrelatedRiskPct: [0.01, 50],
  maxNotionalExposurePct: [1, 1000],
  maxMarginUtilizationPct: [1, 100],
  maxLeverage: [1, 125],
  minStopDistancePct: [0, 10]
};

/** Nested policy sub-objects, kept so a partial write cannot delete one. */
const POLICY_NESTED = ['costs', 'liquidation', 'concentration'];

/**
 * Return a policy containing only recognised keys with in-range values.
 * Unknown keys are dropped; out-of-range and non-numeric values are omitted so
 * the engine default applies instead.
 */
export function sanitizePolicy(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;

  const clean = {};
  for (const [key, [min, max]] of Object.entries(POLICY_BOUNDS)) {
    const value = stored[key];
    if (value === null) {
      // An explicit null means "this cap is disabled", which is a legitimate
      // choice the engine understands. Preserved as-is.
      clean[key] = null;
    } else if (Number.isFinite(value) && value >= min && value <= max) {
      clean[key] = value;
    } else if (value !== undefined) {
      console.warn(
        `[RiskStore] Ignoring out-of-range policy value ${key}=${JSON.stringify(value)} ` +
          `(expected ${min}..${max}); the engine default will be used.`
      );
    }
  }

  for (const key of POLICY_NESTED) {
    const nested = stored[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const sub = {};
      for (const [k, v] of Object.entries(nested)) {
        if (Number.isFinite(v) || typeof v === 'string' || typeof v === 'boolean') sub[k] = v;
      }
      if (Object.keys(sub).length > 0) clean[key] = sub;
    }
  }

  return Object.keys(clean).length > 0 ? clean : null;
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

const TRADE_STATUSES = ['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED'];

/** Numeric fields that must be a real number for the record to count. */
const TRADE_NUMERIC_FIELDS = [
  'entry', 'stop', 'target', 'leverage', 'notional', 'units',
  'margin', 'plannedRisk', 'plannedRiskPct', 'stopDistancePct',
  'walletAtEntry', 'exitPrice', 'actualPnl'
];

/**
 * Load planned trades, coercing what can be coerced and quarantining what
 * cannot.
 *
 * The previous version back-filled defaults and returned every record as-is.
 * Downstream, calculatePortfolioRisk and detectCorrelatedExposure filter on
 * `isPositiveNumber(plannedRisk)` and calculateExposure coerces a non-numeric
 * margin to 0 — so a record whose plannedRisk was the STRING "1000", or whose
 * status was lowercase "open", was silently dropped from every aggregate with
 * no error anywhere. Measured effect on a two-position book: open risk fell
 * from $1,400 (5.6%) to $0, and the same planned trade flipped from ABOVE PLAN
 * to WITHIN PLAN. Risk that disappears quietly is worse than risk that errors.
 *
 * Numeric strings are coerced (a legitimate legacy shape). Anything still
 * unusable is quarantined and reported via `loadTradesWithRejects()` so the UI
 * can show that the book is incomplete rather than under-counting in silence.
 */
export function loadTradesWithRejects() {
  const raw = readJSON(KEYS.trades, []);
  if (!Array.isArray(raw)) return { trades: [], rejected: [] };

  const trades = [];
  const rejected = [];

  for (const stored of raw) {
    if (!stored || typeof stored !== 'object') {
      rejected.push({ record: stored, reason: 'Not an object' });
      continue;
    }

    const trade = {
      status: 'PLANNED',
      leverage: 1,
      macroContext: null,
      setupContext: null,
      exitPrice: null,
      actualPnl: null,
      ...stored
    };

    // Coerce numeric-looking strings; reject anything else non-numeric.
    let fault = null;
    for (const field of TRADE_NUMERIC_FIELDS) {
      const value = trade[field];
      if (value === null || value === undefined) continue;
      if (Number.isFinite(value)) continue;
      const coerced = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (Number.isFinite(coerced)) {
        trade[field] = coerced;
      } else {
        fault = `${field} is not a number (${JSON.stringify(value)})`;
        break;
      }
    }
    if (fault) {
      rejected.push({ record: stored, reason: fault });
      continue;
    }

    const status = String(trade.status || '').toUpperCase();
    if (!TRADE_STATUSES.includes(status)) {
      rejected.push({ record: stored, reason: `Unknown status ${JSON.stringify(trade.status)}` });
      continue;
    }
    trade.status = status;

    const direction = String(trade.direction || '').toUpperCase();
    if (direction && !['LONG', 'SHORT'].includes(direction)) {
      rejected.push({ record: stored, reason: `Unknown direction ${JSON.stringify(trade.direction)}` });
      continue;
    }
    if (direction) trade.direction = direction;

    trades.push(trade);
  }

  if (rejected.length > 0) {
    console.warn(
      `[RiskStore] ${rejected.length} stored trade(s) failed validation and are excluded from ` +
        'portfolio risk. Reasons: ' + rejected.map((r) => r.reason).join('; ')
    );
  }

  return { trades, rejected };
}

export function loadTrades() {
  return loadTradesWithRejects().trades;
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
    // What the liquidation estimate assumed, and which checks failed.
    marginMode: trade.marginMode ?? 'isolated',
    instrument: trade.instrument ?? 'perpetual',
    warnings: Array.isArray(trade.warnings) ? trade.warnings : [],
    costsAtEntry: trade.costsAtEntry ?? null,

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

  // An import is the least trustworthy write in the system — the file has been
  // outside the app, is hand-editable, and lands directly on the keys that hold
  // the wallet balance and every risk ceiling. It used to be written verbatim,
  // which made it the simplest route to the disabled-limits state described in
  // sanitizePolicy. Everything below goes through the same validation as a
  // normal read, and the result is reported rather than assumed.
  const result = { profile: false, walletHistory: 0, trades: 0, rejected: [] };

  if (payload.profile && typeof payload.profile === 'object') {
    const balance = Number(payload.profile.walletBalance);
    writeJSON(KEYS.profile, {
      walletBalance: Number.isFinite(balance) && balance > 0 ? balance : null,
      policy: sanitizePolicy(payload.profile.policy),
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowISO()
    });
    result.profile = true;
  }

  if (Array.isArray(payload.walletHistory)) {
    const clean = payload.walletHistory.filter(
      (e) => e && typeof e === 'object' && Number.isFinite(Number(e.balance))
    ).map((e) => ({
      id: e.id || newId(),
      balance: Number(e.balance),
      note: typeof e.note === 'string' ? e.note : '',
      timestamp: e.timestamp || nowISO()
    }));
    writeJSON(KEYS.walletHistory, clean);
    result.walletHistory = clean.length;
  }

  if (Array.isArray(payload.trades)) {
    // Write first, then re-read through the validator so imported records are
    // held to exactly the same standard as records already on disk.
    writeJSON(KEYS.trades, payload.trades);
    const { trades, rejected } = loadTradesWithRejects();
    writeJSON(KEYS.trades, trades);
    result.trades = trades.length;
    result.rejected = rejected;
  }

  return result;
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
