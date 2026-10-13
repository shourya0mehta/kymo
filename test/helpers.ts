import type { Capture, ElementInfo, Interaction, InteractionRun, PageScan } from "../src/types.js";

export const el = (css: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  tag: "button", id: null, testid: null, group: null, text: css.replace(/^#/, ""), css, role: "button", ...extra,
});

export const cap = (c: Partial<Capture> = {}): Capture => ({
  downAt: 1000, upAt: 1090, clickAt: 1091, firstChangeAt: 1100, firstChangeReasons: [], frames: 60,
  teleports: [], pops: [], vanishes: [], animations: [], longFrames: [], newControls: [], dialog: null,
  errorUi: null, viewport: { w: 1280, h: 800 }, ...c,
});

export const interaction = (key: string, kind: Interaction["kind"] = "click", extra: Partial<Interaction> = {}): Interaction => ({
  key, route: "/", kind, target: { css: `#${key.split("#")[1]?.split(" ")[0] ?? "x"}`, id: key.split("#")[1]?.split(" ")[0] }, ...extra,
});

export const run = (i: Interaction, extra: Partial<InteractionRun> = {}): InteractionRun => ({
  interaction: i, mode: "normal", capture: cap(), requests: [], ...extra,
});

export const page = (p: Partial<PageScan> = {}): PageScan => ({
  cls: 0, clsSource: null, longFrames: [], reveals: [], sections: 0, revealedSections: 0,
  focus: [], focusables: 10, targets: [], ai: { tells: [] }, ...p,
});
