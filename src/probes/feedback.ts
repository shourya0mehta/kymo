import type { Finding, InteractionRun, LongFrame, Thresholds } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../config.js";
import { label, makeFinding, targetInfo } from "./finding.js";

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

/**
 * Did the page cause this frame? A long frame with no blocking task, little script and little style
 * and layout is the browser waiting for the CPU (a busy CI runner), not something the app can fix.
 */
export function attributable(f: LongFrame): boolean {
  if (f.script == null && f.render == null) return true; // older captures: no breakdown, keep
  return f.blocking > 0 || (f.script ?? 0) >= 30 || (f.render ?? 0) >= 50;
}

/** The longest frame the page caused, if any reach the threshold. */
export function longest(frames: LongFrame[] | undefined, minMs: number): LongFrame | null {
  let best: LongFrame | null = null;
  for (const f of frames ?? []) if (f.duration >= minMs && attributable(f) && (!best || f.duration > best.duration)) best = f;
  return best;
}

/** Did this click get FEEL-01 or FEEL-03? Long frames on such clicks are reported there, not as FEEL-04. */
export function slowOrDead(run: InteractionRun, t: Thresholds): boolean {
  const { pressFeedback, feedbackMs } = feedbackLatency(run);
  if (feedbackMs == null) return !run.pixelsChanged;
  return feedbackMs > t.deadMs || (!pressFeedback && feedbackMs > t.feedbackMs);
}

/** FEEL-01 slow feedback and FEEL-03 dead clicks, from normal-mode clicks. Canvas apps are timed from screen frames. */
export function feedbackProbe(runs: InteractionRun[], t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  const canvas = new Map(runs.filter((r) => r.mode === "canvas").map((r) => [r.interaction.key, r]));
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture || run.interaction.kind !== "click") continue;
    const { pressFeedback, feedbackMs } = feedbackLatency(run);
    run.pressFeedback = pressFeedback;
    run.feedbackMs = feedbackMs;
    const target = targetInfo(run.interaction);
    const block = longest(run.capture.longFrames, t.longFrameMs);
    const blockNote = block ? ` A ${Math.round(block.duration)} ms frame blocked the page.` : "";

    // Nothing in the DOM changed but pixels did: feedback drawn on a canvas. Time it from screen frames.
    if (feedbackMs == null && run.pixelsChanged) {
      const px = canvas.get(run.interaction.key)?.pixelMs;
      if (px != null && px > t.feedbackMs) {
        out.push(
          makeFinding("FEEL-01", {
            keyParts: [run.interaction.key],
            interaction: run.interaction,
            element: target,
            message: `Clicking ${label(target)} took ${px} ms to change the picture (timed from screen frames; the page draws on a canvas).${blockNote}`,
            metrics: { feedbackMs: px, budgetMs: t.feedbackMs, timedFrom: "pixels" },
            sourceKeys: block ? ["@longframe"] : undefined,
          }),
        );
      }
      continue;
    }
    if (feedbackMs == null || feedbackMs > t.deadMs) {
      out.push(
        makeFinding("FEEL-03", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: target,
          message: `Clicking ${label(target)} changed nothing on screen within ${t.deadMs} ms.${blockNote}`,
          metrics: { feedbackMs },
          sourceKeys: block ? ["@longframe"] : undefined,
        }),
      );
    } else if (!pressFeedback && feedbackMs > t.feedbackMs) {
      out.push(
        makeFinding("FEEL-01", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: target,
          message: `Clicking ${label(target)} took ${feedbackMs} ms to show any change, with no pressed state while held.${blockNote}`,
          metrics: { feedbackMs, budgetMs: t.feedbackMs, longFrameMs: block ? Math.round(block.duration) : null },
          sourceKeys: block ? ["@longframe"] : undefined,
        }),
      );
    }
  }
  return out;
}
