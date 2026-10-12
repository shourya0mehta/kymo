import type { AnimationRecord, Finding, InteractionRun, MotionInventory } from "../types.js";
import { classifyEasing, normaliseEasing } from "../util/easing.js";
import { elementKey, label, makeFinding } from "./finding.js";

export const MAX_DURATION_MS = 500;
export const SPRAWL_DURATIONS = 8;
export const SPRAWL_EASINGS = 5;

const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset.*|margin.*|padding.*|grid-template-.*|font-size|border-.*-width)$/;
export const MOVEMENT = /^(transform|translate|scale|rotate|left|top|right|bottom|inset.*|offset-.*)$/;

const isInfinite = (a: AnimationRecord) => a.iterations === -1 || a.duration === -1;
const rotationOnly = (a: AnimationRecord) =>
  a.props.length > 0 && a.props.every((p) => p === "rotate" || p === "transform") && /spin|rotat|load/i.test(a.name ?? "");

const COLOUR = /^(color|background(-color)?|border(-\w+)?-color|outline-color|fill|stroke|text-decoration-color|caret-color|accent-color|filter|box-shadow|text-shadow)$/;
export function colourOnly(a: AnimationRecord): boolean {
  return a.props.length > 0 && a.props.every((p) => COLOUR.test(p));
}

export function movementProps(a: AnimationRecord): string[] {
  return a.props.filter((p) => MOVEMENT.test(p));
}

/** MOT-01 long animations, MOT-03 easing that does not fit, MOT-08 layout-property animation. */
export function motionProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture) continue;
    // group transitions on the same element so one element yields one finding per rule
    const byTarget = new Map<string, AnimationRecord[]>();
    for (const a of run.capture.animations) {
      const k = a.target?.css ?? "?";
      if (!byTarget.has(k)) byTarget.set(k, []);
      byTarget.get(k)!.push(a);
    }
    for (const anims of byTarget.values()) {
      const el = anims[0].target;
      // Duration and easing judge motion the click caused. Animations that start after the click
      // scrolled the page (reveals, scroll-linked bars) belong to scroll, so they are skipped here.
      // Layout-property animation (MOT-08) is about the CSS, so it still counts them.
      const finite = anims.filter((a) => !isInfinite(a) && !a.afterScroll);
      // A long colour crossfade (a theme or sky change) neither moves anything nor blocks input.
      const timed = finite.filter((a) => !colourOnly(a));
      const longest = timed.reduce((m, a) => Math.max(m, a.duration + a.delay), 0);
      if (longest > MAX_DURATION_MS) {
        out.push(
          makeFinding("MOT-01", {
            keyParts: [elementKey(el)],
            interaction: run.interaction,
            element: el,
            message: `${label(el)} animates for ${Math.round(longest)} ms after the click (budget ${MAX_DURATION_MS} ms).`,
            metrics: { durationMs: Math.round(longest), budgetMs: MAX_DURATION_MS },
          }),
        );
      }

      const enterAccel = finite.find((a) => a.enter && classifyEasing(a.easing) === "accelerating");
      const linearMove = finite.find((a) => movementProps(a).length > 0 && classifyEasing(a.easing) === "linear" && !rotationOnly(a));
      if (enterAccel || linearMove) {
        const a = (enterAccel ?? linearMove)!;
        const why = enterAccel
          ? `enters on an accelerating curve (${a.easing})`
          : `moves (${movementProps(a).join(", ")}) on a linear curve`;
        out.push(
          makeFinding("MOT-03", {
            keyParts: [elementKey(el)],
            interaction: run.interaction,
            element: el,
            message: `${label(el)} ${why}.`,
            metrics: { easing: a.easing, shape: classifyEasing(a.easing), role: enterAccel ? "enter" : "move" },
          }),
        );
      }

      const layoutProps = [...new Set(anims.flatMap((a) => a.props.filter((p) => LAYOUT.test(p))))];
      const all = anims.some((a) => a.transitionAll);
      if (layoutProps.length || all) {
        const what = [layoutProps.length ? `animates ${layoutProps.join(", ")}` : "", all ? "uses transition: all" : ""]
          .filter(Boolean)
          .join(" and ");
        out.push(
          makeFinding("MOT-08", {
            keyParts: [elementKey(el)],
            interaction: run.interaction,
            element: el,
            message: `${label(el)} ${what}.`,
            metrics: { layoutProps: layoutProps.join(", ") || null, transitionAll: all },
          }),
        );
      }
    }
  }
  return out;
}

/**
 * The app's motion inventory. VIS-08 counts only what stylesheets declare, so a full run and a
 * targeted (--only) run see the same numbers. Values seen running are listed separately.
 */
export function buildInventory(
  runs: InteractionRun[],
  style: { durations: Record<string, number>; easings: Record<string, number>; reducedQuery: boolean },
): MotionInventory {
  const durations: Record<string, number> = { ...style.durations };
  const easings: Record<string, number> = {};
  for (const [e, n] of Object.entries(style.easings)) {
    const k = normaliseEasing(e);
    easings[k] = (easings[k] ?? 0) + n;
  }
  const rtDur = new Set<number>();
  const rtEase = new Set<string>();
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture) continue;
    for (const a of run.capture.animations) {
      if (a.iterations === -1) continue; // spinners and loops are not UI transitions
      const d = Math.round(a.declaredDuration > 0 ? a.declaredDuration : a.duration);
      if (d > 0) rtDur.add(d);
      rtEase.add(normaliseEasing(a.easing));
    }
  }
  return {
    durations: Object.keys(durations).map(Number).sort((a, b) => a - b),
    easings: Object.keys(easings).sort(),
    runtime: { durations: [...rtDur].sort((a, b) => a - b), easings: [...rtEase].sort() },
    sources: { durations, easings },
    hasReducedMotionQuery: style.reducedQuery,
  };
}

/** VIS-08: too many distinct motion values. */
export function sprawlProbe(inv: MotionInventory): Finding[] {
  const easings = inv.easings.filter((e) => e !== "linear");
  if (inv.durations.length <= SPRAWL_DURATIONS && easings.length <= SPRAWL_EASINGS) return [];
  return [
    makeFinding("VIS-08", {
      keyParts: ["@app"],
      group: "@app",
      message: `The stylesheets declare ${inv.durations.length} distinct durations (${inv.durations.join(", ")} ms) and ${easings.length} distinct easing curves besides linear. Design systems get by with 4 to 6 durations and a few curves.`,
      metrics: { durations: inv.durations.length, easings: easings.length },
    }),
  ];
}
