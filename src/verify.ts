import type { AuditResult, Finding } from "./types.js";

export interface LatencyChange {
  interaction: string;
  beforeMs: number | null;
  afterMs: number | null;
}

export type VerifyMode = "fix" | "change";

export interface VerifyResult {
  decision: "keep" | "revert";
  /** "fix": the change must resolve something. "change": a feature or redesign that only has to break nothing. */
  mode: VerifyMode;
  reason: string;
  resolved: Finding[];
  persisting: Finding[];
  introduced: Finding[];
  slower: LatencyChange[];
  /** Interactions whose feedback got faster by more than the tolerance, or that now respond at all. */
  faster: LatencyChange[];
  /** How many interactions both runs measured. */
  shared: number;
  /** Change mode only: interactions measured for the first time (new controls). */
  added: string[];
  /** Change mode only: interactions the after-run no longer has (removed or renamed controls). */
  gone: string[];
  target?: string;
}

export interface VerifyOptions {
  /** Finding ids or keys (or unique key prefixes) the change was meant to fix. */
  target?: string | string[];
  /**
   * "fix" (default): keep only if the change resolves something and breaks nothing.
   * "change": for a feature, restyle or motion pass that was not meant to fix anything; keep if it
   * breaks nothing (no new findings, no slower feedback) across the interactions both runs share.
   */
  mode?: VerifyMode;
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
 * In fix mode a change is kept only if it resolves something, introduces nothing new (suggestions
 * included), and makes no interaction's feedback slower. In change mode the first condition is
 * dropped: a change that was not a fix only has to break nothing.
 */
export function verify(before: AuditResult, after: AuditResult, opts: VerifyOptions = {}): VerifyResult {
  const tolerance = opts.latencyToleranceMs ?? 50;
  const mode: VerifyMode = opts.mode ?? "fix";
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
  const faster: LatencyChange[] = [];
  let shared = 0;
  for (const [k, b] of fb) {
    if (!fa.has(k)) continue;
    shared++;
    const a = fa.get(k) ?? null;
    if (b != null && (a == null || a - b > tolerance)) slower.push({ interaction: k, beforeMs: b, afterMs: a });
    else if (a != null && (b == null || b - a > tolerance)) faster.push({ interaction: k, beforeMs: b, afterMs: a });
  }
  const added = mode === "change" ? [...fa.keys()].filter((k) => !fb.has(k)) : [];
  const gone = mode === "change" ? [...fb.keys()].filter((k) => !fa.has(k)) : [];

  const base0 = { mode, resolved, persisting, introduced, slower, faster, shared, added, gone };
  const wanted = [opts.target ?? []].flat().filter(Boolean);
  if (mode === "change" && wanted.length) {
    return { ...base0, decision: "revert", reason: "A change has no target. Pass --target to check a fix, or --change to check that a feature or redesign broke nothing, not both." };
  }
  if (!shared) {
    return { ...base0, decision: "revert", reason: "The two runs measured no interactions in common, so there is nothing to compare. Audit the same URL and routes, or replay the saved trace." };
  }
  const targets: string[] = [];
  for (const t of wanted) {
    const matches = beforeFindings.filter((f) => f.id === t || f.key === t || f.key.startsWith(t));
    if (matches.length !== 1) {
      return {
        decision: "revert",
        reason: matches.length
          ? `Target "${t}" matches ${matches.length} findings; pass its id.`
          : `Target "${t}" is not a finding in the before run (or its interaction was not replayed).`,
        ...base0,
      };
    }
    targets.push(matches[0].key);
  }
  const target = targets.length ? targets.join(", ") : undefined;

  const base = { ...base0, target };
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
  if (mode === "change") {
    const better = [
      resolved.length ? `resolved ${resolved.length} finding(s)` : "",
      faster.length ? `${faster.length} interaction(s) got faster` : "",
    ].filter(Boolean).join(", and ");
    return {
      ...base,
      decision: "keep",
      reason: `No regressions: nothing new and no slower feedback across ${shared} shared interaction(s).${better ? ` It also ${better}.` : ""}`,
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

const ms = (n: number | null) => (n == null ? "none" : `${Math.round(n)} ms`);
const capped = (list: string[], n = 8) => [...list.slice(0, n).map((k) => `  ${k}`), ...(list.length > n ? [`  and ${list.length - n} more`] : [])];

export function formatVerify(v: VerifyResult): string {
  const head = v.mode === "change" && v.decision === "keep" ? "KEEP (no regressions)" : v.decision.toUpperCase();
  const lines = [`Decision: ${head}`, v.reason, ""];
  if (v.resolved.length) lines.push("Resolved:", ...v.resolved.map((f) => `  - ${f.id ?? f.key}  ${f.key}`));
  if (v.introduced.length) lines.push("Introduced:", ...v.introduced.map((f) => `  + ${f.id ?? f.key}  ${f.message}`));
  if (v.slower.length) lines.push("Slower feedback:", ...v.slower.map((s) => `  ~ ${s.interaction}: ${ms(s.beforeMs)} -> ${ms(s.afterMs)}`));
  if (v.faster.length) lines.push("Faster feedback:", ...v.faster.map((s) => `  ^ ${s.interaction}: ${ms(s.beforeMs)} -> ${ms(s.afterMs)}`));
  if (v.mode === "change") {
    lines.push(`Compared: ${v.shared} interaction(s) both runs measured`);
    if (v.added.length) lines.push(`New, measured for the first time (their findings count as introduced):`, ...capped(v.added));
    if (v.gone.length) lines.push(`Gone from the after-run (not compared):`, ...capped(v.gone));
    if (v.gone.length > v.shared) lines.push("Most interactions were not compared. For a change, audit the whole app again rather than replaying part of it with --only.");
  }
  lines.push(`Still open: ${v.persisting.length}`);
  return lines.join("\n");
}
