// Terminal output: the kymo creature, a live recording strip while it presses things, and the
// findings summary. Colour only on a TTY (and never with NO_COLOR), so Claude and CI logs get plain text.
import type { AuditResult, Finding, InteractionRun, Severity } from "./types.js";
import { feedbackLatency } from "./probes/feedback.js";
import { preferenceFor, sourceHint } from "./browser/sources.js";

import { moodOf, terminalMascot, type Mood } from "./brand.js";
export type { Mood };

export function useColor(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

export function palette(on: boolean) {
  const wrap = (open: string, close = "\x1b[0m") => (s: string) => (on ? `\x1b[${open}m${s}${close}` : s);
  return {
    red: wrap("38;5;203"),
    ochre: wrap("38;5;214"),
    green: wrap("38;5;42"),
    ink: wrap("38;5;69"),
    dim: wrap("2", "\x1b[22m"),
    bold: wrap("1", "\x1b[22m"),
  };
}

/** The kymo creature in half blocks. Its mouth is the trace, and the trace is its mood. */
export function creature(mood: Mood = "busy", on = false): string[] {
  return terminalMascot(mood, on);
}

export const moodFor = moodOf;

/** Creature on the left, lines of text on the right (vertically centred on the four creature lines). */
export function banner(lines: string[], mood: Mood, on: boolean): string {
  const body = creature(mood, on);
  const out: string[] = [];
  const pad = Math.max(0, Math.floor((body.length - lines.length) / 2));
  for (let i = 0; i < Math.max(body.length, lines.length + pad); i++) {
    const left = body[i] ?? "          ";
    out.push(`  ${left}   ${lines[i - pad] ?? ""}`.trimEnd());
  }
  return out.join("\n");
}

const LEVELS = "▁▂▃▄▅▆▇█";

/** One glyph per finished run: taller means slower feedback. */
export function glyphFor(run: InteractionRun, budgetMs = 100): { ch: string; tone: "ok" | "slow" | "bad" | "quiet" } {
  const k = run.interaction.kind;
  if (run.error) return { ch: "×", tone: "bad" };
  if (k === "page") return { ch: "┃", tone: "quiet" };
  if (k === "dialog" || k === "hover") return { ch: "◦", tone: "quiet" };
  let ms: number | null;
  if (k === "type") {
    const c = run.capture;
    ms = c && c.firstChangeAt != null && c.downAt != null ? c.firstChangeAt - c.downAt : null;
  } else if (run.mode === "canvas") {
    ms = run.pixelMs ?? null;
  } else {
    const fb = feedbackLatency(run);
    ms = fb.feedbackMs;
    if (ms == null && run.pixelsChanged) return { ch: "▒", tone: "quiet" };
  }
  if (ms == null) return { ch: "█", tone: "bad" };
  const level = Math.min(LEVELS.length - 1, Math.floor(Math.log2(1 + Math.max(0, ms) / 12)));
  return { ch: LEVELS[level], tone: ms > budgetMs * 5 ? "bad" : ms > budgetMs ? "slow" : "ok" };
}

/** A strip chart that grows as runs finish. On a TTY it redraws one line; elsewhere it logs plain lines. */
export class Recorder {
  private glyphs: string[] = [];
  private last = "";
  constructor(private stream: NodeJS.WriteStream = process.stderr, private on = useColor(stream), private width = 48) {}

  get live(): boolean {
    return !!this.stream.isTTY;
  }

  phase(text: string) {
    this.clear();
    this.stream.write(`  ${text}\n`);
  }

  run(e: { run: InteractionRun; done: number; total: number; phase: string }, budgetMs = 100) {
    const c = palette(this.on);
    const g = glyphFor(e.run, budgetMs);
    const tone = g.tone === "bad" ? c.red : g.tone === "slow" ? c.ochre : g.tone === "quiet" ? c.dim : c.green;
    this.glyphs.push(tone(g.ch));
    if (!this.live) {
      this.stream.write(`  [${e.done}/${e.total}] ${e.phase === "press" ? "" : e.phase + " "}${e.run.interaction.key}${e.run.error ? "  (failed)" : ""}\n`);
      return;
    }
    const strip = this.glyphs.slice(-this.width).join("");
    const key = e.run.interaction.key;
    const line = `  ${c.dim("▕")}${strip}${c.dim("▏")} ${e.done}/${e.total}  ${c.dim(key.length > 50 ? key.slice(0, 49) + "…" : key)}`;
    this.clear();
    this.stream.write(line);
    this.last = line;
  }

  clear() {
    if (this.live && this.last) {
      this.stream.write("\r\x1b[2K");
      this.last = "";
    }
  }

  end() {
    if (this.live && this.last) this.stream.write("\n");
    this.last = "";
  }
}

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

const SEV_GLYPH: Record<Severity, string> = { error: "●", warning: "▲", suggestion: "○" };

/** The findings, worst first, with where to look and how to replay and verify each. */
export function formatSummary(result: AuditResult, opts: { color?: boolean; replay?: (f: Finding) => string } = {}): string {
  const c = palette(!!opts.color);
  const tone = (s: Severity) => (s === "error" ? c.red : s === "warning" ? c.ochre : c.dim);
  const { error, warning, suggestion } = result.counts;
  const lines: string[] = [];
  const total = result.findings.length;
  lines.push(
    banner(
      [
        `${c.bold("kymo")} ${c.dim(result.version)}`,
        total ? `${total} finding${total === 1 ? "" : "s"}: ${tone("error")(`${error} error`)}, ${tone("warning")(`${warning} warning`)}, ${tone("suggestion")(`${suggestion} suggestion`)}` : c.green("Nothing to fix. It feels right."),
        c.dim(`${n(result.trace.length, "interaction")}, ${n(result.routes.length, "route")}, ${result.viewports.map((v) => v.name).join(" + ")}`),
      ],
      moodFor(result.counts),
      !!opts.color,
    ),
  );
  for (const f of result.findings) {
    lines.push("");
    const vps = result.viewports.length > 1 && f.viewports?.length ? `[${f.viewports.join(", ")}]` : "";
    const where = [vps, f.group && !f.group.startsWith("@") ? f.group : ""].filter(Boolean).join(" ");
    lines.push(`  ${tone(f.severity)(SEV_GLYPH[f.severity])} ${c.bold(f.id)}  ${f.title}${where ? c.dim(`  ${where}`) : ""}`);
    lines.push(`    ${f.message}`);
    const src = sourceHint(f.source, preferenceFor(f.rule));
    if (src) lines.push(`    ${c.ink("at")} ${src}`);
    const replay = opts.replay?.(f);
    lines.push(c.dim(`    replay: --only ${replay ?? "@app"}   verify: --target ${f.id}`));
  }
  const broken = result.runs.filter((r) => r.error);
  if (broken.length) lines.push("", c.dim(`  ${broken.length} run(s) had problems; see latest.json`));
  return lines.join("\n");
}
