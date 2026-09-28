/**
 * Re-export shim (2026-09-27, docs/PROMPT_LIVE_RETEST1H.md): the S3 retest-entry shared
 * helpers moved to lib/retestShared.js so the live retest-1h alert (lib/retest1hLive.js)
 * and this research package share ONE implementation, with no scripts/ import needed on
 * the live (api/telegram-cron.js) path. Every research rule file in scripts/swing/rules/
 * that imports `../retestShared.js` keeps working unchanged against this shim.
 */
export * from '../../lib/retestShared.js';
