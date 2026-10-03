/**
 * Homepage (index.html) flag-finder sections, in page order:
 *
 *   #home-hero-shell        copy + CTAs, and the called-flags scoreboard card (#called-flags-card)
 *   #live-board-section     "Should I get in right now?" - one card per data/board.json entry
 *   #how-it-works-section   "How a call is made": 6-step pipeline (numbers from board.json flowRules, else defaults)
 *   #tuning-section         "Tuning toward 70%": live rule vs recommended rule + bucket tables (data/flag-calibration.json)
 *   #process-section        "What we watch" stats (pulse numbers + static facts) and #existing-pages
 *
 * Inputs are plain JSON files written elsewhere: data/called-flags.json (scorer) and data/board.json
 * (collect.js saveBoard). Nothing here computes a number; a missing file renders an honest empty state.
 * The 24H / 7D / 30D toggle runs client-side from the embedded JSON (no network).
 * Class names are prefixed hf- so they never collide with the older homepage zones.
 */

import { esc } from './bento.js';

const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const WINDOWS = [['24h', '24H', 'last 24 hours'], ['7d', '7D', 'last 7 days'], ['30d', '30D', 'last 30 days']];
const DEFAULT_WINDOW = '30d';
export const TARGET_RATE = 70;

// Owner to supply: the Telegram bot and Custom GPT public links (placeholders until then).
export const TELEGRAM_CTA_HREF = '#';
export const GPT_CTA_HREF = '#';

/** The hero buttons. Placeholder href ('#') until the owner supplies the real links. */
function ctaRow() {
  return `<div id="home-hero-ctas"><a class="hf-btn" id="home-hero-telegram-cta" href="${TELEGRAM_CTA_HREF}">Get alerts in Telegram</a>`
    + `<a class="hf-btn ghost" id="home-hero-gpt-cta" href="${GPT_CTA_HREF}">Ask the GPT</a></div>`;
}

