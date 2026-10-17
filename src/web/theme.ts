import { SPACE_COLORS } from "../core/tag-space.js";

/** Light and dark values for every theme token; `page()` inlines them as CSS custom properties. */
export const tokens = {
  light: {
    bg: "#F6F4EF",
    surface: "#FFFFFF",
    ink: "#26262B",
    soft: "#6E6B66",
    line: "#E7E3DA",
    field: "#8F8A82",
    amber: "#E8A33D",
    "amber-bg": "#FFF3DC",
    "amber-ink": "#8A5A0B",
    teal: "#2F8F83",
    clay: "#C8683F",
    violet: "#7B61C9",
    blue: "#3A6FD8",
    green: "#4C8F4C",
    rose: "#C2557A",
  },
  dark: {
    bg: "#1C1C20",
    surface: "#26262B",
    ink: "#EDEBE6",
    soft: "#A8A49D",
    line: "#3A3A40",
    field: "#77736D",
    amber: "#E8A33D",
    "amber-bg": "#3A2E17",
    "amber-ink": "#F2C374",
    teal: "#4FB3A5",
    clay: "#E08A63",
    violet: "#A08BE3",
    blue: "#7099EA",
    green: "#6DBB6D",
    rose: "#DE7E9F",
  },
};

const declarations = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");

/** Each space keeps one color everywhere (`--space`). Amber is never a space color. */
const spaceClasses = SPACE_COLORS.map((name) => `.space-${name}{--space:var(--${name})}`).join(
  "\n",
);

