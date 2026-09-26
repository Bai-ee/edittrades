/**
 * Plain-language story for a tracked flag (Telegram TRACK messages).
 *
 * Every tracked message answers four questions in everyday words:
 *   now    - what price is doing at the trigger (incl. how many pokes through it failed)
 *   wait   - what has to happen next, and roughly how long until the next check
 *   line   - the level that must not break (void before entry, stop/TP1 in a trade)
 *   next   - the most likely path (pathOutlook) and where a failure usually goes
 *
 * Probe counting is tracker-side and observe-only: each cron tick samples the last
 * closed 1m price against the trigger. A close past the trigger that later comes back
 * counts as one rejected probe. No wick data reaches the payload, so this undercounts
 * wick-only pokes; it never changes a signal, gate or plan.
 *
 * Pure: no I/O, no clock. Returns plain strings; the caller escapes for HTML.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Minimum gap between two story updates for the same tracked flag. */
export const STORY_MIN_GAP_MS = 3 * 60_000;
/** A quiet "still waiting" check-in after this long without any message. */
export const STORY_HEARTBEAT_MS = 15 * 60_000;

const PATH_PLAIN = Object.freeze({
  retest_go: 'breaks, comes back to test the level, then goes',
  runner: 'breaks and runs without looking back',
  false_break: 'breaks, then snaps back (a fake-out)',
  fail_first: 'fails before it ever breaks',
  chop: 'chops sideways and goes nowhere'
});

/** Engine fail reasons -> what actually happened, in trader words. */
export function failWords(reason, direction) {
  const buyers = direction === 'short';
  switch (reason) {
    case 'acceptance_above': return 'Buyers pushed price back above the level and held it there. The short idea is dead.';
    case 'acceptance_below': return 'Sellers pushed price back below the level and held it there. The long idea is dead.';
    case 'invalidation_close': return `A candle closed past the void level, so the pattern broke. ${buyers ? 'Buyers' : 'Sellers'} won this one.`;
    case 'stale': return 'The break never followed through in time, so the setup went stale.';
    default: return 'The flag failed.';
  }
}

/**
 * Advance the probe memory one tick. mem = {probes, beyond, extreme}.
 * beyond = the last sampled close sat past the trigger (below it for a short).
 */
export function updateProbes(mem, { price, trigger, direction }) {
  const m = { probes: 0, beyond: false, extreme: null, ...(isObj(mem) ? mem : {}) };
  if (!isNum(price) || !isNum(trigger)) return m;
  const short = direction === 'short';
  const past = short ? price < trigger : price > trigger;
  if (past) {
    m.extreme = isNum(m.extreme) ? (short ? Math.min(m.extreme, price) : Math.max(m.extreme, price)) : price;
    m.beyond = true;
  } else if (m.beyond) {
    m.probes += 1;
    m.beyond = false;
  }
  return m;
}

/** Nearest geometry zone on the far side of price for a failed flag (where failure runs to). */
export function failureZone(geometryContext, direction, price) {
  if (!isObj(geometryContext) || !isNum(price)) return null;
  const up = direction === 'short';
  const zones = [];
  for (const tf of ['15m', '1h']) {
    const g = geometryContext[tf];
    if (!isObj(g)) continue;
    const add = (arr, kind) => (Array.isArray(arr) ? arr : []).forEach((z) => {
      if (isObj(z) && isNum(z.low) && isNum(z.high)) zones.push({ low: z.low, high: z.high, tf, kind });
    });
    add(g.confluenceZones, 'confluence');
    add(g.horizontalSupportZones, 'zone');
    add(g.horizontalResistanceZones, 'zone');
  }
  const ahead = zones.filter((z) => (up ? z.low > price : z.high < price));
  if (!ahead.length) return null;
  ahead.sort((a, b) => (up ? a.low - b.low : b.high - a.high) || (a.kind === 'confluence' ? -1 : 1));
  return ahead[0];
}

const isCounterTrend = (rec) => {
  const codes = isObj(rec) ? [...(rec.opposes || []), ...(rec.supports || [])].map((x) => (isObj(x) ? x.code : x)) : [];
  return codes.some((c) => /^(ct:4h|4h:counter)/.test(String(c)));
};

/**
 * Story lines for a tracked flag that is not in a trade yet.
 * @param {Object} a - {symbol, tf, direction, state, trigger, voidLevel, price, probes, extreme, etaMin, path, geometryContext, rec, fmt}
 * @returns {{now:string, wait:string, line:string, next:string|null}}
 */
