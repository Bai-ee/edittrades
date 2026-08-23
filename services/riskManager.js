/**
 * Risk Manager — server-side re-export.
 *
 * The implementation lives in public/js/riskManager.js rather than here.
 *
 * Why: the Risk Manager's position-size slider has to recalculate on every
 * drag, so the engine must run in the browser. This project has no build step
 * and only `public/` is served to the client (vercel.json maps `public/**` to
 * @vercel/static), so a module under services/ could never reach the page.
 *
 * Keeping one implementation and re-exporting it means the browser and any
 * server-side caller share identical arithmetic, with no duplicated maths to
 * drift apart.
 */
export * from '../public/js/riskManager.js';
export { default } from '../public/js/riskManager.js';
