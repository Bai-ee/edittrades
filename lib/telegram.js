/**
 * Telegram alerts + read commands (T-1, docs/PLAN_TELEGRAM.md).
 *
 * Three parts, all read-only toward the engine and never execution:
 *   1. Pure formatters: context payload -> Telegram HTML messages in the visual layout
 *      (dot + coin glyph + ▲/▼ header, rule-separated LEVELS / VERDICT / PLAN / CONTEXT,
 *      one bold verdict GET IN NOW | BE READY | WAIT | STAND DOWN), the Plan / Thesis
 *      cards, /positions (journal opens), /tracking and /market.
 *   2. Pure alert state machine (`diffAlerts`): previous `telegram/state.json` + a fresh
 *      compact payload -> the alerts to send and the next state. Dedup is by candidate id
 *      (a planId carries closedThrough, so it changes every candle and cannot dedup).
 *   3. A Bot API client (`createBotClient`): sendMessage / sendPhoto / sendMediaGroup, 5 s
 *      timeout per request.
 *      It never throws and never puts the token in a return value or a log line.
 *
 * One import only: lib/trackStory.js (pure, itself import-free), so nothing here can
 * reach a wallet, a signer or an execution path. There is no /buy, /sell, /open or
 * /close command, by design.
 */

import { watchStory, tradeStory, storyText, updateProbes, failWords, failureZone, rBucket, STORY_MIN_GAP_MS, STORY_HEARTBEAT_MS } from './trackStory.js';

export const TELEGRAM_STATE_PATH = 'telegram/state.json';
export const TELEGRAM_STATE_SCHEMA = 'telegram-state-1';
/**
 * Shape version of telegram/state.json. Every write stamps it; parseState migrates any
 * older or partial shape forward and never throws (a state an earlier deploy wrote must
 * never stop the cron). 1 = no stateVersion field (prefs may be missing); 2 = current.
 */
export const STATE_VERSION = 2;
/** Cron health (consecutive failures), a separate blob so a failing state write cannot block it. */
export const TELEGRAM_HEALTH_PATH = 'telegram/health.json';
/** The Nth consecutive cron failure sends ALERTS CRON FAILING; recovery after >= N sends RECOVERED. */
export const CRON_FAIL_ALERT_AFTER = 3;
/** While the cron keeps failing, the FAILING message repeats at most this often. */
export const CRON_FAIL_REPEAT_MS = 60 * 60_000;
export const TRACKER_URL = 'https://edittrades-tracker.vercel.app'; // same page as scripts/tracker/alerts.js PAGE_URL
export const MAX_MESSAGE_CHARS = 4000; // Telegram caps a message at 4096; keep headroom for entities
export const MAX_CAPTION_CHARS = 1000; // sendPhoto caption cap is 1024
export const SEND_TIMEOUT_MS = 5000;
/** A data or mark problem must persist this long before it alerts. */
export const HEALTH_PERSIST_MS = 5 * 60_000;
/** A data or mark alert repeats at most this often while the problem lasts. */
export const HEALTH_REPEAT_MS = 30 * 60_000;
/** closedThrough older than this counts as stale (1m candles plus slack). */
export const STALE_CLOSED_MS = 3 * 60_000;
/** The cron rewrites state for a heartbeat alone at most this often (Blob write budget). */
export const HEARTBEAT_WRITE_MS = 10 * 60_000;
/** Candidate ids remembered per symbol so a flickering GOOD/SETUP alerts once. */
export const RECENT_IDS = 20;
export const JOURNAL_DEFAULT_N = 10;
export const JOURNAL_MAX_N = 50;
/** Alert levels (owner pref in state.prefs.level). Health alerts always send. */
export const ALERT_LEVELS = Object.freeze(['good', 'setup', 'watch']);
export const DEFAULT_ALERT_LEVEL = 'setup';
const LEVEL_KINDS = {
  good: ['GOOD', 'GOOD_ENDED', 'BREAKOUT'],
  setup: ['GOOD', 'GOOD_ENDED', 'BREAKOUT', 'SETUP'],
  watch: ['GOOD', 'GOOD_ENDED', 'BREAKOUT', 'SETUP', 'WATCH', 'TRIGGERING']
};
/** Confirmed candidate ids remembered per symbol so each BREAKOUT alerts once. */
export const BREAKOUT_RECENT_IDS = 50;
/** Candidate states a WATCH alert fires on (never proto, failed, expired, confirmed). */
export const WATCH_STATES = Object.freeze(['forming', 'triggering']);
/** WATCH candidate ids remembered (rolling, all symbols). */
export const WATCH_RECENT_IDS = 200;
/** At most one WATCH alert per symbol this often (forming -> triggering passes once). */
export const WATCH_COOLDOWN_MS = 15 * 60_000;
/**
 * Alert signature memory (WATCH/TRIGGERING/BREAKOUT/SETUP): a forming flag re-detects
 * each candle with a new impulse-based candidateId, so ids alone let the same levels
 * re-alert. The same signature never re-alerts within this window; an escalation
 * (WATCH -> TRIGGERING -> BREAKOUT) and a SETUP pass once each.
 */
export const SIGNATURE_TTL_MS = 60 * 60_000;
/** Breakout levels closer than this fraction of price are the same flag (0.05%). */
export const SIGNATURE_TOLERANCE = 0.0005;
export const SIGNATURE_RECENT = 200;
/** Kinds already sent on a signature that suppress a new alert of each kind. */
const SIG_BLOCKED_BY = Object.freeze({
  WATCH: ['WATCH', 'TRIGGERING', 'BREAKOUT', 'SETUP'],
  TRIGGERING: ['TRIGGERING', 'BREAKOUT'],
  BREAKOUT: ['BREAKOUT'],
  SETUP: ['SETUP']
});
/** Gross R floor quoted in the short rr_below_min stand-down reason (engine minRR). */
const MIN_GROSS_RR = 2.5;
/** Scalp stop cap quoted in the short stop-distance stand-down reason. */
const MAX_STOP_PCT = 3;
/** Candle length per flag timeframe; same values as lib/flagRecommendation.js TF_MS (no imports here). */
const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
/** Quiet hours are owner-local wall clock, every day; alerts send silently, never dropped. */
export const QUIET_TIMEZONE = 'America/Chicago';
export const DEFAULT_QUIET_HOURS = Object.freeze({ start: 1, end: 5 });
/** Flag timeframes WATCH / TRIGGERING / BREAKOUT alert on (prefs.alertTimeframes; null = all). */
export const DEFAULT_ALERT_TIMEFRAMES = Object.freeze(['3m', '5m']);
export const ALERT_TIMEFRAME_CHOICES = Object.freeze(['1m', '3m', '5m', '15m', '1h']);

export const COMMANDS = Object.freeze(['start', 'help', 'menu', 'signals', 'why', 'flags', 'wallet', 'journal', 'status', 'chart', 'charts', 'log', 'testalert', 'alerts', 'tracking', 'positions', 'market',
  'order', 'confirm', 'stops', 'exec', 'kill', 'arm', 'mode']);
/** Persistent reply keyboard rows; each label maps to a command (parseMenuLabel). */
export const MENU_ROWS = Object.freeze([['Signals', 'Flags', 'Market'], ['Why BTC', 'Why ETH', 'Why SOL'], ['Charts', 'Wallet', 'Positions', 'Exec'], ['Journal', 'Status', 'Alerts', 'Tracking']]);
/** Tracked candidates kept at once (state.tracked). */
export const TRACK_MAX = 10;
/** A tracked candidate stops being tracked this long after the tap. */
export const TRACK_TTL_MS = 6 * 60 * 60_000;
/** A taken trade whose TP1 or stop was hit gets one close reminder after this long. */
export const NUDGE_AFTER_MS = 10 * 60_000;
/** Reply to a button whose ref resolves neither live nor in state. */
export const EXPIRED_REPLY = '[expired — send /signals]';
/** Timeframes offered by the Charts inline grid. */
export const CHART_GRID_TIMEFRAMES = Object.freeze(['1m', '3m', '5m', '15m', '1h']);
/** Telegram caps callback_data at 64 bytes. */
export const MAX_CALLBACK_BYTES = 64;
/** Alert plan snapshots kept in state for the Took it / Skipped buttons. */
export const BUTTON_MEMORY = 50;
/** The setWebhook `allowed_updates` value the bot needs (messages + button taps). */
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query']);
export const SYMBOLS = Object.freeze(['BTC', 'SOL', 'ETH']);
/** Flag states /flags charts (every live state; failed is excluded). */
export const LIVE_FLAG_STATES = Object.freeze(['proto', 'forming', 'triggering', 'confirmed', 'expired']);
/** Chart images one /flags call sends at most. */
export const MAX_FLAG_CHARTS = 9;
/** Bot API sendMediaGroup takes 2-10 items. */
export const MAX_MEDIA_GROUP = 10;
/** Per-image render budget for the /flags albums. */
export const FLAG_CHART_BUDGET_MS = 6000;
const TF_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- text helpers

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 84466.1 -> "$84,466.10"; small prices keep 4 decimals. Never locale-dependent. */
export function fmtPrice(value) {
  if (!isNum(value)) return 'n/a';
  const decimals = Math.abs(value) < 10 ? 4 : 2;
  const [int, dec] = Math.abs(value).toFixed(decimals).split('.');
  return `${value < 0 ? '-' : ''}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

const fmtR = (v) => (isNum(v) ? `${Math.round(v * 100) / 100}R` : 'n/a');

/** "2026-09-24T14:05:00.000Z" -> "14:05 UTC" (date kept when not today). */
export function fmtTime(iso, nowMs = null) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'n/a';
  const d = new Date(ms).toISOString();
  const sameDay = isNum(nowMs) && new Date(nowMs).toISOString().slice(0, 10) === d.slice(0, 10);
  return sameDay ? `${d.slice(11, 16)} UTC` : `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

/** Minutes/seconds since an ISO time, e.g. "3 min ago". */
export function fmtAge(iso, nowMs) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !isNum(nowMs)) return 'n/a';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * Split text into chunks of at most `max` chars, on line breaks where possible.
 * @returns {Array<string>}
 */
export function chunkMessage(text, max = MAX_MESSAGE_CHARS) {
  const out = [];
  let cur = '';
  for (const line of String(text || '').split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const next = cur ? `${cur}\n${rest}` : rest;
    if (next.length > max) { out.push(cur); cur = rest; } else cur = next;
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [''];
}

// ---------------------------------------------------------------- env + commands

/** "123, 456" -> ["123", "456"]; only digit ids survive. */
export function parseAllowedIds(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter((s) => /^-?\d{1,20}$/.test(s));
}

export function isAllowed(userId, allowed) {
  return userId !== undefined && userId !== null && allowed.includes(String(userId));
}

/**
 * "/chart@EditBot btc 5m" -> {cmd:'chart', args:['btc','5m'], rest:'btc 5m'}. Not a
 * command (no leading slash) -> null. Unknown command -> {cmd, known:false}.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const m = t.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  return { cmd, args: rest ? rest.split(/\s+/) : [], rest, known: COMMANDS.includes(cmd) };
}

/** Symbol argument -> "BTC" | null. Accepts btc, BTCUSDT, $btc. */
export function parseSymbol(arg) {
  const s = String(arg || '').toUpperCase().replace(/^\$/, '').replace(/(USDT|USD|PERP)$/, '');
  return SYMBOLS.includes(s) ? s : null;
}

/** /journal n -> 1..50, default 10. */
export function parseJournalN(arg) {
  const n = Number.parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 1) return JOURNAL_DEFAULT_N;
  return Math.min(n, JOURNAL_MAX_N);
}

/**
 * `/alerts` arguments -> an action. [] -> show; good|setup|watch -> level;
 * quiet -> show quiet; quiet off; quiet HH-HH (America/Chicago hours, start inclusive,
 * end exclusive, may wrap midnight). Anything else -> {action:'error', message}.
 */
export function parseAlertsArgs(args) {
  const a = (Array.isArray(args) ? args : []).map((x) => String(x).toLowerCase());
  const usage = 'Usage: /alerts · /alerts good|setup|watch · /alerts quiet [HH-HH|off] · /alerts tf 5m|3m,5m|all';
  if (!a.length) return { action: 'show' };
  if (a.length === 1 && ALERT_LEVELS.includes(a[0])) return { action: 'level', level: a[0] };
  if (a[0] === 'tf') {
    const tfs = parseAlertTimeframes(a.slice(1).join(','));
    return tfs === undefined ? { action: 'error', message: `Timeframes are ${ALERT_TIMEFRAME_CHOICES.join(', ')} or all, e.g. /alerts tf 5m · /alerts tf 3m,5m · /alerts tf all` } : { action: 'tf', alertTimeframes: tfs };
  }
  if (a[0] !== 'quiet' || a.length > 2) return { action: 'error', message: usage };
  if (a.length === 1) return { action: 'quiet_show' };
  if (a[1] === 'off') return { action: 'quiet_off' };
  const quiet = parseQuietSpec(a[1]);
  return quiet ? { action: 'quiet_set', quiet } : { action: 'error', message: 'Quiet hours are HH-HH in Chicago time, e.g. /alerts quiet 01-05 (hours 0-24, start and end differ).' };
}

/**
 * "5m" | "3m,5m" | "3m 5m" | "all" -> sorted timeframe list, or null for all; anything
 * else (empty, unknown timeframe) -> undefined.
 */
export function parseAlertTimeframes(spec) {
  const parts = String(spec || '').toLowerCase().split(/[\s,+]+/).filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.length === 1 && parts[0] === 'all') return null;
  if (!parts.every((x) => ALERT_TIMEFRAME_CHOICES.includes(x))) return undefined;
  return ALERT_TIMEFRAME_CHOICES.filter((x) => parts.includes(x));
}

/** "01-05" -> {start:1, end:5}; hours 0..24 (24 = midnight); equal ends -> null. */
export function parseQuietSpec(spec) {
  const m = String(spec || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const [start, end] = [Number(m[1]), Number(m[2])];
  if (start > 24 || end > 24 || start % 24 === end % 24) return null;
  return { start: start % 24, end: end % 24 };
}

// ---------------------------------------------------------------- buttons

const LABEL_COMMANDS = {
  signals: ['signals'], flags: ['flags'], 'why btc': ['why', 'BTC'], 'why eth': ['why', 'ETH'], 'why sol': ['why', 'SOL'],
  charts: ['charts'], wallet: ['wallet'], journal: ['journal'], status: ['status'], alerts: ['alerts'],
  tracking: ['tracking'], positions: ['positions'], market: ['market'], exec: ['exec']
};

/** A reply-keyboard label ("Why BTC", case-insensitive, exact) -> parsed command, else null. */
export function parseMenuLabel(text) {
  const hit = typeof text === 'string' ? LABEL_COMMANDS[text.trim().replace(/\s+/g, ' ').toLowerCase()] : null;
  if (!hit) return null;
  const [cmd, ...args] = hit;
  return { cmd, args, rest: args.join(' '), known: true };
}

/** The persistent reply keyboard sent with every plain reply. */
export function menuKeyboard() {
  return { keyboard: MENU_ROWS.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
}

/** Charts: BTC/ETH/SOL x 1m/3m/5m/15m/1h (`chart:BTC:1m`), then All flags (`flags:all`, the /flags albums). */
export function chartsKeyboard() {
  return {
    inline_keyboard: [
      ...['BTC', 'ETH', 'SOL'].map((sym) => CHART_GRID_TIMEFRAMES.map((tf) => ({ text: `${sym} ${tf}`, callback_data: `chart:${sym}:${tf}` }))),
      [{ text: 'All flags', callback_data: 'flags:all' }]
    ]
  };
}

/** Alerts: level buttons, quiet on (default window) / off, and the timeframe picker (3m+5m · 5m only · all). */
export function alertsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Good', callback_data: 'alerts:good' }, { text: 'Setup', callback_data: 'alerts:setup' }, { text: 'Watch', callback_data: 'alerts:watch' }],
      [{ text: 'Quiet on', callback_data: 'alerts:quiet:on' }, { text: 'Quiet off', callback_data: 'alerts:quiet:off' }],
      [{ text: '3m+5m', callback_data: 'alerts:tf:3m5m' }, { text: '5m only', callback_data: 'alerts:tf:5m' }, { text: 'all', callback_data: 'alerts:tf:all' }]
    ]
  };
}

/** 8-hex FNV-1a of a candidate id: the button ref, so callback_data stays under 64 bytes. */
export function shortRef(candidateId) {
  let h = 0x811c9dc5;
  for (const ch of String(candidateId)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const chartTf = (timeframe) => (CHART_GRID_TIMEFRAMES.includes(timeframe) || /^(4h|1d)$/.test(String(timeframe)) ? timeframe : '5m');

/**
 * Trade buttons for one candidate, two rows: `Plan · Thesis · Chart` and
 * `Track (Untrack when tracked) · Took it · Skipped`. Without a candidate: `Why · Chart`.
 * `named` adds the symbol to each label (for /signals, several symbols at once).
 * callback_data: plan:<ref> thesis:<ref> chart:SYM:TF track:<ref>|untrack:<ref>
 * log:took:SYM:<ref> log:skip:SYM:<ref>; <ref> = shortRef(candidateId), all <= 64 bytes.
 * @returns {Array<Array<{text:string, callback_data:string}>>}
 */
export function tradeButtonRows(symbol, timeframe, candidateId, { named = false, tracked = false } = {}) {
  const tag = named ? ` ${symbol}` : '';
  const tf = chartTf(timeframe);
  const chart = { text: `Chart${tag}${named ? ` ${tf}` : ''}`, callback_data: `chart:${symbol}:${tf}` };
  if (!candidateId) return [[{ text: `Why${tag}`, callback_data: `why:${symbol}` }, chart]];
  const ref = shortRef(candidateId);
  return [
    [{ text: `Plan${tag}`, callback_data: `plan:${ref}` }, { text: `Thesis${tag}`, callback_data: `thesis:${ref}` }, chart],
    [
      tracked ? { text: `Untrack${tag}`, callback_data: `untrack:${ref}` } : { text: `Track${tag}`, callback_data: `track:${ref}` },
      { text: `Took it${tag}`, callback_data: `log:took:${symbol}:${ref}` },
      { text: `Skipped${tag}`, callback_data: `log:skip:${symbol}:${ref}` }
    ]
  ];
}

/** {inline_keyboard} form of tradeButtonRows. */
export function tradeKeyboard(symbol, timeframe, candidateId, opts = {}) {
  return { inline_keyboard: tradeButtonRows(symbol, timeframe, candidateId, opts) };
}

/**
 * The same keyboard with the Track button for `ref` swapped to Untrack (tracked=true) or
 * back. Other buttons untouched. Null when the markup has no such button.
 */
export function swapTrackButton(markup, ref, tracked) {
  if (!isObj(markup) || !Array.isArray(markup.inline_keyboard)) return null;
  const from = tracked ? `track:${ref}` : `untrack:${ref}`;
  let hit = false;
  const rows = markup.inline_keyboard.map((row) => (Array.isArray(row) ? row : []).map((b) => {
    if (!isObj(b) || b.callback_data !== from) return b;
    hit = true;
    return { text: String(b.text || '').replace(tracked ? /^Track/ : /^Untrack/, tracked ? 'Untrack' : 'Track'), callback_data: tracked ? `untrack:${ref}` : `track:${ref}` };
  }));
  return hit ? { inline_keyboard: rows } : null;
}

/**
 * Snapshot of one candidate for the button memory (state.buttons[ref]) and tracking:
 * identity, the candidate's own levels, and the entry/stop/tp1 a Took it logs - field by
 * field from its own plan, else its own SETUP, else the candidate (breakout, invalidation,
 * measured target). Null when the candidate is nowhere in `s`.
 */
export function candidateSnapshot(symbol, s, candidateId) {
  if (!candidateId || !isObj(s)) return null;
  const rec = isObj(s.flagRecommendation) ? s.flagRecommendation : {};
  const plan = isObj(s.flagTradePlan) && s.flagTradePlan.candidateId === candidateId ? s.flagTradePlan : null;
  const setup = isObj(rec.setup) && rec.setup.candidateId === candidateId ? rec.setup : null;
  const c = liveCandidate(s, candidateId);
  if (!c) return null;
  const pick = (k, ck) => [plan && plan[k], setup && setup[k], c[ck]].find(isNum) ?? null;
  return {
    symbol, candidateId, planId: plan ? plan.planId || null : null,
    recClass: rec.class || null,
    reasonCode: (plan && plan.reasonCode) || (rec.primaryReason ? rec.primaryReason.code : null),
    timeframe: c.timeframe || null, direction: c.direction || null,
    entry: pick('entry', 'breakoutLevel'), stop: pick('stop', 'invalidation'), tp1: pick('tp1', 'measuredTarget'),
    state: c.state || null, breakoutLevel: isNum(c.breakoutLevel) ? c.breakoutLevel : null, invalidation: isNum(c.invalidation) ? c.invalidation : null,
    measuredRR: isNum(c.measuredRR) ? c.measuredRR : null, measuredTarget: isNum(c.measuredTarget) ? c.measuredTarget : null,
    planStatus: plan ? plan.status || null : (setup ? 'setup' : null)
  };
}

/**
 * The candidate `id` of a symbol: from candidateSetups, else rebuilt from the plan, the
 * SETUP or the WATCH candidate that names it (so a ref always has levels). Null if none.
 */
function liveCandidate(s, id) {
  const cands = Array.isArray(s && s.candidateSetups) ? s.candidateSetups : [];
  const hit = cands.find((c) => isObj(c) && c.candidateId === id);
  if (hit) return hit;
  const rec = isObj(s && s.flagRecommendation) ? s.flagRecommendation : {};
  const plan = isObj(s && s.flagTradePlan) ? s.flagTradePlan : null;
  const src = [plan, rec.setup, rec.candidate].find((x) => isObj(x) && x.candidateId === id);
  if (!src) return null;
  return {
    candidateId: id, timeframe: src.timeframe, direction: src.direction, state: src.state || (src === plan || src === rec.setup ? 'confirmed' : null),
    breakoutLevel: [src.breakoutLevel, src.breakout, src.entry].find(isNum) ?? null,
    invalidation: [src.invalidation, src.stop].find(isNum) ?? null,
    measuredRR: isNum(src.measuredRR) ? src.measuredRR : null
  };
}

/**
 * The candidate a /signals symbol block's buttons act on: the GOOD plan, else the SETUP,
 * else the plan (any status), else the WATCH candidate. Null when the symbol has none.
 */
export function signalsCandidateId(s) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = isObj(s && s.flagTradePlan) ? s.flagTradePlan : null;
  if (rec.class === 'GOOD' && plan && plan.candidateId) return plan.candidateId;
  if (isObj(rec.setup) && rec.setup.candidateId) return rec.setup.candidateId;
  if (plan && plan.candidateId) return plan.candidateId;
  if (isObj(rec.candidate) && rec.candidate.candidateId) return rec.candidate.candidateId;
  return null;
}

/**
 * The plan a Took it / Skipped button logs for a /signals block: candidateSnapshot of
 * signalsCandidateId. Null when the symbol has no candidate.
 */
export function buttonSnapshot(symbol, s) {
  return candidateSnapshot(symbol, s, signalsCandidateId(s));
}

/** /signals buttons: two rows per symbol with a candidate, else Why/Chart (BTC, ETH, SOL order). */
export function signalsKeyboard(payload, tracked = []) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const trackedIds = new Set((Array.isArray(tracked) ? tracked : []).map((t) => t && t.candidateId));
  const rows = ['BTC', 'ETH', 'SOL'].filter((k) => syms[k]).flatMap((k) => {
    const snap = buttonSnapshot(k, syms[k]);
    return tradeButtonRows(k, snap ? snap.timeframe : '5m', snap ? snap.candidateId : null, { named: true, tracked: Boolean(snap && trackedIds.has(snap.candidateId)) });
  });
  return rows.length ? { inline_keyboard: rows } : null;
}

/** Snapshots of every /signals block with a candidate (stored so its buttons outlive the flag). */
export function signalsSnapshots(payload) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  return ['BTC', 'ETH', 'SOL'].map((k) => (syms[k] ? buttonSnapshot(k, syms[k]) : null)).filter(Boolean);
}

