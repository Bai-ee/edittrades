/**
 * T-20 HTF-anchored entry rule tests (docs/PROMPT_T20_HTF_ENTRY.md, `lib/htfEntryRule.js`).
 *
 * Deterministic, zero-network, pure-function coverage: direction (4h+1D EMA21/EMA200
 * stack, mirror, insufficient-history nulls), the 1m/5m trigger (ageCandles-0 boundary
 * alignment, direction gate), the 1h swing anchor + impulse-projected target (mirror
 * symmetry on a negated series), the stop (NF floor, 3% scalp cap as a rejection - never a
 * clamp - and exact stop-side-of-entry), the R:R gates, `signalAt`'s no-lookahead
 * guarantee, and the candidateId helpers.
 *
 * `scripts/swing/rules/htf-entry-1m.js` re-exports this module unchanged (same precedent
 * as re-flag-retest-1h.js / lib/retest1hRule.js) - covered by a one-line identity check
 * here; the harness-integration/parity-vs-live tests live in test-swing-rules-htf.js and
 * test-htf-entry-live.js respectively.
 *
 * Run: node test-htf-entry-rule.js
 */

import {
  meta, emaStackAt, htfDirectionAt, swingAnchorAndTarget, htfStop, stopWithinScalpCap,
  stopPct, grossRR, closesAt, checkHtfTrigger, buildHtfPlan, htfStructureHoldRule,
  htfCandidateId, isHtfCandidateId, signalAt,
  EMA_FAST_PERIOD, EMA_SLOW_PERIOD, MIN_GROSS_RR, MIN_NET_RR, HOLD_MAX_HOURS
} from './lib/htfEntryRule.js';
import * as htfEntry1m from './scripts/swing/rules/htf-entry-1m.js';
import { detectFlagLifecycle } from './lib/patternDetector.js';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg || 'mismatch'}: expected ~${expected} (tol ${tol}), got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const H1_MS = 3600000;
const H4_MS = 4 * 3600000;
const DAY_MS = 86400000;
const M1_MS = 60000;

function candle(ts, o, h, l, c, stepMs = H1_MS) {
  return { timestamp: ts, open: o, high: h, low: l, close: c, closeTime: ts + stepMs };
}

/** Plain drifting series (EMA stack fixtures) - direction 'up'/'down', stepMs granularity. */
function drift(n, direction, endTs, stepMs, startPrice = 100) {
  const step = direction === 'up' ? 0.6 : -0.6;
  const startTs = endTs - n * stepMs;
  const out = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step + Math.sin(i / 7) * 0.15;
    const close = price;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const ts = startTs + i * stepMs;
    out.push(candle(ts, open, high, low, close, stepMs));
  }
  return out;
}

/**
 * A realistic 1h up-leg -> swing high -> pullback -> swing low (anchor) -> continuation
 * fixture, at a BTC-like price scale, tuned so buildHtfPlan reads 'ready' at entry=89700
 * (validated by hand: gross 2.612R, net 1.709R, stopPct 1.02%).
 */
function buildOneHSwingFixture(startTs = 1_700_000_000_000) {
  const candles = [];
  let ts = startTs;
  let price = 85000;
  for (let i = 0; i < 30; i++) { const o = price; price += 233; const c = price; candles.push(candle(ts, o, Math.max(o, c) + 30, Math.min(o, c) - 30, c)); ts += H1_MS; }
  const swingHighVal = price + 100;
  candles.push(candle(ts, price, swingHighVal, price - 20, swingHighVal - 50)); ts += H1_MS;
  price = swingHighVal - 50;
  for (let i = 0; i < 4; i++) { const o = price; price -= 100; const c = price; candles.push(candle(ts, o, o + 30, c - 30, c)); ts += H1_MS; }
  for (let i = 0; i < 10; i++) { const o = price; price -= 190; const c = price; candles.push(candle(ts, o, Math.max(o, c) + 30, Math.min(o, c) - 30, c)); ts += H1_MS; }
  const swingLowVal = price - 100;
  candles.push(candle(ts, price, price + 20, swingLowVal, swingLowVal + 80)); ts += H1_MS;
  price = swingLowVal + 80;
  for (let i = 0; i < 4; i++) { const o = price; price += 60; const c = price; candles.push(candle(ts, o, c + 30, o - 30, c)); ts += H1_MS; }
  return { candles, swingHighVal, swingLowVal };
}

