/**
 * Homepage hero for the tracker site (index.html): the showcase row above the jump nav.
 *
 *   left  (#home-hero-headline-panel) - stacked EditTrax headline (cycles per refresh), one plain line, two links
 *   right (#home-hero-result-card)    - net R per scored GOOD call, oversized and signed,
 *                                       with the data volume behind it in small type
 *
 * The figure is net of fees and slippage (costs.js) over every scored ready plan since
 * tracking began, never gross: PRODUCT.md "net over gross". Styles: HOME_HERO_CSS below,
 * appended to PAGE_CSS by build-page.js.
 */

import { esc } from './bento.js';

/**
 * Headlines, one per page load: the first is server-rendered (no-JS default), homeHeroScript()
 * swaps in the next one on each refresh (index kept in localStorage,
 * random when storage is unavailable) and shrinks the type if a line would overflow.
 * Each entry is the stacked lines, ~10 characters per line at most.
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
const titleSpans = (lines) => lines.map((l) => `<span>${esc(l)}</span>`).join('');

/** Headline list for the page, as inert JSON (the page keeps one executable script). */
function titleData() {
  return `<script type="application/json" id="home-hero-title-data">${JSON.stringify(HOME_HERO_TITLES).replace(/</g, '\\u003c')}</script>`;
}

/** Appended to the page's single inline script by build-page.js. */
export function homeHeroScript() {
  return `(function(){var d=document.getElementById('home-hero-title-data'),h=document.getElementById('home-hero-title');if(!d||!h)return;var T;try{T=JSON.parse(d.textContent);}catch(e){return;}var i;`
    + `try{i=(parseInt(localStorage.getItem('et-hero-title'),10)+1)%T.length;if(isNaN(i))i=0;localStorage.setItem('et-hero-title',String(i));}catch(e){i=Math.floor(Math.random()*T.length);}`
    + `if(i>0){h.textContent='';T[i].forEach(function(l){var s=document.createElement('span');s.textContent=l;h.appendChild(s);});}`
    + `function fit(){h.style.fontSize='';var n=0;while(h.scrollWidth>h.clientWidth+1&&n++<30){h.style.fontSize=(parseFloat(getComputedStyle(h).fontSize)*0.96)+'px';}}`
    + `fit();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);addEventListener('resize',fit);})();`;
}

export const HOME_HERO_LEDE = 'Every call the engine makes is captured, scored against later closed candles and shown net of fees. The data is here. The trade is yours.';
export const HOME_HERO_NOTE = 'Not evidence of an edge. Scored = a ready GOOD plan that reached TP1 or stop.';

const MINUS = '−';
const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const signed = (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}`;
const count = (v) => (isNum(v) ? v.toLocaleString('en-US') : dash);
const heroStatus = (v) => (v >= 0 ? 'st-good' : v >= -0.5 ? 'st-warn' : 'st-bad');

function stat(id, label, value) {
  return `<div class="home-hero-stat" id="${id}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

/** @param {Object} agg - computeAggregates() output */
export function homeHero(agg) {
  const tr = agg.totals.tradable;
  const scored = tr.wins + tr.losses;
  const net = scored > 0 && isNum(tr.netExpectancy) ? tr.netExpectancy : null;
  const gross = scored > 0 && isNum(tr.expectancy) ? tr.expectancy : null;
  const goodCalls = agg.byDay.reduce((n, d) => n + d.good, 0);
  const candles = Object.values(agg.captures.candles1m).reduce((n, v) => n + v, 0);
  const since = agg.byDay.length ? agg.byDay[agg.byDay.length - 1].day : null;

  const figure = net === null
    ? `<div class="home-hero-figure hero-empty" id="home-hero-net-r">0.00<span class="home-hero-unit">R</span></div>`
      + `<p class="home-hero-figure-sub" id="home-hero-gross-line">[NO SCORED CALLS YET]</p>`
    : `<div class="home-hero-figure ${heroStatus(net)}" id="home-hero-net-r">${esc(signed(net))}<span class="home-hero-unit">R</span></div>`
      + `<p class="home-hero-figure-sub" id="home-hero-gross-line">${esc(`${signed(gross)}R gross · fees and slippage ${signed(net - gross)}R`)}</p>`;

  const headline = `<div class="home-hero-headline-panel" id="home-hero-headline-panel" data-section="home-hero-headline-panel">`
    + `<h1 class="home-hero-title" id="home-hero-title">${titleSpans(HOME_HERO_TITLES[0])}</h1>${titleData()}`
    + `<div class="home-hero-copy" id="home-hero-copy"><p class="home-hero-lede" id="home-hero-lede">${esc(HOME_HERO_LEDE)}</p>`
    + `<div class="home-hero-actions" id="home-hero-actions"><a class="home-hero-action is-primary" id="home-hero-calls-link" href="#zone-calls">See every call</a>`
    + `<a class="home-hero-action" id="home-hero-howto-link" href="how-to.html">How to use it</a>`
    + `<a class="home-hero-action" id="home-hero-product-link" href="product.html">What EditTrades is</a></div></div></div>`;

  const card = `<article class="home-hero-card" id="home-hero-result-card" data-section="home-hero-result-card">`
    + `<header class="home-hero-card-head" id="home-hero-card-head"><span class="label">Net R · per scored GOOD call</span><span class="home-hero-tag" id="home-hero-net-tag">Net of fees</span></header>`
    + `<div class="home-hero-figure-block" id="home-hero-figure-block">${figure}</div>`
    + `<dl class="home-hero-stats" id="home-hero-stats">`
    + stat('home-hero-stat-signals', 'Signals logged', count(agg.totals.recCalls))
    + stat('home-hero-stat-good', 'GOOD calls', count(goodCalls))
    + stat('home-hero-stat-scored', 'Scored', count(scored))
    + stat('home-hero-stat-win-rate', 'Win rate', scored > 0 && isNum(tr.winRate) ? `${Math.round(tr.winRate * 1000) / 10}%` : dash)
    + stat('home-hero-stat-candles', '1m candles', count(candles))
    + stat('home-hero-stat-since', 'Tracking since', since || dash)
    + `</dl><p class="home-hero-note" id="home-hero-note">${esc(HOME_HERO_NOTE)}</p></article>`;

  return `<div class="home-hero" id="home-hero-shell" data-section="home-hero-shell" role="region" aria-labelledby="home-hero-title">${headline}${card}</div>`;
}

