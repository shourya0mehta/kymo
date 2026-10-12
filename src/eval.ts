import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ZOO_DIR = join(here, "..", "zoo");

export interface EvalRow {
  group: string;
  expected: string[];
  found: string[];
  tp: string[];
  fn: string[];
  fp: string[];
}

export interface EvalScore {
  rows: EvalRow[];
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  unattributed: string[]; // findings outside any known group
}

/** Score an audit of the jank zoo against its answer key, on (group, rule) pairs. */
export function scoreAgainstAnswers(result: AuditResult, answersPath = join(ZOO_DIR, "answers.json")): EvalScore {
  const answers = JSON.parse(readFileSync(answersPath, "utf8")).expected as Record<string, string[]>;
  const foundByGroup = new Map<string, Set<string>>();
  const unattributed: string[] = [];
  for (const f of result.findings) {
    const g = f.group ?? "@app";
    if (!(g in answers)) {
      unattributed.push(`${f.rule} ${g}`);
      continue;
    }
    if (!foundByGroup.has(g)) foundByGroup.set(g, new Set());
    foundByGroup.get(g)!.add(f.rule);
  }
  const rows: EvalRow[] = [];
  let tp = 0, fp = 0, fn = 0;
  for (const [group, expected] of Object.entries(answers)) {
    const found = [...(foundByGroup.get(group) ?? [])].sort();
    const exp = new Set(expected);
    const row: EvalRow = {
      group,
      expected: [...expected].sort(),
      found,
      tp: found.filter((r) => exp.has(r)),
      fp: found.filter((r) => !exp.has(r)),
      fn: expected.filter((r) => !found.includes(r)),
    };
    tp += row.tp.length;
    fp += row.fp.length;
    fn += row.fn.length;
    rows.push(row);
  }
  fp += unattributed.length;
  return {
    rows,
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    unattributed,
  };
}

export function formatScore(s: EvalScore): string {
  const lines = [
    "group                 expected                     found                        result",
    "--------------------  ---------------------------  ---------------------------  ------",
  ];
  for (const r of s.rows) {
    const ok = r.fp.length === 0 && r.fn.length === 0;
    const res = ok ? "ok" : [r.fn.length ? `missed ${r.fn.join(",")}` : "", r.fp.length ? `extra ${r.fp.join(",")}` : ""].filter(Boolean).join("; ");
    lines.push(`${r.group.padEnd(20)}  ${(r.expected.join(",") || "(clean)").padEnd(27)}  ${(r.found.join(",") || "-").padEnd(27)}  ${res}`);
  }
  if (s.unattributed.length) lines.push(`unattributed: ${s.unattributed.join("; ")}`);
  lines.push("");
  lines.push(`precision ${(s.precision * 100).toFixed(0)}%  recall ${(s.recall * 100).toFixed(0)}%  (tp ${s.tp}, fp ${s.fp}, fn ${s.fn})`);
  return lines.join("\n");
}
