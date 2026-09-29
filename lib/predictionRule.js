// T-24 STUB: replaced by agent A's lib/predictionRule.js on merge
//
// Placeholder for docs/PROMPT_T24_PREDICTION_TRACKER.md's "Shared contract" rule file.
// Agent D (this worktree, pred-live) codes lib/predictionLive.js strictly against the
// exported names below so the orchestrator can drop agent A's real rule in on merge with
// no call-site change here. This stub's own decisions are deliberately fixed (always
// `no_call`) and NEVER asserted on by test-prediction-live.js - that file injects its own
// fake `predict` for every case that needs a real 'over'/'under' outcome, so nothing in
// the live writer depends on this stub actually deciding anything.

export const PREDICTION_TIMEFRAMES = ['5m', '15m', '1h', '4h'];
export const PREDICTION_SYMBOLS = ['BTC', 'ETH', 'SOL'];
export const HIGHER_TF = { '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' };

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * STUB: always `no_call`, confidence 0, pure and side-effect free - matches the real
 * contract's shape (`{direction, confidence, inputs, reason}`) so lib/predictionLive.js
 * can be written and wired against it unchanged before agent A's real rule lands.
 * @param {{symbol:string, timeframe:string, candles:Array<Object>, higherCandles:Array<Object>}} o
 */
export function predictNextCandle({ symbol, timeframe, candles, higherCandles } = {}) {
  const ok = Array.isArray(candles) && candles.length >= 210;
  return {
    direction: 'no_call',
    confidence: 0,
    inputs: { ema21Side: null, ema200Side: null, higherEma21Side: null, stoch: null, lastSwing: null },
    reason: ok
      ? 'T-24 stub: no rule yet (agent A lands lib/predictionRule.js on merge)'
      : 'T-24 stub: insufficient candle history'
  };
}

export default { PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF, predictNextCandle };
