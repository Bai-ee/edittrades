/**
 * Telegram alerts + read commands (T-1, docs/PLAN_TELEGRAM.md).
 *
 * Three parts, all read-only toward the engine and never execution:
 *   1. Pure formatters: context payload -> Telegram HTML messages (one metric per line,
 *      mirroring the GPT FORMAT: GO IN / HOLD / DON'T lines plus the SETUP line).
 *   2. Pure alert state machine (`diffAlerts`): previous `telegram/state.json` + a fresh
 *      compact payload -> the alerts to send and the next state. Dedup is by candidate id
 *      (a planId carries closedThrough, so it changes every candle and cannot dedup).
 *   3. A Bot API client (`createBotClient`): sendMessage / sendPhoto / sendMediaGroup, 5 s
 *      timeout per request.
 *      It never throws and never puts the token in a return value or a log line.
 *
 * No imports: nothing here can reach a wallet, a signer or an execution path. There is
 * no /buy, /sell, /open or /close command, by design.
 */

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
/** Quiet hours are owner-local wall clock, every day; alerts send silently, never dropped. */
export const QUIET_TIMEZONE = 'America/Chicago';
export const DEFAULT_QUIET_HOURS = Object.freeze({ start: 1, end: 5 });

export const COMMANDS = Object.freeze(['start', 'help', 'menu', 'signals', 'why', 'flags', 'wallet', 'journal', 'status', 'chart', 'charts', 'log', 'testalert', 'alerts']);
/** Persistent reply keyboard rows; each label maps to a command (parseMenuLabel). */
export const MENU_ROWS = Object.freeze([['Signals', 'Flags'], ['Why BTC', 'Why ETH', 'Why SOL'], ['Charts', 'Wallet'], ['Journal', 'Status', 'Alerts']]);
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
  const usage = 'Usage: /alerts · /alerts good|setup|watch · /alerts quiet [HH-HH|off]';
  if (!a.length) return { action: 'show' };
  if (a.length === 1 && ALERT_LEVELS.includes(a[0])) return { action: 'level', level: a[0] };
  if (a[0] !== 'quiet' || a.length > 2) return { action: 'error', message: usage };
  if (a.length === 1) return { action: 'quiet_show' };
  if (a[1] === 'off') return { action: 'quiet_off' };
  const quiet = parseQuietSpec(a[1]);
  return quiet ? { action: 'quiet_set', quiet } : { action: 'error', message: 'Quiet hours are HH-HH in Chicago time, e.g. /alerts quiet 01-05 (hours 0-24, start and end differ).' };
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
  charts: ['charts'], wallet: ['wallet'], journal: ['journal'], status: ['status'], alerts: ['alerts']
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

/** Alerts: level buttons plus quiet on (default window) / off. */
export function alertsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Good', callback_data: 'alerts:good' }, { text: 'Setup', callback_data: 'alerts:setup' }, { text: 'Watch', callback_data: 'alerts:watch' }],
      [{ text: 'Quiet on', callback_data: 'alerts:quiet:on' }, { text: 'Quiet off', callback_data: 'alerts:quiet:off' }]
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

/**
 * One row of trade buttons: Why, Chart (plan timeframe), and with a candidate Took it /
 * Skipped. `named` adds the symbol to each label (for /signals, several symbols at once).
 */
export function tradeButtonRow(symbol, timeframe, candidateId, { named = false } = {}) {
  const tag = named ? ` ${symbol}` : '';
  const tf = CHART_GRID_TIMEFRAMES.includes(timeframe) || /^(4h|1d)$/.test(String(timeframe)) ? timeframe : '5m';
  const row = [{ text: `Why${tag}`, callback_data: `why:${symbol}` }, { text: `Chart${tag}${named ? ` ${tf}` : ''}`, callback_data: `chart:${symbol}:${tf}` }];
  if (candidateId) {
    const ref = shortRef(candidateId);
    row.push({ text: `Took it${tag}`, callback_data: `log:took:${symbol}:${ref}` }, { text: `Skipped${tag}`, callback_data: `log:skip:${symbol}:${ref}` });
  }
  return row;
}

/**
 * The plan a Took it / Skipped button logs: the GOOD plan, else the SETUP's levels, else
 * null. engineRef is filled from the same plan the alert showed.
 */
