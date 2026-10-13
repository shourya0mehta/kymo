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
  /** file:line:col stamped by the kymo Babel plugin (data-kymo-src), when present */
  src?: string | null;
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

/**
 * click  press a control like a person would
 * type   type one character into a field
 * dialog open a dialog from the keyboard, then check focus and Escape
 * hover  check content that appears on hover (WCAG 1.4.13)
 * page   per-route sweep: load shift, scrolling, Tab walk, tap targets, template look
 */
export type InteractionKind = "click" | "type" | "dialog" | "hover" | "page";

export interface Interaction {
  key: string; // stable id: [viewport] route + kind + locator summary
  route: string;
  kind: InteractionKind;
  target: TargetLocator; // for page sweeps this is the body
  /** Controls clicked first, in order, to reach this one (a dialog's buttons, a menu's items). */
  steps?: TargetLocator[];
  /** Viewport name; omitted means the first configured viewport. */
  viewport?: string;
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

export interface Vanish {
  el: ElementInfo;
  t: number;
  areaShare: number;
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

export interface LongFrame {
  start: number;
  duration: number;
  blocking: number;
  /** ms spent running script, and in style and layout; a long frame with neither was the machine, not the page */
  script?: number;
  render?: number;
  scripts: { url: string; fn: string; invoker: string; charPos: number; duration: number }[];
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
  vanishes: Vanish[];
  animations: AnimationRecord[];
  longFrames: LongFrame[];
  /** Controls that became visible during the window (a dialog's buttons, a menu's items). */
  newControls: TargetLocator[];
  /** A dialog that opened during the window. */
  dialog: ElementInfo | null;
  errorUi: { found: boolean; newText: string[]; blank: boolean } | null;
  viewport: { w: number; h: number };
  goAt?: number;
}

export interface HoverResult {
  /** Neighbours that moved or resized when the pointer arrived (bolding, borders that change size). */
  shifted: { el: ElementInfo; px: number }[];
  /** Content that appeared on hover (tooltips, hover cards). */
  appeared: ElementInfo | null;
}

export interface TypingResult {
  echoMs: number | null; // keydown to the character on screen
  earlyError: boolean; // an error appeared after one character, before leaving the field
  errorText: string | null;
}

export interface DialogResult {
  opened: boolean;
  focusMovedIn: boolean;
  escapeCloses: boolean;
  focusReturned: boolean;
  dialog: ElementInfo | null;
}

export interface HoverContentResult {
  content: ElementInfo | null;
  hoverable: boolean; // stays while the pointer moves onto it
  dismissible: boolean; // Escape hides it without moving the pointer
}

export interface FocusIssue {
  el: ElementInfo;
  visible: boolean; // focus changed how it looks
  obscured: boolean; // covered by something else while focused
}

export interface TargetIssue {
  el: ElementInfo;
  w: number;
  h: number;
  crowded: boolean; // a 24 px circle around it overlaps another target
}

export interface AiTells {
  tells: { id: string; label: string; detail: string }[];
}

export interface PageScan {
  cls: number;
  clsSource: ElementInfo | null;
  longFrames: LongFrame[];
  reveals: AnimationRecord[]; // animations started by scrolling
  sections: number; // top-level sections seen while scrolling
  revealedSections: number;
  focus: FocusIssue[];
  focusables: number;
  targets: TargetIssue[]; // under the WCAG minimum (thresholds.targetPx)
  touchTargets?: TargetIssue[]; // touch viewports only: under thresholds.touchTargetPx
  ai: AiTells;
}

export interface CssRuleSource {
  file: string;
  line: number;
  selector: string;
  motion: boolean; // the rule sets transition or animation
}

export interface SourceInfo {
  markup?: string | null; // file:line:col from data-kymo-src
  rules?: CssRuleSource[];
  handler?: string | null; // file:line:col of the element's own click/key handler
  script?: string | null; // file:line:col of the script behind a long frame
}

export type RunMode = "normal" | "reduced-motion" | "slow-network" | "server-error" | "canvas";

export interface InteractionRun {
  interaction: Interaction;
  mode: RunMode;
  capture: Capture | null;
  requests: string[];
  error?: string;
  /** No DOM change was seen, but the viewport's pixels changed (canvas, WebGL, video). */
  pixelsChanged?: boolean;
  /** canvas mode: press-to-pixels latency measured from screencast frames */
  pixelMs?: number | null;
  /** slow-network mode: was the screen different from before the press, 1 s after release? */
  pending?: { changed: boolean; textChanged: boolean; targetChanged: boolean; busy: boolean };
  hover?: HoverResult;
  typing?: TypingResult;
  dialog?: DialogResult;
  hoverContent?: HoverContentResult;
  page?: PageScan;
  /** Where in the source the involved elements are styled and handled, keyed by element CSS path. */
  sources?: Record<string, SourceInfo>;
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
  viewport?: string; // where it was measured (omitted: the first configured viewport)
  viewports?: string[]; // every viewport it showed up on
  element?: ElementInfo | null;
  group: string; // element group, "@page" for route-level findings, "@app" for app-level ones
  metrics?: Record<string, number | string | boolean | null>;
  fix: string; // guidance for whoever fixes it (usually Claude)
  source?: SourceInfo;
  shots?: { before?: string; after?: string };
}

export interface MotionInventory {
  durations: number[]; // distinct declared ms values in same-origin stylesheets, sorted (what VIS-08 counts)
  easings: string[]; // distinct declared easing curves, normalised (what VIS-08 counts; linear excluded there)
  runtime: { durations: number[]; easings: string[] }; // values seen running during the replayed interactions
  sources: { durations: Record<string, number>; easings: Record<string, number> };
  hasReducedMotionQuery: boolean;
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile?: boolean; // touch input, no hover, mobile meta viewport
}

export interface Thresholds {
  feedbackMs: number; // FEEL-01
  deadMs: number; // FEEL-03
  longFrameMs: number; // FEEL-04
  typingMs: number; // FEEL-05
  maxDurationMs: number; // MOT-01
  jumpPx: number; // MOT-09 teleport
  popShare: number; // MOT-09 pop and MOT-10 vanish, share of the viewport
  sprawlDurations: number; // VIS-08
  sprawlEasings: number; // VIS-08
  clsWarn: number; // STAB-01
  clsError: number; // STAB-01
  targetPx: number; // CRAFT-04 (WCAG 2.5.8)
  touchTargetPx: number; // CRAFT-04 on touch viewports
  aiTells: number; // AI-01: how many tells before it counts
}

export interface AuditResult {
  tool: "kymo";
  version: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  routes: string[];
  viewport: { width: number; height: number };
  viewports: Viewport[];
  thresholds: Thresholds;
  trace: Interaction[];
  runs: InteractionRun[];
  findings: Finding[];
  inventory: MotionInventory;
  counts: Record<Severity, number>;
}

export interface Probes {
  reducedMotion: boolean;
  failure: boolean;
  typing: boolean;
  hover: boolean;
  dialogs: boolean;
  nested: boolean;
  page: boolean;
  canvas: boolean;
  sources: boolean;
}

export interface Config {
  baseUrl: string;
  routes: string[];
  /** Kept for older configs: the first viewport when `viewports` is not set. */
  viewport: { width: number; height: number };
  viewports: Viewport[];
  groupAttribute: string;
  include: string; // CSS selector for interactive targets
  exclude: string[]; // CSS selectors to skip
  windowMs: number; // how long to watch after a click
  maxInteractions: number;
  concurrency: number;
  /** Clear the app's cookies and storage before every run, so runs cannot leak state into each other. */
  isolate: boolean;
  /** Playwright storage state (cookies and localStorage) to start from, for signed-in pages. */
  storageState?: string;
  /** Controls whose accessible name matches are never pressed (regex source, case-insensitive). */
  skipNames: string;
  thresholds: Thresholds;
  probes: Probes;
  outDir: string;
}
