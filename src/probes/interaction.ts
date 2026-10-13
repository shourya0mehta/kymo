// Probes for everything beyond the plain click: keyboard focus, dialogs, hover, typing,
// long frames, and the per-route page sweep (layout shift, tap targets, template look).
import type { Config, ElementInfo, Finding, InteractionRun, TargetIssue, Thresholds } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../config.js";
import { elementKey, label, makeFinding, pageGroup, targetInfo } from "./finding.js";
import { attributable, longest, slowOrDead } from "./feedback.js";
import { isReveal } from "./motion.js";

const normal = (r: InteractionRun) => r.mode === "normal";

function list(els: ElementInfo[], max = 4): string {
  const shown = els.slice(0, max).map(label).join(", ");
  return els.length > max ? `${shown} and ${els.length - max} more` : shown;
}

/** Group items by their element group (or none), so planted exhibits and real routes both read well. */
function byGroup<T>(items: T[], el: (x: T) => ElementInfo | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const g = el(x)?.group ?? "";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(x);
  }
  return m;
}

/** CRAFT-03: a dialog must take focus, close on Escape, and hand focus back. One finding per dialog component. */
export function keyboardProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, { run: InteractionRun; problems: string[]; count: number }>();
  for (const run of runs) {
    if (!normal(run) || run.interaction.kind !== "dialog" || !run.dialog?.opened) continue;
    const d = run.dialog;
    const problems: string[] = [];
    if (!d.focusMovedIn) problems.push("focus stays behind it when it opens");
    if (!d.escapeCloses) problems.push("Escape does not close it");
    else if (!d.focusReturned) problems.push("focus does not return to the button that opened it");
    if (!problems.length) continue;
    // eleven plant cards from one component are one fix
    const k = `${elementKey(d.dialog ?? targetInfo(run.interaction))}|${problems.join("|")}`;
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { run, problems, count: 1 });
  }
  for (const [k, { run, problems, count }] of groups) {
    const d = run.dialog!;
    const trigger = targetInfo(run.interaction);
    const more = count > 1 ? ` The same dialog behaves this way from ${count - 1} other control(s).` : "";
    out.push(
      makeFinding("CRAFT-03", {
        keyParts: [k],
        interaction: run.interaction,
        element: d.dialog ?? trigger,
        group: d.dialog?.group ?? trigger.group,
        message: `The dialog opened by ${label(trigger)}: ${problems.join("; ")}.${more}`,
        metrics: { focusMovedIn: d.focusMovedIn, escapeCloses: d.escapeCloses, focusReturned: d.focusReturned, triggers: count },
        sourceKeys: [d.dialog?.css ?? "", run.interaction.target.css].filter(Boolean),
      }),
    );
  }
  return out;
}

/** STAB-02 hover moves the layout around the control; CRAFT-05 hover content that cannot be reached or dismissed. */
export function hoverProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  const badHover = new Map<string, InteractionRun[]>();
  for (const run of runs) {
    if (!normal(run)) continue;
    const target = targetInfo(run.interaction);
    if (run.interaction.kind === "click" && run.hover) {
      const shifted = run.hover.shifted.filter((s) => s.px >= 2);
      if (shifted.length) {
        const max = Math.max(...shifted.map((s) => s.px));
        out.push(
          makeFinding("STAB-02", {
            keyParts: [elementKey(target)],
            interaction: run.interaction,
            element: target,
            message: `Pointing at ${label(target)} moved ${list(shifted.map((s) => s.el))} by up to ${max} px.`,
            metrics: { shiftPx: max, moved: shifted.length },
            sourceParts: ["rules"],
          }),
        );
      }
    }
    if (run.interaction.kind === "hover" && run.hoverContent?.content) {
      const h = run.hoverContent;
      if (h.hoverable && h.dismissible) continue;
      // One tooltip component behind many triggers is one fix: group by the content's shape.
      const k = `${elementKey(h.content)}|${h.hoverable}|${h.dismissible}`;
      if (!badHover.has(k)) badHover.set(k, []);
      badHover.get(k)!.push(run);
    }
  }
  for (const group of badHover.values()) {
    const run = group[0];
    const h = run.hoverContent!;
    const target = targetInfo(run.interaction);
    const problems: string[] = [];
    if (!h.hoverable) problems.push("it disappears when the pointer moves onto it");
    if (!h.dismissible) problems.push("Escape does not hide it");
    const more = group.length > 1 ? ` The same happens on ${group.length - 1} other control(s).` : "";
    out.push(
      makeFinding("CRAFT-05", {
        keyParts: [elementKey(h.content), h.hoverable ? "" : "unreachable", h.dismissible ? "" : "sticky"],
        interaction: run.interaction,
        element: h.content,
        group: target.group ?? h.content!.group,
        message: `Hovering ${label(target)} shows ${label(h.content)}, but ${problems.join(" and ")}.${more}`,
        metrics: { hoverable: h.hoverable, dismissible: h.dismissible, triggers: group.length },
        sourceKeys: [h.content!.css, run.interaction.target.css],
      }),
    );
  }
  return out;
}

