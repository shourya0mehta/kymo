import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import type {
  AuditResult, Capture, Config, ElementInfo, Finding, Interaction, InteractionRun, PageScan, RunMode, Severity, SourceInfo, Viewport,
} from "./types.js";
import { idleAmbient, loadAndSettle, openSession, pointAndClick, press, resetOrigin, resolveTarget, runSteps, settle, typeOne, type Session } from "./browser/session.js";
import { SourceLocator } from "./browser/sources.js";
import { discoverInteractions, make, viewportFor } from "./interact/discover.js";
import { runPool } from "./util/pool.js";
import { feedbackProbe } from "./probes/feedback.js";
import { continuityProbe } from "./probes/continuity.js";
import { motionProbe, buildInventory, sprawlProbe, revealProbe } from "./probes/motion.js";
import { hasMovement, reducedMotionProbe } from "./probes/reducedMotion.js";
import { failureProbe } from "./probes/failure.js";
import { keyboardProbe, hoverProbe, typingProbe, longFrameProbe, pageProbe } from "./probes/interaction.js";
import { attachSources, dedupe } from "./probes/finding.js";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

const SLOW_MS = 3000;
const MAX_NESTED = 30;

export interface AuditOptions {
  trace?: Interaction[];
  screenshots?: boolean;
  log?: (msg: string) => void;
  /** called as each run finishes; without it, progress goes to `log` one line per interaction */
  onRun?: (e: { run: InteractionRun; done: number; total: number; phase: string }) => void;
}

interface Lane {
  context: BrowserContext;
  page: Page;
  locator?: SourceLocator;
  viewport: Viewport;
}

/** One page per (worker, viewport, reduced motion), created on first use. */
class Lanes {
  private lanes = new Map<string, Promise<Lane>>();
  constructor(private session: Session, private config: Config) {}
  get(worker: number, vp: Viewport, reducedMotion = false): Promise<Lane> {
    const k = `${worker}|${vp.name}|${reducedMotion}`;
    if (!this.lanes.has(k)) {
      this.lanes.set(
        k,
        (async () => {
          const { context, page } = await this.session.newPage({ viewport: vp, reducedMotion });
          let locator: SourceLocator | undefined;
          if (this.config.probes.sources && !reducedMotion) {
            locator = new SourceLocator(page, this.config.baseUrl);
            await locator.init().catch(() => (locator = undefined));
          }
          return { context, page, locator, viewport: vp };
        })(),
      );
    }
    return this.lanes.get(k)!;
  }
  async close() {
    for (const p of this.lanes.values()) {
      const l = await p.catch(() => null);
      if (!l) continue;
      await l.locator?.close();
      await l.context.close().catch(() => {});
    }
  }
}