function negate(candles) {
  return candles.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seriesBuilder(seed, wobble = 2) {
  const rand = mulberry32(seed);
  const candles = [];
  const api = {
    candles,
    lastClose: () => (candles.length ? candles[candles.length - 1].close : 100000),
    push(open, close, opts = {}) {
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      candles.push({ open, high: opts.high ?? top + wobble + rand() * wobble * 1.5, low: opts.low ?? bottom - wobble - rand() * wobble * 1.5, close });
      return api;
    },
    base(count, level = 100000) {
      for (let i = 0; i < count; i++) { const open = api.lastClose(); api.push(open, level + (rand() - 0.5) * 20); }
      return api;
    },
    move(count, perCandle) {
      for (let i = 0; i < count; i++) { const open = api.lastClose(); api.push(open, open + perCandle); }
      return api;
    },
    flag(count, high, low) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        const close = i % 2 === 0 ? low + (high - low) * 0.35 : low + (high - low) * 0.65;
        api.push(open, close, {
          high: Math.max(open, close, Math.min(high, Math.max(open, close) + 3)),
          low: Math.min(open, close, Math.max(low, Math.min(open, close) - 3))
        });
      }
      return api;
    }
  };
  return api;
}

function buildFlagBreakout(seed = 21, { level = 100000, poleStep = 1200, flagHighOffset = 30, flagLowOffset = 300, breakoutOffset = 60, wobble = 2 } = {}) {
  const s = seriesBuilder(seed, wobble);
  s.base(60, level).move(6, poleStep);
  const poleTop = s.lastClose();
  const flagHigh = poleTop - flagHighOffset;
  const flagLow = poleTop - flagLowOffset;
  s.flag(6, flagHigh, flagLow);
  s.push(s.lastClose(), flagHigh + breakoutOffset, { high: flagHigh + breakoutOffset + 10 });
  return s.candles;
}

function stampAt(candles, stepMs, startTs) {
  return candles.map((c, i) => ({ ...c, timestamp: startTs + i * stepMs, closeTime: startTs + (i + 1) * stepMs }));
}

