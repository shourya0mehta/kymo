// End-to-end: audit the zoo, try a naive fix and a proper fix for the teleporting panel,
// and check that verify reverts the first and keeps the second. Takes about 1.5 minutes.
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { audit } from "../../src/audit.js";
import { loadConfig } from "../../src/config.js";
import { verify } from "../../src/verify.js";
import { ZOO_DIR } from "../../src/eval.js";
// @ts-expect-error plain JS module
import { startZoo } from "../../zoo/server.mjs";

const PORT = 4311;

describe("fix and verify loop", () => {
  it("reverts a fix that animates a layout property and keeps one that uses transform", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-zoo-"));
    cpSync(ZOO_DIR, dir, { recursive: true });
    const css = join(dir, "zoo.css");
    const original = readFileSync(css, "utf8");
    const server = await startZoo(PORT, dir);
    try {
      const config = loadConfig(undefined, { baseUrl: `http://localhost:${PORT}`, outDir: join(dir, ".kymo") });
      const before = await audit(config, { screenshots: false });
      const target = before.findings.find((f) => f.rule === "MOT-09" && f.group === "teleport-panel");
      expect(target).toBeTruthy();
      const only = before.trace.filter((i) => i.target.group === "teleport-panel");

      // Naive fix: transition the left offset. It removes the teleport but animates layout.
      writeFileSync(css, original.replace(".slab.moved { left: 220px; }", ".slab.moved { left: 220px; }\n.slab:not(.slab-good) { transition: left 200ms var(--ease-out); }"));
      const naive = await audit(config, { trace: only, screenshots: false });
      const v1 = verify(before, naive, { target: target!.key });
      expect(v1.decision).toBe("revert");
      expect(v1.introduced.some((f) => f.rule === "MOT-08")).toBe(true);

      // Proper fix: move with transform on the profile's move curve.
      writeFileSync(css, original.replace(
        ".slab.moved { left: 220px; }",
        ".slab:not(.slab-good) { transition: transform 200ms cubic-bezier(0.2, 0, 0.38, 0.9); }\n.slab.moved:not(.slab-good) { transform: translateX(220px); }",
      ));
      const proper = await audit(config, { trace: only, screenshots: false });
      const v2 = verify(before, proper, { target: target!.key });
      expect(v2.decision).toBe("keep");
      expect(v2.resolved.map((f) => f.key)).toContain(target!.key);
    } finally {
      server.close();
    }
  }, 240_000);
});