export function buttonSnapshot(symbol, s) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = s && s.flagTradePlan;
  if (rec.class === 'GOOD' && isObj(plan) && plan.candidateId) {
    return {
      symbol, candidateId: plan.candidateId, planId: plan.planId || rec.setupId || null, recClass: 'GOOD',
      reasonCode: rec.primaryReason ? rec.primaryReason.code : null,
      timeframe: plan.timeframe || null, direction: plan.direction || null, entry: plan.entry ?? null, stop: plan.stop ?? null, tp1: plan.tp1 ?? null
    };
  }
  const setup = rec.setup;
  if (isObj(setup) && setup.candidateId) {
    return {
      symbol, candidateId: setup.candidateId, planId: null, recClass: rec.class || null,
      reasonCode: rec.primaryReason ? rec.primaryReason.code : null,
      timeframe: setup.timeframe || null, direction: setup.direction || null, entry: setup.entry ?? null, stop: setup.stop ?? null, tp1: setup.tp1 ?? null
    };
  }
  return null;
}

/** /signals buttons: one row per symbol (BTC, ETH, SOL order). */
export function signalsKeyboard(payload) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const rows = ['BTC', 'ETH', 'SOL'].filter((k) => syms[k]).map((k) => {
    const snap = buttonSnapshot(k, syms[k]);
    return tradeButtonRow(k, snap ? snap.timeframe : '5m', snap ? snap.candidateId : null, { named: true });
  });
  return rows.length ? { inline_keyboard: rows } : null;
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
 *   log:took:BTC:<ref> / log:skip:BTC:<ref> -> {cmd:'button_log', kind:'open'|'skip', symbol, ref}
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
  m = d.match(/^log:(took|skip):(BTC|ETH|SOL):([0-9a-f]{8})$/);
  if (m) return { cmd: 'button_log', args: [], rest: '', known: true, kind: m[1] === 'took' ? 'open' : 'skip', symbol: m[2], ref: m[3] };
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

