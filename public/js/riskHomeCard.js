/**
 * Home-page Risk card — view builder
 * ----------------------------------
 * Turns the Adaptive Risk Manager's last complete evaluation into the compact
 * summary shown on the home page.
 *
 * ==========================================================================
 * THE ONE RULE THIS FILE EXISTS TO OBEY
 * ==========================================================================
 * THIS FILE COMPUTES NO RISK NUMBERS.
 *
 * It has no imports. It cannot reach the engine, the stores or the network,
 * so it cannot re-derive a level, a progress percentage, an open-risk figure
 * or a decision even by accident. Its only input is the read-only `display`
 * cache that `riskPage.js` writes through `saveLevelState()` after a complete
 * engine evaluation, and its only job is to choose which of those cached
 * facts to show and how to word the fact that they are cached.
 *
 * ==========================================================================
 * WHY A CACHE AND NOT A LIVE EVALUATION
 * ==========================================================================
 * The engine's level depends on the account's CLOSED TRADE HISTORY, which is
 * reconstructed from chain data by /api/wallet/trades and takes seconds to
 * arrive. `riskPage.js` already documents what happens if you evaluate before
 * it lands: the engine correctly caps an account with no visible trades at
 * level 0, which is not that account's level.
 *
 * The home page never loads that history. So a home page that evaluated for
 * itself would confidently show the WRONG level on every visit. Instead it
 * shows the last complete evaluation, stamped with when that was — the same
 * choice `riskPage.js` makes for its own `awaitingHistory` state.
 *
 * A consequence worth stating plainly: this card makes NO network request. A
 * wallet or price-provider outage cannot degrade the home page through this
 * module, and cannot make this card show a number that was not true at the
 * moment it is stamped with.
 *
 * ==========================================================================
 * HONESTY RULES
 * ==========================================================================
 *  - A missing figure renders as a dash or as "Unavailable". Never as 0.
 *  - A cache older than the engine's own wallet-freshness horizon forces the
 *    decision to INCOMPLETE, because that is exactly what the engine does
 *    with a stale balance (the STALE_WALLET_DATA blocker).
 *  - The card never invents vocabulary. TRADE / NO TRADE / INCOMPLETE and the
 *    level line come from the engine; this file only re-spaces NO_TRADE.
 */

/** Card states, in order of how much the card can honestly say. */
export const HOME_CARD_STATE = {
  /** Nothing has ever been evaluated on this browser. */
  NEVER_EVALUATED: 'NEVER_EVALUATED',
  /** A cached evaluation exists but is older than the freshness horizon. */
  STALE: 'STALE',
  /** A cached evaluation from within the freshness horizon. */
  FRESH: 'FRESH'
};

/**
 * How old a cached evaluation may be before its decision stops counting.
 *
 * Deliberately the same 10 minutes as `STALE_WALLET_MS` in riskPage.js: the
 * decision is a function of the wallet balance, so the home page has no
 * business treating a balance as current for longer than the Risk Manager
 * itself does. Level and progress are still shown past this horizon — they
 * move on the timescale of closed trades, not blocks — but they are stamped.
 */
export const HOME_CACHE_STALE_MS = 10 * 60 * 1000;

/** Engine decision values, plus the display spelling of each. */
const DECISION_LABEL = {
  TRADE: 'TRADE',
  NO_TRADE: 'NO TRADE',
  INCOMPLETE: 'INCOMPLETE'
};

/* ========================================================================
 * PURE FORMATTERS
 *
 * Every one of these returns `dash` for anything that is not a finite
 * number. There is no branch in this file that turns absent data into 0.
 * ===================================================================== */

const DASH = '—';

/** `$1.2K` / `$3.40M` / `$940`. Mirrors formatUsd(compact) in riskPage.js. */
export function formatWalletValue(value, dash = DASH) {
  if (!Number.isFinite(value)) return dash;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  const decimals = abs < 100 && abs % 1 !== 0 ? 2 : 0;
  return `${sign}$${abs.toFixed(decimals)}`;
}

export function formatRiskPct(value, decimals = 2, dash = DASH) {
  if (!Number.isFinite(value)) return dash;
  return `${value.toFixed(decimals)}%`;
}

/** `4m ago` / `3h ago` / `2d ago`. `never` when the stamp is unusable. */
export function formatAge(timestamp, now = Date.now()) {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!Number.isFinite(at)) return 'never';
  const delta = now - at;
  if (delta < 0) return 'just now';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Which timestamp decides freshness.
 *
 * The decision is a function of the wallet balance, so the wallet read is what
 * ages. When there is no wallet attached at all the account is local records
 * only, nothing is being read from chain, and the evaluation's own stamp is
 * the only meaningful age.
 */
function freshnessStamp(display) {
  const walletAt = display.walletAt ? Date.parse(display.walletAt) : NaN;
  if (Number.isFinite(walletAt)) return walletAt;
  const at = display.at ? Date.parse(display.at) : NaN;
  return Number.isFinite(at) ? at : NaN;
}

/* ========================================================================
 * THE VIEW
 * ===================================================================== */

/**
 * Build everything the home-page Risk card renders.
 *
 * @param {object}      input
 * @param {object|null} input.display  loadLevelDisplay() — the read-only cache
 *                                     riskPage.js writes after a COMPLETE
 *                                     evaluation. Never an engine input.
 * @param {number}      input.now      Date.now(), injectable for tests.
 * @returns {{
 *   state: string,
 *   levelLine: string|null,
 *   levelName: string|null,
 *   progressPct: number|null,
 *   figures: Array<{label: string, value: string}>,
 *   strategy: string|null,
 *   decision: string,
 *   decisionTone: 'POSITIVE'|'NEGATIVE'|'NEUTRAL',
 *   note: string|null,
 *   ariaLabel: string
 * }}
 */
