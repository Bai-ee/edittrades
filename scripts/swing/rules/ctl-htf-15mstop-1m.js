/**
 * T-20 control: ctl-htf-15mstop-1m (docs/PROMPT_T20_HTF_ENTRY.md deliverable 4, "same rule
 * with the stop at 15m structure instead of 1h swing") - the SAME direction (4h+1D
 * EMA21/EMA200 stack, `lib/htfEntryRule.js` htfDirectionAt) and the SAME 1m/5m trigger as
 * htf-entry-1m.js, but the swing anchor/stop/target come from `buildHtfPlan`'s own swing
 * math run on the 15m candle series instead of the 1h series - `buildHtfPlan` takes
 * whatever candle array and ATR it is handed for the "swing" side of the plan (it has no
 * 1h-specific logic), so this control reuses it unchanged, just fed 15m instead of 1h. The
 * NF floor's own ATR15m input is the SAME 15m ATR here (the floor and the structure are
 * both 15m-scaled in this control, unlike the live rule where they are two different
 * timeframes) - isolates what anchoring the stop/target to 1h swing structure specifically
 * is worth, against a tighter, faster 15m structure read with everything else held fixed.
 *
 * No lookahead: same clipping rules as htf-entry-1m.js (lib/htfEntryRule.js signalAt).
 */

import {
  htfDirectionAt, checkHtfTrigger, buildHtfPlan, htfStructureHoldRule, TRIGGER_TIMEFRAMES, HOLD_MAX_HOURS
} from '../../../lib/htfEntryRule.js';
import { clipTo, candleTime, isFiniteNumber } from '../../../lib/retestShared.js';

export const meta = {
  id: 'ctl-htf-15mstop-1m',
  label: 'Control: HTF-entry mechanics, stop/target at 15m structure instead of 1h (T-20)',
  source: 'docs/PROMPT_T20_HTF_ENTRY.md',
  tf: '1m',
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    'Same direction (4h+1D EMA21/EMA200 stack) and same 1m/5m trigger as htf-entry-1m.js.',
    'Stop/target: buildHtfPlan\'s own swing-anchor math run on the 15m series instead of 1h - a tighter, faster structure read. The NF floor\'s ATR15m input is the same 15m ATR used for the swing/buffer side here (both 15m-scaled in this control, unlike the live rule\'s 1h-structure/15m-floor split).',
    'Isolates what anchoring to 1h swing structure specifically is worth, against otherwise-identical mechanics.'
  ].join('\n')
};

export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw1m = candlesByTf['1m'];
  if (!Array.isArray(raw1m) || i >= raw1m.length) return null;
  const candles1m = raw1m.slice(0, i + 1);
  if (!candles1m.length) return null;
  const cutMs = candleTime(candles1m[candles1m.length - 1]);
  if (cutMs === null) return null;

  const candles4h = clipTo(candlesByTf['4h'], cutMs);
  const candles1d = clipTo(candlesByTf['1d'], cutMs);
  const direction = htfDirectionAt({ candles4h, candles1d });
  if (!direction) return null;

  const candles5m = clipTo(candlesByTf['5m'], cutMs);
  const trigger = checkHtfTrigger({ candlesByTf: { '1m': candles1m, '5m': candles5m }, tfs: TRIGGER_TIMEFRAMES, direction, cutMs });
  if (!trigger) return null;

  const candles15m = clipTo(candlesByTf['15m'], cutMs);
  const geometry15m = ctx.geometry && ctx.geometry['15m'];
  const geometry4h = ctx.geometry && ctx.geometry['4h'];
  const atr15m = geometry15m && isFiniteNumber(geometry15m.atr) ? geometry15m.atr : null;
  if (!isFiniteNumber(atr15m)) return null;

  // candles1h/atr1h params are the swing/buffer side of buildHtfPlan - fed 15m data here
  // (see this file's own header note); geometry1h -> geometry15m (its own TP2 zone source).
  const plan = buildHtfPlan({ direction, entry: trigger.entry, candles1h: candles15m, atr1h: atr15m, atr15m, geometry1h: geometry15m, geometry4h });
  if (plan.status !== 'ready') return null;

  const reason = [
    `4h+1D EMA21/EMA200 stack agree ${direction} (price ${direction === 'long' ? 'above' : 'below'} EMA21(4h))`,
    `${trigger.tf} flag reached triggering ${direction} at ${trigger.entry} (breakout candle, ageCandles 0)`,
    `stop ${plan.stop} (15m swing anchor ${plan.anchor}, NF-floored on the same 15m ATR, ${plan.stopPct}% <= 3% scalp cap)`,
    `TP1 ${plan.tp1} = last 15m impulse projected from the anchor (${plan.grossRR}R gross, ${plan.netRR}R net)`
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

export default { meta, signalAt };