/** Find a button snapshot by ref: state first, else the live payload's GOOD/SETUP plans. */
export function findButtonSnapshot(state, payload, symbol, ref) {
  const stored = isObj(state) && isObj(state.buttons) ? state.buttons[ref] : null;
  if (isObj(stored) && stored.symbol === symbol) return stored;
  const s = payload && isObj(payload.symbols) ? payload.symbols[symbol] : null;
  const snap = s ? buttonSnapshot(symbol, s) : null;
  return snap && shortRef(snap.candidateId) === ref ? snap : null;
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

const DIR = (d) => (d === 'short' ? 'SHORT' : d === 'long' ? 'LONG' : 'NO DIRECTION');
const CALL = { GOOD: '🟢 GO IN', WATCH: '🟡 HOLD / WAIT', BAD: "🔴 DON'T DO IT", DATA_UNAVAILABLE: '⚪ NO DATA' };

function changeText(rec, code) {
  const list = Array.isArray(rec && rec.changeConditions) ? rec.changeConditions : [];
  const hit = code ? list.find((c) => c && c.code === code) : list[0];
  return hit && hit.text ? hit.text : null;
}

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

/** Alert form of the readiness call: "BE READY (3m) — <note>". */
export function formatReadinessLine(action) {
  const call = formatCall(action);
  if (!call) return null;
  return action.note ? `${call} — ${escapeHtml(action.note)}` : call;
}

/**
 * The room line, same text as the GPT's: "Room: <pts> to <levelPrice> (<levelSource>) =
 * <r>R vs stop <stop>", from flagRecommendation.room verbatim. Null when room is null.
 */
export function formatRoomLine(room) {
  if (!isObj(room) || !isNum(room.pts) || !isNum(room.levelPrice)) return null;
  return `Room: ${fmtLevel(room.pts)} to ${fmtLevel(room.levelPrice)} (${escapeHtml(room.levelSource || 'level')}) = ${fmtR(room.r)} vs stop ${fmtLevel(room.stop)}`;
}

/** The readiness + room lines an alert appends (only the ones present). */
function deliveryLines(rec) {
  const r = isObj(rec) ? rec : {};
  return [formatReadinessLine(r.action), formatRoomLine(r.room)].filter(Boolean);
}

/** The plan-level lines shared by /signals GOOD blocks and the GOOD alert. */
function planLines(plan) {
  if (!isObj(plan)) return ['Plan: unavailable'];
  const lines = [
    `Entry: ${fmtPrice(plan.entry)}`,
    `Stop Loss: ${fmtPrice(plan.stop)}`,
    `Take Profit 1: ${fmtPrice(plan.tp1)}`
  ];
  if (isNum(plan.tp2)) lines.push(`Take Profit 2: ${fmtPrice(plan.tp2)}`);
  lines.push(`R:R gross ${fmtR(plan.grossRR)} · net ${fmtR(plan.netRR)}${isNum(plan.netRR) && plan.netRR < 1 ? ' (thin after fees)' : ''}`);
  return lines;
}

/**
 * One symbol's block for /signals. GOOD -> the header plus plan lines; anything else ->
 * the NO TRADE form (reason + confirmation), one metric per line. SETUP line appended.
 * @param {string} symbol
 * @param {Object} s - payload.symbols[symbol] (compact or full)
 */
export function formatSymbolBlock(symbol, s) {
  const rec = s && s.flagRecommendation;
  const klass = rec && rec.class ? rec.class : 'DATA_UNAVAILABLE';
  const plan = s && s.flagTradePlan;
  const lines = [];
  // Schema 1.25.0: the readiness call leads the asset line, verbatim from action.
  const callPrefix = formatCall(rec && rec.action);
  const pre = callPrefix ? `${callPrefix} — ` : '';
  if (klass === 'GOOD' && plan) {
    lines.push(`<b>${pre}${escapeHtml(symbol)} — ${DIR(plan.direction)} — ${escapeHtml(plan.timeframe)}</b>`);
    lines.push(CALL.GOOD);
    lines.push(...planLines(plan));
    if (rec.qualityBand) lines.push(`Quality: ${escapeHtml(rec.qualityBand)}`);
    const change = changeText(rec, 'call_changes_on_invalidation');
    if (change) lines.push(`Changes if: ${escapeHtml(change)}`);
  } else {
    lines.push(`<b>${pre}${escapeHtml(symbol)} — NO TRADE</b>`);
    lines.push(CALL[klass] || escapeHtml(klass));
    const reasonText = rec && rec.primaryReason ? (rec.primaryReason.text || rec.primaryReason.code) : 'no recommendation';
    lines.push(`Reason: ${escapeHtml(reasonText)}`);
    const confirm = changeText(rec);
    if (confirm && confirm !== reasonText) lines.push(`Confirmation: ${escapeHtml(confirm)}`);
    const room = formatRoomLine(rec && rec.room);
    if (room && !(rec && rec.setup)) lines.push(room);
  }
  lines.push(markLine(s && s.mark));
  const setupLine = formatSetupLine(symbol, rec && rec.setup);
  if (setupLine) {
    lines.push(setupLine);
    // The room line follows the SETUP line when there is one (the GPT's SETUP LINE form).
    const room = klass === 'GOOD' ? null : formatRoomLine(rec && rec.room);
    if (room) lines.push(room);
  }
  return lines.join('\n');
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

/** /signals: GOOD symbols first, then the rest in BTC/ETH/SOL order, then DATA. */
export function formatSignals(payload, nowMs = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  if (!payload || payload.dataStatus === 'unavailable' || !Object.keys(syms).length) {
    return `NO TRADE — BTC / ETH / SOL: market data unavailable.\n\n${formatDataBlock(payload || {}, nowMs)}`;
  }
  const order = ['BTC', 'ETH', 'SOL'].filter((k) => syms[k]);
  const goods = order.filter((k) => syms[k].flagRecommendation && syms[k].flagRecommendation.class === 'GOOD');
  const blocks = [...goods, ...order.filter((k) => !goods.includes(k))].map((k) => formatSymbolBlock(k, syms[k]));
  const head = goods.length ? '' : 'NO TRADE — BTC / ETH / SOL below threshold.\n\n';
  return `${head}${blocks.join('\n\n')}\n\n${formatDataBlock(payload, nowMs)}`;
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

/** /status: schema, config, data age, marks, last alert, cron last run. */
export function formatStatus(payload, state, nowMs, health = null) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const lines = [
    '<b>STATUS</b>',
    `Schema/Config: ${escapeHtml(payload && payload.schemaVersion)} · ${escapeHtml(payload && payload.configVersion)}`,
    `Closed Through: ${payload && payload.closedThrough ? `${escapeHtml(fmtTime(payload.closedThrough, nowMs))} (${fmtAge(payload.closedThrough, nowMs)})` : 'n/a'}`,
    `Data: ${escapeHtml(payload && payload.dataStatus ? payload.dataStatus : 'n/a')}`
  ];
  for (const k of ['BTC', 'ETH', 'SOL']) {
    if (!syms[k]) continue;
    const rec = syms[k].flagRecommendation;
    lines.push(`${k}: ${escapeHtml(rec && rec.class ? rec.class : 'n/a')} · ${markLine(syms[k].mark)}`);
  }
  const st = isObj(state) ? state : {};
  const last = st.alerts && st.alerts.last;
  lines.push(`Last alert: ${last ? `${escapeHtml(last.kind)} ${escapeHtml(last.symbol || '')} ${escapeHtml(fmtTime(last.at, nowMs))}` : 'none yet'}`);
  lines.push(`Alerts today: ${st.alerts && st.alerts.day === new Date(nowMs).toISOString().slice(0, 10) ? st.alerts.today : 0}`);
  lines.push(`Cron last run: ${st.cron && st.cron.lastRunAt ? `${escapeHtml(fmtTime(st.cron.lastRunAt, nowMs))} (${fmtAge(st.cron.lastRunAt, nowMs)}; heartbeat saved every ${HEARTBEAT_WRITE_MS / 60_000} min)` : 'never'}`);
  const prefs = normalizePrefs(st.prefs);
  lines.push(`Alert level: ${prefs.level}`);
  lines.push(`Quiet hours: ${fmtQuiet(prefs.quiet)}${prefs.quiet && isNum(nowMs) && inQuietHours(prefs.quiet, nowMs) ? ' (quiet now)' : ''}`);
  const h = isObj(health) ? health : null;
  lines.push(`Cron failures: ${h ? `${h.failures} in a row` : 'n/a'} · last failure: ${h && h.lastReason ? `${escapeHtml(h.lastReason)} ${escapeHtml(fmtTime(h.lastFailureAt, nowMs))}` : 'none'}`);
  return lines.join('\n');
}

const LEVEL_TEXT = {
  good: 'GOOD and GOOD ended only',
  setup: 'GOOD, GOOD ended and SETUP',
  watch: 'GOOD, GOOD ended, SETUP and new forming/triggering flags'
};

const hh = (h) => `${String(h).padStart(2, '0')}:00`;

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
    'Change: /alerts good|setup|watch · /alerts quiet HH-HH · /alerts quiet off'
  ].join('\n');
}

