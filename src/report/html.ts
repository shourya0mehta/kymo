// The kymo report: one self-contained HTML file. A cobalt pen on gridded recording paper,
// set in Bricolage Grotesque and Martian Mono, with a dark theme that keeps the same tokens.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditResult, Finding, InteractionRun, Severity, SourceInfo } from "../types.js";
import { RULES } from "../rules.js";
import { markSvg, moodOf } from "../brand.js";
import { replayHint } from "../replay.js";
import { durationRuler, easingGlyph, interactionTrace, responseMs, sessionStrip, SEV_GLYPH, sparkline } from "./trace.js";

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inlineImage(outDir: string, rel?: string): string | null {
  if (!rel) return null;
  const p = join(outDir, rel);
  if (!existsSync(p)) return null;
  return `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;
}

/** The report's two faces, embedded so the file looks the same offline: Bricolage Grotesque and Martian Mono. */
function fontFace(): string {
  const faces: [string, string, string][] = [
    ["Bricolage Grotesque", "BricolageGrotesque-latin-opsz-wght.woff2", "font-weight:200 800"],
    ["Martian Mono", "MartianMono-latin-wght-wdth.woff2", "font-weight:100 800;font-stretch:75% 112.5%"],
  ];
  let css = "";
  for (const [family, file, range] of faces) {
    for (const dir of [join(here, "..", "..", "assets", "fonts"), join(here, "..", "assets", "fonts")]) {
      const p = join(dir, file);
      if (!existsSync(p)) continue;
      css += `@font-face{font-family:"${family}";font-style:normal;${range};font-display:block;src:url(data:font/woff2;base64,${readFileSync(p).toString("base64")}) format("woff2")}`;
      break;
    }
  }
  return css;
}

const SEV_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", suggestion: "Suggestion" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function sourceList(s: SourceInfo | undefined): string {
  if (!s) return "";
  const items: string[] = [];
  if (s.markup) items.push(`<li><code>${esc(s.markup)}</code><span>where the element is written</span></li>`);
  if (s.script) items.push(`<li><code>${esc(s.script)}</code><span>where the long frame spent its time</span></li>`);
  if (s.handler) items.push(`<li><code>${esc(s.handler)}</code><span>its event handler</span></li>`);
  for (const r of s.rules ?? []) items.push(`<li><code>${esc(r.file)}:${r.line}</code><span><code class="sel">${esc(r.selector)}</code>${r.motion ? " sets its motion" : ""}</span></li>`);
  return items.length ? `<ul class="src">${items.join("")}</ul>` : "";
}

function metricsList(f: Finding): string {
  const entries = Object.entries(f.metrics ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (!entries.length) return "";
  return `<details class="metrics"><summary>Measurements</summary><dl>${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>`;
}

function findingHtml(f: Finding, result: AuditResult, outDir: string, runFor: (key?: string) => InteractionRun | undefined): string {
  const rule = RULES[f.rule];
  const before = inlineImage(outDir, f.shots?.before);
  const after = inlineImage(outDir, f.shots?.after);
  const run = runFor(f.interaction);
  const trace = run && (run.interaction.kind === "click" || run.interaction.kind === "type") ? interactionTrace(run, { budgetMs: result.thresholds?.feedbackMs, id: f.id }) : "";
  const where: string[] = [];
  if (f.group && !f.group.startsWith("@")) where.push(`<span class="grp">${esc(f.group)}</span>`);
  if (f.route) where.push(`on <code>${esc(f.route)}</code>`);
  if (result.viewports.length > 1 && f.viewports?.length) where.push(`at ${esc(f.viewports.join(" and "))}`);
  const via = f.interaction ? `<p class="via">Seen while ${viaText(f, run)}</p>` : "";
  const hint = replayHint(result, f);
  const shots =
    before || after
      ? `<details class="shots"><summary>Before and after</summary><div class="frames">${
          before ? `<figure><img src="${before}" alt="Before the interaction" loading="lazy"><figcaption>Before</figcaption></figure>` : ""
        }${after ? `<figure><img src="${after}" alt="After the watch window" loading="lazy"><figcaption>After</figcaption></figure>` : ""}</div></details>`
      : "";
  return `<article class="finding" data-sev="${f.severity}" id="${esc(f.id)}">
  <header>
    <p class="kicker">${SEV_GLYPH[f.severity]}<span class="sev">${SEV_LABEL[f.severity]}</span><span class="rid">${esc(f.rule)}</span>${where.length ? `<span class="where">${where.join(" ")}</span>` : ""}</p>
    <h3>${esc(f.title)}</h3>
  </header>
  <p class="msg">${esc(f.message)}</p>
  ${trace ? `<figure class="trace">${trace}</figure>` : ""}
  ${via}
  ${f.element && f.element.css !== run?.interaction.target.css ? `<p class="el"><code>${esc(f.element.css)}</code></p>` : ""}
  ${sourceList(f.source)}
  <p class="fix">${esc(f.fix)}</p>
  <p class="ev">Evidence: ${esc(f.evidence)}. ${rule ? `${esc(rule.threshold.replace(/\.$/, ""))}. <a href="${esc(rule.source)}">Source</a>` : ""}</p>
  ${shots}
  ${metricsList(f)}
  <div class="cmds">
    <button type="button" class="copy" data-copy="${esc(f.id)}" title="Copy the finding id">${esc(f.id)}</button>
    <code>kymo audit --trace .kymo/trace.json --only ${esc(hint)}</code>
    <code>kymo verify --before before.json --after after.json --target ${esc(f.id)}</code>
  </div>
</article>`;
}

function viaText(f: Finding, run?: InteractionRun): string {
  const key = f.interaction ?? "";
  const kind = run?.interaction.kind;
  const name = esc(key.replace(/^\[[\w.-]+\] /, "").slice((f.route ?? "").length).trim().replace(/ @(type|dialog|hover|page)$/, ""));
  if (kind === "page" || key.endsWith("@page")) return "loading, Tabbing through and scrolling the page";
  if (kind === "type") return `typing into <code>${name}</code>`;
  if (kind === "dialog") return `opening <code>${name}</code> and pressing Escape`;
  if (kind === "hover") return `hovering <code>${name}</code>`;
  return `pressing <code>${name}</code>`;
}

function indexHtml(findings: Finding[]): string {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  const items = [...byRule.entries()]
    .map(([id, fs]) => `<li data-sev="${fs[0].severity}"><a href="#${esc(fs[0].id)}">${SEV_GLYPH[fs[0].severity]}<span class="t">${esc(RULES[id]?.title ?? id)}</span><span class="n">${fs.length}</span></a></li>`)
    .join("");
  return `<nav class="index" aria-label="Findings by rule"><ul>${items}</ul></nav>`;
}

const LIGHT = `--paper:#F3F4F7;--paper-2:#FFFFFF;--ink:#12141C;--pencil:#5A6072;--hair:#DCDFE8;--g:#ECEEF3;--G:#DCDFE8;--pen:#2E46F0;--link:#2438D6;--red:#E0393E;--ochre:#B97800;--code:#E8EAF1`;
const DARK = `--paper:#0E1016;--paper-2:#161922;--ink:#E8EAF2;--pencil:#9AA1B4;--hair:#272B37;--g:#1B1E28;--G:#272B37;--pen:#8A9BFF;--link:#A9B6FF;--red:#FF6B6E;--ochre:#F2B544;--code:#1E222D`;

export function renderReport(result: AuditResult, outDir: string): string {
  const { counts } = result;
  const total = result.findings.length;
  const mood = moodOf(counts);
  const normal = result.runs.filter((r) => r.mode === "normal");
  const runByKey = new Map(normal.map((r) => [r.interaction.key, r]));
  const canvasByKey = new Map(result.runs.filter((r) => r.mode === "canvas").map((r) => [r.interaction.key, r]));
  const runFor = (key?: string) => (key ? runByKey.get(key) : undefined);
  const budgets = { feedbackMs: result.thresholds?.feedbackMs ?? 100, typingMs: result.thresholds?.typingMs ?? 100 };
  const findingsByInteraction = new Map<string, Finding[]>();
  for (const f of result.findings) if (f.interaction) findingsByInteraction.set(f.interaction, [...(findingsByInteraction.get(f.interaction) ?? []), f]);
  const modesBy = new Map<string, string[]>();
  for (const r of result.runs) modesBy.set(r.interaction.key, [...(modesBy.get(r.interaction.key) ?? []), r.mode]);

  const headline = total ? `${plural(total, "thing")} to smooth over` : "Nothing to smooth over";
  const sentence = total
    ? `${[counts.error && plural(counts.error, "error"), counts.warning && plural(counts.warning, "warning"), counts.suggestion && plural(counts.suggestion, "suggestion")].filter(Boolean).join(", ")}, from ${plural(normal.length, "interaction")} measured in a real browser.`
    : `Every one of ${plural(normal.length, "interaction")} answered within budget, moved with intent and kept its focus.`;

  const rows = normal
    .map((r) => {
      const k = r.interaction.kind;
      const fs = findingsByInteraction.get(r.interaction.key) ?? [];
      let fb = "";
      let spark = "";
      if (k === "click" || k === "type") {
        const { ms, late } = responseMs(r, canvasByKey.get(r.interaction.key), budgets);
        const press = k === "click" && r.pressFeedback && ms != null ? " on press" : "";
        fb = `<span class="${late ? "late" : ""}">${ms == null ? "none" : `${ms} ms${press}`}</span>`;
        spark = sparkline(r, canvasByKey.get(r.interaction.key), budgets);
      }
      const extra = (modesBy.get(r.interaction.key) ?? []).filter((m) => m !== "normal").join(", ");
      const kindLabel = { click: "press", type: "type", dialog: "dialog", hover: "hover", page: "page sweep" }[k];
      return `<tr${r.error ? ' class="broken"' : ""}><td><code>${esc(r.interaction.key)}</code>${r.error ? `<div class="err">${esc(r.error.slice(0, 140))}</div>` : ""}</td><td>${kindLabel}</td><td class="num">${fb}</td><td>${spark}</td><td>${esc(extra)}</td><td class="num">${fs.length ? `<a href="#${esc(fs[0].id)}">${fs.length}</a>` : ""}</td></tr>`;
    })
    .join("");

  const inv = result.inventory;
  const easings = inv.easings
    .map((e) => `<figure class="easing">${easingGlyph(e)}<figcaption><code>${esc(e)}</code></figcaption></figure>`)
    .join("");
  const ruleRows = Object.values(RULES)
    .map((r) => `<tr><td><code>${r.id}</code></td><td>${esc(r.title)}</td><td>${esc(r.threshold)}</td><td>${esc(r.evidence)}</td><td>${SEV_GLYPH[r.severity]} ${r.severity}</td></tr>`)
    .join("");
  const when = new Date(result.finishedAt);
  const seconds = Math.round((when.getTime() - new Date(result.startedAt).getTime()) / 1000);
  const strip = sessionStrip(result);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>kymo report: ${esc(headline)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(markSvg({ mood }))}">
<style>
${fontFace()}
:root{${LIGHT};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK};color-scheme:dark}}
:root[data-theme=dark]{${DARK};color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.6 "Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;font-optical-sizing:auto}
h1,h2,h3,.brand b{font-family:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;font-optical-sizing:auto;letter-spacing:-.02em}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:2px}
code{font:12px/1.5 "Martian Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-stretch:90%;background:var(--code);padding:1px 6px;border-radius:4px;word-break:break-word}
a{color:var(--link)}
.wrap{max-width:1120px;margin:0 auto;padding:44px 32px 96px}
/* masthead */
.mast{display:grid;grid-template-columns:auto 1fr auto;gap:8px 22px;align-items:end}
.mark{width:76px;height:76px;display:block}
.brand{font:500 12px "Martian Mono",ui-monospace,monospace;font-stretch:90%;margin:0;color:var(--pencil);display:flex;gap:8px;align-items:baseline}
.brand b{color:var(--ink);font:800 20px "Bricolage Grotesque",ui-sans-serif,sans-serif;letter-spacing:-.03em}
h1{font-size:42px;line-height:1.05;font-weight:760;letter-spacing:-.03em;margin:6px 0 0}
.lede{grid-column:2/3;margin:2px 0 0;color:var(--pencil);font-size:18px;max-width:62ch}
.meta{display:grid;grid-template-columns:auto auto;gap:2px 14px;margin:0;font-size:13.5px;color:var(--pencil);text-align:left}
.meta dt{font-weight:600;color:var(--ink)}.meta dd{margin:0;max-width:30ch;overflow-wrap:anywhere}
.side-meta{align-self:start;justify-self:end;display:grid;gap:10px;justify-items:start}
.theme{font:inherit;font-size:13px;color:var(--pencil);background:none;border:1px solid var(--hair);border-radius:999px;padding:3px 12px;cursor:pointer}
/* the recording */
.session{margin:30px 0 8px}
.kymo-strip,.kymo-trace,.kymo-ruler{display:block;width:100%;height:auto;overflow:visible}
.g{stroke:var(--g);stroke-width:1;fill:none}.G{stroke:var(--G);stroke-width:1;fill:none}
.pen{fill:none;stroke:var(--pen);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.pen.red,.dur.red{stroke:var(--red)}
.budget{stroke:var(--red);stroke-width:1.1;stroke-dasharray:2 4;fill:none;opacity:.85}
.lbl{font:10px/1 "Martian Mono",ui-monospace,monospace;font-stretch:90%;fill:var(--pencil);paint-order:stroke;stroke:var(--paper-2);stroke-width:3px;stroke-linejoin:round}
.kymo-strip .lbl,.kymo-ruler .lbl{stroke:var(--paper)}.lbl.red{fill:var(--red)}.lbl.dim{opacity:.8}
.tick{stroke:var(--pencil);stroke-width:1.2}
.hatch{stroke:var(--red);stroke-width:2;opacity:.35}
.anim{stroke:var(--pencil);stroke-width:5;stroke-linecap:round;opacity:.45}.anim.moving{stroke:var(--pen);opacity:.75}.anim.loop{stroke-dasharray:2 5}
.dur{stroke:var(--pen);stroke-width:2.4;stroke-linecap:round}
.x{stroke:var(--red);stroke-width:1.6;stroke-linecap:round}
.dot.error{fill:var(--red)}.dot.warning{fill:var(--ochre)}.dot.suggestion{fill:none;stroke:var(--pencil);stroke-width:1.4}
.hit{fill:transparent}
.legend{font-size:13.5px;color:var(--pencil);margin:6px 0 0;max-width:80ch}
@media (prefers-reduced-motion:no-preference){.pen.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:record 480ms cubic-bezier(.2,0,0,1) 120ms forwards}@keyframes record{to{stroke-dashoffset:0}}}
/* layout */
.cols{display:grid;grid-template-columns:232px minmax(0,1fr);gap:48px;margin-top:40px}
.side{position:sticky;top:20px;align-self:start;font-size:14px}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.filters button{font:inherit;font-size:13px;color:var(--ink);background:none;border:1px solid var(--hair);border-radius:999px;padding:3px 11px;cursor:pointer}
.filters button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.index ul{list-style:none;margin:0;padding:0}
.index a{display:grid;grid-template-columns:14px 1fr auto;gap:8px;align-items:baseline;padding:5px 0;text-decoration:none;border-bottom:1px solid var(--hair)}
.index a:hover .t{text-decoration:underline}
.index .n{color:var(--pencil)}
.sg{width:11px;height:11px;flex:none;vertical-align:-1px}.sg.error{fill:var(--red)}.sg.warning{fill:var(--ochre)}.sg.suggestion{fill:none;stroke:var(--pencil);stroke-width:1.6}
h2{font-size:26px;line-height:1.2;font-weight:720;margin:64px 0 6px;letter-spacing:-.02em}
.cols h2:first-child{margin-top:0}
.note{color:var(--pencil);margin:0 0 18px;max-width:72ch}
/* findings */
.finding{padding:26px 0 30px;border-top:1px solid var(--hair);max-width:760px}
.finding[hidden]{display:none}
.kicker{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0;font-size:13.5px;color:var(--pencil)}
.kicker .sev{font-weight:600;color:var(--ink)}
.finding[data-sev=error] .kicker .sev{color:var(--red)}.finding[data-sev=warning] .kicker .sev{color:var(--ochre)}
.kicker .rid{font-variant-numeric:tabular-nums}
.grp{font-weight:600;color:var(--ink)}
h3{font-size:21px;line-height:1.25;font-weight:700;margin:4px 0 6px}
.msg{font-size:17px;margin:0 0 12px;max-width:68ch}
.trace{margin:14px 0 12px;padding:10px 12px 6px;background:var(--paper-2);border:1px solid var(--hair);border-radius:8px}
.via{font-size:14px;color:var(--pencil);margin:0 0 4px}
.el{margin:0 0 8px;font-size:13px}
.src{list-style:none;margin:6px 0 12px;padding:0;font-size:14px}
.src li{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;padding:2px 0}
.src li>span{color:var(--pencil)}
.src .sel{background:none;padding:0}
.fix{margin:10px 0 6px;max-width:68ch;padding-left:14px;border-left:3px solid var(--pen)}
.ev{font-size:13.5px;color:var(--pencil);margin:6px 0 10px;max-width:72ch}
details{margin:6px 0}
summary{cursor:pointer;font-size:14px;color:var(--pencil)}
.frames{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}
.frames figure{margin:0;flex:0 1 340px}
.frames img{max-width:100%;display:block;border:1px solid var(--hair);border-radius:4px}
.frames figcaption{font-size:13px;color:var(--pencil);margin-top:4px}
.metrics dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;margin:8px 0 0;font-size:13.5px}
.metrics dt{color:var(--pencil)}.metrics dd{margin:0}
.cmds{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:12px}
.cmds code{font-size:11.5px}
.copy{font:11.5px "Martian Mono",ui-monospace,monospace;font-stretch:90%;color:var(--ink);background:none;border:1px solid var(--hair);border-radius:3px;padding:2px 7px;cursor:copy}
.copy.done{border-color:var(--ink)}
.empty{font-size:18px;max-width:60ch}
/* tables and inventory */
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid var(--hair);vertical-align:middle}
th{font-weight:600;color:var(--pencil);font-size:13px}
td.num{text-align:right;white-space:nowrap}
.late{color:var(--red);font-weight:600}
tr.broken td{color:var(--pencil)}.err{font-size:12px;color:var(--red)}
.spark{width:120px;height:22px;display:block}
.easings{display:flex;flex-wrap:wrap;gap:14px;margin-top:14px}
.easing{margin:0;width:112px}.easing figcaption{font-size:11px;line-height:1.3;overflow-wrap:anywhere}.easing code{background:none;padding:0;font-size:10.5px}
.ease{width:44px;height:44px;display:block}
footer{margin-top:80px;padding-top:18px;border-top:1px solid var(--hair);display:flex;gap:14px;align-items:center;color:var(--pencil);font-size:13.5px}
footer svg{width:30px;height:30px}
@media (max-width:980px){.cols{grid-template-columns:1fr;gap:20px}.side{position:static}.index ul{columns:2;column-gap:24px}}
@media (max-width:640px){.wrap{padding:28px 16px 64px}.mast{grid-template-columns:auto 1fr}.mark{width:56px;height:56px}h1{font-size:29px}.lede{grid-column:1/3}.side-meta{grid-column:1/3;grid-row:auto;justify-self:start}.index ul{columns:1}.msg{font-size:16px}}
@media print{.side,.theme,.cmds,.filters{display:none}.cols{display:block}.finding{break-inside:avoid}}
</style></head>
<body><div class="wrap">
<header class="mast">
  <div>${markSvg({ mood, title: "kymo", attrs: 'class="mark"' })}</div>
  <div>
    <p class="brand"><b>kymo</b> ${esc(result.version)}</p>
    <h1>${esc(headline)}</h1>
  </div>
  <div class="side-meta"><dl class="meta">
    <dt>App</dt><dd>${esc(result.baseUrl)}</dd>
    <dt>Routes</dt><dd>${result.routes.map(esc).join(", ")}</dd>
    <dt>Viewports</dt><dd>${result.viewports.map((v) => `${esc(v.name)} ${v.width}×${v.height}`).join(", ")}</dd>
    <dt>Measured</dt><dd>${esc(when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}, ${seconds} s</dd>
  </dl><button type="button" class="theme" id="theme" aria-label="Switch colour theme">Theme: auto</button></div>
  <p class="lede">${esc(sentence)}</p>
</header>

${strip ? `<section class="session" aria-labelledby="rec">
  <h2 id="rec" class="visually-hidden" style="position:absolute;left:-9999px">Recording</h2>
  ${strip}
  <p class="legend">Each pulse is one press or keystroke, in the order kymo made them. Its height is the time until the screen first changed; the dashed line is the ${result.thresholds?.feedbackMs ?? 100} ms budget. Red pulses missed it, a cross means nothing changed, and a dot links to that interaction's worst finding.</p>
</section>` : ""}

<div class="cols">
  <aside class="side">
    ${total ? `<div class="filters" role="group" aria-label="Show findings">
      <button type="button" data-filter="all" aria-pressed="true">All ${total}</button>
      ${counts.error ? `<button type="button" data-filter="error" aria-pressed="false">Errors ${counts.error}</button>` : ""}
      ${counts.warning ? `<button type="button" data-filter="warning" aria-pressed="false">Warnings ${counts.warning}</button>` : ""}
      ${counts.suggestion ? `<button type="button" data-filter="suggestion" aria-pressed="false">Suggestions ${counts.suggestion}</button>` : ""}
    </div>${indexHtml(result.findings)}` : ""}
  </aside>
  <main>
    <h2>Findings</h2>
    <p class="note">Worst first. Severity follows the evidence: specs and studies can warn or error; practitioner taste only suggests.</p>
    ${result.findings.map((f) => findingHtml(f, result, outDir, runFor)).join("\n") || `<p class="empty">No findings. kymo pressed, typed, tabbed, hovered and scrolled through everything it could reach, and it all held up.</p>`}

    <h2>Interactions</h2>
    <p class="note">Feedback is the time from release to the first visible change, or from the press when something changed while the button was held. For typing, it is keydown to the letter on screen.</p>
    <div class="tablewrap"><table><thead><tr><th>Interaction</th><th>Kind</th><th class="num">Feedback</th><th>Trace</th><th>Also run with</th><th class="num">Findings</th></tr></thead><tbody>${rows}</tbody></table></div>

    <h2>Motion inventory</h2>
    <p class="note">The stylesheets declare ${plural(inv.durations.length, "distinct duration")} and ${plural(inv.easings.length, "easing curve")} (loops and var() references are not counted). ${
      inv.hasReducedMotionQuery ? "They include a prefers-reduced-motion query." : "They have no prefers-reduced-motion query."
    }</p>
    ${inv.durations.length ? durationRuler(inv, result.thresholds?.maxDurationMs ?? 500) : ""}
    ${easings ? `<div class="easings">${easings}</div>` : ""}

    <h2>Rules</h2>
    <details><summary>What kymo checks, and why</summary><div class="tablewrap"><table><thead><tr><th>Rule</th><th>Checks</th><th>Threshold</th><th>Evidence</th><th>Severity</th></tr></thead><tbody>${ruleRows}</tbody></table></div></details>
  </main>
</div>
<footer>${markSvg({ mood: "calm", attrs: 'class="mark" style="width:28px;height:28px"' })}<span>Recorded by kymo ${esc(result.version)} in Chromium. A kymograph writes motion onto a turning drum; this one writes how your interface answers.</span></footer>
</div>
<script>
(() => {
  const root = document.documentElement, btn = document.getElementById("theme");
  const order = ["auto", "light", "dark"];
  let theme = "auto";
  try { theme = localStorage.getItem("kymo-theme") || "auto"; } catch (e) {}
  const apply = () => { if (theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme); btn.textContent = "Theme: " + theme; };
  apply();
  btn.addEventListener("click", () => { theme = order[(order.indexOf(theme) + 1) % 3]; try { localStorage.setItem("kymo-theme", theme); } catch (e) {} apply(); });
  const filters = document.querySelectorAll("[data-filter]");
  for (const b of filters) b.addEventListener("click", () => {
    const f = b.dataset.filter;
    for (const o of filters) o.setAttribute("aria-pressed", String(o === b));
    for (const el of document.querySelectorAll(".finding, .index li")) el.hidden = f !== "all" && el.dataset.sev !== f;
  });
  for (const c of document.querySelectorAll("[data-copy]")) c.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(c.dataset.copy); c.classList.add("done"); c.textContent = "Copied"; setTimeout(() => { c.textContent = c.dataset.copy; c.classList.remove("done"); }, 1200); } catch (e) {}
  });
})();
</script>
</body></html>`;
}