export async function audit(config: Config, opts: AuditOptions = {}): Promise<AuditResult> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const session = await openSession(config);
  const lanes = new Lanes(session, config);
  const runs: InteractionRun[] = [];
  const n = Math.max(1, config.concurrency);
  let trace: Interaction[] = [];
  const style = { durations: {} as Record<string, number>, easings: {} as Record<string, number>, reducedQuery: false };
  const ambient = new Map<string, string[]>();
  const ambientFor = (i: Interaction) => ambient.get(`${i.viewport ?? config.viewports[0].name}|${i.route}`) ?? [];
  /** Wraps a runner so each finished run is reported (or logged, when nobody listens). */
  const tracked = <T>(phase: string, total: number, interactionOf: (x: T) => Interaction, fn: (x: T, w: number) => Promise<InteractionRun>) => {
    let done = 0;
    return async (x: T, w: number) => {
      if (!opts.onRun && phase === "press") log(`  [${done + 1}/${total}] ${interactionOf(x).key}`);
      const run = await fn(x, w);
      done++;
      opts.onRun?.({ run, done, total, phase });
      return run;
    };
  };

  try {
    // 1. what to press
    if (opts.trace) {
      trace = opts.trace;
      log(`Replaying ${trace.length} interactions from the trace`);
    } else {
      trace = await discoverInteractions(async (vp) => (await lanes.get(0, vp)).page, config);
      log(`Found ${plural(trace.length, "interaction")} across ${plural(config.routes.length, "route")} and ${plural(config.viewports.length, "viewport")}`);
    }

    // 2. watch each route idle, and read the stylesheets' motion values
    const routeKeys = new Set(trace.map((i) => `${i.viewport ?? config.viewports[0].name}|${i.route}`));
    for (const route of config.routes) routeKeys.add(`${config.viewports[0].name}|${route}`);
    for (const rk of routeKeys) {
      const [vpName, route] = [rk.slice(0, rk.indexOf("|")), rk.slice(rk.indexOf("|") + 1)];
      const lane = await lanes.get(0, viewportFor(config, vpName));
      if (config.isolate) await resetOrigin(lane.page, config.baseUrl);
      await loadAndSettle(lane.page, config.baseUrl + route);
      // watch longer than one interaction: typed headlines and carousels change every few seconds
      const amb = await idleAmbient(lane.page, Math.max(config.windowMs, 3000));
      ambient.set(rk, amb);
      if (amb.length) log(`  ${route}: ${amb.length} element(s) change on their own and will be ignored`);
      if (vpName === config.viewports[0].name) {
        const s = (await lane.page.evaluate("window.__fc.styleInventory()")) as typeof style;
        for (const [k, v] of Object.entries(s.durations)) style.durations[k] = (style.durations[k] ?? 0) + v;
        for (const [k, v] of Object.entries(s.easings)) style.easings[k] = (style.easings[k] ?? 0) + v;
        style.reducedQuery ||= s.reducedQuery;
      }
    }

    // 3. every interaction, as a person would do it
    const pressOne = (i: Interaction, w: number) =>
      lanes.get(w, viewportFor(config, i.viewport)).then((lane) =>
        runOne(lane, config, i, "normal", { screenshots: opts.screenshots !== false, ambient: ambientFor(i) }),
      );
    const first = await runPool(trace, n, tracked("press", trace.length, (i: Interaction) => i, pressOne));
    runs.push(...first);

    // 4. controls behind other controls, dialogs and hover content found along the way
    if (!opts.trace) {
      const follow = followUps(config, first);
      if (follow.length) {
        log(`Found ${follow.length} more interaction(s) inside dialogs, menus and hover content`);
        const more = await runPool(follow, n, tracked("press", follow.length, (i: Interaction) => i, pressOne));
        runs.push(...more);
        trace = [...trace, ...follow];
      }
    }

    const clicks = runs.filter((r) => r.mode === "normal" && r.interaction.kind === "click" && r.capture);

    // 5. failure modes for presses that fired requests
    if (config.probes.failure) {
      const withRequests = clicks.filter((r) => r.requests.length > 0);
      if (withRequests.length) log(`Replaying ${withRequests.length} interaction(s) with slow and failing requests`);
      const jobs = withRequests.flatMap((b) => (["slow-network", "server-error"] as const).map((mode) => ({ b, mode })));
      const res = await runPool(
        jobs,
        n,
        tracked("failure", jobs.length, (j: (typeof jobs)[number]) => j.b.interaction, async ({ b, mode }, w) =>
          runOne(await lanes.get(w, viewportFor(config, b.interaction.viewport)), config, b.interaction, mode, { requests: b.requests, ambient: ambientFor(b.interaction) }),
        ),
      );
      runs.push(...res);
    }

    // 6. reduced motion for presses that moved something
    if (config.probes.reducedMotion) {
      const moved = clicks.filter((r) => hasMovement(r));
      if (moved.length) {
        log(`Replaying ${moved.length} interaction(s) with reduced motion on`);
        const res = await runPool(
          moved,
          n,
          tracked("reduced motion", moved.length, (b: InteractionRun) => b.interaction, async (b, w) =>
            runOne(await lanes.get(w, viewportFor(config, b.interaction.viewport), true), config, b.interaction, "reduced-motion", { ambient: ambientFor(b.interaction) }),
          ),
        );
        runs.push(...res);
      }
    }

    // 7. canvas and WebGL: time feedback from screen frames when the DOM shows nothing
    if (config.probes.canvas) {
      const drawn = clicks.filter((r) => r.capture!.firstChangeAt == null && r.pixelsChanged);
      if (drawn.length) {
        log(`Timing ${drawn.length} interaction(s) from screen frames (canvas or WebGL)`);
        const res = await runPool(
          drawn,
          n,
          tracked("canvas", drawn.length, (b: InteractionRun) => b.interaction, async (b, w) =>
            runOne(await lanes.get(w, viewportFor(config, b.interaction.viewport)), config, b.interaction, "canvas", { ambient: ambientFor(b.interaction) }),
          ),
        );
        runs.push(...res);
      }
    }
  } finally {
    await lanes.close();
    await session.close();
  }

  const t = config.thresholds;
  const inventory = buildInventory(runs, style);
  const motion = motionProbe(runs, t);
  let findings: Finding[] = dedupe([
    ...feedbackProbe(runs, t),
    ...longFrameProbe(runs, t),
    ...typingProbe(runs, t),
    ...continuityProbe(runs),
    ...motion,
    ...revealProbe(runs, t, motion),
    ...reducedMotionProbe(runs),
    ...failureProbe(runs),
    ...keyboardProbe(runs),
    ...hoverProbe(runs),
    ...pageProbe(runs, config),
    ...sprawlProbe(inventory, t),
  ], config.viewports[0].name);
  attachSources(findings, runs);
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
    viewports: config.viewports,
    thresholds: config.thresholds,
    trace,
    runs,
    findings,
    inventory,
    counts,
  };
}

