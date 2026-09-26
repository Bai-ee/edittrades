/**
 * Wallet strategy profile virtual equity curves (T-9 v2 P3/P5). Pure functions over
 * already-scored tracker data (journal-outcomes.jsonl, outcomes.jsonl - ./score.js
 * scoreJournalDataDir / scoreDataDir, part of the existing sync pipeline) plus the raw
 * journal (./store.js readJournal) for the two fields the scored rows do not carry:
 * `resultUsd` (a close) and `execRef.profiles` (an open, T-9 v2 P3). No I/O, no live reads.
 *
 * Two curves per profile:
 *  - `live`: every closed EXECUTION journal trade (lib/execution/executor.js), R-multiple
 *    from journal-outcomes.jsonl, sized by the riskUsd `execRef.profiles[profile]` stamped
 *    at OPEN time (lib/execution/riskPolicy.js `evaluateAllProfiles`) — the profile's
 *    ACTUAL tier-scaled budget for that trade, not re-derived here.
 *  - `asIf`: every scored GOOD call from outcomes.jsonl that reached a final outcome
 *    (tp1/stop), whether or not it was ever taken — sized off a RUNNING virtual equity for
 *    that profile at tier 'B' (multiplier 1). The qualityBand / clarity.gate fields a real
 *    A/B/C classification (lib/tier.js `classifyTier`) needs are not carried through
 *    extractCalls/scoreCalls's call-row shape, so this is a documented simplification, not
 *    the exact tier a live order of that call would have gotten.
 *
 * Both curves start from BOT_WALLET_START_EQUITY_USD (docs/AGENT_SESSION_RULES.md, "Bot
 * wallet ... ~$520", 2026-09-26): there is no separate synced history of the EXECUTION
 * signing wallet's equity (data/wallet.jsonl tracks the TRACKED wallet, a different
 * address — lib/execution/executor.js "equity source" doc comment). `real` is therefore
 * RECONSTRUCTED from that same starting point plus every execution journal close's
 * `resultUsd`, cumulative — an approximation from already-synced data, not a live
 * `walletEquitySnapshot` read (the tracker has no such live path).
 */
import { PROFILES, PROFILE_KEYS, tieredPolicyConfig } from './profileConfig.js';

export const BOT_WALLET_START_EQUITY_USD = 520;
const ASIF_TIER = 'B'; // documented simplification, see module header

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/** Chronological closed EXECUTION journal trades, with the profile riskUsd stamped at open. */
function liveExecutionTrades(journalOutcomes, journalRecords) {
  const byId = new Map((journalRecords || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  return (journalOutcomes || [])
    .filter((row) => row && row.outcome === 'closed' && isNum(row.r) && row.journalId)
    .map((row) => {
      const open = byId.get(row.journalId);
      return {
        journalId: row.journalId,
        calledAt: row.calledAt,
        r: row.r,
        source: open ? open.source : null,
        profiles: open && open.execRef && open.execRef.profiles ? open.execRef.profiles : null
      };
    })
    .filter((t) => t.source === 'execution')
    .sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
}

/** Chronological scored GOOD calls that reached tp1/stop, whether or not they were ever taken. */
function asIfGoodCalls(callOutcomes) {
  return (callOutcomes || [])
    .filter((row) => row && row.class === 'GOOD' && ['tp1', 'stop'].includes(row.outcome) && isNum(row.r))
    .sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
}

/** Walk a chronological trade list into an equity curve, given a per-trade riskUsd rule. */
function walkCurve(trades, riskUsdOf) {
  let equity = BOT_WALLET_START_EQUITY_USD;
  const points = [{ atMs: null, equityUsd: equity }];
  const rs = [];
  for (const t of trades) {
    const riskUsd = riskUsdOf(t, equity);
    if (!isNum(riskUsd)) continue;
    equity = r2(equity + riskUsd * t.r);
    rs.push(t.r);
    points.push({ atMs: Date.parse(t.calledAt), equityUsd: equity });
  }
  const expectancyR = rs.length ? r2(rs.reduce((s, r) => s + r, 0) / rs.length) : null;
  return { points, trades: rs.length, expectancyR };
}

/** One profile's {live, asIf} curves, trade counts toward evaluateAfterTrades, and expectancy. */
function curveFor(profileKey, liveTrades, asIfCalls) {
  const p = PROFILES[profileKey];
  const live = walkCurve(liveTrades, (t) => (t.profiles && t.profiles[profileKey] ? t.profiles[profileKey].riskUsd : null));
  const asIf = walkCurve(asIfCalls, (t, equity) => {
    const cfg = tieredPolicyConfig(profileKey, ASIF_TIER);
    return r2(equity * (cfg.pctPerTrade / 100));
  });
  return {
    key: profileKey,
    label: p.label,
    evaluateAfterTrades: p.evaluateAfterTrades,
    live: { points: live.points, trades: live.trades, expectancyR: live.expectancyR },
    asIf: { points: asIf.points, trades: asIf.trades, expectancyR: asIf.expectancyR }
  };
}

/**
 * @param {Object} data
 * @param {Array} data.journalRecords - store.js readJournal(dataDir) (raw)
 * @param {Array} data.journalOutcomes - store.js readJsonl(journalOutcomesFile(dataDir)) (scored)
 * @param {Array} data.callOutcomes - store.js readJsonl(outcomesFile(dataDir)) (scored)
 * @returns {{startEquityUsd:number, real:{points:Array}, profiles:Object<string,Object>}}
 */
export function computeProfileCurves({ journalRecords = [], journalOutcomes = [], callOutcomes = [] } = {}) {
  const liveTrades = liveExecutionTrades(journalOutcomes, journalRecords);
  const asIfCalls = asIfGoodCalls(callOutcomes);

  let realEquity = BOT_WALLET_START_EQUITY_USD;
  const realPoints = [{ atMs: null, equityUsd: realEquity }];
  for (const r of [...journalRecords].sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0))) {
    if (r && r.kind === 'close' && r.source === 'execution' && isNum(r.resultUsd)) {
      realEquity = r2(realEquity + r.resultUsd);
      realPoints.push({ atMs: Date.parse(r.receivedAt), equityUsd: realEquity });
    }
  }

  const profiles = {};
  for (const key of PROFILE_KEYS) profiles[key] = curveFor(key, liveTrades, asIfCalls);
  return { startEquityUsd: BOT_WALLET_START_EQUITY_USD, real: { points: realPoints }, profiles };
}

/** Read every input computeProfileCurves needs straight from dataDir and compute it. */
export async function computeProfileCurvesDataDir(dataDir) {
  const { readJournal, readJsonl, journalOutcomesFile, outcomesFile } = await import('./store.js');
  return computeProfileCurves({
    journalRecords: readJournal(dataDir),
    journalOutcomes: readJsonl(journalOutcomesFile(dataDir)),
    callOutcomes: readJsonl(outcomesFile(dataDir))
  });
}
