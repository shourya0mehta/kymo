import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AuditResult, Finding, Severity } from "../types.js";
import { RULES } from "../rules.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inlineImage(outDir: string, rel?: string): string | null {
  if (!rel) return null;
  const p = join(outDir, rel);
  if (!existsSync(p)) return null;
  return `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;
}

const SEV_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", suggestion: "Suggestion" };

function findingHtml(f: Finding, outDir: string): string {
  const before = inlineImage(outDir, f.shots?.before);
  const after = inlineImage(outDir, f.shots?.after);
  const metrics = f.metrics
    ? Object.entries(f.metrics)
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
        .map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`)
        .join("")
    : "";
  const shots =
    before || after
      ? `<details class="frames"><summary>Before and after the click</summary><div class="shots">${
          before ? `<figure><img src="${before}" alt="Before the click"><figcaption>Before</figcaption></figure>` : ""
        }${after ? `<figure><img src="${after}" alt="After the watch window"><figcaption>After</figcaption></figure>` : ""}</div></details>`
      : "";
  return `<article class="finding sev-${f.severity}" id="${esc(f.key)}">
  <div class="rule"><code>${esc(f.rule)}</code><span class="sev">${SEV_LABEL[f.severity]}</span><span class="fid">${esc(f.id)}</span></div>
  <div class="body">
    <h3>${esc(f.title)}</h3>
    <p class="msg">${esc(f.message)}</p>
    <p class="where">${f.group && f.group !== "@app" ? `<span class="grp">${esc(f.group)}</span>` : ""}${
      f.element ? `<code>${esc(f.element.css)}</code>` : "<span>whole app</span>"
    }${f.interaction ? ` <span class="via">after clicking <code>${esc(f.interaction.slice((f.route ?? "").length).trim())}</code> on ${esc(f.route ?? "/")}</span>` : ""}</p>
    ${metrics ? `<p class="metrics">${metrics}</p>` : ""}
    <p class="fix"><b>Fix</b> ${esc(f.fix)}</p>
    <p class="ev">Evidence: ${esc(f.evidence)}. <a href="${esc(RULES[f.rule]?.source)}">Source</a></p>
    ${shots}
  </div>
</article>`;
}