/** Interactions found while pressing: controls inside what opened, dialogs to check, hover content to check. */
function followUps(config: Config, runs: InteractionRun[]): Interaction[] {
  const out: Interaction[] = [];
  const seen = new Set<string>();
  let nested = 0;
  const add = (i: Interaction) => {
    if (seen.has(i.key)) return;
    seen.add(i.key);
    out.push(i);
  };
  for (const r of runs) {
    const i = r.interaction;
    if (i.kind !== "click" || !r.capture) continue;
    const vp = viewportFor(config, i.viewport);
    if (config.probes.nested && !i.steps?.length) {
      for (const c of r.capture.newControls.slice(0, 6)) {
        if (nested >= MAX_NESTED) break;
        add(make(config, i.route, "click", c, { steps: [i.target], viewport: vp.name }));
        nested++;
      }
    }
    if (config.probes.dialogs && r.capture.dialog && !vp.mobile) add(make(config, i.route, "dialog", i.target, { steps: i.steps, viewport: vp.name }));
    if (config.probes.hover && r.hover?.appeared && !vp.mobile) add(make(config, i.route, "hover", i.target, { steps: i.steps, viewport: vp.name }));
  }
  return out;
}

async function runOne(
  lane: Lane,
  config: Config,
  interaction: Interaction,
  mode: RunMode,
  o: { screenshots?: boolean; requests?: string[]; ambient?: string[] },
): Promise<InteractionRun> {
  const run: InteractionRun = { interaction, mode, capture: null, requests: [] };
  const { page } = lane;
  const mobile = !!lane.viewport.mobile;
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
    if (config.isolate) await resetOrigin(page, config.baseUrl);
    await loadAndSettle(page, config.baseUrl + interaction.route);
    if (lane.locator) await lane.locator.reset();

    if (interaction.kind === "page") {
      await pageSweep(lane, config, run, o.ambient ?? []);
      return run;
    }

    const stepErr = await runSteps(page, interaction.steps, mobile);
    if (stepErr) {
      run.error = stepErr;
      return run;
    }
    const handle = await resolveTarget(page, interaction.target);
    if (!handle) {
      run.error = "Could not find the target again";
      return run;
    }

    if (interaction.kind === "type") {
      const res = await typeOne(page, handle, { ambient: o.ambient, mobile });
      run.capture = res.capture;
      if (res.error) run.error = res.error;
      const c = res.capture;
      run.typing = {
        echoMs: c && c.firstChangeAt != null && c.downAt != null ? Math.max(0, Math.round(c.firstChangeAt - c.downAt)) : null,
        earlyError: !!res.early?.earlyError,
        errorText: res.early?.errorText ?? null,
      };
      if (lane.locator && c) run.sources = await collectSources(lane.locator, c, interaction, config);
      return run;
    }

    if (interaction.kind === "dialog") {
      await dialogCheck(page, handle, run);
      if (lane.locator) run.sources = await locateAll(lane.locator, [interaction.target.css, run.dialog?.dialog]);
      return run;
    }

    if (interaction.kind === "hover") {
      await hoverContentCheck(page, handle, run);
      if (lane.locator) run.sources = await locateAll(lane.locator, [interaction.target.css, run.hoverContent?.content]);
      return run;
    }

    const res = await press(page, handle, {
      windowMs: mode === "server-error" ? 1500 : config.windowMs,
      screenshots: o.screenshots,
      groupAttribute: config.groupAttribute,
      ambient: o.ambient,
      mobile,
      hover: mode === "normal" && config.probes.hover && !mobile,
      screencast: mode === "canvas",
      checkpoint: mode === "slow-network" ? { afterReleaseMs: 1000, expr: "window.__fc.stateChanged()" } : undefined,
    });
    run.capture = res.capture;
    run.requests = res.requests;
    run.pixelsChanged = res.pixelsChanged;
    if (res.hover) run.hover = res.hover;
    if (mode === "canvas") run.pixelMs = res.pixelMs ?? null;
    if (res.error) run.error = res.error;
    if (mode === "slow-network") run.pending = res.checkpoint as InteractionRun["pending"];
    if (mode === "server-error" && run.capture) {
      run.capture.errorUi = (await page.evaluate("window.__fc.errorScan()")) as Capture["errorUi"];
    }
    if (mode === "normal" && lane.locator && run.capture) run.sources = await collectSources(lane.locator, run.capture, interaction, config, run);
    if (o.screenshots) (run as InteractionRun & { _shots?: unknown })._shots = res.shots;
  } catch (e) {
    run.error = String(e);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
  return run;
}

