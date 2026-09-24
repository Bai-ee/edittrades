/**
 * Phase 2 (recommendation completeness) fixture set: one pinned-clock case per item in
 * the decision-clarity acceptance list (docs/MASTER_PLAN_NEXT_STEPS.md Phase 2), mirrored
 * long/short where the case has a direction. Each asserts class, primaryReason code, the
 * specific support/oppose/unknown codes, the changeConditions text, and byte-stable output.
 *
 * Labels: `owner` = maps directly to an owner-answered decision
 * (docs/OWNER_DECISIONS_2026-09-23.md, incl. "Not asked (decided by you earlier)");
 * `provisional` = implementer interpretation, not yet owner-confirmed.
 *
 * Run: node test-flag-recommendation-fixtures.js
 */

import { buildFlagRecommendation, compactRecommendation } from './lib/flagRecommendation.js';
import { INTERVAL_MS } from './services/scalpContext.js';

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Pinned clock: every record is built at this instant with fresh 1m/3m/5m closes.
const AS_OF = '2026-09-23T12:00:00.000Z';
const NOW_MS = Date.parse(AS_OF);
const DIRS = ['long', 'short'];

/** Mirror a long-side price around 1000 for the short case. */
const mir = (dir, p) => (dir === 'long' ? p : 2000 - p);
const withSent = (dir) => (dir === 'long' ? 'bull' : 'bear');
const againstSent = (dir) => (dir === 'long' ? 'bear' : 'bull');
const withSide = (dir) => (dir === 'long' ? 'above' : 'below');
const againstSide = (dir) => (dir === 'long' ? 'below' : 'above');

function freshness(over = {}) {
  return ['1m', '3m', '5m'].map((tf) => ({ tf, closedThroughIso: over[tf] === undefined ? AS_OF : over[tf], intervalMs: INTERVAL_MS[tf], graceMs: 5000 }));
}

function candidate(dir, over = {}) {
  return {
    candidateId: `BTC:1m:${dir}:2026-09-23T11:50:00.000Z`,
    timeframe: '1m',
    type: 'flag',
    direction: dir,
    state: 'confirmed',
    confidence: 82,
    breakoutLevel: 1000,
    invalidation: mir(dir, 990),
    measuredTarget: mir(dir, 1040),
    measuredRR: 4,
    ema200Side: withSide(dir),
    qual: { quality: 'high', decision: 'actionable', reasons: [] },
    ...over
  };
}

function plan(dir, over = {}) {
  return {
    candidateId: `BTC:1m:${dir}:2026-09-23T11:50:00.000Z`,
    planId: `BTC:1m:${dir}:2026-09-23T11:50:00.000Z|${AS_OF}|TEST`,
    timeframe: '1m',
    direction: dir,
    status: 'ready',
    reasonCode: null,
    entryType: 'retest',
    entryCondition: `a closed candle closes ${dir === 'long' ? 'above' : 'below'} 1000, then a later closed candle retests it and holds`,
    entry: 1000,
    stop: mir(dir, 990),
    tp1: mir(dir, 1040),
    tp2: null,
    grossRR: 4,
    netRR: 3.2,
    stopDistancePct: 1,
    ...over
  };
}

/** 15m geometry with the first level ahead at 1050 (long) / 950 (short), beyond the 1040/960 target. */
function geometry(dir, { zoneAt = 1050, channel = null } = {}) {
  const lo = mir(dir, zoneAt);
  const zone = dir === 'long' ? { low: lo, high: lo + 5 } : { low: lo - 5, high: lo };
  return {
    '15m': {
      horizontalResistanceZones: dir === 'long' ? [zone] : [],
      horizontalSupportZones: dir === 'short' ? [zone] : [],
      confluenceZones: [],
      channel
    }
  };
}

function topDown(dir, over = {}) {
  const s = withSent(dir);
  return {
    sentiment: s,
    aligned: 4,
    score: dir === 'long' ? 1 : -1,
    leans: { '1w': s, '1d': s, '4h': s, '1h': s },
    weekly: { bias: s, close: 1000, ema21: mir(dir, 950), ema21Slope: 3, ema200: null, reason: 'insufficient history for weekly EMA200' },
    above200: { count: dir === 'long' ? 5 : 2, of: 7, weighted: 0.6 },
    ...over
  };
}

