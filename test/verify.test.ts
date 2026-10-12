import { describe, expect, it } from "vitest";
import { verify } from "../src/verify.js";
import type { AuditResult, Finding, Interaction, InteractionRun } from "../src/types.js";

const ix = (key: string): Interaction => ({ key, route: "/", kind: "click", target: { css: key } });
const f = (rule: string, key: string, interaction?: string, severity: Finding["severity"] = "warning"): Finding => ({
  id: key.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12), key, rule, severity, evidence: "Study", title: rule, message: "", fix: "", group: "g", interaction,
});
const run = (key: string, feedbackMs: number | null): InteractionRun => ({
  interaction: ix(key), mode: "normal", capture: null, requests: [], feedbackMs,
});
const result = (trace: string[], findings: Finding[], feedback: Record<string, number | null> = {}): AuditResult => ({
  tool: "kymo", version: "t", startedAt: "", finishedAt: "", baseUrl: "", routes: ["/"],
  viewport: { width: 1, height: 1 }, trace: trace.map(ix), findings,
  runs: trace.map((k) => run(k, feedback[k] ?? 20)),
  inventory: { durations: [], easings: [], runtime: { durations: [], easings: [] }, sources: { durations: {}, easings: {} }, hasReducedMotionQuery: false },
  counts: { error: 0, warning: 0, suggestion: 0 },
});

describe("verify", () => {
  const before = result(["a", "b"], [f("MOT-09", "MOT-09|a|panel", "a", "suggestion"), f("FEEL-01", "FEEL-01|b", "b")]);

  it("keeps a change that resolves something and adds nothing", () => {
    const after = result(["a", "b"], [f("FEEL-01", "FEEL-01|b", "b")]);
    const v = verify(before, after);
    expect(v.decision).toBe("keep");
    expect(v.resolved.map((x) => x.key)).toEqual(["MOT-09|a|panel"]);
  });

  it("reverts a change that introduces a new finding, even a suggestion", () => {
    const after = result(["a", "b"], [f("FEEL-01", "FEEL-01|b", "b"), f("MOT-08", "MOT-08|panel", "a")]);
    const v = verify(before, after);
    expect(v.decision).toBe("revert");
    expect(v.introduced.map((x) => x.rule)).toEqual(["MOT-08"]);
  });

  it("reverts when feedback gets slower", () => {
    const after = result(["a", "b"], [f("FEEL-01", "FEEL-01|b", "b")], { a: 400 });
    expect(verify(before, after).decision).toBe("revert");
  });

  it("reverts when nothing improved", () => {
    expect(verify(before, before).decision).toBe("revert");
  });

  it("does not credit findings from interactions the after-run never replayed", () => {
    const after = result(["a"], []); // targeted re-run of "a" only
    const v = verify(before, after);
    expect(v.resolved.map((x) => x.key)).toEqual(["MOT-09|a|panel"]);
    expect(v.decision).toBe("keep");
  });

  it("accepts several targets and needs all of them resolved", () => {
    const after = result(["a", "b"], []);
    expect(verify(before, after, { target: ["MOT-09|a", "FEEL-01|b"] }).decision).toBe("keep");
    const partial = result(["a", "b"], [f("FEEL-01", "FEEL-01|b", "b")]);
    expect(verify(before, partial, { target: ["MOT-09|a", "FEEL-01|b"] }).decision).toBe("revert");
  });

  it("checks that the targeted finding is the one resolved", () => {
    const after = result(["a", "b"], [f("MOT-09", "MOT-09|a|panel", "a", "suggestion")]);
    const v = verify(before, after, { target: "MOT-09|a" });
    expect(v.decision).toBe("revert");
    expect(v.reason).toContain("still there");
  });
});
