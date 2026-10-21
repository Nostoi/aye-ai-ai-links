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
    plate: "#FFFFFF",
    pic: "#F2F2F2",
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
    plate: "#E9E6E0",
    pic: "#323236",
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
.menu{display:flex;align-items:center;gap:4px 22px;margin-left:auto;font-size:15.5px}
.menu-page{display:inline-flex;align-items:center;min-height:44px;text-decoration:none}
.account-menu{position:relative}
.account-menu summary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;cursor:pointer;list-style:none}
.account-menu summary::-webkit-details-marker{display:none}
.account-dot{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;border:1.5px solid var(--line);background:var(--surface);color:var(--ink)}
.account-menu summary:hover .account-dot,.account-menu[open] .account-dot{border-color:var(--field)}
.account-dot svg{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.icon-phone,.label-phone{display:none}
.account-list{position:absolute;top:46px;right:0;z-index:20;width:max-content;min-width:200px;padding:4px;border-radius:14px;background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);box-shadow:0 12px 32px rgb(0 0 0 / .16),0 2px 6px rgb(0 0 0 / .06);animation:menu-in .12s ease-out}
.account-list a,.account-list button{display:flex;align-items:center;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:10px;background:none;color:var(--ink);font:inherit;font-size:15px;text-align:left;text-decoration:none;cursor:pointer}
.account-list a:hover,.account-list a:focus-visible,.account-list button:hover,.account-list button:focus-visible{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.account-list .menu-phone-only{display:none}
@media (prefers-reduced-motion:reduce){.account-list{animation:none}}
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
textarea{display:block;width:100%;margin-top:6px;padding:12px 20px;font:inherit;color:var(--ink);background:var(--surface);border:1.5px solid var(--field);border-radius:18px;resize:vertical}
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
.handy-tile.guess{box-shadow:none}
.handy-tile.guess .handy-image{opacity:.45}
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
.result{position:relative;display:flex;flex-wrap:wrap;max-width:none;margin:0;background:var(--surface);border-radius:18px;box-shadow:0 2px 10px #0000000b}
.tile{flex:0 0 168px;min-height:120px;background:var(--pic)}
img.tile{display:block;width:168px;height:auto;contain:size;object-fit:cover}
.result>.tile{border-radius:18px 0 0 18px}
.result-body{position:relative;flex:1 1 320px;min-width:0;padding:18px 22px;overflow-wrap:anywhere}
.result h2{font-size:19px;line-height:1.3;margin:0 0 4px;padding-right:28px}
.result h2 a{position:relative;text-decoration:none}
.result p{margin:0 0 8px}
.not-it{max-width:720px;background:var(--surface);border-radius:18px;padding:18px 22px}
.not-it p{margin:0 0 4px}
.worth{margin:64px 0 0}
.worth-grid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:22px}
.worth-card,.handy-tile{min-width:0;background:var(--surface);overflow:hidden}
.worth-card h3 a,.handy-tile h3 a{text-decoration:none}
.worth-lead{flex:2 1 460px;border-radius:20px;box-shadow:0 4px 18px #0000000f;border-top:6px solid var(--space,var(--line))}
.worth-image{display:block;width:100%;height:220px;object-fit:cover;background:var(--pic)}
.worth-body{min-width:0;padding:22px 26px 24px}
.worth-body p,.worth-body h3{overflow-wrap:anywhere}
.reason{display:inline-block;margin:0 0 12px;padding:5px 12px;border-radius:999px;font-size:13.5px;font-weight:600;background:color-mix(in srgb,var(--space,var(--soft)) 14%,var(--surface))}
.worth-lead h3{font-size:22px;line-height:1.25;margin:0 0 8px}
.meta{font-size:15.5px;margin:0 0 18px}
.meta:empty{display:none}
a.button{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;font-size:15.5px;font-weight:600;text-decoration:none;border:1.5px solid var(--line)}
a.button.primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.worth-grid>.worth-side:first-child{flex:0 1 280px}
.worth-side{flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:22px}
.worth-small{display:flex}
.worth-small,.handy-tile{border-radius:18px;box-shadow:0 2px 10px #0000000b}
.worth-tile{flex:0 0 104px;background:var(--pic)}
img.worth-tile{display:block;width:104px;height:auto;contain:size;object-fit:cover}
.worth-small .worth-body{flex:1;padding:16px 18px}
.worth-small h3,.handy-tile h3{font-size:16px;line-height:1.3;margin:0 0 6px}
.handy-tile{position:relative;display:grid;grid-template-columns:52px minmax(0,1fr) 44px;align-items:center;column-gap:14px;padding:12px 4px 12px 12px;overflow:visible;overflow-wrap:anywhere}
.handy-image{grid-row:1;grid-column:1;width:52px;height:52px;border-radius:12px;object-fit:cover;background:var(--pic)}
img.handy-image{background:#fff}
.handy-caption{grid-row:1;grid-column:2;min-width:0;color:var(--ink)}
.handy-tile h3{margin:0;font-size:16px;font-weight:700;line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.handy-tile h3 a{color:inherit}
.handy-tile h3 a::after{content:"";position:absolute;inset:0;border-radius:18px}
.handy-tile h3 a:focus-visible{outline:none}
.handy-tile h3 a:focus-visible::after{outline:3px solid var(--blue);outline-offset:-3px;box-shadow:inset 0 0 0 6px var(--surface)}
.handy-caption .card-site{min-width:0;margin:0;font-size:14px;color:var(--soft)}
.handy-caption .host{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.handy-tile .ask{position:relative;z-index:2;grid-row:2;grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;margin:6px 0 0}
.handy-tile .ask p{margin:0;font-size:14px;font-weight:700;color:var(--ink)}
.handy-tile .small-actions{flex-wrap:nowrap;gap:0 14px}
.handy-tile .ask button{white-space:nowrap}
.handy-tile .small-actions button{min-height:44px;min-width:44px;padding:0 2px;color:var(--ink);font-weight:600;text-decoration-color:color-mix(in srgb,var(--ink) 35%,transparent)}
.card-menu{position:absolute;top:2px;right:2px;z-index:3}
.card-menu summary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;color:var(--soft);cursor:pointer;list-style:none}
.card-menu summary::-webkit-details-marker{display:none}
.handy-tile:has(.card-menu[open]),.result:has(.card-menu[open]),.link-row:has(.card-menu[open]){z-index:5}
.card-menu-dot{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;color:var(--ink);background:color-mix(in srgb,var(--surface) 75%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 1px 3px rgb(0 0 0 / .12);transition:background-color .15s}
.card-menu-dot svg{fill:currentColor}
.handy-tile .card-menu{position:relative;top:auto;right:auto;z-index:3;grid-row:1;grid-column:3}
.card-menu summary:hover .card-menu-dot,.card-menu[open] .card-menu-dot{color:var(--ink);background:var(--surface)}
.result .card-menu-dot{background:color-mix(in srgb,var(--ink) 7%,transparent);-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}
.result .card-menu summary:hover .card-menu-dot,.result .card-menu[open] .card-menu-dot{background:color-mix(in srgb,var(--ink) 12%,transparent)}
.card-menu-list{position:absolute;top:42px;right:-4px;width:max-content;padding:4px;border-radius:14px;background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);box-shadow:0 12px 32px rgb(0 0 0 / .16),0 2px 6px rgb(0 0 0 / .06);transform-origin:top right;animation:menu-in .12s ease-out}
.card-menu-list button{display:flex;align-items:center;gap:7px;width:100%;min-height:44px;padding:0 10px 0 8px;border:0;border-radius:10px;background:none;color:var(--ink);font-size:14px;font-weight:500;white-space:nowrap;text-align:left}
.card-menu-list button:hover,.card-menu-list button:focus-visible{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.card-menu-list svg{flex:none;fill:none;stroke:var(--soft);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.card-menu-list hr{margin:4px 8px;border:0;border-top:1px solid var(--line)}
@keyframes menu-in{from{opacity:0;transform:translateY(-4px) scale(.97)}}
@media (prefers-reduced-motion:reduce){.card-menu-list{animation:none}.card-menu-dot{transition:none}}
.handy-tile p{margin:0 0 4px}
.worth-small .meta{font-size:14px;margin:0 0 4px}
.small-actions{gap:0 18px}
.small-actions button,.small-actions a{min-height:44px;padding:0;background:none;border:0;color:var(--soft);font-size:14px;text-decoration:underline;text-underline-offset:3px}
.small-actions a{display:inline-flex;align-items:center}
.gone-line{color:var(--soft)}
.gone-line p{margin:0 0 4px}
.handy-control{align-items:center;font-size:14px;color:var(--soft)}
.handy-on{display:inline-flex;align-items:center;gap:6px}
.needs-you{outline:2px solid var(--amber);outline-offset:-2px}
.ask{margin:0 0 14px}
.ask p{margin:0 0 8px}
.tell-why,.why-form input,.why-form button{position:relative}
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
.spaces,.handy{margin:64px 0 0}
.spaces h2,.handy h2{margin-bottom:16px}
.handy{display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:4px}
.handy>h2{grid-row:1;grid-column:1;margin:0}
#handy-shelf{display:contents}
.handy-head{grid-row:1;grid-column:2;display:flex;align-items:center;gap:4px}
.handy-row,.handy-empty,#handy-error{grid-column:1/-1;margin:16px 0 0}
.handy-show-all{min-height:44px;padding:0 12px;border:0;background:none;color:var(--soft);font-size:15px;font-weight:600}
.handy-show-all:hover{color:var(--ink)}
.handy-add{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px 0 10px;border-radius:999px;color:var(--ink);font-size:15px;font-weight:600;text-decoration:none;background:color-mix(in srgb,var(--ink) 5%,transparent);transition:background-color .15s}
.handy-add:hover{background:color-mix(in srgb,var(--ink) 9%,transparent)}
.handy-add svg{flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.handy-empty{align-items:center}
.handy-empty p{margin:0}
.home-spaces{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:22px}
.handy-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.home-space{display:block;min-width:0;padding:18px;background:var(--surface);color:var(--ink);text-decoration:none;border-radius:18px;box-shadow:0 2px 10px #0000000b}
.home-space-name{display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:700;overflow-wrap:anywhere}
.home-space-recent{display:block;margin-top:10px;font-size:14px;line-height:1.6;color:var(--soft)}
.home-space-recent>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.link-rows{list-style:none;padding:0;margin:0;background:var(--surface);border-radius:20px;box-shadow:0 1px 2px #0000000f}
.link-row{position:relative;display:flex;align-items:center;gap:16px;min-width:0;max-width:none;margin:0;padding:14px 60px 14px 16px}
main:not([data-view=pictures]) .link-row:not([hidden]) ~ .link-row{border-top:1px solid var(--line)}
.link-row:first-child{border-radius:20px 20px 0 0}
.link-row:last-child{border-radius:0 0 20px 20px}
.link-row:only-child{border-radius:20px}
.row-pic{flex:0 0 44px;width:44px;height:44px;border-radius:10px;object-fit:cover;background:var(--pic);--icon:30px;--initials:16px}
img.row-pic{display:block}
.row-pic .site-icon{padding:3px;box-shadow:none}
.faded .row-pic{opacity:.4}
.row-body{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.row-body h3{font-size:17px;line-height:1.35;margin:0;overflow-wrap:anywhere}
.row-body h3 a{position:relative;text-decoration:none}
.row-body p{margin:0}
.row-body .ask{margin:8px 0 4px}
.row-why{font-size:15px;color:var(--ink);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.link-row .card-menu{top:50%;right:8px;margin-top:-22px}
main:not([data-view=pictures]) .link-row .card-menu-dot{background:none;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}
.list-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:0 0 16px}
.list-head h2{margin:0}
.all-tools{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.view-switch{display:inline-flex;padding:3px;border-radius:999px;background:color-mix(in srgb,var(--ink) 7%,transparent)}
.view-switch button{min-height:44px;padding:0 16px;border:0;border-radius:999px;background:none;color:var(--soft);font-weight:500}
.view-switch button[aria-pressed=true]{background:var(--surface);color:var(--ink);font-weight:700;box-shadow:0 1px 2px #26262b14}
[data-view=pictures] .link-rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;background:none;border-radius:0;box-shadow:none}
[data-view=pictures] .link-row{display:block;padding:0;border:0;border-radius:18px;background:var(--surface);box-shadow:0 2px 10px #0000000b}
[data-view=pictures] .row-pic{width:100%;height:140px;border-radius:18px 18px 0 0;--icon:80px;--initials:40px}
[data-view=pictures] .row-pic .site-icon{padding:calc(var(--icon) / 9);box-shadow:0 1px 4px rgb(0 0 0 / .12)}
[data-view=pictures] .row-body{padding:14px 18px 18px}
[data-view=pictures] .row-why{white-space:normal}
[data-view=pictures] .link-row .card-menu{top:2px;right:2px;margin-top:0}
.show-older{display:inline-flex;align-items:center;min-height:44px;padding:0 26px;border-radius:999px;background:var(--ink);color:var(--surface);font-size:15.5px;font-weight:600;text-decoration:none}
.all-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:0 0 8px}
.all-head h1{margin:0}
.search-instead{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;background:var(--surface);font-size:15.5px;font-weight:600;text-decoration:none;box-shadow:0 2px 10px #0000000d}
.orders{display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;margin:0 0 24px;font-size:15.5px;color:var(--soft)}
.orders a{display:inline-flex;align-items:center;min-height:44px;color:var(--soft);text-decoration:none}
.orders a[aria-current=true]{color:var(--ink);font-weight:600;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:6px}
.month{margin:0 0 40px}
.month h2{font-size:20px;margin:0 0 14px;color:var(--soft)}
.card-site{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--soft);overflow-wrap:anywhere}
.card-site .dot{flex:none;width:10px;height:10px;margin:0}
.card-line{display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;font-size:14px;color:var(--soft);overflow-wrap:anywhere}
.card-line>*{min-width:0}
.card-line>:has(+ :not([hidden]))::after{content:"·";content:"·"/"";margin-left:6px}
.card-line .line-space{display:inline-flex;align-items:center}
.card-line .dot{flex:none;width:8px;height:8px;margin:0 6px 0 0}
.card-line .saved-copy{display:inline-flex;align-items:center;min-height:44px;margin:-12px 0;color:var(--soft)}
.all-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px}
.copy-notice{flex-basis:100%;margin:0;color:var(--soft);font-size:14px}
.copy-notice.needs-you{padding:10px 14px;border-radius:12px}
.edit-link{width:min(520px,calc(100% - 32px));max-height:calc(100% - 32px);padding:8px 24px 20px;border:0;border-radius:22px;background:var(--surface);color:var(--ink);box-shadow:0 24px 64px rgb(0 0 0 / .28)}
.edit-link::backdrop{background:rgb(20 20 24 / .38)}
.edit-grabber,.edit-top,.edit-hint-phone{display:none}
.edit-head{display:flex;align-items:center;gap:8px;margin:0 -12px 8px 0}
.edit-head h2{flex:1;margin:0;font-size:20px;font-weight:700}
.edit-close{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;background:none;color:var(--soft)}
.edit-close svg,.edit-choose svg{flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.edit-link label,.edit-picture legend{font-size:14px;font-weight:600}
.edit-title{height:46px;padding:0 14px;border-radius:12px}
.edit-page-title{display:flex;flex-wrap:wrap;align-items:center;gap:0 4px;margin:4px 0 0;font-size:13.5px;color:var(--soft);overflow-wrap:anywhere}
.edit-use{min-height:44px;padding:0 4px;border:0;background:none;color:var(--ink);font-size:13.5px;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.edit-picture{min-width:0;margin:16px 0 0;padding:0;border:0}
.edit-picture legend{padding:0;margin:0 0 8px}
.edit-picture-row{display:flex;align-items:center;gap:16px}
.edit-preview{position:relative;flex:none;width:200px;height:140px;border-radius:14px;overflow:hidden;background:var(--pic)}
.edit-preview img{display:block;width:100%;height:100%;object-fit:cover}
.edit-preview.dropping{outline:2px dashed var(--field);outline-offset:-2px}
.edit-initials{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px;line-height:1;font-weight:800;color:color-mix(in srgb,var(--field) 55%,var(--ink))}
.edit-chip{position:absolute;left:8px;bottom:8px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:rgb(20 20 24 / .62)}
div.icon-box,div.initials-box{display:flex;align-items:center;justify-content:center}
.site-icon{display:block;width:var(--icon,72px);height:var(--icon,72px);padding:calc(var(--icon,72px) / 9);object-fit:contain;border-radius:22%;background:var(--plate);box-shadow:0 1px 4px rgb(0 0 0 / .12)}
.edit-preview .site-icon{width:var(--icon,72px);height:var(--icon,72px);min-width:0;min-height:0;object-fit:contain}
.pic-initials{font-size:var(--initials,34px);line-height:1;font-weight:800;letter-spacing:.02em;color:color-mix(in srgb,var(--field) 55%,var(--ink))}
.tile{--icon:72px;--initials:34px}
.worth-image{--icon:112px;--initials:56px}
.worth-tile{--icon:56px;--initials:26px}
.handy-image{--icon:36px;--initials:20px}
.handy-image.initials-box{background:var(--pic)}
.edit-preview.fit-contain{display:flex;align-items:center;justify-content:center;--icon:88px}
.edit-picture-actions{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.edit-choose{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border:1.5px solid var(--line)}
.edit-remove{min-height:44px;padding:0 18px;border:0;background:none}
.edit-hint{margin:0;font-size:13px;color:var(--soft);text-align:center}
.edit-types{margin:12px 0 0;font-size:13.5px;color:var(--soft)}
.edit-error{margin:12px 0 0}
.edit-delete-row{margin:16px 0 0}
.edit-delete{min-height:44px;padding:0;border:0;background:none;color:var(--soft)}
.edit-foot{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.edit-foot button{min-height:44px}
${spaceClasses}
.copy{max-width:720px}
.copy h1,.copy p{overflow-wrap:anywhere}
.copy-article{margin-top:24px;font-size:17px;line-height:1.65;overflow-wrap:anywhere}
.copy-article>*{max-width:68ch}
.copy-article h1,.copy-article h2,.copy-article h3,.copy-article h4{margin:28px 0 12px}
.copy-article img{display:block;max-width:100%;height:auto;margin:16px 0;border-radius:8px}
.copy-article pre{max-width:100%;overflow-x:auto;padding:12px 16px;border-radius:8px;background:var(--surface);border:1px solid var(--line);font-size:14.5px}
.copy-article code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.copy-article blockquote{margin:16px 0;padding:0 0 0 16px;border-left:3px solid var(--line);color:var(--soft)}
.copy-article hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.save{max-width:620px}
.save p{overflow-wrap:anywhere}
.save-form label{margin-top:18px}
.save-form label:first-child{margin-top:0}
.save-form .small{margin:6px 0 0}
.save-form button[type=submit]{margin-top:22px;min-height:48px;min-width:120px}
.save-result .actions{margin-top:22px}
.save-result button{min-height:44px}
.save-link-title{font-size:19px;font-weight:600;margin:0 0 6px}
.save-from-browser{margin-top:44px}
.save-from-browser h3{font-size:17px;margin:20px 0 8px}
.bookmarklet-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;margin-bottom:10px;overflow-wrap:anywhere}
.phone-steps li{max-width:68ch}
@media (max-width:600px){.tile{--icon:56px}.column{padding-left:16px;padding-right:16px}.card{padding:24px 20px}h1{font-size:26px}.tile{flex-basis:100%;min-height:72px}img.tile{width:100%;contain:none;max-height:200px}.result>.tile{border-radius:18px 18px 0 0}.handy-row{grid-template-columns:1fr;gap:8px}.handy-tile{grid-template-columns:44px minmax(0,1fr) 44px;column-gap:12px;padding:10px 4px 10px 12px}.handy-image{width:44px;height:44px;border-radius:10px;--icon:32px;--initials:17px}.home-spaces{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.home-space{display:flex;align-items:center;min-height:56px;padding:0 14px}.home-space-recent{display:none}.edit-link{inset:96px 0 0;width:100%;max-width:100%;max-height:none;height:auto;margin:0;padding:0 16px 24px;border-radius:22px 22px 0 0}.edit-grabber{display:block;width:40px;height:5px;margin:8px auto 4px;border-radius:3px;background:var(--line)}.edit-head{display:grid;grid-template-columns:1fr auto 1fr;margin:0 0 8px}.edit-head h2{font-size:17px;text-align:center}.edit-top{display:inline-flex;align-items:center;justify-self:start;min-height:44px;padding:0;border:0;background:none}.edit-top-save{justify-self:end;font-weight:700}.edit-close,.edit-hint,.edit-foot{display:none}.edit-hint-phone{display:block;margin:0;font-size:13px;color:var(--soft);text-align:center}.edit-title{height:48px}.edit-picture-row{flex-direction:column;align-items:stretch}.edit-preview{width:100%;height:196px}.edit-choose{min-height:48px;width:100%}.link-row{gap:12px;padding:12px 52px 12px 12px}.row-pic{flex-basis:40px;width:40px;height:40px}.row-why{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.link-row .card-menu{right:4px}}
@media (max-width:600px){.menu-page{display:none}.account-list .menu-phone-only{display:flex}.label-wide,.icon-wide{display:none}.label-phone{display:inline}.icon-phone{display:inline-flex}}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;

/**
 * The Ask AI panel's styles (#159), in a second `<style>` that `page()` adds only when the AI is
 * set up, so `themeCss` and the copy page's hashed style stay as they were. Colors are tokens only.
 * Above 900px the open panel is a 400px column on the right; at 900px and below, a full-screen sheet.
 */
export const askCss = `#ask-open{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border:1.5px solid var(--line);border-radius:999px;background:var(--surface);cursor:pointer;font:inherit;font-size:15px;font-weight:600;color:var(--ink)}
#ask-open[aria-pressed=true]{border-color:var(--field)}
#ask-open svg{flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round}
#ask-panel{position:fixed;top:0;right:0;bottom:0;z-index:30;width:400px;display:flex;flex-direction:column;background:var(--surface);border-left:1.5px solid var(--line)}
#ask-panel[hidden]{display:none}
.undo-bar{z-index:31}
body.ask-open{margin-right:400px}
.ask-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 8px;padding:14px 16px 6px 22px}
.ask-title{flex:1;min-width:0}
.ask-title h2{margin:0;font-size:18px}
.ask-title p{margin:0;font-size:13px;color:var(--soft);overflow-wrap:anywhere}
.ask-tools{display:flex;align-items:center;gap:2px}
.ask-restart{min-height:44px;padding:0 10px;font-size:14px;font-weight:400;background:none;border:0;color:var(--soft);text-decoration:underline;text-underline-offset:3px}
.ask-close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;background:none;border:0;color:var(--ink)}
.ask-close svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.ask-back{display:none;align-items:center;min-height:44px;padding:0 8px 0 0;background:none;border:0;color:var(--ink)}
.ask-messages{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:18px 18px 8px}
.ask-me{align-self:flex-end;max-width:300px;margin:0;text-align:right;font-size:15px;color:var(--soft);overflow-wrap:anywhere}
.ask-reply{display:flex;flex-direction:column;gap:8px}
.ask-reply p{margin:0;font-size:15.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.ask-me{white-space:pre-wrap}
.ask-notice{margin:0;font-size:14px;color:var(--soft)}
.ask-changes{display:flex;flex-direction:column;gap:8px}
.ask-change{display:flex;flex-direction:column;gap:8px}
.ask-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:14px}
.ask-line a{display:inline-flex;align-items:center;min-height:44px}
.ask-edit,.ask-undo,.ask-button{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;font-weight:600;text-decoration:none}
.ask-undone{color:var(--soft)}
.ask-note{font-size:13px;color:var(--soft)}
.ask-card.ask-faded{opacity:.4}
.ask-dim{opacity:.4}
.ask-earlier{align-self:center;max-width:100%;min-height:44px;padding:0 10px;font-size:13px;font-weight:400;text-align:center;background:none;border:0;color:var(--soft);text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
.ask-earlier-entries{display:flex;flex-direction:column;gap:14px}
.ask-earlier-entries[hidden]{display:none}
.ask-alert{padding:14px 16px;border:1.5px solid var(--line);border-radius:16px;background:var(--surface)}
.ask-alert p{margin:0 0 6px;overflow-wrap:anywhere}
.ask-alert-more{font-size:15px;color:var(--soft)}
.ask-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.ask-card{display:flex;gap:12px;padding:10px;border-radius:14px;background:var(--bg)}
.ask-card-body{min-width:0;overflow-wrap:anywhere}
.ask-card h3{margin:0 0 4px;font-size:15.5px}
.ask-card .ask-why{margin:0 0 6px;font-size:13px;color:var(--soft)}
.ask-tile{flex:0 0 84px;width:84px;height:84px;--icon:56px;--initials:28px;border-radius:10px;object-fit:cover;background:var(--pic)}
.ask-tags{display:flex;flex-wrap:wrap;gap:6px}
.ask-tag{padding:2px 10px;border-radius:999px;font-size:13px;background:var(--line)}
.ask-tag.ask-space{background:color-mix(in srgb,var(--space) 18%,var(--surface))}
.ask-tag.guess{padding:1px 9px;border:1.5px dashed var(--field);background:none;color:var(--soft);font-style:italic}
.ask-form{padding:12px 16px 18px;border-top:1.5px solid var(--line)}
.ask-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ask-row{display:flex;align-items:flex-end;gap:8px}
.ask-row textarea{flex:1;min-width:0;margin:0;padding:10px 16px;font-size:15.5px;resize:none}
.ask-row button{min-height:48px;padding:0 18px;font-size:15px}
@media (max-width:900px){
body.ask-open{margin-right:0}
#ask-panel{left:0;width:auto;border-left:0}
.ask-head{padding:12px 8px 4px 16px}
.ask-back{display:inline-flex}
.ask-close{display:none}
.ask-title{order:3;flex:1 0 100%;padding-top:8px}
.ask-title h2{font-size:20px}
.ask-messages{padding:14px 16px 8px}
.ask-form{padding:10px 12px 20px}
.ask-row textarea{font-size:16px}
}`;
