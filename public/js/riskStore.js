// Integration facade: preserve the hardened production store for all legacy
// risk-manager state, and expose the adaptive branch's new local-only stores
// without replacing the validated persistence code shipped on main.
export * from './riskStoreLegacy.js';

export {
  loadWalletAddress,
  saveWalletAddress,
  clearWalletAddress,
  loadEquitySnapshots,
  appendEquitySnapshot,
  latestEquitySnapshot,
  classifiedCashFlows,
  pendingCashFlows,
  ingestCashFlowCandidates,
  classifyCashFlow,
  addManualCashFlow,
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
  watchingRecommendations,
  linkRecommendationToTrade,
  upsertTradeRecord,
  mergeTradeRecords,
  saveScreenshotMeta,
  loadUiPrefs,
  saveUiPrefs
} from './riskStoreAdaptive.js';
