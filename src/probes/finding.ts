import { createHash } from "node:crypto";
import { rule } from "../rules.js";
import type { ElementInfo, Finding, Interaction } from "../types.js";

/**
 * A key for an element that survives small DOM changes. Repeated siblings
 * (eight bars in a chart, five step numbers) share one key, so they report once.
 */
export function elementKey(el: ElementInfo | null | undefined): string {
  if (!el) return "?";
  return el.group ?? el.id ?? el.testid ?? el.css.replace(/:nth-of-type\(\d+\)/g, "");
}

export function makeFinding(
  ruleId: string,
  parts: {
    keyParts: string[];
    message: string;
    interaction?: Interaction;
    element?: ElementInfo | null;
    group?: string | null;
    metrics?: Finding["metrics"];
  },
): Finding {
  const r = rule(ruleId);
  const key = [ruleId, ...parts.keyParts].join("|");
  return {
    id: shortId(key),
    key,
    rule: ruleId,
    severity: r.severity,
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

/** Keep the first finding for each key. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}

/** A short, shell-safe id for a finding key: the rule plus five hex characters. */
export function shortId(key: string): string {
  const ruleId = key.split("|")[0];
  return `${ruleId}-${createHash("sha1").update(key).digest("hex").slice(0, 5)}`;
}