export function buildRiskHomeCard({ display = null, now = Date.now() } = {}) {
  /* ---- 1. Never evaluated ------------------------------------------ */

  // A cache without a level line is not a complete evaluation. Treating a
  // half-written record as authoritative is how a stray 0 reaches the card.
  if (!display || typeof display !== 'object' || typeof display.levelLine !== 'string') {
    return {
      state: HOME_CARD_STATE.NEVER_EVALUATED,
      levelLine: null,
      levelName: null,
      progressPct: null,
      figures: [
        { label: 'Wallet', value: DASH },
        { label: 'Open Risk', value: DASH },
        { label: 'Positions', value: DASH }
      ],
      strategy: null,
      decision: DECISION_LABEL.INCOMPLETE,
      decisionTone: 'NEUTRAL',
      note: 'No evaluation yet — open the Risk Manager',
      ariaLabel: 'Risk — no evaluation yet. Open the Risk Manager.'
    };
  }

  /* ---- 2. Freshness ------------------------------------------------- */

  const stamp = freshnessStamp(display);
  const age = Number.isFinite(stamp) ? now - stamp : Infinity;
  const stale = !(age >= 0 && age < HOME_CACHE_STALE_MS);
  const state = stale ? HOME_CARD_STATE.STALE : HOME_CARD_STATE.FRESH;

  /* ---- 3. Decision --------------------------------------------------
   * A stale balance cannot support a decision. This is not a home-page
   * policy: it is the engine's STALE_WALLET_DATA rule, which turns exactly
   * this situation into INCOMPLETE inside recommendTrade(). Re-applying it
   * here keeps the two surfaces from disagreeing when the cache ages out
   * between a visit to /risk.html and a visit to the home page.
   * ------------------------------------------------------------------ */

  const cachedDecision = DECISION_LABEL[display.decision] ? display.decision : 'INCOMPLETE';
  const decisionKey = stale ? 'INCOMPLETE' : cachedDecision;

  /* ---- 4. Figures ---------------------------------------------------
   * `walletValue` is null whenever the wallet read failed, so an outage
   * reaches the card as "Unavailable" and not as $0. openRiskPct and
   * openPositions are only meaningful next to a real balance.
   * ------------------------------------------------------------------ */

  const walletValue = Number.isFinite(display.walletValue) ? display.walletValue : null;

  /**
   * OPEN RISK IS A PERCENTAGE OF EQUITY, SO IT DIES WITH THE EQUITY.
   *
   * The engine returns 0 for every percentage when it has no equity to divide
   * by — calculateOpenRisk's `equity ? toPercent(...) : 0`, with `valid:false`
   * beside it. That 0 is a placeholder, not a measurement, and rendering it
   * would put "Open Risk 0.00%" next to "Wallet Unavailable": the reassuring
   * reading of an account nobody can currently see. So a percentage whose
   * denominator is missing renders as a dash regardless of what arrived.
   *
   * The position COUNT survives. It is counted from position records, not
   * divided by equity, so it is still a fact when the balance is not.
   */
  const equityKnown = walletValue !== null && walletValue > 0;

  /**
   * No wallet attached is not the same as a wallet that could not be read.
   *
   * The Risk Manager works without a wallet, on local records alone, and that
   * account has no balance because none was ever asked for. Calling that
   * "Unavailable" reports a failure that did not happen and sends the operator
   * looking for an outage instead of the connect button. IDLE is the status
   * riskPage.js leaves the wallet in when there is no address to read.
   */
  const noWalletAttached = walletValue === null && display.walletStatus === 'IDLE';

  const figures = [
    {
      label: 'Wallet',
      value:
        walletValue !== null
          ? formatWalletValue(walletValue)
          : noWalletAttached
            ? 'Not set'
            : 'Unavailable'
    },
    { label: 'Open Risk', value: equityKnown ? formatRiskPct(display.openRiskPct) : DASH },
    {
      label: 'Positions',
      value: Number.isFinite(display.openPositions) ? String(display.openPositions) : DASH
    }
  ];

  /* ---- 5. Note ------------------------------------------------------ */

  let note = null;
  if (noWalletAttached) {
    // Said first: with no wallet attached the cache's age is beside the point,
    // and "as of 3h ago" would imply something was read 3 hours ago.
    note = 'No wallet connected';
  } else if (stale) {
    note = `As of ${formatAge(stamp, now)}`;
  } else if (walletValue === null) {
    note = 'Wallet data unavailable at last check';
  } else if (decisionKey === 'NO_TRADE' && typeof display.primaryBlocker === 'string' && display.primaryBlocker) {
    note = display.primaryBlocker;
  }

  const levelName = typeof display.levelLabel === 'string' && display.levelLabel
    ? display.levelLabel.toUpperCase()
    : null;

  return {
    state,
    // The engine's own phrasing, composed by riskPage.js and cached verbatim
    // so the two surfaces can never word the same level differently.
    levelLine: display.levelLine,
    levelName,
    progressPct: Number.isFinite(display.progressPct)
      ? Math.max(0, Math.min(100, display.progressPct))
      : null,
    figures,
    strategy: typeof display.strategy === 'string' && display.strategy ? display.strategy : null,
    decision: DECISION_LABEL[decisionKey],
    decisionTone:
      decisionKey === 'TRADE' ? 'POSITIVE' : decisionKey === 'NO_TRADE' ? 'NEGATIVE' : 'NEUTRAL',
    note,
    ariaLabel: `Risk — ${display.levelLine}, ${DECISION_LABEL[decisionKey]}. Open the Risk Manager.`
  };
}

export default { buildRiskHomeCard, HOME_CARD_STATE, HOME_CACHE_STALE_MS };
