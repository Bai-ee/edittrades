/**
 * Re-export shim (2026-09-27, docs/PROMPT_LIVE_RETEST1H.md): this rule's `meta`/`signalAt`
 * moved to lib/retest1hRule.js so the live retest-1h alert (lib/retest1hLive.js) imports
 * the SAME implementation directly from lib/, with no scripts/ import needed on the live
 * (api/telegram-cron.js) path. The S0 research harness (scripts/swing/run.js's loadRules,
 * which imports every `.js` file directly under this directory) and
 * test-swing-rules-retest.js both keep working against this file unchanged.
 */
import retest1hRule, { meta, signalAt } from '../../../lib/retest1hRule.js';

export { meta, signalAt };
export default retest1hRule;
