import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Capture, Config, TargetLocator } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const INPAGE = readFileSync(join(here, "inpage.js"), "utf8");

export interface Session {
  browser: Browser;
  newPage(opts?: { reducedMotion?: boolean }): Promise<{ context: BrowserContext; page: Page }>;
  close(): Promise<void>;
}

export async function openSession(config: Config): Promise<Session> {
  const browser = await chromium.launch({ headless: true });
  return {
    browser,
    async newPage(opts = {}) {
      const context = await browser.newContext({
        viewport: config.viewport,
        deviceScaleFactor: 1,
        reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
      });
      await context.addInitScript(`window.__fcGroupAttr = ${JSON.stringify(config.groupAttribute)};`);
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

export interface PressResult {
  capture: Capture | null;
  requests: string[];
  shots: { before?: Buffer; after?: Buffer };
  checkpoint?: unknown;
  /** Full-viewport pixels differed before and after (catches canvas and WebGL feedback the DOM cannot see). */
  pixelsChanged?: boolean;
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

/**
 * Press a target like a person would (hover, hold about 90 ms, release) and watch the page
 * for `windowMs`. Returns what the in-page instrument saw plus the requests the press fired.
 */
export async function press(
  page: Page,
  handle: ElementHandle,
  opts: {
    windowMs: number;
    screenshots?: boolean;
    groupAttribute?: string;
    ambient?: string[];
    checkpoint?: { afterReleaseMs: number; expr: string };
  },
): Promise<PressResult> {
  const requests: string[] = [];
  const onRequest = (req: { resourceType(): string; url(): string }) => {
    const type = req.resourceType();
    if (type === "fetch" || type === "xhr") requests.push(req.url());
  };
  const shots: PressResult["shots"] = {};
  try {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) return { capture: null, requests, shots, error: "target has no box" };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(160); // let hover styles settle so they are not counted as feedback
    await settle(page, 800);
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
    await page.evaluate(([el, ambient]) => (window as any).__fc.arm(el, ambient), [handle, opts.ambient ?? []] as const);
    await page.waitForTimeout(110); // baseline: learn what moves on its own
    await page.evaluate("window.__fc.go()");
    page.on("request", onRequest);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
    let checkpoint: unknown;
    if (opts.checkpoint) {
      await page.waitForTimeout(opts.checkpoint.afterReleaseMs);
      checkpoint = await page.evaluate(opts.checkpoint.expr);
      await page.waitForTimeout(Math.max(0, opts.windowMs - opts.checkpoint.afterReleaseMs));
    } else {
      await page.waitForTimeout(opts.windowMs);
    }
    const capture = (await page.evaluate("window.__fc.disarm()")) as Capture & { err?: string | null };
    page.off("request", onRequest);
    let pixelsChanged: boolean | undefined;
    if (capture.firstChangeAt == null) {
      const fullAfter = await page.screenshot({ type: "jpeg", quality: 40, scale: "css" });
      pixelsChanged = !fullBefore.equals(fullAfter);
    }
    if (opts.screenshots) shots.after = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", clip });
    return { capture, requests: [...new Set(requests)], shots, checkpoint, pixelsChanged, error: capture.err ?? undefined };
  } catch (e) {
    page.off("request", onRequest);
    return { capture: null, requests, shots, error: String(e) };
  }
}
