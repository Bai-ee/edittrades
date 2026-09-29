/**
 * T-24 prediction rule (docs/PROMPT_T24_PREDICTION_TRACKER.md) - swing-harness wrapper.
 *
 * Re-exports `lib/predictionRule.js` unchanged, same precedent as
 * `scripts/swing/rules/htf-entry-1m.js` re-exporting `lib/htfEntryRule.js`: the replay
 * runner (scripts/predictions/replay.js) and the live writer (agent D's
 * `lib/predictionLive.js`) call the exact same `predictNextCandle`, never two
 * implementations that happen to agree today.
 */
export * from '../../../lib/predictionRule.js';
export { default } from '../../../lib/predictionRule.js';
