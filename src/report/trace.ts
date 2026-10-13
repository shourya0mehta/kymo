// Kymograms: SVG drawings of what happened over time, in the style of a recording drum.
// Colours come from CSS variables, so the same markup works on paper (light) and smoke (dark).
import type { AnimationRecord, AuditResult, Finding, InteractionRun, MotionInventory, Severity } from "../types.js";
import { feedbackLatency } from "../probes/feedback.js";
import { bezierAt, parseEasing } from "../util/easing.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface Timeline {
  /** all times in ms from the press (or keydown) */
  release: number | null;
  click: number | null;
  change: number | null;
  pressFeedback: boolean;
  /** when the budget runs out: from the press if it acknowledged the press, else from the click */
  budgetAt: number;
  anims: { from: number; to: number; label: string; moving: boolean; loop: boolean }[];
  frames: { from: number; to: number }[];
  /** canvas runs: no DOM timeline, only pixels */
  pixelOnly?: boolean;
}

const MOVING = /^(transform|translate|scale|rotate|left|top|right|bottom|inset|width|height|margin|padding)/;

export function timeline(run: InteractionRun, budgetMs: number): Timeline | null {
  const c = run.capture;
  if (!c || c.downAt == null) return null;
  const t0 = c.downAt;
  const rel = (t: number | null | undefined) => (t == null ? null : Math.max(0, t - t0));
  const fb = run.interaction.kind === "click" ? feedbackLatency(run) : { pressFeedback: false, feedbackMs: null };
  const click = rel(c.clickAt ?? c.upAt);
  const anims = (c.animations ?? [])
    .filter((a: AnimationRecord) => a.duration !== 0 || a.delay !== 0)
    .slice(0, 6)
    .map((a) => {
      const start = Math.max(0, a.t - t0) + Math.max(0, a.delay);
      const loop = a.iterations === -1 || a.duration < 0;
      const dur = loop ? 2000 : a.duration * Math.max(1, a.iterations || 1);
      const props = a.props.filter((p) => p !== "transition-behavior").slice(0, 2).join(", ") || a.prop || "animation";
      return { from: start, to: start + dur, label: `${props} ${loop ? "loop" : `${Math.round(a.duration)} ms`}`, moving: a.props.some((p) => MOVING.test(p)), loop };
    });
  const frames = (c.longFrames ?? []).filter((f) => f.duration >= 50).map((f) => ({ from: Math.max(0, f.start - t0), to: Math.max(0, f.start - t0) + f.duration }));
  let change = rel(c.firstChangeAt);
  let pixelOnly = false;
  if (change == null && run.mode === "canvas" && run.pixelMs != null) {
    change = (click ?? 0) + run.pixelMs;
    pixelOnly = true;
  }
  return {
    release: rel(c.upAt),
    click,
    change,
    pressFeedback: fb.pressFeedback,
    budgetAt: fb.pressFeedback ? budgetMs : (click ?? 0) + budgetMs,
    anims,
    frames,
    pixelOnly,
  };
}

function grid(x0: number, y0: number, x1: number, y1: number, xStep: number, yStep: number, majorEvery = 5): string {
  let minor = "", major = "";
  let k = 0;
  for (let x = x0; x <= x1 + 0.01; x += xStep, k++) (k % majorEvery ? (minor += `M${r1(x)} ${y0}V${y1}`) : (major += `M${r1(x)} ${y0}V${y1}`));
  k = 0;
  for (let y = y1; y >= y0 - 0.01; y -= yStep, k++) (k % majorEvery ? (minor += `M${x0} ${r1(y)}H${x1}`) : (major += `M${x0} ${r1(y)}H${x1}`));
  return `<path class="g" d="${minor}"/><path class="G" d="${major}"/>`;
}

/**
 * One interaction as a kymogram: the stylus sits flat until the screen first changes, then
 * steps up. Waiting past the budget is drawn in red. Animations run as bars underneath; long
 * frames are hatched across the top.
 */
