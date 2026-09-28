/**
 * T-20 HTF-anchored entry (docs/PROMPT_T20_HTF_ENTRY.md) - swing-harness wrapper.
 *
 * Re-exports `lib/htfEntryRule.js` unchanged, same precedent as
 * `scripts/swing/rules/re-flag-retest-1h.js` re-exporting `lib/retest1hRule.js`: the
 * research harness (scripts/swing/run.js) and the live alert (lib/htfEntryLive.js) call
 * the exact same `signalAt`, never two implementations that happen to agree today.
 */
export * from '../../../lib/htfEntryRule.js';
export { default } from '../../../lib/htfEntryRule.js';
