// CI support: compare a run with a baseline, write a pull request summary, and emit SARIF
// so findings with a known source line show up as code scanning annotations.
import { existsSync } from "node:fs";
import { RULES } from "./rules.js";
import { withoutViewport } from "./probes/finding.js";
import { preferenceFor, type SourcePreference } from "./browser/sources.js";
import type { AuditResult, Finding, Severity, SourceInfo } from "./types.js";

export interface Comparison {
  added: Finding[];
  fixed: Finding[];
  kept: Finding[];
  /** no baseline: everything counts as added */
  baseline: boolean;
}

/**
 * Compare findings by key. A baseline only judges what both runs looked at, so a run with
 * fewer routes or viewports does not "fix" findings it never measured.
 */
export function compareRuns(current: AuditResult, baseline?: AuditResult | null): Comparison {
  if (!baseline) return { added: current.findings, fixed: [], kept: [], baseline: false };
  // Keys leave out the viewport, so match against every baseline finding. Only "fixed" needs the
  // scope check: a finding counts as fixed only if this run replayed what found it.
  const scope = new Set(current.trace.map((i) => withoutViewport(i.key)));
  const inScope = (f: Finding) => !f.interaction || scope.has(withoutViewport(f.interaction));
  const before = new Map(baseline.findings.map((f) => [f.key, f]));
  const now = new Map(current.findings.map((f) => [f.key, f]));
  return {
    added: current.findings.filter((f) => !before.has(f.key)),
    fixed: baseline.findings.filter((f) => inScope(f) && !now.has(f.key)),
    kept: current.findings.filter((f) => before.has(f.key)),
    baseline: true,
  };
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, suggestion: 1 };
export const SEVERITIES: Severity[] = ["error", "warning", "suggestion"];
export function atLeast(f: Finding, level: Severity): boolean {
  return RANK[f.severity] >= RANK[level];
}

/** The most useful single place to look: stamped markup, then a motion rule, then any rule, then the handler or script. */
export function primaryLocation(s: SourceInfo | undefined, prefer: SourcePreference = "style"): { file: string; line: number; column?: number } | null {
  if (!s) return null;
  const parse = (v: string) => {
    const m = v.match(/^(.*?):(\d+)(?::(\d+))?(?:\s|$)/);
    return m ? { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined } : null;
  };
  if (s.markup) {
    const p = parse(s.markup);
    if (p) return p;
  }
  // only real files in the repository: no URLs, no "<style> in /settings", nothing empty
  const isFile = (f: string) => !!f && !/^https?:/.test(f) && !f.startsWith("<");
  const rules = (s.rules ?? []).filter((r) => isFile(r.file));
  const rule = (prefer === "motion" ? rules.find((r) => r.motion) : undefined) ?? rules[0];
  const fromRule = rule ? { file: rule.file, line: rule.line } : null;
  let fromScript: { file: string; line: number; column?: number } | null = null;
  for (const v of [s.script, s.handler]) {
    if (!v) continue;
    const p = parse(v);
    if (p && isFile(p.file)) { fromScript = p; break; }
  }
  return prefer === "behavior" ? fromScript ?? fromRule : fromRule ?? fromScript;
}

const MARK = { error: "🔴", warning: "🟡", suggestion: "⚪" } as const;

/** Markdown for a pull request comment or $GITHUB_STEP_SUMMARY. */
export function ciMarkdown(result: AuditResult, cmp: Comparison, opts: { reportUrl?: string; failOn?: Severity } = {}): string {
  const lines: string[] = [];
  const failing = cmp.added.filter((f) => atLeast(f, opts.failOn ?? "warning"));
  const verdict = failing.length
    ? `${failing.length} new finding(s) at ${opts.failOn ?? "warning"} or above`
    : cmp.baseline
      ? "No new findings"
      : `${result.findings.length} finding(s), no baseline yet`;
  lines.push(`### kymo: ${verdict}`, "");
  const vps = result.viewports.map((v) => v.name).join(", ");
  lines.push(`Measured ${result.trace.length} interaction(s) on ${result.routes.length} route(s) at ${vps}. ${result.counts.error} error, ${result.counts.warning} warning, ${result.counts.suggestion} suggestion in total.`, "");
  const table = (title: string, fs: Finding[]) => {
    if (!fs.length) return;
    lines.push(`#### ${title} (${fs.length})`, "", "| | Finding | Where | Source |", "|---|---|---|---|");
    for (const f of fs.slice(0, 40)) {
      const loc = primaryLocation(f.source, preferenceFor(f.rule));
      const vps = result.viewports.length > 1 && f.viewports?.length ? `[${f.viewports.join(", ")}]` : "";
      const where = [vps, f.route ?? ""].filter(Boolean).join(" ");
      const msg = f.message.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${MARK[f.severity]} | **${f.rule}** ${RULES[f.rule]?.title ?? f.title}<br>${msg} | ${where || "app"} | ${loc ? `\`${loc.file}:${loc.line}\`` : ""} |`);
    }
    if (fs.length > 40) lines.push(`| | and ${fs.length - 40} more | | |`);
    lines.push("");
  };
  if (cmp.baseline) {
    table("New", cmp.added);
    table("Fixed", cmp.fixed);
    if (cmp.kept.length) lines.push(`${cmp.kept.length} finding(s) were already in the baseline.`, "");
  } else {
    table("Findings", cmp.added);
  }
  if (opts.reportUrl) lines.push(`[Full report](${opts.reportUrl})`, "");
  return lines.join("\n");
}

/** SARIF 2.1.0. Findings without a source line point at the config file so code scanning still lists them. */
export function toSarif(result: AuditResult, opts: { only?: Finding[]; fallbackUri?: string } = {}): object {
  const findings = opts.only ?? result.findings;
  const fallback = opts.fallbackUri ?? (existsSync("kymo.config.json") ? "kymo.config.json" : "package.json");
  const used = [...new Set(findings.map((f) => f.rule))];
  const level = (s: Severity) => (s === "error" ? "error" : s === "warning" ? "warning" : "note");
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "kymo",
            version: result.version,
            informationUri: "https://github.com/shourya0mehta/kymo",
            rules: used.map((id) => {
              const r = RULES[id];
              return {
                id,
                name: r ? r.title.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join("") : id,
                shortDescription: { text: r?.title ?? id },
                fullDescription: { text: r ? `${r.threshold}. ${r.why}` : id },
                help: { text: r?.fix ?? "", markdown: r ? `${r.fix}\n\nEvidence: ${r.evidence}. [Source](${r.source})` : "" },
                helpUri: r?.source,
                defaultConfiguration: { level: level(r?.severity ?? "warning") },
                properties: { tags: ["ux", "feel", r?.probe ?? "app"] },
              };
            }),
          },
        },
        results: findings.map((f) => {
          const loc = primaryLocation(f.source, preferenceFor(f.rule));
          return {
            ruleId: f.rule,
            level: level(f.severity),
            message: { text: `${f.message}${f.viewports && result.viewports.length > 1 ? ` [${f.viewports.join(", ")}]` : ""}${f.route ? ` on ${f.route}` : ""}` },
            partialFingerprints: { kymoKey: f.key },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: loc?.file ?? fallback },
                  region: { startLine: loc?.line ?? 1, ...(loc?.column ? { startColumn: loc.column } : {}) },
                },
              },
            ],
          };
        }),
      },
    ],
  };
}
