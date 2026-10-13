import type { Finding, InteractionRun } from "../types.js";
import { elementKey, label, makeFinding } from "./finding.js";

/** MOT-09 elements that teleport or pop in with no transition after a click; MOT-10 ones that blink out. */
export function continuityProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture || run.interaction.kind !== "click") continue;
    for (const t of run.capture.teleports) {
      const dist = Math.round(Math.hypot(t.dx, t.dy));
      out.push(
        makeFinding("MOT-09", {
          keyParts: [elementKey(t.el)],
          interaction: run.interaction,
          element: t.el,
          message: `${label(t.el)} jumped ${dist} px in a single frame with no transition.`,
          metrics: { kind: "teleport", distancePx: dist, dx: t.dx, dy: t.dy },
        }),
      );
    }
    for (const p of run.capture.pops) {
      out.push(
        makeFinding("MOT-09", {
          keyParts: [elementKey(p.el)],
          interaction: run.interaction,
          element: p.el,
          message: `${label(p.el)} appeared fully formed (${(p.areaShare * 100).toFixed(1)}% of the viewport) ${p.sinceInputMs} ms after the click, with no transition.`,
          metrics: { kind: "pop", areaPct: +(p.areaShare * 100).toFixed(1), sinceInputMs: p.sinceInputMs },
        }),
      );
    }
    for (const v of run.capture.vanishes ?? []) {
      out.push(
        makeFinding("MOT-10", {
          keyParts: [elementKey(v.el)],
          interaction: run.interaction,
          element: v.el,
          message: `${label(v.el)} (${(v.areaShare * 100).toFixed(1)}% of the viewport) disappeared in a single frame ${v.sinceInputMs} ms after the click, with no exit animation.`,
          metrics: { areaPct: +(v.areaShare * 100).toFixed(1), sinceInputMs: v.sinceInputMs },
          // the element is gone, so its CSS cannot be read; the handler that removed it can
          sourceKeys: [run.interaction.target.css],
          sourceParts: ["handler"],
        }),
      );
    }
  }
  return out;
}
