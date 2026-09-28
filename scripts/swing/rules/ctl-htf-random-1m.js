/**
 * T-20 control: ctl-htf-random-1m (docs/PROMPT_T20_HTF_ENTRY.md deliverable 4, "random
 * direction with identical mechanics") - the SAME trigger, 1h swing stop/target, NF floor,
 * scalp cap and R:R gates as htf-entry-1m.js (lib/htfEntryRule.js `checkHtfTrigger`,
 * `buildHtfPlan`), but the direction is a seeded coin flip (same FNV-1a -> mulberry32
 * technique as scripts/swing/rules/re-random-4h.js / ctl-random-4h.js / mr-random-1h.js)
 * instead of the 4h+1D EMA21/EMA200 stack. A 1m/5m flag is still required in that randomly
 * chosen direction; the signal is skipped (not forced) when nothing qualifies. Isolates
 * what the direction gate is worth: entry/stop/target/exit mechanics held fixed, only the
 * direction source changes (trend stack vs. coin flip).
 *
 * No lookahead: same clipping rules as htf-entry-1m.js (lib/htfEntryRule.js signalAt).
 */

import { seededDraw } from '../../../lib/retestShared.js';
import {
  checkHtfTrigger, buildHtfPlan, htfStructureHoldRule, TRIGGER_TIMEFRAMES, HOLD_MAX_HOURS
} from '../../../lib/htfEntryRule.js';
import { clipTo, candleTime, isFiniteNumber } from '../../../lib/retestShared.js';

export const RANDOM_SEED = 2026;

export const meta = {
  id: 'ctl-htf-random-1m',
  label: 'Control: seeded random direction, HTF-entry mechanics (T-20)',
  source: 'docs/PROMPT_T20_HTF_ENTRY.md',
  tf: '1m',
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    `Null baseline for htf-entry-1m.js: seeded (RANDOM_SEED=${RANDOM_SEED}) deterministic random direction on every closed 1m candle, no 4h+1D trend gate - same FNV-1a -> mulberry32 seeding as ctl-random-4h.js/re-random-4h.js/mr-random-1h.js.`,
    'Trigger/stop/target/gates identical to htf-entry-1m.js: a 1m/5m flag reaching triggering in the randomly drawn direction, 1h swing stop (NF-floored, 3% scalp-capped), target = last 1h impulse projected from that swing, >= 2.5R gross / >= 1.0R net.',
    'Isolates what the 4h+1D direction gate is worth against otherwise-identical mechanics.'
  ].join('\n')
};

export function signalAt(ctx) {
  const { i, candlesByTf, symbol } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf || !symbol) return null;

  const raw1m = candlesByTf['1m'];
  if (!Array.isArray(raw1m) || i >= raw1m.length) return null;
  const candles1m = raw1m.slice(0, i + 1);
  if (!candles1m.length) return null;
  const cutMs = candleTime(candles1m[candles1m.length - 1]);
  if (cutMs === null) return null;

  const draw = seededDraw(RANDOM_SEED, symbol, cutMs);
  const direction = draw < 0.5 ? 'long' : 'short';

  const candles5m = clipTo(candlesByTf['5m'], cutMs);
  const trigger = checkHtfTrigger({ candlesByTf: { '1m': candles1m, '5m': candles5m }, tfs: TRIGGER_TIMEFRAMES, direction, cutMs });
  if (!trigger) return null;

  const candles1h = clipTo(candlesByTf['1h'], cutMs);
  const geometry1h = ctx.geometry && ctx.geometry['1h'];
  const geometry4h = ctx.geometry && ctx.geometry['4h'];
  const geometry15m = ctx.geometry && ctx.geometry['15m'];
  const atr1h = geometry1h && isFiniteNumber(geometry1h.atr) ? geometry1h.atr : null;
  const atr15m = geometry15m && isFiniteNumber(geometry15m.atr) ? geometry15m.atr : null;
  if (!isFiniteNumber(atr1h)) return null;

  const plan = buildHtfPlan({ direction, entry: trigger.entry, candles1h, atr1h, atr15m, geometry1h, geometry4h });
  if (plan.status !== 'ready') return null;

  const reason = [
    `seeded random draw ${draw.toFixed(4)} (seed ${RANDOM_SEED}, symbol ${symbol}, ts ${cutMs}) -> ${direction}, no trend gate`,
    `${trigger.tf} flag reached triggering ${direction} at ${trigger.entry} (breakout candle, ageCandles 0)`,
    `stop ${plan.stop} (1h swing anchor ${plan.anchor}, NF-floored, ${plan.stopPct}% <= 3% scalp cap)`,
    `TP1 ${plan.tp1} = last 1h impulse projected from the anchor (${plan.grossRR}R gross, ${plan.netRR}R net)`
  ];

  return {
    direction,
    entry: trigger.entry,
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: isFiniteNumber(plan.tp2) ? plan.tp2 : undefined,
    reason,
    holdRule: htfStructureHoldRule(plan.structureStop, direction)
  };
}

export default { meta, signalAt, RANDOM_SEED };
