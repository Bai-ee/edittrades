/**
 * AI Data Contract
 * ----------------
 * The rules every model call in EditTrades runs under, plus the helpers that
 * make a payload honest before it is sent.
 *
 * The problem this exists to solve is not that the model was badly behaved. It
 * is that the model was handed almost nothing and told to be specific. The
 * trade-analysis path filtered its snapshot with the wrong key names —
 * `currentPrice` and `priceChange24h` where the client sends `price` and
 * `change24h`, `analysis` where the client sends `signal.confluence`, and
 * `timeframes` not copied at all — so those fields arrived `undefined`.
 * `JSON.stringify` drops undefined keys, so the model could not even see that
 * they were meant to exist. Meanwhile the prompt asked for "actual numbers from
 * the data", "exact percentage from data", 15m and 5m stochastic readings, and
 * a timeline in hours. With no evidence and no instruction to say so, inventing
 * was the only way to answer.
 *
 * Two mechanisms follow from that:
 *
 *   serializeDataBlock  renders absent fields as the literal "MISSING" rather
 *                       than letting them vanish, so absence is visible.
 *   collectMissingFields  computes the missing list deterministically and puts
 *                       it in the prompt, so the model is told what it lacks
 *                       instead of having to notice.
 *
 * AI is the last layer of the desk and owns none of the numbers.
 */

/**
 * Binding preamble, prepended to every call. Server-side only.
 *
 * Deliberately placed before any tone or persona text and stated as overriding
 * it, because the tone instructions elsewhere in this codebase ask for
 * confidence, and confidence about absent data is precisely the failure.
 */
export const DATA_CONTRACT = `DATA CONTRACT — binding. This section overrides every tone, persona and style instruction that follows it.

You are a commentary layer over a deterministic trading engine. The engine owns every number. You own only explanation.

YOU MAY:
  - Explain what the supplied values mean and why the engine reached its label.
  - Compare supplied values with each other and with supplied thresholds.
  - Caution, qualify, and point out conflicts between supplied inputs.
  - Say a setup looks weak, or that the inputs disagree with each other.
  - Point out concentration or portfolio risk that the supplied risk block shows.

YOU MAY NOT, under any circumstances:
  - State, estimate, round, extrapolate or infer any price, entry, stop, target,
    EMA, stochastic value, distance-from-EMA, swing level, macro anchor,
    economic value, premium, percentile, wallet balance, position size, risk
    amount, leverage or liquidation price that is not present verbatim in the
    DATA block.
  - Recompute or "correct" any supplied number.
  - Predict a timeline, a future price, or when a condition will be met.
  - Contradict, upgrade, downgrade or relabel the engine's decision in
    signal.valid, signal.direction or the strategy label. If the supplied
    evidence cuts against the engine, say so plainly and stop there.
  - Emit a rating, grade, score or priority. The engine assigns those.
  - Tell the user to enter or exit a trade.

MISSING INPUTS — mandatory:
  Any field shown as null, "MISSING", or "UNAVAILABLE" is missing. Name every
  missing field you would have needed and say your read is incomplete because
  of it. Never work around a missing value, never substitute a typical one,
  never infer one from a related field. "The 15m EMA distance was not supplied,
  so I cannot assess entry precision" is a correct and expected answer.

DEGRADED SOURCES — mandatory:
  If dataHealth reports any feed stale, degraded or unavailable, open by saying
  so and name which. Never present degraded data as current.

CONFIDENCE:
  Your confidence must track the amount and freshness of the supplied evidence,
  never the direction of the signal. Do not use "strong buy", "will",
  "definitely", "guaranteed", or "expect".

OUTPUT: prose only. No number that is not quoted from the DATA block.`;

/**
 * JSON with absence made visible.
 *
 * `undefined` becomes the string "MISSING" instead of being dropped. `null` is
 * preserved, because null is a deliberate "we looked and there is nothing"
 * from the deterministic layer, and the contract treats both as missing.
 */
export function serializeDataBlock(payload, space = 2) {
  const withMissing = (value) => {
    if (value === undefined) return 'MISSING';
    if (Array.isArray(value)) return value.map(withMissing);
    if (value && typeof value === 'object') {
      const out = {};
      // Object.keys skips nothing here because the caller builds these
      // objects with explicit keys; an absent key is the case we cannot see,
      // which is why callers should pass an explicit schema (see below).
      for (const [k, v] of Object.entries(value)) out[k] = withMissing(v);
      return out;
    }
    return value;
  };
  return JSON.stringify(withMissing(payload), null, space);
}

/**
 * Walk a payload against a list of dotted paths the prompt relies on, and
 * return those that are absent.
 *
 * Computed deterministically before the call so the model is *told* what is
 * missing rather than left to infer it from a gap.
 */
export function collectMissingFields(payload, requiredPaths) {
  const missing = [];
  for (const path of requiredPaths) {
    let node = payload;
    let found = true;
    for (const part of path.split('.')) {
      if (node === null || node === undefined || typeof node !== 'object' || !(part in node)) {
        found = false;
        break;
      }
      node = node[part];
    }
    if (!found || node === null || node === undefined || node === 'MISSING') missing.push(path);
  }
  return missing;
}

/**
 * Assemble the user-facing prompt body with the contract's required framing.
 */
export function buildPromptBody({ instruction, payload, requiredPaths = [], dataHealth = null }) {
  const missing = collectMissingFields(payload, requiredPaths);

  const parts = [instruction.trim(), '', 'DATA:', serializeDataBlock(payload)];

  if (dataHealth) {
    parts.push('', 'DATA HEALTH:', serializeDataBlock(dataHealth));
  }

  parts.push(
    '',
    missing.length > 0
      ? `MISSING INPUTS (${missing.length}): ${missing.join(', ')}\n` +
          'You must state that these were not supplied and that your read is incomplete without them. ' +
          'Do not estimate them.'
      : 'MISSING INPUTS: none.'
  );

  return { prompt: parts.join('\n'), missing };
}

/**
 * Clamp sampling temperature.
 *
 * This was `parseFloat(variables?.temperature || '0.5')` straight from the
 * request body, with a cap applied only when `isDev` — and `isDev` was true
 * unless `VERCEL_ENV === 'production'`, so in production there was no cap at
 * all and a caller could request temperature 2 on the operator's key.
 */
export function clampTemperature(requested, max = 0.4) {
  const value = Number(requested);
  if (!Number.isFinite(value)) return Math.min(0.3, max);
  return Math.min(Math.max(value, 0), max);
}

/** Pinned model ids. Floating aliases change behaviour under you silently. */
export const AI_MODELS = Object.freeze({
  commentary: process.env.OPENAI_COMMENTARY_MODEL || 'gpt-4o-mini-2024-07-18',
  vision: process.env.OPENAI_VISION_MODEL || 'gpt-4o-2024-11-20'
});

export default {
  DATA_CONTRACT,
  serializeDataBlock,
  collectMissingFields,
  buildPromptBody,
  clampTemperature,
  AI_MODELS
};