/** Store snapshots in state.buttons (keyed by ref, newest BUTTON_MEMORY kept); returns the new state text. */
export function applyButtonSnapshots(text, snaps, nowMs) {
  const state = parseState(text);
  const at = new Date(nowMs).toISOString();
  const add = Object.fromEntries((snaps || []).filter((x) => isObj(x) && x.candidateId).map((x) => [shortRef(x.candidateId), { ...x, at }]));
  state.buttons = pruneButtons({ ...state.buttons, ...add });
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Keep the newest BUTTON_MEMORY snapshots. */
function pruneButtons(buttons) {
  const entries = Object.entries(isObj(buttons) ? buttons : {}).filter(([, v]) => isObj(v));
  entries.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
  return Object.fromEntries(entries.slice(-BUTTON_MEMORY));
}

/**
 * callback_data -> a parsed command ({cmd, args, rest, known}) or null (unknown/expired).
 *   chart:BTC:5m -> /chart BTC 5m     why:BTC -> /why BTC
 *   flags:all -> /flags (every live flag as chart albums)
 *   alerts:good|setup|watch -> /alerts <level>
 *   alerts:quiet:on -> /alerts quiet 01-05 (the default window)   alerts:quiet:off
 *   alerts:tf:3m5m | alerts:tf:5m | alerts:tf:all -> /alerts tf 3m,5m | 5m | all
 *   log:took:BTC:<ref> / log:skip:BTC:<ref> -> {cmd:'button_log', kind:'open'|'skip', symbol, ref}
 *   plan:<ref> thesis:<ref> track:<ref> untrack:<ref> -> {cmd:'plan'|'thesis'|'track'|'untrack', ref}
 *   closed:<ref> partial:<ref> stillin:<ref> pclose:<ref> -> {cmd:'closed'|'partial'|'stillin'|'pclose', ref}
 *   open:<ref> -> {cmd:'open', ref} (order ticket for a ready plan)
 *   xok:<nonce> / xno:<nonce> -> {cmd:'xconfirm'|'xcancel', nonce} (ticket Confirm / Cancel)
 *   xclose|xhalf|xbe|xstops:<pref> -> {cmd:'xmanage', action:'close'|'half'|'be'|'stops', ref} (position buttons)
 */
export function parseCallbackData(data) {
  const d = typeof data === 'string' ? data.trim() : '';
  const cmd = (c, args) => ({ cmd: c, args, rest: args.join(' '), known: true });
  let m = d.match(/^chart:(BTC|ETH|SOL):([0-9a-z]{2,3})$/);
  if (m) return cmd('chart', [m[1], m[2]]);
  if (d === 'flags:all') return cmd('flags', []);
  m = d.match(/^why:(BTC|ETH|SOL)$/);
  if (m) return cmd('why', [m[1]]);
  m = d.match(/^alerts:(good|setup|watch)$/);
  if (m) return cmd('alerts', [m[1]]);
  if (d === 'alerts:quiet:on') return cmd('alerts', ['quiet', `${DEFAULT_QUIET_HOURS.start}-${DEFAULT_QUIET_HOURS.end}`]);
  if (d === 'alerts:quiet:off') return cmd('alerts', ['quiet', 'off']);
  if (d === 'alerts:tf:3m5m') return cmd('alerts', ['tf', '3m,5m']);
  if (d === 'alerts:tf:5m') return cmd('alerts', ['tf', '5m']);
  if (d === 'alerts:tf:all') return cmd('alerts', ['tf', 'all']);
  m = d.match(/^log:(took|skip):(BTC|ETH|SOL):([0-9a-f]{8})$/);
  if (m) return { cmd: 'button_log', args: [], rest: '', known: true, kind: m[1] === 'took' ? 'open' : 'skip', symbol: m[2], ref: m[3] };
  m = d.match(/^(plan|thesis|track|untrack|closed|partial|stillin|pclose):([0-9a-f]{8})$/);
  if (m) return { cmd: m[1], args: [], rest: '', known: true, ref: m[2] };
  m = d.match(/^open:([0-9a-f]{8})$/);
  if (m) return { cmd: 'open', args: [], rest: '', known: true, ref: m[1] };
  m = d.match(/^x(ok|no):([A-Za-z0-9_-]{4,48})$/);
  if (m) return { cmd: m[1] === 'ok' ? 'xconfirm' : 'xcancel', args: [], rest: '', known: true, nonce: m[2] };
  m = d.match(/^x(close|half|be|stops):([0-9a-f]{8})$/);
  if (m) return { cmd: 'xmanage', args: [], rest: '', known: true, action: m[1], ref: m[2] };
  return null;
}

/**
 * Journal body for a Took it / Skipped tap: kind open or skip with the plan's symbol,
 * direction, entry/stop/tp1 and engineRef. The id is per ref and kind, so a double tap
 * logs once.
 */
export function buttonLogBody(kind, snap, ref) {
  const verb = kind === 'open' ? 'Took' : 'Skipped';
  const body = {
    id: `tg_${kind}_${ref}`,
    kind,
    symbol: snap.symbol,
    direction: snap.direction || null,
    engineRef: { candidateId: snap.candidateId, planId: snap.planId || null, recClass: snap.recClass || null, reasonCode: snap.reasonCode || null },
    text: `${verb} (button): ${snap.symbol} ${snap.timeframe || ''} ${DIR(snap.direction)} entry ${snap.entry ?? 'n/a'} stop ${snap.stop ?? 'n/a'} tp1 ${snap.tp1 ?? 'n/a'}`.replace(/\s+/g, ' ')
  };
  for (const k of ['entry', 'stop', 'tp1']) if (isNum(snap[k]) && snap[k] > 0) body[k] = snap[k];
  return body;
}

/** Every candidate id a symbol names (candidates, plan, SETUP, WATCH candidate). */
function symbolCandidateIds(s) {
  const rec = isObj(s && s.flagRecommendation) ? s.flagRecommendation : {};
  const ids = [
    ...(Array.isArray(s && s.candidateSetups) ? s.candidateSetups.map((c) => c && c.candidateId) : []),
    isObj(s && s.flagTradePlan) ? s.flagTradePlan.candidateId : null,
    isObj(rec.setup) ? rec.setup.candidateId : null,
    isObj(rec.candidate) ? rec.candidate.candidateId : null
  ];
  return [...new Set(ids.filter((x) => typeof x === 'string' && x))];
}

/** Find a button snapshot by ref: state first, else any live candidate of `symbol` with that ref. */
export function findButtonSnapshot(state, payload, symbol, ref) {
  const stored = isObj(state) && isObj(state.buttons) ? state.buttons[ref] : null;
  if (isObj(stored) && stored.symbol === symbol) return stored;
  const s = payload && isObj(payload.symbols) ? payload.symbols[symbol] : null;
  const id = s ? symbolCandidateIds(s).find((x) => shortRef(x) === ref) : null;
  return id ? candidateSnapshot(symbol, s, id) : null;
}

const NUM = '(\\d+(?:\\.\\d+)?)';

/**
 * Map a `/log` sentence to a POST /api/journal body - the same mapping the GPT uses
 * (docs/GPT_INSTRUCTIONS.md COMMANDS `log`): took/entered/opened = open, closed/exited =
 * close, skipped/passed = skip, else note. Numbers only when the owner typed them next to
 * a keyword; nothing is inferred. The text is always kept verbatim.
 * @param {string} text
 * @returns {Object} journal body (validated later by lib/journalSchema.js)
 */
export function parseLogText(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const body = { text: raw };
  if (/\b(skipped|skip|passed on|passing on)\b/.test(lower)) body.kind = 'skip';
  else if (/\b(closed|exited|stopped out|tp1? hit|took profit)\b/.test(lower)) body.kind = 'close';
  else if (/\b(took|entered|opened|went long|went short)\b/.test(lower)) body.kind = 'open';
  else if (/\b(moved|adjusted|trailed)\b/.test(lower)) body.kind = 'adjust';
  else body.kind = 'note';
  const sym = lower.match(/\b(btc|sol|eth)\b/);
  if (sym) body.symbol = sym[1].toUpperCase();
  const dir = lower.match(/\b(long|short)\b/);
  if (dir) body.direction = dir[1];
  const plain = lower.replace(/,(?=\d{3}\b)/g, '');
  const grab = (...res) => {
    for (const re of res) {
      const m = plain.match(re);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  const entry = body.kind === 'close' ? undefined
    : grab(new RegExp(`\\bentry\\s*(?:at\\s*)?\\$?${NUM}`), new RegExp(`\\b(?:long|short)\\s*(?:at\\s*|@\\s*)?\\$?${NUM}(?!\\s*x\\b)`), new RegExp(`@\\s*\\$?${NUM}`));
  const stop = grab(new RegExp(`\\b(?:stop|sl)\\s*(?:at\\s*)?\\$?${NUM}`));
  const tp1 = grab(new RegExp(`\\b(?:tp1?|target)\\s*(?:at\\s*)?\\$?${NUM}`));
  const leverage = grab(new RegExp(`${NUM}\\s*x\\b`));
  const sizeUsd = grab(new RegExp(`\\bsize\\s*\\$?${NUM}`));
  const exitPrice = body.kind === 'close' ? grab(new RegExp(`\\b(?:exit(?:ed)?|closed)\\s*(?:at\\s*|@\\s*)?\\$?${NUM}`), new RegExp(`(?:\\bat|@)\\s*\\$?${NUM}(?!\\s*r\\b)`)) : undefined;
  for (const [k, v] of Object.entries({ entry, stop, tp1, leverage, sizeUsd, exitPrice })) {
    if (isNum(v) && v > 0) body[k] = v;
  }
  const r = plain.match(/([+-]?\d+(?:\.\d+)?)\s*r\b/);
  if (r && body.kind === 'close') body.resultR = Number(r[1]);
  return body;
}

// ---------------------------------------------------------------- formatters

/** Plain number, no currency sign: 84466.1 -> "84,466.10". */
const fmtLevel = (v) => fmtPrice(v).replace('$', '');
const DIR = (d) => (d === 'short' ? 'SHORT' : d === 'long' ? 'LONG' : 'NO DIRECTION');
/** Direction with its arrow, for headers and cards: "▲ LONG" / "▼ SHORT". */
export const dirArrow = (d) => (d === 'short' ? '▼ SHORT' : d === 'long' ? '▲ LONG' : 'NO DIRECTION');
const CALL = { GOOD: '🟢 GO IN', WATCH: '🟡 HOLD / WAIT', BAD: "🔴 DON'T DO IT", DATA_UNAVAILABLE: '⚪ NO DATA' };

function markLine(mark) {
  if (!isObj(mark) || mark.status === 'unavailable' || !isNum(mark.price)) return 'Mark: unavailable';
  const drift = isNum(mark.driftBps) ? ` (drift ${mark.driftBps} bps${Math.abs(mark.driftBps) > 10 ? ', over 10' : ''})` : '';
  return `Mark: ${fmtPrice(mark.price)}${drift}${mark.status === 'stale' ? ' STALE' : ''}`;
}

/**
 * The SETUP line, verbatim to the GPT FORMAT: "SETUP — [ASSET] [TF] [LONG/SHORT] —
 * trigger: [entryCondition]. Info;never GO IN."
 */
export function formatSetupLine(symbol, setup) {
  if (!isObj(setup)) return null;
  return `SETUP — ${escapeHtml(symbol)} ${escapeHtml(setup.timeframe)} ${DIR(setup.direction)} — trigger: ${escapeHtml(setup.entryCondition || 'n/a')}. Info; never GO IN.`;
}

/**
 * Readiness call from flagRecommendation.action, verbatim (schema 1.25.0), in the GPT's
 * signals-line form: "GET IN NOW", "BE READY (3m)", "WAIT (4m)", "STAND DOWN". The eta is
 * shown only when positive. Null when the record carries no action.
 */
export function formatCall(action) {
  if (!isObj(action) || typeof action.call !== 'string') return null;
  return `${escapeHtml(action.call)}${isNum(action.etaMin) && action.etaMin > 0 ? ` (${action.etaMin}m)` : ''}`;
}

/** Minutes from asOf to `tf`'s next close (same arithmetic as flagRecommendation nextCloseEta). */
export function etaToNextClose(asOfIso, tf) {
  const t = typeof asOfIso === 'string' ? Date.parse(asOfIso) : NaN;
  const iv = TF_MS[tf];
  if (!Number.isFinite(t) || !iv) return null;
  return Math.ceil(((Math.floor(t / iv) + 1) * iv - t) / 60000);
}

const withEta = (call, eta) => (isNum(eta) && eta > 0 ? `${call} (${eta}m)` : call);

const fmt1R = (v) => (isNum(v) ? `${(Math.round(v * 10) / 10).toFixed(1)}R` : 'n/a');
const lvl = (v) => (isNum(v) ? fmtLevel(v) : 'n/a');
const sideOf = (direction) => (direction === 'short' ? 'below' : 'above');
/** The bold verdict token: "<b>BE READY (1m)</b>". */
const bold = (call, eta = null) => `<b>${escapeHtml(withEta(call, eta))}</b>`;
const stopTpText = (stop, tp1) => ` · stop ${lvl(stop)} · TP1 ${lvl(tp1)}`;
const stopTp = stopTpText;
/** GET IN NOW levels: "entry X · stop Y · TP1 Z (3.0R) · net 2.6R". */
const goLevels = (p) => `entry ${lvl(p.entry)} · stop ${lvl(p.stop)} · TP1 ${lvl(p.tp1)} (${fmt1R(p.grossRR)}) · net ${fmt1R(p.netRR)}`;
/** Candidate state -> trigger stage (confirmed and unknown mean "waiting for the retest"). */
const stageOf = (candState) => (candState === 'forming' || candState === 'proto' ? 'forming' : candState === 'triggering' ? 'triggering' : 'retest');

/** Plain words for rejection codes without a dedicated short reason (never a raw code). */
const REASON_WORDS = Object.freeze({
  chase: 'ran past breakout',
  net_rr_below_min: 'too thin after fees',
  stop_inside_costs: 'stop inside trading costs',
  invalid_levels: 'levels invalid',
  stale_data: 'data stale',
  missing_data: 'data missing'
});

/**
 * Short STAND DOWN reason for a rejected plan (never the remedy sentence, never a code):
 * rr_below_min -> "0.67R room to 84,771.30 (15m resistance); needs 2.5R" (room when it
 * belongs to this plan, else gross R to TP1), room_at_entry -> "entry X inside
 * resistance|support", stop cap -> "stop 3.4% &gt; 3% cap", anything else -> plain words.
 */
export function shortStandDownReason(plan, room = null) {
  const p = isObj(plan) ? plan : {};
  switch (p.reasonCode) {
    case 'rr_below_min': {
      const own = isObj(room) && isNum(room.r) && isNum(room.levelPrice);
      const r = own ? room.r : (isNum(p.grossRR) ? p.grossRR : null);
      const level = own ? room.levelPrice : p.tp1;
      const src = own && room.levelSource ? ` (${escapeHtml(room.levelSource)})` : '';
      return `${r === null ? 'too little' : `${Math.round(r * 100) / 100}R`} room${isNum(level) ? ` to ${fmtLevel(level)}${src}` : ''}; needs ${MIN_GROSS_RR}R`;
    }
    case 'room_at_entry':
      return `entry ${lvl(p.entry)} inside ${p.direction === 'short' ? 'support' : 'resistance'}`;
    case 'stop_distance_exceeds_cap': {
      const pct = isNum(p.stopDistancePct) ? p.stopDistancePct
        : (isNum(p.entry) && isNum(p.stop) && p.entry > 0 ? Math.abs(p.entry - p.stop) / p.entry * 100 : null);
      return `stop ${pct === null ? 'n/a' : Math.round(pct * 100) / 100}% &gt; ${MAX_STOP_PCT}% cap`;
    }
    default:
      return escapeHtml(REASON_WORDS[p.reasonCode] || String(p.reasonCode || 'rejected').replace(/_/g, ' '));
  }
}

/**
 * Plain-English trigger at a stage: forming -> "needs a 3m close above X, then a retest
 * that holds"; triggering -> "close below X confirms; then retest &amp; hold to enter";
 * retest -> "enter on a retest of X that holds below".
 */
export function triggerWords(stage, { timeframe, direction, level }) {
  const side = sideOf(direction);
  if (stage === 'forming') return `needs a ${escapeHtml(timeframe)} close ${side} ${lvl(level)}, then a retest that holds`;
  if (stage === 'triggering') return `close ${side} ${lvl(level)} confirms; then retest &amp; hold to enter`;
  return `enter on a retest of ${lvl(level)} that holds ${side}`;
}

/**
 * "counter-trend (td:bull 4/4)" when the symbol's top-down sentiment (the td:<s>:<n>/4
 * code in the recommendation) opposes `direction`; null when aligned, mixed or unknown.
 */
export function counterTrendTag(rec, direction) {
  const codes = isObj(rec) ? [...(rec.supports || []), ...(rec.opposes || []), ...(rec.unknowns || [])] : [];
  for (const x of codes) {
    const m = String(typeof x === 'string' ? x : x && x.code).match(/^td:(bull|bear):(\d)\/4$/);
    if (!m) continue;
    const against = (m[1] === 'bull' && direction === 'short') || (m[1] === 'bear' && direction === 'long');
    return against ? `counter-trend (td:${m[1]} ${m[2]}/4)` : null;
  }
  return null;
}

// ---------------------------------------------------------------- visual layout

/**
 * Visual layout (owner spec 2026-09-24): every trade message opens with
 * `<dot> <glyph> <b>SYM tf DIRECTION</b> · KIND`, then sections separated by RULE.
 * Dots: 🟢 GET IN NOW, 🟡 BE READY / WAIT, 🔴 STAND DOWN, ⚪ informational (WATCH, status).
 * Aligned numbers go in <code> blocks (Telegram renders them monospace, spaces kept).
 * Messages stay under MAX_CARD_CHARS.
 */
export const RULE = '────────────────';
export const COIN_GLYPH = Object.freeze({ BTC: '₿', ETH: 'Ξ', SOL: '◎' });
export const MAX_CARD_CHARS = 1000;
const CALL_DOT = Object.freeze({ 'GET IN NOW': '🟢', 'BE READY': '🟡', WAIT: '🟡', 'STAND DOWN': '🔴' });

/** Coin glyph for a symbol (• for anything else). */
export const glyph = (symbol) => COIN_GLYPH[symbol] || '•';

/** Verdict call ("GET IN NOW" | "BE READY" | "WAIT" | "STAND DOWN") -> its dot; unknown -> ⚪. */
export function callDot(call) {
  return CALL_DOT[call] || '⚪';
}

/** The call named in a verdict line ("<b>BE READY (1m)</b> — ...") or null. */
export function callOf(verdictLine) {
  const m = String(verdictLine || '').match(/^<b>(GET IN NOW|BE READY|WAIT|STAND DOWN)\b/);
  return m ? m[1] : null;
}

/** Header line: "🟡 ◎ <b>SOL 3m SHORT</b> · BREAKOUT". */
export function msgHeader(dot, symbol, tf, dir, kind) {
  const subject = [symbol, tf, dir ? dirArrow(dir) : null].filter(Boolean).map(escapeHtml).join(' ');
  return `${dot} ${glyph(symbol)} <b>${subject}</b>${kind ? ` · ${kind}` : ''}`;
}

/**
 * Aligned monospace rows: keys left-aligned, values right-aligned (`alignValues: false`
 * leaves values left-aligned for text). Null rows are skipped. Escaped for HTML.
 * @param {Array<[string, string]|null>} rows
 */
export function codeBlock(rows, { alignValues = true } = {}) {
  const r = (rows || []).filter((x) => Array.isArray(x) && x[1] !== null && x[1] !== undefined).map(([k, v]) => [String(k), String(v)]);
  if (!r.length) return '';
  const kw = Math.max(...r.map(([k]) => k.length));
  const vw = Math.max(...r.map(([, v]) => v.length));
  return `<code>${r.map(([k, v]) => escapeHtml(`${k.padEnd(kw)}  ${alignValues ? v.padStart(vw) : v}`)).join('\n')}</code>`;
}

/** Header + sections joined by the rule; empty sections dropped. */
export function joinSections(parts) {
  return parts.filter((x) => typeof x === 'string' && x.trim()).join(`\n${RULE}\n`);
}

/** Context lines for an alert: counter-trend or top-down, divergence, mark drift. */
function contextLines(rec, direction, mark) {
  const lines = [];
  const ct = String(counterTrendTag(rec, direction) || '').match(/td:(bull|bear) (\d)\/4/);
  const codes = isObj(rec) ? [...(rec.supports || []), ...(rec.opposes || []), ...(rec.unknowns || [])].map((x) => (typeof x === 'string' ? x : x && x.code)) : [];
  if (ct) lines.push(`Counter-trend: top-down ${ct[1]} ${ct[2]}/4, against this ${dirArrow(direction)}`);
  else {
    const td = codes.map((x) => String(x).match(/^td:(\w+):(\d)\/4$/)).find(Boolean);
    if (td) lines.push(`Top-down: ${escapeHtml(td[1])} ${td[2]}/4`);
  }
  if (codes.includes('divergence_agrees')) lines.push('Divergence: agrees');
  if (codes.includes('divergence_conflicts')) lines.push('Divergence: against the trade');
  if (isObj(mark)) {
    if (mark.status === 'unavailable' || !isNum(mark.price)) lines.push('Mark: unavailable');
    else lines.push(`Mark: ${fmtPrice(mark.price)}${isNum(mark.driftBps) ? ` · drift ${mark.driftBps} bps` : ''}${mark.status === 'stale' ? ' · STALE' : ''}`);
  }
  return lines.join('\n');
}

/** PLAN section rows for a plan or SETUP (entry / stop / TP1 / TP2 / R / size / loss), sizing from `risk`. */
function planRows(P, risk = null) {
  if (!isObj(P)) return [];
  const stopPct = isNum(P.stopDistancePct) ? P.stopDistancePct
    : (isNum(P.entry) && isNum(P.stop) && P.entry > 0 ? Math.abs(P.entry - P.stop) / P.entry * 100 : null);
  const r = isObj(risk) && !risk.reason && isNum(risk.suggestedLeverage) && isNum(risk.collateralUsd) ? risk : null;
  return [
    ['entry', lvl(P.entry)],
    ['stop', lvl(P.stop)],
    stopPct === null ? null : ['stop dist', `${Math.round(stopPct * 100) / 100}%`],
    ['TP1', lvl(P.tp1)],
    isNum(P.tp2) ? ['TP2', lvl(P.tp2)] : null,
    isNum(P.grossRR) ? ['R gross·net', `${fmt1R(P.grossRR)} · ${fmt1R(P.netRR)}`] : null,
    r ? ['size · lev', `${fmtUsd(r.suggestedLeverage * r.collateralUsd)} · ${r.suggestedLeverage}x`] : null,
    r ? ['loss$', fmtUsd(r.lossAtStopUsd)] : null
  ];
}

/**
 * One alert in the visual layout: header (dot from the verdict; WATCH is ⚪), LEVELS
 * (brk / void / meas / room, monospace), VERDICT (bold call + plain reason), PLAN (only
 * for this candidate's own ready/conditional plan or SETUP), CONTEXT.
 * @param {string} kind - header kind label (GOOD, SETUP, BREAKOUT, WATCH, TRIGGERING, TRACK · ...)
 * @param {Object} opts - {rec, plan (the symbol's plan), asOf, mark, verdictKind, verdict}
 */
export function alertMessage(kind, symbol, c, { rec = null, plan = null, asOf = null, mark = null, verdictKind = kind, verdict = null } = {}) {
  const v = verdict || alertVerdict(verdictKind, c, { plan, rec, asOf, levels: false });
  const dot = verdictKind === 'WATCH' ? '⚪' : callDot(callOf(v));
  const room = ownRoom(rec, plan, c.candidateId);
  const levels = codeBlock([
    ['brk', lvl(c.breakoutLevel)],
    ['void', lvl(c.invalidation)],
    ['meas', fmt1R(c.measuredRR)],
    room && isNum(room.r) ? ['room', `${fmt1R(room.r)}${isNum(room.levelPrice) ? ` to ${fmtLevel(room.levelPrice)}` : ''}`] : null
  ]);
  const own = isObj(plan) && plan.candidateId === c.candidateId && (plan.status === 'ready' || plan.status === 'conditional') ? plan : null;
  const ownSetup = !own && isObj(rec) && isObj(rec.setup) && rec.setup.candidateId === c.candidateId ? rec.setup : null;
  const planSec = own || ownSetup ? codeBlock(planRows(own || ownSetup, c.risk)) : '';
  const head = msgHeader(dot, symbol, c.timeframe, c.direction, `${kind}${verdictKind === 'WATCH' && c.state ? ` · ${escapeHtml(c.state)}` : ''}`);
  return joinSections([head, levels, v, planSec, contextLines(rec, c.direction, mark)]);
}

/**
 * Alert line 1: "KIND · SYM tf DIR [forming] · brk X · void Y · meas 3.1R [· counter-trend
 * (td:bull 4/4)]". The candidate state shows on WATCH only.
 */
export function alertHeadLine(kind, symbol, c, rec = null) {
  const parts = [
    kind,
    `${escapeHtml(symbol)} ${escapeHtml(c.timeframe)} ${DIR(c.direction)}${kind === 'WATCH' && c.state ? ` ${escapeHtml(c.state)}` : ''}`,
    `brk ${lvl(c.breakoutLevel)}`,
    `void ${lvl(c.invalidation)}`,
    `meas ${fmt1R(c.measuredRR)}`
  ];
  const tag = counterTrendTag(rec, c.direction);
  if (tag) parts.push(tag);
  return parts.join(' · ');
}

/**
 * Alert line 2: one bold verdict for THAT candidate, then a plain reason.
 *   WATCH -> WAIT (eta) — needs a close, then a retest
 *   TRIGGERING -> BE READY (eta) — close confirms; then retest & hold
 *   own plan ready -> GET IN NOW — retest held · entry · stop · TP1 (R) · net
 *   own plan conditional, or its SETUP (incl. chase-rejected) -> BE READY (eta) — trigger · stop · TP1
 *   own plan rejected, no setup -> STAND DOWN — short reason
 *   else -> STAND DOWN — another flag is the live plan
 * eta = minutes to the next close of that timeframe from asOf. `levels: false` drops the
 * entry/stop/TP1 tail (the visual layout prints them in its PLAN section).
 */
export function alertVerdict(kind, c, { plan = null, rec = null, asOf = null, levels = true } = {}) {
  const tf = c.timeframe;
  const stopTp = levels ? stopTpText : () => '';
  if (kind === 'WATCH') return `${bold('WAIT', etaToNextClose(asOf, tf))} — ${triggerWords('forming', { timeframe: tf, direction: c.direction, level: c.breakoutLevel })}`;
  if (kind === 'TRIGGERING') return `${bold('BE READY', etaToNextClose(asOf, tf))} — ${triggerWords('triggering', { timeframe: tf, direction: c.direction, level: c.breakoutLevel })}`;
  const own = isObj(plan) && plan.candidateId === c.candidateId ? plan : null;
  const ownSetup = isObj(rec) && isObj(rec.setup) && rec.setup.candidateId === c.candidateId ? rec.setup : null;
  if (own && own.status === 'ready') return `${bold('GET IN NOW')} — retest held${levels ? ` · ${goLevels(own)}` : ''}`;
  if (own && own.status === 'conditional') {
    const ptf = own.timeframe || tf;
    const stage = own.reasonCode === 'awaiting_breakout' ? stageOf(c.state) : 'retest';
    return `${bold('BE READY', etaToNextClose(asOf, ptf))} — ${triggerWords(stage, { timeframe: ptf, direction: own.direction || c.direction, level: own.entry })}${stopTp(own.stop, own.tp1)}`;
  }
  if (ownSetup) {
    const stf = ownSetup.timeframe || tf;
    const chase = own && own.reasonCode === 'chase' ? 'no chase; ' : '';
    return `${bold('BE READY', etaToNextClose(asOf, stf))} — ${chase}${triggerWords(stageOf(c.state), { timeframe: stf, direction: ownSetup.direction || c.direction, level: ownSetup.entry })}${stopTp(ownSetup.stop, ownSetup.tp1)}`;
  }
  if (own && own.status === 'rejected') return `${bold('STAND DOWN')} — ${shortStandDownReason(own, ownRoom(rec, plan, c.candidateId))}`;
  return `${bold('STAND DOWN')} — another flag is the live plan`;
}

/** The candidate with `id` from a candidateSetups list, else one built from plan/setup levels. */
function candidateFor(cands, id, levels) {
  const hit = Array.isArray(cands) ? cands.find((c) => isObj(c) && c.candidateId === id) : null;
  if (hit) return hit;
  const l = isObj(levels) ? levels : {};
  return { candidateId: id, timeframe: l.timeframe, direction: l.direction, state: null, breakoutLevel: l.entry, invalidation: l.stop, measuredRR: null };
}

/**
 * The candidateId flagRecommendation.room was built for (same precedence as its
 * buildRoom: a ready/conditional plan, else the SETUP, else a rejected plan), so an
 * alert only shows room that belongs to its own candidate.
 */
export function roomOwnerId(rec, plan) {
  if (isObj(plan) && (plan.status === 'ready' || plan.status === 'conditional')) return plan.candidateId || null;
  if (isObj(rec) && isObj(rec.setup)) return rec.setup.candidateId || null;
  if (isObj(plan) && plan.status === 'rejected') return plan.candidateId || null;
  return null;
}

/** rec.room when it belongs to candidate `id`, else null. */
function ownRoom(rec, plan, id) {
  const room = isObj(rec) && isObj(rec.room) ? rec.room : null;
  return room && id && roomOwnerId(rec, plan) === id ? room : null;
}

/**
 * One /signals line per symbol, the alerts' verdict in the same words:
 * "<b>VERDICT (Xm)</b> · SYM · reason". The verdict is flagRecommendation.action verbatim
 * (GOOD with a plan and no action -> GET IN NOW, else STAND DOWN).
 * @param {string} symbol
 * @param {Object} s - payload.symbols[symbol] (compact or full)
 */
export function formatSignalLine(symbol, s) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = isObj(s && s.flagTradePlan) ? s.flagTradePlan : null;
  const cands = s && s.candidateSetups;
  const klass = rec.class || 'DATA_UNAVAILABLE';
  const fallback = klass === 'GOOD' && plan ? 'GET IN NOW' : 'STAND DOWN';
  const call = isObj(rec.action) && typeof rec.action.call === 'string' ? rec.action.call : fallback;
  const verdict = `<b>${formatCall(rec.action) || escapeHtml(fallback)}</b>`;
  const head = (x) => `${escapeHtml(x.timeframe)} ${DIR(x.direction)}`;
  let reason;
  if (klass === 'DATA_UNAVAILABLE') reason = 'market data unavailable';
  else if (call === 'GET IN NOW' && plan) reason = `${head(plan)} · retest held · ${goLevels(plan)}`;
  else if (call === 'BE READY' && plan && plan.status === 'conditional') {
    const stage = plan.reasonCode === 'awaiting_breakout' ? stageOf(candidateFor(cands, plan.candidateId, plan).state) : 'retest';
    reason = `${head(plan)} · ${triggerWords(stage, { timeframe: plan.timeframe, direction: plan.direction, level: plan.entry })}`;
  } else if (call === 'BE READY' && isObj(rec.setup)) {
    const su = rec.setup;
    const chase = plan && plan.candidateId === su.candidateId && plan.reasonCode === 'chase' ? 'no chase; ' : '';
    reason = `${head(su)} · ${chase}${triggerWords(stageOf(candidateFor(cands, su.candidateId, su).state), { timeframe: su.timeframe, direction: su.direction, level: su.entry })}`;
  } else if (call === 'WAIT' && isObj(rec.candidate)) {
    const c = rec.candidate;
    reason = `${head(c)} ${escapeHtml(c.state || '')} · ${triggerWords(stageOf(c.state), { timeframe: c.timeframe, direction: c.direction, level: c.breakout })}`;
  } else if (plan && plan.status === 'rejected') reason = shortStandDownReason(plan, roomOwnerId(rec, plan) === plan.candidateId ? rec.room : null);
  else reason = 'no flag setup';
  return `${verdict} · ${escapeHtml(symbol)} · ${reason}`;
}

/** /signals SETUP line: "SETUP · ETH 3m SHORT · entry X · stop Y · TP1 Z (2.5R)". Null without a setup. */
export function formatSetupBrief(symbol, setup) {
  if (!isObj(setup)) return null;
  return `SETUP · ${escapeHtml(symbol)} ${escapeHtml(setup.timeframe)} ${DIR(setup.direction)} · entry ${lvl(setup.entry)}${stopTp(setup.stop, setup.tp1)} (${fmt1R(setup.grossRR)})`;
}

/**
 * DATA block, same as the GPT FORMAT's one-line DATA section (schema 1.25.0):
 * "Data: closed 14:05Z · complete · 1.25.0·2026.09.24-5", plus "Warnings:" only when any.
 */
export function formatDataBlock(payload, nowMs = null) {
  const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings : [];
  const ct = payload && typeof payload.closedThrough === 'string' && Number.isFinite(Date.parse(payload.closedThrough))
    ? `${new Date(Date.parse(payload.closedThrough)).toISOString().slice(11, 16)}Z`
    : 'n/a';
  const lines = [
    '<b>DATA</b>',
    `Data: closed ${ct} · ${escapeHtml(payload && payload.dataStatus ? payload.dataStatus : 'n/a')} · ${escapeHtml(payload && payload.schemaVersion)}·${escapeHtml(payload && payload.configVersion)}`
  ];
  if (warnings.length) lines.push(`Warnings: ${escapeHtml(warnings.slice(0, 5).join('; '))}`);
  return lines.join('\n');
}

/** The flag a /signals line talks about (plan, SETUP or WATCH candidate), for its header. */
function signalsSubject(s) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = isObj(s && s.flagTradePlan) ? s.flagTradePlan : null;
  const call = isObj(rec.action) ? rec.action.call : null;
  if (plan && (call === 'GET IN NOW' || (call === 'BE READY' && plan.status === 'conditional') || plan.status === 'rejected')) return plan;
  if (call === 'BE READY' && isObj(rec.setup)) return rec.setup;
  if (call === 'WAIT' && isObj(rec.candidate)) return rec.candidate;
  return plan || rec.setup || rec.candidate || null;
}

/**
 * /signals in the visual layout: one block per symbol (GOOD first, then BTC/ETH/SOL):
 * `<dot> <glyph> <b>SYM tf ▲ LONG</b> · SIGNAL`, the verdict line, its SETUP line when
 * any; blocks and the DATA block separated by the rule.
 */
export function formatSignals(payload, nowMs = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  if (!payload || payload.dataStatus === 'unavailable' || !Object.keys(syms).length) {
    return joinSections([`🔴 <b>BTC / ETH / SOL</b> · SIGNALS`, '<b>STAND DOWN</b> · market data unavailable', formatDataBlock(payload || {}, nowMs)]);
  }
  const order = ['BTC', 'ETH', 'SOL'].filter((k) => syms[k]);
  const goods = order.filter((k) => syms[k].flagRecommendation && syms[k].flagRecommendation.class === 'GOOD');
  const blocks = [...goods, ...order.filter((k) => !goods.includes(k))].map((k) => {
    const s = syms[k];
    const line = formatSignalLine(k, s);
    const subj = signalsSubject(s);
    const head = msgHeader(callDot(callOf(line)), k, subj ? subj.timeframe : null, subj ? subj.direction : null, 'SIGNAL');
    const setup = formatSetupBrief(k, s.flagRecommendation && s.flagRecommendation.setup);
    return [head, line, ...(setup ? [setup] : [])].join('\n');
  });
  return joinSections([...blocks, formatDataBlock(payload, nowMs)]);
}

/** /why SYM: the full recommendation record (model.recommendation) or the compact one. */
export function formatWhy(symbol, s) {
  if (!s) return `${escapeHtml(symbol)}: not in this build.`;
  const full = s.model && s.model.recommendation ? s.model.recommendation : s.flagRecommendation;
  if (!full) return `${escapeHtml(symbol)}: no recommendation in this build.`;
  const list = (items) => (Array.isArray(items) && items.length
    ? items.map((r) => `• ${escapeHtml(typeof r === 'string' ? r : (r.text || r.code))}`).join('\n')
    : '• none');
  return [
    `<b>${escapeHtml(symbol)} — ${escapeHtml(full.class)}</b>`,
    `Primary: ${escapeHtml(full.primaryReason ? (full.primaryReason.text || full.primaryReason.code) : 'n/a')}`,
    `Readiness: ${escapeHtml(full.readiness || 'n/a')}${full.qualityBand ? ` · quality ${escapeHtml(full.qualityBand)}` : ''}`,
    '', '<b>Supports</b>', list(full.supports),
    '', '<b>Against</b>', list(full.opposes),
    '', '<b>Unknown</b>', list(full.unknowns),
    '', '<b>What changes</b>', list(full.changeConditions),
    ...(full.setup ? ['', formatSetupLine(symbol, full.setup)] : [])
  ].join('\n');
}

/** /flags [SYM]: every candidate per asset, both directions, every state. */
export function formatFlags(payload, only = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const keys = (only ? [only] : ['BTC', 'ETH', 'SOL']).filter((k) => syms[k]);
  if (!keys.length) return 'No symbols in this build.';
  return keys.map((k) => {
    const cands = Array.isArray(syms[k].candidateSetups) ? syms[k].candidateSetups : [];
    const lines = [`<b>${escapeHtml(k)}</b>`];
    if (!cands.length) lines.push('No flag candidates.');
    for (const c of cands) {
      if (!c) continue;
      const bits = [`${escapeHtml(c.timeframe)} ${DIR(c.direction)} ${escapeHtml(c.type || 'flag')} ${escapeHtml(c.state)}`];
      if (isNum(c.confidence)) bits.push(`conf ${c.confidence}`);
      if (isNum(c.breakoutLevel)) bits.push(`brk ${fmtPrice(c.breakoutLevel)}`);
      if (isNum(c.invalidation)) bits.push(`inv ${fmtPrice(c.invalidation)}`);
      if (c.qual && c.qual.decision) bits.push(`qual ${escapeHtml(c.qual.decision)}`);
      if (c.failReason) bits.push(`fail ${escapeHtml(c.failReason)}`);
      lines.push(`• ${bits.join(' · ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

/** /wallet: the read-only account block. Unavailable is never $0. */
export function formatWallet(account) {
  const a = isObj(account) ? account : {};
  const avail = a.status === 'available';
  const usd = (v) => (avail && isNum(v) ? fmtPrice(v) : 'Unavailable');
  const perf = isObj(a.performance) ? a.performance : {};
  return [
    '<b>ACCOUNT</b>',
    `Status: ${escapeHtml(a.status || 'unavailable')}${a.reason ? ` (${escapeHtml(a.reason)})` : ''}`,
    `Wallet Balance: ${usd(a.margin && a.margin.usd)}`,
    `Holdings Exposure: ${usd(a.holdingsUsd)}`,
    `Gas: ${avail && a.gas && isNum(a.gas.sol) ? `${a.gas.sol} SOL${a.gas.sufficient === false ? ' (low)' : ''}` : 'Unavailable'}`,
    `Realized PnL: ${usd(perf.netPnlUsd)}${avail && isNum(perf.returnPct) ? ` (${perf.returnPct}%)` : ''}`,
    `Wallet Updated At: ${escapeHtml(a.fetchedAt || 'n/a')}`
  ].join('\n');
}

/** /journal n: one line per record, newest first. */
export function formatJournal(records, nowMs = null) {
  if (!Array.isArray(records) || !records.length) return 'Journal is empty.';
  return records.map((r) => {
    const lv = [r.entry, r.stop, r.tp1].some(isNum) ? ` ${[r.entry, r.stop, r.tp1].map((v) => (isNum(v) ? fmtPrice(v) : '-')).join(' / ')}` : '';
    const res = isNum(r.resultR) ? ` ${fmtR(r.resultR)}` : '';
    const text = String(r.text || '').slice(0, 120);
    return `${escapeHtml(fmtTime(r.saidAt || r.receivedAt, nowMs))} · ${escapeHtml(r.kind)}${r.symbol ? ` ${escapeHtml(r.symbol)}` : ''}${r.direction ? ` ${escapeHtml(r.direction)}` : ''}${lv}${res} — ${escapeHtml(text)}${r.source === 'telegram' ? ' [tg]' : ''}`;
  }).join('\n');
}

/** /status: ⚪ header, then key/value rows in monospace (schema, data age, marks, alerts, cron, prefs, tracking). */
export function formatStatus(payload, state, nowMs, health = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const rows = [
    ['Schema/Config', `${payload && payload.schemaVersion} · ${payload && payload.configVersion}`],
    ['Closed Through', payload && payload.closedThrough ? `${fmtTime(payload.closedThrough, nowMs)} (${fmtAge(payload.closedThrough, nowMs)})` : 'n/a'],
    ['Data', payload && payload.dataStatus ? payload.dataStatus : 'n/a']
  ];
  for (const k of ['BTC', 'ETH', 'SOL']) {
    if (!syms[k]) continue;
    const rec = syms[k].flagRecommendation;
    rows.push([k, `${rec && rec.class ? rec.class : 'n/a'} · ${markLine(syms[k].mark)}`]);
  }
  const st = isObj(state) ? state : {};
  const last = st.alerts && st.alerts.last;
  rows.push(['Last alert', last ? `${last.kind} ${last.symbol || ''} ${fmtTime(last.at, nowMs)}`.replace(/\s+/g, ' ') : 'none yet']);
  rows.push(['Alerts today', String(st.alerts && st.alerts.day === new Date(nowMs).toISOString().slice(0, 10) ? st.alerts.today : 0)]);
  rows.push(['Cron last run', st.cron && st.cron.lastRunAt ? `${fmtTime(st.cron.lastRunAt, nowMs)} (${fmtAge(st.cron.lastRunAt, nowMs)}; heartbeat saved every ${HEARTBEAT_WRITE_MS / 60_000} min)` : 'never']);
  const prefs = normalizePrefs(st.prefs);
  rows.push(['Alert level', prefs.level]);
  rows.push(['Quiet hours', `${fmtQuiet(prefs.quiet)}${prefs.quiet && isNum(nowMs) && inQuietHours(prefs.quiet, nowMs) ? ' (quiet now)' : ''}`]);
  rows.push(['Alert timeframes', Array.isArray(prefs.alertTimeframes) ? prefs.alertTimeframes.join(', ') : 'all']);
  rows.push(['Tracking', `${liveTracked(st.tracked, nowMs).length} of ${TRACK_MAX}`]);
  const h = isObj(health) ? health : null;
  rows.push(['Cron failures', `${h ? `${h.failures} in a row` : 'n/a'} · last failure: ${h && h.lastReason ? `${h.lastReason} ${fmtTime(h.lastFailureAt, nowMs)}` : 'none'}`]);
  return joinSections(['⚪ <b>STATUS</b>', codeBlock(rows.map(([k, v]) => [`${k}:`, v]), { alignValues: false })]);
}

const LEVEL_TEXT = {
  good: 'GOOD and GOOD ended only',
  setup: 'GOOD, GOOD ended and SETUP',
  watch: 'GOOD, GOOD ended, SETUP and new forming/triggering flags'
};

const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/** ['3m','5m'] -> "3m, 5m (WATCH / TRIGGERING / BREAKOUT; 1m turns on for a tracked symbol + direction)"; null -> "all". */
export function fmtAlertTimeframes(tfs) {
  return `${Array.isArray(tfs) ? tfs.join(', ') : 'all'} (WATCH / TRIGGERING / BREAKOUT; GOOD, SETUP, tracked and health alerts always send; a tracked symbol + direction adds its 1m flags)`;
}

/** {start:1,end:5} -> "01:00–05:00 America/Chicago, every day (silent)"; null -> "off". */
export function fmtQuiet(quiet) {
  if (!isObj(quiet)) return 'off';
  return `${hh(quiet.start)}–${hh(quiet.end)} ${QUIET_TIMEZONE}, every day (alerts arrive silently)`;
}

/** /alerts (no args): level, what it sends, quiet window, how to change. */
export function formatAlertPrefs(prefs) {
  const p = normalizePrefs(prefs);
  return [
    `Alert level: <b>${p.level}</b> — ${LEVEL_TEXT[p.level]}. Data and mark health alerts always send.`,
    `Quiet hours: ${fmtQuiet(p.quiet)}`,
    `Timeframes: ${fmtAlertTimeframes(p.alertTimeframes)}`,
    'Change: /alerts good|setup|watch · /alerts quiet HH-HH · /alerts quiet off · /alerts tf 5m|3m,5m|all'
  ].join('\n');
}

export function formatHelp() {
  return [
    '<b>EditTrades bot</b> — reads the engine; trades only through an order ticket you confirm with your PIN (off unless execution is enabled; dry run first).',
    '/signals — one verdict line per symbol (GET IN NOW / BE READY / WAIT / STAND DOWN) + SETUP lines',
    '/why SYM — supports, against, unknowns, what changes',
    '/flags [SYM] — every flag candidate and its state, then chart albums of every live flag (max 9 images)',
    '/chart SYM TF — confirmation chart, e.g. /chart BTC 5m',
    '/wallet — read-only account block',
    '/journal [n] — last n journal lines (default 10)',
    '/log text — journal a line, e.g. /log took BTC long entry 84600 stop 84390 tp 85100',
    '/positions — journal opens with no close: live mark, R now, R to stop and TP1, age; Close @ mark button',
    '/tracking — the candidates you track (max 10, 6 h each) with Plan / Thesis / Untrack buttons',
    '/status — schema, data age, marks, last alert, cron, alert level, quiet hours, timeframes',
    '/market — last 24h per symbol from engine fields (change, range, top-down, 4h/1h lean, EMA200, Stoch, drift), a rule-based LEAN, alerts today, and the level that would change it',
    '/testalert — sample GOOD card with chart (labeled TEST)',
    '/menu — show the button keyboard (Signals, Flags, Market, Why, Charts, Wallet, Positions, Exec, Journal, Status, Alerts, Tracking)',
    '/charts — chart picker buttons',
    '/alerts — show alert level, quiet hours and timeframes',
    '/alerts good|setup|watch — good: GOOD only · setup: + SETUP (default) · watch: + new forming/triggering flags',
    '/alerts quiet HH-HH — silent (not dropped) alerts in those Chicago hours, every day; /alerts quiet off; /alerts quiet shows it',
    '/alerts tf 5m | 3m,5m | all — timeframes WATCH / TRIGGERING / BREAKOUT alert on (default 3m,5m)',
    'Alerts arrive on their own: new GOOD, BREAKOUT, new SETUP, GOOD ended, data or mark down over 5 min.',
    'Every alert and /signals block has buttons: Plan (levels + sizing), Thesis (why, in plain words), Chart / Track (alerts on every change of that flag; tracking a symbol + direction also turns on its 1m flags), Took it (journals an open and tracks TP1 / stop), Skipped.',
    'After Took it, a TP1 or stop hit brings Closed here / Partial / Still in; no close in 10 min sends one reminder.',
    '<b>Execution</b> (owner only; off unless enabled; DRY RUN until the mode is set to live in Vercel):',
    'Open (on GOOD alerts and ready Plan cards) — order ticket from the plan: size and leverage = engine suggestion capped by your caps; Confirm, then reply /confirm &lt;nonce&gt; &lt;PIN&gt; within 60 s (the message is deleted after use)',
    `${ORDER_USAGE} — manual order; SL and TP are required`,
    '/positions — with execution on: live positions from chain with Close / Close 50% / SL→BE / Set SL/TP, each confirmed with your PIN',
    '/stops &lt;pos&gt; sl &lt;price&gt; tp &lt;price&gt; — ticket to move a position\'s stop and target',
    '/exec — mode, kill switch, caps, loss today, open count, margin · /kill — stop all execution now (no PIN) · /arm &lt;PIN&gt; — clear the /kill flag · /mode — dry or live (env-only)'
  ].join('\n');
}

/**
 * The GOOD alert (sent with the plan-timeframe chart) in the visual layout: 🟢 header,
 * LEVELS, <b>GET IN NOW</b> — retest held, PLAN (entry/stop/TP1/TP2/R/size), CONTEXT.
 * `test` adds a TEST label line so a sample can never be mistaken for a call.
 */
export function formatGoodAlert(symbol, s, payload = null, { test = false } = {}) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = (s && s.flagTradePlan) || {};
  const c = candidateFor(s && s.candidateSetups, plan.candidateId, plan);
  const text = alertMessage('GOOD', symbol, c, { rec, plan: { ...plan, candidateId: c.candidateId, status: plan.status || 'ready' }, asOf: rec.asOf || null, mark: s && s.mark, verdictKind: 'BREAKOUT' });
  return `${test ? '🧪 TEST — NOT A SIGNAL\n' : ''}${text}`;
}

/**
 * SETUP alert: header (🟡 BE READY), LEVELS from the setup's candidate (when it is in
 * `candidates`), the trigger, PLAN from the setup's levels, CONTEXT.
 */
export function formatSetupAlert(symbol, setup, rec = null, { plan = null, asOf = null, candidates = [], mark = null } = {}) {
  const c = candidateFor(candidates, setup.candidateId, setup);
  const r = { ...(isObj(rec) ? rec : {}), setup };
  return alertMessage('SETUP', symbol, c, { rec: r, plan, asOf, mark });
}

/**
 * WATCH (⚪, candidate forming) / TRIGGERING (🟡) alert, no chart: LEVELS, the WAIT /
 * BE READY trigger, CONTEXT.
 */
export function formatWatchAlert(symbol, c, rec, { asOf = null, mark = null } = {}) {
  const kind = c.state === 'triggering' ? 'TRIGGERING' : 'WATCH';
  return alertMessage(kind, symbol, c, { rec, asOf, mark });
}

// ---------------------------------------------------------------- Plan / Thesis cards

/**
 * A button ref -> the view the Plan / Thesis cards and Track read: live data first (any
 * candidate, plan, SETUP or WATCH candidate of any symbol whose candidateId hashes to
 * `ref`), else the snapshot stored when the alert went out (state.buttons, then
 * state.tracked). Null when neither knows the ref (reply EXPIRED_REPLY).
 * @returns {Object|null} {source:'live'|'snapshot', symbol, ref, candidateId, candidate, plan, symbolPlan, setup, rec, mark, price, pathOutlook, asOf, at, s?, snap?}
 */
export function resolveRef(ref, payload, state = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  for (const k of ['BTC', 'ETH', 'SOL']) {
    const s = syms[k];
    if (!isObj(s)) continue;
    const id = symbolCandidateIds(s).find((x) => shortRef(x) === ref);
    if (id) return liveView(k, s, id, payload);
  }
  const st = isObj(state) ? state : {};
  const snap = (isObj(st.buttons) && isObj(st.buttons[ref]) ? st.buttons[ref] : null)
    || (Array.isArray(st.tracked) ? st.tracked.find((t) => isObj(t) && t.ref === ref) : null);
  return isObj(snap) && snap.symbol && snap.candidateId ? snapshotView(snap, ref) : null;
}

/** The live view of candidate `id` on symbol `symbol` (see resolveRef). */
export function liveView(symbol, s, id, payload = null) {
  const rec = isObj(s.flagRecommendation) ? s.flagRecommendation : {};
  const symbolPlan = isObj(s.flagTradePlan) ? s.flagTradePlan : null;
  return {
    source: 'live', symbol, ref: shortRef(id), candidateId: id, candidate: liveCandidate(s, id) || { candidateId: id },
    plan: symbolPlan && symbolPlan.candidateId === id ? symbolPlan : null, symbolPlan,
    setup: isObj(rec.setup) && rec.setup.candidateId === id ? rec.setup : null,
    rec, mark: isObj(s.mark) ? s.mark : null, price: isNum(s.price) ? s.price : null,
    pathOutlook: isObj(s.pathOutlook) && s.pathOutlook.id === id ? s.pathOutlook : null,
    asOf: rec.asOf || (payload && payload.closedThrough) || null, at: null, s
  };
}

function snapshotView(snap, ref) {
  const candidate = {
    candidateId: snap.candidateId, timeframe: snap.timeframe, direction: snap.direction, state: snap.state || snap.lastState || null,
    breakoutLevel: [snap.breakoutLevel, snap.entry].find(isNum) ?? null, invalidation: [snap.invalidation, snap.stop].find(isNum) ?? null,
    measuredRR: isNum(snap.measuredRR) ? snap.measuredRR : null, measuredTarget: isNum(snap.measuredTarget) ? snap.measuredTarget : null
  };
  return {
    source: 'snapshot', symbol: snap.symbol, ref, candidateId: snap.candidateId, candidate, plan: null, symbolPlan: null, setup: null,
    rec: {}, mark: null, price: null, pathOutlook: null, asOf: null, at: snap.at || snap.since || null, snap
  };
}

const PATH_WORDS = { retest_go: 'retest & go', runner: 'runs without a retest', false_break: 'false break', fail_first: 'fails before breaking', chop: 'chop' };
const fmtUsd = (v) => (isNum(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : 'n/a');
const fmtSignedR = (v) => (isNum(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(Math.round(v * 10) / 10).toFixed(1)}R` : 'R n/a');
const tagOf = (symbol, tf, dir) => `${escapeHtml(symbol)} ${escapeHtml(tf || '')} ${dirArrow(dir)}`.replace(/\s+/g, ' ');
/** "SOL 3m ▼ SHORT" (HTML-escaped) for bot replies about one candidate. */
export const fmtTag = tagOf;
/** A level as the cards print it ("84,466.10"; "n/a" when missing). */
export const fmtLvl = (v) => lvl(v);

/**
 * R multiple of `price` against a trade: sign * (price - entry) / |entry - stop|
 * (sign +1 long, -1 short). Null on missing levels or a zero-width stop.
 */
export function rMultiple(direction, entry, stop, price) {
  if (![entry, stop, price].every(isNum) || entry === stop || (direction !== 'long' && direction !== 'short')) return null;
  const sign = direction === 'short' ? -1 : 1;
  return Math.round((sign * (price - entry) / Math.abs(entry - stop)) * 100) / 100;
}

/** Levels the Plan card prints: own plan (ready/conditional), own SETUP, rejected plan with levels, snapshot, else the candidate's. */
function planLevels(v) {
  const p = v.plan;
  const c = v.candidate || {};
  if (p && (p.status === 'ready' || p.status === 'conditional')) return { kind: 'plan', ...p };
  if (v.setup) return { kind: 'setup', ...v.setup };
  if (p && p.status === 'rejected' && isNum(p.entry)) return { kind: 'rejected', ...p, timeframe: p.timeframe || c.timeframe, direction: p.direction || c.direction };
  if (v.source === 'snapshot') {
    const sn = v.snap || {};
    return { kind: 'snapshot', timeframe: sn.timeframe, direction: sn.direction, entry: sn.entry, stop: sn.stop, tp1: sn.tp1 };
  }
  return { kind: 'candidate', timeframe: c.timeframe, direction: c.direction, entry: c.breakoutLevel, stop: c.invalidation, tp1: null };
}

/** Why this candidate is not a trade under the rules (never a code; see shortStandDownReason). */
function notTradeReason(v) {
  if (v.source === 'snapshot') return 'flag no longer live';
  const p = v.plan;
  if (p && p.status === 'rejected') return shortStandDownReason(p, ownRoom(v.rec, v.symbolPlan, v.candidateId));
  const st = v.candidate && v.candidate.state;
  if (st === 'forming' || st === 'proto') return 'not broken out yet';
  if (st === 'triggering') return 'breakout not confirmed yet';
  if (st === 'expired' || st === 'failed') return `flag ${st}`;
  if (st === 'confirmed' && v.symbolPlan && v.symbolPlan.candidateId !== v.candidateId) return 'another flag is the live plan';
  return 'no plan for this flag';
}

/** The readiness verdict for this candidate, in the alerts' words. */
function verdictFor(v, { levels = true } = {}) {
  if (v.source === 'snapshot') return `${bold('STAND DOWN')} — flag no longer live${v.at ? ` (as alerted ${escapeHtml(fmtTime(v.at))})` : ''}`;
  const c = v.candidate;
  if (c.state === 'expired' || c.state === 'failed') return `${bold('STAND DOWN')} — flag ${escapeHtml(c.state)}`;
  const kind = kindForState(c.state);
  return alertVerdict(kind, c, { plan: v.symbolPlan, rec: v.rec, asOf: v.asOf, levels });
}

/** alertVerdict kind for a candidate state (forming -> WATCH, triggering -> TRIGGERING, else BREAKOUT). */
const kindForState = (st) => (st === 'forming' || st === 'proto' ? 'WATCH' : st === 'triggering' ? 'TRIGGERING' : 'BREAKOUT');

function sizingLine(v) {
  const c = v.candidate || {};
  const r = isObj(c.risk) ? c.risk : null;
  if (r && !r.reason && isNum(r.suggestedLeverage) && isNum(r.collateralUsd)) {
    const wallet = isNum(r.lossAtStopPctOfWallet) ? ` (${r.lossAtStopPctOfWallet}% of wallet)` : '';
    return `Sizing: max ${isNum(r.maxLeverage) ? `${r.maxLeverage}x` : 'n/a'} · suggested ${r.suggestedLeverage}x · collateral ${fmtUsd(r.collateralUsd)} · size ${fmtUsd(r.suggestedLeverage * r.collateralUsd)} · loss at stop ${fmtUsd(r.lossAtStopUsd)}${wallet}`;
  }
  if (r) return `Sizing: unavailable (${escapeHtml(r.reason || 'incomplete risk block')})`;
  if (v.source === 'snapshot') return 'Sizing: unavailable (flag no longer live)';
  if (c.chaseRisk === true) return 'Sizing: unavailable (chase; the engine does not size a chase)';
  if (c.state === 'forming' || c.state === 'proto') return 'Sizing: unavailable (no breakout yet; the engine sizes triggering and confirmed flags)';
  return 'Sizing: unavailable (no risk block for this flag)';
}

function markVsKraken(v) {
  const kraken = isNum(v.price) ? ` · Kraken close ${fmtPrice(v.price)}` : '';
  const m = v.mark;
  if (!isObj(m) || m.status === 'unavailable' || !isNum(m.price)) return `Mark: unavailable${kraken}`;
  const drift = isNum(m.driftBps) ? ` · drift ${m.driftBps} bps${Math.abs(m.driftBps) > 10 ? ' (over 10)' : ''}` : '';
  return `Mark: ${fmtPrice(m.price)}${m.status === 'stale' ? ' STALE' : ''}${kraken}${drift}`;
}

/**
 * Expected length, honest: a measured candles-to-TP1 figure when the payload carries one
 * for this flag (pathOutlook), else n/a; always the candle timeframe, plus the path
 * history lean when pathOutlook describes this flag. Labeled as estimates.
 */
function expectLines(v, tf) {
  const po = v.pathOutlook;
  const n = po ? [po.candlesToTp1, po.medianCandlesToTp1].find(isNum) : undefined;
  const lines = [`Expect: ${isNum(n) ? `~${Math.round(n)} candles to TP1 (estimate from path history)` : 'n/a (no measured time-to-TP1 for this flag)'} · ${escapeHtml(tf || 'n/a')} candles`];
  if (po && po.likely) lines.push(`Path history (estimate): likely ${escapeHtml(PATH_WORDS[po.likely] || po.likely)} · lean ${escapeHtml(po.lean || 'n/a')} · n=${isNum(po.n) ? po.n : 'n/a'}${po.cal ? '' : ', thin sample'}`);
  return lines;
}

/**
 * Plan card (plan:<ref>): levels and sizing from engine fields only, in the visual
 * layout: `🧭 PLAN · <glyph> <b>SYM tf ▲ LONG</b>`, then LEVELS / SIZING / TIMING /
 * VERDICT. Only this candidate's own ready/conditional plan or SETUP is a trade; anything
 * else carries `🔴 <b>NOT A TRADE UNDER YOUR RULES — <short reason></b>` under the header
 * and still prints the levels on file (rejected plan, snapshot, or the candidate's
 * breakout/void); a missing target stays missing. Sizing only from the candidate's `risk`
 * block (size = suggested leverage x collateral).
 */
export function formatPlanCard(v) {
  const L = planLevels(v);
  const c = v.candidate || {};
  const tf = L.timeframe || c.timeframe;
  const dir = L.direction || c.direction;
  const tradeable = L.kind === 'plan' || L.kind === 'setup';
  const head = [`🧭 PLAN · ${glyph(v.symbol)} <b>${tagOf(v.symbol, tf, dir)}</b>`];
  if (!tradeable) head.push(`🔴 <b>NOT A TRADE UNDER YOUR RULES — ${notTradeReason(v)}</b>`);
  const stopPct = isNum(L.stopDistancePct) ? L.stopDistancePct
    : (isNum(L.entry) && isNum(L.stop) && L.entry > 0 ? Math.abs(L.entry - L.stop) / L.entry * 100 : null);
  const rows = [
    ['entry', lvl(L.entry)],
    ['stop', lvl(L.stop)],
    stopPct === null ? null : ['stop dist', `${Math.round(stopPct * 100) / 100}%`],
    ['TP1', isNum(L.tp1) ? lvl(L.tp1) : 'none'],
    isNum(L.tp2) ? ['TP2', lvl(L.tp2)] : null,
    isNum(L.grossRR) ? ['R gross·net', `${fmt1R(L.grossRR)} · ${fmt1R(L.netRR)}`] : (isNum(c.measuredRR) ? ['R measured', fmt1R(c.measuredRR)] : null)
  ];
  const notes = [
    `Flag ${escapeHtml(c.state || 'n/a')} · ${L.kind === 'candidate' ? 'entry = breakout level; enter only on a retest that holds' : L.kind === 'snapshot' ? 'levels as alerted' : 'entry = retest of the breakout'}${L.kind === 'setup' ? ' · SETUP waits for its trigger' : ''}`,
    isNum(L.grossRR) ? `Net R is after ${dir === 'short' ? 'short' : 'long'} costs.` : null,
    !isNum(L.tp1) ? `No plan target${isNum(c.measuredTarget) ? `; measured move ${lvl(c.measuredTarget)} is a pattern projection, not a target` : ''}.` : null
  ].filter(Boolean);
  const r = isObj(c.risk) ? c.risk : null;
  const sized = r && !r.reason && isNum(r.suggestedLeverage) && isNum(r.collateralUsd);
  const sizing = sized
    ? codeBlock([
      ['max lev', isNum(r.maxLeverage) ? `${r.maxLeverage}x` : 'n/a'],
      ['suggested', `${r.suggestedLeverage}x`],
      ['collateral', fmtUsd(r.collateralUsd)],
      ['size', fmtUsd(r.suggestedLeverage * r.collateralUsd)],
      ['loss at stop', fmtUsd(r.lossAtStopUsd)],
      ['% of wallet', isNum(r.lossAtStopPctOfWallet) ? `${r.lossAtStopPctOfWallet}%` : 'n/a']
    ])
    : sizingLine(v);
  return joinSections([
    head.join('\n'),
    `<b>LEVELS</b>\n${codeBlock(rows)}\n${notes.join('\n')}`,
    `<b>SIZING</b>\n${sizing}\n${markVsKraken(v)}`,
    `<b>TIMING</b>\n${expectLines(v, tf).join('\n')}`,
    `<b>VERDICT</b>\n${verdictFor(v, { levels: false })}`
  ]);
}

/** Short phrases for reason codes (codes never reach the owner); side-aware where the list decides the meaning. */
const REASON_PHRASES = Object.freeze({
  ready_flag_plan: 'plan ready: the retest held',
  valid_conditional_plan: 'valid plan, waiting on its trigger',
  rr_ok: 'enough R to TP1',
  net_rr_ok: 'enough R after fees',
  fees_heavy: 'fees eat the edge',
  net_rr_low: 'thin after fees',
  rr_below_min: 'not enough R to TP1',
  room_at_entry: 'entry sits inside a level',
  stop_distance_exceeds_cap: 'stop wider than the 3% cap',
  chase: 'price ran past the breakout',
  net_rr_below_min: 'too thin after fees',
  stop_inside_costs: 'stop inside trading costs',
  invalid_levels: 'levels invalid',
  stale_data: 'data stale',
  missing_data: 'data missing',
  unclassified_rejection: 'rejected for an unlisted reason',
  awaiting_breakout: 'waiting for the breakout close',
  awaiting_retest: 'waiting for the retest',
  ema21_flag_context: { support: 'price on the trade side of EMA21', oppose: 'price on the wrong side of EMA21', unknown: 'EMA21 side unclear' },
  top_down_context: { support: 'top-down trend agrees', oppose: 'top-down trend disagrees', unknown: 'top-down trend unclear' },
  ma_context_missing: 'EMA21/EMA200 context missing',
  top_down_missing: 'top-down trend unavailable',
  'td:unknown': 'top-down trend unavailable',
  first_level_ahead: 'first level ahead is mapped',
  level_context_missing: 'no level ahead detected',
  'level:none': 'no level beyond the breakout',
  'a200:unknown': 'EMA200 count unavailable',
  'ema200:1w:missing': 'weekly EMA200 unavailable',
  'ema200:counter': 'against EMA200',
  '4h:unknown': '4h lean unavailable',
  '4h:with': '4h lean with the trade',
  'ct:4h': '4h lean against the trade',
  'stoch:ob-cross': 'Stoch RSI overbought with a bearish cross',
  'stoch:os-cross': 'Stoch RSI oversold with a bullish cross',
  divergence_missing: 'divergence not evaluated',
  divergence_undirected: 'divergence with no direction to compare',
  divergence_agrees: 'Stoch RSI divergence agrees',
  divergence_conflicts: 'Stoch RSI divergence against the trade',
  divergence_absent: 'no Stoch RSI divergence',
  data_partial: 'some timeframes unavailable',
  data_fresh: 'flag timeframes fresh',
  market_data_unavailable: 'market data unavailable',
  need_confirmed_flag_plan: 'needs a confirmed flag plan',
  fresh_closed_candles: 'needs fresh closed candles',
  new_valid_plan: 'needs a new plan that passes the rules',
  entry_condition: 'the entry condition must print',
  call_changes_on_invalidation: 'changes on invalidation or a blocked TP1'
});

const REASON_PATTERNS = [
  [/^td:(\w+):(\d)\/4$/, (m) => `top-down ${m[1]} ${m[2]}/4 aligned`],
  [/^a200:(\d+)\/(\d+)$/, (m) => `above EMA200 on ${m[1]} of ${m[2]} timeframes`],
  [/^ema200:(\w+):(above|below)$/, (m) => `${m[1]} price ${m[2]} EMA200`],
  [/^ema200:(\w+):unknown$/, (m) => `${m[1]} EMA200 side unknown`],
  [/^4h:(bull|bear|flat)$/, (m) => `4h lean ${m[1]}`],
  [/^conflict:(\w+)-(long|short)$/, (m) => `opposite ${m[1]} ${m[2]} flag active`],
  [/^rr:([\d.]+)$/, (m) => `measured move only ${m[1]}R`],
  [/^level:(\w+):([\d.]+)$/, (m, side) => (side === 'oppose' ? `a ${m[1]} level at ${lvl(Number(m[2]))} sits before the target` : `first ${m[1]} level ${lvl(Number(m[2]))} is beyond the target`)],
  [/^chan:(\w+):(\w+):(\w+)$/, (m) => `at the ${m[1]} channel ${m[2]}, ${m[3]} break odds`],
  [/^tp1_capped:([\d.]+)$/, (m) => `TP1 capped by a level at ${lvl(Number(m[1]))}`],
  [/^data_stale:(.+)$/, (m) => `${m[1]} candles stale`],
  [/^(stale_data|missing_data):(\w+)$/, (m) => `${m[2]} candles ${m[1] === 'stale_data' ? 'stale' : 'missing'}`],
  [/^candidate:(\w+)-(long|short)-(\w+)$/, (m) => `nearest flag: ${m[1]} ${m[2]} ${m[3]}`],
  [/^room:blocked-(\w+)$/, (m) => `a ${m[1]} level blocks the measured target`]
];

/**
 * Reason code -> a short plain phrase (`side` = support | oppose | unknown for codes whose
 * meaning depends on the list). An unmapped code comes back as itself.
 */
export function reasonPhrase(code, side = 'unknown') {
  const c = String(code || '');
  const hit = REASON_PHRASES[c];
  if (typeof hit === 'string') return hit;
  if (isObj(hit)) return hit[side] || hit.unknown;
  for (const [re, fn] of REASON_PATTERNS) {
    const m = c.match(re);
    if (m) return fn(m, side);
  }
  return c;
}

/** The candidate the symbol's recommendation was built for (plan, SETUP, else WATCH candidate). */
function recOwnerId(rec, plan) {
  return roomOwnerId(rec, plan) || (isObj(rec) && isObj(rec.candidate) ? rec.candidate.candidateId : null) || (isObj(rec) ? rec.candidateId || null : null);
}

/** What has to happen for this candidate to become GO IN, in one plain sentence. */
function goInCondition(v) {
  if (v.source === 'snapshot') return 'n/a — this flag is no longer live; send /signals.';
  const p = v.plan;
  const c = v.candidate || {};
  if (p && p.status === 'ready') return 'it already is: the retest held.';
  if (p && p.status === 'conditional' && p.entryCondition) return `${escapeHtml(p.entryCondition)}.`;
  if (v.setup && v.setup.entryCondition) return `${escapeHtml(v.setup.entryCondition)}.`;
  if (p && p.status === 'rejected') return `not on these levels (${shortStandDownReason(p, ownRoom(v.rec, v.symbolPlan, v.candidateId))}); it needs a new plan that passes your rules.`;
  if (c.state === 'forming' || c.state === 'proto') return `${triggerWords('forming', { timeframe: c.timeframe, direction: c.direction, level: c.breakoutLevel })}, and the plan must pass your R and stop rules.`;
  if (c.state === 'triggering') return `${triggerWords('triggering', { timeframe: c.timeframe, direction: c.direction, level: c.breakoutLevel })}.`;
  if (c.state === 'confirmed') return `this flag must become the live plan, then ${triggerWords('retest', { timeframe: c.timeframe, direction: c.direction, level: c.breakoutLevel })}.`;
  return `n/a — flag ${escapeHtml(c.state || 'unknown')}.`;
}

/**
 * Thesis card (thesis:<ref>) in the visual layout: `🧠 THESIS · <glyph> <b>SYM tf ▼ SHORT</b>`,
 * the candidate's own line (state, measured R, room R) and counter-trend note, then
 * SUPPORTS (✔) / AGAINST (✖) / UNKNOWN (?) from the symbol's flagRecommendation as short
 * phrases (never codes), WHAT CHANGES THE CALL, and TO BECOME GO IN. Lists shrink (and
 * long lines are cut) until the card fits MAX_CARD_CHARS.
 */
export function formatThesisCard(v) {
  const c = v.candidate || {};
  const head = `🧠 THESIS · ${glyph(v.symbol)} <b>${tagOf(v.symbol, c.timeframe, c.direction)}</b>`;
  if (v.source === 'snapshot') {
    return joinSections([
      head,
      `This flag is no longer live (as alerted ${escapeHtml(fmtTime(v.at))}).\n${codeBlock([['brk', lvl(c.breakoutLevel)], ['void', lvl(c.invalidation)], ['meas', fmt1R(c.measuredRR)]])}`,
      `<b>TO BECOME GO IN</b>\n${goInCondition(v)}`
    ]);
  }
  const room = ownRoom(v.rec, v.symbolPlan, v.candidateId);
  const roomText = room && isNum(room.r) ? `room ${fmt1R(room.r)}${isNum(room.levelPrice) ? ` to ${lvl(room.levelPrice)}` : ''}${room.levelSource ? ` (${escapeHtml(room.levelSource)})` : ''}` : 'room n/a';
  const intro = [`This flag: ${escapeHtml(c.state || 'n/a')} · measured ${fmt1R(c.measuredRR)} · ${roomText}`];
  const ct = String(counterTrendTag(v.rec, c.direction) || '').match(/td:(bull|bear) (\d)\/4/);
  if (ct) intro.push(`Counter-trend: the top-down trend is ${ct[1]} (${ct[2]}/4), against this ${dirArrow(c.direction)}.`);
  const owner = recOwnerId(v.rec, v.symbolPlan);
  if (owner && owner !== v.candidateId) {
    const o = liveCandidate(v.s, owner);
    intro.push(`Symbol read, built for the ${o ? `${escapeHtml(o.timeframe)} ${dirArrow(o.direction)}` : 'other'} flag; it fits this one only in part.`);
  }
  const phrases = (items, side) => [...new Set((Array.isArray(items) ? items : [])
    .map((r) => (typeof r === 'string' ? reasonPhrase(r, side) : (r && r.code ? reasonPhrase(r.code, side) : null))).filter(Boolean))];
  const lists = [
    ['SUPPORTS', '✔', phrases(v.rec.supports, 'support')],
    ['AGAINST', '✖', phrases(v.rec.opposes, 'oppose')],
    ['UNKNOWN', '?', phrases(v.rec.unknowns, 'unknown')],
    ['WHAT CHANGES THE CALL', '•', (Array.isArray(v.rec.changeConditions) ? v.rec.changeConditions : [])
      .map((r) => (isObj(r) ? (r.text || reasonPhrase(r.code)) : reasonPhrase(r))).filter(Boolean)]
  ];
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  const render = (maxItems, maxLen) => joinSections([
    head,
    intro.join('\n'),
    ...lists.map(([title, mark, items]) => {
      const shown = items.slice(0, maxItems).map((t) => `${mark} ${escapeHtml(cut(String(t), maxLen))}`);
      const more = items.length > maxItems ? `\n+${items.length - maxItems} more (/why ${escapeHtml(v.symbol)})` : '';
      return `<b>${title}</b>\n${shown.length ? shown.join('\n') : `${mark} none`}${more}`;
    }),
    `<b>TO BECOME GO IN</b>\n${goInCondition(v)}`
  ]);
  for (const [n, len] of [[5, 110], [4, 90], [3, 80], [2, 70], [1, 60]]) {
    const text = render(n, len);
    if (text.length <= MAX_CARD_CHARS) return text;
  }
  return render(1, 50);
}

// ---------------------------------------------------------------- tracking

/**
 * A state.tracked entry from a candidate snapshot (candidateSnapshot shape). `ready` when
 * the candidate's own plan is already ready (so GET IN NOW is not re-sent and TP1/stop are
 * watched), `took` when the owner tapped Took it (TP1/stop watched, close buttons).
 */
export function trackEntry(snap, nowMs, { took = false, ready = false, setupSeen = false } = {}) {
  return {
    ref: shortRef(snap.candidateId), symbol: snap.symbol, candidateId: snap.candidateId,
    timeframe: snap.timeframe || null, direction: snap.direction || null, since: new Date(nowMs).toISOString(),
    lastState: snap.state || null, setupSeen: Boolean(setupSeen), ready: Boolean(ready), took: Boolean(took),
    entry: isNum(snap.entry) ? snap.entry : null, stop: isNum(snap.stop) ? snap.stop : null, tp1: isNum(snap.tp1) ? snap.tp1 : null,
    breakoutLevel: isNum(snap.breakoutLevel) ? snap.breakoutLevel : (isNum(snap.entry) ? snap.entry : null),
    invalidation: isNum(snap.invalidation) ? snap.invalidation : (isNum(snap.stop) ? snap.stop : null),
    measuredRR: isNum(snap.measuredRR) ? snap.measuredRR : null, hit: null
  };
}

const liveTracked = (list, nowMs) => (Array.isArray(list) ? list : []).filter((t) => isObj(t) && nowMs - Date.parse(t.since) < TRACK_TTL_MS);

/**
 * Apply a tracking change to stored state text. change.action:
 *   track   add `change.entry` (took merges into an existing entry: took + its levels);
 *           full list (TRACK_MAX) -> a took evicts the oldest untaken entry, else 'full'
 *   untrack / closed  remove by ref       stillin  clear the hit (re-arms TP1/stop + nudge)
 * @returns {{text:string, result:string, entry:Object|null}} result: tracked | took | already | full | untracked | not_tracked | rearmed
 */
export function applyTrackChange(text, change, nowMs) {
  const state = parseState(text);
  let list = liveTracked(state.tracked, nowMs);
  const ref = change.ref || (change.entry && change.entry.ref);
  const idx = list.findIndex((t) => t.ref === ref);
  let result;
  let entry = idx === -1 ? null : list[idx];
  if (change.action === 'track') {
    const e = change.entry;
    if (idx !== -1) {
      if (e.took && !list[idx].took) {
        entry = { ...list[idx], took: true, entry: e.entry ?? list[idx].entry, stop: e.stop ?? list[idx].stop, tp1: e.tp1 ?? list[idx].tp1 };
        list[idx] = entry;
        result = 'took';
      } else result = 'already';
    } else {
      if (list.length >= TRACK_MAX) {
        const drop = e.took ? list.findIndex((t) => !t.took) : -1;
        if (drop === -1) return { text: `${JSON.stringify({ ...state, tracked: list }, null, 2)}\n`, result: 'full', entry: null };
        list.splice(drop, 1);
      }
      list.push(e);
      entry = e;
      result = 'tracked';
    }
  } else if (change.action === 'untrack' || change.action === 'closed') {
    if (idx === -1) result = 'not_tracked';
    else { list = list.filter((t) => t.ref !== ref); result = 'untracked'; }
  } else if (change.action === 'stillin') {
    if (idx === -1) result = 'not_tracked';
    else { entry = { ...list[idx], hit: null }; list[idx] = entry; result = 'rearmed'; }
  } else result = 'noop';
  state.tracked = list;
  return { text: `${JSON.stringify(state, null, 2)}\n`, result, entry };
}

/** Close-flow buttons on a TP1 / stop alert of a taken trade: Closed here, Partial (TP1 only), Still in. */
export function hitKeyboard(ref, kind) {
  return {
    inline_keyboard: [[
      { text: 'Closed here', callback_data: `closed:${ref}` },
      ...(kind === 'tp1' ? [{ text: 'Partial', callback_data: `partial:${ref}` }] : []),
      { text: 'Still in', callback_data: `stillin:${ref}` }
    ]]
  };
}

/** /tracking: ⚪ header, one line per tracked candidate; `[NOT TRACKING ANYTHING]` when empty. */
export function formatTrackingList(tracked, nowMs) {
  const list = liveTracked(tracked, nowMs);
  if (!list.length) return '[NOT TRACKING ANYTHING] — tap Track on an alert or on /signals.';
  return joinSections([`⚪ 🔔 <b>TRACKING</b> · ${list.length} of ${TRACK_MAX}`, list.map((t) => {
    const phase = t.hit ? `${t.hit.kind === 'tp1' ? 'TP1' : 'stop'} hit, awaiting close` : t.took ? 'in trade (took it)' : t.ready ? 'plan ready' : escapeHtml(t.lastState || 'n/a');
    const left = Math.max(0, Math.round((TRACK_TTL_MS - (nowMs - Date.parse(t.since))) / 60_000));
    return `${glyph(t.symbol)} <b>${tagOf(t.symbol, t.timeframe, t.direction)}</b> · brk ${lvl(t.breakoutLevel)} · ${phase} · ${left} min left`;
  }).join('\n')]);
}

/** /tracking buttons: Plan / Thesis / Untrack per tracked candidate. */
export function trackingKeyboard(tracked, nowMs) {
  const rows = liveTracked(tracked, nowMs).map((t) => {
    const tag = ` ${t.symbol} ${t.timeframe || ''}`.trimEnd();
    return [{ text: `Plan${tag}`, callback_data: `plan:${t.ref}` }, { text: `Thesis${tag}`, callback_data: `thesis:${t.ref}` }, { text: `Untrack${tag}`, callback_data: `untrack:${t.ref}` }];
  });
  return rows.length ? { inline_keyboard: rows } : null;
}

/**
 * Tracked-candidate transitions for one cron run (any alert level). Mutates
 * state.tracked; returns alerts {kind:'TRACK'|'NUDGE', symbol, candidateId, ref, text, replyMarkup?}.
 * Not in a trade: void (candidate failed, or the Kraken close is through the void level),
 * gone, expired, plan READY (GET IN NOW + Plan card), SETUP appears, state change
 * (forming -> triggering -> confirmed); at most one alert per candidate per run.
 * In a trade (plan was ready, or Took it): TP1 / stop hit on the mark (Kraken close when
 * the mark is not ok) with R at that price. A taken trade keeps tracking with
 * Closed here / Partial / Still in buttons and gets one NUDGE after NUDGE_AFTER_MS;
 * an untaken one ends. Every entry ends after TRACK_TTL_MS (TRACK ENDED).
 */
/** A trackStory story as escaped Telegram lines (📍 now / ⏳ wait / 🚫 line / 🔮 next). */
const storyBlock = (story) => storyText(story).map(escapeHtml).join('\n');

export function diffTracked(state, payload, nowMs) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const dataOk = payload && payload.dataStatus !== 'unavailable';
  const nowIso = new Date(nowMs).toISOString();
  const alerts = [];
  const keep = [];
  // `event` + `trackLevels` feed the sent-alert log (lib/telegramLog.js): what happened to
  // the tracked candidate, and its levels when the candidate is no longer in the payload.
  const push = (t, text, replyMarkup = null, kind = 'TRACK', more = null, event = null) => alerts.push({
    kind, symbol: t.symbol, candidateId: t.candidateId, ref: t.ref, text, ...(replyMarkup ? { replyMarkup } : {}), ...(more ? { more } : {}),
    event, trackLevels: { timeframe: t.timeframe || null, direction: t.direction || null, entry: t.entry ?? null, stop: t.stop ?? null, tp1: t.tp1 ?? null, breakoutLevel: t.breakoutLevel ?? null, invalidation: t.invalidation ?? null }
  });
  const head = (t, dot, kind) => msgHeader(dot, t.symbol, t.timeframe, t.direction, kind);
  const ended = (t, kind, detail) => push(t, joinSections([head(t, '🔴', `TRACK · ${kind}`), detail, `${bold('STAND DOWN')} — tracking ended.`]), null, 'TRACK', null, kind.toLowerCase());
  for (const t of Array.isArray(state.tracked) ? state.tracked : []) {
    if (!isObj(t)) continue;
    if (!(nowMs - Date.parse(t.since) < TRACK_TTL_MS)) {
      push(t, joinSections([head(t, '⚪', 'TRACK ENDED'), '6 h limit reached. Tap Track again to keep following it.']), null, 'TRACK', null, 'ttl');
      continue;
    }
    const s = syms[t.symbol];
    if (!dataOk || !isObj(s)) { keep.push(t); continue; }
    if (t.took || t.ready) {
      const mk = isObj(s.mark) && s.mark.status === 'ok' && isNum(s.mark.price) ? s.mark.price : null;
      const px = mk !== null ? mk : (isNum(s.price) ? s.price : null);
      const src = mk !== null ? 'mark' : 'Kraken close';
      const levels = (price, psrc, r) => codeBlock([['entry', lvl(t.entry)], ['stop', lvl(t.stop)], ['TP1', lvl(t.tp1)], [psrc === 'mark' ? 'mark' : 'close', lvl(price)], ['R at exit', fmtSignedR(r)]]);
      if (!t.hit && px !== null) {
        const sign = t.direction === 'short' ? -1 : 1;
        const stopHit = isNum(t.stop) && sign * (px - t.stop) <= 0;
        const tpHit = isNum(t.tp1) && sign * (px - t.tp1) >= 0;
        if (stopHit || tpHit) {
          const kind = stopHit ? 'stop' : 'tp1';
          const r = rMultiple(t.direction, t.entry, t.stop, px);
          const h = head(t, kind === 'tp1' ? '🟢' : '🔴', `TRACK · ${kind === 'tp1' ? 'TP1 HIT' : 'STOP HIT'}`);
          const plain = kind === 'tp1'
            ? 'TP1 hit. Take some profit and move your stop to entry so this cannot turn into a loss.'
            : 'Stopped out. That is the plan working: a small, planned loss. Nothing to fix, wait for the next setup.';
          if (t.took) {
            const hit = { kind, price: px, src, r, at: nowIso, nudged: false };
            push(t, joinSections([h, levels(px, src, r), escapeHtml(plain), `Journal it: ${kind === 'tp1' ? 'Closed here, Partial or Still in' : 'Closed here or Still in'}.`]), hitKeyboard(t.ref, kind), 'TRACK', null, kind);
            keep.push({ ...t, hit });
          } else push(t, joinSections([h, levels(px, src, r), escapeHtml(plain), 'Tracking ended (you did not tap Took it).']), null, 'TRACK', null, kind);
          continue;
        }
        // Live trade, nothing hit: a plain update when R moves a half-R bucket, else a quiet check-in.
        const r = rMultiple(t.direction, t.entry, t.stop, px);
        const sig = `trade|${rBucket(r)}`;
        const st = isObj(t.story) ? t.story : {};
        const since = isNum(st.at) ? nowMs - st.at : Infinity;
        const changed = sig !== st.sig && since >= STORY_MIN_GAP_MS;
        if (changed || since >= STORY_HEARTBEAT_MS) {
          const story = tradeStory({ tf: t.timeframe, direction: t.direction, entry: t.entry, stop: t.stop, tp1: t.tp1, price: px, r, fmt: lvl });
          push(t, joinSections([head(t, r !== null && r >= 0 ? '🟢' : '🟡', `TRACK · ${changed ? 'UPDATE' : 'CHECK-IN'}`), storyBlock(story)]), null, 'TRACK', null, 'story');
          keep.push({ ...t, story: { ...st, sig, at: nowMs } });
          continue;
        }
      } else if (t.hit && t.took && !t.hit.nudged && nowMs - Date.parse(t.hit.at) >= NUDGE_AFTER_MS) {
        push(t, joinSections([
          head(t, '🟡', 'REMINDER'),
          levels(t.hit.price, t.hit.src, t.hit.r),
          `${t.hit.kind === 'tp1' ? 'TP1' : 'Stop'} hit ${fmtAge(t.hit.at, nowMs)} · no close journaled.`
        ]), hitKeyboard(t.ref, t.hit.kind), 'NUDGE', null, 'nudge');
        keep.push({ ...t, hit: { ...t.hit, nudged: true } });
        continue;
      }
      keep.push(t);
      continue;
    }
    const c = liveCandidate(s, t.candidateId);
    const inv = c && isNum(c.invalidation) ? c.invalidation : t.invalidation;
    const trig = c && isNum(c.breakoutLevel) ? c.breakoutLevel : t.breakoutLevel;
    // Probe sample: the 1m close, or the mark when it sits further past the trigger (catches some wick pokes).
    const mk = isObj(s.mark) && s.mark.status === 'ok' && isNum(s.mark.price) ? s.mark.price : null;
    const probePx = mk === null || !isNum(s.price) ? s.price : (t.direction === 'short' ? Math.min(s.price, mk) : Math.max(s.price, mk));
    const probes = updateProbes(t.story, { price: probePx, trigger: trig, direction: t.direction });
    const through = isNum(s.price) && isNum(inv) && (t.direction === 'short' ? s.price > inv : s.price < inv);
    const word = t.direction === 'short' ? 'short' : 'long';
    const fz = failureZone(s.geometryContext, t.direction, s.price);
    const whereNext = fz ? ` Next area price may head to: ${lvl(fz.low)}–${lvl(fz.high)} (${fz.tf}).` : '';
    if (through || (c && c.state === 'failed')) {
      const why = through
        ? `Price closed ${t.direction === 'short' ? 'above' : 'below'} ${lvl(inv)}, the line that had to hold. The ${word} idea is dead.`
        : failWords(c.failReason, t.direction);
      ended(t, 'VOID', escapeHtml(`${why}${probes.probes > 0 ? ` It was defended ${probes.probes}× before it broke.` : ''}${whereNext} Nothing to do: stay out of this one.`));
      continue;
    }
    if (!c) { ended(t, 'GONE', escapeHtml('The engine no longer sees this flag (the pattern fell apart). Nothing to do.')); continue; }
    if (c.state === 'expired') { ended(t, 'EXPIRED', escapeHtml('The break never came in time, so the setup went stale. Nothing to do.')); continue; }
    const v = liveView(t.symbol, s, t.candidateId, payload);
    const story = watchStory({
      symbol: t.symbol, tf: t.timeframe || c.timeframe, direction: t.direction, state: c.state, trigger: trig, voidLevel: inv,
      price: s.price, probes: probes.probes, extreme: probes.extreme, etaMin: etaToNextClose(nowIso, t.timeframe || c.timeframe),
      path: v.pathOutlook, geometryContext: s.geometryContext, rec: v.rec, fmt: lvl
    });
    const sig = `watch|${c.state}|${probes.probes}|${probes.beyond ? 1 : 0}`;
    const st0 = isObj(t.story) ? t.story : {};
    const next = { ...t, lastState: c.state, setupSeen: t.setupSeen || Boolean(v.setup), breakoutLevel: trig, invalidation: inv, story: { ...st0, ...probes } };
    const kb = tradeKeyboard(t.symbol, t.timeframe, t.candidateId, { tracked: true });
    const opts = { rec: v.rec, plan: v.symbolPlan, asOf: v.asOf, mark: s.mark };
    const before = alerts.length;
    if (v.plan && v.plan.status === 'ready') {
      Object.assign(next, { ready: true, entry: v.plan.entry ?? t.entry, stop: v.plan.stop ?? t.stop, tp1: v.plan.tp1 ?? t.tp1 });
      push(t, joinSections([alertMessage('TRACK · GET IN NOW', t.symbol, c, { ...opts, verdictKind: 'BREAKOUT' }), escapeHtml('Retest held. This is the entry. Use the plan levels below; the stop goes in with the order.')]), kb, 'TRACK', [formatPlanCard(v)], 'get_in_now');
      alerts[alerts.length - 1].chart = { symbol: t.symbol, timeframe: t.timeframe || v.plan.timeframe };
    } else if (v.setup && !t.setupSeen) {
      push(t, joinSections([alertMessage('TRACK · SETUP', t.symbol, c, { ...opts, verdictKind: 'SETUP' }), storyBlock(story)]), kb, 'TRACK', null, 'setup');
    } else if (c.state !== t.lastState) {
      push(t, joinSections([alertMessage(`TRACK · ${escapeHtml(String(c.state).toUpperCase())}`, t.symbol, c, { ...opts, verdictKind: kindForState(c.state), verdict: verdictFor(v, { levels: false }) }), storyBlock(story)]), kb, 'TRACK', null, `state:${c.state}`);
    } else {
      // No state change: a plain update when the story moved (new probe, price crossed the trigger), else a quiet check-in.
      const since = isNum(st0.at) ? nowMs - st0.at : Infinity;
      const changed = sig !== st0.sig && since >= STORY_MIN_GAP_MS;
      if (changed || since >= STORY_HEARTBEAT_MS) {
        push(t, joinSections([head(t, '⚪', `TRACK · ${changed ? 'UPDATE' : 'CHECK-IN'}`), storyBlock(story)]), kb, 'TRACK', null, 'story');
      }
    }
    if (alerts.length > before) next.story = { ...next.story, sig, at: nowMs };
    keep.push(next);
  }
  state.tracked = keep;
  return alerts;
}

// ---------------------------------------------------------------- positions (journal opens)

/** The ref a journal open is closed by: its candidate's ref when it names one, else its own id's. */
export function positionRef(open) {
  const cid = isObj(open && open.engineRef) ? open.engineRef.candidateId : null;
  return shortRef(cid || (open && open.id));
}

/**
 * Journal records -> open trades (newest first): each close (oldest first) closes the
 * latest earlier open with the same engineRef.candidateId, else the latest open of the
 * same symbol (and direction when both name one).
 */
export function openPositions(records) {
  const rows = (Array.isArray(records) ? records : []).filter(isObj)
    .slice().sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0));
  const opens = [];
  const lastIdx = (fn) => { for (let i = opens.length - 1; i >= 0; i--) if (fn(opens[i])) return i; return -1; };
  for (const r of rows) {
    if (r.kind === 'open') { opens.push(r); continue; }
    if (r.kind !== 'close') continue;
    const cid = isObj(r.engineRef) ? r.engineRef.candidateId : null;
    let i = cid ? lastIdx((o) => isObj(o.engineRef) && o.engineRef.candidateId === cid) : -1;
    if (i === -1 && r.symbol) i = lastIdx((o) => o.symbol === r.symbol && (!r.direction || !o.direction || o.direction === r.direction));
    if (i !== -1) opens.splice(i, 1);
  }
  return opens.reverse();
}

/** Timeframe named in an open's text ("Took (button): SOL 3m SHORT ..."), else 5m. */
function openTimeframe(open) {
  const m = String(open && open.text || '').match(/\b(1m|3m|5m|15m|1h|4h)\b/);
  return m ? m[1] : '5m';
}

/** Price to judge an open trade on: the mark when ok, else the Kraken close. */
export function livePrice(s) {
  if (isObj(s && s.mark) && s.mark.status === 'ok' && isNum(s.mark.price)) return { price: s.mark.price, src: 'mark' };
  return isNum(s && s.price) ? { price: s.price, src: 'Kraken close' } : null;
}

/**
 * /positions in the visual layout: one block per open trade, `🟢|🔴 <glyph> <b>▲|▼ SYM
 * DIRECTION</b> · OPEN` (dot by the sign of the unrealized R; ⚪ when unknown), then
 * entry / stop / TP1 / live price / R now / R to stop / R to TP1 / age, monospace.
 * Blocks past MAX_CARD_CHARS become a "+n more" line. `[NO OPEN TRADES]` when none.
 */
export function formatPositions(opens, payload, nowMs) {
  if (!Array.isArray(opens) || !opens.length) return '[NO OPEN TRADES]';
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const blocks = opens.map((o) => {
    const lp = livePrice(syms[o.symbol]);
    const risk = isNum(o.entry) && isNum(o.stop) ? Math.abs(o.entry - o.stop) : null;
    const sign = o.direction === 'short' ? -1 : 1;
    const rNow = lp ? rMultiple(o.direction, o.entry, o.stop, lp.price) : null;
    const toStop = lp && risk ? sign * (lp.price - o.stop) / risk : null;
    const toTp = lp && risk && isNum(o.tp1) ? sign * (o.tp1 - lp.price) / risk : null;
    const dot = isNum(rNow) ? (rNow >= 0 ? '🟢' : '🔴') : '⚪';
    const arrow = o.direction === 'short' ? '▼' : o.direction === 'long' ? '▲' : '•';
    const head = `${dot} ${glyph(o.symbol)} <b>${arrow} ${escapeHtml(o.symbol || '?')} ${o.direction ? DIR(o.direction) : 'NO DIRECTION'}</b> · OPEN`;
    return `${head}\n${codeBlock([
      ['entry', lvl(o.entry)], ['stop', lvl(o.stop)], ['TP1', lvl(o.tp1)],
      [lp && lp.src === 'mark' ? 'mark' : 'close', lp ? lvl(lp.price) : 'n/a'],
      ['R now', fmtSignedR(rNow)], ['to stop', isNum(toStop) ? fmt1R(toStop) : 'n/a'], ['to TP1', isNum(toTp) ? fmt1R(toTp) : 'n/a'],
      ['age', fmtAge(o.saidAt || o.receivedAt, nowMs).replace(' ago', '')]
    ])}`;
  });
  const out = [];
  for (const b of blocks) {
    if (joinSections([...out, b]).length > MAX_CARD_CHARS - 40) break;
    out.push(b);
  }
  const more = blocks.length - out.length;
  return `${joinSections(out)}${more ? `\n${RULE}\n+${more} more open trade${more === 1 ? '' : 's'}` : ''}`;
}

/** /positions buttons: `Close SYM @ mark` (pclose:<ref>) and `Chart SYM` per open trade (max 10). */
export function positionsKeyboard(opens) {
  const rows = (Array.isArray(opens) ? opens : []).slice(0, 10).map((o) => [
    { text: `Close ${o.symbol} @ mark`, callback_data: `pclose:${positionRef(o)}` },
    { text: `Chart ${o.symbol}`, callback_data: `chart:${SYMBOLS.includes(o.symbol) ? o.symbol : 'BTC'}:${openTimeframe(o)}` }
  ]);
  return rows.length ? { inline_keyboard: rows } : null;
}

/**
 * Journal body closing (kind close, resultR vs the open's entry/stop) or partly closing
 * (kind adjust, text "partial at TP1") an open trade at `exitPrice`. id tg_close_<ref> /
 * tg_adjust_<ref>, so a double tap logs once. Linked by the open's engineRef.
 */
export function closeBody(open, { kind = 'close', exitPrice, src = 'mark', ref, levels = null }) {
  const lv = isObj(levels) ? levels : {};
  const entry = isNum(open.entry) ? open.entry : lv.entry;
  const stop = isNum(open.stop) ? open.stop : lv.stop;
  const r = rMultiple(open.direction, entry, stop, exitPrice);
  const what = kind === 'adjust' ? 'partial at TP1' : 'Closed (button)';
  const body = {
    id: `tg_${kind}_${ref}`, kind, symbol: open.symbol || null, direction: open.direction || null,
    engineRef: isObj(open.engineRef) ? { candidateId: open.engineRef.candidateId ?? null, planId: open.engineRef.planId ?? null, recClass: open.engineRef.recClass ?? null, reasonCode: open.engineRef.reasonCode ?? null } : null,
    text: `${what}: ${open.symbol || ''} ${open.direction ? DIR(open.direction) : ''} at ${isNum(exitPrice) ? exitPrice : 'n/a'} (${src})${kind === 'close' && isNum(r) ? ` · ${fmtSignedR(r)}` : ''}`.replace(/\s+/g, ' ')
  };
  for (const [k, val] of Object.entries({ entry, stop, tp1: open.tp1, exitPrice })) if (isNum(val) && val > 0) body[k] = val;
  if (kind === 'close' && isNum(r)) body.resultR = r;
  return body;
}

// ---------------------------------------------------------------- /market

/**
 * 24h move for one symbol from published closed candles: the last 24 1h candles, else the
 * last 6 4h candles (the payload publishes 20 per timeframe), else null. Never invented.
 * @returns {{changePct:number, low:number, high:number, source:'1h'|'4h'}|null}
 */
export function dayMove(s) {
  const tfs = isObj(s && s.timeframes) ? s.timeframes : {};
  for (const [tf, n] of [['1h', 24], ['4h', 6]]) {
    const candles = isObj(tfs[tf]) && Array.isArray(tfs[tf].candles) ? tfs[tf].candles.filter((c) => isObj(c) && [c.o, c.h, c.l, c.c].every(isNum)) : [];
    if (candles.length < n) continue;
    const w = candles.slice(-n);
    const open = w[0].o;
    const close = w[w.length - 1].c;
    if (!(open > 0)) continue;
    return { changePct: Math.round(((close - open) / open) * 10000) / 100, low: Math.min(...w.map((c) => c.l)), high: Math.max(...w.map((c) => c.h)), source: tf };
  }
  return null;
}

/** Top-down {sentiment, aligned} from payload topDown (bias build), else the rec's td:<s>:<n>/4 code. */
function topDownOf(s) {
  if (isObj(s && s.topDown) && typeof s.topDown.sentiment === 'string') return { sentiment: s.topDown.sentiment, aligned: isNum(s.topDown.aligned) ? s.topDown.aligned : null };
  const rec = isObj(s && s.flagRecommendation) ? s.flagRecommendation : {};
  const m = [...(rec.supports || []), ...(rec.opposes || []), ...(rec.unknowns || [])].map((x) => String(typeof x === 'string' ? x : x && x.code).match(/^td:(\w+):(\d)\/4$/)).find(Boolean);
  return m ? { sentiment: m[1], aligned: Number(m[2]) } : null;
}

/** EMA200 count {count, of} from topDown.above200, else the rec's a200:<n>/<m> code. */
function above200Of(s) {
  const a = isObj(s && s.topDown) && isObj(s.topDown.above200) ? s.topDown.above200 : null;
  if (a && isNum(a.count) && isNum(a.of)) return a;
  const rec = isObj(s && s.flagRecommendation) ? s.flagRecommendation : {};
  const m = [...(rec.supports || []), ...(rec.opposes || []), ...(rec.unknowns || [])].map((x) => String(typeof x === 'string' ? x : x && x.code).match(/^a200:(\d+)\/(\d+)$/)).find(Boolean);
  return m ? { count: Number(m[1]), of: Number(m[2]) } : null;
}

/** Bias-matrix label for a timeframe (long / short / neutral), else the top-down lean, else null. */
function leanOf(s, tf) {
  const b = isObj(s && s.biasMatrix) && isObj(s.biasMatrix[tf]) ? s.biasMatrix[tf].bias : null;
  if (typeof b === 'string') return b;
  const l = isObj(s && s.topDown) && isObj(s.topDown.leans) ? s.topDown.leans[tf] : null;
  return typeof l === 'string' ? ({ bull: 'long', bear: 'short' }[l] || l) : null;
}

/** Stoch RSI state on a timeframe: overbought | oversold | neutral, null when not published. */
function stochOf(s, tf) {
  const st = isObj(s && s.timeframes) && isObj(s.timeframes[tf]) && isObj(s.timeframes[tf].stochRsi) ? s.timeframes[tf].stochRsi.state : null;
  if (typeof st !== 'string') return null;
  const x = st.toLowerCase();
  return x === 'overbought' || x === 'oversold' ? x : 'neutral';
}

/**
 * The market lean, by rule over the symbols' engine fields:
 *   structure: >= 2 symbols top-down bull with >= 3/4 aligned -> bullish; bear -> bearish; else mixed
 *   short term: >= 2 symbols with 15m or 1h Stoch RSI overbought (oversold) -> stretched when it
 *   runs with the structure, "bouncing" / "pulling back" when it runs against it.
 * @returns {{side:'bull'|'bear'|'mixed', text:string}}
 */
export function marketLean(rows) {
  const n = (fn) => rows.filter(fn).length;
  const bull = n((r) => r.td && r.td.sentiment === 'bull' && r.td.aligned >= 3);
  const bear = n((r) => r.td && r.td.sentiment === 'bear' && r.td.aligned >= 3);
  const ob = n((r) => r.stoch15 === 'overbought' || r.stoch1h === 'overbought');
  const os = n((r) => r.stoch15 === 'oversold' || r.stoch1h === 'oversold');
  const side = bull >= 2 && bull > bear ? 'bull' : bear >= 2 && bear > bull ? 'bear' : 'mixed';
  const structure = side === 'bull' ? 'bullish structure' : side === 'bear' ? 'bearish structure' : 'mixed structure';
  let short = 'short-term not stretched';
  if (side === 'bull' && ob >= 2) short = 'stretched short-term (Stoch overbought)';
  else if (side === 'bear' && os >= 2) short = 'stretched short-term (Stoch oversold)';
  else if (side === 'bull' && os >= 2) short = 'pulling back short-term (Stoch oversold)';
  else if (side === 'bear' && ob >= 2) short = 'bouncing short-term (Stoch overbought)';
  else if (side === 'mixed' && (ob >= 2 || os >= 2)) short = `short-term Stoch ${ob >= 2 ? 'overbought' : 'oversold'} on ${Math.max(ob, os)} symbols`;
  return { side, text: `${structure}, ${short}` };
}

/**
 * The first 1h/4h level that would change the lean: bull -> the nearest support below
 * price, bear -> the nearest resistance above; mixed -> both. From geometryContext zones.
 */
export function changeLevel(s, side) {
  const price = isNum(s && s.price) ? s.price : null;
  const g = isObj(s && s.geometryContext) ? s.geometryContext : {};
  if (price === null) return null;
  let below = null;
  let above = null;
  for (const tf of ['1h', '4h']) {
    const geo = isObj(g[tf]) ? g[tf] : null;
    if (!geo) continue;
    for (const z of Array.isArray(geo.horizontalSupportZones) ? geo.horizontalSupportZones : []) {
      if (isObj(z) && isNum(z.high) && z.high < price && (!below || z.high > below.price)) below = { price: z.high, tf, kind: 'support' };
    }
    for (const z of Array.isArray(geo.horizontalResistanceZones) ? geo.horizontalResistanceZones : []) {
      if (isObj(z) && isNum(z.low) && z.low > price && (!above || z.low < above.price)) above = { price: z.low, tf, kind: 'resistance' };
    }
  }
  return side === 'bull' ? (below ? { below } : null) : side === 'bear' ? (above ? { above } : null) : (below || above ? { below, above } : null);
}

/**
 * /market: `🌐 MARKET · last 24h`, one block per symbol (price, 24h change and range,
 * top-down, 4h/1h lean, EMA200 count, Stoch 15m/1h, mark drift), then LEAN (by rule),
 * FLAGS (alerts sent today by kind, from telegram/state.json), WHAT WOULD CHANGE IT (first
 * 1h/4h level per symbol). Engine fields only; anything missing prints n/a.
 */
export function formatMarket(payload, state = null, nowMs = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const keys = ['BTC', 'ETH', 'SOL'].filter((k) => isObj(syms[k]));
  if (!keys.length) return joinSections(['🌐 MARKET · last 24h', 'Market data unavailable.']);
  const rows = keys.map((k) => {
    const s = syms[k];
    return { k, s, move: dayMove(s), td: topDownOf(s), a200: above200Of(s), l4h: leanOf(s, '4h'), l1h: leanOf(s, '1h'), stoch15: stochOf(s, '15m'), stoch1h: stochOf(s, '1h') };
  });
  const na = (v) => (v === null || v === undefined ? 'n/a' : v);
  const short = { overbought: 'ob', oversold: 'os', neutral: 'neutral' };
  const blocks = rows.map((r) => {
    const m = r.move;
    const head = `${glyph(r.k)} <b>${escapeHtml(r.k)}</b> ${fmtPrice(r.s.price)} · ${m ? `${m.changePct >= 0 ? '+' : ''}${m.changePct}% 24h` : '24h n/a'}`;
    const drift = isObj(r.s.mark) && isNum(r.s.mark.driftBps) && r.s.mark.status !== 'unavailable' ? `${r.s.mark.driftBps} bps` : 'n/a';
    return `${head}\n${codeBlock([
      ['range', m ? `${fmtLevel(m.low)}–${fmtLevel(m.high)}${m.source === '4h' ? ' (4h)' : ''}` : 'n/a'],
      ['td', r.td ? `${r.td.sentiment} ${na(r.td.aligned)}/4` : 'n/a'],
      ['4h/1h', `${na(r.l4h)}/${na(r.l1h)}`],
      ['a200', r.a200 ? `${r.a200.count}/${r.a200.of}` : 'n/a'],
      ['stoch', `15m ${na(short[r.stoch15])} · 1h ${na(short[r.stoch1h])}`],
      ['drift', drift]
    ], { alignValues: false })}`;
  });
  const lean = marketLean(rows);
  const st = isObj(state) ? state : null;
  const today = isNum(nowMs) ? new Date(nowMs).toISOString().slice(0, 10) : null;
  const by = st && isObj(st.alerts) && st.alerts.day === today && isObj(st.alerts.byKind) ? st.alerts.byKind : null;
  const cnt = (...ks) => ks.reduce((a, k) => a + (isNum(by[k]) ? by[k] : 0), 0);
  const flags = by
    ? `formed ${cnt('WATCH', 'TRIGGERING')} · confirmed ${cnt('BREAKOUT')} · SETUP ${cnt('SETUP')} · GOOD ${cnt('GOOD')} (alerts today, UTC)`
    : 'n/a';
  const changes = rows.map((r) => {
    const lv = changeLevel(r.s, lean.side);
    const part = (x, verb) => (x ? `${verb} ${fmtLevel(x.price)} (${x.tf} ${x.kind})` : null);
    const text = lv ? [part(lv.below, 'loses'), part(lv.above, 'clears')].filter(Boolean).join(' or ') : 'n/a';
    return `${glyph(r.k)} ${escapeHtml(r.k)} ${text}`;
  });
  const dot = lean.side === 'bull' ? '🟢' : lean.side === 'bear' ? '🔴' : '⚪';
  return joinSections([
    '🌐 MARKET · last 24h',
    ...blocks,
    `<b>LEAN</b> ${dot} ${escapeHtml(lean.text)}`,
    `<b>FLAGS</b> ${escapeHtml(flags)}`,
    `<b>WHAT WOULD CHANGE IT</b>\n${changes.join('\n')}`
  ]);
}

// ---------------------------------------------------------------- /flags chart albums

/**
 * Live flags grouped for the /flags albums: per symbol (BTC, ETH, SOL order; `only` limits
 * to one), one chart per distinct timeframe carrying every live candidate on it (a long and
 * a short on one timeframe share an image). Failed candidates are excluded.
 * @returns {Array<{symbol:string, charts:Array<{symbol:string, timeframe:string, candidates:Array}>}>}
 */
export function collectLiveFlags(payload, only = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  return (only ? [only] : ['BTC', 'ETH', 'SOL']).map((symbol) => {
    const s = syms[symbol];
    const cands = s && Array.isArray(s.candidateSetups) ? s.candidateSetups.filter((c) => isObj(c) && c.timeframe && LIVE_FLAG_STATES.includes(c.state)) : [];
    const byTf = new Map();
    for (const c of cands) byTf.set(c.timeframe, [...(byTf.get(c.timeframe) || []), c]);
    const rank = (tf) => (TF_ORDER.includes(tf) ? TF_ORDER.indexOf(tf) : TF_ORDER.length);
    const charts = [...byTf.keys()].sort((a, b) => rank(a) - rank(b)).map((timeframe) => ({ symbol, timeframe, candidates: byTf.get(timeframe) }));
    return { symbol, charts };
  });
}

/**
 * Keep the first `max` charts across the groups (symbol order, then timeframe order).
 * @returns {{groups:Array, dropped:number}} groups keep their symbol even when all its charts drop
 */
export function capFlagCharts(groups, max = MAX_FLAG_CHARTS) {
  let left = max;
  let dropped = 0;
  const out = groups.map((g) => {
    const keep = g.charts.slice(0, Math.max(0, left));
    left -= keep.length;
    dropped += g.charts.length - keep.length;
    return { ...g, charts: keep, capped: keep.length < g.charts.length };
  });
  return { groups: out, dropped };
}

/** "BTC 3m · LONG forming · brk 84,466.10 · void 84,331.60 · 2.4R · qual watch (room:blocked-15m)" */
export function formatFlagLine(symbol, c) {
  const parts = [
    `${escapeHtml(symbol)} ${escapeHtml(c.timeframe)}`,
    `${DIR(c.direction)} ${escapeHtml(c.state)}`,
    `brk ${isNum(c.breakoutLevel) ? fmtLevel(c.breakoutLevel) : 'n/a'}`,
    `void ${isNum(c.invalidation) ? fmtLevel(c.invalidation) : 'n/a'}`,
    isNum(c.measuredRR) ? `${Math.round(c.measuredRR * 10) / 10}R` : 'R n/a'
  ];
  const q = isObj(c.qual) ? c.qual : null;
  if (q && q.decision) {
    const reasons = Array.isArray(q.reasons) ? q.reasons.filter((r) => typeof r === 'string').slice(0, 3) : [];
    parts.push(`qual ${escapeHtml(q.decision)}${reasons.length ? ` (${escapeHtml(reasons.join(', '))})` : ''}`);
  }
  return parts.join(' · ');
}

/** One album image's caption: a line per candidate on that timeframe + closed through, under 1,000 chars. */
export function formatFlagCaption(chart, closedThrough) {
  const tail = `closed through ${escapeHtml(typeof closedThrough === 'string' && closedThrough.length >= 16 ? closedThrough.slice(11, 16) : 'n/a')} UTC`;
  const lines = [];
  let used = tail.length;
  for (const c of chart.candidates) {
    const line = formatFlagLine(chart.symbol, c);
    if (used + line.length + 1 > MAX_CAPTION_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [...lines, tail].join('\n');
}

/** The line sent for a symbol with no live flag. */
export function formatNoLiveFlags(symbol) {
  return `${escapeHtml(symbol)} · no live flags`;
}

/** Split an album into Bot API media groups of at most `size` photos. */
export function chunkMediaGroup(items, size = MAX_MEDIA_GROUP) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * EMA values for a published candle window, rebuilt backwards from the payload's last EMA
 * (ema[t-1] = (ema[t] - k*close[t]) / (1 - k)), so an album chart shows EMA lines from the
 * one build without a per-chart series hook. Presentation only; null when unusable.
 */
export function emaTailSeries(closes, last, period) {
  if (!Array.isArray(closes) || !closes.length || !isNum(last) || !closes.every(isNum)) return null;
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  out[closes.length - 1] = last;
  for (let i = closes.length - 1; i > 0; i--) out[i - 1] = (out[i] - k * closes[i]) / (1 - k);
  return out.every(isNum) ? out.map((v) => Math.round(v * 100) / 100) : null;
}

/** {ema21, ema200} for one symbol/timeframe of a full payload (see emaTailSeries). */
export function albumSeries(payload, symbol, timeframe) {
  const tf = payload && isObj(payload.symbols) && isObj(payload.symbols[symbol]) && isObj(payload.symbols[symbol].timeframes)
    ? payload.symbols[symbol].timeframes[timeframe] : null;
  if (!isObj(tf) || !Array.isArray(tf.candles)) return {};
  const closes = tf.candles.map((c) => (c ? c.c : null));
  return { ema21: emaTailSeries(closes, tf.ema21, 21), ema200: emaTailSeries(closes, tf.ema200, 200) };
}

/**
 * BREAKOUT (a candidate first reached confirmed) in the visual layout. `symbolPlan` is the
 * symbol's live plan; it drives the verdict and PLAN only when it is this candidate's.
 */
export function formatBreakoutAlert(symbol, c, symbolPlan = null, rec = null, { asOf = null, mark = null } = {}) {
  return alertMessage('BREAKOUT', symbol, c, { rec, plan: symbolPlan, asOf, mark });
}

export function formatGoodEnded(symbol, prev, s) {
  const rec = (s && s.flagRecommendation) || {};
  const klass = rec.class || 'DATA_UNAVAILABLE';
  const word = klass === 'BAD' ? 'rejected' : 'void';
  return joinSections([
    msgHeader('🔴', symbol, prev.planTimeframe || null, prev.planDirection || null, 'GOOD ENDED'),
    [`GOOD → ${escapeHtml(klass)} (${word})`, `Reason: ${escapeHtml(rec.primaryReason ? (rec.primaryReason.text || rec.primaryReason.code) : 'no recommendation')}`].join('\n'),
    `${bold('STAND DOWN')} — do not enter this plan now.`
  ]);
}

export function formatDataAlert(reasons, sinceIso, nowMs) {
  return [`🔴 <b>DATA PROBLEM</b> — since ${escapeHtml(fmtTime(sinceIso, nowMs))} (${fmtAge(sinceIso, nowMs)})`, ...reasons.map((r) => `• ${escapeHtml(r)}`), 'No calls are valid on this data.'].join('\n');
}

export function formatMarkAlert(symbol, mark, sinceIso, nowMs) {
  return `🔴 ${glyph(symbol)} <b>MARK ${escapeHtml(mark && mark.status === 'stale' ? 'STALE' : 'UNAVAILABLE')} — ${escapeHtml(symbol)}</b>\nSince ${escapeHtml(fmtTime(sinceIso, nowMs))} (${fmtAge(sinceIso, nowMs)}). Check stops against the venue mark yourself.`;
}

// ---------------------------------------------------------------- alert state machine

/** An empty, valid state. */
export function emptyState() {
  return {
    schemaVersion: TELEGRAM_STATE_SCHEMA,
    stateVersion: STATE_VERSION,
    updatedAt: null,
    cron: { lastRunAt: null },
    symbols: {},
    health: { dataBadSince: null, dataAlertAt: null, marks: {} },
    alerts: { day: null, today: 0, last: null },
    prefs: { level: DEFAULT_ALERT_LEVEL, quiet: { ...DEFAULT_QUIET_HOURS } },
    watch: { ids: [], lastAt: {}, sigs: [] },
    buttons: {},
    tracked: []
  };
}

/**
 * Stored prefs -> {level, quiet, alertTimeframes}. Unknown level -> 'setup'. quiet:
 * missing -> the default 01-05 Chicago; null -> off (the owner turned it off); malformed
 * -> default. alertTimeframes: missing or malformed -> ['3m','5m']; null -> all.
 */
export function normalizePrefs(raw) {
  const p = isObj(raw) ? raw : {};
  const level = ALERT_LEVELS.includes(p.level) ? p.level : DEFAULT_ALERT_LEVEL;
  let quiet = { ...DEFAULT_QUIET_HOURS };
  if (p.quiet === null) quiet = null;
  else if (isObj(p.quiet) && Number.isInteger(p.quiet.start) && Number.isInteger(p.quiet.end)
    && p.quiet.start >= 0 && p.quiet.start < 24 && p.quiet.end >= 0 && p.quiet.end < 24 && p.quiet.start !== p.quiet.end) {
    quiet = { start: p.quiet.start, end: p.quiet.end };
  }
  let alertTimeframes = [...DEFAULT_ALERT_TIMEFRAMES];
  if (p.alertTimeframes === null) alertTimeframes = null;
  else if (Array.isArray(p.alertTimeframes) && p.alertTimeframes.length && p.alertTimeframes.every((x) => ALERT_TIMEFRAME_CHOICES.includes(x))) {
    alertTimeframes = ALERT_TIMEFRAME_CHOICES.filter((x) => p.alertTimeframes.includes(x));
  }
  return { level, quiet, alertTimeframes };
}

/**
 * Apply an `/alerts` change to stored state text; returns the new state text. Only
 * `prefs` moves; the cron's alert memory is carried over untouched.
 * @param {string|null} text - current telegram/state.json
 * @param {{level?:string, quiet?:Object|null, alertTimeframes?:Array<string>|null}} change
 */
export function applyPrefsChange(text, change) {
  const state = parseState(text);
  const prefs = { ...state.prefs };
  if (change && ALERT_LEVELS.includes(change.level)) prefs.level = change.level;
  if (change && 'quiet' in change) prefs.quiet = change.quiet;
  if (change && 'alertTimeframes' in change) prefs.alertTimeframes = change.alertTimeframes;
  state.prefs = normalizePrefs(prefs);
  return `${JSON.stringify(state, null, 2)}\n`;
}

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** A parsed state object of any version -> the current shape. Unknown fields are kept. */
function migrateRaw(raw) {
  const base = emptyState();
  const symbols = {};
  for (const [k, v] of Object.entries(isObj(raw.symbols) ? raw.symbols : {})) {
    if (!isObj(v)) continue;
    symbols[k] = { ...v, lastAlertAt: isoOrNull(v.lastAlertAt), goodIds: strList(v.goodIds), setupIds: strList(v.setupIds), breakoutIds: strList(v.breakoutIds) };
  }
  const marks = {};
  const rawHealth = isObj(raw.health) ? raw.health : {};
  for (const [k, v] of Object.entries(isObj(rawHealth.marks) ? rawHealth.marks : {})) {
    if (isObj(v)) marks[k] = { ...v, badSince: isoOrNull(v.badSince), alertAt: isoOrNull(v.alertAt) };
  }
  const rawAlerts = isObj(raw.alerts) ? raw.alerts : {};
  const rawWatch = isObj(raw.watch) ? raw.watch : {};
  const lastAt = {};
  for (const [k, v] of Object.entries(isObj(rawWatch.lastAt) ? rawWatch.lastAt : {})) if (isoOrNull(v)) lastAt[k] = v;
  return {
    ...base,
    ...raw,
    schemaVersion: TELEGRAM_STATE_SCHEMA,
    stateVersion: STATE_VERSION,
    updatedAt: isoOrNull(raw.updatedAt),
    cron: { ...base.cron, ...(isObj(raw.cron) ? raw.cron : {}), lastRunAt: isoOrNull(raw.cron && raw.cron.lastRunAt) },
    symbols,
    health: { ...base.health, ...rawHealth, dataBadSince: isoOrNull(rawHealth.dataBadSince), dataAlertAt: isoOrNull(rawHealth.dataAlertAt), marks },
    alerts: {
      ...base.alerts,
      ...rawAlerts,
      day: typeof rawAlerts.day === 'string' ? rawAlerts.day : null,
      today: isNum(rawAlerts.today) ? rawAlerts.today : 0,
      last: isObj(rawAlerts.last) ? rawAlerts.last : null
    },
    prefs: normalizePrefs(raw.prefs),
    watch: {
      ...rawWatch,
      ids: Array.isArray(rawWatch.ids) ? rawWatch.ids.filter((e) => isObj(e) && typeof e.id === 'string').slice(-WATCH_RECENT_IDS) : [],
      lastAt,
      sigs: Array.isArray(rawWatch.sigs)
        ? rawWatch.sigs.filter((e) => isObj(e) && typeof e.sig === 'string' && isoOrNull(e.at) && Array.isArray(e.kinds))
          .map((e) => ({ sig: e.sig, at: e.at, kinds: strList(e.kinds) })).slice(-SIGNATURE_RECENT)
        : []
    },
    buttons: pruneButtons(raw.buttons),
    tracked: (Array.isArray(raw.tracked) ? raw.tracked : [])
      .filter((t) => isObj(t) && /^[0-9a-f]{8}$/.test(String(t.ref)) && typeof t.symbol === 'string' && typeof t.candidateId === 'string' && isoOrNull(t.since))
      .map((t) => ({ ...t, hit: isObj(t.hit) && isoOrNull(t.hit.at) ? t.hit : null }))
      .slice(-TRACK_MAX)
  };
}

/**
 * Stored state text (or an already-parsed object) -> {state, fromVersion, migrated, reset,
 * reason}. Never throws. Missing text -> a fresh state (first run, not a reset).
 * Unparseable JSON, a non-object, or a migration error -> a fresh default state with
 * reset:true and reason (unparseable | wrong_type | migrate_error); the caller logs
 * `reason=state_reset`. Otherwise the stored shape is migrated to STATE_VERSION:
 * missing prefs -> defaults (level setup, quiet 01-05 America/Chicago), missing or
 * malformed memory arrays -> empty, unknown fields kept.
 */
export function migrateState(input) {
  let raw = input;
  if (input === null || input === undefined || input === '') return { state: emptyState(), fromVersion: null, migrated: false, reset: false, reason: null };
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return { state: emptyState(), fromVersion: null, migrated: false, reset: true, reason: 'unparseable' }; }
  }
  if (!isObj(raw)) return { state: emptyState(), fromVersion: null, migrated: false, reset: true, reason: 'wrong_type' };
  const fromVersion = Number.isInteger(raw.stateVersion) ? raw.stateVersion : 1;
  try {
    return { state: migrateRaw(raw), fromVersion, migrated: fromVersion !== STATE_VERSION, reset: false, reason: null };
  } catch {
    return { state: emptyState(), fromVersion, migrated: false, reset: true, reason: 'migrate_error' };
  }
}

/** Parse stored state text; never throws. Older shapes migrate; anything malformed becomes an empty state. */
export function parseState(text) {
  return migrateState(text).state;
}

function remember(list, id) {
  const out = (Array.isArray(list) ? list : []).filter((x) => x !== id);
  out.push(id);
  return out.slice(-RECENT_IDS);
}

function rememberWatch(list, id, candState) {
  const out = list.filter((e) => e.id !== id);
  out.push({ id, state: candState });
  return out.slice(-WATCH_RECENT_IDS);
}

const round2 = (v) => (isNum(v) ? (Math.round(v * 100) / 100).toFixed(2) : null);

/**
 * Alert signature `symbol|timeframe|direction|round(breakoutLevel,2)` (a SETUP without a
 * breakout level uses its entry). The void level is not part of it: a re-detected flag
 * whose invalidation drifted is the same flag. Null when the breakout level is missing.
 */
export function alertSignature(symbol, c) {
  if (!isObj(c)) return null;
  const brk = round2(isNum(c.breakoutLevel) ? c.breakoutLevel : c.entry);
  if (brk === null) return null;
  return `${symbol}|${c.timeframe}|${c.direction}|${brk}`;
}

/**
 * Two signatures name the same flag when symbol, timeframe and direction match and the
 * breakout levels differ by less than SIGNATURE_TOLERANCE of price. Older 5-part
 * signatures (with the void level) still compare on their breakout segment.
 */
export function sameSignature(a, b) {
  const pa = String(a).split('|');
  const pb = String(b).split('|');
  if (pa.length < 4 || pb.length < 4 || pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) return false;
  const x = Number(pa[3]);
  const y = Number(pb[3]);
  return Number.isFinite(x) && Number.isFinite(y) && y !== 0 && Math.abs(x - y) / Math.abs(y) < SIGNATURE_TOLERANCE;
}

/** Live (< SIGNATURE_TTL_MS old) memory entries for the same flag as `sig`. */
function liveSigs(sigs, sig, nowMs) {
  return sig ? sigs.filter((x) => nowMs - Date.parse(x.at) < SIGNATURE_TTL_MS && sameSignature(x.sig, sig)) : [];
}

/** Kinds already sent on the same flag within the TTL. */
function sigKinds(sigs, sig, nowMs) {
  return [...new Set(liveSigs(sigs, sig, nowMs).flatMap((e) => e.kinds))];
}

/** True when `kind` on `sig` was already covered within the TTL (escalations pass once each). */
export function signatureBlocked(sigs, sig, kind, nowMs) {
  return sigKinds(sigs, sig, nowMs).some((k) => SIG_BLOCKED_BY[kind].includes(k));
}

/** Record `kind` on the flag; live entries for the same flag merge into one (first signature kept). */
function rememberSig(sigs, sig, kind, nowMs) {
  if (!sig) return sigs;
  const hits = liveSigs(sigs, sig, nowMs);
  const kinds = [...new Set([...hits.flatMap((e) => e.kinds), kind])];
  const keep = hits.length ? hits[0].sig : sig;
  return [...sigs.filter((x) => !hits.includes(x)), { sig: keep, at: new Date(nowMs).toISOString(), kinds }].slice(-SIGNATURE_RECENT);
}

/** Why the data is not usable right now (empty = fine). */
export function dataProblems(payload, nowMs) {
  const out = [];
  if (!payload || payload.dataStatus === 'unavailable') out.push('market data unavailable');
  const ct = payload ? Date.parse(payload.closedThrough) : NaN;
  if (payload && payload.dataStatus !== 'unavailable') {
    if (!Number.isFinite(ct)) out.push('closedThrough missing');
    else if (nowMs - ct > STALE_CLOSED_MS) out.push(`closed candles stale (closedThrough ${fmtAge(payload.closedThrough, nowMs)})`);
  }
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  for (const k of Object.keys(syms).sort()) {
    const rec = syms[k] && syms[k].flagRecommendation;
    if (rec && rec.class === 'DATA_UNAVAILABLE') out.push(`${k} DATA_UNAVAILABLE (${rec.primaryReason ? rec.primaryReason.code : 'no reason'})`);
  }
  return out;
}

/**
 * Compare the stored state with a fresh payload.
 *
 * Transitions that alert (per symbol unless noted):
 *   NEW GOOD      class GOOD on a candidate not alerted as GOOD recently (chart attached)
 *   NEW SETUP     flagRecommendation.setup on a candidate not alerted as SETUP recently
 *   GOOD ENDED    last run was GOOD, this run is not (BAD = rejected, else void)
 *   DATA          (global) unavailable / stale closedThrough / any DATA_UNAVAILABLE class,
 *                 persisting >= 5 min; repeats at most every 30 min
 *   MARK          mark not ok for >= 5 min; repeats at most every 30 min
 *   WATCH         (level watch only) a candidate id not seen before in state forming or
 *                 triggering; one per symbol per 15 min; ids remembered (last 200)
 *   SIGNATURE     WATCH/TRIGGERING/BREAKOUT/SETUP also dedup on alertSignature (symbol,
 *                 tf, direction, breakout; void ignored; breakouts < 0.05% apart are the
 *                 same flag) for 60 min: a WATCH never repeats
 *                 on a signature; TRIGGERING/BREAKOUT pass once each as escalations (a
 *                 TRIGGERING on a signature that had a WATCH passes the 15-min cooldown);
 *                 SETUP once. Catches re-detected flags whose candidateId shifted.
 *   TRIGGERING    (level watch only) an alerted forming candidate now triggering; passes
 *                 the cooldown once. A new id first seen triggering alerts as TRIGGERING
 *                 under the cooldown. A candidate held back by the cooldown is not
 *                 remembered, so it alerts once the cooldown ends if still live.
 * Level (state.prefs.level): good sends GOOD + GOOD ENDED; setup adds SETUP; watch adds
 * WATCH/TRIGGERING. DATA/MARK always send. A SETUP held back by the level is still
 * remembered (dedup unchanged), so raising the level later does not replay it.
 * No transition -> no alert; `changed` is false unless something besides the heartbeat
 * moved, or the heartbeat is older than HEARTBEAT_WRITE_MS.
 *
 * @param {Object} prevState - parseState output
 * @param {Object} payload - compact context payload
 * @param {number} nowMs
 * BREAKOUT: once per candidateId when a candidate first reaches `confirmed`, at every
 * level, before that symbol's SETUP. A BREAKOUT whose own candidate carries the SETUP
 * already shows its BE READY retest line, so that SETUP is remembered but not sent again.
 * Every flag alert carries `replyMarkup` (Plan · Thesis · Chart / Track · Took it · Skipped)
 * and stores its candidate snapshot in state.buttons[shortRef(candidateId)] (last 50).
 * TIMEFRAMES  WATCH/TRIGGERING/BREAKOUT only on prefs.alertTimeframes (null = all), plus 1m
 *             flags of a tracked symbol + direction (line 0 "1m ENTRY · for your tracked ...").
 * TRACKED     diffTracked: every transition of a state.tracked candidate at any level; the
 *             generic alert for that candidate is dropped in the same run.
 *
 * @returns {{alerts: Array<{kind:string, symbol:string|null, text:string, chart?:{symbol:string,timeframe:string}, replyMarkup?:Object}>, state: Object, changed: boolean}}
 */
/**
 * Per-minute candidate transitions (the transition log, lib/telegramLog.js). `prevCands`
 * is state.cands from the last run: {candidateId: {sym, s (state), p (plan status)}}.
 * Returns the next map and one line per candidate whose state or plan status changed:
 * a new candidate (from null), a changed one, or one no longer named by its symbol
 * (to 'gone'). Only symbols present in the payload are compared; unavailable data or a
 * first run (prevCands not an object) returns no lines and seeds the map silently.
 * planStatus: the candidate's own flagTradePlan status, 'setup' when it is the SETUP, else null.
 * @returns {{cands: Object, transitions: Array<Object>}}
 */
export function diffCandidates(prevCands, payload, nowMs) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const prev = isObj(prevCands) ? prevCands : null;
  if (!payload || payload.dataStatus === 'unavailable') return { cands: prev || {}, transitions: [] };
  const at = new Date(nowMs).toISOString();
  const closedThrough = typeof payload.closedThrough === 'string' ? payload.closedThrough : null;
  const cands = {};
  const transitions = [];
  const num = (v) => (isNum(v) ? v : null);
  const idParts = (id) => { const p = String(id).split(':'); return { timeframe: p[1] || null, direction: p[2] === 'long' || p[2] === 'short' ? p[2] : null }; };
  for (const [id, e] of Object.entries(prev || {})) if (isObj(e) && !isObj(syms[e.sym])) cands[id] = e; // symbol absent this run: keep
  for (const k of Object.keys(syms).sort()) {
    const s = syms[k];
    if (!isObj(s)) continue;
    const rec = isObj(s.flagRecommendation) ? s.flagRecommendation : {};
    const plan = isObj(s.flagTradePlan) ? s.flagTradePlan : null;
    const seen = new Set();
    for (const id of symbolCandidateIds(s)) {
      const c = liveCandidate(s, id);
      if (!c) continue;
      seen.add(id);
      const own = plan && plan.candidateId === id ? plan : null;
      const p = own ? own.status || null : (isObj(rec.setup) && rec.setup.candidateId === id ? 'setup' : null);
      const st = c.state || null;
      cands[id] = { sym: k, s: st, p };
      const before = prev && isObj(prev[id]) ? prev[id] : null;
      if (!prev || (before && before.s === st && before.p === p)) continue;
      const named = rec.candidateId === id || (isObj(rec.setup) && rec.setup.candidateId === id);
      transitions.push({
        at, closedThrough, symbol: k, timeframe: c.timeframe || idParts(id).timeframe, direction: c.direction || idParts(id).direction, candidateId: id,
        from: before ? before.s : null, to: st, planStatus: p, planFrom: before ? before.p : null,
        reasonCode: own ? own.reasonCode || null : (named && rec.primaryReason ? rec.primaryReason.code || null : null),
        class: named ? rec.class || null : null,
        breakout: num(c.breakoutLevel), invalidation: num(c.invalidation), measuredRR: num(c.measuredRR)
      });
    }
    if (!prev) continue;
    for (const [id, e] of Object.entries(prev)) {
      if (!isObj(e) || e.sym !== k || seen.has(id)) continue;
      transitions.push({
        at, closedThrough, symbol: k, ...idParts(id), candidateId: id, from: e.s ?? null, to: 'gone', planStatus: null, planFrom: e.p ?? null,
        reasonCode: null, class: null, breakout: null, invalidation: null, measuredRR: null
      });
    }
  }
  return { cands, transitions };
}

export function diffAlerts(prevState, payload, nowMs) {
  const prev = migrateState(isObj(prevState) ? prevState : {}).state;
  const nowIso = new Date(nowMs).toISOString();
  const alerts = [];
  const state = JSON.parse(JSON.stringify(prev));
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const dataOk = payload && payload.dataStatus !== 'unavailable';
  const allow = (kind) => LEVEL_KINDS[prev.prefs.level].includes(kind);
  // Tracked candidates as of the last run: their buttons read Untrack, and a tracked
  // SYMBOL+DIRECTION turns on 1m alerts in that direction (focus mode).
  const trackedPrev = liveTracked(prev.tracked, nowMs);
  const trackedIds = new Set(trackedPrev.map((t) => t.candidateId));
  const focusFor = (k, c) => (isObj(c) && c.timeframe === '1m' ? trackedPrev.find((t) => t.symbol === k && t.direction === c.direction && t.candidateId !== c.candidateId) || null : null);
  const tfs = prev.prefs.alertTimeframes;
  const tfAllowed = (k, c) => !tfs || tfs.includes(c.timeframe) || Boolean(focusFor(k, c));
  const line0 = (k, c) => { const f = focusFor(k, c); return f ? `1m ENTRY · for your tracked ${tagOf(f.symbol, f.timeframe, f.direction)}\n` : ''; };
  const keyboard = (k, tf, id) => tradeKeyboard(k, tf, id, { tracked: trackedIds.has(id) });
  const storeSnap = (k, s, id) => {
    const snap = candidateSnapshot(k, s, id);
    if (snap) state.buttons = pruneButtons({ ...state.buttons, [shortRef(id)]: { ...snap, at: nowIso } });
  };

  for (const k of Object.keys(syms).sort()) {
    const s = syms[k] || {};
    const rec = s.flagRecommendation || {};
    const plan = s.flagTradePlan || null;
    const asOf = rec.asOf || (payload && payload.closedThrough) || null;
    const before = isObj(prev.symbols[k]) ? prev.symbols[k] : {};
    const next = {
      class: rec.class || null,
      primaryReason: rec.primaryReason ? rec.primaryReason.code : null,
      setupId: rec.setup && rec.setup.candidateId ? rec.setup.candidateId : null,
      planId: rec.setupId || (plan && plan.planId) || null,
      planCandidateId: rec.candidateId || (plan && plan.candidateId) || null,
      planStatus: plan ? plan.status : null,
      planTimeframe: plan ? plan.timeframe : null,
      planDirection: plan ? plan.direction : null,
      lastAlertAt: before.lastAlertAt || null,
      goodIds: Array.isArray(before.goodIds) ? before.goodIds : [],
      setupIds: Array.isArray(before.setupIds) ? before.setupIds : [],
      breakoutIds: Array.isArray(before.breakoutIds) ? before.breakoutIds : []
    };

    // Setups a BREAKOUT alert in this run already carried (its BE READY line): no second SETUP alert.
    const coveredSetups = new Set();
    if (dataOk) {
      for (const c of Array.isArray(s.candidateSetups) ? s.candidateSetups : []) {
        if (!isObj(c) || typeof c.candidateId !== 'string' || c.state !== 'confirmed' || next.breakoutIds.includes(c.candidateId)) continue;
        next.breakoutIds = [...next.breakoutIds, c.candidateId].slice(-BREAKOUT_RECENT_IDS);
        if (!allow('BREAKOUT') || !tfAllowed(k, c)) continue;
        const sig = alertSignature(k, c);
        if (signatureBlocked(state.watch.sigs, sig, 'BREAKOUT', nowMs)) continue;
        state.watch.sigs = rememberSig(state.watch.sigs, sig, 'BREAKOUT', nowMs);
        alerts.push({ kind: 'BREAKOUT', symbol: k, candidateId: c.candidateId, text: `${line0(k, c)}${formatBreakoutAlert(k, c, plan, rec, { asOf, mark: s.mark })}`, replyMarkup: keyboard(k, c.timeframe, c.candidateId) });
        if (isObj(rec.setup) && rec.setup.candidateId === c.candidateId) coveredSetups.add(c.candidateId);
        storeSnap(k, s, c.candidateId);
        next.lastAlertAt = nowIso;
      }
    }

    if (dataOk && next.class === 'GOOD' && plan && next.planCandidateId && !next.goodIds.includes(next.planCandidateId)) {
      const gc = candidateFor(s.candidateSetups, next.planCandidateId, plan);
      alerts.push({ kind: 'GOOD', symbol: k, candidateId: next.planCandidateId, text: `${line0(k, gc)}${formatGoodAlert(k, s, payload, { nowMs })}`, chart: plan.timeframe ? { symbol: k, timeframe: plan.timeframe } : undefined, replyMarkup: keyboard(k, plan.timeframe, next.planCandidateId) });
      storeSnap(k, s, next.planCandidateId);
      next.goodIds = remember(next.goodIds, next.planCandidateId);
      next.lastAlertAt = nowIso;
    }
    if (dataOk && next.setupId && !next.setupIds.includes(next.setupId)) {
      next.setupIds = remember(next.setupIds, next.setupId);
      const sig = alertSignature(k, rec.setup);
      if (coveredSetups.has(next.setupId)) {
        state.watch.sigs = rememberSig(state.watch.sigs, sig, 'SETUP', nowMs);
      } else if (allow('SETUP') && !signatureBlocked(state.watch.sigs, sig, 'SETUP', nowMs)) {
        state.watch.sigs = rememberSig(state.watch.sigs, sig, 'SETUP', nowMs);
        const sc = candidateFor(s.candidateSetups, next.setupId, rec.setup);
        alerts.push({ kind: 'SETUP', symbol: k, candidateId: next.setupId, text: `${line0(k, sc)}${formatSetupAlert(k, rec.setup, rec, { plan, asOf, candidates: s.candidateSetups, mark: s.mark })}`, replyMarkup: keyboard(k, rec.setup.timeframe, next.setupId) });
        storeSnap(k, s, next.setupId);
        next.lastAlertAt = nowIso;
      }
    }
    if (before.class === 'GOOD' && next.class !== 'GOOD') {
      alerts.push({ kind: 'GOOD_ENDED', symbol: k, text: formatGoodEnded(k, before, s) });
      next.lastAlertAt = nowIso;
    }
    if (dataOk && allow('WATCH')) {
      for (const c of Array.isArray(s.candidateSetups) ? s.candidateSetups : []) {
        if (!isObj(c) || typeof c.candidateId !== 'string' || !WATCH_STATES.includes(c.state) || !tfAllowed(k, c)) continue;
        const kind = c.state === 'triggering' ? 'TRIGGERING' : 'WATCH';
        const sig = alertSignature(k, c);
        if (signatureBlocked(state.watch.sigs, sig, kind, nowMs)) continue;
        const seen = state.watch.ids.find((e) => e.id === c.candidateId);
        // Escalation: forming -> triggering on the same id, or on the same flag signature.
        const escalation = kind === 'TRIGGERING' && ((seen && seen.state === 'forming') || sigKinds(state.watch.sigs, sig, nowMs).includes('WATCH'));
        const last = Date.parse(state.watch.lastAt[k]);
        const cooling = Number.isFinite(last) && nowMs - last < WATCH_COOLDOWN_MS;
        const fire = seen ? escalation : (escalation || !cooling);
        if (!fire) continue;
        alerts.push({ kind, symbol: k, candidateId: c.candidateId, text: `${line0(k, c)}${formatWatchAlert(k, c, rec, { asOf, mark: s.mark })}`, replyMarkup: keyboard(k, c.timeframe, c.candidateId) });
        storeSnap(k, s, c.candidateId);
        state.watch.sigs = rememberSig(state.watch.sigs, sig, kind, nowMs);
        state.watch.ids = rememberWatch(state.watch.ids, c.candidateId, c.state);
        state.watch.lastAt = { ...state.watch.lastAt, [k]: nowIso };
        next.lastAlertAt = nowIso;
      }
    }
    state.symbols[k] = next;

    // Mark health, per symbol.
    const markBad = !isObj(s.mark) || s.mark.status !== 'ok';
    const mh = isObj(prev.health.marks[k]) ? { ...prev.health.marks[k] } : { badSince: null, alertAt: null };
    if (dataOk && markBad) {
      mh.badSince = mh.badSince || nowIso;
      const due = nowMs - Date.parse(mh.badSince) >= HEALTH_PERSIST_MS && (!mh.alertAt || nowMs - Date.parse(mh.alertAt) >= HEALTH_REPEAT_MS);
      if (due) {
        alerts.push({ kind: 'MARK', symbol: k, text: formatMarkAlert(k, s.mark, mh.badSince, nowMs) });
        mh.alertAt = nowIso;
      }
    } else if (!markBad) {
      mh.badSince = null;
      mh.alertAt = null;
    }
    state.health.marks[k] = mh;
  }

  // Tracked candidates: every transition, at any level and timeframe. A candidate with a
  // TRACK alert this run does not also get the generic alert (one message per change).
  const trackAlerts = diffTracked(state, payload, nowMs);
  const tracked = new Set(trackAlerts.map((a) => a.candidateId));
  const generic = ['WATCH', 'TRIGGERING', 'BREAKOUT', 'SETUP', 'GOOD'];
  for (let i = alerts.length - 1; i >= 0; i--) if (generic.includes(alerts[i].kind) && tracked.has(alerts[i].candidateId)) alerts.splice(i, 1);
  alerts.push(...trackAlerts);

  // Candidate transitions for the per-minute log (state.cands; absent on older states -> seeded silently).
  const cd = diffCandidates(prev.cands, payload, nowMs);
  state.cands = cd.cands;

  // Data health, global. A build that failed outright arrives here as unavailable.
  const problems = dataProblems(payload, nowMs);
  if (problems.length) {
    state.health.dataBadSince = prev.health.dataBadSince || nowIso;
    const since = Date.parse(state.health.dataBadSince);
    const last = Date.parse(prev.health.dataAlertAt);
    if (nowMs - since >= HEALTH_PERSIST_MS && (!Number.isFinite(last) || nowMs - last >= HEALTH_REPEAT_MS)) {
      alerts.push({ kind: 'DATA', symbol: null, text: formatDataAlert(problems, state.health.dataBadSince, nowMs) });
      state.health.dataAlertAt = nowIso;
    }
  } else {
    if (prev.health.dataAlertAt) alerts.push({ kind: 'DATA_OK', symbol: null, text: '🟢 <b>DATA OK</b> — closed candles are fresh again.' });
    state.health.dataBadSince = null;
    state.health.dataAlertAt = null;
  }

  const today = nowIso.slice(0, 10);
  if (state.alerts.day !== today) state.alerts = { ...state.alerts, day: today, today: 0, byKind: {} };
  if (alerts.length) {
    const lastAlert = alerts[alerts.length - 1];
    // Per-kind counts for the day (the /market FLAGS line).
    const byKind = { ...(isObj(state.alerts.byKind) ? state.alerts.byKind : {}) };
    for (const a of alerts) byKind[a.kind] = (isNum(byKind[a.kind]) ? byKind[a.kind] : 0) + 1;
    state.alerts = { day: today, today: (state.alerts.today || 0) + alerts.length, last: { at: nowIso, symbol: lastAlert.symbol, kind: lastAlert.kind }, byKind };
  }

  const strip = (st) => JSON.stringify({ ...st, updatedAt: null, cron: null });
  const moved = strip(state) !== strip(prev);
  const lastRun = Date.parse(prev.cron.lastRunAt);
  const heartbeatDue = !Number.isFinite(lastRun) || nowMs - lastRun >= HEARTBEAT_WRITE_MS;
  state.cron = { ...state.cron, lastRunAt: nowIso };
  state.updatedAt = nowIso;
  state.stateVersion = STATE_VERSION;
  return { alerts, state, changed: moved || heartbeatDue, transitions: cd.transitions };
}

// ---------------------------------------------------------------- cron health

/** An empty cron health record (telegram/health.json). */
export function emptyHealth() {
  return { failures: 0, since: null, lastReason: null, lastFailureAt: null, lastAlertAt: null, recoveredAt: null };
}

/** health.json text -> record; never throws, anything malformed -> empty. */
export function parseHealth(text) {
  let raw = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const base = emptyHealth();
  if (!isObj(raw)) return base;
  return {
    failures: Number.isInteger(raw.failures) && raw.failures > 0 ? raw.failures : 0,
    since: isoOrNull(raw.since),
    lastReason: typeof raw.lastReason === 'string' ? raw.lastReason.slice(0, 80) : null,
    lastFailureAt: isoOrNull(raw.lastFailureAt),
    lastAlertAt: isoOrNull(raw.lastAlertAt),
    recoveredAt: isoOrNull(raw.recoveredAt)
  };
}

/**
 * One cron outcome -> the next health record and at most one message.
 * Failure: failures+1; the CRON_FAIL_ALERT_AFTER-th sends ALERTS CRON FAILING, then at
 * most once per CRON_FAIL_REPEAT_MS while it keeps failing. Success after >=
 * CRON_FAIL_ALERT_AFTER failures sends ALERTS CRON RECOVERED once. `write` is false when
 * nothing moved (a success with no failures on record), so a healthy cron costs no write.
 * @param {Object} prev - parseHealth output
 * @param {{ok: boolean, reason?: string}} outcome - reason is a code, never error text
 * @param {number} nowMs
 * @returns {{health: Object, message: string|null, write: boolean}}
 */
export function nextCronHealth(prev, outcome, nowMs) {
  const h = { ...emptyHealth(), ...(isObj(prev) ? prev : {}) };
  const nowIso = new Date(nowMs).toISOString();
  if (outcome && outcome.ok) {
    if (!h.failures) return { health: h, message: null, write: false };
    const message = h.failures >= CRON_FAIL_ALERT_AFTER
      ? `🟢 <b>ALERTS CRON RECOVERED</b> · after ${h.failures} failed runs since ${escapeHtml(fmtTime(h.since, nowMs))}`
      : null;
    return { health: { ...h, failures: 0, since: null, lastAlertAt: null, recoveredAt: nowIso }, message, write: true };
  }
  const reason = String((outcome && outcome.reason) || 'unknown').slice(0, 80);
  const next = { ...h, failures: h.failures + 1, since: h.since || nowIso, lastReason: reason, lastFailureAt: nowIso };
  const last = Date.parse(h.lastAlertAt);
  const due = next.failures === CRON_FAIL_ALERT_AFTER
    || (next.failures > CRON_FAIL_ALERT_AFTER && (!Number.isFinite(last) || nowMs - last >= CRON_FAIL_REPEAT_MS));
  if (!due) return { health: next, message: null, write: true };
  next.lastAlertAt = nowIso;
  return { health: next, message: `🔴 <b>ALERTS CRON FAILING</b> · ${escapeHtml(reason)} · since ${escapeHtml(fmtTime(next.since, nowMs))}`, write: true };
}

/**
 * Error text for logs: `err.message`, first 200 chars, with any given secret value and
 * token-shaped strings redacted. Never returned to a client or stored.
 */
export function errText(err, secrets = []) {
  let msg = String(err && err.message ? err.message : err || '').slice(0, 400);
  for (const sec of secrets) if (typeof sec === 'string' && sec.length >= 6) msg = msg.split(sec).join('[redacted]');
  msg = msg.replace(/vercel_blob_rw_[A-Za-z0-9_]+/g, '[redacted]').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]');
  return msg.slice(0, 200);
}

