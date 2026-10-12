import type { Finding, InteractionRun } from "../types.js";
import { elementKey, label, makeFinding } from "./finding.js";
import { movementProps } from "./motion.js";

/** Did the normal run move anything? Only those interactions get a reduced-motion rerun. */
export function hasMovement(run: InteractionRun): boolean {
  return !!run.capture?.animations.some((a) => a.duration > 0 && movementProps(a).length > 0);
}

/** MOT-06: movement that still runs with prefers-reduced-motion: reduce. */
export function reducedMotionProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "reduced-motion" || !run.capture) continue;
    for (const a of run.capture.animations) {
      const moving = movementProps(a);
      if (!moving.length || a.duration <= 0) continue;
      if (a.iterations === -1 && /spin|rotat|load/i.test(a.name ?? "")) continue; // spinners are allowed
      out.push(
        makeFinding("MOT-06", {
          keyParts: [elementKey(a.target)],
          interaction: run.interaction,
          element: a.target,
          message: `With reduced motion turned on, ${label(a.target)} still animates ${moving.join(", ")} for ${Math.round(a.duration)} ms.`,
          metrics: { props: moving.join(", "), durationMs: Math.round(a.duration) },
        }),
      );
    }
  }
  return out;
}