const timeZ = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}Z`;
};
const fmtVal = (v) => {
  if (isNum(v)) return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 4 });
  return typeof v === 'string' && v.trim() ? v : dash;
};
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

/** Display numbers for one window; pure, shared shape with the inline script below. */
export function windowView(w) {
  const side = (s) => {
    const x = s || {};
    const right = x.right || 0;
    const resolved = right + (x.wrong || 0);
    return { called: x.called || 0, right, pct: pctOf(right, resolved) };
  };
  const t = (w && w.total) || {};
  const right = t.right || 0;
  const resolved = right + (t.wrong || 0);
  return {
    rate: isNum(w && w.rate) ? w.rate : null,
    right, resolved,
    long: side(w && w.long), short: side(w && w.short),
    called: t.called || 0, wrong: t.wrong || 0, flat: t.flat || 0
  };
}

/** True when the file is missing or it has never called a flag. */
function isEmptyCalled(data) {
  if (!data || typeof data !== 'object' || !data.windows) return true;
  return !WINDOWS.some(([k]) => ((data.windows[k] || {}).total || {}).called > 0)
    && !(Array.isArray(data.recent) && data.recent.length);
}

/** Target meter state for a rate: 'meets' at or above the target, 'below' under it, 'none' without a rate. */
export function targetState(rate) {
  return !isNum(rate) ? 'none' : rate >= TARGET_RATE ? 'meets' : 'below';
}

const OUTCOME_CLASS = { right: 'right', wrong: 'wrong', flat: 'flat', open: 'open', no_data: 'nodata' };
const dirArrow = (d) => (d === 'short' ? '▼' : '▲');

function recentStrip(recent) {
  const rows = (Array.isArray(recent) ? recent : [])
    .filter((r) => r && Number.isFinite(Date.parse(r.calledAt)))
    .sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt))
    .slice(-20);
  return rows.map((r) => {
    const cls = OUTCOME_CLASS[r.outcome] || 'nodata';
    const title = `${r.symbol || ''} ${r.timeframe || ''} ${r.direction || ''} · ${String(r.outcome || '').replace('_', ' ')}`.trim();
    return `<span class="hf-dot ${cls}" title="${esc(title)}">${dirArrow(r.direction)}</span>`;
  }).join('');
}

/** Muted line for calls made before the checklist rule; only when there were any. */
function legacyLine(l) {
  if (!l || !isNum(l.called) || l.called <= 0) return '';
  const resolved = (l.right || 0) + (l.wrong || 0);
  const pct = isNum(l.rate) ? l.rate : pctOf(l.right || 0, resolved);
  return `<p id="called-flags-legacy">Earlier calls (before the checklist rule): ${l.called}${pct === null ? '' : ` · ${pct}% right`}</p>`;
}

/** The scoreboard card. `data` = parsed data/called-flags.json or null. */
export function calledFlagsCard(data) {
  const head = (toggle) => `<div id="called-flags-header"><span class="label" id="called-flags-title">Called flags · <span id="win-label">${esc(WINDOWS.find(([k]) => k === DEFAULT_WINDOW)[2])}</span></span>${toggle}</div>`;
  const rule = data && typeof data.rule === 'string' && data.rule
    ? `<p id="called-flags-rule">${esc(data.rule)}</p>` : '';
  if (isEmptyCalled(data)) {
    const since = data && data.since && timeZ(data.since) ? String(data.since).slice(0, 10) : 'today';
    return `<article id="called-flags-card" data-section="called-flags" aria-labelledby="called-flags-title">`
      + `<span class="label" id="called-flags-title">Called flags</span>`
      + `<p id="called-flags-empty">No called flags yet — counting started ${esc(since)}</p>${rule}</article>`;
  }
  const v = windowView(data.windows[DEFAULT_WINDOW]);
  const toggle = `<div class="hf-seg" id="called-flags-window-toggle" role="group" aria-label="Window">`
    + WINDOWS.map(([k, label]) => `<button type="button" id="win-${k}" data-win="${k}" aria-pressed="${k === DEFAULT_WINDOW}">${label}</button>`).join('')
    + `</div>`;
  const sidePanel = (id, cls, arrow, word, s, key) => `<div class="hf-side ${cls}" id="${id}">`
    + `<div class="hf-side-head"><span class="hf-dir">${arrow} ${word}</span><span class="hf-pct num" id="${key}-pct">${s.pct === null ? dash : `${s.pct}%`}</span></div>`
    + `<div class="hf-bar" aria-hidden="true"><i id="${key}-bar" style="width:${s.pct || 0}%"></i></div>`
    + `<span class="hf-line num" id="${key}-line">${s.called} called · ${s.right} right</span></div>`;
  const tally = (cls, key, n, label) => `<div${cls ? ` class="${cls}"` : ''}><b class="num" id="t-${key}">${n}</b><span class="label">${label}</span></div>`;
  const legend = (color, label) => `<span><i style="${color}"></i>${label}</span>`;
  return `<article id="called-flags-card" data-section="called-flags" aria-labelledby="called-flags-title">`
    + head(toggle)
    + `<div id="called-flags-rate-row"><div id="called-flags-rate" class="num"><span id="rate-val">${v.rate === null ? dash : v.rate}</span>${v.rate === null ? '' : '<small>%</small>'}</div>`
    + `<div id="called-flags-rate-caption"><strong>went our way</strong><span id="rate-sub">${v.right} of ${v.resolved} resolved calls</span></div></div>`
    + `<div id="called-flags-target" data-state="${targetState(v.rate)}"><div id="called-flags-target-text"><b class="num" id="target-rate">${v.rate === null ? dash : `${v.rate}%`}</b><span> · target ${TARGET_RATE}%</span><span class="hf-pill" id="target-pill">${targetState(v.rate) === 'meets' ? 'on target' : 'below target'}</span></div>`
    + `<div class="hf-meter" id="called-flags-target-meter" aria-hidden="true"><i id="target-fill" style="width:${Math.min(100, v.rate || 0)}%"></i><u id="target-tick" style="left:${TARGET_RATE}%"></u></div>`
    + `<span class="hf-line num" id="target-n">n=${v.resolved} resolved${v.resolved < 30 ? ' · small sample, not proof yet' : ''}</span></div>`
    + `<div id="called-flags-split">${sidePanel('called-flags-long', 'up', '▲', 'LONG', v.long, 'long')}${sidePanel('called-flags-short', 'down', '▼', 'SHORT', v.short, 'short')}</div>`
    + `<div id="called-flags-tally">${tally('', 'called', v.called, 'Called')}${tally('', 'right', v.right, 'Right')}${tally('', 'wrong', v.wrong, 'Wrong')}${tally('flat', 'flat', v.flat, 'Flat')}</div>`
    + `<div id="called-flags-recent"><span class="label">Last 20 calls · newest right</span>`
    + `<div id="recent-strip" aria-label="Last 20 calls">${recentStrip(data.recent)}</div>`
    + `<div id="recent-legend">${legend('background:var(--success)', 'right')}${legend('background:var(--accent)', 'wrong')}${legend('background:var(--warning)', 'flat')}${legend('border:1px dashed var(--border-visible)', 'still running')}</div></div>`
    + legacyLine(data.legacy)
    + rule
    + `</article>`
    + `<script type="application/json" id="called-flags-data">${JSON.stringify({ windows: data.windows }).replace(/</g, '\\u003c')}</script>`;
}

/** Hero: copy + CTAs on the left, the scoreboard card on the right. */
export function homeFlagHero(called) {
  return `<div id="home-hero-shell" data-section="home-hero">`
    + `<div id="home-hero-copy"><span class="label">BTC · ETH · SOL · 1m to 4h</span>`
    + `<h1 id="home-hero-title">We find the flag, call the direction, and count every call.</h1>`
    + `<p id="home-hero-lede">When a flag passes the checklist and breaks, we send it as a lock opportunity: long or short, with entry, stop and targets. This card is the scoreboard for those calls.</p>`
    + ctaRow()
    + `</div>`
    + calledFlagsCard(called)
    + `</div>`;
}

const STAGE = {
  lockable: { cls: 'lock', word: 'LOCK NOW', icon: '🟢' },
  found: { cls: 'found', word: 'FORMING', icon: '🟡' },
  watch: { cls: 'watch', word: 'WATCHING', icon: '⚪' },
  missed: { cls: 'missed', word: 'MISSED', icon: '⚫' }
};

function actionLine(e, lv) {
  const dir = String(e.dir || '').toLowerCase();
  if (e.stage === 'lockable') return '⏱ Enter now';
  if (e.stage === 'found') return `⏳ Needs a ${esc(e.tf || '')} close ${dir.startsWith('s') ? 'below' : 'above'} ${esc(fmtVal(lv.ent))}`;
  if (e.stage === 'missed') return 'Missed';
  return 'Not ready';
}

/** One board card in the owner's snapshot order: status, number-then-label rows, checklist, action. */
function boardCard(e, i) {
  const lv = e.lv && typeof e.lv === 'object' ? e.lv : {};
  const st = STAGE[e.stage] || STAGE.watch;
  const dir = String(e.dir || '').toLowerCase();
  const row = (cls, value, label) => `<div class="hf-lv"><b class="hf-lv-val ${cls}">${esc(fmtVal(value))}</b><span class="hf-lv-label">${label}</span></div>`;
  return `<article class="hf-flag-card" id="live-board-card-${i + 1}" data-stage="${esc(e.stage || '')}">`
    + `<div class="hf-flag-top"><span class="hf-sym">${esc(e.sym || '')} ${esc(e.tf || '')} ${dir.startsWith('s') ? '▼' : '▲'}</span>`
    + `<span class="hf-chip ${st.cls}" id="live-board-card-${i + 1}-status">${st.icon} ${st.word}</span></div>`
    + `<div class="hf-levels num">${row('hf-v-entry', lv.ent, 'Entry')}${row('hf-v-valid', lv.cap, 'Valid')}${row('hf-v-tp', lv.tp1, 'TP')}${row('hf-v-inval', lv.inv, 'Inval')}${row('hf-v-sl', lv.stop, 'SL')}</div>`
    + `<div class="hf-checklist">Checklist ${esc(e.score || dash)}${e.tfs ? ` · ${esc(e.tfs)}` : ''}</div>`
    + `<div class="hf-action">${actionLine(e, lv)}</div></article>`;
}

/** "Should I get in right now?" - `board` = parsed data/board.json or null. */
export function liveBoardSection(board) {
  const entries = board && Array.isArray(board.board) ? board.board.filter((e) => e && typeof e === 'object').slice(0, 3) : [];
  const asOf = board && board.closedThrough ? timeZ(board.closedThrough) : null;
  const sub = `Same board as Telegram and the GPT${asOf ? ` · updated ${asOf}` : ''}`;
  const body = entries.length
    ? entries.map(boardCard).join('')
    : `<p id="live-board-empty">No flags passing the checklist right now.</p>`;
  return `<div id="live-board-section" data-section="live-board">`
    + `<div class="hf-sec-head"><h2>Should I get in right now?</h2><span class="label" id="live-board-asof">${esc(sub)}</span></div>`
    + `<div id="live-board-grid">${body}</div></div>`;
}

// ---------------------------------------------------------------- how it works

const DEFAULT_RULES = {
  minScore: '5/7', timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '4h'], capAtr: 1.5, windowCandles: 6,
  scoring: '1x ATR in the called direction before 1x ATR against, within 12 candles of the flag timeframe'
};
const ruleNum = (v, d) => (isNum(v) ? v : d);
const ruleStr = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);

/** "How a call is made": six plain-language steps. `board` = parsed data/board.json (flowRules optional). */
export function howItWorksSection(board) {
  const fr = board && board.flowRules && typeof board.flowRules === 'object' ? board.flowRules : {};
  const minScore = ruleStr(fr.minScore, DEFAULT_RULES.minScore);
  const capAtr = ruleNum(fr.capAtr, DEFAULT_RULES.capAtr);
  const candles = ruleNum(fr.windowCandles, DEFAULT_RULES.windowCandles);
  const scoring = ruleStr(fr.scoring, DEFAULT_RULES.scoring);
  const steps = [
    ['data', 'Data', 'Closed candles from Kraken, 1m to 1D, for BTC, ETH and SOL. Live price from Pyth.'],
    ['indicators', 'Indicators', 'EMA21, EMA200, Stoch RSI and volume, computed on every timeframe.'],
    ['flag-finder', 'Flag finder', 'An impulse move, then a tight pause riding the EMA21, on 1m to 4h.'],
    ['checklist', 'Checklist', `Seven timeframes are checked. A flag needs ${minScore} aligned to go out with the trade.`],
    ['lock-now', 'Lock now', `Entry is the breakout, stop is where the flag is invalid, target is the measured move. Valid until price is ${capAtr} ATR past entry, for ${candles} candles.`],
    ['scoring', 'Scoring', `Every call is scored: ${scoring}.`]
  ];
  return `<div id="how-it-works-section" data-section="how-it-works">`
    + `<div class="hf-sec-head"><h2>How a call is made</h2><span class="label">The data we use and how it is processed</span></div>`
    + `<ol id="how-it-works-steps">${steps.map(([key, title, line], i) => `<li class="hf-step" id="how-step-${key}"><span class="hf-step-n num">${i + 1}</span><div><strong>${title}</strong><p>${esc(line)}</p></div></li>`).join('')}</ol>`
    + `</div>`;
}

// ---------------------------------------------------------------- tuning

const MIN_N_DEFAULT = 30;
const PILL_WORD = { meets: 'meets 70%', below: 'below 70%', thin: 'thin', needs_data: 'needs data' };
const pill = (status) => `<span class="hf-pill ${esc(status in PILL_WORD ? status : 'thin')}">${PILL_WORD[status] || 'thin'}</span>`;
const pct = (r) => (isNum(r) ? `${Math.round(r)}%` : dash);

function ruleText(r) {
  if (!r || typeof r !== 'object') return dash;
  const parts = [];
  if (r.minScore) parts.push(`checklist ${esc(r.minScore)}`);
  if (Array.isArray(r.timeframes) && r.timeframes.length) parts.push(`timeframes ${esc(r.timeframes.join(', '))}`);
  if (isNum(r.minRR)) parts.push(`reward:risk at least ${r.minRR}`);
  if (r.nextTf === 'agrees') parts.push('next timeframe agrees');
  return parts.join(' · ') || dash;
}

const BUCKET_TABLES = [['score', 'Checklist score'], ['timeframe', 'Timeframe'], ['rr', 'Reward:risk'], ['nextTf', 'Next timeframe'], ['symbol', 'Coin'], ['direction', 'Direction']];

function bucketTable(id, title, rows, minN) {
  const body = rows.map((b) => {
    const thin = b.status === 'thin';
    const status = b.status === 'meets' || b.status === 'below' ? b.status : 'thin';
    const state = thin ? `<span class="hf-pill thin">needs ${minN}</span>` : pill(status);
    return `<tr class="hf-bucket ${status}"><th scope="row">${esc(b.key)}</th><td class="num">${isNum(b.n) ? b.n : 0}</td><td class="num">${thin ? dash : pct(b.rate)}</td><td>${state}</td></tr>`;
  }).join('');
  return `<div class="hf-bucket-card" id="${id}"><span class="label">${title}</span>`
    + `<table><thead><tr><th scope="col">Bucket</th><th scope="col">n</th><th scope="col">Right</th><th scope="col">Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/** "Tuning toward 70%": live vs recommended rule and bucket tables. `cal` = data/flag-calibration.json or null. */