// ---------------------------------------------------------------- execution (T-3, docs/PLAN_TELEGRAM_EXECUTION.md)

/**
 * Telegram side of execution: parsing, intents, cards, keyboards and the manage-ticket
 * store. Pure and import-free like the rest of this file: the executor
 * (lib/execution/executor.js) is resolved and called by api/telegram-webhook.js only.
 * Field names read from executor results are tolerant (see the pickers) so a small
 * naming drift in the executor never prints a wrong number: a value that is not found
 * prints n/a. No card ever prints a PIN.
 */
export const EXEC_OFF_REPLY = 'Execution off';
export const ORDER_USAGE = 'Usage: /order SYM long|short size USD lev N sl PRICE tp PRICE (e.g. /order BTC long size 200 lev 5 sl 84390 tp 85146)';
export const CONFIRM_USAGE = 'Reply: /confirm NONCE PIN (the nonce is on the ticket; the message is deleted after use)';
export const STOPS_USAGE = 'Usage: /stops POS sl PRICE tp PRICE (POS = the 8-letter id on /positions)';
/** Telegram-side tickets for position actions (close / stops); order tickets live in the executor. */
export const EXEC_TICKETS_PATH = 'telegram/exec-tickets.json';
export const EXEC_TICKET_TTL_MS = 60_000;
const EXEC_TICKETS_MAX = 20;
const NONCE_RE = /^[A-Za-z0-9_-]{4,48}$/;