export function renderReport(result: AuditResult, outDir: string): string {
  const { counts } = result;
  const total = result.findings.length;
  const normal = result.runs.filter((r) => r.mode === "normal");
  const findingsByInteraction = new Map<string, number>();
  for (const f of result.findings) if (f.interaction) findingsByInteraction.set(f.interaction, (findingsByInteraction.get(f.interaction) ?? 0) + 1);
  const modesBy = new Map<string, string[]>();
  for (const r of result.runs) modesBy.set(r.interaction.key, [...(modesBy.get(r.interaction.key) ?? []), r.mode]);

  const rows = normal
    .map((r) => {
      const ms = r.feedbackMs;
      const cls = ms == null ? "bad" : !r.pressFeedback && ms > 100 ? "warn" : "ok";
      const fb = ms == null ? "none" : `${ms} ms${r.pressFeedback ? " (on press)" : ""}`;
      const extra = (modesBy.get(r.interaction.key) ?? []).filter((m) => m !== "normal").join(", ");
      return `<tr><td><code>${esc(r.interaction.key)}</code></td><td class="${cls}">${esc(fb)}</td><td>${esc(extra || "-")}</td><td>${findingsByInteraction.get(r.interaction.key) ?? 0}</td></tr>`;
    })
    .join("");

  const inv = result.inventory;
  const durList = inv.durations.map((d) => `<span class="pill">${d} ms</span>`).join("");
  const easeList = inv.easings.map((e) => `<span class="pill">${esc(e)}</span>`).join("");
  const ruleRows = Object.values(RULES)
    .map((r) => `<tr><td><code>${r.id}</code></td><td>${esc(r.title)}</td><td>${esc(r.threshold)}</td><td>${esc(r.evidence)}</td><td>${r.severity}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>feelcheck report</title>
<style>
:root{--ink:#15171c;--muted:#5d6371;--line:#e4e6eb;--bg:#fbfbfa;--paper:#fff;--err:#b4371f;--warn:#8f5d00;--sug:#4a5468;--ok:#1d7a46}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:40px 24px 80px}
header .mark{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;color:var(--muted)}
h1{font-size:28px;line-height:1.2;margin:10px 0 6px;letter-spacing:-.01em}
.meta{color:var(--muted);margin:0}
.tally{display:flex;gap:28px;margin:24px 0 8px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tally div{display:flex;flex-direction:column}.tally b{font-size:26px;line-height:1.1}.tally span{color:var(--muted);font-size:13px}
.tally .e b{color:var(--err)}.tally .w b{color:var(--warn)}.tally .s b{color:var(--sug)}
h2{font-size:18px;margin:40px 0 12px}
.note{color:var(--muted);font-size:14px;margin:0 0 16px}
.finding{display:grid;grid-template-columns:120px 1fr;gap:16px;padding:18px 0;border-bottom:1px solid var(--line)}
.rule code{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace}
.rule .sev{display:block;font-size:12px;font-weight:600;margin-top:4px}
.rule .fid{display:block;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin-top:6px}
.sev-error .sev{color:var(--err)}.sev-warning .sev{color:var(--warn)}.sev-suggestion .sev{color:var(--sug)}
.finding h3{font-size:16px;margin:0 0 4px}
.finding p{margin:4px 0}
.msg{color:var(--ink)}
.where{font-size:13px;color:var(--muted)}.where code{font-size:12px;background:#f2f3f5;padding:1px 5px;border-radius:4px;word-break:break-all}
.grp{font-weight:600;color:var(--ink);margin-right:8px}
.metrics{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.metrics span{margin-right:14px}.metrics b{color:var(--ink);font-weight:600}
.fix{font-size:14px}.fix b{margin-right:6px}
.ev{font-size:12px;color:var(--muted)}.ev a{color:inherit}
.frames summary{cursor:pointer;font-size:13px;color:var(--muted);margin-top:6px}
.shots{display:flex;gap:12px;margin-top:10px;flex-wrap:wrap}
.shots figure{margin:0;flex:0 1 380px}.shots img{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}
.shots figcaption{font-size:12px;color:var(--muted);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted)}
td code{font-size:12px;word-break:break-all}
td.ok{color:var(--ok)}td.warn{color:var(--warn);font-weight:600}td.bad{color:var(--err);font-weight:600}
.pill{display:inline-block;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:2px 7px;margin:0 6px 6px 0}
footer{margin-top:48px;color:var(--muted);font-size:12px}
@media (max-width:640px){.finding{grid-template-columns:1fr;gap:4px}.tally{gap:18px}}
</style></head>
<body><div class="wrap">
<header>
  <div class="mark">feelcheck ${esc(result.version)}</div>
  <h1>${total ? `${total} thing${total === 1 ? "" : "s"} to smooth over` : "Nothing to smooth over"}</h1>
  <p class="meta">${esc(result.baseUrl)} · ${result.routes.map(esc).join(", ")} · ${normal.length} interactions · ${esc(new Date(result.finishedAt).toLocaleString("en-US"))}</p>
</header>
<section class="tally">
  <div class="e"><b>${counts.error}</b><span>errors</span></div>
  <div class="w"><b>${counts.warning}</b><span>warnings</span></div>
  <div class="s"><b>${counts.suggestion}</b><span>suggestions</span></div>
</section>
<p class="note">Severity follows evidence: specs and studies can warn or error, practitioner taste only suggests. Every number below was measured in a real browser.</p>

<h2>Findings</h2>
${result.findings.map((f) => findingHtml(f, outDir)).join("\n") || '<p class="note">No findings.</p>'}

<h2>Interactions</h2>
<p class="note">Feedback is the time from release to the first visible change, or from press when something changed while the button was held.</p>
<table><thead><tr><th>Interaction</th><th>Feedback</th><th>Also run with</th><th>Findings</th></tr></thead><tbody>${rows}</tbody></table>

<h2>Motion inventory</h2>
<p class="note">Stylesheets declare ${inv.durations.length} distinct durations and ${inv.easings.length} distinct easing curves (looping animations and var() token references are not counted). ${inv.runtime.durations.length} durations were seen running during the interactions. ${
    inv.hasReducedMotionQuery ? "The CSS has a prefers-reduced-motion query." : "The CSS has no prefers-reduced-motion query."
  }</p>
<div>${durList}</div><div style="margin-top:6px">${easeList}</div>

<h2>Rules</h2>
<table><thead><tr><th>Rule</th><th>Checks</th><th>Threshold</th><th>Evidence</th><th>Severity</th></tr></thead><tbody>${ruleRows}</tbody></table>
<footer>Generated by feelcheck. Thresholds marked as proposals are unvalidated starting points.</footer>
</div></body></html>`;
}
