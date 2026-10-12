// Shared types for the engine. Everything that crosses the browser boundary is plain JSON.

export type Severity = "error" | "warning" | "suggestion";
export type Evidence = string; // e.g. "Study", "Standard (AA)", "Practitioner"

export interface ElementInfo {
  tag: string;
  id: string | null;
  testid: string | null;
  group: string | null;
  text: string;
  css: string;
  role?: string | null;
}

/** How to find an interaction target again on a later run. Tried in order. */
export interface TargetLocator {
  id?: string;
  testid?: string;
  role?: string;
  name?: string;
  css: string;
  text?: string;
  group?: string | null;
}

export interface Interaction {
  key: string; // stable id: route + locator summary
  route: string;
  kind: "click";
  target: TargetLocator;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Teleport {
  el: ElementInfo;
  frame: number;
  t: number;
  dx: number;
  dy: number;
  from: Rect;
  to: Rect;
}

export interface Pop {
  el: ElementInfo;
  frame: number;
  t: number;
  rect: Rect;
  areaShare: number; // of the viewport
  opacity: number;
  sinceInputMs: number;
}

export interface AnimationRecord {
  kind: string; // CSSTransition | CSSAnimation | Animation
  name: string | null;
  prop: string | null; // transitionProperty for CSS transitions
  target: ElementInfo | null;
  duration: number; // ms, may be Infinity encoded as -1
  delay: number;
  iterations: number; // -1 for infinite
  easing: string; // effective easing (timing or first keyframe)
  props: string[]; // animated properties
  computedTransitionProperty: string;
  transitionAll: boolean; // transition-property includes "all" with a non-zero duration
  declaredDuration: number; // the authored duration (CSS transitions can run shortened when reversed)
  enter: boolean; // target sits inside something that appeared during the capture
  afterScroll: boolean; // started after the click scrolled the page (likely scroll-triggered)
  t: number;
}

/** What the in-page instrument returns for one interaction window. */
export interface Capture {
  downAt: number | null;
  upAt: number | null;
  clickAt: number | null;
  firstChangeAt: number | null;
  firstChangeReasons: string[];
  changeWhileDown?: boolean; // the first change happened before the pointer was released
  frames: number;
  teleports: Teleport[];
  pops: Pop[];
  animations: AnimationRecord[];
  errorUi: { found: boolean; newText: string[]; blank: boolean } | null;
  viewport: { w: number; h: number };
}

export interface InteractionRun {
  interaction: Interaction;
  mode: "normal" | "reduced-motion" | "slow-network" | "server-error";
  capture: Capture | null;
  requests: string[];
  error?: string;
  /** No DOM change was seen, but the viewport's pixels changed (canvas, WebGL, video). */
  pixelsChanged?: boolean;
  /** slow-network mode: was the screen different from before the press, 1 s after release? */
  pending?: { changed: boolean; textChanged: boolean; targetChanged: boolean; busy: boolean };
  /** derived metrics */
  pressFeedback?: boolean;
  feedbackMs?: number | null; // from press (if feedback during press) or from click
  shots?: { before?: string; after?: string };
}

export interface Finding {
  id: string; // short, shell-safe form of key, e.g. MOT-09-3fa2c
  key: string; // stable across runs: rule | interaction | element
  rule: string;
  severity: Severity;
  evidence: Evidence;
  title: string;
  message: string;
  interaction?: string;
  route?: string;
  element?: ElementInfo | null;
  group: string; // element group, or "@app" for app-level findings
  metrics?: Record<string, number | string | boolean | null>;
  fix: string; // guidance for whoever fixes it (usually Claude)
  shots?: { before?: string; after?: string };
}

export interface MotionInventory {
  durations: number[]; // distinct declared ms values in same-origin stylesheets, sorted (what VIS-08 counts)
  easings: string[]; // distinct declared easing curves, normalised (what VIS-08 counts; linear excluded there)
  runtime: { durations: number[]; easings: string[] }; // values seen running during the replayed interactions
  sources: { durations: Record<string, number>; easings: Record<string, number> };
  hasReducedMotionQuery: boolean;
}

export interface AuditResult {
  tool: "feelcheck";
  version: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  routes: string[];
  viewport: { width: number; height: number };
  trace: Interaction[];
  runs: InteractionRun[];
  findings: Finding[];
  inventory: MotionInventory;
  counts: Record<Severity, number>;
}

export interface Config {
  baseUrl: string;
  routes: string[];
  viewport: { width: number; height: number };
  groupAttribute: string;
  include: string; // CSS selector for interactive targets
  exclude: string[]; // CSS selectors to skip
  windowMs: number; // how long to watch after a click
  maxInteractions: number;
  probes: { reducedMotion: boolean; failure: boolean };
  outDir: string;
}
