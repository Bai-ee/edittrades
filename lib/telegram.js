/**
 * Telegram alerts + read commands (T-1, docs/PLAN_TELEGRAM.md).
 *
 * Three parts, all read-only toward the engine and never execution:
 *   1. Pure formatters: context payload -> Telegram HTML messages (one metric per line,
 *      mirroring the GPT FORMAT: GO IN / HOLD / DON'T lines plus the SETUP line).
 *   2. Pure alert state machine (`diffAlerts`): previous `telegram/state.json` + a fresh
 *      compact payload -> the alerts to send and the next state. Dedup is by candidate id
 *      (a planId carries closedThrough, so it changes every candle and cannot dedup).
 *   3. A Bot API client (`createBotClient`): sendMessage / sendPhoto with a 5 s timeout.
 *      It never throws and never puts the token in a return value or a log line.
 *
 * No imports: nothing here can reach a wallet, a signer or an execution path. There is
 * no /buy, /sell, /open or /close command, by design.
 */

export const TELEGRAM_STATE_PATH = 'telegram/state.json';
export const TELEGRAM_STATE_SCHEMA = 'telegram-state-1';
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

export const COMMANDS = Object.freeze(['start', 'help', 'signals', 'why', 'flags', 'wallet', 'journal', 'status', 'chart', 'log', 'testalert']);
export const SYMBOLS = Object.freeze(['BTC', 'SOL', 'ETH']);

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
  if (klass === 'GOOD' && plan) {
    lines.push(`<b>${escapeHtml(symbol)} — ${DIR(plan.direction)} — ${escapeHtml(plan.timeframe)}</b>`);
    lines.push(CALL.GOOD);
    lines.push(...planLines(plan));
    if (rec.qualityBand) lines.push(`Quality: ${escapeHtml(rec.qualityBand)}`);
    const change = changeText(rec, 'call_changes_on_invalidation');
    if (change) lines.push(`Changes if: ${escapeHtml(change)}`);
  } else {
    lines.push(`<b>${escapeHtml(symbol)} — NO TRADE</b>`);
    lines.push(CALL[klass] || escapeHtml(klass));
    const reasonText = rec && rec.primaryReason ? (rec.primaryReason.text || rec.primaryReason.code) : 'no recommendation';
    lines.push(`Reason: ${escapeHtml(reasonText)}`);
    const confirm = changeText(rec);
    if (confirm && confirm !== reasonText) lines.push(`Confirmation: ${escapeHtml(confirm)}`);
  }
  lines.push(markLine(s && s.mark));
  const setupLine = formatSetupLine(symbol, rec && rec.setup);
  if (setupLine) lines.push(setupLine);
  return lines.join('\n');
}

