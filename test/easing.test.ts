import { describe, expect, it } from "vitest";
import { bezierAt, classifyEasing, normaliseEasing } from "../src/util/easing.js";

describe("easing", () => {
  it("classifies the CSS keywords by shape", () => {
    expect(classifyEasing("linear")).toBe("linear");
    expect(classifyEasing("ease-in")).toBe("accelerating");
    expect(classifyEasing("ease-out")).toBe("decelerating");
    expect(classifyEasing("ease")).toBe("decelerating");
    expect(classifyEasing("ease-in-out")).toBe("symmetric");
    expect(classifyEasing("steps(4, end)")).toBe("stepped");
  });

  it("classifies design-system curves", () => {
    expect(classifyEasing("cubic-bezier(0.2, 0, 0, 1)")).toBe("decelerating"); // M3 standard
    expect(classifyEasing("cubic-bezier(0.3, 0, 1, 1)")).toBe("accelerating"); // M3 exit
    expect(classifyEasing("cubic-bezier(0.34, 1.56, 0.64, 1)")).toBe("overshoot"); // back-out
  });

  it("solves cubic-bezier progress", () => {
    expect(bezierAt([0, 0, 1, 1], 0.5)).toBeCloseTo(0.5, 3);
    expect(bezierAt([0.42, 0, 1, 1], 0.5)).toBeCloseTo(0.315, 2);
  });

  it("normalises equivalent spellings", () => {
    expect(normaliseEasing("ease-out")).toBe(normaliseEasing("cubic-bezier(0, 0, 0.58, 1)"));
    expect(normaliseEasing("LINEAR")).toBe("linear");
  });
});