export function formatHelp() {
  return [
    '<b>EditTrades bot</b> — read-only. It never places, signs or closes a trade.',
    '/signals — BTC/ETH/SOL call now, GO IN / HOLD / DON\'T + SETUP lines',
    '/why SYM — supports, against, unknowns, what changes',
    '/flags [SYM] — every flag candidate and its state, then chart albums of every live flag (max 9 images)',
    '/chart SYM TF — confirmation chart, e.g. /chart BTC 5m',
    '/wallet — read-only account block',
    '/journal [n] — last n journal lines (default 10)',
    '/log text — journal a line, e.g. /log took BTC long entry 84600 stop 84390 tp 85100',
    '/status — schema, data age, marks, last alert, cron, alert level, quiet hours',
    '/testalert — sample GOOD card with chart (labeled TEST)',
    '/menu — show the button keyboard (Signals, Flags, Why, Charts, Wallet, Journal, Status, Alerts)',
    '/charts — chart picker buttons',
    '/alerts — show alert level and quiet hours',
    '/alerts good|setup|watch — good: GOOD only · setup: + SETUP (default) · watch: + new forming/triggering flags',
    '/alerts quiet HH-HH — silent (not dropped) alerts in those Chicago hours, every day; /alerts quiet off; /alerts quiet shows it',
    'Alerts arrive on their own: new GOOD, BREAKOUT (a flag first confirms, every level), new SETUP, GOOD ended, data or mark down over 5 min.',
    'GOOD, SETUP and /signals carry buttons: Why, Chart, Took it (journals an open with the plan levels), Skipped.'
  ].join('\n');
}

