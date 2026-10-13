import { describe, expect, it } from "vitest";
import { hoverProbe, keyboardProbe, longFrameProbe, pageProbe, typingProbe } from "../src/probes/interaction.js";
import { continuityProbe } from "../src/probes/continuity.js";
import { revealProbe } from "../src/probes/motion.js";
import { DEFAULT_THRESHOLDS, VIEWPORT_PRESETS } from "../src/config.js";
import type { AnimationRecord, LongFrame } from "../src/types.js";
import { cap, el, interaction, page, run } from "./helpers.js";

const t = DEFAULT_THRESHOLDS;
const frame = (start: number, duration: number): LongFrame => ({ start, duration, blocking: duration - 50, scripts: [{ url: "http://x/app.js", fn: "sort", invoker: "click", charPos: 10, duration }] });
const anim = (a: Partial<AnimationRecord>): AnimationRecord => ({
  kind: "CSSTransition", name: null, prop: "opacity", target: el("#s", { tag: "section", role: null }), duration: 300, delay: 0, iterations: 1,
  easing: "ease-out", props: ["opacity"], computedTransitionProperty: "opacity", transitionAll: false, declaredDuration: 300, enter: false, afterScroll: true, t: 0, ...a,
});
const config = { thresholds: t, viewports: [VIEWPORT_PRESETS.desktop, VIEWPORT_PRESETS.mobile] };

describe("dialogs (CRAFT-03)", () => {
  const i = interaction("/ #open @dialog", "dialog");
  it("names each broken part", () => {
    const f = keyboardProbe([run(i, { dialog: { opened: true, focusMovedIn: false, escapeCloses: false, focusReturned: false, dialog: el("#d") } })]);
    expect(f.map((x) => x.rule)).toEqual(["CRAFT-03"]);
    expect(f[0].message).toMatch(/focus stays behind it.*Escape does not close it/);
    expect(f[0].message).not.toMatch(/return/); // cannot judge focus return if it never closed
  });
  it("passes a dialog that does all three", () => {
    expect(keyboardProbe([run(i, { dialog: { opened: true, focusMovedIn: true, escapeCloses: true, focusReturned: true, dialog: el("#d") } })])).toEqual([]);
  });
});

describe("hover (STAB-02, CRAFT-05)", () => {
  it("flags neighbours that move 2 px or more, ignores sub-pixel noise", () => {
    const i = interaction("/ #follow");
    expect(hoverProbe([run(i, { hover: { shifted: [{ el: el("#msg"), px: 17 }], appeared: null } })]).map((f) => f.rule)).toEqual(["STAB-02"]);
    expect(hoverProbe([run(i, { hover: { shifted: [{ el: el("#msg"), px: 1 }], appeared: null } })])).toEqual([]);
  });
  it("flags hover content that cannot be reached or dismissed", () => {
    const i = interaction("/ #share @hover", "hover");
    const bad = hoverProbe([run(i, { hoverContent: { content: el("#tip", { tag: "span" }), hoverable: false, dismissible: false } })]);
    expect(bad[0].rule).toBe("CRAFT-05");
    expect(bad[0].message).toMatch(/disappears.*Escape/);
    expect(hoverProbe([run(i, { hoverContent: { content: el("#tip"), hoverable: true, dismissible: true } })])).toEqual([]);
  });
});

describe("typing (FEEL-05, CRAFT-08)", () => {
  const i = interaction("/ #email @type", "type");
  it("flags a slow echo and an early error", () => {
    const f = typingProbe([run(i, { typing: { echoMs: 183, earlyError: true, errorText: "Please enter a valid email" } })], t);
    expect(f.map((x) => x.rule).sort()).toEqual(["CRAFT-08", "FEEL-05"]);
  });
  it("leaves a fast, quiet field alone, and skips echoes it could not time", () => {
    expect(typingProbe([run(i, { typing: { echoMs: 16, earlyError: false, errorText: null } })], t)).toEqual([]);
    expect(typingProbe([run(i, { typing: { echoMs: null, earlyError: false, errorText: null } })], t)).toEqual([]);
  });
});

describe("long frames (FEEL-04)", () => {
  const i = interaction("/ #sort");
  it("reports a long frame when feedback was otherwise fine", () => {
    const f = longFrameProbe([run(i, { capture: cap({ firstChangeAt: 1004, changeWhileDown: true, longFrames: [frame(1100, 258)] }) })], t);
    expect(f.map((x) => x.rule)).toEqual(["FEEL-04"]);
    expect(f[0].message).toMatch(/258 ms.*sort/);
  });
  it("leaves it to FEEL-01 when the click was slow anyway", () => {
    expect(longFrameProbe([run(i, { capture: cap({ firstChangeAt: 1400, longFrames: [frame(1100, 258)] }) })], t)).toEqual([]);
  });
});

