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

/** Each space owns one color everywhere (`--space`). Amber is never a space color. */
const spaceClasses = ["teal", "clay", "violet", "blue", "green", "rose"]
  .map((name) => `.space-${name}{--space:var(--${name})}`)
  .join("\n");

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
:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
[role=alert]:empty{display:none}
[role=alert]{background:var(--surface);border:1.5px solid var(--line);border-radius:12px;padding:10px 14px}
.card{background:var(--surface);border-radius:20px;padding:32px;box-shadow:0 4px 18px #0000000f}
.card-narrow{max-width:420px;margin:24px auto 0}
.card-narrow h1{text-align:center}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.connections{list-style:none;padding:0}
.connections li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border-radius:18px;padding:16px 20px;max-width:none}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.search-box{display:flex;align-items:center;gap:8px;background:var(--surface);border:1.5px solid var(--field);border-radius:999px;box-shadow:0 2px 10px #0000000d;padding:6px 8px 6px 24px}
.search-box input{flex:1;min-width:0;width:auto;margin:0;padding:10px 0;background:transparent;border:0;border-radius:0}
kbd{font-family:inherit;font-size:13px;background:var(--bg);color:var(--soft);border-radius:6px;padding:2px 8px}
.home{padding-top:48px}
.home form{max-width:620px;margin:0 auto}
.question{text-align:center;font-size:30px;font-weight:700;letter-spacing:-.3px;margin:0 0 18px}
.hint{text-align:center;margin:12px 0 0}
.search-page{max-width:720px;margin:0 0 36px}
.results{list-style:none;padding:0;margin:0 0 40px;display:flex;flex-direction:column;gap:16px}
.result{display:flex;flex-wrap:wrap;max-width:none;margin:0;background:var(--surface);border-radius:18px;overflow:hidden;box-shadow:0 2px 10px #0000000b}
.tile{flex:0 0 168px;min-height:120px;background:var(--line)}
img.tile{display:block;width:168px;height:auto;object-fit:cover}
.result-body{flex:1 1 320px;min-width:0;padding:18px 22px}
.result h2{font-size:19px;line-height:1.3;margin:0 0 4px}
.result h2 a{text-decoration:none}
.result p{margin:0 0 8px}
.not-it{max-width:720px;background:var(--surface);border-radius:18px;padding:18px 22px}
.not-it p{margin:0 0 4px}
${spaceClasses}
@media (max-width:600px){.column{padding-left:16px;padding-right:16px}.card{padding:24px 20px}h1{font-size:26px}.tile{flex-basis:100%;min-height:72px}img.tile{width:100%;max-height:200px}}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
