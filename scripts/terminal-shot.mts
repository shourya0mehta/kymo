// Renders kymo's real terminal summary from a saved run as a PNG, for the README.
//   npx tsx scripts/terminal-shot.mts .kymo/eval/latest.json docs/terminal.png CRAFT-03 FEEL-04-875e6 MOT-09-6d380
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { formatSummary } from "../src/term.js";
import type { AuditResult } from "../src/types.js";

const [, , runPath, out, ...ids] = process.argv;
process.env.COLORTERM = "truecolor";
const full = JSON.parse(readFileSync(runPath, "utf8")) as AuditResult;
// format the whole run, so the headline counts are real, then keep the header and the chosen findings
const all = formatSummary(full, { color: true, replay: (f) => (f.group && !f.group.startsWith("@") ? f.group : "@app") });
const blocks = all.split("\n\n");
const plain = (b: string) => b.replace(/\x1b\[[\d;]*m/g, "");
const kept = blocks.slice(1).filter((b) => ids.some((p) => plain(b).includes(` ${p}`)));
const rest = full.findings.length - kept.length;
const text = [blocks[0], ...kept, `\x1b[2m  and ${rest} more in .kymo/report.html\x1b[22m`].join("\n\n");

// xterm 256 colours
const x256 = (n: number) => {
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  if (n >= 16) { n -= 16; const s = [0, 95, 135, 175, 215, 255]; return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`; }
  return ["#000", "#c00", "#0c0", "#cc0", "#00c", "#c0c", "#0cc", "#ccc"][n % 8];
};
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
let html = "", st: { fg?: string; bg?: string; b?: boolean; d?: boolean } = {};
const open = () => {
  const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.b && "font-weight:700", st.d && "opacity:.55"].filter(Boolean).join(";");
  return css ? `<span style="${css}">` : "<span>";
};
for (const part of text.split(/(\x1b\[[\d;]*m)/)) {
  const m = part.match(/^\x1b\[([\d;]*)m$/);
  if (!m) {
    if (!part) continue;
    for (const ch of part) {
      if ("▀▄█".includes(ch)) {
        const fg = st.fg ?? "#E8EAF2", bg = st.bg ?? "transparent";
        const [top, bot] = ch === "█" ? [fg, fg] : ch === "▀" ? [fg, bg] : [bg, fg];
        html += `<span class="cell" style="background:linear-gradient(${top} 50%, ${bot} 50%)"></span>`;
      } else html += open() + esc(ch) + "</span>";
    }
    continue;
  }
  const a = m[1].split(";").map(Number);
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === 0) st = {};
    else if (c === 1) st.b = true;
    else if (c === 2) st.d = true;
    else if (c === 22) { st.b = false; st.d = false; }
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (a[i + 1] === 5) { st[key] = x256(a[i + 2]); i += 2; }
      else if (a[i + 1] === 2) { st[key] = `rgb(${a[i + 2]},${a[i + 3]},${a[i + 4]})`; i += 4; }
    } else if (c === 39) st.fg = undefined;
    else if (c === 49) st.bg = undefined;
  }
}
const font = readFileSync("assets/fonts/MartianMono-latin-wght-wdth.woff2").toString("base64");
const page = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:M;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 800;font-stretch:75% 112.5%}
body{margin:0;background:transparent;padding:28px}
.win{width:1180px;background:#12141C;border-radius:14px;box-shadow:0 0 0 1px #272B37;overflow:hidden}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#181B25;border-bottom:1px solid #272B37;color:#7d8396;font:500 12px M;font-stretch:90%}
.bar i{width:11px;height:11px;border-radius:50%;background:#2a2e3a;display:inline-block}
.bar span{margin-left:12px}
pre{margin:0;padding:20px 26px 24px;color:#E8EAF2;font:400 14px/20px M;font-stretch:88%;white-space:pre-wrap}
.cell{display:inline-block;width:1ch;height:20px;vertical-align:top}
</style><div class="win"><div class="bar"><i></i><i></i><i></i><span>~/kymo  node dist/cli.js audit http://localhost:4173 --routes /,/slop.html</span></div><pre>${html}</pre></div>`;

const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
await p.setContent(page);
await p.evaluate(() => document.fonts.ready);
const el = await p.$(".win");
await el!.screenshot({ path: out, omitBackground: true });
await b.close();
console.log("wrote", out);
