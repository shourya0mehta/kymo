import type { AnimationRecord, Finding, InteractionRun, MotionInventory, Thresholds } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../config.js";
import { classifyEasing, normaliseEasing } from "../util/easing.js";
import { elementKey, label, makeFinding, pageGroup } from "./finding.js";

const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset.*|margin.*|padding.*|grid-template-.*|font-size|border-.*-width)$/;
export const MOVEMENT = /^(transform|translate|scale|rotate|left|top|right|bottom|inset.*|offset-.*)$/;

const isInfinite = (a: AnimationRecord) => a.iterations === -1 || a.duration === -1 || !Number.isFinite(a.duration);
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
export function motionProbe(runs: InteractionRun[], t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const MAX_DURATION_MS = t.maxDurationMs;
  const out: Finding[] = [];
  for (const run of runs) {
    if (run.mode !== "normal" || !run.capture) continue;
    if (run.interaction.kind !== "click" && run.interaction.kind !== "type") continue;
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
export function sprawlProbe(inv: MotionInventory, t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const easings = inv.easings.filter((e) => e !== "linear");
  if (inv.durations.length <= t.sprawlDurations && easings.length <= t.sprawlEasings) return [];
  return [
    makeFinding("VIS-08", {
      keyParts: ["@app"],
      group: "@app",
      message: `The stylesheets declare ${inv.durations.length} distinct durations (${inv.durations.join(", ")} ms) and ${easings.length} distinct easing curves besides linear. Design systems get by with 4 to 6 durations and a few curves.`,
      metrics: { durations: inv.durations.length, easings: easings.length },
    }),
  ];
}

/** Is this a scroll reveal: a finite opacity or movement animation that started while scrolling? */
export function isReveal(a: AnimationRecord): boolean {
  if (isInfinite(a) || a.duration <= 0 || colourOnly(a)) return false;
  return a.props.some((p) => p === "opacity" || MOVEMENT.test(p));
}

/**
 * MOT-01 and MOT-03 for animations that scrolling starts (reveal-on-scroll). One finding per route
 * and rule, because reveals usually share one rule in the stylesheet.
 */
export function revealProbe(runs: InteractionRun[], t: Thresholds = DEFAULT_THRESHOLDS, already: Finding[] = []): Finding[] {
  const out: Finding[] = [];
  // an element whose animation a click already reported is not reported again for scrolling
  const covered = new Set(already.map((f) => `${f.rule}|${elementKey(f.element)}`));
  const fresh = (rule: string) => (a: AnimationRecord) => !covered.has(`${rule}|${elementKey(a.target)}`);
  for (const run of runs) {
    if (run.mode !== "normal" || run.interaction.kind !== "page" || !run.page) continue;
    const reveals = run.page.reveals.filter(isReveal);
    if (!reveals.length) continue;
    // Each reveal's own duration: a stagger of short fades is a different question from one slow one.
    const long = reveals.filter((a) => a.duration > t.maxDurationMs).filter(fresh("MOT-01"));
    if (long.length) {
      const worst = long.reduce((m, a) => (a.duration > m.duration ? a : m));
      const ms = Math.round(worst.duration);
      out.push(
        makeFinding("MOT-01", {
          keyParts: [run.interaction.key, "reveal"],
          interaction: run.interaction,
          element: worst.target,
          group: pageGroup(run.interaction.route, worst.target),
          message: `Scrolling reveals ${long.length} element(s) with animations up to ${ms} ms long (budget ${t.maxDurationMs} ms), such as ${label(worst.target)}. Readers wait for each section to finish arriving.`,
          metrics: { durationMs: ms, budgetMs: t.maxDurationMs, count: long.length, trigger: "scroll" },
        }),
      );
    }
    const bad = reveals.filter((a) => {
      const shape = classifyEasing(a.easing);
      return shape === "accelerating" || (shape === "linear" && movementProps(a).length > 0);
    }).filter(fresh("MOT-03"));
    if (bad.length) {
      const a = bad[0];
      const shape = classifyEasing(a.easing);
      out.push(
        makeFinding("MOT-03", {
          keyParts: [run.interaction.key, "reveal"],
          interaction: run.interaction,
          element: a.target,
          group: pageGroup(run.interaction.route, a.target),
          message: `${bad.length} scroll reveal(s) enter on ${shape === "linear" ? "a linear" : "an accelerating"} curve (${a.easing}), such as ${label(a.target)}. Entrances should decelerate.`,
          metrics: { easing: a.easing, shape, count: bad.length, trigger: "scroll" },
        }),
      );
    }
  }
  return out;
}