const firstNum = (...vals) => vals.find(isNum) ?? null;
const pickNum = (obj, keys) => (isObj(obj) ? firstNum(...keys.map((k) => obj[k])) : null);

/**
 * True when candidate view `v` (resolveRef) is a live, ready plan the Open button may act
 * on: its own plan with status ready, the recommendation class GOOD, and the readiness
 * call GET IN NOW (a missing call is not ready).
 */
export function isOpenReady(v) {
  if (!isObj(v) || v.source !== 'live' || !isObj(v.plan) || v.plan.status !== 'ready') return false;
  if (!isObj(v.rec) || v.rec.class !== 'GOOD') return false;
  const call = isObj(v.rec.action) ? v.rec.action.call : null;
  return call === 'GET IN NOW';
}

/** Same check on a payload symbol for the candidate a GOOD alert names. */
export function isOpenReadySymbol(symbol, s, candidateId) {
  if (!isObj(s) || !candidateId) return false;
  return isOpenReady(liveView(symbol, s, candidateId));
}

/** The markup with an `Open` row (open:<ref>) on top. */
export function withOpenButton(markup, candidateId) {
  const rows = isObj(markup) && Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
  return { inline_keyboard: [[{ text: 'Open', callback_data: `open:${shortRef(candidateId)}` }], ...rows] };
}