/** Locate a few elements by CSS path (or ElementInfo), skipping blanks and repeats. */
async function locateAll(locator: SourceLocator, els: (string | ElementInfo | null | undefined)[]): Promise<Record<string, SourceInfo>> {
  const out: Record<string, SourceInfo> = {};
  for (const e of els) {
    if (!e) continue;
    const css = typeof e === "string" ? e : e.css;
    if (out[css]) continue;
    out[css] = await locator.locate(css, { markup: typeof e === "string" ? null : e.src });
  }
  return out;
}

/** Where the elements involved in a capture are styled and handled. */
async function collectSources(
  locator: SourceLocator,
  c: Capture,
  interaction: Interaction,
  config: Config,
  run?: InteractionRun,
): Promise<Record<string, SourceInfo>> {
  const els = new Map<string, string | null>();
  els.set(interaction.target.css, null);
  for (const a of c.animations.slice(0, 8)) if (a.target) els.set(a.target.css, a.target.src ?? null);
  for (const x of [...c.teleports, ...c.pops, ...c.vanishes]) els.set(x.el.css, x.el.src ?? null);
  for (const s of run?.hover?.shifted ?? []) els.set(s.el.css, s.el.src ?? null);
  const out: Record<string, SourceInfo> = {};
  for (const [css, markup] of [...els].slice(0, 12)) out[css] = await locator.locate(css, { markup });
  const scripts: string[] = [];
  for (const lf of c.longFrames) {
    if (lf.duration < config.thresholds.longFrameMs) continue;
    const top = [...lf.scripts].sort((a, b) => b.duration - a.duration)[0];
    if (!top) continue;
    const pos = await locator.scriptPosition(top.url, top.charPos);
    if (pos) scripts.push(top.fn ? `${pos} (${top.fn})` : pos);
  }
  if (scripts.length) out["@longframe"] = { script: scripts[0] };
  return out;
}

