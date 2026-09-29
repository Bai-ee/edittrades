/**
 * Homepage hero for the tracker site (index.html): the showcase row above the jump nav.
 *
 *   left   (#home-hero-headline-panel) - one-sentence headline + subhead built from the
 *                                        latest capture rows (T-23), two links
 *   middle (#home-hero-right-now)      - one "right now" card per symbol (T-23): price/mark,
 *                                        a 7-cell timeframe trend strip, the engine's own
 *                                        class + action + reason, and the active candidate
 *   right  (#home-hero-prediction-panel) - next-candle overall hit rate + 12-row current-call
 *                                        table (T-24c, predictions.js), capped at 40vh
 *
 * The live board (live-board.js) no longer sits in the hero's right column - it renders
 * directly below the hero, full width, its own markup untouched. Styles: HOME_HERO_CSS below
 * plus LIVE_BOARD_CSS and PREDICTIONS_CSS, all appended to PAGE_CSS by build-page.js.
 */

import { esc } from './bento.js';
import { liveBoard } from './live-board.js';
import { predictionsPanelHtml } from './predictions.js';

const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Historical rotating headline lines (pre-T-23). The h1 is now a data-driven sentence
 * (buildHeadline below), so these are no longer read to render it; kept exported because
 * other work may still reach for them. homeHeroScript() no longer finds the title-data
 * script it used to rotate (removed from homeHero's output), so it is now a harmless no-op -
 * still wired in by build-page.js's inline script, left as-is since this pass only touches
 * the hero call there.
 */
export const HOME_HERO_TITLES = [
  ['The signal', 'is coming', 'from inside', 'the noise.'],
  ['There is', 'a voice in', 'the static.'],
  ['The void', 'is not', 'silent.', 'It is', 'counting.'],
  ['Something', 'in the dark', 'keeps', 'answering.'],
  ['The noise', 'has a', 'heartbeat.'],
  ['It speaks', 'only to', 'those who', 'keep', 'listening.'],
  ['The static', 'is trying', 'to tell us', 'something.'],
  ['Out of', 'the void,', 'a pattern.'],
  ['The dark', 'between', 'the stars', 'is full of', 'signal.'],
  ['We tuned', 'into the', 'void. The', 'void tuned', 'back.'],
  ['Every', 'silence', 'has a', 'frequency.']
];

/** Appended to the page's single inline script by build-page.js; no-op now (see note above). */
export function homeHeroScript() {
  return `(function(){var d=document.getElementById('home-hero-title-data'),h=document.getElementById('home-hero-title');if(!d||!h)return;var T;try{T=JSON.parse(d.textContent);}catch(e){return;}var i;`
    + `try{i=(parseInt(localStorage.getItem('et-hero-title'),10)+1)%T.length;if(isNaN(i))i=0;localStorage.setItem('et-hero-title',String(i));}catch(e){i=Math.floor(Math.random()*T.length);}`
    + `if(i>0){h.textContent='';T[i].forEach(function(l){var s=document.createElement('span');s.textContent=l;h.appendChild(s);});}`
    + `function fit(){h.style.fontSize='';var n=0;while(h.scrollWidth>h.clientWidth+1&&n++<30){h.style.fontSize=(parseFloat(getComputedStyle(h).fontSize)*0.96)+'px';}}`
    + `fit();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);addEventListener('resize',fit);})();`;
}

/** Static half of the subhead; buildLede() appends the live "Data as of HH:MMZ." clause. */
export const HOME_HERO_LEDE = 'Closed-candle read of BTC, ETH and SOL every 10 minutes, scored net of fees.';

/** `tf:1m=S,...`, `scalp:`, `swing:`, `ct:`, `td:<sentiment>:n/of`, `a200:n/of`, `mark:bps`
 * out of a capture row's bias string. Pure; missing tokens or garbage input parse to nulls/empty,
 * never throw. Unrecognised tokens (no `key:value` shape) are skipped.
 * @param {string} bias
 */
export function parseBiasString(bias) {
  const out = { tf: {}, scalp: null, swing: null, ct: null, td: null, a200: null, mark: null };
  if (typeof bias !== 'string' || !bias) return out;
  for (const part of bias.split('|')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i);
    const val = part.slice(i + 1);
    if (key === 'tf') {
      for (const pair of val.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) out.tf[k] = v;
      }
    } else if (key === 'scalp') out.scalp = val || null;
    else if (key === 'swing') out.swing = val || null;
    else if (key === 'ct') {
      const n = Number(val);
      out.ct = Number.isFinite(n) ? n : null;
    } else if (key === 'td') {
      const m = /^([A-Za-z]+):(\d+)\/(\d+)$/.exec(val);
      out.td = m ? { sentiment: m[1], n: Number(m[2]), of: Number(m[3]) } : null;
    } else if (key === 'a200') {
      const m = /^(\d+)\/(\d+)$/.exec(val);
      out.a200 = m ? { n: Number(m[1]), of: Number(m[2]) } : null;
    } else if (key === 'mark') {
      const n = Number(val);
      out.mark = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

const joinNames = (list) => {
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};
const trendWord = (side) => (side === 'L' ? 'up' : side === 'S' ? 'down' : null);

/**
 * One sentence built only from the latest capture rows: what is aligned (all present symbols
 * agreeing on both 1h and 4h, else how many lean the same way on 4h alone), then any candidate
 * actually `triggering` or `confirmed` on a WATCH (never a class the row doesn't show) - else
 * "no flag ready". Pure, unit-tested.
 * @param {Array<Object>} rows - latest capture row per symbol
 */
export function buildHeadline(rows) {
  const bySym = new Map((rows || []).map((r) => [r.symbol, r]));
  const have = SYMBOLS.filter((s) => bySym.has(s));
  if (!have.length) return 'Reading the market. No live capture yet.';

  const sides = have.map((s) => {
    const bias = parseBiasString(bySym.get(s).bias);
    return { symbol: s, h1: bias.tf['1h'] || null, h4: bias.tf['4h'] || null };
  });
  const letters = sides.map((s) => (s.h1 && s.h1 === s.h4 ? s.h1 : null));
  const uniform = letters.every((l) => l && l === letters[0]);

  let trendPart;
  if (uniform) {
    trendPart = `${joinNames(have)}: 1h and 4h trend ${trendWord(letters[0])}`;
  } else {
    const counts = { L: 0, S: 0 };
    for (const s of sides) if (s.h4 === 'L' || s.h4 === 'S') counts[s.h4] += 1;
    if (counts.L === 0 && counts.S === 0) {
      trendPart = `${joinNames(have)}: no clear 4h trend`;
    } else {
      const dom = counts.L >= counts.S ? 'L' : 'S';
      trendPart = `${counts[dom]} of ${have.length} coin${have.length === 1 ? '' : 's'} trending ${trendWord(dom)} on 4h`;
    }
  }

  let flagPart = null;
  for (const s of have) {
    const rec = bySym.get(s).flagRecommendation;
    const cand = rec && rec.class === 'WATCH' ? rec.candidate : null;
    if (cand && (cand.state === 'triggering' || cand.state === 'confirmed')) {
      const verb = cand.state === 'confirmed' ? 'breaking out' : 'triggering';
      flagPart = `${s} ${cand.timeframe} ${cand.direction} flag ${verb}`;
      break;
    }
  }
  return flagPart ? `${trendPart} · ${flagPart}.` : `${trendPart}, no flag ready.`;
}

const timeZ = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}Z`;
};

/** HOME_HERO_LEDE plus the newest `closedThrough` across rows, "Data as of HH:MMZ." */
export function buildLede(rows) {
  const closes = (rows || []).map((r) => Date.parse(r.closedThrough)).filter(Number.isFinite);
  const asOf = closes.length ? timeZ(new Date(Math.max(...closes)).toISOString()) : null;
  return asOf ? `${HOME_HERO_LEDE} Data as of ${asOf}.` : `${HOME_HERO_LEDE} No live capture yet.`;
}

const TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const ARROW = { L: '▲', S: '▼' };
const SIDE_CLASS = { L: 'hh-long', S: 'hh-short' };

const fmtPrice = (v) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 }) : dash);

function trendStrip(sym, tf) {
  const cells = TFS.map((k) => {
    const side = tf[k];
    return `<span class="home-hero-now-trend-cell ${SIDE_CLASS[side] || ''}"><b>${side ? (ARROW[side] || '·') : '·'}</b><i>${k}</i></span>`;
  }).join('');
  return `<div class="home-hero-now-trend" id="home-hero-now-${sym}-trend" role="img" aria-label="${esc(sym.toUpperCase())} timeframe trend">${cells}</div>`;
}

function contextLine(sym, bias) {
  const parts = [];
  if (bias.a200) parts.push(`EMA200 above on ${bias.a200.n}/${bias.a200.of}`);
  if (bias.td) parts.push(`top-down ${bias.td.sentiment} ${bias.td.n}/${bias.td.of}`);
  return parts.length ? `<p class="home-hero-now-context" id="home-hero-now-${sym}-context">${esc(parts.join(' · '))}</p>` : '';
}

/** `class` + `action.call` (e.g. "WATCH · WAIT") and `primaryReason.text` verbatim, truncated ~140 chars. */
function stanceLine(sym, rec) {
  const klass = (rec && rec.class) || 'NO DATA';
  const call = rec && rec.action && rec.action.call ? rec.action.call : null;
  const head = call ? `${klass} · ${call}` : klass;
  const reasonRaw = rec && rec.primaryReason && rec.primaryReason.text ? String(rec.primaryReason.text) : '';
  const reason = reasonRaw.length > 140 ? `${reasonRaw.slice(0, 140)}…` : reasonRaw;
  return `<p class="home-hero-now-stance" id="home-hero-now-${sym}-stance">${esc(head)}${reason ? ` — ${esc(reason)}` : ''}</p>`;
}

function candidateLine(sym, cand) {
  if (!cand) return '';
  const text = `${cand.timeframe || dash} ${cand.direction || ''} flag ${cand.state || ''} · break ${fmtPrice(cand.breakout)} · void ${fmtPrice(cand.invalidation)} · ${isNum(cand.measuredRR) ? `${cand.measuredRR.toFixed(1)}R` : dash}`;
  return `<p class="home-hero-now-candidate" id="home-hero-now-${sym}-candidate">${esc(text)}</p>`;
}

/** Grey `data: <status>` tag when the row isn't clean; never hides the card. */
function dataTag(sym, row) {
  const status = row.dataStatus && row.dataStatus !== 'complete'
    ? row.dataStatus
    : (row.mark && row.mark.status && row.mark.status !== 'ok' ? row.mark.status : null);
  return status ? `<span class="home-hero-now-data-tag" id="home-hero-now-${sym}-data-tag">data: ${esc(status)}</span>` : '';
}

function nowCard(symbol, row) {
  const sym = symbol.toLowerCase();
  if (!row) {
    return `<div class="home-hero-now-card" id="home-hero-now-${sym}" data-section="home-hero-now-${sym}">`
      + `<div class="home-hero-now-head" id="home-hero-now-${sym}-head"><span class="home-hero-now-symbol">${esc(symbol)}</span></div>`
      + `<p class="home-hero-now-empty" id="home-hero-now-${sym}-empty">No live capture yet.</p></div>`;
  }
  const bias = parseBiasString(row.bias);
  const mark = row.mark || {};
  const drift = isNum(mark.driftBps) ? `${mark.driftBps > 0 ? '+' : ''}${mark.driftBps} bps` : dash;
  const rec = row.flagRecommendation || {};

  return `<div class="home-hero-now-card" id="home-hero-now-${sym}" data-section="home-hero-now-${sym}">`
    + `<div class="home-hero-now-head" id="home-hero-now-${sym}-head">`
    + `<span class="home-hero-now-symbol">${esc(symbol)}</span>`
    + `<span class="home-hero-now-prices"><b>${esc(fmtPrice(mark.price))}</b> Pyth mark · ${esc(fmtPrice(row.price))} Kraken close · ${esc(drift)}</span>`
    + `</div>`
    + trendStrip(sym, bias.tf)
    + contextLine(sym, bias)
    + stanceLine(sym, rec)
    + candidateLine(sym, rec.candidate || null)
    + dataTag(sym, row)
    + `</div>`;
}

/**
 * "Right now" cards, one per symbol (T-23), read off the same latest capture rows as the
 * headline and the live board: price/mark/drift, a 7-cell timeframe trend strip, the a200/td
 * context line, the engine's own class + action + reason (verbatim, truncated), and the active
 * candidate if any. A missing symbol row or a non-"ok"/non-"complete" status never hides the card.
 * @param {Array<Object>} rows - latest capture row per symbol
 */
export function rightNowCards(rows) {
  const bySym = new Map((rows || []).map((r) => [r.symbol, r]));
  const cards = SYMBOLS.map((s) => nowCard(s, bySym.get(s))).join('');
  return `<div class="home-hero-right-now" id="home-hero-right-now" data-section="home-hero-right-now">${cards}</div>`;
}

/**
 * The right column is the next-candle prediction panel (predictions.js, T-24c) - overall hit
 * rate on top, the 12-row current-call table under it. The live board renders as its own
 * full-width block directly after the hero (still built here so its args stay in one place);
 * its ALL tab leads with the overall net PnL, the rest of performance is in the zones further
 * down.
 * @param {Array<Object>} liveRows - latest capture row per symbol
 * @param {string} [generatedAt] - page build time
 * @param {Object} [agg] - computeAggregates() output, for the panel and the board's PnL summary
 */
export function homeHero(liveRows, generatedAt, agg) {
  const rows = Array.isArray(liveRows) ? liveRows : [];
  const headline = `<div class="home-hero-headline-panel" id="home-hero-headline-panel" data-section="home-hero-headline-panel">`
    + `<h1 class="home-hero-title" id="home-hero-title">${esc(buildHeadline(rows))}</h1>`
    + `<div class="home-hero-copy" id="home-hero-copy"><p class="home-hero-lede" id="home-hero-lede">${esc(buildLede(rows))}</p>`
    + `<div class="home-hero-actions" id="home-hero-actions"><a class="home-hero-action is-primary" id="home-hero-calls-link" href="#zone-calls">See every call</a>`
    + `<a class="home-hero-action" id="home-hero-howto-link" href="how-to.html">How to use it</a>`
    + `<a class="home-hero-action" id="home-hero-product-link" href="product.html">What EditTrades is</a></div></div></div>`;
  // Owner 2026-09-29: no per-coin cards on the homepage. Right column = prediction panel on top,
  // live board (net PnL per scored GOOD call + per-coin tabs) under it. rightNowCards stays exported.
  const column = `<div class="home-hero-side-column" id="home-hero-side-column">${predictionsPanelHtml(agg)}${liveBoard(rows, generatedAt, agg)}</div>`;
  return `<div class="home-hero" id="home-hero-shell" data-section="home-hero-shell" role="region" aria-labelledby="home-hero-title">${headline}${column}</div>`;
}

export const HOME_HERO_CSS = `
/* home hero: EditTrax headline + net-R card. Type sizes track each column (cqi):
   the widest headline line is ~5.5em, a six-glyph figure (+10.25R) ~3.6em. */
@font-face{font-family:"Mathias";src:url("fonts/mathias-bold.ttf") format("truetype");font-weight:700;font-style:normal;font-display:swap}
.home-hero{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"headline" "board";gap:var(--sp-6);padding:var(--sp-6) 0 var(--sp-7)}
@media (min-width:1024px){.home-hero{grid-template-columns:minmax(0,7fr) minmax(0,5fr);grid-template-areas:"headline board";gap:var(--sp-7);padding:var(--sp-8) 0;align-items:start}}
.home-hero-side-column{grid-area:board;display:flex;flex-direction:column;gap:var(--sp-4);min-width:0}
.home-hero-headline-panel{grid-area:headline;container-type:inline-size;display:flex;flex-direction:column;justify-content:center;gap:var(--sp-5);min-width:0}
.home-hero-title{margin:0;font:700 clamp(26px,4.4cqi,42px)/1.25 "Mathias","Space Grotesk",system-ui,sans-serif;letter-spacing:0;color:var(--text-display)}
.home-hero-copy{display:flex;flex-direction:column;gap:var(--sp-5)}
.home-hero-lede{margin:0;max-width:36em;font-size:var(--fs-title);line-height:1.55;color:var(--text-primary)}
.home-hero-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.home-hero-action{display:inline-flex;align-items:center;min-height:44px;padding:0 var(--sp-4);border:1px solid var(--border-visible);border-radius:999px;font:400 var(--fs-sm)/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-display);text-decoration:none;transition:border-color .2s cubic-bezier(.25,1,.5,1),background-color .2s cubic-bezier(.25,1,.5,1),color .2s cubic-bezier(.25,1,.5,1)}
.home-hero-action:hover{border-color:var(--text-display)}
.home-hero-action.is-primary{background:var(--text-display);border-color:var(--text-display);color:var(--black)}
.home-hero-action.is-primary:hover{background:var(--text-primary);border-color:var(--text-primary)}
.home-hero-action:focus-visible{outline:1px solid var(--text-display);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.home-hero-action{transition:none}}
/* "Right now" cards (T-23): one per symbol, phone-first single column, three-up from 640px. */
.home-hero-right-now{grid-area:now;display:grid;grid-template-columns:minmax(0,1fr);gap:var(--sp-3);min-width:0}
@media (min-width:640px){.home-hero-right-now{grid-template-columns:repeat(3,minmax(0,1fr))}}
.home-hero-now-card{display:flex;flex-direction:column;gap:var(--sp-2);min-width:0;padding:var(--tile-pad);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.home-hero-now-head{display:flex;flex-direction:column;gap:2px}
.home-hero-now-symbol{font:700 var(--fs-md)/1 var(--doto);color:var(--text-display)}
.home-hero-now-prices{font:400 11px/1.4 var(--mono);color:var(--text-secondary);overflow-wrap:anywhere}
.home-hero-now-prices b{color:var(--text-display)}
.home-hero-now-trend{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.home-hero-now-trend-cell{display:flex;flex-direction:column;align-items:center;padding:2px 0;border:1px solid var(--border);border-radius:4px;font:400 12px/1.2 var(--mono);color:var(--text-secondary)}
.home-hero-now-trend-cell b{font-style:normal}
.home-hero-now-trend-cell i{font-style:normal;font-size:9px;color:var(--text-secondary);margin-top:1px}
.home-hero-now-trend-cell.hh-long{color:var(--success);border-color:var(--success)}
.home-hero-now-trend-cell.hh-short{color:var(--accent);border-color:var(--accent)}
.home-hero-now-context,.home-hero-now-stance,.home-hero-now-candidate,.home-hero-now-empty{margin:0;font:400 12px/1.4 var(--mono);color:var(--text-primary);overflow-wrap:anywhere}
.home-hero-now-stance{color:var(--text-secondary)}
.home-hero-now-empty{color:var(--text-secondary)}
.home-hero-now-data-tag{align-self:flex-start;padding:1px var(--sp-2);border:1px solid var(--border-visible);border-radius:999px;font:400 10px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--text-disabled)}
`;
