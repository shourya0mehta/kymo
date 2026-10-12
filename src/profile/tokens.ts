import type { ProfileInference, ProfileTokens } from "./infer.js";

/** CSS custom properties for a motion profile, with a reduced-motion block. */
export function renderTokensCss(p: ProfileTokens, inference?: ProfileInference): string {
  const why = inference?.reasons.length ? inference.reasons.map((r) => ` *   - ${r}`).join("\n") : " *   - chosen by hand";
  return `/*
 * Motion tokens: ${p.label} profile (written by kymo, approve before use)
 * Source: ${p.source}
 * Why this profile:
${why}
 * Springs, if the app uses a spring library: ${p.spring}
 * Max overshoot: ${p.maxOvershoot}
 *
 * Use sm for small state changes (toggles, presses), md for menus, toasts and panels,
 * lg for dialogs and large surfaces. Enter decelerates, exit accelerates, move does both.
 * Keyboard-triggered and very frequent actions should not animate at all.
 */
:root {
  --motion-duration-sm: ${p.durations.sm}ms;
  --motion-duration-md: ${p.durations.md}ms;
  --motion-duration-lg: ${p.durations.lg}ms;
  --motion-ease-enter: ${p.ease.enter};
  --motion-ease-exit: ${p.ease.exit};
  --motion-ease-move: ${p.ease.move};
  --motion-distance: 1; /* multiply translate distances by this */
}

/*
 * Reduced motion: no movement, at most a short crossfade. Distances collapse to 0 when written as
 * calc(16px * var(--motion-distance)); transforms written without it still need their own
 * @media (prefers-reduced-motion: reduce) rule. Colour and opacity changes may stay.
 */
@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-duration-md: ${Math.min(150, p.durations.md)}ms;
    --motion-duration-lg: ${Math.min(200, p.durations.lg)}ms;
    --motion-distance: 0;
  }
}
`;
}

export function renderTokensJson(p: ProfileTokens, inference?: ProfileInference): string {
  return JSON.stringify(
    {
      profile: p.name,
      durations: p.durations,
      ease: p.ease,
      spring: p.spring,
      maxOvershoot: p.maxOvershoot,
      source: p.source,
      inferredFrom: inference?.reasons ?? [],
      scores: inference?.scores,
    },
    null,
    2,
  ) + "\n";
}