export function interactionTrace(run: InteractionRun, opts: { budgetMs?: number; width?: number; id?: string } = {}): string {
  const budget = opts.budgetMs ?? 100;
  const tl = timeline(run, budget);
  if (!tl) return "";
  const W = opts.width ?? 680;
  const lanes = Math.min(4, tl.anims.length);
  const plotTop = 22, low = 64, high = 34, lanesTop = 88;
  const H = lanesTop + lanes * 12 + 26;
  const pad = 10;
  const ends = [tl.change ?? 0, tl.budgetAt + 60, ...tl.anims.filter((a) => !a.loop).map((a) => a.to), ...tl.frames.map((f) => f.to)];
  const T = Math.min(1600, Math.max(600, Math.ceil((Math.max(...ends) + 120) / 100) * 100));
  const x = (ms: number) => pad + (Math.min(ms, T) / T) * (W - 2 * pad);
  const id = opts.id ?? "t";
  const kind = run.interaction.kind;
  const parts: string[] = [];
  parts.push(grid(pad, plotTop - 8, W - pad, H - 18, (W - 2 * pad) / (T / 20), 6));
  // long frames
  for (const f of tl.frames) {
    parts.push(`<rect class="lf" x="${r1(x(f.from))}" y="${plotTop - 8}" width="${r1(Math.max(2, x(f.to) - x(f.from)))}" height="${H - 18 - plotTop + 8}" fill="url(#${id}-hatch)"/>`);
    if (x(f.to) - x(f.from) > 70) parts.push(`<text class="lbl red" x="${r1(x(f.from) + 4)}" y="${plotTop - 12}">long frame ${Math.round(f.to - f.from)} ms</text>`);
  }
  // budget
  parts.push(`<path class="budget" d="M${r1(x(tl.budgetAt))} ${plotTop - 8}V${H - 18}"/>`);
  parts.push(`<text class="lbl red" x="${r1(x(tl.budgetAt) + 4)}" y="${H - 6}">${budget} ms budget</text>`);
  // the stylus
  const ch = tl.change;
  if (ch == null) {
    parts.push(`<path class="pen" d="M${x(0)} ${low}H${r1(x(tl.budgetAt))}"/>`);
    parts.push(`<path class="pen red" d="M${r1(x(tl.budgetAt))} ${low}H${r1(x(T))}"/>`);
    parts.push(`<text class="lbl red" x="${r1(x(T) - 4)}" y="${low - 8}" text-anchor="end">no visible change</text>`);
  } else {
    const late = ch > tl.budgetAt;
    if (late) {
      parts.push(`<path class="pen" d="M${x(0)} ${low}H${r1(x(tl.budgetAt))}"/>`);
      parts.push(`<path class="pen red" d="M${r1(x(tl.budgetAt))} ${low}H${r1(x(ch))}"/>`);
    } else parts.push(`<path class="pen" d="M${x(0)} ${low}H${r1(x(ch))}"/>`);
    parts.push(`<path class="pen" d="M${r1(x(ch))} ${low}L${r1(x(ch) + 3)} ${high}H${r1(x(T))}"/>`);
    const what = tl.pixelOnly ? "pixels changed" : kind === "type" ? "letter shown" : "screen changed";
    // say it the way the finding does: from the key, from the press while held, or from the release
    const when =
      kind === "type" ? `${Math.round(ch)} ms after the key`
      : tl.pressFeedback ? `while held, ${Math.round(ch)} ms after the press`
      : `${Math.round(ch - (tl.click ?? 0))} ms after the release`;
    const anchor = x(ch) > W - 230 ? "end" : "start";
    parts.push(`<text class="lbl${late ? " red" : ""}" x="${r1(x(ch) + (anchor === "end" ? -6 : 8))}" y="${high - 7}" text-anchor="${anchor}">${what} ${when}</text>`);
  }
  // press and release
  parts.push(`<path class="tick" d="M${x(0)} ${low + 4}V${low + 9}"/><text class="lbl" x="${x(0)}" y="${low + 20}">${kind === "type" ? "key" : "press"}</text>`);
  if (tl.release != null && tl.release > 0 && kind !== "type") {
    parts.push(`<path class="tick" d="M${r1(x(tl.release))} ${low + 4}V${low + 9}"/>`);
    if (x(tl.release) - x(0) > 40) parts.push(`<text class="lbl" x="${r1(x(tl.release))}" y="${low + 20}">release</text>`);
  }
  // animations
  tl.anims.slice(0, lanes).forEach((a, i) => {
    const y = lanesTop + 12 + i * 12;
    const x0 = x(a.from), x1 = a.loop ? x(T) : x(a.to);
    parts.push(`<path class="anim${a.moving ? " moving" : ""}${a.loop ? " loop" : ""}" d="M${r1(x0)} ${y}H${r1(Math.max(x0 + 2, x1))}"/>`);
    if (x1 - x0 > 110 || x0 < W - 200) parts.push(`<text class="lbl" x="${r1(x1 + 6)}" y="${y + 3.5}">${esc(a.label)}</text>`);
  });
  // time ruler
  let ticks = "";
  for (let ms = 0; ms <= T; ms += 100) ticks += `<text class="lbl dim" x="${r1(x(ms))}" y="${H - 6}" text-anchor="middle">${ms === 0 || ms % 500 ? "" : `${ms}`}</text>`;
  parts.push(ticks);
  const desc = ch == null ? "No visible change in the window." : `First visible change ${Math.round(ch)} ms after the ${kind === "type" ? "key" : "press"}.`;
  return (
    `<svg class="kymo-trace" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">` +
    `<defs><pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V6" class="hatch"/></pattern></defs>` +
    parts.join("") +
    `</svg>`
  );
}

