import { createHash } from "node:crypto";
import { rule } from "../rules.js";
import type { ElementInfo, Finding, Interaction, InteractionRun, Severity, SourceInfo } from "../types.js";

/**
 * A key for an element that survives small DOM changes. Repeated siblings
 * (eight bars in a chart, five step numbers) share one key, so they report once.
 */
export function elementKey(el: ElementInfo | null | undefined): string {
  if (!el) return "?";
  return el.group ?? el.id ?? el.testid ?? el.css.replace(/:nth-of-type\(\d+\)/g, "");
}

type Hidden = Finding & { _sourceKeys?: string[]; _sourceParts?: (keyof SourceInfo)[] };

export function makeFinding(
  ruleId: string,
  parts: {
    keyParts: string[];
    message: string;
    interaction?: Interaction;
    element?: ElementInfo | null;
    group?: string | null;
    metrics?: Finding["metrics"];
    /** override the rule's default, e.g. CLS over the error line */
    severity?: Severity;
    /** where to look up source locations in the run's sources map (defaults to the element) */
    sourceKeys?: string[];
    /** keep only these kinds of source (a removed element has no CSS left to point at) */
    sourceParts?: (keyof SourceInfo)[];
  },
): Finding {
  const r = rule(ruleId);
  // Keys leave out the viewport, so the same problem on desktop and mobile is one finding (one fix).
  const key = [ruleId, ...parts.keyParts.map(withoutViewport)].join("|");
  const f: Finding = {
    id: shortId(key),
    key,
    rule: ruleId,
    severity: parts.severity ?? r.severity,
    evidence: r.evidence,
    title: r.title,
    message: parts.message,
    interaction: parts.interaction?.key,
    route: parts.interaction?.route,
    element: parts.element ?? null,
    group: parts.group ?? parts.element?.group ?? "@app",
    metrics: parts.metrics,
    fix: r.fix,
  };
  if (parts.interaction?.viewport) f.viewport = parts.interaction.viewport;
  f.viewports = [parts.interaction?.viewport ?? DEFAULT_VP];
  if (parts.sourceKeys?.length) (f as Hidden)._sourceKeys = parts.sourceKeys;
  if (parts.sourceParts?.length) (f as Hidden)._sourceParts = parts.sourceParts;
  return f;
}

/** Route-level group: an element's own group when it has one, else "@page <route>". */
export function pageGroup(route: string, el?: ElementInfo | null): string {
  return el?.group ?? `@page ${route}`;
}

/**
 * Point each finding at its source: the element's CSS rules and handler, the stamped markup,
 * and for long frames the script that ran. Sources come from the normal run of the same interaction.
 */
export function attachSources(findings: Finding[], runs: InteractionRun[]): void {
  const byKey = new Map<string, Record<string, SourceInfo>>();
  for (const r of runs) if (r.sources && !byKey.has(r.interaction.key)) byKey.set(r.interaction.key, r.sources);
  const targetCss = new Map(runs.map((r) => [r.interaction.key, r.interaction.target.css]));
  for (const f of findings) {
    const ff = f as Hidden;
    const keys = ff._sourceKeys ?? [];
    const only = ff._sourceParts;
    delete ff._sourceKeys;
    delete ff._sourceParts;
    if (!f.interaction) continue;
    const src = byKey.get(f.interaction);
    if (!src) {
      if (f.element?.src) f.source = { markup: f.element.src };
      continue;
    }
    const look = [...keys, f.element?.css, targetCss.get(f.interaction)].filter((k): k is string => !!k);
    const merged: SourceInfo = {};
    for (const k of look) {
      const s = src[k];
      if (!s) continue;
      merged.markup ??= s.markup ?? undefined;
      if (!merged.rules?.length && s.rules?.length) merged.rules = s.rules;
      merged.handler ??= s.handler ?? undefined;
      merged.script ??= s.script ?? undefined;
    }
    if (!merged.markup && f.element?.src) merged.markup = f.element.src;
    for (const k of Object.keys(merged) as (keyof SourceInfo)[]) {
      if (merged[k] == null || (only && k !== "markup" && !only.includes(k))) delete merged[k];
    }
    if (Object.keys(merged).length) f.source = merged;
  }
}

export function label(el: ElementInfo | null | undefined): string {
  if (!el) return "an element";
  const name = el.text ? `"${el.text}"` : el.id ? `#${el.id}` : el.css;
  return `${el.tag} ${name}`;
}

/** The element an interaction pressed, as an ElementInfo. */
export function targetInfo(i: Interaction): ElementInfo {
  return {
    tag: i.target.role ?? "element",
    id: i.target.id ?? null,
    testid: i.target.testid ?? null,
    group: i.target.group ?? null,
    text: i.target.text ?? i.target.name ?? "",
    css: i.target.css,
    role: i.target.role ?? null,
  };
}

/** "[mobile] / #save" -> "/ #save". */
export function withoutViewport(s: string): string {
  return s.replace(/^\[[\w.-]+\] /, "");
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, suggestion: 1 };

/** Stand-in for "the first configured viewport" until dedupe knows its name. */
export const DEFAULT_VP = "@first";

/** Keep the first finding for each key, and note every viewport it showed up on. */
export function dedupe(findings: Finding[], firstViewport = "desktop"): Finding[] {
  const byKey = new Map<string, Finding>();
  const out: Finding[] = [];
  for (const f of findings) {
    const vps = (f.viewports ?? []).map((v) => (v === DEFAULT_VP ? firstViewport : v));
    const prev = byKey.get(f.key);
    if (prev) {
      const merged = [...prev.viewports!, ...vps.filter((v) => !prev.viewports!.includes(v))];
      // keep the worst instance (mobile CLS 0.4 must not hide behind desktop CLS 0.15)
      if (RANK[f.severity] > RANK[prev.severity]) Object.assign(prev, f);
      prev.viewports = merged;
      continue;
    }
    f.viewports = vps;
    byKey.set(f.key, f);
    out.push(f);
  }
  return out;
}

/** A short, shell-safe id for a finding key: the rule plus five hex characters. */
export function shortId(key: string): string {
  const ruleId = key.split("|")[0];
  return `${ruleId}-${createHash("sha1").update(key).digest("hex").slice(0, 5)}`;
}
