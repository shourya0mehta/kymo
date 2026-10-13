import { describe, expect, it } from "vitest";
import { transformSync } from "@babel/core";
import syntaxJsx from "@babel/plugin-syntax-jsx";
import kymoBabel, { stampFor } from "../src/plugins/babel.js";

const run = (code: string, opts = {}) =>
  transformSync(code, { filename: "/repo/src/App.tsx", cwd: "/repo", babelrc: false, configFile: false, plugins: [syntaxJsx, [kymoBabel, opts]] })!.code!;

describe("kymo/babel", () => {
  it("stamps host elements with file:line:col", () => {
    const out = run(`const A = () => <div>\n  <button onClick={go}>Save</button>\n</div>;`);
    expect(out).toContain(`data-kymo-src="src/App.tsx:1:17"`);
    expect(out).toContain(`data-kymo-src="src/App.tsx:2:3"`);
  });
  it("leaves components, member expressions and existing stamps alone", () => {
    const out = run(`<Card><ui.Button/><a data-kymo-src="keep" /></Card>`);
    expect(out.match(/data-kymo-src/g)).toHaveLength(1);
    expect(out).toContain(`"keep"`);
  });
  it("is off in production unless asked", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(run(`<div/>`)).not.toContain("data-kymo-src");
      expect(run(`<div/>`, { production: true })).toContain("data-kymo-src");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
  it("writes forward slashes on every platform", () => {
    expect(stampFor("C:\\repo\\src\\App.tsx", "C:\\repo", 3, 0)).toMatch(/App\.tsx:3:1$/);
  });
});
