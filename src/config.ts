import { readFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import type { Config, Probes, Thresholds, Viewport } from "./types.js";

export const DEFAULT_INCLUDE = [
  "button",
  '[role="button"]',
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'a[href^="#"]',
  "[data-kymo-click]",
].join(", ");

/** Text fields the typing probe tries. */
export const TYPE_INCLUDE = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="email"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="number"]',
  "textarea",
].join(", ");

/**
 * Never pressed by default: leaving the app, signing out, paying, and account deletion. Anything else
 * destructive in your app belongs in `exclude`, and kymo should run against development data.
 */
export const DEFAULT_SKIP_NAMES =
  "^(log ?out|sign ?out)$|sign (in|up) with|continue with (google|github|apple|microsoft|facebook)|^(pay|buy|purchase|place order|checkout)\\b|delete (my )?account";

export const VIEWPORT_PRESETS: Record<string, Viewport> = {
  desktop: { name: "desktop", width: 1280, height: 800 },
  laptop: { name: "laptop", width: 1440, height: 900 },
  tablet: { name: "tablet", width: 820, height: 1180, mobile: true },
  mobile: { name: "mobile", width: 390, height: 844, mobile: true },
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  feedbackMs: 100,
  deadMs: 1000,
  longFrameMs: 100,
  typingMs: 100,
  maxDurationMs: 500,
  jumpPx: 24,
  popShare: 0.02,
  sprawlDurations: 8,
  sprawlEasings: 5,
  clsWarn: 0.1,
  clsError: 0.25,
  targetPx: 24,
  touchTargetPx: 44,
  aiTells: 3,
};

export const DEFAULT_PROBES: Probes = {
  reducedMotion: true,
  failure: true,
  typing: true,
  hover: true,
  dialogs: true,
  nested: true,
  page: true,
  canvas: true,
  sources: true,
};

/** Half the cores, between 1 and 4: parallel runs share the CPU, and timing gets noisy past that. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
}

export const DEFAULTS: Config = {
  baseUrl: "http://localhost:4173",
  routes: ["/"],
  viewport: { width: 1280, height: 800 },
  viewports: [VIEWPORT_PRESETS.desktop],
  groupAttribute: "data-kymo-group",
  include: DEFAULT_INCLUDE,
  exclude: [],
  windowMs: 1500, // long enough for a response that waits on a fetch or an image
  maxInteractions: 60,
  concurrency: 1,
  isolate: true,
  skipNames: DEFAULT_SKIP_NAMES,
  thresholds: DEFAULT_THRESHOLDS,
  probes: DEFAULT_PROBES,
  outDir: ".kymo",
};

/** Accepts preset names ("desktop", "mobile") or full viewport objects. */
export function parseViewports(v: Array<string | Viewport> | string | undefined): Viewport[] | undefined {
  if (v == null) return undefined;
  const list = typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
  return list.map((x) => {
    if (typeof x !== "string") return x;
    const m = x.match(/^(?:([A-Za-z][\w-]*):)?(\d+)x(\d+)$/);
    if (m) return { name: m[1] ?? `${m[2]}x${m[3]}`, width: Number(m[2]), height: Number(m[3]) };
    const p = VIEWPORT_PRESETS[x];
    if (!p) throw new Error(`Unknown viewport "${x}". Use ${Object.keys(VIEWPORT_PRESETS).join(", ")} or WIDTHxHEIGHT.`);
    return p;
  });
}

type ConfigOverrides = Omit<Partial<Config>, "viewports" | "thresholds" | "probes"> & {
  viewports?: Array<string | Viewport> | string;
  thresholds?: Partial<Thresholds>;
  probes?: Partial<Probes>;
};

export function loadConfig(path?: string, overrides: ConfigOverrides = {}): Config {
  let fromFile: ConfigOverrides = {};
  const file = path ?? (existsSync("kymo.config.json") ? "kymo.config.json" : undefined);
  if (file) {
    fromFile = JSON.parse(readFileSync(resolve(file), "utf8"));
  }
  const o = stripUndefined(overrides);
  const viewports =
    parseViewports(o.viewports) ??
    parseViewports(fromFile.viewports) ??
    (fromFile.viewport ? [{ name: "desktop", ...fromFile.viewport }] : DEFAULTS.viewports);
  const merged: Config = {
    ...DEFAULTS,
    ...(fromFile as Partial<Config>),
    ...(o as Partial<Config>),
    viewports,
    viewport: { width: viewports[0].width, height: viewports[0].height },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(fromFile.thresholds ?? {}), ...(o.thresholds ?? {}) },
    probes: { ...DEFAULT_PROBES, ...(fromFile.probes ?? {}), ...(o.probes ?? {}) },
    concurrency: o.concurrency ?? fromFile.concurrency ?? defaultConcurrency(),
  };
  // signed-in runs keep their storage unless told otherwise
  if (merged.storageState && (o.isolate ?? fromFile.isolate) === undefined) merged.isolate = false;
  merged.baseUrl = merged.baseUrl.replace(/\/$/, "");
  if (!merged.routes.length) merged.routes = ["/"];
  return merged;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