/**
 * Open a dialog the way a keyboard user would (focus the trigger, press Enter), then check focus
 * moves in, Escape closes it, and focus comes back. If Enter does nothing, open it with the pointer
 * and skip the focus-return check: focus was never on the trigger to come back to.
 */
async function dialogCheck(page: Page, trigger: import("playwright").ElementHandle, run: InteractionRun) {
  await trigger.scrollIntoViewIfNeeded();
  await page.evaluate("window.__fc.dialogSnap()");
  type State = { open: boolean; dialog: ElementInfo | null; focusInside: boolean; focusOnTrigger: boolean };
  const state = () => page.evaluate((el) => (window as any).__fc.dialogState(el), trigger) as Promise<State>;
  const wait = async () => {
    await page.waitForTimeout(450);
    await settle(page, 1200);
  };
  let viaKeyboard = true;
  await trigger.focus().catch(() => {});
  await page.keyboard.press("Enter");
  await wait();
  let s1 = await state();
  if (!s1.open) {
    viaKeyboard = false;
    await pointAndClick(page, trigger, false);
    await wait();
    s1 = await state();
  }
  if (!s1.open) {
    run.dialog = { opened: false, focusMovedIn: false, escapeCloses: false, focusReturned: false, dialog: null };
    return;
  }
  await page.keyboard.press("Escape");
  await wait();
  const s2 = await state();
  run.dialog = {
    opened: true,
    focusMovedIn: s1.focusInside,
    escapeCloses: !s2.open,
    focusReturned: viaKeyboard ? s2.focusOnTrigger : true,
    dialog: s1.dialog,
  };
}

