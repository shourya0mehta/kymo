// kymo/babel: stamps each host JSX element with where it was written, so findings can say
// "src/components/Save.tsx:42:7" instead of a CSS path. Development builds only, no runtime code.
//
//   // vite.config.ts
//   react({ babel: { plugins: ["kymo/babel"] } })
//
// Components (<Button>) are left alone; the stamp lands on the DOM elements they render
// (<button>), which is what the browser sees. Set `production: true` to stamp production builds too.
import { relative, isAbsolute } from "node:path";
import type { PluginObj, types as BabelTypes } from "@babel/core";

export interface KymoBabelOptions {
  /** attribute name (default data-kymo-src; the in-page instrument reads this one) */
  attribute?: string;
  /** paths are written relative to this folder (default: Babel's cwd) */
  root?: string;
  /** also stamp when NODE_ENV is production */
  production?: boolean;
}

interface State {
  filename?: string;
  cwd?: string;
  opts?: KymoBabelOptions;
}

/** "src/App.tsx:12:5" for a file and a 1-based line and 0-based column. */
export function stampFor(filename: string | undefined, root: string, line: number, column: number): string {
  let file = filename ?? "unknown";
  if (isAbsolute(file)) file = relative(root, file);
  return `${file.split("\\").join("/")}:${line}:${column + 1}`;
}

export default function kymoBabel(api: { types: typeof BabelTypes }, options: KymoBabelOptions = {}): PluginObj<State> {
  const t = api.types;
  const attr = options.attribute ?? "data-kymo-src";
  const off = !options.production && process.env.NODE_ENV === "production";
  return {
    name: "kymo-source",
    visitor: {
      JSXOpeningElement(path, state) {
        if (off) return;
        const name = path.node.name;
        if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return; // host elements only
        if (name.name === "fragment") return;
        const has = path.node.attributes.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === attr);
        if (has || !path.node.loc) return;
        const root = options.root ?? state.cwd ?? process.cwd();
        const value = stampFor(state.filename, root, path.node.loc.start.line, path.node.loc.start.column);
        path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier(attr), t.stringLiteral(value)));
      },
    },
  };
}
