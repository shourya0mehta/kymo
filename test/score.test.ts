import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scoreAgainstAnswers } from "../src/eval.js";
import type { AuditResult, Finding } from "../src/types.js";

const f = (rule: string, group: string): Finding => ({
  id: rule, key: `${rule}|${group}`, rule, severity: "warning", evidence: "", title: "", message: "", fix: "", group,
});

describe("zoo scoring", () => {
  it("counts true positives, misses and extras on (group, rule) pairs", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-"));
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ expected: { a: ["R1"], b: ["R2", "R3"], clean: [] } }));
    const res = { findings: [f("R1", "a"), f("R1", "a"), f("R2", "b"), f("R9", "clean"), f("R1", "elsewhere")] } as unknown as AuditResult;
    const s = scoreAgainstAnswers(res, answers);
    expect(s.tp).toBe(2);
    expect(s.fn).toBe(1); // R3 missed
    expect(s.fp).toBe(2); // R9 on a clean twin, plus one unattributed finding
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(2 / 3);
  });
});
