#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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
import { atLeast, ciMarkdown, compareRuns, SEVERITIES, toSarif } from "./ci.js";
import { banner, formatSummary, Recorder, useColor } from "./term.js";
import { replayHint } from "./replay.js";
import type { AuditOptions } from "./audit.js";
import type { AuditResult, Config, Interaction, Severity } from "./types.js";

type Args = { _: string[]; [k: string]: string | boolean | string[] };

/** Flags that never take a value, so `--update-baseline http://...` keeps the URL as the URL. */
const BOOLEAN_FLAGS = new Set(["update-baseline", "no-screens", "json", "help"]);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (!BOOLEAN_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function severityArg(v: unknown, fallback?: Severity): Severity | undefined {
  if (v === undefined) return fallback;
  if (typeof v === "string" && (SEVERITIES as string[]).includes(v)) return v as Severity;
  throw new Error(`--fail-on takes error, warning or suggestion (got "${String(v)}")`);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const HELP = `kymo ${VERSION}: measures how a web app feels in a real browser, then keeps only the fixes that help.

Usage
  kymo audit [url]      Press every control, type into fields, Tab, hover and scroll; measure;
                        write .kymo/latest.json and report.html
      --config <file>          Config file (default: kymo.config.json if present)
      --routes /,/settings     Routes to visit
      --viewports desktop,mobile
                               Presets (desktop, laptop, tablet, mobile) or WIDTHxHEIGHT
      --concurrency <n>        Pages driven at once (default: half the cores, at most 4)
      --trace <file>           Replay a saved trace instead of discovering controls
      --only <a,b>             With --trace: replay only matching interactions (group, #id, key,
                               or position in the trace), or @app for app-wide rules only.
                               Saves to runs/<name>.json/.html.
      --out <dir>              Output folder (default .kymo)
      --save-as <name>         Also save the run as <out>/runs/<name>.json
      --fail-on <level>        Exit 1 if any finding is at least this severe (error|warning|suggestion)
      --no-screens             Skip before/after screenshots
  kymo verify --before <run.json> --after <run.json> [--target <id,id>]
                        Keep or revert a change. Exit 0 = keep, 3 = revert.
  kymo ci [url]         Audit, compare with a baseline, write a summary and SARIF. Exit 1 on new
                        findings at --fail-on or above.
      --baseline <file>        Run to compare with (default .kymo/baseline.json if present)
      --update-baseline        Save this run as the baseline
      --fail-on <level>        Default warning
      --sarif <file>           Write SARIF 2.1.0 for code scanning
      --markdown <file>        Write the summary as Markdown (also appended to $GITHUB_STEP_SUMMARY)
  kymo profile [url] [--write [file]]
                        Infer a motion profile and optionally write its token file
      --as <name>              Force a profile: productive, expressive, calm, physical
  kymo eval [--port 4199]
                        Audit the bundled jank zoo and score it against its answer key
  kymo zoo [--port 4173] Serve the jank zoo
  kymo rules            List the rules and their evidence
`;

function configFrom(args: Args): Config {
  const url = args._[1];
  const routes = str(args.routes)?.split(",").map((r) => r.trim()).filter(Boolean);
  const conc = str(args.concurrency);
  if (conc !== undefined && !/^[1-9]\d*$/.test(conc)) throw new Error(`--concurrency takes a whole number of pages, 1 or more (got "${conc}")`);
  return loadConfig(str(args.config), {
    baseUrl: url,
    routes,
    outDir: str(args.out),
    viewports: str(args.viewports),
    concurrency: conc ? Number(conc) : undefined,
  });
}

/** Run an audit with the live recording strip on a terminal, plain progress lines elsewhere. */
async function runAudit(config: Config, opts: Omit<AuditOptions, "log" | "onRun"> = {}): Promise<AuditResult> {
  const color = useColor(process.stderr);
  const rec = new Recorder(process.stderr, color);
  process.stderr.write(
    banner(
      [
        `kymo ${VERSION}`,
        `feeling out ${config.baseUrl}`,
        `${config.routes.length === 1 ? "1 route" : `${config.routes.length} routes`}, ${config.viewports.map((v) => v.name).join(" + ")}, ${config.concurrency} at a time`,
      ],
      "busy",
      color,
    ) + "\n\n",
  );
  try {
    return await audit(config, {
      ...opts,
      log: (m) => rec.phase(m.trimStart()),
      onRun: (e) => rec.run(e, config.thresholds.feedbackMs),
    });
  } finally {
    rec.end();
  }
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

function writeTargeted(result: AuditResult, outDir: string, name?: string): string {
  mkdirSync(join(outDir, "runs"), { recursive: true });
  const base = join(outDir, "runs", name ?? `only-${result.startedAt.replace(/[:.]/g, "-")}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${base}.html`, renderReport(result, outDir));
  return `${base}.json`;
}

function summary(result: AuditResult): string {
  return formatSummary(result, { color: useColor(process.stdout), replay: (f) => replayHint(result, f) });
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
    const result = await runAudit(config, { trace, screenshots: !args["no-screens"] });
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
    const failOn = severityArg(args["fail-on"]);
    if (failOn && result.findings.some((f) => SEV_RANK[f.severity] >= SEV_RANK[failOn])) process.exitCode = 1;
    return;
  }

  if (cmd === "ci") {
    const config = configFrom(args);
    const failOn = severityArg(args["fail-on"], "warning")!;
    const baselinePath = str(args.baseline) ?? join(config.outDir, "baseline.json");
    const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as AuditResult) : null;
    if (!baseline && args.baseline) log(`No baseline at ${baselinePath}; every finding counts as new.`);
    const result = await runAudit(config, { screenshots: !args["no-screens"] });
    writeRun(result, config.outDir, str(args["save-as"]));
    const cmp = compareRuns(result, baseline);
    const md = ciMarkdown(result, cmp, { failOn });
    const mdPath = str(args.markdown);
    if (mdPath) writeFileSync(mdPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    const sarifPath = str(args.sarif);
    if (sarifPath) {
      writeFileSync(sarifPath, JSON.stringify(toSarif(result, { only: cmp.baseline ? cmp.added : undefined }), null, 2));
      log(`SARIF: ${sarifPath}`);
    }
    if (args["update-baseline"]) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, JSON.stringify(result, null, 2));
      log(`Baseline saved to ${baselinePath}`);
    }
    process.stdout.write(summary(result) + "\n\n" + md + "\n");
    const failing = cmp.added.filter((f) => atLeast(f, failOn));
    if (failing.length && !args["update-baseline"]) process.exitCode = 1;
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
      const file = typeof args.write === "string" ? args.write : "kymo.motion.css";
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
      const outDir = str(args.out) ?? join(".kymo", "eval");
      const config = loadConfig(undefined, { baseUrl: `http://localhost:${port}`, routes: ["/", "/slop.html"], outDir });
      if (existsSync("kymo.config.json")) log("Note: eval ignores kymo.config.json and audits the bundled zoo.");
      const result = await runAudit({ ...config, groupAttribute: "data-kymo-group" });
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
  process.stderr.write(`kymo: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
