// Classify CSS easing functions by shape, so rules can ask "does this decelerate?"

export type EasingShape = "linear" | "accelerating" | "decelerating" | "symmetric" | "stepped" | "overshoot" | "unknown";

const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export function parseEasing(easing: string): [number, number, number, number] | "linear" | "steps" | null {
  const e = easing.trim().toLowerCase();
  if (e === "linear") return "linear";
  if (e.startsWith("steps(") || e === "step-start" || e === "step-end") return "steps";
  if (e.startsWith("linear(")) return null; // piecewise linear(), shape unknown without sampling
  if (KEYWORDS[e]) return KEYWORDS[e];
  const m = e.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** Progress of a cubic-bezier easing at time fraction x, by bisection on the x curve. */
export function bezierAt(p: [number, number, number, number], x: number): number {
  const [x1, y1, x2, y2] = p;
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

export function classifyEasing(easing: string): EasingShape {
  const p = parseEasing(easing);
  if (p === "linear") return "linear";
  if (p === "steps") return "stepped";
  if (!p) return "unknown";
  if (p[1] > 1.05 || p[3] > 1.05 || p[1] < -0.05 || p[3] < -0.05) return "overshoot";
  const mid = bezierAt(p, 0.5);
  if (mid < 0.42) return "accelerating";
  if (mid > 0.58) return "decelerating";
  return "symmetric";
}

/** Normalise an easing string so "ease-out" and "cubic-bezier(0, 0, 0.58, 1)" count once. */
export function normaliseEasing(easing: string): string {
  const p = parseEasing(easing);
  if (p === "linear") return "linear";
  if (Array.isArray(p)) return `cubic-bezier(${p.map((n) => +n.toFixed(3)).join(", ")})`;
  return easing.trim().toLowerCase().replace(/\s+/g, " ");
}
