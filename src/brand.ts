// The kymo mark: a kymograph drum with eyes and feet, drawn on a 16 by 16 pixel grid.
// A kymograph records motion as a line traced around a turning drum. kymo's line is its mouth,
// and it changes with the result: a smile when nothing is wrong, a pulse for warnings,
// a jagged trace for errors.

export type Mood = "calm" | "busy" | "alarm";

/** Brand tokens. Light is the primary theme; dark redefines the same names. */
export const PALETTE = {
  cobalt: "#2E46F0", // the mascot, links, the pen
  cobaltText: "#2438D6", // cobalt dark enough for small text on paper
  cobaltOnDark: "#8A9BFF",
  paper: "#F3F4F7",
  surface: "#FFFFFF",
  ink: "#12141C",
  muted: "#5A6072",
  line: "#DCDFE8",
  grid: "#E6E8EF",
  red: "#E0393E", // over budget, errors
  amber: "#B97800", // warnings
  green: "#178A5B", // kept, within budget
  // dark
  night: "#0E1016",
  nightSurface: "#161922",
  nightInk: "#E8EAF2",
  nightMuted: "#9AA1B4",
  nightLine: "#272B37",
  nightGrid: "#1C202A",
  redOnDark: "#FF6B6E",
  amberOnDark: "#F2B544",
  greenOnDark: "#3CCB8C",
} as const;

/** '#' body, 'o' face, '.' empty. Rows 9 to 12 are the mouth and change with the mood. */
const BODY = [
  "................",
  "...##########...",
  "..############..",
  ".##############.",
  ".###oo####oo###.",
  ".###oo####oo###.",
  ".###oo####oo###.",
  ".##############.",
  ".##############.",
  "MOUTH",
  "MOUTH",
  "MOUTH",
  "MOUTH",
  "..############..",
  "...##......##...",
  "...##......##...",
];

const MOUTHS: Record<Mood, string[]> = {
  calm: [".##############.", ".#oo########oo#.", ".###o######o###.", ".####oooooo####."],
  busy: [".######o#######.", ".#ooooo#o##ooo#.", ".########o#o###.", ".#########o####."],
  alarm: [".###o###o###o##.", ".#oo#o#o#o#o#o#.", ".#####o###o###o.", ".##############."],
};

/** The pixel grid for a mood; `blink` closes the eyes to a slit, `look` shifts the pupils sideways. */
export function mascotGrid(mood: Mood = "busy", opts: { blink?: boolean; look?: -1 | 0 | 1 } = {}): string[] {
  let mouth = 0;
  const rows = BODY.map((r) => (r === "MOUTH" ? MOUTHS[mood][mouth++] : r));
  if (opts.blink) {
    rows[4] = rows[4].replace(/o/g, "#");
    rows[6] = rows[6].replace(/o/g, "#");
  }
  if (opts.look) {
    for (const i of [4, 5, 6]) {
      if (!rows[i].includes("o")) continue;
      const r = rows[i].replace(/o/g, "#").split("");
      for (const c of [4, 5, 10, 11]) r[c + opts.look] = "o";
      rows[i] = r.join("");
    }
  }
  return rows;
}

/** Merge each row's runs of one character into a single SVG path. */
export function gridPath(grid: string[], ch: string, unit = 4): string {
  let d = "";
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== ch) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] === ch) w++;
      d += `M${x * unit} ${y * unit}h${w * unit}v${unit}h${-w * unit}z`;
      x += w;
    }
  });
  return d;
}

export interface MarkOptions {
  mood?: Mood;
  body?: string;
  face?: string;
  size?: number;
  title?: string;
  blink?: boolean;
  /** extra attributes on the root svg element, e.g. a class */
  attrs?: string;
}

/** The mark as an SVG string: flat cobalt body, white face, crisp pixel edges. */
export function markSvg(o: MarkOptions = {}): string {
  const grid = mascotGrid(o.mood ?? "busy", { blink: o.blink });
  const size = o.size ? ` width="${o.size}" height="${o.size}"` : "";
  const label = o.title ?? "kymo";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${size} shape-rendering="crispEdges" role="img" aria-label="${label}"${o.attrs ? ` ${o.attrs}` : ""}>` +
    `<title>${label}</title>` +
    `<path d="${gridPath(grid, "#")}" fill="${o.body ?? PALETTE.cobalt}"/>` +
    `<path d="${gridPath(grid, "o")}" fill="${o.face ?? "#FFFFFF"}"/>` +
    `</svg>`
  );
}

export function moodOf(counts: { error: number; warning: number; suggestion: number }): Mood {
  if (counts.error) return "alarm";
  if (counts.warning || counts.suggestion) return "busy";
  return "calm";
}

/** A compact 10 by 8 version for terminals, drawn with half blocks: 10 columns, 4 lines. */
const TERMINAL: Record<Mood, string[]> = {
  busy: [".########.", "##########", "##oo##oo##", "##oo##oo##", "##########", "#oooo#ooo#", "#####o####", ".##....##."],
  calm: [".########.", "##########", "##oo##oo##", "##oo##oo##", "##########", "#o######o#", "##oooooo##", ".##....##."],
  alarm: [".########.", "##########", "##oo##oo##", "##oo##oo##", "##########", "#o#o#o#o##", "##o#o#o#o#", ".##....##."],
};

/**
 * The terminal creature. With colour, face pixels are white and the body cobalt (24-bit when the
 * terminal says it supports it, 256-colour otherwise). Without colour, the face shows as gaps.
 */
export function terminalMascot(mood: Mood = "busy", color = true, truecolor = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit"): string[] {
  const g = TERMINAL[mood];
  const fg = (c: string) => (c === "#" ? (truecolor ? "38;2;46;70;240" : "38;5;63") : "38;5;231");
  const bg = (c: string) => (c === "#" ? (truecolor ? "48;2;46;70;240" : "48;5;63") : "48;5;231");
  const out: string[] = [];
  for (let y = 0; y < g.length; y += 2) {
    let line = "";
    for (let x = 0; x < g[y].length; x++) {
      const top = g[y][x], bot = g[y + 1]?.[x] ?? ".";
      if (!color) {
        const t = top === "#", b = bot === "#";
        line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
        continue;
      }
      if (top === "." && bot === ".") line += " ";
      else if (top === bot) line += `\x1b[${fg(top)}m█\x1b[0m`;
      else if (bot === ".") line += `\x1b[${fg(top)}m▀\x1b[0m`;
      else if (top === ".") line += `\x1b[${fg(bot)}m▄\x1b[0m`;
      else line += `\x1b[${fg(top)};${bg(bot)}m▀\x1b[0m`;
    }
    out.push(line);
  }
  return out;
}