export function tuningSection(board, cal) {
  const head = `<div class="hf-sec-head"><h2>Tuning toward 70%</h2><span class="label">We only tighten the rule when a bucket proves itself</span></div>`;
  const note = `<p id="tuning-note">We only tighten the rule when a bucket proves itself over at least ${cal && isNum(cal.minN) ? cal.minN : MIN_N_DEFAULT} resolved calls. Target: ${cal && isNum(cal.target) ? cal.target : TARGET_RATE}% right.</p>`;
  if (!cal || typeof cal !== 'object' || !cal.buckets) {
    return `<div id="tuning-section" data-section="tuning">${head}${note}<p id="tuning-empty">No calibration yet. It appears once enough calls have resolved.</p></div>`;
  }
  const minN = isNum(cal.minN) ? cal.minN : MIN_N_DEFAULT;
  const fr = board && board.flowRules && typeof board.flowRules === 'object' ? board.flowRules : null;
  const rec = cal.recommended && typeof cal.recommended === 'object' ? cal.recommended : null;
  const recStatus = rec && PILL_WORD[rec.status] ? rec.status : 'needs_data';
  const proj = rec && rec.projected && typeof rec.projected === 'object' ? rec.projected : null;
  const projLine = proj && isNum(proj.n) && proj.n > 0 ? `Projected on past calls: ${pct(proj.rate)} right, n=${proj.n}` : 'Projected rate: not enough resolved calls';
  const live = `<div class="hf-rule-card" id="tuning-live-rule"><span class="label">Live rule</span><p>${fr ? ruleText({ minScore: fr.minScore, timeframes: fr.timeframes }) : dash}</p></div>`;
  const recommended = `<div class="hf-rule-card" id="tuning-recommended-rule" data-status="${esc(recStatus)}"><span class="label">Recommended rule ${pill(recStatus)}</span>`
    + `<p>${rec ? ruleText(rec.rule) : dash}</p><p class="hf-line num">${esc(projLine)}</p>${rec && rec.reason ? `<p class="hf-reason">${esc(rec.reason)}</p>` : ''}</div>`;
  const tables = BUCKET_TABLES
    .filter(([k]) => Array.isArray(cal.buckets[k]) && cal.buckets[k].length)
    .map(([k, title]) => bucketTable(`tuning-bucket-${k.toLowerCase()}`, title, cal.buckets[k].filter((b) => b && typeof b === 'object'), minN)).join('');
  const scored = isNum(cal.scored) ? `<span class="label" id="tuning-scored">${cal.scored} resolved calls scored</span>` : '';
  return `<div id="tuning-section" data-section="tuning">${head}${note}${scored}`
    + `<div id="tuning-rules-row">${live}${recommended}</div>`
    + `<div id="tuning-buckets">${tables}</div></div>`;
}

