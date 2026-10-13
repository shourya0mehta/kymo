import type { AnimationRecord, Finding, InteractionRun } from "../types.js";
import { elementKey, label, makeFinding } from "./finding.js";
import { movementProps } from "./motion.js";

/**
 * A short transform on the control itself (a 0.97 scale while pressed) is press feedback, not motion
 * that can make anyone dizzy. It neither earns a reduced-motion rerun nor counts as MOT-06.
 */
export function isPressFeedback(a: AnimationRecord, run: InteractionRun): boolean {
  return !!a.target && a.target.css === run.interaction.target.css && a.duration <= 200 && a.iterations !== -1;
}

/** Did the normal run move anything? Only those interactions get a reduced-motion rerun. */
export function hasMovement(run: InteractionRun): boolean {
  return !!run.capture?.animations.some((a) => a.duration > 0 && movementProps(a).length > 0 && !isPressFeedback(a, run));
}

/** MOT-06: movement that still runs with prefers-reduced-motion: reduce. */
export function reducedMotionProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "reduced-motion" || !run.capture) continue;
    for (const a of run.capture.animations) {
      const moving = movementProps(a);
      // a 1 ms animation is the usual way to switch motion off under reduced motion; anything under 50 ms is instant
      if (!moving.length || a.duration < 50) continue;
      if (a.iterations === -1 && /spin|rotat|load/i.test(a.name ?? "")) continue; // spinners are allowed
      if (isPressFeedback(a, run)) continue;
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
