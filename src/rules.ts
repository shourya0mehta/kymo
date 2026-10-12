import type { Evidence, Severity } from "./types.js";

/**
 * The rule registry. Every rule here traces back to a row in the research doc
 * ("Interface feel: principles and probes"). Severity follows evidence strength:
 * specs and studies can warn or error, practitioner taste only suggests.
 */
export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  evidence: Evidence;
  threshold: string;
  why: string;
  fix: string;
  source: string;
}

export const RULES: Record<string, Rule> = {
  "FEEL-01": {
    id: "FEEL-01",
    title: "Slow feedback after a click",
    severity: "warning",
    evidence: "Study",
    threshold: "No visible change within 100 ms of the click, and no pressed state",
    why: "Cause and effect stop feeling linked somewhere between 100 and 200 ms (Michotte; Card, Moran and Newell).",
    fix: "Acknowledge the click in the next frame: a pressed style on :active, an optimistic update, or a pending state that appears immediately. Keep the slow work, but stop making the user wait to see that the click landed.",
    source: "https://web.dev/articles/defining-core-web-vitals-thresholds",
  },
  "FEEL-03": {
    id: "FEEL-03",
    title: "Dead click",
    severity: "warning",
    evidence: "Practitioner (RUM vendor rules)",
    threshold: "Nothing on screen changes within 1 s of the click",
    why: "Users who see no response click again; every frustration-signal vendor treats this as a defect. A dead click is a bug whatever the exact window.",
    fix: "Either wire the control up or make it look and behave like it is not interactive (no button role, no pointer cursor). If it is disabled on purpose, say why next to it.",
    source: "https://docs.datadoghq.com/real_user_monitoring/application_monitoring/browser/frustration_signals/",
  },
  "MOT-01": {
    id: "MOT-01",
    title: "Animation runs too long",
    severity: "warning",
    evidence: "Standard + Practitioner",
    threshold: "A finite UI animation longer than 500 ms",
    why: "Design systems keep routine motion between 50 and 500 ms; NN/g says 500 ms starts to feel like a drag, and Baudisch found long animations force waits.",
    fix: "Use the motion profile's large duration token (240 to 500 ms) or smaller. Exits can be shorter than entrances.",
    source: "https://www.nngroup.com/articles/animation-duration/",
  },
  "MOT-03": {
    id: "MOT-03",
    title: "Easing does not fit the motion",
    severity: "warning",
    evidence: "Study + Standard",
    threshold: "An entering element that accelerates (ease-in), or movement on a linear curve",
    why: "Every major design system decelerates entrances and keeps linear for spinners; slow-in/slow-out helps people track moving objects (Dragicevic 2011).",
    fix: "Entrances use the profile's enter curve (decelerating), exits the exit curve (accelerating), on-screen moves the move curve. Linear is only for continuous rotation.",
    source: "https://inria.hal.science/inria-00556177v2",
  },
  "MOT-06": {
    id: "MOT-06",
    title: "Movement ignores reduced motion",
    severity: "warning",
    evidence: "Standard (WCAG 2.3.3, AAA)",
    threshold: "Translate, scale or position animations still run with prefers-reduced-motion: reduce",
    why: "Motion triggered by interaction can cause dizziness and nausea for people with vestibular disorders; the setting means remove, reduce or replace.",
    fix: "Inside @media (prefers-reduced-motion: reduce), drop the movement and keep at most a short crossfade (about 200 ms or less).",
    source: "https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html",
  },
  "MOT-08": {
    id: "MOT-08",
    title: "Animating layout properties",
    severity: "warning",
    evidence: "Standard",
    threshold: "Animating width, height, top, left, margin or padding, or transition: all",
    why: "Layout properties force layout and paint every frame and stutter under load; transition: all silently animates them.",
    fix: "Animate transform and opacity instead (FLIP or the View Transitions API for size and position changes). Replace transition: all with an explicit property list.",
    source: "https://web.dev/articles/animations-guide",
  },
  "MOT-09": {
    id: "MOT-09",
    title: "Teleport or pop with no transition",
    severity: "suggestion",
    evidence: "Study (design paper) + proposal",
    threshold: "An element jumps more than 24 px in one frame, or something bigger than 2% of the viewport appears fully formed within 150 ms of the click",
    why: "People track change through continuity (Chang and Ungar 1993; Heer and Robertson 2007). Thresholds are unvalidated starting points.",
    fix: "Give the state change a short transform/opacity transition with the profile's tokens. Keyboard-driven and very frequent actions should stay instant.",
    source: "https://bibliography.selflanguage.org/_static/animation.pdf",
  },
  "WAIT-01": {
    id: "WAIT-01",
    title: "No pending state on a slow request",
    severity: "warning",
    evidence: "Practitioner + Study",
    threshold: "With the request held for 3 s, nothing changes on screen for more than 1 s after the click",
    why: "Any indicator beats a blank wait (Myers 1985); unexplained waits feel longer.",
    fix: "Show a pending state right away: disable the control with aria-busy and a label like Saving..., or update optimistically and roll back on failure.",
    source: "https://www.cs.cmu.edu/~bam/papers/percentdoneCHI85.pdf",
  },
  "CRAFT-07": {
    id: "CRAFT-07",
    title: "Failure is silent or blank",
    severity: "warning",
    evidence: "Standard (AA) + Practitioner",
    threshold: "With the request answered by a 500, no error text, alert or recovery appears, or the content goes blank",
    why: "Errors should appear near their source, be specific, and be announced (WCAG 4.1.3 status messages; NN/g error guidelines).",
    fix: "Render an error next to the control with role=alert, say what failed and offer a retry. Keep existing content on screen instead of clearing it.",
    source: "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html",
  },
  "VIS-08": {
    id: "VIS-08",
    title: "Motion token sprawl",
    severity: "suggestion",
    evidence: "Practitioner",
    threshold: "More than 8 distinct durations or more than 5 distinct easing curves in use",
    why: "Design systems converge on 4 to 6 durations and a few curves; drift shows up as many one-off values.",
    fix: "Adopt a motion profile (kymo profile --write) and move every transition onto its tokens.",
    source: "https://carbondesignsystem.com/elements/motion/overview/",
  },
};

export function rule(id: string): Rule {
  const r = RULES[id];
  if (!r) throw new Error(`Unknown rule ${id}`);
  return r;
}
