/**
 * Bento layout helpers shared by the tracker site pages (index.html, how-to.html).
 * Styles live in ./page-style.js.
 *
 *   zone     - a titled group of tiles; the jump nav links to zones
 *   tile     - one module answering one question; spans `sm` of 2 columns on phones
 *              and `lg` of 12 columns from 1024px
 *   sub      - a collapsible block inside a tile (dense tables stay one tap away)
 *   jumpNav  - sticky, horizontally scrollable zone links
 */

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {Object} o
 * @param {string} o.id - stable DOM id (also the data-section value)
 * @param {string} [o.title] - tile heading; omitted → no head row
 * @param {string|null} [o.tag] - small chip beside the title (e.g. PROVISIONAL); null → none
 * @param {number} [o.sm] - phone span out of 2
 * @param {number} [o.lg] - desktop span out of 12
 * @param {string} o.body - inner HTML
 * @param {string} [o.foot] - footnote text (escaped)
 * @param {string} [o.cls] - extra classes
 * @param {'section'|'div'} [o.as] - element; sections carry a PROVISIONAL tag on the tracker page
 * @param {Object<string, string>} [o.data] - extra data-* attributes (escaped), e.g. {lastCapture: iso}
 */
export function tile({ id, title = '', tag = null, sm = 2, lg = 12, body, foot = '', cls = '', as = 'section', data = {} }) {
  const head = title || tag
    ? `<header class="tile-head" id="${id}-head">${title ? `<h3 class="tile-title">${esc(title)}</h3>` : '<span></span>'}${tag ? `<span class="prov-tag">${esc(tag)}</span>` : ''}</header>`
    : '';
  const dataAttrs = Object.entries(data).map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${esc(v)}"`).join('');
  return `<${as} id="${id}" data-section="${id}"${dataAttrs} class="tile${cls ? ` ${cls}` : ''}" style="--sm:${sm};--lg:${lg}">`
    + head
    + `<div class="tile-body" id="${id}-body">${body}</div>`
    + (foot ? `<p class="tile-foot" id="${id}-foot">${esc(foot)}</p>` : '')
    + `</${as}>`;
}

export function zone({ id, title, sub = '', tiles }) {
  return `<div class="zone" id="${id}" data-section="${id}">`
    + `<div class="zone-head" id="${id}-head"><h2 class="zone-title">${esc(title)}</h2>${sub ? `<span class="zone-sub">${esc(sub)}</span>` : ''}</div>`
    + `<div class="bento" id="${id}-grid">${tiles.join('')}</div></div>`;
}

export function sub(id, title, content, open = false) {
  return `<details class="sub" id="${id}"${open ? ' open' : ''}><summary class="sub-title" id="${id}-summary">${esc(title)}</summary>${content}</details>`;
}

/** @param {Array<[string, string, string?]>} links - [href, label, extra attrs] */
export function jumpNav(id, links) {
  return `<nav class="jump-nav" id="${id}" aria-label="Sections">${links.map(([href, label, attrs = '']) => `<a href="${esc(href)}"${attrs ? ` ${attrs}` : ''}>${esc(label)}</a>`).join('')}</nav>`;
}
