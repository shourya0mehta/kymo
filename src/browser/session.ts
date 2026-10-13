import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Capture, Config, HoverResult, TargetLocator, Viewport } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const INPAGE = readFileSync(join(here, "inpage.js"), "utf8");

export interface Session {
  browser: Browser;
  newPage(opts?: { reducedMotion?: boolean; viewport?: Viewport }): Promise<{ context: BrowserContext; page: Page }>;
  close(): Promise<void>;
}

export async function openSession(config: Config): Promise<Session> {
  const browser = await chromium.launch({ headless: true });
  const inpageConfig = {
    groupAttribute: config.groupAttribute,
    jumpPx: config.thresholds.jumpPx,
    popShare: config.thresholds.popShare,
    include: config.include,
    skipNames: config.skipNames,
  };
  return {
    browser,
    async newPage(opts = {}) {
      const vp = opts.viewport ?? config.viewports[0];
      const context = await browser.newContext({
        ...(config.storageState ? { storageState: config.storageState } : {}),
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: !!vp.mobile,
        hasTouch: !!vp.mobile,
        reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
      });
      await context.addInitScript(`window.__fcConfig = ${JSON.stringify(inpageConfig)};`);
      await context.addInitScript(INPAGE);
      const page = await context.newPage();
      return { context, page };
    },
    async close() {
      await browser.close();
    },
  };
}

/** Load a route and wait until it is quiet: network idle, fonts loaded, no finite animations running. */
export async function loadAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await settle(page);
}

export async function settle(page: Page, timeoutMs = 2000): Promise<void> {
  await page.evaluate(`(async () => {
    try { await document.fonts.ready; } catch (e) {}
    const deadline = performance.now() + ${timeoutMs};
    const busy = () => document.getAnimations().some(a => {
      const it = a.effect && a.effect.getTiming().iterations;
      return (a.playState === "running" || a.pending) && isFinite(it);
    });
    while (busy() && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/** Find an interaction target again: id, then test id, then role + name, then CSS path. */
export async function resolveTarget(page: Page, t: TargetLocator): Promise<ElementHandle | null> {
  const tries: Array<() => Promise<ElementHandle | null>> = [];
  if (t.id) tries.push(() => unique(page, `#${cssEscape(t.id!)}`));
  if (t.testid) tries.push(() => unique(page, `[data-testid="${t.testid}"]`));
  if (t.role && t.name) {
    tries.push(async () => {
      const loc = page.getByRole(t.role as never, { name: t.name, exact: true });
      if ((await loc.count()) !== 1) return null;
      return loc.elementHandle();
    });
  }
  tries.push(() => unique(page, t.css));
  // Names that carry live state ("Recall: bare. Open") drift between runs; try the stable prefix.
  if (t.role && t.name) {
    const prefix = t.name.split(/[:.(]/)[0].trim();
    if (prefix.length >= 3 && prefix !== t.name) {
      tries.push(async () => {
        const loc = page.getByRole(t.role as never, { name: prefix });
        if ((await loc.count()) !== 1) return null;
        return loc.elementHandle();
      });
    }
  }
  for (const attempt of tries) {
    try {
      const h = await attempt();
      if (h) return h;
    } catch {
      /* try the next strategy */
    }
  }
  return null;
}

async function unique(page: Page, selector: string): Promise<ElementHandle | null> {
  const loc = page.locator(selector);
  if ((await loc.count()) !== 1) return null;
  return loc.elementHandle();
}

function cssEscape(s: string): string {
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/**
 * Click where a person would: the centre of the element, with the real pointer (or a tap).
 * Unlike handle.click(), this works for hit areas with pointer-events: none over a canvas,
 * which is exactly what a person's click lands on too.
 */
export async function pointAndClick(page: Page, handle: ElementHandle, mobile: boolean): Promise<boolean> {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return false;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (mobile) await page.touchscreen.tap(x, y);
  else {
    await page.mouse.move(x, y, { steps: 2 });
    await page.mouse.click(x, y);
  }
  return true;
}

/** Click through setup steps (open the dialog, then press what is inside it). */
export async function runSteps(page: Page, steps: TargetLocator[] | undefined, mobile: boolean): Promise<string | null> {
  for (const step of steps ?? []) {
    const h = await resolveTarget(page, step);
    if (!h) return `Could not find setup step ${step.css}`;
    if (!(await pointAndClick(page, h, mobile))) return `Setup step ${step.css} has no box`;
    await page.waitForTimeout(250);
    await settle(page, 1200);
  }
  return null;
}

/**
 * Start each run from a clean slate: what one run stores (a dismissed banner, a planted seed,
 * a signed-out flag) must not change what the next run sees. Clears cookies, storage, IndexedDB,
 * caches and service workers for the app's origin.
 */
export async function resetOrigin(page: Page, baseUrl: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  let cdp = cdpByPage.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    cdpByPage.set(page, cdp);
  }
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }).catch(() => {});
}
const cdpByPage = new WeakMap<Page, import("playwright").CDPSession>();

