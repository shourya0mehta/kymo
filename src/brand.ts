// The kymo mark: a kymograph drum with eyes. A kymograph records motion on smoked paper wrapped
// around a turning drum; the stylus scratches a trace through the soot. kymo's trace is its mouth,
// and it changes with the result: a smile when nothing is wrong, a pulse for warnings, jitter for errors.

export type Mood = "calm" | "busy" | "alarm";

/** Two media, both from the instrument: ink on recording paper (light), scratches on smoked paper (dark). */
export const PALETTE = {
  paper: "#F5F7F2",
  grid: "#D9E6DB",
  gridMajor: "#B9D0BE",
  ink: "#17233B",
  pencil: "#5B6577",
  red: "#C4302B",
  ochre: "#9C6106",
  soot: "#1E1A15",
  sootTop: "#463C30",
  scratch: "#F2EEE4",
  // dark
  smoke: "#16130F",
  smokeRaised: "#211D17",
  ash: "#A69E8F",
  scratchDark: "#ECE5D5",
  redDark: "#EE6B59",
  ochreDark: "#E0A847",
} as const;

const MOUTH: Record<Mood, string> = {
  calm: "M6 42.5 H24.5 Q31.5 50 38.5 42.5 H60",
  busy: "M6 42.5 H26.5 L29.6 36 L33.6 48 L36.6 41 H60",
  alarm: "M6 42.5 H17 L20 36.5 L23 48 L26 36.5 L29 48 L32 36.5 L35 48 L38 36.5 L41 47 L43.5 42.5 H60",
};

export interface MarkOptions {
  mood?: Mood;
  /** drum colour; the face (eyes and trace) uses `face` */
  body?: string;
  top?: string;
  face?: string;
  size?: number;
  title?: string;
  /** leave out the stylus and spindle (for 16 px favicons) */
  simple?: boolean;
  /** id prefix, so several marks can share one page */
  id?: string;
}

/** The mark as an SVG string. Defaults: soot drum for light backgrounds. */
export function markSvg(o: MarkOptions = {}): string {
  const body = o.body ?? PALETTE.soot;
  const top = o.top ?? PALETTE.sootTop;
  const face = o.face ?? PALETTE.scratch;
  const id = `${o.id ?? "kymo"}-drum`;
  const size = o.size ? ` width="${o.size}" height="${o.size}"` : "";
  const title = o.title ? `<title>${o.title}</title>` : "";
  const extras = o.simple
    ? ""
    : `<rect x="29.6" y="6" width="4.8" height="10" rx="1.2" fill="${body}"/><circle cx="32" cy="6" r="3.4" fill="${body}"/>` +
      `<path d="M60.5 30 L52.5 41.5" stroke="${body}" stroke-width="2.2" stroke-linecap="round"/><circle cx="60.5" cy="30" r="2.2" fill="${body}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${size} role="img" aria-label="${o.title ?? "kymo"}">${title}` +
    `<defs><clipPath id="${id}"><path d="M10 18 V50 A21 6.5 0 0 0 52 50 V18 Z"/></clipPath></defs>` +
    extras +
    `<path d="M10 18 V50 A21 6.5 0 0 0 52 50 V18 Z" fill="${body}"/>` +
    `<ellipse cx="32" cy="18" rx="21" ry="6.5" fill="${top}" stroke="${body}" stroke-width="1.6"/>` +
    `<circle cx="25.5" cy="31" r="2.8" fill="${face}"/><circle cx="38.5" cy="31" r="2.8" fill="${face}"/>` +
    `<g clip-path="url(#${id})"><path d="${MOUTH[o.mood ?? "busy"]}" fill="none" stroke="${face}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    `</svg>`
  );
}

/** The paper version, for dark backgrounds. */
export function markSvgPaper(o: MarkOptions = {}): string {
  return markSvg({ body: PALETTE.scratchDark, top: "#C9C0AD", face: PALETTE.smoke, ...o });
}

export function moodOf(counts: { error: number; warning: number; suggestion: number }): Mood {
  if (counts.error) return "alarm";
  if (counts.warning || counts.suggestion) return "busy";
  return "calm";
}