/** Caps from executor.status() (tolerant names), else the EXECUTION_MAX_* env values. */
export function execCaps(status, env = {}) {
  const c = isObj(status) && isObj(status.caps) ? status.caps : {};
  const envNum = (k) => { const n = Number(env && env[k]); return env && env[k] !== undefined && env[k] !== '' && Number.isFinite(n) ? n : null; };
  return {
    maxSizeUsd: firstNum(c.maxSizeUsd, c.sizeUsd, c.maxSize, envNum('EXECUTION_MAX_SIZE_USD')),
    maxLeverage: firstNum(c.maxLeverage, c.leverage, envNum('EXECUTION_MAX_LEVERAGE')),
    maxLossUsdPerTrade: firstNum(c.maxLossUsdPerTrade, c.maxLossUsd, c.lossPerTradeUsd, envNum('EXECUTION_MAX_LOSS_USD_PER_TRADE')),
    maxDailyLossUsd: firstNum(c.maxDailyLossUsd, c.dailyLossUsd, envNum('EXECUTION_MAX_DAILY_LOSS_USD')),
    maxOpenPositions: firstNum(c.maxOpenPositions, c.openPositions, envNum('EXECUTION_MAX_OPEN_POSITIONS'))
  };
}

/** 'dry' | 'live' | null from executor.status(). */
export const execMode = (status) => (isObj(status) && (status.mode === 'dry' || status.mode === 'live') ? status.mode : null);
const modeBanner = (mode) => (mode === 'live' ? '🔴 <b>LIVE</b> — real funds' : mode === 'dry' ? '🧪 <b>DRY RUN</b> — nothing is signed or sent' : '⚪ <b>MODE UNKNOWN</b>');