const PAGES = [
  ['strategies.html', 'Strategies', 'Every strategy, its timeframes and its live scoreboard'],
  ['predictions.html', 'Predictions', 'Next-candle calls on every close, against a coin flip'],
  ['risk.html', 'Risk', 'Stops, sizing and what each call risks after fees'],
  ['spot.html', 'Spot', 'The slow trend arm for holding, not trading'],
  ['product.html', 'Product', 'How the flag finder, lock and alerts fit together'],
  ['how-to.html', 'How to', 'Lock a flag in Telegram, ask the GPT "now?"'],
  ['changelog.html', 'Changelog', 'System map and every change, newest first']
];

/** "What we watch" stats + links to the other pages. `board` supplies the pulse numbers. */
export function processSection(board) {
  const p = board && board.pulse && typeof board.pulse === 'object' ? board.pulse : null;
  const since = p && p.partial ? (timeZ(p.since) || (typeof p.since === 'string' ? p.since : null)) : null;
  const window = p && p.partial && since ? `since ${since}` : '24h';
  const pv = (k) => (p && isNum(p[k]) ? p[k].toLocaleString('en-US') : dash);
  const stat = (id, n, label) => `<div class="hf-stat" id="${id}"><b class="num">${n}</b><span class="label">${label}</span></div>`;
  return `<div id="process-section" data-section="what-we-process">`
    + `<div class="hf-sec-head"><h2>What we watch, every minute</h2><span class="label">The engine behind every call</span></div>`
    + `<div id="process-stats">${stat('process-stat-coins', 3, 'Coins')}${stat('process-stat-timeframes', 7, 'Timeframes read')}`
    + stat('process-stat-found', pv('found'), `Flags found ${esc(window)}`) + stat('process-stat-opps', pv('opps'), `Lock opps ${esc(window)}`)
    + stat('process-stat-locked', pv('locked'), `Locked ${esc(window)}`) + stat('process-stat-scans', '1,440', 'Scans a day')
    + `</div>`
    + `<div id="existing-pages">${PAGES.map(([href, name, blurb]) => `<a class="hf-page-link" id="home-page-link-${href.replace('.html', '')}" href="${href}"><strong>${name}</strong><span>${esc(blurb)}</span></a>`).join('')}</div>`
    + `</div>`;
}

