import { describe, expect, it } from "vitest";
import { markSvg, moodOf } from "../src/brand.js";
import { interactionTrace, timeline, easingGlyph } from "../src/report/trace.js";
import { glyphFor } from "../src/term.js";
import { cap, interaction, run } from "./helpers.js";

describe("the mark", () => {
  it("changes its trace with the result", () => {
    expect(moodOf({ error: 1, warning: 0, suggestion: 0 })).toBe("alarm");
    expect(moodOf({ error: 0, warning: 0, suggestion: 2 })).toBe("busy");
    expect(moodOf({ error: 0, warning: 0, suggestion: 0 })).toBe("calm");
    expect(markSvg({ mood: "calm" })).not.toBe(markSvg({ mood: "alarm" }));
  });
});

describe("kymograms", () => {
  const i = interaction("/ #like");
  it("times everything from the press, with the budget after the release unless the press answered", () => {
    const tl = timeline(run(i, { capture: cap({ firstChangeAt: 1700 }) }), 100)!;
    expect(tl.change).toBe(700);
    expect(tl.budgetAt).toBe(191);
    const held = timeline(run(i, { capture: cap({ firstChangeAt: 1012, changeWhileDown: true }) }), 100)!;
    expect(held.pressFeedback).toBe(true);
    expect(held.budgetAt).toBe(100);
  });
  it("says when nothing changed, and reports the time the way the finding does", () => {
    expect(interactionTrace(run(i, { capture: cap({ firstChangeAt: null }) }))).toContain("no visible change");
    expect(interactionTrace(run(i, { capture: cap({ firstChangeAt: 1700 }) }))).toContain("609 ms after the release");
  });
  it("draws easing curves, and a question mark for ones it cannot plot", () => {
    expect(easingGlyph("ease-out")).toContain("<path class=\"pen\"");
    expect(easingGlyph("linear(0, 0.5 20%, 1)")).toContain("?");
  });
  it("gives the terminal strip a taller glyph for a slower answer", () => {
    const fast = glyphFor(run(i, { capture: cap({ firstChangeAt: 1100 }) }));
    const slow = glyphFor(run(i, { capture: cap({ firstChangeAt: 1700 }) }));
    expect(fast.tone).toBe("ok");
    expect(slow.tone).toBe("bad");
    expect(slow.ch > fast.ch).toBe(true);
  });
});
