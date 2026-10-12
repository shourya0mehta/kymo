#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { audit, VERSION } from "./audit.js";
import { loadConfig } from "./config.js";
import { renderReport } from "./report/html.js";
import { verify, formatVerify } from "./verify.js";
import { collectSignals } from "./profile/collect.js";
import { inferProfile, PROFILES, type ProfileName } from "./profile/infer.js";
import { renderTokensCss, renderTokensJson } from "./profile/tokens.js";
import { RULES } from "./rules.js";
import { formatScore, scoreAgainstAnswers, ZOO_DIR } from "./eval.js";
import type { AuditResult, Config, Interaction, Severity } from "./types.js";

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const HELP = `feelcheck ${VERSION}: measure how a web app feels, then keep only the fixes that help.

Usage
  feelcheck audit [url]      Drive the app, measure, write .feelcheck/latest.json and report.html
      --config <file>          Config file (default: feelcheck.config.json if present)
      --routes /,/settings     Routes to visit
      --trace <file>           Replay a saved trace instead of discovering controls
      --only <a,b>             With --trace: replay only matching interactions (group, #id, key,
                               or position in the trace),
                               or @app for app-wide rules only. Saves to runs/<name>.json/.html.
      --out <dir>              Output folder (default .feelcheck)
      --save-as <name>         Also save the run as <out>/runs/<name>.json
      --fail-on <level>        Exit 1 if any finding is at least this severe (error|warning|suggestion)
      --no-screens             Skip before/after screenshots
  feelcheck verify --before <run.json> --after <run.json> [--target <id,id>]
                             Keep or revert a change. Exit 0 = keep, 3 = revert.
  feelcheck profile [url] [--write [file]]
                             Infer a motion profile and optionally write its token file
      --as <name>              Force a profile: productive, expressive, calm, physical
  feelcheck eval [--port 4199]
                             Audit the bundled jank zoo and score it against its answer key
  feelcheck zoo [--port 4173] Serve the jank zoo
  feelcheck rules            List the rules and their evidence
`;

function configFrom(args: Args): Config {
  const url = args._[1];
  const routes = str(args.routes)?.split(",").map((r) => r.trim()).filter(Boolean);
  return loadConfig(str(args.config), {
    baseUrl: url,
    routes,
    outDir: str(args.out),
  });
}

function writeRun(result: AuditResult, outDir: string, saveAs?: string, writeTrace = true) {
  mkdirSync(join(outDir, "runs"), { recursive: true });
  const json = JSON.stringify(result, null, 2);
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  writeFileSync(join(outDir, "latest.json"), json);
  writeFileSync(join(outDir, "runs", `${saveAs ?? stamp}.json`), json);
  if (writeTrace) writeFileSync(join(outDir, "trace.json"), JSON.stringify(result.trace, null, 2));
  writeFileSync(join(outDir, "report.html"), renderReport(result, outDir));
}

function matchesOnly(i: Interaction, o: string, index: number): boolean {
  if (/^\d+$/.test(o)) return Number(o) === index + 1; // position in the trace, 1-based
  return i.key === o || i.key.includes(o) || i.target.group === o || i.target.css === o || (!!i.target.id && `#${i.target.id}` === o);
}

/** What to pass to --only to replay the interaction behind a finding. */
function replayHint(result: AuditResult, f: AuditResult["findings"][number]): string {
  if (!f.interaction) return "@app";
  const n = result.trace.findIndex((t) => t.key === f.interaction);
  if (n < 0) return JSON.stringify(f.interaction);
  const i = result.trace[n];
  if (i.target.group && /^[\w-]+$/.test(i.target.group)) return i.target.group;
  if (i.target.id && /^[\w-]+$/.test(i.target.id)) return `#${i.target.id}`;
  return String(n + 1); // its position in trace.json: shell-safe when the name is not
}

function writeTargeted(result: AuditResult, outDir: string, name?: string): string {
  mkdirSync(join(outDir, "runs"), { recursive: true });
  const base = join(outDir, "runs", name ?? `only-${result.startedAt.replace(/[:.]/g, "-")}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${base}.html`, renderReport(result, outDir));
  return `${base}.json`;
}

function summary(result: AuditResult): string {
  const lines = [`${result.findings.length} finding(s): ${result.counts.error} error, ${result.counts.warning} warning, ${result.counts.suggestion} suggestion`];
  for (const f of result.findings) {
    lines.push(`  ${f.id.padEnd(15)} ${f.severity.padEnd(10)} ${f.message}`);
    lines.push(`  ${"".padEnd(15)} replay: --only ${replayHint(result, f)}   verify: --target ${f.id}`);
  }
  const broken = result.runs.filter((r) => r.error);
  if (broken.length) lines.push(`  (${broken.length} run(s) had problems; see latest.json)`);
  return lines.join("\n");
}

