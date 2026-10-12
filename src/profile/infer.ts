// Motion profiles for apps with no motion vocabulary yet.
// Numbers come from published design systems (see the research doc, "Motion from scratch").

export type ProfileName = "productive" | "expressive" | "calm" | "physical";

export interface ProfileTokens {
  name: ProfileName;
  label: string;
  durations: { sm: number; md: number; lg: number };
  ease: { enter: string; exit: string; move: string };
  spring: string;
  maxOvershoot: string;
  source: string;
}

export const PROFILES: Record<ProfileName, ProfileTokens> = {
  productive: {
    name: "productive",
    label: "Productive",
    durations: { sm: 70, md: 150, lg: 240 },
    ease: { enter: "cubic-bezier(0, 0, 0.38, 0.9)", exit: "cubic-bezier(0.2, 0, 1, 0.9)", move: "cubic-bezier(0.2, 0, 0.38, 0.9)" },
    spring: "damping ratio 0.9 at stiffness 1400 / 700 / 300; color and opacity at damping 1.0",
    maxOvershoot: "0.5%",
    source: "IBM Carbon productive tokens; Material 3 standard motion scheme",
  },
  expressive: {
    name: "expressive",
    label: "Expressive",
    durations: { sm: 240, md: 400, lg: 500 },
    ease: { enter: "cubic-bezier(0, 0, 0.3, 1)", exit: "cubic-bezier(0.4, 0.14, 1, 1)", move: "cubic-bezier(0.4, 0.14, 0.3, 1)" },
    spring: "damping ratio 0.8 at stiffness 380 and 200 (0.6 at 800 for small elements only); or Apple bounce 0.15 to 0.3",
    maxOvershoot: "5% (9.5% for small elements)",
    source: "IBM Carbon expressive tokens; Material 3 Expressive motion scheme; Apple WWDC23",
  },
  calm: {
    name: "calm",
    label: "Calm",
    durations: { sm: 150, md: 250, lg: 300 },
    ease: { enter: "cubic-bezier(0.25, 0.1, 0.25, 1)", exit: "cubic-bezier(0.33, 0, 0.67, 1)", move: "cubic-bezier(0.42, 0, 0.58, 1)" },
    spring: "none for movement; opacity at damping 1.0, stiffness 1600",
    maxOvershoot: "0%",
    source: "Shopify Polaris ease and ease-in-out; Microsoft Fluent durations and easyEase",
  },
  physical: {
    name: "physical",
    label: "Physical",
    durations: { sm: 150, md: 300, lg: 500 },
    ease: { enter: "cubic-bezier(0, 0, 0, 1)", exit: "cubic-bezier(0.3, 0, 1, 1)", move: "cubic-bezier(0.2, 0, 0, 1)" },
    spring: "tracking: response 0.15 s, damping 0.86; taps: bounce 0; flings: 80% damping with release velocity handed off",
    maxOvershoot: "0% on taps; 1.5% on flings",
    source: "Apple WWDC18 and WWDC23, SwiftUI interactiveSpring; Material 3 standard curves",
  },
};

export interface ProfileSignals {
  controlsInView: number;
  tables: number;
  keyListeners: number;
  proseShare: number; // 0..1
  longBlocks: number;
  imageShare: number; // 0..1 of the first viewport
  hero: boolean;
  displayHeading: boolean; // an h1 or h2 of 40 px or more in the first viewport
  serif: boolean;
  touchAction: boolean;
  draggable: number;
  pointerListeners: number;
}

export interface ProfileInference {
  profile: ProfileName;
  scores: Record<ProfileName, number>;
  reasons: string[];
  confident: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Score each profile from what the running app shows. Weak or tied evidence falls back to Productive. */
export function inferProfile(s: ProfileSignals): ProfileInference {
  const reasons: string[] = [];
  const scores: Record<ProfileName, number> = {
    productive: 2 * clamp(s.controlsInView / 10) + 2 * (s.tables > 0 ? 1 : 0) + 0.5 * (s.keyListeners > 0 ? 1 : 0),
    expressive: 2 * (s.hero ? 1 : 0) + 1.5 * (s.displayHeading ? 1 : 0) + 2 * clamp(s.imageShare / 0.3) + (s.controlsInView < 6 ? 0.5 : 0),
    calm: 2.5 * clamp(s.proseShare / 0.5) + clamp(s.longBlocks / 4) + (s.serif ? 1 : 0),
    physical: 2 * (s.touchAction ? 1 : 0) + 1.5 * clamp(s.draggable / 3) + 0.5 * (s.pointerListeners > 0 ? 1 : 0),
  };
  if (s.controlsInView >= 8) reasons.push(`${s.controlsInView} controls in the first viewport`);
  if (s.tables) reasons.push(`${s.tables} table or grid element(s)`);
  if (s.keyListeners) reasons.push("keyboard listeners on the page");
  if (s.hero) reasons.push("a tall hero section around the h1");
  if (s.displayHeading) reasons.push("a display-size heading (40 px or more) in the first viewport");
  if (s.imageShare > 0.15) reasons.push(`large imagery covers ${(s.imageShare * 100).toFixed(0)}% of the first viewport`);
  if (s.proseShare > 0.4) reasons.push(`${(s.proseShare * 100).toFixed(0)}% of the text is prose`);
  if (s.serif) reasons.push("a serif body font");
  if (s.touchAction) reasons.push("touch-action rules in the CSS");
  if (s.draggable) reasons.push(`${s.draggable} draggable element(s)`);

  reasons.push(
    `signals: ${s.controlsInView} controls in view, ${s.tables} tables, ${(s.proseShare * 100).toFixed(0)}% prose, ` +
      `${(s.imageShare * 100).toFixed(0)}% imagery, hero ${s.hero ? "yes" : "no"}, display heading ${s.displayHeading ? "yes" : "no"}, ` +
      `drag surfaces ${s.touchAction || s.draggable ? "yes" : "no"}`,
  );
  const ranked = (Object.entries(scores) as Array<[ProfileName, number]>).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const confident = top[1] >= 1.5 && top[1] - second[1] >= 0.5;
  const profile = confident ? top[0] : "productive";
  if (!confident) reasons.push("signals are weak or close, so the default (Productive) applies");
  return { profile, scores, reasons, confident };
}