/** DATA block, same fields as the GPT FORMAT's DATA section. */
export function formatDataBlock(payload, nowMs = null) {
  const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings : [];
  return [
    '<b>DATA</b>',
    `Generated At: ${escapeHtml(payload && payload.generatedAt ? fmtTime(payload.generatedAt, nowMs) : 'n/a')}`,
    `Closed Through: ${escapeHtml(payload && payload.closedThrough ? `${fmtTime(payload.closedThrough, nowMs)}${isNum(nowMs) ? ` (${fmtAge(payload.closedThrough, nowMs)})` : ''}` : 'n/a')}`,
    `Data: ${escapeHtml(payload && payload.dataStatus ? payload.dataStatus : 'n/a')}`,
    `Schema/Config: ${escapeHtml(payload && payload.schemaVersion)} · ${escapeHtml(payload && payload.configVersion)}`,
    `Warnings: ${warnings.length ? escapeHtml(warnings.slice(0, 5).join('; ')) : 'None'}`
  ].join('\n');
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
export function formatStatus(payload, state, nowMs) {
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
  return lines.join('\n');
}

export function formatHelp() {
  return [
    '<b>EditTrades bot</b> — read-only. It never places, signs or closes a trade.',
    '/signals — BTC/ETH/SOL call now, GO IN / HOLD / DON\'T + SETUP lines',
    '/why SYM — supports, against, unknowns, what changes',
    '/flags [SYM] — every flag candidate and its state',
    '/chart SYM TF — confirmation chart, e.g. /chart BTC 5m',
    '/wallet — read-only account block',
    '/journal [n] — last n journal lines (default 10)',
    '/log text — journal a line, e.g. /log took BTC long entry 84600 stop 84390 tp 85100',
    '/status — schema, data age, marks, last alert, cron',
    '/testalert — sample GOOD card with chart (labeled TEST)',
    'Alerts arrive on their own: new GOOD, new SETUP, GOOD ended, data or mark down over 5 min.'
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
  const lines = [head, CALL.GOOD, ...planLines(plan)];
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

export function formatSetupAlert(symbol, setup) {
  return [
    `<b>NEW SETUP — ${escapeHtml(symbol)} ${escapeHtml(setup.timeframe)} ${DIR(setup.direction)}</b>`,
    formatSetupLine(symbol, setup),
    `If triggered: entry ${fmtPrice(setup.entry)} · stop ${fmtPrice(setup.stop)} · TP1 ${fmtPrice(setup.tp1)}`,
    `R:R gross ${fmtR(setup.grossRR)} · net ${fmtR(setup.netRR)}`
  ].join('\n');
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
    updatedAt: null,
    cron: { lastRunAt: null },
    symbols: {},
    health: { dataBadSince: null, dataAlertAt: null, marks: {} },
    alerts: { day: null, today: 0, last: null }
  };
}

/** Parse stored state text; anything malformed becomes an empty state. */
export function parseState(text) {
  let raw = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  const base = emptyState();
  if (!isObj(raw)) return base;
  return {
    ...base,
    ...raw,
    cron: { ...base.cron, ...(isObj(raw.cron) ? raw.cron : {}) },
    symbols: isObj(raw.symbols) ? raw.symbols : {},
    health: { ...base.health, ...(isObj(raw.health) ? raw.health : {}), marks: isObj(raw.health && raw.health.marks) ? raw.health.marks : {} },
    alerts: { ...base.alerts, ...(isObj(raw.alerts) ? raw.alerts : {}) }
  };
}

function remember(list, id) {
  const out = (Array.isArray(list) ? list : []).filter((x) => x !== id);
  out.push(id);
  return out.slice(-RECENT_IDS);
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
 * No transition -> no alert; `changed` is false unless something besides the heartbeat
 * moved, or the heartbeat is older than HEARTBEAT_WRITE_MS.
 *
 * @param {Object} prevState - parseState output
 * @param {Object} payload - compact context payload
 * @param {number} nowMs
 * @returns {{alerts: Array<{kind:string, symbol:string|null, text:string, chart?:{symbol:string,timeframe:string}}>, state: Object, changed: boolean}}
 */
export function diffAlerts(prevState, payload, nowMs) {
  const prev = parseState(JSON.stringify(prevState || {}));
  const nowIso = new Date(nowMs).toISOString();
  const alerts = [];
  const state = JSON.parse(JSON.stringify(prev));
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const dataOk = payload && payload.dataStatus !== 'unavailable';

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
      setupIds: Array.isArray(before.setupIds) ? before.setupIds : []
    };

    if (dataOk && next.class === 'GOOD' && plan && next.planCandidateId && !next.goodIds.includes(next.planCandidateId)) {
      alerts.push({ kind: 'GOOD', symbol: k, text: formatGoodAlert(k, s, payload, { nowMs }), chart: plan.timeframe ? { symbol: k, timeframe: plan.timeframe } : undefined });
      next.goodIds = remember(next.goodIds, next.planCandidateId);
      next.lastAlertAt = nowIso;
    }
    if (dataOk && next.setupId && !next.setupIds.includes(next.setupId)) {
      alerts.push({ kind: 'SETUP', symbol: k, text: formatSetupAlert(k, rec.setup) });
      next.setupIds = remember(next.setupIds, next.setupId);
      next.lastAlertAt = nowIso;
    }
    if (before.class === 'GOOD' && next.class !== 'GOOD') {
      alerts.push({ kind: 'GOOD_ENDED', symbol: k, text: formatGoodEnded(k, before, s) });
      next.lastAlertAt = nowIso;
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
  return { alerts, state, changed: moved || heartbeatDue };
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
    /** Sends `text` (HTML) to one chat, chunked under 4,000 chars. */
    async sendMessage(chatId, text, { silent = false } = {}) {
      const results = [];
      for (const part of chunkMessage(text)) {
        results.push(await call('sendMessage', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent })
        }));
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
    }
  };
}

/** Quiet hours "22-7" (UTC, start-end) -> true when nowMs falls inside. Unset -> false. */
export function inQuietHours(spec, nowMs) {
  const m = String(spec || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]) % 24, Number(m[2]) % 24];
  const h = new Date(nowMs).getUTCHours();
  return a === b ? false : a < b ? h >= a && h < b : h >= a || h < b;
}

export default {
  escapeHtml, fmtPrice, chunkMessage, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSymbolBlock, formatSignals, formatDataBlock, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp,
  formatGoodAlert, formatSetupAlert, formatGoodEnded, formatDataAlert, formatMarkAlert, formatSetupLine,
  emptyState, parseState, diffAlerts, dataProblems, createBotClient, inQuietHours
};