export function watchStory(a) {
  const f = a.fmt || ((v) => String(v));
  const short = a.direction === 'short';
  const word = short ? 'short' : 'long';
  const trig = f(a.trigger);
  const past = isNum(a.price) && isNum(a.trigger) && (short ? a.price < a.trigger : a.price > a.trigger);

  const nowParts = [];
  if (isNum(a.price) && isNum(a.trigger)) {
    nowParts.push(past
      ? `Price ${f(a.price)} is ${short ? 'under' : 'over'} the trigger ${trig} right now.`
      : `Price ${f(a.price)}, ${(Math.abs(a.price - a.trigger) / a.trigger * 100).toFixed(2)}% ${short ? 'above' : 'below'} the trigger ${trig}.`);
  }
  if (a.probes > 0) {
    const who = short ? 'buyers' : 'sellers';
    const verb = short ? 'dipped under' : 'poked above';
    const back = short ? 'pushed back up' : 'pushed back down';
    nowParts.push(`It ${verb} ${trig} ${a.probes}× and got ${back} every time: ${who} are defending it.${a.probes >= 2 ? ` Each failed push makes the ${word} weaker.` : ''}`);
  }
  if (isCounterTrend(a.rec)) nowParts.push(`This ${word} goes against the 4h trend, so it needs extra proof.`);

  const side = short ? 'below' : 'above';
  const eta = isNum(a.etaMin) ? ` Next ${a.tf} close in ~${a.etaMin} min.` : '';
  let wait;
  if (a.state === 'triggering') wait = `The break is on. Wait for price to come back to ${trig} and hold ${side} it. Don't chase.${eta}`;
  else if (a.state === 'confirmed') wait = `Break confirmed. Enter only on a retest of ${trig} that holds ${side}.${eta}`;
  else wait = `Wait for a ${a.tf} candle to CLOSE ${side} ${trig}${a.probes > 0 && isNum(a.extreme) ? ` (better: past ${f(a.extreme)}, the poke low that failed)` : ''}, then a retest that holds. A wick through doesn't count.${eta}`;

  const line = isNum(a.voidLevel)
    ? `A close ${short ? 'above' : 'below'} ${f(a.voidLevel)} kills the ${word} idea. If that happens, walk away.`
    : 'No void level on this flag.';

  const nextParts = [];
  const w = isObj(a.path) && isObj(a.path.w) ? a.path.w : null;
  if (w) {
    const [top, pct] = Object.entries(w).sort((x, y) => y[1] - x[1])[0] || [];
    if (top && PATH_PLAIN[top]) nextParts.push(`Most likely it ${PATH_PLAIN[top]} (${pct}% of similar flags).`);
  }
  const fz = failureZone(a.geometryContext, a.direction, a.price);
  if (fz) nextParts.push(`If it fails, price usually heads to ${f(fz.low)}–${f(fz.high)} (${fz.tf} ${fz.kind === 'confluence' ? 'confluence' : 'zone'}).`);
  return { now: nowParts.join(' '), wait, line, next: nextParts.length ? nextParts.join(' ') : null };
}

/**
 * Story lines for a tracked trade that is live (plan was ready, or Took it).
 * @param {Object} a - {tf, direction, entry, stop, tp1, price, r, fmt}
 */
export function tradeStory(a) {
  const f = a.fmt || ((v) => String(v));
  const short = a.direction === 'short';
  const rTxt = isNum(a.r) ? `${a.r >= 0 ? '+' : ''}${Math.round(a.r * 100) / 100}R` : 'n/a';
  const now = isNum(a.price) ? `In the trade. Price ${f(a.price)}, ${rTxt} from entry ${f(a.entry)}.` : 'In the trade. No live price right now.';
  let wait = `Let it work. TP1 is ${f(a.tp1)}.`;
  if (isNum(a.r) && a.r >= 0.8) wait = `Close to TP1 ${f(a.tp1)}. Be ready to take profit or move the stop to entry.`;
  else if (isNum(a.r) && a.r <= -0.6) wait = `Getting close to the stop. Don't widen it; let the stop do its job.`;
  const line = `Stop ${f(a.stop)}. Price ${short ? 'above' : 'below'} it means you're out.`;
  return { now, wait, line, next: null };
}

/** The four sections as plain text lines (caller escapes). */
export function storyText(st) {
  return [
    `📍 ${st.now}`,
    `⏳ ${st.wait}`,
    `🚫 ${st.line}`,
    st.next ? `🔮 ${st.next}` : null
  ].filter(Boolean).filter((l) => l.trim().length > 2);
}

/** R-bucket (0.5R steps) for a live trade: a change is worth a message. */
export const rBucket = (r) => (isNum(r) ? Math.floor(r * 2) / 2 : null);
