// Map elements and scripts on a live page back to source files through the DevTools protocol.
// CSS rules come from CSS.getMatchedStylesForNode, handlers from DOMDebugger.getEventListeners,
// and both are followed through source maps when the dev server provides them.
import type { CDPSession, Page } from "playwright";
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";
import { relative, isAbsolute } from "node:path";
import type { CssRuleSource, SourceInfo } from "../types.js";

interface SheetHeader {
  styleSheetId: string;
  sourceURL: string;
  sourceMapURL?: string;
  startLine: number;
  isInline: boolean;
  ownerNode?: number;
  origin: string;
}

interface ScriptInfo {
  url: string;
  sourceMapURL?: string;
}

const MOTION_PROP = /^(transition|animation)/;
const RELEVANT_PROP = /^(transition|animation|display|visibility|opacity|transform|translate|scale|rotate|left|top|right|bottom|inset|width|height|margin|padding|outline|box-shadow|font-weight|border)/;
const VENDOR = /node_modules|\.vite\/deps|react-dom|react\.development|chunk-|webpack\/runtime|\/@vite\/client|\/@react-refresh/;

export class SourceLocator {
  private cdp!: CDPSession;
  private sheets = new Map<string, SheetHeader>();
  private scripts = new Map<string, ScriptInfo>();
  private scriptsByUrl = new Map<string, ScriptInfo>();
  private maps = new Map<string, SourceMapConsumer | null>();
  private texts = new Map<string, string | null>();
  private ownerPaths = new Map<number, string | null>();
  private ready = false;

  constructor(private page: Page, private baseUrl: string) {}

