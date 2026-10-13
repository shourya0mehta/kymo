import { describe, expect, it } from "vitest";
import { feedbackLatency, feedbackProbe } from "../src/probes/feedback.js";
import type { Capture, InteractionRun } from "../src/types.js";

const cap = (c: Partial<Capture>): Capture => ({
  downAt: 1000, upAt: 1090, clickAt: 1091, firstChangeAt: null, firstChangeReasons: [], frames: 60,
  teleports: [], pops: [], vanishes: [], animations: [], longFrames: [], newControls: [], dialog: null,
  errorUi: null, viewport: { w: 1280, h: 800 }, ...c,
});
const run = (c: Partial<Capture>): InteractionRun => ({
  interaction: { key: "/ #x", route: "/", kind: "click", target: { css: "#x", id: "x" } },
  mode: "normal", capture: cap(c), requests: [],
});

describe("feedback latency", () => {
  it("counts from press when something changed while held", () => {
    expect(feedbackLatency(run({ firstChangeAt: 1016, changeWhileDown: true }))).toEqual({ pressFeedback: true, feedbackMs: 16 });
  });
  it("does not mistake the click's own effect for press feedback", () => {
    // a frame timestamp can precede the click handled in the same frame; the engine reports it was after release
    expect(feedbackLatency(run({ firstChangeAt: 1104, changeWhileDown: false }))).toEqual({ pressFeedback: false, feedbackMs: 13 });
  });
  it("counts from the click otherwise", () => {
    expect(feedbackLatency(run({ firstChangeAt: 1700 }))).toEqual({ pressFeedback: false, feedbackMs: 609 });
  });
  it("flags slow feedback and dead clicks", () => {
    expect(feedbackProbe([run({ firstChangeAt: 1700 })]).map((f) => f.rule)).toEqual(["FEEL-01"]);
    expect(feedbackProbe([run({ firstChangeAt: null })]).map((f) => f.rule)).toEqual(["FEEL-03"]);
    expect(feedbackProbe([run({ firstChangeAt: 1100 })])).toEqual([]);
  });
});
