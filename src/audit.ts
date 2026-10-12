import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { AuditResult, Capture, Config, Finding, Interaction, InteractionRun, Severity } from "./types.js";
import { idleAmbient, loadAndSettle, openSession, press, resolveTarget } from "./browser/session.js";
import { discoverInteractions } from "./interact/discover.js";
import { feedbackProbe } from "./probes/feedback.js";
import { continuityProbe } from "./probes/continuity.js";
import { motionProbe, buildInventory, sprawlProbe } from "./probes/motion.js";
import { hasMovement, reducedMotionProbe } from "./probes/reducedMotion.js";
import { failureProbe } from "./probes/failure.js";
import { dedupe } from "./probes/finding.js";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

const SLOW_MS = 3000;

export interface AuditOptions {
  trace?: Interaction[];
  screenshots?: boolean;
  log?: (msg: string) => void;
}

export async function audit(config: Config, opts: AuditOptions = {}): Promise<AuditResult> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const session = await openSession(config);
  const runs: InteractionRun[] = [];
  let trace: Interaction[] = [];
  let style = { durations: {} as Record<string, number>, easings: {} as Record<string, number>, reducedQuery: false };
  try {
    const { page } = await session.newPage();

    // 1. what to press
    if (opts.trace) {
      trace = opts.trace;
      log(`Replaying ${trace.length} interactions from the trace`);
    } else {
      trace = await discoverInteractions(page, config);
      log(`Found ${trace.length} interactions across ${config.routes.length} route(s)`);
    }

    // stylesheet motion inventory and an idle watch, per route
    const ambient: Record<string, string[]> = {};
    for (const route of config.routes) {
      await loadAndSettle(page, config.baseUrl + route);
      ambient[route] = await idleAmbient(page, config.windowMs);
      if (ambient[route].length) log(`  ${route}: ${ambient[route].length} element(s) change on their own and will be ignored`);
      const s = (await page.evaluate("window.__fc.styleInventory()")) as typeof style;
      for (const [k, v] of Object.entries(s.durations)) style.durations[k] = (style.durations[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.easings)) style.easings[k] = (style.easings[k] ?? 0) + v;
      style.reducedQuery ||= s.reducedQuery;
    }

    // 2. normal presses
    for (const [i, interaction] of trace.entries()) {
      log(`  [${i + 1}/${trace.length}] ${interaction.key}`);
      runs.push(await runOne(page, config, interaction, "normal", { screenshots: opts.screenshots !== false, ambient: ambient[interaction.route] }));
    }

    // 3. failure modes for presses that fired requests
    if (config.probes.failure) {
      const withRequests = runs.filter((r) => r.mode === "normal" && r.requests.length > 0);
      if (withRequests.length) log(`Replaying ${withRequests.length} interaction(s) with slow and failing requests`);
      for (const base of withRequests) {
        const amb = ambient[base.interaction.route];
        runs.push(await runOne(page, config, base.interaction, "slow-network", { requests: base.requests, ambient: amb }));
        runs.push(await runOne(page, config, base.interaction, "server-error", { requests: base.requests, ambient: amb }));
      }
    }

    // 4. reduced motion for presses that moved something
    if (config.probes.reducedMotion) {
      const moved = runs.filter((r) => r.mode === "normal" && hasMovement(r));
      if (moved.length) {
        log(`Replaying ${moved.length} interaction(s) with reduced motion on`);
        const { page: rmPage, context } = await session.newPage({ reducedMotion: true });
        for (const base of moved) runs.push(await runOne(rmPage, config, base.interaction, "reduced-motion", { ambient: ambient[base.interaction.route] }));
        await context.close();
      }
    }
  } finally {
    await session.close();
  }

  const inventory = buildInventory(runs, style);
  let findings: Finding[] = dedupe([
    ...feedbackProbe(runs),
    ...continuityProbe(runs),
    ...motionProbe(runs),
    ...reducedMotionProbe(runs),
    ...failureProbe(runs),
    ...sprawlProbe(inventory),
  ]);
  findings = sortFindings(findings);

  // screenshots: keep only those that illustrate a finding
  const shotDir = join(config.outDir, "shots");
  mkdirSync(shotDir, { recursive: true });
  const normalByKey = new Map(runs.filter((r) => r.mode === "normal").map((r) => [r.interaction.key, r]));
  for (const f of findings) {
    if (!f.interaction) continue;
    const run = normalByKey.get(f.interaction) as (InteractionRun & { _shots?: { before?: Buffer; after?: Buffer } }) | undefined;
    if (!run?._shots) continue;
    const id = createHash("sha1").update(f.interaction).digest("hex").slice(0, 10);
    const shots: Finding["shots"] = {};
    if (run._shots.before) writeFileSync(join(shotDir, `${id}-before.jpg`), run._shots.before), (shots.before = `shots/${id}-before.jpg`);
    if (run._shots.after) writeFileSync(join(shotDir, `${id}-after.jpg`), run._shots.after), (shots.after = `shots/${id}-after.jpg`);
    f.shots = shots;
  }
  for (const r of runs) delete (r as { _shots?: unknown })._shots;

  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    tool: "kymo",
    version: VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    routes: config.routes,
    viewport: config.viewport,
    trace,
    runs,
    findings,
    inventory,
    counts,
  };
}

async function runOne(
  page: Page,
  config: Config,
  interaction: Interaction,
  mode: InteractionRun["mode"],
  o: { screenshots?: boolean; requests?: string[]; ambient?: string[] },
): Promise<InteractionRun> {
  const run: InteractionRun = { interaction, mode, capture: null, requests: [] };
  const matches = (url: URL) => (o.requests ?? []).includes(url.href);
  try {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    if (mode === "slow-network") {
      await page.route(matches, async (route) => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        await route.continue().catch(() => {});
      });
    } else if (mode === "server-error") {
      await page.route(matches, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"kymo injected failure"}' }).catch(() => {}),
      );
    }
    await loadAndSettle(page, config.baseUrl + interaction.route);
    const handle = await resolveTarget(page, interaction.target);
    if (!handle) {
      run.error = "Could not find the target again";
      return run;
    }
    const res = await press(page, handle, {
      windowMs: mode === "server-error" ? 1500 : config.windowMs,
      screenshots: o.screenshots,
      groupAttribute: config.groupAttribute,
      ambient: o.ambient,
      checkpoint: mode === "slow-network" ? { afterReleaseMs: 1000, expr: "window.__fc.stateChanged()" } : undefined,
    });
    run.capture = res.capture;
    run.requests = res.requests;
    run.pixelsChanged = res.pixelsChanged;
    if (res.error) run.error = res.error;
    if (mode === "slow-network") run.pending = res.checkpoint as InteractionRun["pending"];
    if (mode === "server-error" && run.capture) {
      run.capture.errorUi = (await page.evaluate("window.__fc.errorScan()")) as Capture["errorUi"];
    }
    if (o.screenshots) (run as InteractionRun & { _shots?: unknown })._shots = res.shots;
  } catch (e) {
    run.error = String(e);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
  return run;
}

const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, suggestion: 2 };
export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
}
