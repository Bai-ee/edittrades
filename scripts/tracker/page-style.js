/**
 * Shared stylesheet for the tracker site pages (index.html, how-to.html).
 *
 * Nothing design system, monochrome: color only carries status (good / warn / bad).
 * Light and dark via prefers-color-scheme. Layout is a bento grid (./bento.js):
 * 2 columns on phones and tablets, 12 from 1024px. One 4px-based spacing scale drives the rhythm:
 * tight inside a tile (--sp-2..--sp-4), medium between tiles (--sp-3 / --sp-4),
 * generous between zones (--sp-7 / --sp-8).
 */

export const PAGE_CSS = `:root{
  --black:#F5F5F5;--surface:#FFFFFF;--border:#E4E4E4;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;
  --text-disabled:#999999;--text-secondary:#5E5E5E;--text-primary:#1A1A1A;--text-display:#000000;
  --success:#3F8A50;--warning:#B8892A;--accent:#D71921;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;--sp-7:48px;--sp-8:64px;
  --radius:12px;--radius-sm:8px;--tile-pad:var(--sp-4);--grid-gap:var(--sp-3);--zone-gap:var(--sp-7);
  --fs-sm:12px;--fs-body:14px;--fs-title:16px;--fs-zone:20px;--fs-md:24px;--fs-hero:clamp(64px,20vw,96px);
  --z-sticky:10;
  --grotesk:"Space Grotesk","DM Sans",system-ui,sans-serif;--mono:"Space Mono","SF Mono",ui-monospace,monospace;--doto:"Doto","Space Mono",monospace;
  color-scheme:light}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--black:#F5F5F5;--surface:#FFFFFF;--border:#E4E4E4;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;--text-disabled:#999999;--text-secondary:#5E5E5E;--text-primary:#1A1A1A;--text-display:#000000;color-scheme:light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--black:#000000;--surface:#0E0E0E;--border:#222222;--border-visible:#3A3A3A;--seg-empty:#262626;--text-disabled:#6E6E6E;--text-secondary:#A3A3A3;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}}
:root[data-theme="dark"]{--black:#000000;--surface:#0E0E0E;--border:#222222;--border-visible:#3A3A3A;--seg-empty:#262626;--text-disabled:#6E6E6E;--text-secondary:#A3A3A3;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}
@media (min-width:760px){:root{--tile-pad:var(--sp-5);--grid-gap:var(--sp-4);--zone-gap:var(--sp-8)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:auto}
body{margin:0;background:var(--black);color:var(--text-primary);font:400 var(--fs-body)/1.5 var(--grotesk)}
main{max-width:1120px;margin:0 auto;padding:0 var(--sp-4)}
h1,h2,h3,h4{text-wrap:balance}
p{text-wrap:pretty}
dl,dd{margin:0}

/* mono label voice */
.label,.prov-tag,.edge-strip,th,.stat-row dt,.inst-sub,.mono-note,.empty,.empty-inline,.progress-val,.status-word,.track-val,.hero-n,.sub-title,.jump-nav a,.zone-sub{font-family:var(--mono);font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em}
.label,.stat-row dt,th,.inst-sub,.zone-sub{color:var(--text-secondary)}

/* edges */
.edge-strip{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--sp-1) var(--sp-4);padding:var(--sp-4) 0;color:var(--text-secondary)}
.edge-strip + .jump-nav{margin-top:0}
footer.edge-strip{border-top:1px solid var(--border);margin-top:var(--zone-gap);padding-bottom:var(--sp-6)}

/* jump nav: sticky, wraps onto more rows on phones; anchor jumps are instant */
.jump-nav{position:sticky;top:0;z-index:var(--z-sticky);display:flex;flex-wrap:wrap;gap:var(--sp-2);margin:0 calc(-1 * var(--sp-4));padding:var(--sp-3) var(--sp-4);background:var(--black);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.jump-nav a{flex:0 0 auto;display:inline-flex;align-items:center;min-height:36px;padding:0 var(--sp-3);border:1px solid var(--border-visible);border-radius:999px;color:var(--text-primary);text-decoration:none;white-space:nowrap;transition:background-color .2s cubic-bezier(.25,1,.5,1),color .2s cubic-bezier(.25,1,.5,1)}
.jump-nav a:hover{border-color:var(--text-display)}
.jump-nav a.is-page{background:var(--text-display);border-color:var(--text-display);color:var(--black)}
.jump-nav a:focus-visible,.nav-link:focus-visible,summary:focus-visible{outline:1px solid var(--text-display);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.jump-nav a{transition:none}}
.nav-link{color:var(--text-display);text-decoration:none;border-bottom:1px solid var(--border-visible)}
.nav-link:hover{border-bottom-color:var(--text-display)}

/* zones and bento */
.zone{margin-top:var(--zone-gap);scroll-margin-top:72px}
.zone:first-of-type{margin-top:var(--sp-5)}
.zone-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:var(--sp-1) var(--sp-4);margin-bottom:var(--sp-4)}
.zone-title{margin:0;font:500 var(--fs-zone)/1.2 var(--grotesk);letter-spacing:-.01em;color:var(--text-display)}
.bento{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--grid-gap);align-items:stretch}
@media (min-width:1024px){.bento{grid-template-columns:repeat(12,minmax(0,1fr))}}
.tile{grid-column:span var(--sm,2);min-width:0;display:flex;flex-direction:column;gap:var(--sp-4);padding:var(--tile-pad);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);scroll-margin-top:72px}
@media (min-width:1024px){.tile{grid-column:span var(--lg,12)}}
.tile-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-3)}
.tile-title{margin:0;font:500 var(--fs-title)/1.25 var(--grotesk);color:var(--text-display)}
.tile-body{display:flex;flex-direction:column;gap:var(--sp-4);min-width:0;flex:1 1 auto}
.tile .tile-body>*{margin:0}
.tile-foot{margin:0;padding-top:var(--sp-3);border-top:1px solid var(--border);color:var(--text-secondary);font-size:var(--fs-sm);line-height:1.5}
.prov-tag{flex:0 0 auto;color:var(--text-secondary);border:1px solid var(--border-visible);border-radius:999px;padding:1px var(--sp-2);font-size:10px;letter-spacing:.1em}

/* collapsible sub-blocks inside a tile */
.sub{border-top:1px solid var(--border)}
.sub:last-of-type{border-bottom:1px solid var(--border)}
.sub summary{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-4);min-height:44px;cursor:pointer;list-style:none;color:var(--text-primary)}
.sub summary::-webkit-details-marker{display:none}
.sub summary::after{content:"+";font-family:var(--mono);color:var(--text-secondary)}
.sub[open] summary::after{content:"\\2212"}
.sub[open]>:not(summary){margin-bottom:var(--sp-4)}

/* system status */
.status-hero{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2) var(--sp-3)}
.status-dot{position:relative;width:12px;height:12px;border-radius:50%;background:currentColor;flex:0 0 auto}
.status-dot.is-live::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid currentColor;animation:status-ring 2s cubic-bezier(.25,1,.5,1) infinite}
@keyframes status-ring{from{transform:scale(1);opacity:1}to{transform:scale(2.6);opacity:0}}
@media (prefers-reduced-motion: reduce){.status-dot.is-live::after{animation:none}}
.status-big{font:400 var(--fs-md)/1 var(--mono);letter-spacing:.08em}
.status-desc{flex:1 1 100%;color:var(--text-secondary)}
@media (min-width:760px){.status-desc{flex:1 1 20em;text-align:right}}
.status-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--sp-3);padding:var(--sp-4) 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.status-fact{display:flex;flex-direction:column;gap:var(--sp-1);min-width:0}
.status-fact dt{font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.status-fact dd{font:400 var(--fs-title)/1.2 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums}
.status-fact dd.fact-sub{font-size:var(--fs-sm);color:var(--text-secondary);letter-spacing:.04em;overflow-wrap:anywhere}
@media (min-width:760px){.status-fact dd{font-size:var(--fs-md)}}
@media (max-width:479px){
  .status-facts{grid-template-columns:1fr;gap:0;padding:var(--sp-2) 0}
  .status-fact{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:0 var(--sp-3);padding:var(--sp-2) 0}
  .status-fact+.status-fact{border-top:1px solid var(--border)}
  .status-fact dd{text-align:right}
  .status-fact dd.fact-sub{grid-column:1 / -1}
  .heartbeat-axis{flex-wrap:wrap;gap:var(--sp-1) var(--sp-3)}
}
.heartbeat{display:grid;gap:2px}
.heartbeat i{display:block;height:24px;background:transparent;border:1px dashed var(--border)}
.heartbeat i.on{background:var(--text-display);border-color:var(--text-display)}
.heartbeat i.miss{background:var(--seg-empty);border:1px solid var(--seg-empty)}
.heartbeat-axis,.timeline-axis{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-3);margin-top:var(--sp-2);font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.heartbeat-key{display:inline-flex;align-items:center;gap:var(--sp-1) var(--sp-2)}
.heartbeat-key i{display:inline-block;width:8px;height:8px;background:var(--text-display)}
.heartbeat-key i.miss{background:var(--seg-empty);margin-left:var(--sp-2)}
.phase-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-3)}
.phase-day{font:400 var(--fs-md)/1 var(--mono);color:var(--text-display)}
.phase-of{font-size:var(--fs-sm);color:var(--text-secondary);letter-spacing:.08em;text-transform:uppercase}
.seg-days i{height:24px}
.seg-days i.now{animation:day-now 2.4s ease-in-out infinite}
@keyframes day-now{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.seg-days i.now{animation:none;outline:1px solid var(--text-display);outline-offset:2px}}

/* hero */
.hero-value{font-family:var(--doto);font-weight:700;font-size:var(--fs-hero);line-height:1;letter-spacing:-.03em;color:var(--text-display);font-variant-numeric:tabular-nums}
.hero-unit{font-family:var(--mono);font-weight:400;font-size:var(--fs-md);letter-spacing:0;vertical-align:top;margin-left:var(--sp-2);color:var(--text-secondary)}
.hero-empty{color:var(--text-disabled)}
.hero-n{color:var(--text-primary)}
.hero-stack{display:flex;flex-direction:column;gap:var(--sp-2)}
.edge-note{max-width:40em;color:var(--text-secondary)}
#performance-hero-section #hero-edge-note{margin-top:auto}

/* instrument tiles */
.instrument{display:flex;flex-direction:column;gap:var(--sp-2);min-width:0}
.inst-value{font:400 var(--fs-md)/1.1 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums}
.inst-value .empty-inline{display:block;font-size:var(--fs-sm);line-height:1.5}
.tile.tile-instrument{justify-content:space-between}

/* bars */
.seg{display:grid;gap:2px}
.seg i{display:block;background:var(--seg-empty)}
.seg i.on{background:var(--text-display)}
.seg-std i{height:8px}
.seg-hero i{height:12px}
.ibar{height:4px;background:var(--seg-empty)}
.ibar i{display:block;height:100%;background:var(--text-display)}
.progress-head{display:flex;justify-content:space-between;gap:var(--sp-4);margin-bottom:var(--sp-2)}
.progress-val{color:var(--text-display)}

/* status */
.st-good{color:var(--success)!important}
.st-warn{color:var(--warning)!important}
.st-bad{color:var(--accent)!important}
.dim{color:var(--text-disabled)!important}

/* text */
.note{color:var(--text-secondary);font-size:var(--fs-sm);line-height:1.5}
.mono-note{color:var(--text-secondary)}
.empty,.empty-inline{color:var(--text-secondary)}
.status-word{color:var(--text-display)}

/* key/value rows */
.stat-row{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-4);padding:var(--sp-2) 0;border-bottom:1px solid var(--border)}
.stat-row:last-child{border-bottom:0}
.stat-row dd{font-family:var(--mono);font-size:var(--fs-sm);text-align:right;color:var(--text-primary);letter-spacing:.04em}
.track-row{display:grid;grid-template-columns:1fr auto;gap:var(--sp-1) var(--sp-4);padding:var(--sp-3) 0;border-bottom:1px solid var(--border)}
.track-row:last-child{border-bottom:0}
.track-row dt{grid-column:1;font-weight:500;color:var(--text-display)}
.track-val{grid-column:2;grid-row:1;text-align:right;color:var(--text-primary);white-space:nowrap}
.track-why{grid-column:1 / -1;color:var(--text-secondary);font-size:var(--fs-sm)}

/* tables: scroll inside the tile, bleeding to its edges */
.table-scroll,.tile .tile-body .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-inline:calc(-1 * var(--tile-pad));padding-inline:var(--tile-pad)}
table{border-collapse:collapse;width:100%;font:400 var(--fs-sm)/1.4 var(--mono);font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:var(--sp-2) var(--sp-4) var(--sp-2) 0;white-space:nowrap}
th{font-weight:400;border-bottom:1px solid var(--border-visible)}
td{border-bottom:1px solid var(--border);color:var(--text-primary)}
tbody tr:last-child td{border-bottom:0}
th.num,td.num{text-align:right;padding:var(--sp-2) 0 var(--sp-2) var(--sp-4)}

/* how-to */
.howto-lede{max-width:40em;font-size:var(--fs-body);line-height:1.6;color:var(--text-primary)}
#howto-intro-title{margin:0;font:500 clamp(32px,8vw,56px)/1.05 var(--grotesk);letter-spacing:-.02em;color:var(--text-display)}
.step-num{font-family:var(--doto);font-weight:700;font-size:48px;line-height:1;color:var(--text-display)}
.step-text{color:var(--text-primary)}
.cmd-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:var(--sp-2) var(--sp-3)}
.cmd-name{font:400 var(--fs-md)/1.1 var(--mono);color:var(--text-display);letter-spacing:-.01em}
.cmd-desc{color:var(--text-primary)}
.def-list{display:flex;flex-direction:column}
.def-row{display:flex;flex-direction:column;gap:var(--sp-1);padding:var(--sp-3) 0;border-bottom:1px solid var(--border)}
.def-row:first-child{padding-top:0}
.def-row:last-child{border-bottom:0;padding-bottom:0}
.def-row dt{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-3);font-weight:500;color:var(--text-display)}
.def-row dt .label{font-weight:400;text-align:right}
.def-row dd{color:var(--text-secondary)}
.howto-prompt{margin:0;padding:var(--sp-3) var(--sp-4);background:var(--black);border:1px solid var(--border);border-radius:var(--radius-sm);font:400 var(--fs-sm)/1.5 var(--mono);color:var(--text-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.prompt-stack{display:flex;flex-direction:column;gap:var(--sp-2)}
.howto-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.howto-list li{padding:var(--sp-3) 0;border-bottom:1px solid var(--border)}
.howto-list li:first-child{padding-top:0}
.howto-list li:last-child{border-bottom:0;padding-bottom:0}
.howto-list + .howto-list,.def-list + .howto-list{padding-top:var(--sp-3);border-top:1px solid var(--border)}
.cmd-inline{font:400 var(--fs-sm)/1.4 var(--mono);letter-spacing:.04em;color:var(--text-display)}
.menu-keys{display:flex;flex-direction:column;gap:var(--sp-2)}
.menu-row{display:flex;gap:var(--sp-2)}
.menu-key{flex:1 1 0;min-width:0;min-height:44px;display:flex;align-items:center;justify-content:center;padding:0 var(--sp-2);background:var(--black);border:1px solid var(--border-visible);border-radius:var(--radius-sm);font:400 var(--fs-sm)/1.2 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-primary);text-align:center}
.rules-table td{white-space:normal;vertical-align:top}
.rules-table td.rule-name{white-space:nowrap;color:var(--text-display)}
.rules-table td.rule-value{min-width:16em;font-family:var(--grotesk);font-size:var(--fs-body);letter-spacing:0}
.rules-table td.rule-src{min-width:12em;color:var(--text-secondary)}
.status-channel-note{margin:0}
`;