export const themeCss = `:root{${declarations(tokens.light)}}
@media (prefers-color-scheme: dark){:root{${declarations(tokens.dark)}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-rounded, "SF Pro Rounded", system-ui, sans-serif;font-size:17px;line-height:1.5}
.column{max-width:980px;margin:0 auto;padding:0 24px}
.site{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 24px;padding-top:24px;padding-bottom:8px}
.menu{display:flex;flex-wrap:wrap;align-items:center;gap:4px 22px;font-size:15.5px}
.menu a,.menu button{display:inline-flex;align-items:center;min-height:44px}
.menu a{text-decoration:none}
.menu button{padding:0;background:none;border:0;color:var(--soft);text-decoration:underline;text-underline-offset:3px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);font-weight:700;letter-spacing:-.2px;text-decoration:none}
.brand svg{height:28px;width:auto;display:block}
main{padding-top:32px;padding-bottom:64px}
main p,main li{max-width:68ch}
h1{font-size:30px;font-weight:700;letter-spacing:-.3px;line-height:1.2;margin:0 0 20px}
h2{font-size:22px;font-weight:700;letter-spacing:-.2px;line-height:1.25;margin:0 0 12px}
p{margin:0 0 16px}
small,.small{font-size:13.5px;color:var(--soft)}
.lead{font-size:15.5px;color:var(--soft)}
a{color:var(--ink);text-underline-offset:3px}
ul{padding-left:22px;margin:0 0 24px}
li{margin-bottom:10px}
label{display:block;font-size:15.5px;font-weight:600}
input{display:block;width:100%;margin-top:6px;padding:14px 20px;font:inherit;color:var(--ink);background:var(--surface);border:1.5px solid var(--field);border-radius:999px}
button{font:inherit;font-size:15.5px;font-weight:600;padding:10px 20px;border-radius:999px;cursor:pointer;color:var(--ink);background:var(--surface);border:1.5px solid var(--line)}
button.primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}
button:disabled{opacity:.6;cursor:default}
[hidden]{display:none!important}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
[role=alert]:empty{display:none}
[role=alert]{background:var(--surface);border:1.5px solid var(--line);border-radius:12px;padding:10px 14px}
.card{background:var(--surface);border-radius:20px;padding:32px;box-shadow:0 4px 18px #0000000f}
.card-narrow{max-width:420px;margin:24px auto 0}
.card-narrow h1{text-align:center}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.apps{max-width:760px}
.apps h1{margin-bottom:28px}
.apps h2{margin-bottom:6px}
.apps .lead{margin-bottom:14px}
.group{margin-bottom:44px}
.connections{list-style:none;padding:0;margin:0 0 18px;display:flex;flex-direction:column;gap:12px}
.connections li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border-radius:18px;padding:16px 20px;max-width:none;margin:0;box-shadow:0 2px 10px #0000000b}
.connections li>span{min-width:0;overflow-wrap:anywhere}
.new-key{background:var(--amber-bg);color:var(--amber-ink);border-radius:18px;padding:18px 20px;margin:0 0 14px}
.new-key p{margin:0 0 8px;font-weight:700;overflow-wrap:anywhere}
.new-key-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.new-key code{flex:1 1 280px;min-width:0;overflow-wrap:anywhere;background:var(--surface);color:var(--ink);border-radius:12px;padding:10px 14px;font-size:15px}
.key-form{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.key-form input{flex:1 1 260px;min-width:0;width:auto;margin:0;padding:12px 20px}
.profile>.lead{max-width:62ch;margin-bottom:32px}
.profile h1{margin-bottom:8px}
.profile-columns{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start}
.profile-notes{flex:999 1 520px;min-width:0}
.profile h2{margin-bottom:14px}
.notes{list-style:none;padding:0;margin:0 0 18px;display:flex;flex-direction:column;gap:12px}
.note{max-width:none;margin:0;background:var(--surface);border:1.5px solid transparent;border-radius:18px;padding:16px 20px;box-shadow:0 2px 10px #0000000b}
.note.guess,.handy-tile.guess{border:1.5px dashed var(--field)}
.handy-tile.guess{background:transparent;box-shadow:none}
.note-text{margin:0 0 6px;font-size:16.5px;overflow-wrap:anywhere}
.note-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;font-size:14px;color:var(--soft)}
.note.guess .note-source{font-style:italic}
.note-meta button{min-height:44px;padding:0 16px}
button.link{background:none;border:0;padding:0 6px;font-weight:400;text-decoration:underline;text-underline-offset:3px}
.note-edit textarea{display:block;width:100%;margin:0 0 10px;padding:12px 16px;font:inherit;color:var(--ink);background:var(--surface);border:1.5px solid var(--field);border-radius:14px;resize:vertical}
.focus-panel{flex:1 1 300px;min-width:0;background:var(--surface);border-radius:20px;padding:22px 24px;box-shadow:0 2px 10px #0000000b}
.focus-panel h2{font-size:20px;margin-bottom:4px}
.focus-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}
.focus-list li{margin:0}
.focus-list p{margin:0}
.focus-text{font-weight:600;overflow-wrap:anywhere}
.undo-bar{position:fixed;left:0;right:0;bottom:24px;margin:0 auto;width:fit-content;max-width:calc(100% - 32px);display:flex;align-items:center;gap:14px;background:var(--ink);color:var(--surface);border-radius:28px;padding:6px 6px 6px 22px;box-shadow:0 6px 24px #00000026;font-size:15.5px}
.undo-bar span{min-width:0;overflow-wrap:anywhere}
.undo-bar button{font-weight:700;padding:0 18px;min-height:44px;border:0}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.search-box{display:flex;align-items:center;gap:8px;background:var(--surface);border:1.5px solid var(--field);border-radius:999px;box-shadow:0 2px 10px #0000000d;padding:6px 8px 6px 24px}
.search-box input{flex:1;min-width:0;width:auto;margin:0;padding:10px 0;background:transparent;border:0;border-radius:0}
kbd{font-family:inherit;font-size:13px;background:var(--bg);color:var(--soft);border-radius:6px;padding:2px 8px}
.home{padding-top:48px}
.home-search{max-width:620px;margin:0 auto}
.question{text-align:center;font-size:30px;font-weight:700;letter-spacing:-.3px;margin:0 0 18px}
.hint{text-align:center;margin:12px 0 0}
.search-page{max-width:720px;margin:0 0 36px}
.results{list-style:none;padding:0;margin:0 0 40px;display:flex;flex-direction:column;gap:16px}
.result{display:flex;flex-wrap:wrap;max-width:none;margin:0;background:var(--surface);border-radius:18px;overflow:hidden;box-shadow:0 2px 10px #0000000b}
.tile{flex:0 0 168px;min-height:120px;background:var(--line)}
img.tile{display:block;width:168px;height:auto;contain:size;object-fit:cover}
.result-body{flex:1 1 320px;min-width:0;padding:18px 22px}
.result h2{font-size:19px;line-height:1.3;margin:0 0 4px}
.result h2 a{text-decoration:none}
.result p{margin:0 0 8px}
.not-it{max-width:720px;background:var(--surface);border-radius:18px;padding:18px 22px}
.not-it p{margin:0 0 4px}
.worth{margin:64px 0 0}
.worth-grid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:22px}
.worth-card,.handy-tile{min-width:0;background:var(--surface);overflow:hidden}
.worth-card h3 a,.handy-tile h3 a{text-decoration:none}
.worth-lead{flex:2 1 460px;border-radius:20px;box-shadow:0 4px 18px #0000000f;border-top:6px solid var(--space,var(--line))}
.worth-image{display:block;width:100%;height:220px;object-fit:cover;background:color-mix(in srgb,var(--space,var(--line)) 24%,var(--surface))}
.worth-body{min-width:0;padding:22px 26px 24px}
.worth-body p,.worth-body h3{overflow-wrap:anywhere}
.reason{display:inline-block;margin:0 0 12px;padding:5px 12px;border-radius:999px;font-size:13.5px;font-weight:600;background:color-mix(in srgb,var(--space,var(--soft)) 14%,var(--surface))}
.worth-lead h3{font-size:22px;line-height:1.25;margin:0 0 8px}
.meta{font-size:15.5px;margin:0 0 18px}
.meta:empty{display:none}
a.button{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;font-size:15.5px;font-weight:600;text-decoration:none;border:1.5px solid var(--line)}
a.button.primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.worth-side{flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:22px}
.worth-small{display:flex}
.worth-small,.handy-tile{border-radius:18px;box-shadow:0 2px 10px #0000000b}
.worth-tile{flex:0 0 104px;background:color-mix(in srgb,var(--space,var(--line)) 24%,var(--surface))}
img.worth-tile{display:block;width:104px;height:auto;contain:size;object-fit:cover}
.worth-small .worth-body{flex:1;padding:16px 18px}
.worth-small h3,.handy-tile h3{font-size:16px;line-height:1.3;margin:0 0 6px}
.handy-tile{position:relative;display:flex;flex-direction:column;padding:16px 18px;overflow-wrap:anywhere}
.tile-menu{margin-top:auto;align-self:flex-end;text-align:right}
.handy-tile p{margin:0 0 4px}
.worth-small .meta{font-size:14px;margin:0 0 4px}
.small-actions{gap:0 18px}
.small-actions button{min-height:44px;padding:0;background:none;border:0;color:var(--soft);font-size:14px;text-decoration:underline;text-underline-offset:3px}
.handy-control{align-items:center;font-size:14px;color:var(--soft)}
.handy-on{display:inline-flex;align-items:center;gap:6px}
.needs-you{outline:2px solid var(--amber);outline-offset:-2px}
.ask{margin:0 0 14px}
.ask p{margin:0 0 8px}
.tell-why{min-height:44px;padding:0 16px;font-size:14px;background:var(--amber-bg);color:var(--amber-ink);border:0}
.why-form{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.why-form input{flex:1 1 180px;min-width:0;width:auto;margin:0;padding:10px 16px}
.tags{max-width:760px}
.tags h1{margin-bottom:8px}
.tags .lead{margin-bottom:28px}
.tag-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px}
.tag{max-width:none;margin:0;background:var(--surface);border-radius:18px;padding:12px 14px 12px 22px;box-shadow:0 2px 10px #0000000b}
.tag-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.tag-row h2{flex:1 1 200px;min-width:0;font-size:18px;margin:0;overflow-wrap:anywhere}
.tag .kind{margin-left:10px;font-size:14px;font-weight:400;color:var(--soft);white-space:nowrap}
.dot{display:inline-block;width:14px;height:14px;margin-right:10px;border-radius:50%;background:var(--space,var(--line))}
.tag button{min-height:44px;padding:0 18px}
.tag .pill{border-color:var(--field)}
.tag .pill[aria-pressed=true]{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.tag-edit{display:flex;flex-wrap:wrap;gap:16px 32px;padding:16px 0 6px;margin-top:12px;border-top:1.5px solid var(--line)}
.tag-edit fieldset{border:0;margin:0;padding:0;min-width:0}
.tag-edit legend{font-size:14px;color:var(--soft);padding:0;margin:0 0 8px}
.tag-edit p{margin:8px 0 0}
.choices,.swatches{display:flex;flex-wrap:wrap;gap:6px}
.tag .swatch{width:44px;padding:0;border-radius:50%;background:var(--space);border:4px solid var(--surface);box-shadow:0 0 0 2px transparent}
.tag .swatch[aria-pressed=true]{box-shadow:0 0 0 2px var(--ink)}
.result[class*=" space-"]>.tile{background:color-mix(in srgb,var(--space) 24%,var(--surface))}
.in-space{display:inline-flex;align-items:center;gap:6px;margin-right:8px;font-weight:600;color:var(--ink)}
.in-space .dot{width:10px;height:10px;margin:0}
.spaces,.handy{margin:64px 0 0}
.spaces h2,.handy h2{margin-bottom:16px}
.handy-foot{margin-top:16px}
.handy-empty{align-items:center}
.handy-empty p{margin:0}
.tile-menu summary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;color:var(--soft);cursor:pointer;list-style:none}
.tile-menu summary::-webkit-details-marker{display:none}
.home-spaces,.handy-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:22px}
.home-space{display:block;min-width:0;background:var(--surface);color:var(--ink);text-decoration:none;border-radius:18px;overflow:hidden;box-shadow:0 2px 10px #0000000b}
.mosaic{display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;gap:2px;height:120px}
.mosaic>:first-child{grid-row:span 2}
.mosaic img{display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:cover}
.tint-1{background:color-mix(in srgb,var(--space,var(--field)) 30%,var(--surface))}
.tint-2{background:color-mix(in srgb,var(--space,var(--field)) 18%,var(--surface))}
.tint-3{background:color-mix(in srgb,var(--space,var(--field)) 12%,var(--surface))}
.home-space-name{display:flex;align-items:center;gap:8px;padding:14px 16px;font-size:15.5px;font-weight:700;overflow-wrap:anywhere}
.home-space-name .dot{flex:none;width:12px;height:12px;margin:0;background:var(--space,var(--field))}
.band{background:var(--surface);border-radius:24px;overflow:hidden;box-shadow:0 4px 18px #0000000f;margin:0 0 40px}
.band-color{height:120px;background:color-mix(in srgb,var(--space,var(--field)) 30%,var(--surface));border-bottom:6px solid var(--space,var(--field))}
.band-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:8px 16px;padding:24px 28px 26px}
.band-title{flex:1 1 420px;min-width:0}
.band-head h1{display:flex;align-items:center;gap:12px;margin:0 0 6px;overflow-wrap:anywhere}
.band-head h1 .dot{flex:none;width:16px;height:16px;margin:0;background:var(--space,var(--field))}
.band-kind{margin:0 0 4px;font-size:15.5px;color:var(--soft)}
.band-description{margin:0;font-size:16px;overflow-wrap:anywhere}
.band-head>a,.done-link,.back-link{display:inline-flex;align-items:center;min-height:44px;font-size:15.5px}
.space h2{margin-bottom:16px}
.link-cards{list-style:none;padding:0;margin:0 0 32px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
.link-card{max-width:none;margin:0;min-width:0;background:var(--surface);border-radius:18px;overflow:hidden;box-shadow:0 2px 10px #0000000b}
.card-image{display:block;width:100%;height:150px;object-fit:cover;background:color-mix(in srgb,var(--space,var(--line)) 22%,var(--surface))}
.faded .card-image{opacity:.4}
.card-body{padding:14px 18px 18px}
.card-body h3{font-size:17px;line-height:1.3;margin:0 0 4px;overflow-wrap:anywhere}
.card-body h3 a{text-decoration:none}
.card-body p{margin:0 0 8px}
.card-body p:last-child{margin:0}
.card-why{font-size:15px;overflow-wrap:anywhere}
.show-older{display:inline-flex;align-items:center;min-height:44px;padding:0 26px;border-radius:999px;background:var(--ink);color:var(--surface);font-size:15.5px;font-weight:600;text-decoration:none}
.all-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:0 0 8px}
.all-head h1{margin:0}
.search-instead{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;background:var(--surface);font-size:15.5px;font-weight:600;text-decoration:none;box-shadow:0 2px 10px #0000000d}
.orders{display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;margin:0 0 24px;font-size:15.5px;color:var(--soft)}
.orders a{display:inline-flex;align-items:center;min-height:44px;color:var(--soft);text-decoration:none}
.orders a[aria-current=true]{color:var(--ink);font-weight:600;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:6px}
.month{margin:0 0 40px}
.month h2{font-size:20px;margin:0 0 14px;color:var(--soft)}
.month .link-cards{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));margin:0}
.all-card .card-image{height:140px}
.card-site{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--soft);overflow-wrap:anywhere}
.card-site .dot{flex:none;width:10px;height:10px;margin:0}
.all-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px}
${spaceClasses}
@media (max-width:600px){.column{padding-left:16px;padding-right:16px}.card{padding:24px 20px}h1{font-size:26px}.tile{flex-basis:100%;min-height:72px}img.tile{width:100%;contain:none;max-height:200px}.handy-row{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:12px;padding-bottom:6px}.handy-row>.handy-tile{flex:0 0 72%;scroll-snap-align:start}}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
