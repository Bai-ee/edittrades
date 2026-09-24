/**
 * Shared stylesheet for the tracker site pages (index.html, how-to.html).
 * Nothing design system tokens; light and dark via prefers-color-scheme.
 */

export const PAGE_CSS = `:root{
  --black:#F5F5F5;--surface:#FFFFFF;--border:#E8E8E8;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;
  --text-disabled:#999999;--text-secondary:#666666;--text-primary:#1A1A1A;--text-display:#000000;
  --success:#4A9E5C;--warning:#D4A843;--accent:#D71921;
  --fs-sm:12px;--fs-md:24px;--fs-hero:clamp(88px,26vw,160px);
  --grotesk:"Space Grotesk","DM Sans",system-ui,sans-serif;--mono:"Space Mono","SF Mono",ui-monospace,monospace;--doto:"Doto","Space Mono",monospace;
  color-scheme:light}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--black:#F5F5F5;--surface:#FFFFFF;--border:#E8E8E8;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;--text-disabled:#999999;--text-secondary:#666666;--text-primary:#1A1A1A;--text-display:#000000;color-scheme:light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--black:#000000;--surface:#111111;--border:#222222;--border-visible:#333333;--seg-empty:#222222;--text-disabled:#666666;--text-secondary:#999999;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}}
:root[data-theme="dark"]{--black:#000000;--surface:#111111;--border:#222222;--border-visible:#333333;--seg-empty:#222222;--text-disabled:#666666;--text-secondary:#999999;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--black);color:var(--text-primary);font:400 var(--fs-sm)/1.5 var(--grotesk)}
main{max-width:1100px;margin:0 auto;padding:0 16px}
.label,.prov-tag,.edge-strip,th,dt,.inst-sub,.mono-note,.empty,.empty-inline,.progress-val,.status-word,.track-val,.hero-n{font-family:var(--mono);font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em}
.label,dt,th,.inst-sub{color:var(--text-secondary)}
.prov-tag{color:var(--text-disabled)}
.edge-strip{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;padding:16px 0;color:var(--text-disabled)}
#tracker-top-edge-strip{border-bottom:1px solid var(--border)}
#tracker-bottom-edge-strip{border-top:1px solid var(--border);margin-top:64px;padding-bottom:32px}
section{margin-top:48px}
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding-bottom:8px;border-bottom:1px solid var(--border-visible);margin-bottom:16px}
h2{margin:0;font:500 var(--fs-md)/1.2 var(--grotesk);letter-spacing:-.01em;color:var(--text-display)}
h3{margin:24px 0 8px;font:400 var(--fs-sm)/1.2 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.hero{margin-top:48px}
.hero .section-head{border-bottom:0;padding-bottom:0;margin-bottom:0}
.hero-empty{color:var(--text-disabled)}.hero-empty-note{margin:0 0 8px}
.hero-value{font-family:var(--doto);font-weight:700;font-size:var(--fs-hero);line-height:1;letter-spacing:-.03em;color:var(--text-display);margin:16px 0 8px;font-variant-numeric:tabular-nums}
.hero-unit{font-family:var(--mono);font-weight:400;font-size:var(--fs-md);letter-spacing:0;vertical-align:top;margin-left:8px;color:var(--text-secondary)}
.hero-empty{font-size:var(--fs-md);font-family:var(--mono);font-weight:400;letter-spacing:.04em;margin:32px 0 16px}
.hero-n{color:var(--text-primary)}
.edge-note{margin:8px 0 0;max-width:36em;color:var(--text-secondary)}
.instruments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 16px}
@media (min-width:760px){.instruments{grid-template-columns:repeat(5,minmax(0,1fr))}}
.instrument{display:flex;flex-direction:column;gap:8px;min-width:0}
.inst-value{font:400 var(--fs-md)/1.1 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums}
.inst-value .empty-inline{display:block;font-size:var(--fs-sm);line-height:1.5;color:var(--text-secondary)}
.seg{display:grid;gap:2px}
.seg i{display:block;background:var(--seg-empty)}
.seg i.on{background:var(--text-display)}
.seg-std i{height:8px}
.seg-hero i{height:16px}
.ibar{height:4px;background:var(--seg-empty)}
.ibar i{display:block;height:100%;background:var(--text-display)}
.st-good{color:var(--success)!important}
.st-warn{color:var(--warning)!important}
.st-bad{color:var(--accent)!important}
.dim{color:var(--text-disabled)!important}
.note{margin:16px 0 0;color:var(--text-secondary)}
.mono-note{margin:16px 0 0;color:var(--text-secondary)}
.empty{margin:8px 0;color:var(--text-secondary)}
.empty-inline{color:var(--text-secondary)}
dl{margin:0}
dd{margin:0}
.stat-row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)}
.stat-row dd{font-family:var(--mono);text-align:right;color:var(--text-primary);letter-spacing:.04em}
.status-word{color:var(--text-display)}
.progress{margin-top:24px}
.progress-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px}
.progress-val{color:var(--text-display)}
.track-row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--border)}
.track-row dt{grid-column:1}
.track-val{grid-column:2;grid-row:1;text-align:right;color:var(--text-primary);white-space:nowrap}
.track-why{grid-column:1 / -1;color:var(--text-primary)}
@media (min-width:760px){.track-row{grid-template-columns:200px 1fr auto}.track-why{grid-column:2;grid-row:1}.track-val{grid-column:3}}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font:400 var(--fs-sm)/1.4 var(--mono);font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 16px 8px 0;white-space:nowrap}
th{font-weight:400;border-bottom:1px solid var(--border-visible)}
td{border-bottom:1px solid var(--border);color:var(--text-primary)}
th.num,td.num{text-align:right;padding:8px 0 8px 16px}
.nav-link{color:var(--text-display);text-decoration:none;border-bottom:1px solid var(--border-visible)}
.nav-link:hover{border-bottom-color:var(--text-display)}
.howto-text{margin:16px 0 0;max-width:42em;font-size:14px;line-height:1.6;color:var(--text-primary)}
#howto-intro-title{margin:0;font:500 clamp(32px,7vw,56px)/1.05 var(--grotesk);letter-spacing:-.02em;color:var(--text-display)}
.howto-steps,.howto-list{margin:0;padding-left:20px;max-width:42em;font-size:14px;line-height:1.6}
.howto-steps li,.howto-list li{padding:6px 0}
.howto-prompt{margin:8px 0 0;padding:12px 16px;background:var(--surface);border:1px solid var(--border);font:400 var(--fs-sm)/1.5 var(--mono);color:var(--text-primary);white-space:pre-wrap;overflow-wrap:anywhere}
`;