/**
 * The order intent for an Open tap: entry / stop / tp1 (tp2) / direction from the plan;
 * size = min(cap, suggested leverage x collateral from the candidate's risk block),
 * leverage = min(cap, suggested leverage). {error} when the plan is not ready or the
 * engine did not size it.
 * @returns {{intent:Object, snap:Object}|{error:string}}
 */
export function orderIntentFromPlan(v, caps = {}) {
  if (!isOpenReady(v)) return { error: 'the plan is not ready (Open needs GOOD and GET IN NOW)' };
  const p = v.plan;
  const r = isObj(v.candidate && v.candidate.risk) ? v.candidate.risk : null;
  if (!r || r.reason || !isNum(r.suggestedLeverage) || !isNum(r.collateralUsd)) return { error: 'the engine did not size this plan (no risk block); use /order' };
  if (![p.entry, p.stop, p.tp1].every(isNum)) return { error: 'the plan has no entry, stop or TP1' };
  const suggested = r.suggestedLeverage * r.collateralUsd;
  const sizeUsd = Math.round((isNum(caps.maxSizeUsd) ? Math.min(caps.maxSizeUsd, suggested) : suggested) * 100) / 100;
  const leverage = isNum(caps.maxLeverage) ? Math.min(caps.maxLeverage, r.suggestedLeverage) : r.suggestedLeverage;
  const intent = {
    symbol: v.symbol, direction: p.direction || v.candidate.direction, sizeUsd, leverage,
    entry: p.entry, stop: p.stop, tp1: p.tp1, ...(isNum(p.tp2) ? { tp2: p.tp2 } : {}),
    planId: p.planId || null, candidateId: v.candidateId, recClass: v.rec.class, source: 'telegram'
  };
  return { intent, snap: { ...candidateSnapshot(v.symbol, v.s, v.candidateId), symbol: v.symbol } };
}