function evidence(dir, over = {}) {
  return {
    flags: [{ candidateId: `BTC:1m:${dir}:2026-09-23T11:50:00.000Z`, timeframe: '1m', direction: dir, state: 'confirmed', confidence: 82 }],
    ma: { map: { '1m': { priceVsEma21: withSide(dir), priceVsEma200: withSide(dir), ema21: mir(dir, 998), ema200: mir(dir, 980) } }, pull: { direction: 'none' } },
    channels: { nearestLevelAhead: { timeframe: '15m', kind: dir === 'long' ? 'resistance_zone' : 'support_zone', price: mir(dir, 1050) }, levelsAhead: [], channels: {} },
    divergence: { confluence: dir === 'long' ? { bullish: 1, bearish: 0 } : { bullish: 0, bearish: 1 }, byTimeframe: {} },
    ...over
  };
}

function build(dir, { p = plan(dir), c = [candidate(dir)], ev = evidence(dir), td = topDown(dir), g = geometry(dir), fresh = freshness(), dataStatus = 'complete' } = {}) {
  return buildFlagRecommendation({
    symbol: 'BTC',
    asOf: AS_OF,
    dataStatus,
    flagTradePlan: p,
    evidence: ev,
    topDown: td,
    flagFreshness: fresh,
    now: NOW_MS,
    candidates: c,
    geometryContext: g
  });
}

/**
 * Build twice (byte-stable), compact, and check class / primary / codes / change text.
 * @returns {{full:Object, compact:Object}}
 */
function check(label, args, expect) {
  const a = build(args.dir, args);
  const b = build(args.dir, args);
  assertEqual(JSON.stringify(a), JSON.stringify(b), `${label}: byte-stable full record`);
  const compact = compactRecommendation(a);
  assertEqual(JSON.stringify(compact), JSON.stringify(compactRecommendation(b)), `${label}: byte-stable compact record`);
  assertEqual(compact.class, expect.class, `${label}: class`);
  assertEqual(compact.primaryReason.code, expect.primary, `${label}: primaryReason`);
  for (const k of ['supports', 'opposes', 'unknowns']) {
    for (const code of expect[k] || []) assert(compact[k].includes(code), `${label}: ${k} missing ${code}; got ${JSON.stringify(compact[k])}`);
  }
  for (const code of expect.absent || []) {
    assert(![...compact.supports, ...compact.opposes, ...compact.unknowns].includes(code), `${label}: ${code} must be absent`);
  }
  if (expect.change !== undefined) {
    const texts = compact.changeConditions.map((x) => x.text);
    const ok = expect.change instanceof RegExp ? texts.some((t) => expect.change.test(t)) : texts.includes(expect.change);
    assert(ok, `${label}: changeConditions ${JSON.stringify(texts)} vs ${expect.change}`);
  }
  return { full: a, compact };
}