  async init(): Promise<void> {
    if (this.ready) return;
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("CSS.styleSheetAdded", (e: { header: SheetHeader }) => this.sheets.set(e.header.styleSheetId, e.header));
    this.cdp.on("Debugger.scriptParsed", (e: { scriptId: string; url: string; sourceMapURL?: string }) => {
      const info = { url: e.url, sourceMapURL: e.sourceMapURL };
      this.scripts.set(e.scriptId, info);
      if (e.url) this.scriptsByUrl.set(e.url, info);
    });
    await this.cdp.send("DOM.enable");
    await this.cdp.send("CSS.enable");
    await this.cdp.send("Debugger.enable");
    // a `debugger;` statement in the app must not pause the page while the debugger is attached
    await this.cdp.send("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
    await this.cdp.send("DOM.getDocument", { depth: 0 });
    this.ready = true;
  }

  /** Call after each navigation: node ids and sheets belong to one document. */
  async reset(): Promise<void> {
    if (!this.ready) return this.init();
    await this.cdp.send("DOM.getDocument", { depth: 0 }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.ready) await this.cdp.detach().catch(() => {});
    this.ready = false;
  }

  /** Locate an element (by CSS path) in the source: its stamped markup, matching rules and own handlers. */
  async locate(css: string, opts: { markup?: string | null } = {}): Promise<SourceInfo> {
    const info: SourceInfo = {};
    if (opts.markup) info.markup = opts.markup;
    try {
      const { result } = await this.cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(css)})` });
      if (!result.objectId) return info;
      await this.cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await this.cdp.send("DOM.requestNode", { objectId: result.objectId });
      if (nodeId) info.rules = await this.rulesFor(nodeId);
      info.handler = await this.handlerFor(result.objectId);
      await this.cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    } catch {
      /* element gone or protocol refused: no source */
    }
    return info;
  }

  private async rulesFor(nodeId: number): Promise<CssRuleSource[]> {
    const res = (await this.cdp.send("CSS.getMatchedStylesForNode", { nodeId })) as {
      matchedCSSRules?: { rule: { selectorList: { text: string }; origin: string; styleSheetId?: string; style: { cssProperties: { name: string; value: string }[]; range?: { startLine: number; startColumn: number } } } }[];
    };
    const out: CssRuleSource[] = [];
    for (const m of res.matchedCSSRules ?? []) {
      const r = m.rule;
      if (r.origin !== "regular" || !r.styleSheetId || !r.style.range) continue;
      const props = r.style.cssProperties.filter((p) => p.value).map((p) => p.name);
      if (!props.some((p) => RELEVANT_PROP.test(p))) continue;
      if (/^(\*|html|body|:root)(\s|,|$)/.test(r.selectorList.text.trim())) continue;
      const sheet = this.sheets.get(r.styleSheetId);
      if (!sheet) continue;
      const loc = await this.sheetLocation(sheet, r.style.range.startLine, r.style.range.startColumn);
      out.push({ file: loc.file, line: loc.line, selector: r.selectorList.text, motion: props.some((p) => MOTION_PROP.test(p)) });
    }
    // later rules win in the cascade; show the most specific last-declared first
    return out.reverse().slice(0, 6);
  }

  private async sheetLocation(sheet: SheetHeader, line0: number, col0: number): Promise<{ file: string; line: number }> {
    const absLine = sheet.isInline ? sheet.startLine + line0 : line0;
    // Vite injects CSS as <style data-vite-dev-id="/abs/path.css">
    if (sheet.ownerNode) {
      const devPath = await this.ownerPath(sheet.ownerNode);
      if (devPath) {
        const mapped = await this.viaSourceMap(sheet.sourceMapURL, sheet.sourceURL, line0, col0);
        return mapped ?? { file: this.prettyPath(devPath), line: line0 + 1 };
      }
    }
    const mapped = await this.viaSourceMap(sheet.sourceMapURL, sheet.sourceURL, absLine, col0);
    if (mapped) return mapped;
    // a <style> in the page or a stylesheet built in script has no file of its own
    if (!sheet.sourceURL) return { file: "<constructed stylesheet>", line: line0 + 1 };
    if (sheet.isInline) return { file: `<style> in ${this.prettyPath(sheet.sourceURL) || "/"}`, line: absLine + 1 };
    return { file: this.prettyPath(sheet.sourceURL), line: absLine + 1 };
  }

  private async ownerPath(backendNodeId: number): Promise<string | null> {
    if (this.ownerPaths.has(backendNodeId)) return this.ownerPaths.get(backendNodeId)!;
    let path: string | null = null;
    try {
      const { node } = await this.cdp.send("DOM.describeNode", { backendNodeId });
      const attrs: string[] = node.attributes ?? [];
      const i = attrs.indexOf("data-vite-dev-id");
      if (i >= 0) path = attrs[i + 1];
    } catch {
      /* ignore */
    }
    this.ownerPaths.set(backendNodeId, path);
    return path;
  }

  private async handlerFor(objectId: string): Promise<string | null> {
    try {
      const { listeners } = (await this.cdp.send("DOMDebugger.getEventListeners", { objectId, depth: 0 })) as {
        listeners: { type: string; scriptId: string; lineNumber: number; columnNumber: number }[];
      };
      for (const l of listeners) {
        if (!/^(click|pointerdown|pointerup|mousedown|mouseup|keydown|input|change|submit|touchstart)$/.test(l.type)) continue;
        const script = this.scripts.get(l.scriptId);
        if (!script?.url || VENDOR.test(script.url)) continue;
        const mapped = await this.viaSourceMap(script.sourceMapURL, script.url, l.lineNumber, l.columnNumber);
        if (mapped && VENDOR.test(mapped.file)) continue;
        const loc = mapped ?? { file: this.prettyPath(script.url), line: l.lineNumber + 1, column: l.columnNumber + 1 };
        return `${loc.file}:${loc.line}${"column" in loc && loc.column ? `:${loc.column}` : ""}`;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** A script position from a long animation frame (URL + character offset) as file:line:col. */
  async scriptPosition(url: string, charPos: number): Promise<string | null> {
    if (!url || charPos < 0 || VENDOR.test(url)) return null;
    const text = await this.fetchText(url);
    if (text == null) return `${this.prettyPath(url)}`;
    const before = text.slice(0, charPos);
    const line0 = (before.match(/\n/g) ?? []).length;
    const col0 = charPos - (before.lastIndexOf("\n") + 1);
    const script = this.scriptsByUrl.get(url);
    const mapUrl = script?.sourceMapURL ?? text.match(/\/\/# sourceMappingURL=(\S+)\s*$/)?.[1];
    const mapped = await this.viaSourceMap(mapUrl, url, line0, col0);
    if (mapped && VENDOR.test(mapped.file)) return null;
    const loc = mapped ?? { file: this.prettyPath(url), line: line0 + 1, column: col0 + 1 };
    return `${loc.file}:${loc.line}:${loc.column ?? 1}`;
  }

  private async viaSourceMap(mapUrl: string | undefined, fileUrl: string, line0: number, col0: number): Promise<{ file: string; line: number; column?: number } | null> {
    if (!mapUrl) return null;
    const consumer = await this.loadMap(mapUrl, fileUrl);
    if (!consumer) return null;
    const pos = consumer.originalPositionFor({ line: line0 + 1, column: col0, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
    if (!pos.source || pos.line == null) return null;
    return { file: this.prettyPath(pos.source), line: pos.line, column: (pos.column ?? 0) + 1 };
  }

  private async loadMap(mapUrl: string, fileUrl: string): Promise<SourceMapConsumer | null> {
    const key = mapUrl.startsWith("data:") ? `${fileUrl}#inline` : new URL(mapUrl, fileUrl || this.baseUrl).href;
    if (this.maps.has(key)) return this.maps.get(key)!;
    let consumer: SourceMapConsumer | null = null;
    try {
      let raw: string | null = null;
      if (mapUrl.startsWith("data:")) {
        const comma = mapUrl.indexOf(",");
        const meta = mapUrl.slice(0, comma);
        const body = mapUrl.slice(comma + 1);
        raw = meta.includes("base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
      } else {
        raw = await this.fetchText(key);
      }
      if (raw) consumer = new SourceMapConsumer(JSON.parse(raw) as RawSourceMap);
    } catch {
      consumer = null;
    }
    this.maps.set(key, consumer);
    return consumer;
  }

  private async fetchText(url: string): Promise<string | null> {
    if (this.texts.has(url)) return this.texts.get(url)!;
    let text: string | null = null;
    try {
      if (/^https?:/.test(url)) {
        const res = await this.page.request.get(url, { timeout: 5000 });
        if (res.ok()) text = await res.text();
      }
    } catch {
      text = null;
    }
    this.texts.set(url, text);
    return text;
  }

  /** URLs on the app's own origin become paths; absolute disk paths become relative to the working directory. */
  prettyPath(p: string): string {
    try {
      if (/^https?:/.test(p)) {
        const u = new URL(p);
        const base = new URL(this.baseUrl);
        if (u.origin === base.origin) p = decodeURIComponent(u.pathname).replace(/^\/@fs\//, "/");
        else return p;
      }
      p = p.replace(/^webpack:\/\/[^/]*\//, "").replace(/^file:\/\//, "").replace(/\?.*$/, "");
      if (isAbsolute(p) && p.startsWith(process.cwd())) return relative(process.cwd(), p);
      return p.replace(/^\/+/, "");
    } catch {
      return p;
    }
  }
}

export type SourcePreference = "motion" | "style" | "behavior";

/** Behaviour findings are fixed in script, motion findings in the rule that animates, the rest in CSS. */
export function preferenceFor(ruleId: string): SourcePreference {
  if (/^(FEEL-|WAIT-01|CRAFT-03|CRAFT-07|CRAFT-08|MOT-10)/.test(ruleId)) return "behavior";
  if (/^MOT-/.test(ruleId)) return "motion";
  return "style";
}

/** One-line summary of where to look, for messages and terminal output. */
export function sourceHint(s: SourceInfo | undefined, prefer: SourcePreference | "any" = "style"): string | null {
  if (!s) return null;
  if (s.markup) return s.markup;
  const rules = s.rules ?? [];
  const rule = (prefer === "motion" ? rules.find((x) => x.motion) : undefined) ?? rules[0];
  const ruleText = rule ? `${rule.file}:${rule.line} ${rule.selector}` : null;
  if (prefer === "behavior") return s.script ?? s.handler ?? ruleText;
  return ruleText ?? s.handler ?? s.script ?? null;
}