/**
 * The GOOD alert card: full plan levels, gross/net R, change condition, mark drift,
 * tracker link. `test` labels it TEST so it can never be mistaken for a call.
 */
export function formatGoodAlert(symbol, s, payload, { nowMs = null, test = false } = {}) {
  const rec = (s && s.flagRecommendation) || {};
  const plan = s && s.flagTradePlan;
  const head = `${test ? '🧪 TEST — NOT A SIGNAL\n' : ''}<b>${test ? 'SAMPLE' : 'NEW'} GOOD — ${escapeHtml(symbol)} ${escapeHtml(plan && plan.timeframe)} ${DIR(plan && plan.direction)}</b>`;
  const readiness = formatReadinessLine(rec.action);
  const room = formatRoomLine(rec.room);
  const lines = [head, CALL.GOOD, ...(readiness ? [readiness] : []), ...planLines(plan), ...(room ? [room] : [])];
  if (rec.qualityBand) lines.push(`Quality: ${escapeHtml(rec.qualityBand)}`);
  const change = changeText(rec, 'call_changes_on_invalidation');
  lines.push(`Changes if: ${escapeHtml(change || 'price invalidates the plan or data goes stale')}`);
  lines.push(markLine(s && s.mark));
  lines.push(`Closed Through: ${escapeHtml(payload && payload.closedThrough ? fmtTime(payload.closedThrough, nowMs) : 'n/a')}`);
  lines.push(`Tracker: ${TRACKER_URL}`);
  const setupLine = formatSetupLine(symbol, rec.setup);
  if (setupLine) lines.push(setupLine);
  return lines.join('\n');
}

/** SETUP alert; `rec` (the symbol's flagRecommendation) adds the readiness call and room line. */
export function formatSetupAlert(symbol, setup, rec = null) {
  return [
    `<b>NEW SETUP — ${escapeHtml(symbol)} ${escapeHtml(setup.timeframe)} ${DIR(setup.direction)}</b>`,
    formatSetupLine(symbol, setup),
    `If triggered: entry ${fmtPrice(setup.entry)} · stop ${fmtPrice(setup.stop)} · TP1 ${fmtPrice(setup.tp1)}`,
    `R:R gross ${fmtR(setup.grossRR)} · net ${fmtR(setup.netRR)}`,
    ...deliveryLines(rec)
  ].join('\n');
}

/** Plain number, no currency sign: 84466.1 -> "84,466.10". */
const fmtLevel = (v) => fmtPrice(v).replace('$', '');

/**
 * One-line WATCH / TRIGGERING alert, no chart:
 * "WATCH · BTC 3m LONG forming · break 84,466.10 / void 84,331.60 · 2.4R · td:bull:3/4"
 * The td segment is the symbol's top-down reason code from the recommendation, when present.
 */