describe("vanishes (MOT-10)", () => {
  it("reports something that blinks out, pointing at the handler only", () => {
    const i = interaction("/ #dismiss");
    const f = continuityProbe([run(i, { capture: cap({ vanishes: [{ el: el("#notice", { tag: "div" }), t: 1100, areaShare: 0.03, sinceInputMs: 9 }] }) })]);
    expect(f.map((x) => x.rule)).toEqual(["MOT-10"]);
  });
});

describe("scroll reveals (MOT-01, MOT-03)", () => {
  const i = interaction("/ @page", "page");
  it("flags long and accelerating reveals once per route", () => {
    const reveals = [0, 1, 2].map((k) => anim({ target: el(`#s${k}`, { tag: "section" }), duration: 900, easing: "cubic-bezier(0.55, 0, 1, 0.45)", props: ["opacity", "transform"] }));
    const f = revealProbe([run(i, { page: page({ reveals }) })], t);
    expect(f.map((x) => x.rule).sort()).toEqual(["MOT-01", "MOT-03"]);
    expect(f[0].message).toMatch(/3/);
  });
  it("ignores colour fades and loops", () => {
    const reveals = [anim({ props: ["background-color"], duration: 900 }), anim({ iterations: -1, duration: 2000, props: ["transform"] })];
    expect(revealProbe([run(i, { page: page({ reveals }) })], t)).toEqual([]);
  });
});

describe("page sweep", () => {
  const desk = interaction("/ @page", "page");
  const mob = interaction("[mobile] / @page", "page", { viewport: "mobile" });
  it("grades layout shift by the CLS bands", () => {
    expect(pageProbe([run(desk, { page: page({ cls: 0.05 }) })], config)).toEqual([]);
    expect(pageProbe([run(desk, { page: page({ cls: 0.15 }) })], config)[0].severity).toBe("warning");
    expect(pageProbe([run(desk, { page: page({ cls: 0.3 }) })], config)[0].severity).toBe("error");
  });
  it("groups invisible focus by exhibit, and by route when there are no groups", () => {
    const focus = [
      { el: el("#a", { group: "toolbar" }), visible: false, obscured: false },
      { el: el("#b", { group: "toolbar" }), visible: false, obscured: false },
      { el: el("#c"), visible: false, obscured: false },
      { el: el("#d"), visible: true, obscured: true },
    ];
    const f = pageProbe([run(desk, { page: page({ focus }) })], config);
    expect(f.map((x) => `${x.rule} ${x.group}`).sort()).toEqual(["CRAFT-02 @page /", "CRAFT-02 @page /", "CRAFT-02 toolbar"]);
  });
  it("only flags small targets that are also crowded, and touch sizes only on touch viewports", () => {
    const targets = [{ el: el("#bold"), w: 16, h: 16, crowded: true }, { el: el("#lonely"), w: 16, h: 16, crowded: false }];
    const touchTargets = [{ el: el("#save"), w: 100, h: 39, crowded: false }];
    expect(pageProbe([run(desk, { page: page({ targets, touchTargets }) })], config).map((x) => x.rule)).toEqual(["CRAFT-04"]);
    expect(pageProbe([run(mob, { page: page({ targets, touchTargets }) })], config).map((x) => x.rule).sort()).toEqual(["CRAFT-04", "CRAFT-09"]);
  });
  it("needs several template tells before it says anything, and counts them once per route", () => {
    const tells = (n: number) => ({ tells: Array.from({ length: n }, (_, k) => ({ id: `t${k}`, label: `Tell ${k}`, detail: "x" })) });
    expect(pageProbe([run(desk, { page: page({ ai: tells(2) }) })], config)).toEqual([]);
    const f = pageProbe([run(desk, { page: page({ ai: tells(3) }) }), run(mob, { page: page({ ai: tells(4) }) })], config);
    expect(f.map((x) => x.rule)).toEqual(["AI-01"]);
  });
});

describe("long frames the page did not cause", () => {
  it("ignores a long frame with no blocking task, script or layout (a busy machine)", () => {
    const i = interaction("/ #italic");
    const idle = { start: 1100, duration: 143, blocking: 0, script: 0, render: 4, scripts: [] };
    expect(longFrameProbe([run(i, { capture: cap({ firstChangeAt: 1004, changeWhileDown: true, longFrames: [idle] }) })], t)).toEqual([]);
    const layout = { ...idle, render: 120 };
    expect(longFrameProbe([run(i, { capture: cap({ firstChangeAt: 1004, changeWhileDown: true, longFrames: [layout] }) })], t)).toHaveLength(1);
  });
});
