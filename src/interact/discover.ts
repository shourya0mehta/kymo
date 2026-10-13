import type { Page } from "playwright";
import type { Config, Interaction, InteractionKind, TargetLocator, Viewport } from "../types.js";
import { loadAndSettle, resetOrigin } from "../browser/session.js";
import { TYPE_INCLUDE } from "../config.js";

export function locatorSummary(t: TargetLocator): string {
  if (t.id) return `#${t.id}`;
  if (t.testid) return `[data-testid=${t.testid}]`;
  if (t.role && t.name) return `${t.role} "${t.name}"`;
  return t.css;
}

const KIND_SUFFIX: Record<InteractionKind, string> = { click: "", type: " @type", dialog: " @dialog", hover: " @hover", page: "" };

/** Stable key: [viewport] route, any setup steps, the target, and the kind. */
export function interactionKey(
  route: string,
  t: TargetLocator,
  opts: { kind?: InteractionKind; steps?: TargetLocator[]; viewport?: string } = {},
): string {
  const vp = opts.viewport ? `[${opts.viewport}] ` : "";
  if (opts.kind === "page") return `${vp}${route} @page`;
  const steps = (opts.steps ?? []).map((s) => `${locatorSummary(s)} > `).join("");
  return `${vp}${route} ${steps}${locatorSummary(t)}${KIND_SUFFIX[opts.kind ?? "click"]}`;
}

export function viewportFor(config: Config, name?: string): Viewport {
  return config.viewports.find((v) => v.name === name) ?? config.viewports[0];
}

export function make(
  config: Config,
  route: string,
  kind: InteractionKind,
  target: TargetLocator,
  extra: { steps?: TargetLocator[]; viewport?: string } = {},
): Interaction {
  const vpName = extra.viewport && extra.viewport !== config.viewports[0].name ? extra.viewport : undefined;
  const i: Interaction = { key: interactionKey(route, target, { kind, steps: extra.steps, viewport: vpName }), route, kind, target };
  if (extra.steps?.length) i.steps = extra.steps;
  if (vpName) i.viewport = vpName;
  return i;
}

/** Visit each route at each viewport and list what a person could click or type into. */
export async function discoverInteractions(pageFor: (vp: Viewport) => Promise<Page>, config: Config): Promise<Interaction[]> {
  const out: Interaction[] = [];
  const seen = new Set<string>();
  const push = (i: Interaction) => {
    if (seen.has(i.key)) {
      // Two controls with the same summary: fall back to the CSS path so keys stay unique.
      const alt = { ...i, target: { ...i.target, id: undefined, testid: undefined, role: undefined, name: undefined } };
      alt.key = interactionKey(i.route, alt.target, { kind: i.kind, steps: i.steps, viewport: i.viewport });
      if (seen.has(alt.key)) return;
      i = { ...i, key: alt.key };
    }
    seen.add(i.key);
    out.push(i);
  };
  for (const vp of config.viewports) {
    const page = await pageFor(vp);
    let count = 0;
    for (const route of config.routes) {
      if (config.isolate) await resetOrigin(page, config.baseUrl);
      await loadAndSettle(page, config.baseUrl + route);
      const clicks = (await page.evaluate(
        ([include, exclude]) => (window as any).__fc.discover(include, exclude),
        [config.include, config.exclude] as const,
      )) as TargetLocator[];
      for (const t of clicks) {
        if (count >= config.maxInteractions) break;
        push(make(config, route, "click", t, { viewport: vp.name }));
        count++;
      }
      if (config.probes.typing) {
        const fields = (await page.evaluate(
          ([include, exclude]) => (window as any).__fc.discover(include, exclude),
          [TYPE_INCLUDE, config.exclude] as const,
        )) as TargetLocator[];
        for (const t of fields.slice(0, 12)) push(make(config, route, "type", t, { viewport: vp.name }));
      }
      if (config.probes.page) push(make(config, route, "page", { css: "body" }, { viewport: vp.name }));
    }
  }
  return out;
}
