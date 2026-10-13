import { describe, it, expect } from "vitest";
import { mascotGrid, markSvg, moodOf, terminalMascot } from "../src/brand.js";

describe("brand", () => {
  it("draws every mood on a 16 by 16 grid", () => {
    for (const mood of ["calm", "busy", "alarm"] as const) {
      const g = mascotGrid(mood);
      expect(g).toHaveLength(16);
      for (const row of g) expect(row).toMatch(/^[.#o]{16}$/);
    }
  });

  it("gives each mood its own mouth and keeps the rest of the body", () => {
    const [calm, busy, alarm] = (["calm", "busy", "alarm"] as const).map((m) => mascotGrid(m));
    expect(calm.slice(9, 13)).not.toEqual(busy.slice(9, 13));
    expect(busy.slice(9, 13)).not.toEqual(alarm.slice(9, 13));
    expect(calm.slice(0, 9)).toEqual(busy.slice(0, 9));
    expect(calm.slice(13)).toEqual(alarm.slice(13));
  });

  it("blinks and looks without changing the outline", () => {
    const base = mascotGrid("busy");
    const outline = (g: string[]) => g.map((r) => r.replace(/o/g, "#"));
    expect(outline(mascotGrid("busy", { blink: true }))).toEqual(outline(base));
    expect(outline(mascotGrid("busy", { look: 1 }))).toEqual(outline(base));
    expect(mascotGrid("busy", { look: -1 })[4]).not.toEqual(base[4]);
  });

  it("renders a crisp two-path svg", () => {
    const svg = markSvg({ mood: "calm", title: "kymo" });
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.match(/<path /g)).toHaveLength(2);
  });

  it("picks the mood from the counts", () => {
    expect(moodOf({ error: 1, warning: 0, suggestion: 0 })).toBe("alarm");
    expect(moodOf({ error: 0, warning: 0, suggestion: 2 })).toBe("busy");
    expect(moodOf({ error: 0, warning: 0, suggestion: 0 })).toBe("calm");
  });

  it("fits the terminal creature in 4 lines of 10 cells", () => {
    for (const color of [true, false]) {
      const lines = terminalMascot("busy", color, true);
      expect(lines).toHaveLength(4);
      for (const l of lines) expect(l.replace(/\x1b\[[\d;]*m/g, "")).toHaveLength(10);
    }
  });
});
