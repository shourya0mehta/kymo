import type { AuditResult, Finding } from "./types.js";

export interface LatencyChange {
  interaction: string;
  beforeMs: number | null;
  afterMs: number | null;
}

export interface VerifyResult {
  decision: "keep" | "revert";
  reason: string;
  resolved: Finding[];
  persisting: Finding[];
  introduced: Finding[];
  slower: LatencyChange[];
  target?: string;
}

export interface VerifyOptions {
  /** Finding ids or keys (or unique key prefixes) the change was meant to fix. */
  target?: string | string[];
  /** How much slower feedback may get before it counts as a regression. */
  latencyToleranceMs?: number;
}

function feedbackByInteraction(r: AuditResult): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const run of r.runs) if (run.mode === "normal") m.set(run.interaction.key, run.feedbackMs ?? null);
  return m;
}

/**
 * Compare two audits of the same trace and decide whether a change earned its place.
 * A change is kept only if it resolves something, introduces nothing new (suggestions included),
 * and makes no interaction's feedback slower. Otherwise it should be reverted.
 */
export function verify(before: AuditResult, after: AuditResult, opts: VerifyOptions = {}): VerifyResult {
  const tolerance = opts.latencyToleranceMs ?? 50;
  // Only compare what both runs looked at: a targeted re-run (--only) must not "resolve"
  // findings from interactions it never replayed.
  const scope = new Set(after.trace.map((i) => i.key));
  const inScope = (f: Finding) => !f.interaction || scope.has(f.interaction);
  const beforeFindings = before.findings.filter(inScope);
  const beforeKeys = new Map(beforeFindings.map((f) => [f.key, f]));
  const afterKeys = new Map(after.findings.map((f) => [f.key, f]));
  const resolved = beforeFindings.filter((f) => !afterKeys.has(f.key));
  const persisting = after.findings.filter((f) => beforeKeys.has(f.key));
  const introduced = after.findings.filter((f) => !beforeKeys.has(f.key));

  const fb = feedbackByInteraction(before);
  const fa = feedbackByInteraction(after);
  const slower: LatencyChange[] = [];
  for (const [k, b] of fb) {
    if (!fa.has(k)) continue;
    const a = fa.get(k) ?? null;
    if (b != null && (a == null || a - b > tolerance)) slower.push({ interaction: k, beforeMs: b, afterMs: a });
  }

  const targets: string[] = [];
  for (const t of [opts.target ?? []].flat().filter(Boolean)) {
    const matches = beforeFindings.filter((f) => f.id === t || f.key === t || f.key.startsWith(t));
    if (matches.length !== 1) {
      return {
        decision: "revert",
        reason: matches.length
          ? `Target "${t}" matches ${matches.length} findings; pass its id.`
          : `Target "${t}" is not a finding in the before run (or its interaction was not replayed).`,
        resolved, persisting, introduced, slower,
      };
    }
    targets.push(matches[0].key);
  }
  const target = targets.length ? targets.join(", ") : undefined;

  const base = { resolved, persisting, introduced, slower, target };
  if (introduced.length) {
    return { ...base, decision: "revert", reason: `The change introduced ${introduced.length} new finding(s): ${introduced.map((f) => `${f.id} (${f.title})`).join("; ")}` };
  }
  if (slower.length) {
    return {
      ...base,
      decision: "revert",
      reason: `Feedback got slower on ${slower.map((s) => `${s.interaction} (${s.beforeMs} -> ${s.afterMs ?? "none"} ms)`).join("; ")}. If the change did not touch that control, replay it once more before reverting: timing can vary by a frame.`,
    };
  }
  const open = targets.filter((k) => !resolved.some((f) => f.key === k));
  if (open.length) {
    return { ...base, decision: "revert", reason: `The target finding is still there: ${open.join("; ")}` };
  }
  if (!resolved.length) {
    return { ...base, decision: "revert", reason: "No measured improvement: nothing was resolved." };
  }
  return { ...base, decision: "keep", reason: `Resolved ${resolved.length} finding(s) with nothing new and no slower feedback.` };
}

export function formatVerify(v: VerifyResult): string {
  const lines = [`Decision: ${v.decision.toUpperCase()}`, v.reason, ""];
  if (v.resolved.length) lines.push("Resolved:", ...v.resolved.map((f) => `  - ${f.id ?? f.key}  ${f.key}`));
  if (v.introduced.length) lines.push("Introduced:", ...v.introduced.map((f) => `  + ${f.id ?? f.key}  ${f.message}`));
  if (v.slower.length) lines.push("Slower feedback:", ...v.slower.map((s) => `  ~ ${s.interaction}: ${s.beforeMs} -> ${s.afterMs ?? "none"} ms`));
  lines.push(`Still open: ${v.persisting.length}`);
  return lines.join("\n");
}
