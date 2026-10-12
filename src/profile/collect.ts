import type { Page } from "playwright";
import type { Config } from "../types.js";
import { loadAndSettle, openSession } from "../browser/session.js";
import type { ProfileSignals } from "./infer.js";

type PageSignals = Omit<ProfileSignals, "keyListeners" | "pointerListeners">;

/** Count event listeners on window and document through the DevTools protocol. */
async function listenerCounts(page: Page): Promise<{ key: number; pointer: number }> {
  const cdp = await page.context().newCDPSession(page);
  let key = 0, pointer = 0;
  try {
    for (const expr of ["window", "document"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: expr });
      if (!result.objectId) continue;
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
      for (const l of listeners) {
        if (/^key(down|up|press)$/.test(l.type)) key++;
        if (/^(pointer(down|move)|touch(start|move)|mousedown)$/.test(l.type)) pointer++;
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  return { key, pointer };
}

/** Visit each route and collect the signals that point to a motion profile. */
export async function collectSignals(config: Config): Promise<ProfileSignals> {
  const session = await openSession(config);
  const all: ProfileSignals[] = [];
  try {
    const { page } = await session.newPage();
    for (const route of config.routes) {
      await loadAndSettle(page, config.baseUrl + route);
      const s = (await page.evaluate("window.__fc.profileSignals()")) as PageSignals;
      const l = await listenerCounts(page);
      all.push({ ...s, keyListeners: l.key, pointerListeners: l.pointer });
    }
  } finally {
    await session.close();
  }
  const avg = (k: keyof ProfileSignals) => all.reduce((n, s) => n + Number(s[k]), 0) / all.length;
  const any = (k: keyof ProfileSignals) => all.some((s) => Boolean(s[k]));
  return {
    controlsInView: Math.round(avg("controlsInView")),
    tables: Math.round(avg("tables")),
    keyListeners: Math.round(avg("keyListeners")),
    proseShare: avg("proseShare"),
    longBlocks: Math.round(avg("longBlocks")),
    imageShare: avg("imageShare"),
    hero: any("hero"),
    displayHeading: any("displayHeading"),
    serif: any("serif"),
    touchAction: any("touchAction"),
    draggable: Math.round(avg("draggable")),
    pointerListeners: Math.round(avg("pointerListeners")),
  };
}