/** Feedback time for the strip and the table: click feedback, typing echo, or canvas pixels. */
export interface Budgets {
  feedbackMs: number;
  typingMs: number;
}
const DEFAULT_BUDGETS: Budgets = { feedbackMs: 100, typingMs: 100 };

export function responseMs(run: InteractionRun, canvas?: InteractionRun, b: Budgets = DEFAULT_BUDGETS): { ms: number | null; late: boolean; budgetOk: boolean } {
  const k = run.interaction.kind;
  if (k === "type") {
    const c = run.capture;
    const ms = c && c.firstChangeAt != null && c.downAt != null ? Math.round(c.firstChangeAt - c.downAt) : null;
    // an echo kymo could not time is not a finding, so it is not drawn as late either
    return { ms, late: ms != null && ms > b.typingMs, budgetOk: ms == null || ms <= b.typingMs };
  }
  const fb = feedbackLatency(run);
  let ms = fb.feedbackMs;
  if (ms == null && run.pixelsChanged && canvas?.pixelMs != null) ms = canvas.pixelMs;
  const late = ms == null ? !run.pixelsChanged : !fb.pressFeedback && ms > b.feedbackMs;
  return { ms, late, budgetOk: !late };
}

const SEV_RANK: Record<Severity, number> = { error: 3, warning: 2, suggestion: 1 };

/**
 * The whole session as one recording: one pulse per press or keystroke, in the order kymo did them.
 * Height is time to the first visible change (log scale). Pulses that missed the budget are red;
 * a dot above a pulse means it has findings, and links to the first.
 */
export function sessionStrip(result: AuditResult, opts: { width?: number; budgetMs?: number } = {}): string {
  const W = opts.width ?? 1080, H = 132, pad = 12, base = 104, top = 30;
  const budget = opts.budgetMs ?? result.thresholds?.feedbackMs ?? 100;
  const budgets: Budgets = { feedbackMs: budget, typingMs: result.thresholds?.typingMs ?? budget };
  const canvas = new Map(result.runs.filter((r) => r.mode === "canvas").map((r) => [r.interaction.key, r]));
  const runs = result.runs.filter((r) => r.mode === "normal" && (r.interaction.kind === "click" || r.interaction.kind === "type") && r.capture);
  if (!runs.length) return "";
  const worst = new Map<string, Finding>();
  for (const f of result.findings) {
    if (!f.interaction) continue;
    const w = worst.get(f.interaction);
    if (!w || SEV_RANK[f.severity] > SEV_RANK[w.severity]) worst.set(f.interaction, f);
  }
  const maxMs = 1200;
  const amp = (ms: number) => (Math.log2(1 + Math.min(ms, maxMs) / 10) / Math.log2(1 + maxMs / 10)) * (base - top);
  const step = (W - 2 * pad) / Math.max(runs.length, 24);
  const x0 = pad + Math.max(0, (W - 2 * pad - step * runs.length) / 2);
  let ink = `M${pad} ${base}`;
  const reds: string[] = [];
  const marks: string[] = [];
  const hits: string[] = [];
  runs.forEach((run, i) => {
    const { ms, late } = responseMs(run, canvas.get(run.interaction.key), budgets);
    const cx = x0 + i * step + step / 2;
    const w = Math.min(10, step * 0.6);
    let seg: string;
    if (ms == null) {
      // nothing happened: a flat, red stretch with a small cross
      seg = `L${r1(cx - w / 2)} ${base} L${r1(cx + w / 2)} ${base}`;
      marks.push(`<path class="x" d="M${r1(cx - 3)} ${base - 9}l6 6m0 -6l-6 6"/>`);
    } else {
      const h = Math.max(3, amp(ms));
      seg = `L${r1(cx - w / 2)} ${base} L${r1(cx - w / 6)} ${r1(base - h)} L${r1(cx + w / 6)} ${r1(base + Math.min(10, h * 0.25))} L${r1(cx + w / 2)} ${base}`;
    }
    ink += ` ${seg}`;
    if (late) reds.push(`M${r1(cx - w / 2)} ${base} ${seg}`);
    const f = worst.get(run.interaction.key);
    if (f) marks.push(`<a href="#${esc(f.id)}"><circle class="dot ${f.severity}" cx="${r1(cx)}" cy="${top - 12}" r="3.6"><title>${esc(f.id)}: ${esc(f.title)}</title></circle></a>`);
    hits.push(`<rect class="hit" x="${r1(x0 + i * step)}" y="${top - 18}" width="${r1(step)}" height="${base - top + 30}"><title>${esc(run.interaction.key)}: ${ms == null ? "no visible change" : `${ms} ms`}</title></rect>`);
  });
  ink += ` L${W - pad} ${base}`;
  const by = base - amp(budget);
  return (
    `<svg class="kymo-strip" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recording of ${runs.length} interactions; ${reds.length} missed the ${budget} ms budget.">` +
    grid(pad, 8, W - pad, H - 8, 12, 12) +
    `<path class="budget" d="M${pad} ${r1(by)}H${W - pad}"/>` +
    `<text class="lbl red" x="${W - pad - 4}" y="${r1(by - 5)}" text-anchor="end">${budget} ms</text>` +
    `<path class="pen draw" pathLength="1" d="${ink}"/>` +
    reds.map((d) => `<path class="pen red" d="${d}"/>`).join("") +
    hits.join("") +
    marks.join("") +
    `</svg>`
  );
}