/**
 * `/order BTC long size 200 lev 5 sl 84390 tp 85146` args -> {ok, symbol, direction,
 * sizeUsd, leverage, stop, tp1} or {ok:false}. Every field is required (SL and TP too).
 */
export function parseOrderArgs(args) {
  const a = (Array.isArray(args) ? args : []).map((x) => String(x).toLowerCase());
  const symbol = parseSymbol(a[0]);
  const direction = a[1] === 'long' || a[1] === 'short' ? a[1] : null;
  const kv = {};
  for (let i = 2; i + 1 < a.length; i += 2) kv[a[i]] = a[i + 1];
  const num = (k) => { const n = Number(String(kv[k] ?? '').replace(/[$,x]/g, '')); return kv[k] !== undefined && Number.isFinite(n) && n > 0 ? n : null; };
  const out = { symbol, direction, sizeUsd: num('size'), leverage: num('lev'), stop: num('sl'), tp1: num('tp') };
  const ok = Boolean(symbol && direction && a.length === 10) && [out.sizeUsd, out.leverage, out.stop, out.tp1].every(isNum);
  return ok ? { ok: true, ...out } : { ok: false };
}

/** `/confirm <nonce> <pin>` args -> {nonce, pin} (either null when malformed). The PIN is never echoed. */
export function parseConfirmArgs(args) {
  const a = Array.isArray(args) ? args.map(String) : [];
  return { nonce: NONCE_RE.test(a[0] || '') ? a[0] : null, pin: /^\d{4,8}$/.test(a[1] || '') && a.length === 2 ? a[1] : null };
}

/** `/stops <pos> sl <price> tp <price>` -> {ok, ref, stop, tp} (pos = 8-hex ref or a full position id). */
export function parseStopsArgs(args) {
  const a = Array.isArray(args) ? args.map(String) : [];
  const n = (x) => { const v = Number(String(x || '').replace(/,/g, '')); return Number.isFinite(v) && v > 0 ? v : null; };
  if (a.length !== 5 || a[1].toLowerCase() !== 'sl' || a[3].toLowerCase() !== 'tp' || !/^[A-Za-z0-9_-]{4,64}$/.test(a[0])) return { ok: false };
  const stop = n(a[2]);
  const tp = n(a[4]);
  return stop && tp ? { ok: true, pos: a[0], stop, tp } : { ok: false };
}

/** Header `⚡ ORDER · ₿ <b>BTC 5m ▲ LONG</b>` (any label). */
function execHeader(icon, label, symbol, tf, dir) {
  return `${icon} ${label} · ${glyph(symbol)} <b>${tagOf(symbol, tf, dir)}</b>`;
}

/** Expected fill from a quote (tolerant names). */
export const quoteFill = (quote) => pickNum(quote, ['expectedPrice', 'price', 'entryPrice', 'fillPrice', 'markPrice']);

/**
 * `⛔ ORDER REFUSED` card: the intent's subject and each preflight reason on its own line.
 */
export function formatRefusedCard(intent, reasons, { timeframe = null } = {}) {
  const i = isObj(intent) ? intent : {};
  const list = (Array.isArray(reasons) ? reasons : [reasons]).filter((x) => x !== null && x !== undefined && String(x).trim())
    .map((x) => `• ${escapeHtml(typeof x === 'string' ? x : (x.message || x.code || JSON.stringify(x)))}`);
  return joinSections([
    execHeader('⛔', 'ORDER REFUSED', i.symbol || '?', timeframe, i.direction),
    list.length ? list.join('\n') : '• refused (no reason given)',
    'Nothing was sent.'
  ]);
}

/**
 * The order ticket: `⚡ ORDER · ₿ <b>BTC 5m ▲ LONG</b>`, the mode banner, then side /
 * size / lev / fill (quote) / SL / TP1 / max loss / fees in a code block, and the expiry.
 * @param {Object} pf - preflight result {quote, order}
 * @param {Object} ticket - createTicket result {nonce, expiresAt}
 */
export function formatTicketCard(intent, pf, ticket, { mode = null, timeframe = null, nowMs = Date.now() } = {}) {
  const i = isObj(intent) ? intent : {};
  const o = isObj(pf && pf.order) ? pf.order : {};
  const q = isObj(pf && pf.quote) ? pf.quote : {};
  const size = firstNum(o.sizeUsd, i.sizeUsd);
  const lev = firstNum(o.leverage, i.leverage);
  const fill = firstNum(o.expectedFill, quoteFill(q), o.entry, i.entry);
  const stop = firstNum(o.stop, i.stop);
  const tp1 = firstNum(o.tp1, o.tp, i.tp1);
  const maxLoss = firstNum(o.maxLossUsd, o.lossAtStopUsd, q.maxLossUsd, isNum(size) && isNum(fill) && isNum(stop) && fill > 0 ? size * Math.abs(fill - stop) / fill : null);
  const fees = firstNum(o.feesUsd, o.estFeesUsd, o.feeUsd, q.feesUsd, q.venueFeesUsd, q.feeUsd, q.totalFeeUsd);
  const dir = o.direction || i.direction;
  const t = isObj(ticket) ? ticket : {};
  const secs = Number.isFinite(Date.parse(t.expiresAt)) ? Math.max(0, Math.round((Date.parse(t.expiresAt) - nowMs) / 1000)) : 60;
  const warns = (Array.isArray(pf && pf.reasons) ? pf.reasons : []).filter((x) => typeof x === 'string' && x.startsWith('warn:')).map((x) => `⚠️ ${escapeHtml(x.slice(5))}`);
  return joinSections([
    `${execHeader('⚡', 'ORDER', o.symbol || i.symbol || '?', timeframe, dir)}\n${modeBanner(mode)}${warns.length ? `\n${warns.join('\n')}` : ''}`,
    codeBlock([
      ['side', DIR(dir)],
      ['size', fmtUsd(size)],
      ['lev', isNum(lev) ? `${lev}x` : 'n/a'],
      ['fill', lvl(fill)],
      ['SL', lvl(stop)],
      ['TP1', lvl(tp1)],
      ['max loss', fmtUsd(maxLoss)],
      ['fees', isNum(fees) ? `~${fmtUsd(fees)}` : 'n/a']
    ]),
    `ticket <code>${escapeHtml(t.nonce || 'n/a')}</code> · expires in ${secs} s\nTap Confirm, then reply /confirm NONCE PIN.`
  ]);
}

