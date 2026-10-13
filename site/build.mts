// Builds the launch page into one self-contained file: fonts, mascot, rules and a real finding inlined.
//   npx tsx site/build.mts            -> site/index.html (GitHub Pages)
//   npx tsx site/build.mts --body X   -> also writes the page without <html>/<head>/<body> to X
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { markSvg, mascotGrid, gridPath, PALETTE } from "../src/brand.js";
import { RULES } from "../src/rules.js";
import { interactionTrace } from "../src/report/trace.js";
import type { InteractionRun } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pkg = JSON.parse(read("package.json"));

// fonts, inlined so the page renders the same everywhere and never swaps faces after first paint
const font = (family: string, file: string, range: string) =>
  `@font-face{font-family:"${family}";${range};font-display:block;src:url(data:font/woff2;base64,${readFileSync(join(root, "assets/fonts", file)).toString("base64")}) format("woff2")}`;
const FONT_CSS =
  font("Bricolage Grotesque", "BricolageGrotesque-latin-opsz-wght.woff2", "font-weight:200 800") +
  font("Martian Mono", "MartianMono-latin-wght-wdth.woff2", "font-weight:100 800;font-stretch:75% 112.5%");

// the mascot grid, shared with the page script
const busy = mascotGrid("busy");
const grid = {
  body: busy.map((r, i) => (i >= 9 && i <= 12 ? "MOUTH" : r)),
  mouths: Object.fromEntries((["calm", "busy", "alarm"] as const).map((m) => [m, mascotGrid(m).slice(9, 13)])),
};
const mark = (mood: "calm" | "busy" | "alarm", attrs = "") => markSvg({ mood, attrs: `aria-hidden="true" ${attrs}` }).replace(/ role="img" aria-label="[^"]*"/, "").replace(/<title>.*?<\/title>/, "");
// a mascot the page script can redraw (mood, blink, eyes); drawn in full at build time so it is there before any script runs
const pet = (id: string, mood: "calm" | "busy" | "alarm", cls: string, label?: string) => {
  const g = mascotGrid(mood);
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="${cls}" id="${id}" viewBox="0 0 64 64" shape-rendering="crispEdges" ${a11y}><path class="body" fill="var(--cobalt)" d="${gridPath(g, "#")}"/><path class="face" fill="${PALETTE.surface}" d="${gridPath(g, "o")}"/></svg>`;
};

// the rules, grouped the way a person thinks about them
const groups: [string, string[]][] = [
  ["Feedback and waiting", ["FEEL-01", "FEEL-03", "FEEL-04", "FEEL-05", "WAIT-01", "CRAFT-07"]],
  ["Motion", ["MOT-01", "MOT-03", "MOT-06", "MOT-08", "MOT-09", "MOT-10", "VIS-08"]],
  ["Layout, focus and input", ["STAB-01", "STAB-02", "CRAFT-02", "CRAFT-03", "CRAFT-04", "CRAFT-05", "CRAFT-08", "CRAFT-09"]],
  ["Look", ["AI-01"]],
];
const shortEvidence = (e: string) => e.replace(/\s*\(.*\)$/, "");
const RULE_GROUPS = groups
  .map(([name, ids]) => `<div class="rule-group"><h3>${esc(name)}</h3><ul>${ids
    .map((id) => {
      const r = RULES[id];
      return `<li><code>${id}</code><span><i class="sev-dot ${r.severity}" aria-label="${r.severity}"></i>${esc(r.title)}</span><em>${esc(shortEvidence(r.evidence))}</em></li>`;
    })
    .join("")}</ul></div>`)
  .join("");

// a real finding and its trace, from a saved zoo run
const sample = JSON.parse(read("site/data/sample-run.json"));
const finding = sample.findings.find((f: { id: string }) => f.id === "FEEL-01-5c130");
const run = sample.runs.find((r: InteractionRun) => r.interaction.key === "/ #slow-ack-btn") as InteractionRun;
const REPORT_TRACE = interactionTrace(run, { budgetMs: 100, id: "site", width: 640 });
const REPORT_SOURCES = [
  finding.source.handler && `<li><code>${esc(finding.source.handler)}</code><span>its click handler</span></li>`,
  ...(finding.source.rules ?? []).slice(0, 2).map((r: { file: string; line: number; selector: string }) => `<li><code>${esc(r.file)}:${r.line}</code><span>${esc(r.selector)}</span></li>`),
].filter(Boolean).join("");

// what kymo found on this page, filled in from the audit before launch
const dogPath = join(here, "data", "dogfood.json");
const dog = existsSync(dogPath) ? JSON.parse(readFileSync(dogPath, "utf8")) : { before: "?", stat: "findings on this page before launch.", summary: "Audit pending.", items: [] };

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`site: no value for {{${k}}}`);
  return vars[k];
});
const body = fill(read("site/src/page.html"), {
  VERSION: esc(pkg.version),
  MARK_NAV: pet("navpet", "busy", "mark"),
  PET: pet("pet", "busy", "pet", "kymo, the mascot"),
  MARK_FOOT: mark("calm"),
  MARK_DOG: pet("dogpet", "calm", "mark"),
  REPORT_MESSAGE: esc(finding.message),
  REPORT_TRACE,
  REPORT_SOURCES,
  REPORT_FIX: esc(finding.fix),
  RULE_COUNT: String(Object.keys(RULES).length),
  RULE_GROUPS,
  DOG_BEFORE: esc(dog.before),
  DOG_STAT: esc(dog.stat),
  DOG_SUMMARY: esc(dog.summary),
  DOG_LIST: dog.items.map((i: string) => `<li>${esc(i)}</li>`).join(""),
});
const css = FONT_CSS + read("site/src/site.css");
const data = { grid, sample: [16, 12, 618, 14, 20, 316, 15, 22, 257, 13, 18] };
const script = `<script>window.KYMO=${JSON.stringify(data)};</script><script>${read("site/src/site.js")}</script>`;
const favicon = `data:image/svg+xml,${encodeURIComponent(markSvg({ mood: "busy" }))}`;
const description = "kymo drives your web app in a real browser, measures how every press, keystroke and scroll feels, points each problem at its source line, and keeps only the fixes that measurably help.";
const head = `<title>kymo</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://shourya0mehta.github.io/kymo/">
<meta property="og:url" content="https://shourya0mehta.github.io/kymo/">
<meta property="og:title" content="kymo: polish you can prove">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="https://raw.githubusercontent.com/shourya0mehta/kymo/main/docs/brand/social-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${favicon}">
<style>${css}</style>`;

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body}
${script}
</body>
</html>
`;
writeFileSync(join(here, "index.html"), full);
const bodyOut = process.argv.indexOf("--body");
if (bodyOut > 0) writeFileSync(process.argv[bodyOut + 1], `${head}\n${body}\n${script}\n`);
console.log(`site/index.html ${(full.length / 1024).toFixed(0)} KB`);