export interface PressResult {
  capture: Capture | null;
  requests: string[];
  shots: { before?: Buffer; after?: Buffer };
  checkpoint?: unknown;
  /** Full-viewport pixels differed before and after (catches canvas and WebGL feedback the DOM cannot see). */
  pixelsChanged?: boolean;
  /** Press-to-pixels latency from screencast frames (canvas mode). */
  pixelMs?: number | null;
  hover?: HoverResult;
  error?: string;
}

/** Watch a route with nobody touching it, and list the elements that change on their own. */
export async function idleAmbient(page: Page, windowMs: number): Promise<string[]> {
  await page.evaluate("window.__fc.arm(null, [])");
  await page.waitForTimeout(110);
  await page.evaluate("window.__fc.go()");
  await page.waitForTimeout(windowMs + 300);
  await page.evaluate("window.__fc.disarm()");
  return (await page.evaluate("window.__fc.ambientReport()")) as string[];
}

async function neutralPointer(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(vp.width - 2, vp.height - 2);
}

/**
 * Press a target like a person would (hover, hold about 90 ms, release; or tap on touch viewports)
 * and watch the page for `windowMs`. Returns what the in-page instrument saw plus the requests the
 * press fired. With `hover`, it also records what moved or appeared when the pointer arrived.
 */
export async function press(
  page: Page,
  handle: ElementHandle,
  opts: {
    windowMs: number;
    screenshots?: boolean;
    groupAttribute?: string;
    ambient?: string[];
    mobile?: boolean;
    hover?: boolean;
    screencast?: boolean;
    checkpoint?: { afterReleaseMs: number; expr: string };
  },
): Promise<PressResult> {
  const requests: string[] = [];
  const onRequest = (req: { resourceType(): string; url(): string }) => {
    const type = req.resourceType();
    if (type === "fetch" || type === "xhr") requests.push(req.url());
  };
  const shots: PressResult["shots"] = {};
  let hover: HoverResult | undefined;
  let stopCast: (() => Promise<{ ts: number; data: string }[]>) | null = null;
  try {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) return { capture: null, requests, shots, error: "target has no box" };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (!opts.mobile) {
      if (opts.hover) {
        await neutralPointer(page);
        await page.waitForTimeout(80);
        await page.evaluate(([el, amb]) => (window as any).__fc.hoverSnap(el, amb), [handle, opts.ambient ?? []] as const);
      }
      await page.mouse.move(cx, cy, { steps: 2 });
      await page.waitForTimeout(160); // let hover styles settle so they are not counted as feedback
      await settle(page, 800);
      if (opts.hover) {
        hover = (await page.evaluate("window.__fc.hoverDiff()")) as HoverResult;
        if (hover.shifted.length || hover.appeared) {
          // Move away and look again: a hover effect undoes itself; something changing on its own does not.
          await neutralPointer(page);
          await page.waitForTimeout(300);
          await settle(page, 800);
          hover = (await page.evaluate("window.__fc.hoverRecheck()")) as HoverResult;
          await page.mouse.move(cx, cy, { steps: 2 });
          await page.waitForTimeout(160);
          await settle(page, 800);
        }
      }
    }
    // Screenshots are cropped to the control's group (or the area around it) so the change is visible.
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (opts.screenshots) {
      clip = await handle.evaluate((node, attr) => {
        const el = node as Element;
        const g = (attr && el.closest(`[${attr}]`)) || el;
        const r = g.getBoundingClientRect();
        const pad = g === el ? 160 : 12;
        const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
        const w = Math.min(innerWidth - x, r.width + 2 * pad), h = Math.min(innerHeight - y, r.height + 2 * pad);
        return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
      }, opts.groupAttribute ?? "");
      shots.before = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", clip });
    }
    const fullBefore = await page.screenshot({ type: "jpeg", quality: 40, scale: "css" });
    if (opts.screencast) stopCast = await startScreencast(page);
    await page.evaluate(([el, ambient]) => (window as any).__fc.arm(el, ambient), [handle, opts.ambient ?? []] as const);
    await page.waitForTimeout(opts.screencast ? 400 : 110); // baseline: learn what moves on its own
    await page.evaluate("window.__fc.go()");
    const timeOrigin = (await page.evaluate("performance.timeOrigin")) as number;
    page.on("request", onRequest);
    if (opts.mobile) {
      await page.touchscreen.tap(cx, cy);
    } else {
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
    }
    let checkpoint: unknown;
    if (opts.checkpoint) {
      await page.waitForTimeout(opts.checkpoint.afterReleaseMs);
      checkpoint = await page.evaluate(opts.checkpoint.expr);
      await page.waitForTimeout(Math.max(0, opts.windowMs - opts.checkpoint.afterReleaseMs));
    } else {
      await page.waitForTimeout(opts.windowMs);
    }
    const capture = (await page.evaluate("window.__fc.disarm()")) as Capture & { err?: string | null; goAt?: number };
    page.off("request", onRequest);
    let pixelMs: number | null | undefined;
    if (stopCast) {
      const frames = await stopCast();
      stopCast = null;
      pixelMs = pixelLatency(frames, timeOrigin, capture);
    }
    let pixelsChanged: boolean | undefined;
    if (capture.firstChangeAt == null) {
      const fullAfter = await page.screenshot({ type: "jpeg", quality: 40, scale: "css" });
      pixelsChanged = !fullBefore.equals(fullAfter);
    }
    if (opts.screenshots) shots.after = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", clip });
    return { capture, requests: [...new Set(requests)], shots, checkpoint, pixelsChanged, pixelMs, hover, error: capture.err ?? undefined };
  } catch (e) {
    page.off("request", onRequest);
    if (stopCast) await stopCast().catch(() => []);
    return { capture: null, requests, shots, hover, error: String(e) };
  }
}