/** Confirm / Cancel buttons for a ticket nonce (null when the nonce cannot ride in callback_data). */
export function ticketKeyboard(nonce) {
  if (!NONCE_RE.test(String(nonce || '')) || `xok:${nonce}`.length > MAX_CALLBACK_BYTES) return null;
  return { inline_keyboard: [[{ text: 'Confirm', callback_data: `xok:${nonce}` }, { text: 'Cancel', callback_data: `xno:${nonce}` }]] };
}

/** The prompt a Confirm tap sends (never carries a PIN). */
export const confirmPrompt = (nonce) => `Reply: <code>/confirm ${escapeHtml(nonce)} PIN</code> within 60 s. The message is deleted after use.`;

const shortId = (id) => { const s = String(id || ''); return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };

/**
 * Result card for a confirmed order: `✅ FILLED` (live) or `🧪 DRY RUN OK` with price,
 * size, position id, SL / TP1, the tx signature or dry-run id, and the tracking line.
 * @param {Object} result - executor.confirm result
 * @param {Object} t - the Telegram-side ticket (intent + snapshot)
 */
export function formatResultCard(result, t, { tracking = null } = {}) {
  const r = isObj(result) ? result : {};
  const tk = isObj(t) ? t : {};
  const pos = isObj(r.position) ? r.position : {};
  const o = isObj(r.order) ? r.order : {};
  const dry = r.mode === 'dry' || (!r.txSignature && r.dryRunId);
  // Live mode with JUPITER_SIMULATE_ONLY: the real transaction was built and simulated on
  // chain, nothing was signed or sent (2026-09-26: this rendered as "FILLED" with no tx).
  const simulated = !dry && r.simulated === true;
  const price = firstNum(pos.entryPrice, pos.entry, pos.price, r.fillPrice, r.price, o.expectedFill, tk.fill, tk.entry);
  const size = firstNum(pos.sizeUsd, r.sizeUsd, o.sizeUsd, tk.sizeUsd);
  const lev = firstNum(pos.leverage, r.leverage, o.leverage, tk.leverage);
  const id = pos.positionId || pos.id || r.positionId || null;
  const icon = dry || simulated ? '🧪' : '✅';
  const label = dry ? 'DRY RUN OK' : simulated ? 'SIMULATED · nothing sent' : 'FILLED';
  return joinSections([
    execHeader(icon, label, tk.symbol || o.symbol || pos.symbol || '?', tk.timeframe || null, tk.direction || o.direction || pos.direction || pos.side),
    codeBlock([
      ['price', lvl(price)],
      ['size', `${fmtUsd(size)}${isNum(lev) ? ` · ${lev}x` : ''}`],
      ['position', id ? shortId(id) : (dry ? 'n/a (dry run)' : simulated ? 'n/a (simulate-only)' : 'n/a')],
      ['SL', lvl(firstNum(pos.stop, pos.stopLoss, o.stop, tk.stop))],
      ['TP1', lvl(firstNum(pos.tp1, pos.takeProfit, pos.tp, o.tp1, tk.tp1))]
    ]),
    [dry ? `dry-run id ${escapeHtml(shortId(r.dryRunId || 'n/a'))} · journaled as a note`
      : simulated ? 'live simulation passed on chain · not signed, not sent (JUPITER_SIMULATE_ONLY)'
        : `tx ${escapeHtml(shortId(r.txSignature || 'n/a'))}`,
      tracking === true ? 'Tracking on' : tracking === 'full' ? `Tracking list full (${TRACK_MAX}); untrack one` : tracking === false ? 'Tracking could not be saved' : 'Tracking: n/a (manual order)'].join('\n')
  ]);
}

/** T-3 F: the four milestones a live two-phase open reaches, in order. */
export const OPEN_PHASES = Object.freeze(['submitted', 'filled', 'stops_attached', 'verified']);
const OPEN_PHASE_LABEL = Object.freeze({ submitted: 'submitted', filled: 'filled', stops_attached: 'stops attached', verified: 'verified' });

/**
 * The live phase card (T-3 F, F4): one message, edited in place as each phase completes
 * (`submitted -> filled @price -> stops attached -> verified`). `phase` is the milestone
 * just reached; every phase up to and including it renders checked, later ones plain.
 * @param {string} phase - one of OPEN_PHASES
 * @param {Object} [info] - {symbol, direction, sizeUsd, leverage, fillPrice}
 */
export function formatOpenPhaseCard(phase, info = {}, { mode = null, timeframe = null } = {}) {
  const i = isObj(info) ? info : {};
  const doneIdx = OPEN_PHASES.indexOf(phase);
  const line = OPEN_PHASES.map((p, n) => {
    const label = p === 'filled' && n <= doneIdx && isNum(i.fillPrice) ? `filled @${lvl(i.fillPrice)}` : OPEN_PHASE_LABEL[p];
    return n <= doneIdx ? `${label} ✔` : label;
  }).join(' → ');
  const done = doneIdx >= OPEN_PHASES.length - 1;
  return joinSections([
    `${execHeader(done ? '✅' : '⏳', done ? 'OPENED' : 'OPENING', i.symbol || '?', timeframe, i.direction)}\n${modeBanner(mode)}`,
    line
  ]);
}

/**
 * `🛑 EMERGENCY CLOSE` card: a live open filled but its SL/TP could not be attached (or
 * did not verify on chain), so the executor closed the naked position at market. If that
 * close itself failed, the card says so plainly and flags KILL ENGAGED.
 * @param {Object} result - the executor confirm() result (reasons include `emergency_closed` or `emergency_close_failed`)
 */
export function formatEmergencyCloseCard(result, info = {}, { mode = null, timeframe = null } = {}) {
  const r = isObj(result) ? result : {};
  const i = isObj(info) ? info : {};
  const ec = isObj(r.emergencyClose) ? r.emergencyClose : {};
  const killed = (Array.isArray(r.reasons) ? r.reasons : []).includes('kill_engaged');
  return joinSections([
    `${execHeader('🛑', 'EMERGENCY CLOSE', i.symbol || '?', timeframe, i.direction)}\n${modeBanner(mode)}`,
    codeBlock([
      ['reason', 'stops could not be attached / verified'],
      ['close', ec.ok ? `sent (attempt ${ec.attempt || 1})` : `FAILED after ${ec.attempts || 0} attempt(s)`],
      ...(killed ? [['kill', 'ENGAGED']] : [])
    ]),
    ec.ok ? 'The naked position was closed at market.' : '⚠️ The position could NOT be closed automatically — check it on chain now.'
  ]);
}

/**
 * A failed confirm / close / update / arm: `❌ PIN` when the executor says the PIN was
 * wrong (with `auto-kill on` when it tripped the kill), else `⛔ NOT DONE`; then the
 * executor's error and reasons, escaped. Never echoes the PIN (the executor never returns it).
 */
export function formatConfirmFail(result) {
  const r = isObj(result) ? result : {};
  const err = typeof r.error === 'string' ? r.error : isObj(r.error) ? String(r.error.message || r.error.code || '') : '';
  const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((x) => String(x));
  const pin = /pin_wrong|wrong pin|\bpin\b/i.test([err, ...reasons].join(' '));
  const words = [...new Set([err, ...reasons].filter((x) => x && x !== 'pin_wrong'))];
  if (pin) return `❌ <b>PIN</b> — wrong PIN${reasons.includes('auto_killed') ? '; too many wrong PINs, execution auto-killed for 1 h' : ''}${words.filter((x) => x !== 'auto_killed').length ? ` (${escapeHtml(words.filter((x) => x !== 'auto_killed').join(', '))})` : ''}.`;
  return `⛔ <b>NOT DONE</b> — ${escapeHtml(words.join(', ') || 'failed')}`;
}

/**
 * On-chain positions (executor.listPositions) -> normalized rows; tolerant of names.
 * A result with ok:false (read failed) -> null, never an empty list.
 * @returns {Array<{positionId, ref, symbol, direction, sizeUsd, collateralUsd, leverage, entry, liq, pnlUsd, stop, tp}>|null}
 */
export function normalizeChainPositions(list) {
  if (isObj(list) && list.ok === false) return null; // a failed read is not "no positions"
  const arr = Array.isArray(list) ? list : isObj(list) && Array.isArray(list.positions) ? list.positions : [];
  return arr.filter(isObj).map((p) => {
    const positionId = String(p.positionId || p.id || p.pubkey || p.address || '');
    const sym = String(p.symbol || p.market || '').toUpperCase().replace(/-?PERP$|USD[CT]?$/g, '').replace(/[-/]$/, '');
    const side = String(p.direction || p.side || '').toLowerCase();
    return {
      positionId, ref: positionId ? shortRef(positionId) : null, symbol: sym || '?',
      direction: side === 'long' || side === 'short' ? side : null,
      sizeUsd: pickNum(p, ['sizeUsd', 'size']), collateralUsd: pickNum(p, ['collateralUsd', 'collateral']),
      leverage: pickNum(p, ['leverage']), entry: pickNum(p, ['entryPrice', 'entry', 'price']),
      liq: pickNum(p, ['liquidationPrice', 'liqPrice', 'liquidation']),
      pnlUsd: pickNum(p, ['unrealizedPnlUsd', 'pnlUsd', 'pnl', 'unrealizedPnl']),
      stop: pickNum(p, ['stop', 'stopLoss', 'slPrice']), tp: pickNum(p, ['tp', 'tp1', 'takeProfit', 'tpPrice'])
    };
  }).filter((p) => p.positionId);
}

/** `stops: SL ✔ TP ✔` (either/both present), or `⚠ none` when neither is known (F4). */
function stopsSummary(p) {
  const hasSl = isNum(p.stop);
  const hasTp = isNum(p.tp);
  if (!hasSl && !hasTp) return '⚠ none';
  return `SL ${hasSl ? '✔' : '✗'} TP ${hasTp ? '✔' : '✗'}`;
}

/** Chain position blocks for /positions (live PnL from chain) with the 8-letter position id. */
export function formatChainPositions(positions, { mode = null } = {}) {
  const rows = Array.isArray(positions) ? positions : [];
  if (!rows.length) return `⛓ <b>ON CHAIN</b>${mode ? ` · ${mode === 'live' ? 'LIVE' : 'DRY RUN'}` : ''}\n[NO OPEN POSITIONS ON CHAIN]`;
  return joinSections(rows.slice(0, 5).map((p) => {
    const dot = isNum(p.pnlUsd) ? (p.pnlUsd >= 0 ? '🟢' : '🔴') : '⚪';
    const arrow = p.direction === 'short' ? '▼' : p.direction === 'long' ? '▲' : '•';
    return `${dot} ${glyph(p.symbol)} <b>${arrow} ${escapeHtml(p.symbol)} ${p.direction ? DIR(p.direction) : 'NO DIRECTION'}</b> · ON CHAIN · pos ${escapeHtml(p.ref)}\n${codeBlock([
      ['size', `${fmtUsd(p.sizeUsd)}${isNum(p.leverage) ? ` · ${p.leverage}x` : ''}`],
      ['entry', lvl(p.entry)], ['liq', lvl(p.liq)], ['SL', lvl(p.stop)], ['TP', lvl(p.tp)],
      ['stops', stopsSummary(p)],
      ['PnL', isNum(p.pnlUsd) ? `${p.pnlUsd >= 0 ? '+' : ''}${fmtUsd(p.pnlUsd)}` : 'n/a']
    ])}`;
  }));
}

/** Per chain position: [Close SYM, Close 50%] and [SL→BE, Set SL/TP] (max 5 positions). */
export function chainPositionsKeyboardRows(positions) {
  return (Array.isArray(positions) ? positions : []).slice(0, 5).filter((p) => p && p.ref).flatMap((p) => [
    [{ text: `Close ${p.symbol}`, callback_data: `xclose:${p.ref}` }, { text: 'Close 50%', callback_data: `xhalf:${p.ref}` }],
    [{ text: 'SL→BE', callback_data: `xbe:${p.ref}` }, { text: 'Set SL/TP', callback_data: `xstops:${p.ref}` }]
  ]);
}

/**
 * A position-action ticket (close / half / be / stops) for a chain position:
 * `⚡ CLOSE · ₿ <b>BTC ▲ LONG</b>` with mode banner, what changes, expiry.
 */
export function formatManageTicket(t, { mode = null, nowMs = Date.now() } = {}) {
  const p = isObj(t && t.position) ? t.position : {};
  const label = t.action === 'close' ? 'CLOSE' : t.action === 'half' ? 'CLOSE 50%' : t.action === 'be' ? 'SL → BE' : 'SET SL/TP';
  const secs = Number.isFinite(Date.parse(t.expiresAt)) ? Math.max(0, Math.round((Date.parse(t.expiresAt) - nowMs) / 1000)) : 60;
  const rows = [['position', escapeHtml(p.ref || 'n/a')], ['size', fmtUsd(p.sizeUsd)], ['entry', lvl(p.entry)]];
  if (t.action === 'close' || t.action === 'half') rows.push(['close', t.action === 'half' ? `50% (${fmtUsd(t.sizeUsd)})` : '100%'], ['PnL now', isNum(p.pnlUsd) ? `${p.pnlUsd >= 0 ? '+' : ''}${fmtUsd(p.pnlUsd)}` : 'n/a']);
  else rows.push(['SL', `${lvl(p.stop)} → ${lvl(t.stop)}`], ['TP', `${lvl(p.tp)} → ${lvl(t.tp)}`]);
  return joinSections([
    `${execHeader('⚡', label, p.symbol || '?', null, p.direction)}\n${modeBanner(mode)}`,
    codeBlock(rows),
    `ticket <code>${escapeHtml(t.nonce)}</code> · expires in ${secs} s\nTap Confirm, then reply /confirm NONCE PIN.`
  ]);
}

/** Result of a position action (closePosition / updateStops). */
export function formatManageResult(result, t) {
  const r = isObj(result) ? result : {};
  const p = isObj(t && t.position) ? t.position : {};
  const dry = r.mode === 'dry' || (!r.txSignature && r.dryRunId);
  const done = t.action === 'close' ? 'CLOSED' : t.action === 'half' ? 'CLOSED 50%' : 'STOPS SET';
  const rows = t.action === 'be' || t.action === 'stops' ? [['SL', lvl(t.stop)], ['TP', lvl(t.tp)]] : [['size', t.action === 'half' ? fmtUsd(t.sizeUsd) : fmtUsd(p.sizeUsd)], ['price', lvl(firstNum(r.exitPrice, r.price, r.fillPrice))]];
  return joinSections([
    execHeader(dry ? '🧪' : '✅', dry ? `DRY RUN OK · ${done}` : done, p.symbol || '?', null, p.direction),
    codeBlock([['position', escapeHtml(p.ref || 'n/a')], ...rows]),
    dry ? `dry-run id ${escapeHtml(shortId(r.dryRunId || 'n/a'))}` : `tx ${escapeHtml(shortId(r.txSignature || 'n/a'))}`
  ]);
}

/** /exec card from executor.status(): mode, kill, caps, loss today, open count, margin. */
export function formatExecStatus(status, env = {}) {
  const s = isObj(status) ? status : {};
  const caps = execCaps(s, env);
  const mode = execMode(s);
  const k = s.kill;
  const killOn = k === true || (isObj(k) && (k.active === true || k.killed === true));
  const killSrc = isObj(k) && typeof k.source === 'string' ? (k.source === 'blob' ? '/kill' : k.source) : '';
  const loss = firstNum(s.dailyLossUsd, s.todayLossUsd, s.realizedLossTodayUsd, s.todayRealizedLossUsd);
  const open = firstNum(s.openCount, s.openPositions, isObj(s.open) ? s.open.count : null);
  const margin = firstNum(s.walletMarginUsd, s.marginUsd, isObj(s.wallet) ? s.wallet.marginUsd : null);
  return joinSections([
    `${killOn ? '🛑' : mode === 'live' ? '🔴' : '🧪'} <b>EXEC</b> · ${mode === 'live' ? 'LIVE' : mode === 'dry' ? 'DRY RUN' : 'MODE UNKNOWN'}${killOn ? ' · KILLED' : ''}`,
    codeBlock([
      ['mode', mode || 'n/a'],
      ['kill', killOn ? `ON${killSrc ? ` (${killSrc})` : ''}` : 'off'],
      ['max size', fmtUsd(caps.maxSizeUsd)],
      ['max lev', isNum(caps.maxLeverage) ? `${caps.maxLeverage}x` : 'n/a'],
      ['loss/trade', fmtUsd(caps.maxLossUsdPerTrade)],
      ['loss/day', fmtUsd(caps.maxDailyLossUsd)],
      ['max open', isNum(caps.maxOpenPositions) ? String(caps.maxOpenPositions) : 'n/a'],
      ['loss today', fmtUsd(loss)],
      ['open', isNum(open) ? String(open) : 'n/a'],
      ['margin', fmtUsd(margin)]
    ]),
    '/kill stops execution now · /arm PIN clears /kill (an env kill stays) · mode is env-only'
  ]);
}

export const formatKilled = () => '🛑 <b>KILLED</b> — execution stopped. No order, close or stop change runs until /arm PIN (an env kill needs Vercel).';
export const formatArmed = (result) => {
  const envKill = isObj(result) && (result.envKillStill === true || result.envKill === true);
  return `✅ <b>ARMED</b> — the /kill flag is cleared.${envKill ? ' EXECUTION_KILL is still set in the environment, so execution stays off.' : ''}`;
};
export const formatModeCard = (status) => {
  const mode = execMode(status);
  return `Mode: <b>${mode === 'live' ? 'LIVE' : mode === 'dry' ? 'DRY RUN' : 'unknown'}</b>${mode ? ` (${mode})` : ''}. Changing it is env-only (EXECUTION_MODE in Vercel), deliberately.`;
};

function parseTickets(text) {
  try { const j = JSON.parse(text || '{}'); return isObj(j) && isObj(j.tickets) ? j.tickets : {}; } catch { return {}; }
}
const liveTickets = (tickets, nowMs) => Object.fromEntries(Object.entries(tickets)
  .filter(([, t]) => isObj(t) && Date.parse(t.expiresAt) > nowMs)
  .sort((a, b) => String(a[1].expiresAt).localeCompare(String(b[1].expiresAt))).slice(-EXEC_TICKETS_MAX));
const ticketsText = (tickets) => `${JSON.stringify({ schemaVersion: 'telegram-exec-tickets-1', tickets }, null, 2)}\n`;

/** Store text with ticket `t` (keyed by t.nonce) added; expired ones dropped. */
export function putExecTicket(text, t, nowMs) {
  return ticketsText({ ...liveTickets(parseTickets(text), nowMs), [t.nonce]: t });
}

/** The live ticket for `nonce`, or null (read only). */
export function findExecTicket(text, nonce, nowMs) {
  return liveTickets(parseTickets(text), nowMs)[nonce] || null;
}

/** Take (single use) ticket `nonce`: {text (without it), ticket|null}. */
export function takeExecTicket(text, nonce, nowMs) {
  const all = liveTickets(parseTickets(text), nowMs);
  const ticket = all[nonce] || null;
  delete all[nonce];
  return { text: ticketsText(all), ticket };
}

// ---------------------------------------------------------------- Bot API client

/**
 * Minimal Bot API client. Every call resolves to {ok, status, error?}; it never throws,
 * and the token only ever appears inside the request URL (never in a result or a log).
 * @param {Object} o
 * @param {string} o.token
 * @param {Function} [o.fetchImpl=fetch]
 * @param {number} [o.timeoutMs=5000]
 */
export function createBotClient({ token, fetchImpl = globalThis.fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const url = (method) => `https://api.telegram.org/bot${token}/${method}`;
  async function call(method, init) {
    if (!token) return { ok: false, status: 0, error: 'token_missing' };
    try {
      const res = await fetchImpl(url(method), { method: 'POST', ...init, signal: AbortSignal.timeout(timeoutMs) });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.ok && body && body.ok) return { ok: true, status: res.status, result: body.result };
      return { ok: false, status: res.status, error: body && typeof body.description === 'string' ? body.description.slice(0, 200) : `http_${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err && err.name === 'TimeoutError' ? 'timeout' : (err && err.name) || 'error' };
    }
  }
  return {
    /**
     * Sends `text` (HTML) to one chat, chunked under 4,000 chars; `replyMarkup` rides on
     * the last chunk. `message_id` (the last chunk's, for a later editMessageText) is
     * `null` on failure or when the Bot API response carried none.
     */
    async sendMessage(chatId, text, { silent = false, replyMarkup = null } = {}) {
      const results = [];
      const parts = chunkMessage(text);
      for (let i = 0; i < parts.length; i++) {
        const body = { chat_id: chatId, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent };
        if (replyMarkup && i === parts.length - 1) body.reply_markup = replyMarkup;
        results.push(await call('sendMessage', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      }
      const last = results.at(-1);
      const messageId = last && last.ok && last.result && typeof last.result.message_id === 'number' ? last.result.message_id : null;
      return results.every((r) => r.ok) ? { ok: true, status: 200, parts: results.length, message_id: messageId } : { ...results.find((r) => !r.ok), message_id: messageId };
    },
    /**
     * Replaces the text (HTML) of a previously sent message in place -- the live phase
     * card (F4: submitted -> filled -> stops attached -> verified / the emergency-close
     * card). Falls back to sending a new message when the edit itself fails (e.g. the
     * original message aged out of Telegram's edit window).
     */
    async editMessageText(chatId, messageId, text, { replyMarkup = null } = {}) {
      const parts = chunkMessage(text);
      const body = { chat_id: chatId, message_id: messageId, text: parts[0], parse_mode: 'HTML', disable_web_page_preview: true };
      if (replyMarkup) body.reply_markup = replyMarkup;
      const r = await call('editMessageText', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return { ok: true, status: r.status, message_id: messageId };
      return this.sendMessage(chatId, text, { replyMarkup });
    },
    /** Sends one PNG with an HTML caption (trimmed under 1,000 chars). */
    async sendPhoto(chatId, png, caption = '', { silent = false } = {}) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('parse_mode', 'HTML');
      if (caption) form.append('caption', String(caption).slice(0, MAX_CAPTION_CHARS));
      form.append('disable_notification', String(!!silent));
      form.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
      return call('sendPhoto', { body: form });
    },
    /**
     * Sends up to 10 PNGs as one album (multipart, `attach://` parts), each with its HTML
     * caption. A single photo goes through sendPhoto (the Bot API needs 2-10 group items).
     * @param {Array<{png:Buffer, caption?:string}>} photos
     */
    async sendMediaGroup(chatId, photos, { silent = false } = {}) {
      const items = Array.isArray(photos) ? photos.slice(0, MAX_MEDIA_GROUP) : [];
      if (!items.length) return { ok: false, status: 0, error: 'no_photos' };
      if (items.length === 1) return this.sendPhoto(chatId, items[0].png, items[0].caption || '', { silent });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('disable_notification', String(!!silent));
      form.append('media', JSON.stringify(items.map((p, i) => ({
        type: 'photo', media: `attach://photo${i}`, parse_mode: 'HTML', ...(p.caption ? { caption: String(p.caption).slice(0, MAX_CAPTION_CHARS) } : {})
      }))));
      items.forEach((p, i) => form.append(`photo${i}`, new Blob([p.png], { type: 'image/png' }), `chart${i}.png`));
      return call('sendMediaGroup', { body: form });
    },
    /** Replaces the inline keyboard of a sent message (the Track <-> Untrack swap). */
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      const body = { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup };
      return call('editMessageReplyMarkup', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    /** Deletes one message (the owner's /confirm or /arm, so the PIN does not stay in the chat). Best effort. */
    async deleteMessage(chatId, messageId) {
      const body = { chat_id: chatId, message_id: messageId };
      return call('deleteMessage', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    /** Stops the button spinner; call first on every callback_query. */
    async answerCallbackQuery(callbackQueryId, text = '') {
      const body = { callback_query_id: String(callbackQueryId) };
      if (text) body.text = String(text).slice(0, 200);
      return call('answerCallbackQuery', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
  };
}

const chicagoHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: QUIET_TIMEZONE, hour: 'numeric', hourCycle: 'h23' });

/** Wall-clock hour 0..23 in America/Chicago (DST-safe via Intl). */
export function chicagoHour(nowMs) {
  const part = chicagoHourFmt.formatToParts(new Date(nowMs)).find((p) => p.type === 'hour');
  return Number(part && part.value) % 24;
}

/**
 * Quiet hours {start, end} (or "HH-HH") in America/Chicago, every day: true when nowMs
 * falls in [start, end), wrapping midnight when start > end. null / off -> false.
 */
export function inQuietHours(quiet, nowMs) {
  const q = typeof quiet === 'string' ? parseQuietSpec(quiet) : quiet;
  if (!isObj(q) || !isNum(q.start) || !isNum(q.end) || q.start === q.end || !isNum(nowMs)) return false;
  const h = chicagoHour(nowMs);
  return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

export default {
  escapeHtml, fmtPrice, chunkMessage, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSignalLine, formatSetupBrief, formatSignals, formatDataBlock, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp,
  formatGoodAlert, formatSetupAlert, formatGoodEnded, formatDataAlert, formatMarkAlert, formatSetupLine, formatWatchAlert,
  collectLiveFlags, capFlagCharts, formatFlagLine, formatFlagCaption, formatNoLiveFlags, chunkMediaGroup, emaTailSeries, albumSeries,
  formatBreakoutAlert, formatCall, alertHeadLine, alertVerdict, triggerWords, counterTrendTag, shortStandDownReason, formatAlertPrefs, fmtQuiet, parseAlertsArgs, parseMenuLabel, menuKeyboard, chartsKeyboard, alertsKeyboard, shortRef,
  tradeButtonRows, tradeKeyboard, swapTrackButton, candidateSnapshot, signalsCandidateId, signalsSnapshots, applyButtonSnapshots, buttonSnapshot, signalsKeyboard,
  resolveRef, liveView, formatPlanCard, formatThesisCard, reasonPhrase, rMultiple, trackEntry, applyTrackChange, hitKeyboard, formatTrackingList, trackingKeyboard, diffTracked,
  dayMove, marketLean, changeLevel, formatMarket, positionRef, openPositions, livePrice, formatPositions, positionsKeyboard, closeBody, parseAlertTimeframes, fmtAlertTimeframes, parseCallbackData, buttonLogBody, findButtonSnapshot, parseQuietSpec, normalizePrefs, applyPrefsChange, chicagoHour,
  emptyState, parseState, migrateState, diffAlerts, dataProblems, createBotClient, inQuietHours,
  emptyHealth, parseHealth, nextCronHealth, errText
};