/** A tiny step line for the interactions table. */
export function sparkline(run: InteractionRun, canvas?: InteractionRun, b: Budgets = DEFAULT_BUDGETS): string {
  const W = 120, H = 22, low = 17, high = 5, T = 1000;
  const { ms, late } = responseMs(run, canvas, b);
  const x = (v: number) => 2 + (Math.min(v, T) / T) * (W - 4);
  const bx = x(run.interaction.kind === "type" ? b.typingMs : b.feedbackMs);
  const line = ms == null ? `M2 ${low}H${W - 2}` : `M2 ${low}H${r1(x(ms))}L${r1(x(ms) + 2)} ${high}H${W - 2}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="budget" d="M${r1(bx)} 2V${H - 2}"/><path class="pen${late ? " red" : ""}" d="${line}"/></svg>`;
}

/** Declared durations on a 0 to 1000 ms ruler; taller ticks are used more often. */
export function durationRuler(inv: MotionInventory, budgetMs = 500): string {
  const W = 680, H = 74, pad = 12, base = 48, T = 1000;
  const x = (ms: number) => pad + (Math.min(ms, T) / T) * (W - 2 * pad);
  const counts = inv.sources?.durations ?? {};
  const max = Math.max(1, ...Object.values(counts));
  let ticks = "";
  for (let ms = 0; ms <= T; ms += 100) ticks += `<path class="G" d="M${r1(x(ms))} ${base}V${base + 5}"/><text class="lbl dim" x="${r1(x(ms))}" y="${base + 18}" text-anchor="middle">${ms % 500 ? "" : `${ms} ms`}</text>`;
  const bars = inv.durations
    .map((d) => {
      const h = 8 + (26 * (counts[String(d)] ?? 1)) / max;
      return `<path class="dur${d > budgetMs ? " red" : ""}" d="M${r1(x(d))} ${base}V${r1(base - h)}"><title>${d} ms, declared ${counts[String(d)] ?? 1} time(s)</title></path>`;
    })
    .join("");
  return `<svg class="kymo-ruler" viewBox="0 0 ${W} ${H}" role="img" aria-label="${inv.durations.length} declared durations">${grid(pad, 6, W - pad, base, (W - 2 * pad) / 50, 7)}<path class="budget" d="M${r1(x(budgetMs))} 6V${base}"/>${ticks}${bars}</svg>`;
}

/** An easing curve as a small plot. */
export function easingGlyph(easing: string): string {
  const S = 44, p = 5;
  const parsed = parseEasing(easing);
  let d = "";
  if (parsed === "linear") d = `M${p} ${S - p}L${S - p} ${p}`;
  else if (parsed === "steps") d = `M${p} ${S - p}H${S / 2}V${S / 2}H${S - p}V${p}`;
  else if (Array.isArray(parsed)) {
    const pts: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const y = bezierAt(parsed, t);
      pts.push(`${r1(p + t * (S - 2 * p))} ${r1(S - p - y * (S - 2 * p))}`);
    }
    d = `M${pts.join("L")}`;
  } else return `<svg class="ease" viewBox="0 0 ${S} ${S}" aria-hidden="true"><text class="lbl dim" x="${S / 2}" y="${S / 2 + 3}" text-anchor="middle">?</text></svg>`;
  return `<svg class="ease" viewBox="0 0 ${S} ${S}" aria-hidden="true"><path class="G" d="M${p} ${S - p}H${S - p}M${p} ${p}V${S - p}"/><path class="pen" d="${d}"/></svg>`;
}

export const SEV_GLYPH: Record<Severity, string> = {
  error: `<svg class="sg error" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg>`,
  warning: `<svg class="sg warning" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11.2 10.5H.8Z"/></svg>`,
  suggestion: `<svg class="sg suggestion" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.2"/></svg>`,
};