/** Inline script: the 24H/7D/30D toggle, from the embedded JSON. Appended to the page's single script. */
export function homeFlagsScript() {
  return `(function(){var d=document.getElementById('called-flags-data');if(!d)return;var W;try{W=JSON.parse(d.textContent).windows;}catch(e){return;}`
    + `var L={'24h':'last 24 hours','7d':'last 7 days','30d':'last 30 days'};`
    + `function $(i){return document.getElementById(i);}`
    + `function pc(a,b){return b>0?Math.round(a/b*100):null;}`
    + `function side(k,s){s=s||{};var r=s.right||0,p=pc(r,r+(s.wrong||0));$(k+'-pct').textContent=p===null?'\\u2013':p+'%';$(k+'-bar').style.width=(p||0)+'%';$(k+'-line').textContent=(s.called||0)+' called \\u00b7 '+r+' right';}`
    + `function show(w){var x=W[w];if(!x)return;var t=x.total||{},r=t.right||0;$('win-label').textContent=L[w];`
    + `var rv=$('rate-val');rv.textContent=typeof x.rate==='number'?x.rate:'\\u2013';var sm=rv.parentNode.querySelector('small');if(sm)sm.style.display=typeof x.rate==='number'?'':'none';`
    + `var rt=typeof x.rate==='number'?x.rate:null,n=r+(t.wrong||0),tg=$('called-flags-target');tg.dataset.state=rt===null?'none':rt>=70?'meets':'below';`
    + `$('target-rate').textContent=rt===null?'\\u2013':rt+'%';$('target-pill').textContent=rt!==null&&rt>=70?'on target':'below target';$('target-fill').style.width=Math.min(100,rt||0)+'%';`
    + `$('target-n').textContent='n='+n+' resolved'+(n<30?' \\u00b7 small sample, not proof yet':'');`
    + `$('rate-sub').textContent=r+' of '+(r+(t.wrong||0))+' resolved calls';side('long',x.long);side('short',x.short);`
    + `$('t-called').textContent=t.called||0;$('t-right').textContent=r;$('t-wrong').textContent=t.wrong||0;$('t-flat').textContent=t.flat||0;`
    + `document.querySelectorAll('#called-flags-window-toggle button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.win===w));});`
    + `try{localStorage.setItem('flagWin',w);}catch(e){}}`
    + `document.querySelectorAll('#called-flags-window-toggle button').forEach(function(b){b.addEventListener('click',function(){show(b.dataset.win);});});`
    + `var s='30d';try{s=localStorage.getItem('flagWin')||'30d';}catch(e){}show(W[s]?s:'30d');})();`;
}