const SEV_RANK: Record<Severity, number> = { error: 3, warning: 2, suggestion: 1 };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const log = (m: string) => process.stderr.write(m + "\n");

  if (!cmd || args.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "audit") {
    const config = configFrom(args);
    const tracePath = str(args.trace);
    let trace = tracePath ? (JSON.parse(readFileSync(tracePath, "utf8")) as Interaction[]) : undefined;
    const only = str(args.only)?.split(",").map((s) => s.trim()).filter(Boolean);
    if (only?.length) {
      if (!trace) throw new Error("--only needs --trace (filter a saved trace to the interactions you touched)");
      const appOnly = only.includes("@app");
      const rest = only.filter((o) => o !== "@app");
      trace = trace.filter((i, n) => rest.some((o) => matchesOnly(i, o, n)));
      if (!trace.length && !appOnly) throw new Error(`--only ${only.join(",")} matched no interactions in the trace`);
      log(appOnly && !trace.length ? "Checking app-wide rules only (no interactions)" : `Replaying ${trace.length} of the trace's interactions`);
    }
    log(`Auditing ${config.baseUrl}`);
    const result = await audit(config, { trace, log, screenshots: !args["no-screens"] });
    const name = str(args["save-as"]);
    if (only?.length) {
      // A targeted run is a measurement for verify, not the app's report: keep latest.json and report.html as they were.
      const file = writeTargeted(result, config.outDir, name);
      process.stdout.write(summary(result) + "\n");
      log(`Saved ${file}`);
    } else {
      writeRun(result, config.outDir, name, !trace);
      process.stdout.write(summary(result) + "\n");
      log(`Report: ${resolve(config.outDir, "report.html")}`);
    }
    const failOn = str(args["fail-on"]) as Severity | undefined;
    if (failOn && result.findings.some((f) => SEV_RANK[f.severity] >= SEV_RANK[failOn])) process.exitCode = 1;
    return;
  }

  if (cmd === "verify") {
    const before = JSON.parse(readFileSync(String(args.before), "utf8")) as AuditResult;
    const after = JSON.parse(readFileSync(String(args.after), "utf8")) as AuditResult;
    const v = verify(before, after, { target: str(args.target)?.split(",").map((t) => t.trim()).filter(Boolean) });
    process.stdout.write((args.json ? JSON.stringify(v, null, 2) : formatVerify(v)) + "\n");
    process.exitCode = v.decision === "keep" ? 0 : 3;
    return;
  }

  if (cmd === "profile") {
    const config = configFrom(args);
    const forced = str(args.as) as ProfileName | undefined;
    if (forced && !PROFILES[forced]) throw new Error(`Unknown profile ${forced}`);
    log(`Reading ${config.baseUrl} for motion-profile signals`);
    const signals = await collectSignals(config);
    const inference = inferProfile(signals);
    const chosen = PROFILES[forced ?? inference.profile];
    const lines = [
      `Profile: ${chosen.label}${forced ? " (forced)" : inference.confident ? "" : " (default)"}`,
      `Scores: ${Object.entries(inference.scores).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`,
      ...inference.reasons.map((r) => `  - ${r}`),
      `Durations ${chosen.durations.sm} / ${chosen.durations.md} / ${chosen.durations.lg} ms; enter ${chosen.ease.enter}; exit ${chosen.ease.exit}; move ${chosen.ease.move}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
    if (args.write) {
      const file = typeof args.write === "string" ? args.write : "feelcheck.motion.css";
      writeFileSync(file, renderTokensCss(chosen, inference));
      writeFileSync(file.replace(/\.css$/, "") + ".json", renderTokensJson(chosen, inference));
      log(`Wrote ${file} and its .json twin. Review them before any fix uses them.`);
    }
    return;
  }

  if (cmd === "eval") {
    const port = Number(str(args.port) ?? 4199);
    const { startZoo } = (await import(pathToFileURL(join(ZOO_DIR, "server.mjs")).href)) as { startZoo: (p: number) => Promise<{ close(): void }> };
    const server = await startZoo(port);
    try {
      const outDir = str(args.out) ?? join(".feelcheck", "eval");
      const config = loadConfig(undefined, { baseUrl: `http://localhost:${port}`, routes: ["/"], outDir });
      if (existsSync("feelcheck.config.json")) log("Note: eval ignores feelcheck.config.json and audits the bundled zoo.");
      const result = await audit({ ...config, groupAttribute: "data-feelcheck-group" }, { log });
      writeRun(result, outDir, "zoo");
      const score = scoreAgainstAnswers(result);
      writeFileSync(join(outDir, "score.json"), JSON.stringify(score, null, 2));
      process.stdout.write(formatScore(score) + "\n");
      log(`Report: ${resolve(outDir, "report.html")}`);
    } finally {
      server.close();
    }
    return;
  }

  if (cmd === "zoo") {
    const port = Number(str(args.port) ?? 4173);
    const { startZoo } = (await import(pathToFileURL(join(ZOO_DIR, "server.mjs")).href)) as { startZoo: (p: number) => Promise<unknown> };
    await startZoo(port);
    log(`Jank zoo on http://localhost:${port} (Ctrl+C to stop)`);
    return;
  }

  if (cmd === "rules") {
    for (const r of Object.values(RULES)) {
      process.stdout.write(`${r.id.padEnd(9)}${r.severity.padEnd(11)}${r.title}\n         ${r.threshold}\n         Evidence: ${r.evidence}\n`);
    }
    return;
  }

  process.stderr.write(`Unknown command "${cmd}"\n\n${HELP}`);
  process.exitCode = 2;
}

// Piping into `head` closes stdout early; that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});

main().catch((e) => {
  process.stderr.write(`feelcheck: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
