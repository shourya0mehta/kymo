import { describe, expect, it } from "vitest";
import { compareRuns, primaryLocation, toSarif, ciMarkdown } from "../src/ci.js";
import { attachSources, dedupe, makeFinding } from "../src/probes/finding.js";
import { DEFAULT_THRESHOLDS, VIEWPORT_PRESETS } from "../src/config.js";
import type { AuditResult, Finding } from "../src/types.js";
import { interaction, run } from "./helpers.js";

const result = (findings: Finding[], keys = ["/ #a", "/ #b"]): AuditResult => ({
  tool: "kymo", version: "0.2.0", startedAt: "", finishedAt: "", baseUrl: "http://x", routes: ["/"],
  viewport: { width: 1280, height: 800 }, viewports: [VIEWPORT_PRESETS.desktop], thresholds: DEFAULT_THRESHOLDS,
  trace: keys.map((k) => interaction(k)), runs: [], findings,
  inventory: { durations: [], easings: [], runtime: { durations: [], easings: [] }, sources: { durations: {}, easings: {} }, hasReducedMotionQuery: false },
  counts: { error: 0, warning: findings.length, suggestion: 0 },
});
const f = (key: string, rule = "FEEL-01") => makeFinding(rule, { keyParts: [key], interaction: interaction(key), message: `m ${key}` });

describe("baseline comparison", () => {
  it("splits findings into added, fixed and kept", () => {
    const cmp = compareRuns(result([f("/ #a"), f("/ #b")]), result([f("/ #b"), f("/ #c", "FEEL-03")], ["/ #b", "/ #c"]));
    expect(cmp.added.map((x) => x.interaction)).toEqual(["/ #a"]);
    expect(cmp.kept.map((x) => x.interaction)).toEqual(["/ #b"]);
    expect(cmp.fixed).toEqual([]); // #c was never measured in the new run, so it is not "fixed"
  });
  it("treats everything as new without a baseline", () => {
    expect(compareRuns(result([f("/ #a")])).added).toHaveLength(1);
  });
  it("writes a summary that leads with the verdict", () => {
    const md = ciMarkdown(result([f("/ #a")]), compareRuns(result([f("/ #a")]), result([])), { failOn: "warning" });
    expect(md.split("\n")[0]).toBe("### kymo: 1 new finding(s) at warning or above");
  });
});

describe("SARIF", () => {
  it("points motion findings at the animating rule, behaviour findings at the handler", () => {
    const source = { rules: [{ file: "src/a.css", line: 4, selector: ".a", motion: false }, { file: "src/b.css", line: 9, selector: ".b", motion: true }], handler: "src/a.ts:3:1" };
    const motion = f("/ #a", "MOT-01");
    motion.source = source;
    const slow = f("/ #b", "FEEL-01");
    slow.source = source;
    const s = toSarif(result([motion, slow]), { fallbackUri: "kymo.config.json" }) as any;
    const [r1, r2] = s.runs[0].results;
    expect(r1.locations[0].physicalLocation.artifactLocation.uri).toBe("src/b.css");
    expect(r2.locations[0].physicalLocation.artifactLocation.uri).toBe("src/a.ts");
    expect(r1.partialFingerprints.kymoKey).toBe(motion.key);
    expect(s.runs[0].tool.driver.rules.map((r: any) => r.id)).toEqual(["MOT-01", "FEEL-01"]);
  });
  it("prefers stamped markup, skips remote URLs, and falls back to the config", () => {
    expect(primaryLocation({ markup: "src/App.tsx:12:5" })).toEqual({ file: "src/App.tsx", line: 12, column: 5 });
    expect(primaryLocation({ rules: [{ file: "https://cdn.example/x.css", line: 1, selector: "a", motion: false }] })).toBeNull();
    const s = toSarif(result([f("/ #a")]), { fallbackUri: "kymo.config.json" }) as any;
    expect(s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("kymo.config.json");
  });
});

describe("findings across viewports", () => {
  it("merges the same problem on desktop and mobile into one finding", () => {
    const d = makeFinding("FEEL-01", { keyParts: ["/ #a"], interaction: interaction("/ #a"), message: "d" });
    const m = makeFinding("FEEL-01", { keyParts: ["[mobile] / #a"], interaction: interaction("[mobile] / #a", "click", { viewport: "mobile" }), message: "m" });
    const out = dedupe([d, m], "desktop");
    expect(out).toHaveLength(1);
    expect(out[0].viewports).toEqual(["desktop", "mobile"]);
    expect(d.id).toBe(m.id);
  });
  it("attaches sources from the run, limited to the parts that help", () => {
    const i = interaction("/ #dismiss");
    const x = makeFinding("MOT-10", { keyParts: ["n"], interaction: i, message: "", sourceKeys: ["#dismiss"], sourceParts: ["handler"] });
    attachSources([x], [run(i, { sources: { "#dismiss": { handler: "src/n.ts:4:2", rules: [{ file: "a.css", line: 1, selector: ".btn", motion: false }] } } })]);
    expect(x.source).toEqual({ handler: "src/n.ts:4:2" });
  });
});

describe("review fixes", () => {
  it("parses WIDTHxHEIGHT viewports, with or without a name", async () => {
    const { parseViewports } = await import("../src/config.js");
    expect(parseViewports("1280x800")).toEqual([{ name: "1280x800", width: 1280, height: 800 }]);
    expect(parseViewports("phone:390x844")).toEqual([{ name: "phone", width: 390, height: 844 }]);
  });
  it("keeps the worst instance when viewports disagree", () => {
    const d = makeFinding("STAB-01", { keyParts: ["/ @page"], interaction: interaction("/ @page", "page"), message: "desktop", severity: "warning" });
    const m = makeFinding("STAB-01", { keyParts: ["[mobile] / @page"], interaction: interaction("[mobile] / @page", "page", { viewport: "mobile" }), message: "mobile", severity: "error" });
    const [one] = dedupe([d, m], "desktop");
    expect(one.severity).toBe("error");
    expect(one.message).toBe("mobile");
    expect(one.viewports).toEqual(["desktop", "mobile"]);
  });
  it("matches a baseline taken at other viewports", () => {
    const base = result([makeFinding("STAB-01", { keyParts: ["[mobile] / @page"], interaction: interaction("[mobile] / @page", "page", { viewport: "mobile" }), message: "" })], ["/ @page", "[mobile] / @page"]);
    const now = result([makeFinding("STAB-01", { keyParts: ["/ @page"], interaction: interaction("/ @page", "page"), message: "" })], ["/ @page"]);
    expect(compareRuns(now, base).added).toEqual([]);
  });
  it("never sends inline styles to code scanning as a file", () => {
    expect(primaryLocation({ rules: [{ file: "<style> in /settings", line: 3, selector: "a", motion: true }] })).toBeNull();
  });
});