/** FEEL-05 typed characters that take too long to appear; CRAFT-08 validation that fires on the first character. */
export function typingProbe(runs: InteractionRun[], t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (!normal(run) || run.interaction.kind !== "type" || !run.typing) continue;
    const field = targetInfo(run.interaction);
    const ty = run.typing;
    if (ty.echoMs != null && ty.echoMs > t.typingMs) {
      const block = longest(run.capture?.longFrames, t.longFrameMs);
      out.push(
        makeFinding("FEEL-05", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: field,
          message: `A character typed into ${label(field)} took ${ty.echoMs} ms to appear (budget ${t.typingMs} ms).${block ? ` A ${Math.round(block.duration)} ms frame blocked the page.` : ""}`,
          metrics: { echoMs: ty.echoMs, budgetMs: t.typingMs },
          sourceKeys: block ? ["@longframe"] : undefined,
          sourceParts: ["script", "handler"],
        }),
      );
    }
    if (ty.earlyError) {
      out.push(
        makeFinding("CRAFT-08", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: field,
          message: `After one character in ${label(field)}, before leaving the field, it already shows an error${ty.errorText && ty.errorText !== "aria-invalid" ? `: "${ty.errorText}"` : " (aria-invalid)"}.`,
          metrics: { errorText: ty.errorText },
        }),
      );
    }
  }
  return out;
}

/** FEEL-04: a frame of longFrameMs or more after a click (when the click's feedback was otherwise fine). */
export function longFrameProbe(runs: InteractionRun[], t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (!normal(run) || run.interaction.kind !== "click" || !run.capture) continue;
    const block = longest(run.capture.longFrames, t.longFrameMs);
    if (!block || slowOrDead(run, t)) continue; // reported with FEEL-01 or FEEL-03 instead
    const target = targetInfo(run.interaction);
    const fn = [...block.scripts].sort((a, b) => b.duration - a.duration)[0]?.fn;
    out.push(
      makeFinding("FEEL-04", {
        keyParts: [run.interaction.key],
        interaction: run.interaction,
        element: target,
        message: `After clicking ${label(target)}, one frame took ${Math.round(block.duration)} ms${fn ? ` (mostly in ${fn})` : ""}. Nothing can paint or respond until it ends.`,
        metrics: { frameMs: Math.round(block.duration), blockingMs: Math.round(block.blocking), budgetMs: t.longFrameMs },
        sourceKeys: ["@longframe"],
        sourceParts: ["script", "handler"],
      }),
    );
  }
  return out;
}

/**
 * The per-route sweep: STAB-01 layout shift, FEEL-04 long frames while scrolling, CRAFT-02 focus,
 * CRAFT-04 and CRAFT-09 tap targets, AI-01 template look.
 */
