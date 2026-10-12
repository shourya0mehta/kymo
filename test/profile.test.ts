import { describe, expect, it } from "vitest";
import { inferProfile, PROFILES, type ProfileSignals } from "../src/profile/infer.js";
import { renderTokensCss } from "../src/profile/tokens.js";

const base: ProfileSignals = {
  controlsInView: 4, tables: 0, keyListeners: 0, proseShare: 0.1, longBlocks: 0,
  imageShare: 0, hero: false, displayHeading: false, serif: false, touchAction: false, draggable: 0, pointerListeners: 0,
};

describe("motion profile inference", () => {
  it("picks Productive for a dense dashboard", () => {
    const r = inferProfile({ ...base, controlsInView: 24, tables: 2, keyListeners: 3 });
    expect(r.profile).toBe("productive");
    expect(r.confident).toBe(true);
  });

  it("picks Calm for long-form reading", () => {
    expect(inferProfile({ ...base, proseShare: 0.8, longBlocks: 6, serif: true }).profile).toBe("calm");
  });

  it("picks Expressive for a landing page with a display headline", () => {
    expect(inferProfile({ ...base, displayHeading: true, hero: true, controlsInView: 4 }).profile).toBe("expressive");
  });

  it("picks Expressive for a hero with big imagery", () => {
    expect(inferProfile({ ...base, hero: true, imageShare: 0.4, controlsInView: 3 }).profile).toBe("expressive");
  });

  it("picks Physical for touch and drag", () => {
    expect(inferProfile({ ...base, touchAction: true, draggable: 5, pointerListeners: 2 }).profile).toBe("physical");
  });

  it("falls back to Productive when signals are weak", () => {
    const r = inferProfile(base);
    expect(r.profile).toBe("productive");
    expect(r.confident).toBe(false);
  });

  it("writes tokens with a reduced-motion block that removes movement", () => {
    const css = renderTokensCss(PROFILES.expressive);
    expect(css).toContain("--motion-duration-lg: 500ms");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*--motion-distance: 0/);
    expect(css).not.toMatch(/--motion-duration-sm: 0ms/); // colour and opacity changes may stay
    expect(css).not.toContain("—"); // no em dashes in generated files
  });
});