export function formatWatchAlert(symbol, c, rec) {
  const codes = isObj(rec) ? [...(rec.supports || []), ...(rec.opposes || []), ...(rec.unknowns || [])] : [];
  const td = codes.map((x) => (typeof x === 'string' ? x : x && x.code)).find((x) => typeof x === 'string' && x.startsWith('td:'));
  const head = c.state === 'triggering' ? 'TRIGGERING' : 'WATCH';
  const parts = [
    head,
    `${escapeHtml(symbol)} ${escapeHtml(c.timeframe)} ${DIR(c.direction)} ${escapeHtml(c.state)}`,
    `break ${fmtLevel(c.breakoutLevel)} / void ${fmtLevel(c.invalidation)}`,
    isNum(c.measuredRR) ? `${Math.round(c.measuredRR * 10) / 10}R` : 'R n/a'
  ];
  if (td) parts.push(escapeHtml(td));
  // Schema 1.25.0: the symbol's readiness call and room line, one per line, when present.
  return [parts.join(' · '), ...deliveryLines(rec)].join('\n');
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
 * BREAKOUT (a candidate first reached confirmed), one line:
 * "BREAKOUT · BTC 5m LONG confirmed · brk 84,479.00 · void 84,349.70 · 3.9R ·
 *  entry = retest of 84,479.00 that holds · plan rejected: chase"
 * `plan` is the symbol's live plan when it is this candidate's, else null.
 */
export function formatBreakoutAlert(symbol, c, plan = null, rec = null) {
  const status = plan ? `plan ${escapeHtml(plan.status || 'n/a')}${plan.reasonCode ? `: ${escapeHtml(plan.reasonCode)}` : ''}` : 'plan: another candidate is selected';
  return [
    'BREAKOUT',
    `${escapeHtml(symbol)} ${escapeHtml(c.timeframe)} ${DIR(c.direction)} confirmed`,
    `brk ${isNum(c.breakoutLevel) ? fmtLevel(c.breakoutLevel) : 'n/a'}`,
    `void ${isNum(c.invalidation) ? fmtLevel(c.invalidation) : 'n/a'}`,
    isNum(c.measuredRR) ? `${Math.round(c.measuredRR * 10) / 10}R` : 'R n/a',
    `entry = retest of ${isNum(c.breakoutLevel) ? fmtLevel(c.breakoutLevel) : 'n/a'} that holds`,
    status
  ].join(' · ') + (rec ? deliveryLines(rec).map((l) => `\n${l}`).join('') : '');
}

export function formatGoodEnded(symbol, prev, s) {
  const rec = (s && s.flagRecommendation) || {};
  const klass = rec.class || 'DATA_UNAVAILABLE';
  const word = klass === 'BAD' ? 'rejected' : 'void';
  return [
    `<b>GOOD ENDED — ${escapeHtml(symbol)} ${escapeHtml(prev.planTimeframe || '')} ${DIR(prev.planDirection)}</b>`,
    `GOOD → ${escapeHtml(klass)} (${word})`,
    `Reason: ${escapeHtml(rec.primaryReason ? (rec.primaryReason.text || rec.primaryReason.code) : 'no recommendation')}`,
    `Do not enter this plan now. ${CALL[klass] || ''}`.trim()
  ].join('\n');
}

export function formatDataAlert(reasons, sinceIso, nowMs) {
  return [`<b>DATA PROBLEM</b> — since ${escapeHtml(fmtTime(sinceIso, nowMs))} (${fmtAge(sinceIso, nowMs)})`, ...reasons.map((r) => `• ${escapeHtml(r)}`), 'No calls are valid on this data.'].join('\n');
}

export function formatMarkAlert(symbol, mark, sinceIso, nowMs) {
  return `<b>MARK ${escapeHtml(mark && mark.status === 'stale' ? 'STALE' : 'UNAVAILABLE')} — ${escapeHtml(symbol)}</b>\nSince ${escapeHtml(fmtTime(sinceIso, nowMs))} (${fmtAge(sinceIso, nowMs)}). Check stops against the venue mark yourself.`;
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
    watch: { ids: [], lastAt: {} },
    buttons: {}
  };
}

/**
 * Stored prefs -> {level, quiet}. Unknown level -> 'setup'. quiet: missing -> the
 * default 01-05 Chicago; null -> off (the owner turned it off); malformed -> default.
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
  return { level, quiet };
}

/**
 * Apply an `/alerts` change to stored state text; returns the new state text. Only
 * `prefs` moves; the cron's alert memory is carried over untouched.
 * @param {string|null} text - current telegram/state.json
 * @param {{level?:string, quiet?:Object|null}} change
 */
export function applyPrefsChange(text, change) {
  const state = parseState(text);
  const prefs = { ...state.prefs };
  if (change && ALERT_LEVELS.includes(change.level)) prefs.level = change.level;
  if (change && 'quiet' in change) prefs.quiet = change.quiet;
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
      lastAt
    },
    buttons: pruneButtons(raw.buttons)
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
 * level, before that symbol's SETUP (a chase-rejected confirmed flag then also yields
 * one SETUP for the retest; neither repeats per candle).
 * GOOD, SETUP and BREAKOUT alerts carry `replyMarkup` (Why / Chart / Took it / Skipped) and store the
 * plan snapshot the Took it button logs in state.buttons[shortRef(candidateId)] (last 50).
 *
 * @returns {{alerts: Array<{kind:string, symbol:string|null, text:string, chart?:{symbol:string,timeframe:string}, replyMarkup?:Object}>, state: Object, changed: boolean}}
 */