/** Record compositor frames through the DevTools protocol (Chromium only). */
async function startScreencast(page: Page): Promise<() => Promise<{ ts: number; data: string }[]>> {
  const cdp = await page.context().newCDPSession(page);
  const frames: { ts: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ ts: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 35, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    return frames;
  };
}

/**
 * Time from the click to the first new frame that looks different. Screencast frames arrive only
 * when something repaints, so a steady page sends none; a page that repaints during the quiet
 * baseline is animating on its own and cannot be timed this way.
 */
export function pixelLatency(frames: { ts: number; data: string }[], timeOrigin: number, c: Capture & { goAt?: number }): number | null {
  const goEpoch = timeOrigin + (c.goAt ?? 0);
  const inputAt = c.clickAt ?? c.upAt ?? c.downAt;
  if (inputAt == null) return null;
  const clickEpoch = timeOrigin + inputAt;
  const baseline = frames.filter((f) => f.ts < goEpoch);
  const last = baseline.at(-1);
  const distinctBaseline = new Set(baseline.slice(-6).map((f) => f.data.length)).size;
  if (distinctBaseline > 2) return null; // repainting on its own
  for (const f of frames) {
    if (f.ts < clickEpoch) continue;
    if (last && f.data === last.data) continue;
    return Math.max(0, Math.round(f.ts - clickEpoch));
  }
  return null;
}

/** Type one character into a field and time the echo; then check whether it complained early. */
export async function typeOne(
  page: Page,
  handle: ElementHandle,
  opts: { ambient?: string[]; mobile?: boolean },
): Promise<{ capture: Capture | null; early: { earlyError: boolean; errorText: string | null } | null; error?: string }> {
  try {
    await handle.scrollIntoViewIfNeeded();
    if (opts.mobile) await handle.tap();
    else await handle.click();
    await page.waitForTimeout(150);
    await settle(page, 800);
    const type = ((await handle.getAttribute("type")) ?? "text").toLowerCase();
    const ch = type === "number" || type === "tel" ? "4" : "k";
    await page.evaluate(([el, ambient]) => (window as any).__fc.arm(el, ambient), [handle, opts.ambient ?? []] as const);
    await page.waitForTimeout(110);
    await page.evaluate("window.__fc.go()");
    await page.keyboard.press(ch);
    await page.waitForTimeout(500); // a pause in typing, without leaving the field
    const early = (await page.evaluate((el) => (window as any).__fc.earlyErrorScan(el), handle)) as { earlyError: boolean; errorText: string | null };
    await page.waitForTimeout(200);
    const capture = (await page.evaluate("window.__fc.disarm()")) as Capture & { err?: string | null };
    return { capture, early, error: capture.err ?? undefined };
  } catch (e) {
    return { capture: null, early: null, error: String(e) };
  }
}