export const HOME_FLAGS_CSS = `
/* flag-finder homepage sections (home-flags.js): hf- prefixed, mapped onto the page tokens */
:root{--hf-entry:#3F8A50;--hf-valid:#2563EB;--hf-inval:#C2570C;--hf-sl:#D71921}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--hf-entry:#5BB56E;--hf-valid:#6EA8FF;--hf-inval:#FF9A3D;--hf-sl:#FF3B42}}
:root[data-theme="dark"]{--hf-entry:#5BB56E;--hf-valid:#6EA8FF;--hf-inval:#FF9A3D;--hf-sl:#FF3B42}
#home-hero-shell{display:grid;gap:var(--sp-5);grid-template-columns:minmax(0,1fr);align-items:start;padding:var(--sp-6) 0 var(--sp-5)}
@media (min-width:880px){#home-hero-shell{grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:var(--sp-7)}}
#home-hero-copy{display:grid;gap:var(--sp-4);padding-top:var(--sp-2);min-width:0}
#home-hero-title{margin:0;font:500 clamp(30px,5vw,46px)/1.05 var(--grotesk);letter-spacing:-.02em;color:var(--text-display)}
#home-hero-lede{margin:0;max-width:46ch;font-size:15px;color:var(--text-secondary)}
#home-hero-ctas{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.hf-btn{display:inline-flex;align-items:center;min-height:44px;padding:0 var(--sp-4);border:1px solid var(--text-display);border-radius:999px;background:var(--text-display);color:var(--black);font:700 var(--fs-sm)/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;text-decoration:none}
.hf-btn.ghost{background:transparent;color:var(--text-display);border-color:var(--border-visible)}
.hf-btn:focus-visible,.hf-seg button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#called-flags-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--tile-pad);display:grid;gap:var(--sp-4);min-width:0}
@media (min-width:760px){#called-flags-card{padding:28px}}
#called-flags-header{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-3);flex-wrap:wrap}
#called-flags-empty{margin:0;font:400 var(--fs-body)/1.5 var(--mono);color:var(--text-secondary)}
.hf-seg{display:inline-flex;border:1px solid var(--border-visible);border-radius:999px;padding:2px}
.hf-seg button{font:400 11px/1 var(--mono);letter-spacing:.06em;border:0;background:transparent;color:var(--text-secondary);padding:9px 12px;border-radius:999px;cursor:pointer}
.hf-seg button[aria-pressed="true"]{background:var(--text-display);color:var(--black)}
#called-flags-rate-row{display:flex;align-items:flex-end;gap:var(--sp-4);flex-wrap:wrap}
#called-flags-rate{font:700 clamp(72px,16vw,112px)/.85 var(--doto);color:var(--text-display);letter-spacing:-.02em}
#called-flags-rate small{font-size:.45em}
#called-flags-rate-caption{display:grid;gap:2px;padding-bottom:6px}
#called-flags-rate-caption strong{font:500 16px/1.2 var(--grotesk);color:var(--text-display)}
#called-flags-rate-caption span{color:var(--text-secondary);font-size:13px}
#called-flags-split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.hf-side{border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;display:grid;gap:var(--sp-2);min-width:0}
.hf-side-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-2)}
.hf-dir{font:700 13px/1 var(--mono);letter-spacing:.08em}
.hf-side.up .hf-dir{color:var(--success)}.hf-side.down .hf-dir{color:var(--accent)}
.hf-pct{font:700 28px/1 var(--doto);color:var(--text-display)}
.hf-line{font:400 12px/1.4 var(--mono);color:var(--text-secondary)}
.hf-bar{height:6px;border-radius:3px;background:var(--seg-empty);overflow:hidden;display:flex}
.hf-bar i{display:block;height:100%}
.hf-side.up .hf-bar i{background:var(--success)}.hf-side.down .hf-bar i{background:var(--accent)}
#called-flags-tally{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
#called-flags-tally div{padding:10px 4px;display:grid;gap:2px;text-align:center}
#called-flags-tally div+div{border-left:1px solid var(--border)}
#called-flags-tally b{font:700 22px/1 var(--doto);color:var(--text-display)}
#called-flags-tally .flat b{color:var(--warning)}
#called-flags-recent{display:grid;gap:var(--sp-2)}
#recent-strip{display:flex;flex-wrap:wrap;gap:4px}
.hf-dot{width:22px;height:22px;border-radius:5px;display:grid;place-items:center;font:700 11px/1 var(--mono);color:#fff}
.hf-dot.right{background:var(--success)}.hf-dot.wrong{background:var(--accent)}.hf-dot.flat{background:var(--warning)}
.hf-dot.open,.hf-dot.nodata{background:transparent;color:var(--text-secondary);border:1px dashed var(--border-visible)}
#recent-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font:400 11px/1.4 var(--mono);color:var(--text-secondary)}
#recent-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
#called-flags-rule{font-size:12px;color:var(--text-secondary);border-left:2px solid var(--border-visible);padding-left:10px;margin:0;max-width:62ch}
#called-flags-target{display:grid;gap:6px}
#called-flags-target-text{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;font:400 13px/1.3 var(--mono);color:var(--text-secondary)}
#called-flags-target-text b{font:700 18px/1 var(--mono);color:var(--text-display)}
#called-flags-target[data-state="meets"] #target-rate,#called-flags-target[data-state="meets"] #target-pill{color:var(--success)}
#called-flags-target[data-state="below"] #target-rate,#called-flags-target[data-state="below"] #target-pill{color:var(--warning)}
.hf-meter{position:relative;height:8px;border-radius:4px;background:var(--seg-empty)}
.hf-meter i{display:block;height:100%;border-radius:4px;background:var(--text-secondary)}
#called-flags-target[data-state="meets"] .hf-meter i{background:var(--success)}
#called-flags-target[data-state="below"] .hf-meter i{background:var(--warning)}
.hf-meter u{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--text-display);text-decoration:none}
.hf-pill{font:700 10px/1 var(--mono);letter-spacing:.06em;padding:4px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;text-transform:uppercase;color:var(--text-disabled)}
.hf-pill.meets{color:var(--success)}.hf-pill.below{color:var(--warning)}
#called-flags-legacy{margin:0;font:400 11px/1.4 var(--mono);color:var(--text-disabled)}
#how-it-works-section,#tuning-section{display:grid;gap:var(--sp-3);padding:var(--sp-5) 0}
#how-it-works-steps{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:760px){#how-it-works-steps{grid-template-columns:repeat(3,minmax(0,1fr))}}
.hf-step{display:flex;gap:var(--sp-3);align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;min-width:0}
.hf-step-n{font:700 24px/1 var(--doto);color:var(--text-display);min-width:1.2ch}
.hf-step strong{font:500 14px/1.3 var(--grotesk);color:var(--text-display)}
.hf-step p{margin:4px 0 0;font-size:12px;color:var(--text-secondary)}
#tuning-note{margin:0;font-size:13px;color:var(--text-secondary);max-width:62ch}
#tuning-empty{margin:0;font:400 var(--fs-body)/1.5 var(--mono);color:var(--text-secondary)}
#tuning-rules-row,#tuning-buckets{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:760px){#tuning-rules-row{grid-template-columns:1fr 1fr}#tuning-buckets{grid-template-columns:repeat(2,minmax(0,1fr))}}
.hf-rule-card,.hf-bucket-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;display:grid;gap:8px;min-width:0;align-content:start}
.hf-rule-card p{margin:0;font:400 12px/1.5 var(--mono);color:var(--text-primary)}
.hf-reason{color:var(--text-secondary)!important}
.hf-bucket-card table{width:100%;border-collapse:collapse;font:400 12px/1.4 var(--mono)}
.hf-bucket-card th,.hf-bucket-card td{text-align:left;padding:6px 4px;border-top:1px solid var(--border);font-weight:400}
.hf-bucket-card thead th{border-top:0;color:var(--text-secondary);font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.hf-bucket-card tbody th{color:var(--text-display);font-weight:700}
.hf-bucket.thin{opacity:.55}
#live-board-section,#process-section{display:grid;gap:var(--sp-3);padding:var(--sp-5) 0}
.hf-sec-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-3);flex-wrap:wrap}
.hf-sec-head h2{font:500 var(--fs-zone)/1.2 var(--grotesk);margin:0;color:var(--text-display)}
#live-board-grid{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:760px){#live-board-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
#live-board-empty{margin:0;font:400 var(--fs-body)/1.5 var(--mono);color:var(--text-secondary)}
.hf-flag-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;display:grid;gap:10px;min-width:0}
.hf-flag-top{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2)}
.hf-sym{font:700 15px/1 var(--mono);color:var(--text-display)}
.hf-chip{font:700 10px/1 var(--mono);letter-spacing:.08em;padding:5px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.hf-chip.lock{color:var(--success)}.hf-chip.found{color:var(--warning)}.hf-chip.watch,.hf-chip.missed{color:var(--text-disabled)}
.hf-levels{display:grid;gap:3px}
.hf-lv{display:flex;align-items:baseline;gap:var(--sp-3);font:400 12px/1.5 var(--mono)}
.hf-lv-val{min-width:7ch;font-weight:700;color:var(--text-display)}
.hf-lv-label{color:var(--text-secondary)}
.hf-v-entry{color:var(--hf-entry)}.hf-v-valid{color:var(--hf-valid)}.hf-v-inval{color:var(--hf-inval)}.hf-v-sl{color:var(--hf-sl)}
.hf-checklist{font:400 11px/1.4 var(--mono);color:var(--text-secondary)}
.hf-action{font:400 11px/1.4 var(--mono);color:var(--text-primary);border-top:1px dashed var(--border);padding-top:var(--sp-2)}
#process-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (min-width:760px){#process-stats{grid-template-columns:repeat(6,minmax(0,1fr))}}
.hf-stat{border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;display:grid;gap:4px;min-width:0}
.hf-stat b{font:700 26px/1 var(--doto);color:var(--text-display)}
#existing-pages{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:760px){#existing-pages{grid-template-columns:repeat(3,minmax(0,1fr))}}
.hf-page-link{border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;text-decoration:none;display:grid;gap:4px;background:var(--surface)}
.hf-page-link:hover{border-color:var(--border-visible)}
.hf-page-link strong{font:500 14px/1.3 var(--grotesk);color:var(--text-display)}
.hf-page-link span{font-size:12px;color:var(--text-secondary)}
@media (prefers-reduced-motion:no-preference){.hf-bar i{transition:width .5s ease}}
`;