export const HOME_HERO_CSS = `
/* home hero: EditTrax headline + net-R card. Type sizes track each column (cqi):
   the widest headline line is ~5.5em, a six-glyph figure (+10.25R) ~3.6em. */
@font-face{font-family:"Mathias";src:url("fonts/mathias-bold.ttf") format("truetype");font-weight:700;font-style:normal;font-display:swap}
.home-hero{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--sp-6);padding:var(--sp-6) 0 var(--sp-7)}
@media (min-width:1024px){.home-hero{grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:var(--sp-7);padding:var(--sp-8) 0}}
.home-hero-headline-panel{container-type:inline-size;display:flex;flex-direction:column;justify-content:center;gap:var(--sp-5);min-width:0}
.home-hero-title{margin:0;font:700 clamp(40px,17.5cqi,96px)/.9 "Mathias","Space Grotesk",system-ui,sans-serif;text-transform:uppercase;letter-spacing:0;color:var(--text-display)}
.home-hero-title span{display:block}
.home-hero-copy{display:flex;flex-direction:column;gap:var(--sp-5)}
.home-hero-lede{margin:0;max-width:36em;font-size:var(--fs-title);line-height:1.55;color:var(--text-primary)}
.home-hero-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.home-hero-action{display:inline-flex;align-items:center;min-height:44px;padding:0 var(--sp-4);border:1px solid var(--border-visible);border-radius:999px;font:400 var(--fs-sm)/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-display);text-decoration:none;transition:border-color .2s cubic-bezier(.25,1,.5,1),background-color .2s cubic-bezier(.25,1,.5,1),color .2s cubic-bezier(.25,1,.5,1)}
.home-hero-action:hover{border-color:var(--text-display)}
.home-hero-action.is-primary{background:var(--text-display);border-color:var(--text-display);color:var(--black)}
.home-hero-action.is-primary:hover{background:var(--text-primary);border-color:var(--text-primary)}
.home-hero-action:focus-visible{outline:1px solid var(--text-display);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.home-hero-action{transition:none}}
.home-hero-card{container-type:inline-size;display:flex;flex-direction:column;gap:var(--sp-5);min-width:0;padding:var(--tile-pad);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.home-hero-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-3)}
.home-hero-tag{flex:0 0 auto;padding:1px var(--sp-2);border:1px solid var(--border-visible);border-radius:999px;font:400 10px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--text-secondary)}
.home-hero-figure-block{display:flex;flex-direction:column;gap:var(--sp-2)}
.home-hero-figure{font-family:var(--doto);font-weight:700;font-size:clamp(56px,26cqi,128px);line-height:.9;letter-spacing:-.03em;font-variant-numeric:tabular-nums;white-space:nowrap}
.home-hero-unit{font-family:var(--mono);font-weight:400;font-size:var(--fs-md);letter-spacing:0;vertical-align:top;margin-left:var(--sp-2);color:var(--text-secondary)}
.home-hero-figure-sub{margin:0;font:400 var(--fs-sm)/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.home-hero-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border)}
.home-hero-stat{display:flex;flex-direction:column;gap:var(--sp-1);padding:var(--sp-3) 0;border-bottom:1px solid var(--border);min-width:0}
.home-hero-stat:nth-child(odd){padding-right:var(--sp-3)}
.home-hero-stat:nth-child(even){padding-left:var(--sp-3);border-left:1px solid var(--border)}
.home-hero-stat dt{font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.home-hero-stat dd{font:400 var(--fs-md)/1.1 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.home-hero-note{margin:auto 0 0;font-size:var(--fs-sm);line-height:1.5;color:var(--text-secondary)}
`;