export function pageProbe(runs: InteractionRun[], config: Pick<Config, "thresholds" | "viewports">): Finding[] {
  const t = config.thresholds;
  const out: Finding[] = [];
  const aiDone = new Set<string>();
  for (const run of runs) {
    if (!normal(run) || run.interaction.kind !== "page" || !run.page) continue;
    const p = run.page;
    const i = run.interaction;
    const route = i.route;

    if (p.cls > t.clsWarn) {
      out.push(
        makeFinding("STAB-01", {
          keyParts: [i.key],
          interaction: i,
          element: p.clsSource,
          group: pageGroup(route, p.clsSource),
          severity: p.cls > t.clsError ? "error" : "warning",
          message: `Content shifted by a cumulative ${p.cls} while loading and scrolling ${route} (good is ${t.clsWarn} or less, poor above ${t.clsError})${p.clsSource ? `. The largest shift moved ${label(p.clsSource)}.` : "."}`,
          metrics: { cls: p.cls, warn: t.clsWarn, error: t.clsError },
          sourceParts: ["rules"],
        }),
      );
    }

    const block = longest(p.longFrames, t.longFrameMs);
    const count = p.longFrames.filter((f) => f.duration >= t.longFrameMs && attributable(f)).length;
    // one blip in a whole page of scrolling is not stutter: it takes two long frames, or one twice as long
    if (block && (count >= 2 || block.duration >= 2 * t.longFrameMs)) {
      out.push(
        makeFinding("FEEL-04", {
          keyParts: [i.key, "scroll"],
          interaction: i,
          group: pageGroup(route),
          message: `Scrolling ${route} produced ${count} frame(s) of ${t.longFrameMs} ms or more, the longest ${Math.round(block.duration)} ms. Scrolling stutters while they run.`,
          metrics: { frameMs: Math.round(block.duration), count, budgetMs: t.longFrameMs, trigger: "scroll" },
          sourceKeys: ["@longframe"],
        }),
      );
    }

    for (const [g, issues] of byGroup(p.focus.filter((f) => !f.visible), (f) => f.el)) {
      const els = issues.map((f) => f.el);
      out.push(
        makeFinding("CRAFT-02", {
          keyParts: [i.key, g || "page", "invisible"],
          interaction: i,
          element: els[0],
          group: g || pageGroup(route),
          message: `Tabbing to ${list(els)} changes nothing about how ${els.length > 1 ? "they look" : "it looks"}, so keyboard users cannot see where focus is.`,
          metrics: { count: els.length, of: p.focusables },
          sourceKeys: [els[0].css],
          sourceParts: ["rules"],
        }),
      );
    }
    for (const [g, issues] of byGroup(p.focus.filter((f) => f.visible && f.obscured), (f) => f.el)) {
      const els = issues.map((f) => f.el);
      out.push(
        makeFinding("CRAFT-02", {
          keyParts: [i.key, g || "page", "obscured"],
          interaction: i,
          element: els[0],
          group: g || pageGroup(route),
          message: `When ${list(els)} ${els.length > 1 ? "have" : "has"} keyboard focus, something else covers ${els.length > 1 ? "them" : "it"} completely (often a sticky header or a cookie banner).`,
          metrics: { count: els.length },
          sourceKeys: [els[0].css],
          sourceParts: ["rules"],
        }),
      );
    }

    const crowded = p.targets.filter((x) => x.crowded);
    for (const [g, issues] of byGroup(crowded, (x) => x.el)) {
      out.push(targetFinding("CRAFT-04", run, g, issues, t.targetPx, "and too close to another control"));
    }
    const vp = config.viewports.find((v) => v.name === (i.viewport ?? config.viewports[0].name));
    if (vp?.mobile && p.touchTargets?.length) {
      const already = new Set(crowded.map((x) => x.el.css));
      const touch = p.touchTargets.filter((x) => !already.has(x.el.css));
      // One finding per route: undersized touch targets nearly always share one button or link style.
      if (touch.length) out.push(targetFinding("CRAFT-09", run, "", touch, t.touchTargetPx, "for a thumb"));
    }

    // the template look: judged once per route, not once per viewport
    if (!aiDone.has(route)) {
      aiDone.add(route);
      const tells = [...p.ai.tells];
      if (p.sections >= 3 && p.revealedSections / p.sections > 0.6 && p.reveals.some(isReveal)) {
        tells.push({ id: "reveal-everything", label: "An entrance on every section", detail: `${p.revealedSections} of ${p.sections} sections animate in on scroll` });
      }
      if (tells.length >= t.aiTells) {
        out.push(
          makeFinding("AI-01", {
            keyParts: [route],
            interaction: i,
            group: pageGroup(route),
            message: `${route} shows ${tells.length} template tells: ${tells.map((x) => `${x.label.toLowerCase()} (${x.detail})`).join("; ")}.`,
            metrics: { tells: tells.length, ids: tells.map((x) => x.id).join(", ") },
          }),
        );
      }
    }
  }
  return out;
}

function targetFinding(ruleId: string, run: InteractionRun, g: string, issues: TargetIssue[], px: number, why: string): Finding {
  const i = run.interaction;
  const els = issues.map((x) => x.el);
  const smallest = issues.reduce((m, x) => (Math.min(x.w, x.h) < Math.min(m.w, m.h) ? x : m));
  return makeFinding(ruleId, {
    keyParts: [i.key, g || "page"],
    interaction: i,
    element: smallest.el,
    group: g || pageGroup(i.route),
    message: `${issues.length} control(s) are under ${px} by ${px} px ${why}: ${list(els)}. The smallest is ${smallest.w} by ${smallest.h} px.`,
    metrics: { count: issues.length, minW: smallest.w, minH: smallest.h, budgetPx: px },
    sourceKeys: [smallest.el.css],
    sourceParts: ["rules"],
  });
}