export function diffAlerts(prevState, payload, nowMs) {
  const prev = migrateState(isObj(prevState) ? prevState : {}).state;
  const nowIso = new Date(nowMs).toISOString();
  const alerts = [];
  const state = JSON.parse(JSON.stringify(prev));
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const dataOk = payload && payload.dataStatus !== 'unavailable';
  const allow = (kind) => LEVEL_KINDS[prev.prefs.level].includes(kind);

  for (const k of Object.keys(syms).sort()) {
    const s = syms[k] || {};
    const rec = s.flagRecommendation || {};
    const plan = s.flagTradePlan || null;
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

    if (dataOk) {
      for (const c of Array.isArray(s.candidateSetups) ? s.candidateSetups : []) {
        if (!isObj(c) || typeof c.candidateId !== 'string' || c.state !== 'confirmed' || next.breakoutIds.includes(c.candidateId)) continue;
        next.breakoutIds = [...next.breakoutIds, c.candidateId].slice(-BREAKOUT_RECENT_IDS);
        if (!allow('BREAKOUT')) continue;
        const own = plan && plan.candidateId === c.candidateId ? plan : null;
        alerts.push({ kind: 'BREAKOUT', symbol: k, text: formatBreakoutAlert(k, c, own, rec), replyMarkup: { inline_keyboard: [tradeButtonRow(k, c.timeframe, c.candidateId)] } });
        const snap = {
          symbol: k, candidateId: c.candidateId, planId: own ? own.planId || null : null, recClass: rec.class || null,
          reasonCode: own ? own.reasonCode || null : null, timeframe: c.timeframe || null, direction: c.direction || null,
          entry: own && isNum(own.entry) ? own.entry : c.breakoutLevel ?? null,
          stop: own && isNum(own.stop) ? own.stop : c.invalidation ?? null,
          tp1: own && isNum(own.tp1) ? own.tp1 : c.measuredTarget ?? null
        };
        state.buttons = pruneButtons({ ...state.buttons, [shortRef(c.candidateId)]: { ...snap, at: nowIso } });
        next.lastAlertAt = nowIso;
      }
    }

    if (dataOk && next.class === 'GOOD' && plan && next.planCandidateId && !next.goodIds.includes(next.planCandidateId)) {
      alerts.push({ kind: 'GOOD', symbol: k, text: formatGoodAlert(k, s, payload, { nowMs }), chart: plan.timeframe ? { symbol: k, timeframe: plan.timeframe } : undefined, replyMarkup: { inline_keyboard: [tradeButtonRow(k, plan.timeframe, next.planCandidateId)] } });
      const snap = buttonSnapshot(k, s);
      if (snap) state.buttons = pruneButtons({ ...state.buttons, [shortRef(snap.candidateId)]: { ...snap, at: nowIso } });
      next.goodIds = remember(next.goodIds, next.planCandidateId);
      next.lastAlertAt = nowIso;
    }
    if (dataOk && next.setupId && !next.setupIds.includes(next.setupId)) {
      next.setupIds = remember(next.setupIds, next.setupId);
      if (allow('SETUP')) {
        alerts.push({ kind: 'SETUP', symbol: k, text: formatSetupAlert(k, rec.setup, rec), replyMarkup: { inline_keyboard: [tradeButtonRow(k, rec.setup.timeframe, next.setupId)] } });
        const snap = buttonSnapshot(k, { flagRecommendation: rec });
        if (snap) state.buttons = pruneButtons({ ...state.buttons, [shortRef(snap.candidateId)]: { ...snap, at: nowIso } });
        next.lastAlertAt = nowIso;
      }
    }
    if (before.class === 'GOOD' && next.class !== 'GOOD') {
      alerts.push({ kind: 'GOOD_ENDED', symbol: k, text: formatGoodEnded(k, before, s) });
      next.lastAlertAt = nowIso;
    }
    if (dataOk && allow('WATCH')) {
      for (const c of Array.isArray(s.candidateSetups) ? s.candidateSetups : []) {
        if (!isObj(c) || typeof c.candidateId !== 'string' || !WATCH_STATES.includes(c.state)) continue;
        const seen = state.watch.ids.find((e) => e.id === c.candidateId);
        const last = Date.parse(state.watch.lastAt[k]);
        const cooling = Number.isFinite(last) && nowMs - last < WATCH_COOLDOWN_MS;
        const fire = seen ? seen.state === 'forming' && c.state === 'triggering' : !cooling;
        if (!fire) continue;
        alerts.push({ kind: c.state === 'triggering' ? 'TRIGGERING' : 'WATCH', symbol: k, text: formatWatchAlert(k, c, rec) });
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
    if (prev.health.dataAlertAt) alerts.push({ kind: 'DATA_OK', symbol: null, text: '<b>DATA OK</b> — closed candles are fresh again.' });
    state.health.dataBadSince = null;
    state.health.dataAlertAt = null;
  }

  const today = nowIso.slice(0, 10);
  if (state.alerts.day !== today) state.alerts = { ...state.alerts, day: today, today: 0 };
  if (alerts.length) {
    const lastAlert = alerts[alerts.length - 1];
    state.alerts = { day: today, today: (state.alerts.today || 0) + alerts.length, last: { at: nowIso, symbol: lastAlert.symbol, kind: lastAlert.kind } };
  }

  const strip = (st) => JSON.stringify({ ...st, updatedAt: null, cron: null });
  const moved = strip(state) !== strip(prev);
  const lastRun = Date.parse(prev.cron.lastRunAt);
  const heartbeatDue = !Number.isFinite(lastRun) || nowMs - lastRun >= HEARTBEAT_WRITE_MS;
  state.cron = { ...state.cron, lastRunAt: nowIso };
  state.updatedAt = nowIso;
  state.stateVersion = STATE_VERSION;
  return { alerts, state, changed: moved || heartbeatDue };
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
      ? `<b>ALERTS CRON RECOVERED</b> · after ${h.failures} failed runs since ${escapeHtml(fmtTime(h.since, nowMs))}`
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
  return { health: next, message: `<b>ALERTS CRON FAILING</b> · ${escapeHtml(reason)} · since ${escapeHtml(fmtTime(next.since, nowMs))}`, write: true };
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
      if (res.ok && body && body.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: body && typeof body.description === 'string' ? body.description.slice(0, 200) : `http_${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err && err.name === 'TimeoutError' ? 'timeout' : (err && err.name) || 'error' };
    }
  }
  return {
    /** Sends `text` (HTML) to one chat, chunked under 4,000 chars; `replyMarkup` rides on the last chunk. */
    async sendMessage(chatId, text, { silent = false, replyMarkup = null } = {}) {
      const results = [];
      const parts = chunkMessage(text);
      for (let i = 0; i < parts.length; i++) {
        const body = { chat_id: chatId, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent };
        if (replyMarkup && i === parts.length - 1) body.reply_markup = replyMarkup;
        results.push(await call('sendMessage', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      }
      return results.every((r) => r.ok) ? { ok: true, status: 200, parts: results.length } : results.find((r) => !r.ok);
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
  formatSymbolBlock, formatSignals, formatDataBlock, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp,
  formatGoodAlert, formatSetupAlert, formatGoodEnded, formatDataAlert, formatMarkAlert, formatSetupLine, formatWatchAlert,
  collectLiveFlags, capFlagCharts, formatFlagLine, formatFlagCaption, formatNoLiveFlags, chunkMediaGroup, emaTailSeries, albumSeries,
  formatBreakoutAlert, formatCall, formatReadinessLine, formatRoomLine, formatAlertPrefs, fmtQuiet, parseAlertsArgs, parseMenuLabel, menuKeyboard, chartsKeyboard, alertsKeyboard, shortRef,
  tradeButtonRow, buttonSnapshot, signalsKeyboard, parseCallbackData, buttonLogBody, findButtonSnapshot, parseQuietSpec, normalizePrefs, applyPrefsChange, chicagoHour,
  emptyState, parseState, migrateState, diffAlerts, dataProblems, createBotClient, inQuietHours,
  emptyHealth, parseHealth, nextCronHealth, errText
};