async function run() {
  console.log('\nflagRecommendation acceptance fixtures (pinned clock)\n');

  // provisional: GOOD quality/bands are implementer defaults (owner item 3a: accepted, provisional).
  await test('aligned bull flag -> GOOD with full context cited', () => {
    check('long', { dir: 'long' }, {
      class: 'GOOD',
      primary: 'ready_flag_plan',
      supports: ['ready_flag_plan', 'rr_ok', 'td:bull:4/4', 'a200:5/7', 'ema200:1m:above', '4h:with', 'level:15m:1050', 'divergence_agrees', 'data_fresh'],
      unknowns: ['ema200:1w:missing'],
      change: /invalidates the plan at 990/
    });
  });

  // provisional: mirror of the aligned bull case.
  await test('aligned bear flag -> GOOD (mirror)', () => {
    check('short', { dir: 'short' }, {
      class: 'GOOD',
      primary: 'ready_flag_plan',
      supports: ['ready_flag_plan', 'rr_ok', 'td:bear:4/4', 'a200:2/7', 'ema200:1m:below', '4h:with', 'level:15m:950', 'divergence_agrees', 'data_fresh'],
      unknowns: ['ema200:1w:missing'],
      change: /invalidates the plan at 1010/
    });
  });

  // owner: "alignment never vetoes" (Not asked, decided earlier). Quality drop is provisional.
  await test('mixed top-down -> lower quality, conditional stays WATCH, ready is not vetoed (long + short)', () => {
    for (const dir of DIRS) {
      const mixed = topDown(dir, { sentiment: 'mixed', aligned: 2, leans: { '1w': withSent(dir), '1d': againstSent(dir), '4h': withSent(dir), '1h': againstSent(dir) } });
      const aligned = check(`${dir} aligned`, { dir }, { class: 'GOOD', primary: 'ready_flag_plan' });
      const ready = check(`${dir} mixed ready`, { dir, td: mixed }, { class: 'GOOD', primary: 'ready_flag_plan', opposes: ['td:mixed:2/4'] });
      assert(ready.full.trace.score < aligned.full.trace.score, `${dir}: mixed score ${ready.full.trace.score} < aligned ${aligned.full.trace.score}`);
      check(`${dir} mixed conditional`, { dir, td: mixed, p: plan(dir, { status: 'conditional', reasonCode: 'awaiting_retest' }) }, {
        class: 'WATCH', primary: 'entry_condition', opposes: ['td:mixed:2/4'], change: /then a later closed candle retests it and holds/
      });
    }
  });

  // owner: "EMA200 never filters" (Not asked, decided earlier).
  await test('short above EMA200 -> GOOD, EMA200 cited as oppose only', () => {
    const td = topDown('short', { above200: { count: 5, of: 7, weighted: 0.6 } });
    check('short', { dir: 'short', td, c: [candidate('short', { ema200Side: 'above' })] }, {
      class: 'GOOD', primary: 'ready_flag_plan', supports: ['td:bear:4/4'], opposes: ['ema200:1m:above', 'a200:5/7']
    });
  });

  // owner: "EMA200 never filters" (Not asked, decided earlier). Mirror of the short case.
  await test('long below EMA200 -> GOOD, EMA200 cited as oppose only', () => {
    const td = topDown('long', { above200: { count: 2, of: 7, weighted: 0.3 } });
    check('long', { dir: 'long', td, c: [candidate('long', { ema200Side: 'below' })] }, {
      class: 'GOOD', primary: 'ready_flag_plan', supports: ['td:bull:4/4'], opposes: ['ema200:1m:below', 'a200:2/7']
    });
  });

  // provisional: M-4 breakout-vs-rejection read is owner-stated, the risk bands are the implementer's.
  await test('channel-edge fade with high breakout risk -> oppose cited, class not vetoed (long + short)', () => {
    for (const dir of DIRS) {
      const channel = { top: 1100, bottom: 900, positionPct: dir === 'short' ? 90 : 10 };
      const td = topDown(dir, { sentiment: againstSent(dir), leans: { '1w': againstSent(dir), '1d': againstSent(dir), '4h': againstSent(dir), '1h': againstSent(dir) } });
      check(dir, { dir, td, g: geometry(dir, { channel }) }, {
        class: 'GOOD',
        primary: 'ready_flag_plan',
        opposes: [`chan:15m:${dir === 'short' ? 'top' : 'bottom'}:high`, `td:${againstSent(dir)}:4/4`, 'ct:4h']
      });
    }
  });

  // owner: item 4a (the candidate's own geometry timeframe) for the level cited.
  await test('measured target blocked by an earlier level -> TP1 capped, level cited (long + short)', () => {
    for (const dir of DIRS) {
      const p = plan(dir, { tp1: mir(dir, 1030), tp2: mir(dir, 1040), grossRR: 3, netRR: 2.1 });
      check(dir, { dir, p, g: geometry(dir, { zoneAt: 1030 }) }, {
        class: 'GOOD',
        primary: 'ready_flag_plan',
        supports: ['rr_ok', 'net_rr_ok'],
        opposes: [`tp1_capped:${mir(dir, 1030)}`, `level:15m:${mir(dir, 1030)}`]
      });
    }
  });

  // provisional: divergence detector is simplified (contract: implementation choice).
  await test('divergence agreement -> support (long + short)', () => {
    for (const dir of DIRS) {
      const ev = evidence(dir, { divergence: { confluence: dir === 'long' ? { bullish: 2, bearish: 0 } : { bullish: 0, bearish: 2 }, byTimeframe: {} } });
      check(dir, { dir, ev }, { class: 'GOOD', primary: 'ready_flag_plan', supports: ['divergence_agrees'], absent: ['divergence_conflicts', 'divergence_absent'] });
    }
  });

  // provisional: conflict is an oppose, never a veto (M-7 owner-stated; detector provisional).
  await test('divergence conflict -> oppose, class unchanged (long + short)', () => {
    for (const dir of DIRS) {
      const ev = evidence(dir, { divergence: { confluence: dir === 'long' ? { bullish: 0, bearish: 1 } : { bullish: 1, bearish: 0 }, byTimeframe: {} } });
      check(dir, { dir, ev }, { class: 'GOOD', primary: 'ready_flag_plan', opposes: ['divergence_conflicts'], absent: ['divergence_agrees'] });
    }
  });

  // provisional: weekly EMA200 is never guessed; unknown never improves or lowers the class.
  await test('missing weekly EMA200 -> unknown, class and quality unchanged (long + short)', () => {
    for (const dir of DIRS) {
      const missing = check(`${dir} missing`, { dir }, { class: 'GOOD', primary: 'ready_flag_plan', unknowns: ['ema200:1w:missing'] });
      const known = check(`${dir} known`, { dir, td: topDown(dir, { weekly: { ...topDown(dir).weekly, ema200: 800, reason: null } }) }, { class: 'GOOD', primary: 'ready_flag_plan', absent: ['ema200:1w:missing'] });
      assertEqual(missing.compact.qualityBand, known.compact.qualityBand, `${dir}: quality band unchanged`);
      assertEqual(missing.full.trace.score, known.full.trace.score, `${dir}: score unchanged`);
    }
  });

  // provisional: review fix 5 behavior (no owner item).
  await test('stale 1m with no plan -> DATA_UNAVAILABLE naming 1m, no candidate named', () => {
    const { compact } = check('stale', { dir: 'long', p: null, fresh: freshness({ '1m': '2026-09-23T11:50:00.000Z' }) }, {
      class: 'DATA_UNAVAILABLE',
      primary: 'stale_data:1m',
      unknowns: ['stale_data:1m', 'td:bull:4/4'],
      absent: ['data_fresh'],
      change: 'Refresh 1m closed candles and rebuild.'
    });
    assertEqual(compact.unknowns[0], 'stale_data:1m', 'stale timeframe listed first');
    assertEqual(compact.candidate, null, 'no candidate named on stale candles');
  });

  // owner: item 2a (breakout close, then one holding retest close = ready).
  await test('flag forming but unconfirmed -> WATCH naming the candidate and its exact trigger (long + short)', () => {
    for (const dir of DIRS) {
      const b = 84466.1;
      const inv = dir === 'long' ? 84300 : 84632.2;
      const forming = candidate(dir, { candidateId: `BTC:3m:${dir}:2026-09-23T11:30:00.000Z`, timeframe: '3m', state: 'forming', confidence: 70, breakoutLevel: b, invalidation: inv, measuredTarget: null, measuredRR: 3.5, ema200Side: withSide(dir) });
      const proto = candidate(dir, { candidateId: `BTC:1m:${dir}:2026-09-23T11:55:00.000Z`, state: 'proto', confidence: 95 });
      const weaker = candidate(dir, { candidateId: `BTC:5m:${dir}:2026-09-23T11:00:00.000Z`, timeframe: '5m', state: 'forming', confidence: 60 });
      const { compact } = check(dir, { dir, p: null, c: [proto, weaker, forming], ev: evidence(dir, { flags: [] }) }, {
        class: 'WATCH',
        primary: 'need_confirmed_flag_plan',
        supports: [`candidate:3m-${dir}-forming`, `td:${withSent(dir)}:4/4`, 'ema200:3m:' + withSide(dir), 'data_fresh'],
        change: dir === 'long'
          ? '3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it'
          : '3m close below 84,466.10, then a retest that holds it, then plan ready; a close above 84,632.20 voids it'
      });
      assertEqual(JSON.stringify(compact.candidate), JSON.stringify({ candidateId: `BTC:3m:${dir}:2026-09-23T11:30:00.000Z`, timeframe: '3m', direction: dir, state: 'forming', breakout: b, invalidation: inv, measuredRR: 3.5 }), `${dir}: candidate named`);
      assertEqual(compact.candidateId, null, `${dir}: no plan candidateId`);
    }
  });

  // owner: item 1a (2.5R is gross price R to TP1, D-variant revised 2026-09-24).
  await test('valid geometry with gross < 2.5R floor -> BAD rr_below_min, reason first, remedy named (long + short)', () => {
    for (const dir of DIRS) {
      const p = plan(dir, { status: 'rejected', reasonCode: 'rr_below_min', tp1: mir(dir, 1025), grossRR: 2.4, netRR: 1.9 });
      const { compact } = check(dir, { dir, p }, {
        class: 'BAD',
        primary: 'rr_below_min',
        supports: [`td:${withSent(dir)}:4/4`],
        unknowns: ['ema200:1w:missing'],
        change: 'a flag whose measured move is >= 2.5R gross to TP1 (now 2.4R)'
      });
      assertEqual(compact.opposes[0], 'rr_below_min', `${dir}: disqualifying reason first`);
    }
  });

  // provisional: chase rejection is plan logic (no owner item); remedy text follows owner item 2a.
  await test('price past entry (chase) -> BAD chase with retest remedy (long + short)', () => {
    for (const dir of DIRS) {
      const p = plan(dir, { status: 'rejected', reasonCode: 'chase', entry: 2678.79, stop: dir === 'long' ? 2670 : 2687, tp1: null, grossRR: null, netRR: null });
      const c = [candidate(dir, { breakoutLevel: 2678.79, invalidation: dir === 'long' ? 2670 : 2687, measuredTarget: dir === 'long' ? 2710 : 2647, qual: { reasons: ['chase', 'conflict:5m-' + (dir === 'long' ? 'short' : 'long')] } })];
      const { compact } = check(dir, { dir, p, c, g: {} }, {
        class: 'BAD',
        primary: 'chase',
        opposes: ['chase', `conflict:5m-${dir === 'long' ? 'short' : 'long'}`],
        unknowns: ['level:none'],
        change: `wait for a 1m retest of 2,678.79 that holds ${dir === 'long' ? 'above' : 'below'} it`
      });
      assertEqual(compact.opposes[0], 'chase', `${dir}: disqualifying reason first`);
    }
  });

  // provisional: no-flag wording (no owner item).
  await test('no flag -> WATCH "must form", context undirected', () => {
    const { compact } = check('none', { dir: 'long', p: null, c: [], ev: evidence('long', { flags: [] }) }, {
      class: 'WATCH',
      primary: 'need_confirmed_flag_plan',
      unknowns: ['td:bull:4/4', 'a200:5/7', '4h:bull', 'divergence_undirected', 'ema200:1w:missing'],
      supports: ['data_fresh'],
      change: 'a 1m/3m/5m flag must form (none detected)'
    });
    assertEqual(compact.candidate, null, 'no candidate');
    assertEqual(compact.opposes.length, 0, 'nothing directional opposes without a candidate');
  });

  // provisional: remaining hard-rejection remedies, mirrored.
  await test('other rejection remedies are concrete (room_at_entry, stop cap, invalid_levels; long + short)', () => {
    for (const dir of DIRS) {
      const zone = dir === 'long' ? 'resistance' : 'support';
      check(`${dir} room`, { dir, p: plan(dir, { status: 'rejected', reasonCode: 'room_at_entry', tp1: null, grossRR: null }) }, {
        class: 'BAD', primary: 'room_at_entry', change: `a flag whose entry is clear of ${zone} (entry 1,000.00 sits inside a ${zone} zone)`
      });
      check(`${dir} cap`, { dir, p: plan(dir, { status: 'rejected', reasonCode: 'stop_distance_exceeds_cap', stopDistancePct: 3.4 }) }, {
        class: 'BAD', primary: 'stop_distance_exceeds_cap', change: 'a flag whose stop is within 3% of entry (now 3.4%)'
      });
      check(`${dir} levels`, { dir, p: plan(dir, { status: 'rejected', reasonCode: 'invalid_levels' }) }, {
        class: 'BAD', primary: 'invalid_levels', change: `a flag with its stop ${dir === 'long' ? 'below' : 'above'} and measured target ${dir === 'long' ? 'above' : 'below'} the breakout`
      });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
