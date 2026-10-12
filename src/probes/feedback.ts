import type { Finding, InteractionRun } from "../types.js";
import { label, makeFinding, targetInfo } from "./finding.js";

export const FEEDBACK_MS = 100;
export const DEAD_MS = 1000;

/**
 * Feedback latency for one press. If something changed while the button was held down,
 * that is press feedback and latency counts from pointerdown. Otherwise latency counts
 * from the click (release), which is when ordinary click handlers run.
 */
export function feedbackLatency(run: InteractionRun): { pressFeedback: boolean; feedbackMs: number | null } {
  const c = run.capture;
  if (!c || c.downAt == null || c.firstChangeAt == null) return { pressFeedback: false, feedbackMs: null };
  const whileDown = c.changeWhileDown ?? (c.upAt != null && c.firstChangeAt <= c.upAt);
  if (whileDown) {
    return { pressFeedback: true, feedbackMs: Math.max(0, Math.round(c.firstChangeAt - c.downAt)) };
  }
  const from = c.clickAt ?? c.upAt ?? c.downAt;
  return { pressFeedback: false, feedbackMs: Math.max(0, Math.round(c.firstChangeAt - from)) };
}

/** FEEL-01 slow feedback and FEEL-03 dead clicks, from normal-mode runs. */
export function feedbackProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture) continue;
    const { pressFeedback, feedbackMs } = feedbackLatency(run);
    run.pressFeedback = pressFeedback;
    run.feedbackMs = feedbackMs;
    const target = targetInfo(run.interaction);
    // Nothing in the DOM changed but pixels did: feedback drawn on a canvas. Not dead, not measurable.
    if (feedbackMs == null && run.pixelsChanged) continue;
    if (feedbackMs == null || feedbackMs > DEAD_MS) {
      out.push(
        makeFinding("FEEL-03", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: target,
          message: `Clicking ${label(target)} changed nothing on screen within ${DEAD_MS} ms.`,
          metrics: { feedbackMs },
        }),
      );
    } else if (!pressFeedback && feedbackMs > FEEDBACK_MS) {
      out.push(
        makeFinding("FEEL-01", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: target,
          message: `Clicking ${label(target)} took ${feedbackMs} ms to show any change, with no pressed state while held.`,
          metrics: { feedbackMs, budgetMs: FEEDBACK_MS },
        }),
      );
    }
  }
  return out;
}