function emaLocal(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Running T-20 HTF entry rule tests...\n');

  console.log('meta / wrapper identity');

  await test('meta: id/tf/holdMaxHours/stopKind', () => {
    assertEqual(meta.id, 'htf-entry-1m');
    assertEqual(meta.tf, '1m');
    assertEqual(meta.holdMaxHours, 72);
    assertEqual(HOLD_MAX_HOURS, 72);
    assertEqual(meta.stopKind, 'structure');
  });

  await test('scripts/swing/rules/htf-entry-1m.js re-exports lib/htfEntryRule.js unchanged (same precedent as re-flag-retest-1h.js)', () => {
    assertEqual(htfEntry1m.meta.id, meta.id);
    assertEqual(htfEntry1m.signalAt, signalAt, 'the SAME function reference, not a copy');
  });

  console.log('\ndirection: 4h+1D EMA21/EMA200 stack');

  await test('htfDirectionAt: long when both 4h and 1D stacks are bull and price > EMA21(4h)', () => {
    const end = 1_735_000_000_000;
    const c4h = drift(230, 'up', end, H4_MS);
    const c1d = drift(230, 'up', end, DAY_MS);
    assertEqual(htfDirectionAt({ candles4h: c4h, candles1d: c1d }), 'long');
  });

  await test('htfDirectionAt: short mirrors long on a negated series', () => {
    const end = 1_735_000_000_000;
    const c4h = negate(drift(230, 'up', end, H4_MS));
    const c1d = negate(drift(230, 'up', end, DAY_MS));
    assertEqual(htfDirectionAt({ candles4h: c4h, candles1d: c1d }), 'short');
  });

  await test('htfDirectionAt: null when the two timeframes disagree, or on insufficient history', () => {
    const end = 1_735_000_000_000;
    const bull4h = drift(230, 'up', end, H4_MS);
    const bear1d = drift(230, 'down', end, DAY_MS);
    assertEqual(htfDirectionAt({ candles4h: bull4h, candles1d: bear1d }), null, 'disagreement -> null');
    assertEqual(htfDirectionAt({ candles4h: drift(50, 'up', end, H4_MS), candles1d: drift(230, 'up', end, DAY_MS) }), null, 'short 4h history -> null');
    assertEqual(htfDirectionAt({ candles4h: null, candles1d: null }), null);
  });

  await test('emaStackAt: null under MIN_STACK_CANDLES, a real stack otherwise', () => {
    assertEqual(emaStackAt(drift(EMA_SLOW_PERIOD - 1, 'up', 1_735_000_000_000, H1_MS)), null);
    const s = emaStackAt(drift(EMA_SLOW_PERIOD + 10, 'up', 1_735_000_000_000, H1_MS));
    assert(s && Number.isFinite(s.ema21) && Number.isFinite(s.ema200) && Number.isFinite(s.close), 'a real stack read');
  });

  console.log('\ntrigger: 1m/5m/3m boundary alignment + flag reaching triggering');

  await test('closesAt: 1m always true; 5m/3m only on an aligned close time', () => {
    assertEqual(closesAt('1m', 12345), true);
    assertEqual(closesAt('5m', 300000), true);
    assertEqual(closesAt('5m', 300001), false);
    assertEqual(closesAt('3m', 180000), true);
    assertEqual(closesAt('3m', 180001), false);
    assertEqual(closesAt('4h', 0), false, 'unknown tf -> false, never throws');
  });

  await test('checkHtfTrigger: fires on the exact breakout candle (ageCandles 0, state triggering) in the given direction', () => {
    const rawFlag = buildFlagBreakout(21);
    const startTs = 1_735_000_000_000 - rawFlag.length * M1_MS;
    const oneM = stampAt(rawFlag, M1_MS, startTs);
    const emaHist = emaLocal(oneM.map((c) => c.close), EMA_FAST_PERIOD);
    const direct = detectFlagLifecycle({ candles: oneM, ema21History: emaHist }, 'long');
    assert(direct && direct.candidate.state === 'triggering' && direct.candidate.ageCandles === 0, 'fixture sanity: fires on the research detector directly');

    const cutMs = oneM[oneM.length - 1].closeTime;
    const trigger = checkHtfTrigger({ candlesByTf: { '1m': oneM, '5m': [] }, direction: 'long', cutMs });
    assert(trigger, 'fires');
    assertEqual(trigger.tf, '1m');
    assertEqual(trigger.entry, oneM[oneM.length - 1].close);

    assertEqual(checkHtfTrigger({ candlesByTf: { '1m': oneM, '5m': [] }, direction: 'short', cutMs }), null, 'wrong direction -> null');
  });

  await test('checkHtfTrigger: a 5m candidate is only checked on a 5m-aligned close', () => {
    const rawFlag = buildFlagBreakout(22);
    // Align the fixture so its last candle's closeTime is itself a 5m boundary.
    const alignedEnd = Math.floor(1_735_000_000_000 / 300000) * 300000;
    const fiveM = stampAt(rawFlag, 300000, alignedEnd - rawFlag.length * 300000);
    const cutMs = fiveM[fiveM.length - 1].closeTime;
    assertEqual(cutMs % 300000, 0, 'fixture sanity: aligned');
    const firedAligned = checkHtfTrigger({ candlesByTf: { '1m': [], '5m': fiveM }, tfs: ['5m'], direction: 'long', cutMs });
    assert(firedAligned, '5m trigger fires on an aligned close');
    const firedUnaligned = checkHtfTrigger({ candlesByTf: { '1m': [], '5m': fiveM }, tfs: ['5m'], direction: 'long', cutMs: cutMs + 60000 });
    assertEqual(firedUnaligned, null, 'the SAME 5m array, one minute later (unaligned) - no re-fire');
  });

  console.log('\n1h swing anchor + impulse-projected target');

  await test('swingAnchorAndTarget: anchor = newest confirmed pivot, target = anchor + impulse leg into it', () => {
    const { candles, swingHighVal, swingLowVal } = buildOneHSwingFixture();
    const swing = swingAnchorAndTarget(candles, 'long');
    assert(swing, 'a swing was found');
    assertClose(swing.anchor.price, swingLowVal, 1, 'anchor is the pullback low');
    assertClose(swing.target, swingHighVal, 5, 'target reconstructs the prior high (symmetric leg)');
  });

  await test('swingAnchorAndTarget: mirrors exactly on a negated series (short)', () => {
    const { candles } = buildOneHSwingFixture();
    const long = swingAnchorAndTarget(candles, 'long');
    const short = swingAnchorAndTarget(negate(candles), 'short');
    assert(long && short, 'both found');
    assertClose(short.anchor.price, -long.anchor.price, 1e-6);
    assertClose(short.target, -long.target, 1e-6);
    assertClose(short.impulseHeight, long.impulseHeight, 1e-6);
  });

  await test('swingAnchorAndTarget: null with no pivots on either side', () => {
    assertEqual(swingAnchorAndTarget([], 'long'), null);
    assertEqual(swingAnchorAndTarget(drift(10, 'up', 1_735_000_000_000, H1_MS), 'long'), null, 'too few candles for a confirmed pivot');
  });

  console.log('\nstop: NF floor, 3% scalp cap (rejection, never a clamp), exact stop side');

  await test('htfStop: long stop below entry, short above - even after NF widening', () => {
    const longStop = htfStop({ direction: 'long', entry: 89700, anchorPrice: 89640, atr1h: 300, atr15m: 100 });
    assert(longStop < 89700, 'long stop stays below entry');
    const shortStop = htfStop({ direction: 'short', entry: 89700, anchorPrice: 89760, atr1h: 300, atr15m: 100 });
    assert(shortStop > 89700, 'short stop stays above entry');
  });

  await test('stopWithinScalpCap: exact 3% boundary, direction-agnostic', () => {
    assertEqual(stopWithinScalpCap(100, 97), true, 'exactly 3% passes');
    assertEqual(stopWithinScalpCap(100, 96.99), false, 'just over 3% fails');
    assertEqual(stopWithinScalpCap(100, 103), true, 'a short-side 3% also passes');
  });

  await test('stopPct: percent distance, direction-agnostic, null on bad input', () => {
    assertEqual(stopPct(100, 99), 1);
    assertEqual(stopPct(100, 101), 1);
    assertEqual(stopPct(0, 99), null);
    assertEqual(stopPct(100, null), null);
  });

  console.log('\nR:R gates');

  await test('grossRR: long/short target-ahead + positive-risk gate', () => {
    assertEqual(grossRR('long', 100, 99, 103), 3);
    assertEqual(grossRR('short', 100, 101, 97), 3);
    assertEqual(grossRR('long', 100, 99, 98), null, 'target behind entry -> null');
    assertEqual(grossRR('long', 100, 100, 103), null, 'zero risk -> null');
  });

  console.log('\nbuildHtfPlan: full gate chain');

  await test('buildHtfPlan: ready end-to-end (fixture-verified numbers)', () => {
    const { candles } = buildOneHSwingFixture();
    const entry = 89700;
    const plan = buildHtfPlan({ direction: 'long', entry, candles1h: candles, atr1h: 300, atr15m: 100, geometry1h: null, geometry4h: null });
    assertEqual(plan.status, 'ready');
    assertEqual(plan.reasonCode, null);
    assert(plan.stop < entry, 'long stop below entry');
    assertClose(plan.stopPct, 1.02, 0.05);
    assert(plan.grossRR >= MIN_GROSS_RR, `gross ${plan.grossRR} >= ${MIN_GROSS_RR}`);
    assert(plan.netRR >= MIN_NET_RR, `net ${plan.netRR} >= ${MIN_NET_RR}`);
    assertClose(plan.tp1, 92090, 1);
  });

  await test('buildHtfPlan: rejects rr_below_min without moving the stop closer to pass', () => {
    const { candles } = buildOneHSwingFixture();
    const entry = 89960; // farther from the anchor than the 'ready' fixture -> lower gross R
    const plan = buildHtfPlan({ direction: 'long', entry, candles1h: candles, atr1h: 300, atr15m: 100, geometry1h: null, geometry4h: null });
    assertEqual(plan.status, 'rejected');
    assertEqual(plan.reasonCode, 'rr_below_min');
    assert(plan.stop < entry, 'stop is still on the correct side, never adjusted to force a pass');
  });

  await test('buildHtfPlan: stop_exceeds_scalp_cap rejects rather than clamping the stop to 3%', () => {
    const { candles } = buildOneHSwingFixture();
    // Shrink the price scale (/100) but keep the SAME absolute ATRs - the NF floor (priced
    // in ATR/entry terms) now dwarfs the entry price, blowing well past the 3% cap.
    const scaledCandles = candles.map((c) => ({ ...c, open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 }));
    const entry = 897; // ~ the scaled continuation price (89700 / 100)
    const plan = buildHtfPlan({ direction: 'long', entry, candles1h: scaledCandles, atr1h: 300, atr15m: 100, geometry1h: null, geometry4h: null });
    assertEqual(plan.status, 'rejected');
    assertEqual(plan.reasonCode, 'stop_exceeds_scalp_cap');
    assert(plan.stopPct > 3, 'the rejected stop distance is genuinely over the cap, not silently trimmed to it');
  });

  await test('buildHtfPlan: no_1h_swing when there is no confirmed pivot', () => {
    const plan = buildHtfPlan({ direction: 'long', entry: 100, candles1h: [], atr1h: 1, atr15m: 1, geometry1h: null, geometry4h: null });
    assertEqual(plan.status, 'rejected');
    assertEqual(plan.reasonCode, 'no_1h_swing');
  });

  await test('buildHtfPlan: tp2 is the next 1h/4h zone strictly ahead of tp1, when supplied', () => {
    const { candles } = buildOneHSwingFixture();
    const entry = 89700;
    const geometry1h = { horizontalResistanceZones: [{ low: 93000, high: 93100 }], horizontalSupportZones: [] };
    const withZone = buildHtfPlan({ direction: 'long', entry, candles1h: candles, atr1h: 300, atr15m: 100, geometry1h, geometry4h: null });
    assertEqual(withZone.status, 'ready');
    assertEqual(withZone.tp2, 93000);
    const noZone = buildHtfPlan({ direction: 'long', entry, candles1h: candles, atr1h: 300, atr15m: 100, geometry1h: null, geometry4h: null });
    assertEqual(noZone.tp2, null);
  });

  console.log('\nhtfStructureHoldRule');

  await test('htfStructureHoldRule: n=1 one-sided band on the safe side of structureStop, mirrored by direction', () => {
    const long = htfStructureHoldRule(89610, 'long');
    assertEqual(long.insideHigh, 89610);
    assertEqual(long.insideLow, -Infinity);
    assertEqual(long.n, 1);
    const short = htfStructureHoldRule(89610, 'short');
    assertEqual(short.insideLow, 89610);
    assertEqual(short.insideHigh, Infinity);
  });

  console.log('\ncandidateId helpers');

  await test('htfCandidateId / isHtfCandidateId: stable, prefix-scoped', () => {
    const id = htfCandidateId('BTC', '5m', 'long', '2026-09-27T15:05:00.000Z');
    assertEqual(id, 'htf_BTC_5m_long_2026-09-27T15:05:00.000Z');
    assert(isHtfCandidateId(id));
    assert(!isHtfCandidateId('retest1h_BTC_2026-09-27T15:00:00.000Z'), 'never matches another family\'s id');
    assert(!isHtfCandidateId(null) && !isHtfCandidateId(undefined));
  });

  console.log('\nsignalAt: end-to-end + no lookahead');

  function buildFullCtx({ flagSeed = 21, includeExtraFuture = false } = {}) {
    const end = 1_735_000_000_000;
    const c4h = drift(230, 'up', end, H4_MS);
    const c1d = drift(230, 'up', end, DAY_MS);
    const { candles: c1h } = buildOneHSwingFixture(end - 400 * H1_MS);

    // Tuned so the 1m breakout entry lands inside the swing fixture's 'ready' window
    // (anchor 89640, target 92090 - see buildOneHSwingFixture): level 89600, a small pole
    // (poleStep 8, proportionally smaller flag/breakout offsets, tight wobble) lands the
    // trigger's entry close to ~89650 (hand-verified against buildHtfPlan directly).
    const rawFlag = buildFlagBreakout(flagSeed, { level: 89600, poleStep: 8, flagHighOffset: 3, flagLowOffset: 30, breakoutOffset: 6, wobble: 0.2 });
    const oneMEnd = end;
    const oneM = stampAt(rawFlag, M1_MS, oneMEnd - rawFlag.length * M1_MS);
    const cutMs = oneM[oneM.length - 1].closeTime;

    const candlesByTf = { '1m': oneM, '5m': [], '4h': c4h, '1d': c1d, '1h': c1h };
    const geometry = { '1h': { atr: 300, horizontalSupportZones: [], horizontalResistanceZones: [] }, '4h': null, '15m': { atr: 100 } };
    let candlesByTfFull = candlesByTf;
    if (includeExtraFuture) {
      const future = oneM.concat([{ ...oneM[oneM.length - 1], timestamp: cutMs, closeTime: cutMs + M1_MS, close: oneM[oneM.length - 1].close + 99999 }]);
      candlesByTfFull = { ...candlesByTf, '1m': future };
    }
    return { ctx: { i: oneM.length - 1, candlesByTf: candlesByTfFull, geometry }, cutMs };
  }

  await test('signalAt: fires a ready signal when direction + trigger + plan all align', () => {
    const { ctx } = buildFullCtx({ flagSeed: 21 });
    const sig = signalAt(ctx);
    assert(sig, 'a signal fired');
    assertEqual(sig.direction, 'long');
    assert(sig.stop < sig.entry, 'long stop below entry');
    assert(sig.tp1 > sig.entry, 'tp1 ahead of entry');
    assert(Array.isArray(sig.reason) && sig.reason.length >= 3, 'reason trail present');
    assert(sig.holdRule && sig.holdRule.n === 1, 'structure holdRule attached');
  });

  await test('signalAt: null on bad ctx, missing 1m data, or index out of range - never throws', () => {
    assertEqual(signalAt(null), null);
    assertEqual(signalAt({}), null);
    assertEqual(signalAt({ i: 0, candlesByTf: { '1m': [] } }), null);
    assertEqual(signalAt({ i: 999, candlesByTf: { '1m': [{ timestamp: 0, closeTime: 60000, open: 1, high: 1, low: 1, close: 1 }] } }), null, 'i past the array end');
  });

  await test('signalAt: no lookahead - candles appended AFTER index i never change the result', () => {
    const { ctx } = buildFullCtx({ flagSeed: 23 });
    const base = signalAt(ctx);
    const { ctx: futureCtx } = buildFullCtx({ flagSeed: 23, includeExtraFuture: true });
    // futureCtx.i still points at the SAME original last-real-candle index (not the appended one).
    futureCtx.i = ctx.i;
    const withFuture = signalAt(futureCtx);
    assertEqual(JSON.stringify(withFuture), JSON.stringify(base), 'appending a future candle past i must not change signalAt\'s output at i');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
}

main();
