import type { Page } from "playwright";
import type { Config, Interaction, TargetLocator } from "../types.js";
import { loadAndSettle } from "../browser/session.js";

export function locatorSummary(t: TargetLocator): string {
  if (t.id) return `#${t.id}`;
  if (t.testid) return `[data-testid=${t.testid}]`;
  if (t.role && t.name) return `${t.role} "${t.name}"`;
  return t.css;
}

export function interactionKey(route: string, t: TargetLocator): string {
  return `${route} ${locatorSummary(t)}`;
}

/** Visit each route and list the controls a person could click. */
export async function discoverInteractions(page: Page, config: Config): Promise<Interaction[]> {
  const out: Interaction[] = [];
  const seen = new Set<string>();
  for (const route of config.routes) {
    await loadAndSettle(page, config.baseUrl + route);
    const targets = (await page.evaluate(
      ([include, exclude]) => (window as any).__fc.discover(include, exclude),
      [config.include, config.exclude] as const,
    )) as TargetLocator[];
    for (const t of targets) {
      let key = interactionKey(route, t);
      // Two controls with the same summary: fall back to the CSS path so keys stay unique.
      if (seen.has(key)) key = `${route} ${t.css}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, route, kind: "click", target: t });
      if (out.length >= config.maxInteractions) return out;
    }
  }
  return out;
}
