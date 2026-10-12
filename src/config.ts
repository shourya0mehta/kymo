import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";

export const DEFAULT_INCLUDE = [
  "button",
  '[role="button"]',
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  'a[href^="#"]',
  "[data-kymo-click]",
].join(", ");

export const DEFAULTS: Config = {
  baseUrl: "http://localhost:4173",
  routes: ["/"],
  viewport: { width: 1280, height: 800 },
  groupAttribute: "data-kymo-group",
  include: DEFAULT_INCLUDE,
  exclude: [],
  windowMs: 1200,
  maxInteractions: 60,
  probes: { reducedMotion: true, failure: true },
  outDir: ".kymo",
};

export function loadConfig(path?: string, overrides: Partial<Config> = {}): Config {
  let fromFile: Partial<Config> = {};
  const file = path ?? (existsSync("kymo.config.json") ? "kymo.config.json" : undefined);
  if (file) {
    fromFile = JSON.parse(readFileSync(resolve(file), "utf8"));
  }
  const merged: Config = {
    ...DEFAULTS,
    ...fromFile,
    ...stripUndefined(overrides),
    viewport: { ...DEFAULTS.viewport, ...(fromFile.viewport ?? {}), ...(overrides.viewport ?? {}) },
    probes: { ...DEFAULTS.probes, ...(fromFile.probes ?? {}), ...(overrides.probes ?? {}) },
  };
  merged.baseUrl = merged.baseUrl.replace(/\/$/, "");
  if (!merged.routes.length) merged.routes = ["/"];
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