/** WCAG 1.4.13: content shown on hover must stay while the pointer moves onto it, and Escape must hide it. */
async function hoverContentCheck(page: Page, target: import("playwright").ElementHandle, run: InteractionRun) {
  await target.scrollIntoViewIfNeeded();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(vp.width - 2, vp.height - 2);
  await page.waitForTimeout(80);
  await page.evaluate((el) => (window as any).__fc.hoverSnap(el), target);
  const box = await target.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.waitForTimeout(450);
  const diff = (await page.evaluate("window.__fc.hoverDiff()")) as { appeared: ElementInfo | null };
  if (!diff.appeared) {
    run.hoverContent = { content: null, hoverable: true, dismissible: true };
    return;
  }
  const s = (await page.evaluate("window.__fc.hoverContentState()")) as { center: { x: number; y: number } | null };
  let hoverable = true;
  if (s.center) {
    await page.mouse.move(s.center.x, s.center.y, { steps: 10 });
    await page.waitForTimeout(350);
    hoverable = ((await page.evaluate("window.__fc.hoverContentState()")) as { visible: boolean }).visible;
  }
  if (!hoverable) {
    // put it back so Escape can be tested on its own
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  const dismissible = !((await page.evaluate("window.__fc.hoverContentState()")) as { visible: boolean }).visible;
  run.hoverContent = { content: diff.appeared, hoverable, dismissible };
}

/** Per-route sweep: tap targets, template look, Tab walk, then scroll to the bottom. */
async function pageSweep(lane: Lane, config: Config, run: InteractionRun, ambient: string[]) {
  const { page, locator, viewport } = lane;
  const t = config.thresholds;
  const sources: Record<string, SourceInfo> = {};
  await page.waitForTimeout(400);
  const scanTargets = (px: number) => page.evaluate((x) => (window as any).__fc.targetScan(x), px) as Promise<PageScan["targets"]>;
  const targets = await scanTargets(t.targetPx);
  const touchTargets = viewport.mobile ? await scanTargets(t.touchTargetPx) : undefined;
  const ai = (await page.evaluate("window.__fc.aiScan()")) as PageScan["ai"];
  if (locator) {
    const located = new Set<string>();
    for (const tg of [...targets.filter((x) => x.crowded), ...(touchTargets ?? [])]) {
      if (located.size >= 6 || located.has(tg.el.css)) continue;
      located.add(tg.el.css);
      sources[tg.el.css] = await locator.locate(tg.el.css, { markup: tg.el.src });
    }
  }

  // Tab through the page and check each stop shows where focus is
  const focus: PageScan["focus"] = [];
  let focusables = 0;
  if (!viewport.mobile) {
    focusables = (await page.evaluate("window.__fc.focusBaseline()")) as number;
    const seen = new Set<string>();
    for (let k = 0; k < Math.min(80, focusables + 2); k++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      const c = (await page.evaluate("window.__fc.focusCheck()")) as (PageScan["focus"][number] & { known: boolean }) | null;
      if (!c) break;
      if (seen.has(c.el.css)) break;
      seen.add(c.el.css);
      if (c.known && (!c.visible || c.obscured)) {
        focus.push({ el: c.el, visible: c.visible, obscured: c.obscured });
        if (locator && focus.length <= 8) sources[c.el.css] = await locator.locate(c.el.css, { markup: c.el.src });
      }
    }
  }

  // Scroll to the bottom like a reader would, watching shifts, long frames and reveals
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur(); scrollTo(0, 0)");
  await page.waitForTimeout(200);
  // keep the pointer at the edge so scrolling does not drag hover effects across the page
  await page.mouse.move(4, viewport.height / 2);
  await page.evaluate((amb) => (window as any).__fc.arm(null, amb), ambient);
  await page.waitForTimeout(110);
  await page.evaluate("window.__fc.go()");
  const t0 = (await page.evaluate("window.__fc.now()")) as number;
  for (let k = 0; k < 30; k++) {
    if (viewport.mobile) await page.evaluate((h) => scrollBy(0, h), viewport.height * 0.8);
    else await page.mouse.wheel(0, viewport.height * 0.8);
    await page.waitForTimeout(160);
    const done = (await page.evaluate("innerHeight + scrollY >= document.documentElement.scrollHeight - 2")) as boolean;
    if (done) break;
  }
  await page.waitForTimeout(800);
  const capture = (await page.evaluate("window.__fc.disarm()")) as Capture;
  const stats = (await page.evaluate("window.__fc.sectionStats()")) as { sections: number; revealed: number };
  const shifts = (await page.evaluate("window.__fc.shiftsSince(0)")) as { cls: number; source: PageScan["clsSource"] };
  const longFrames = (await page.evaluate((x) => (window as any).__fc.longFramesSince(x), t0)) as PageScan["longFrames"];
  if (shifts.source && locator) sources[shifts.source.css] = await locator.locate(shifts.source.css, { markup: shifts.source.src });
  if (locator) {
    for (const lf of longFrames) {
      if (lf.duration < t.longFrameMs) continue;
      const top = [...lf.scripts].sort((a, b) => b.duration - a.duration)[0];
      if (!top) continue;
      const pos = await locator.scriptPosition(top.url, top.charPos);
      if (pos) {
        sources["@longframe"] = { script: top.fn ? `${pos} (${top.fn})` : pos };
        break;
      }
    }
  }
  if (locator) {
    const seen = new Set<string>();
    for (const a of capture.animations) {
      if (!a.target || seen.has(a.target.css) || seen.size >= 3) continue;
      seen.add(a.target.css);
      sources[a.target.css] = await locator.locate(a.target.css, { markup: a.target.src });
    }
  }
  run.capture = capture;
  run.page = {
    cls: shifts.cls,
    clsSource: shifts.source,
    longFrames,
    reveals: capture.animations,
    sections: stats.sections,
    revealedSections: stats.revealed,
    focus,
    focusables,
    targets,
    touchTargets,
    ai,
  };
  run.sources = sources;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, suggestion: 2 };
export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
}
