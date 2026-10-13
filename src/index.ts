// Programmatic API. The CLI (kymo audit, verify, ci, eval) is built on these.
export { audit, VERSION, sortFindings, type AuditOptions } from "./audit.js";
export { loadConfig, DEFAULT_THRESHOLDS, DEFAULT_PROBES, VIEWPORT_PRESETS, parseViewports } from "./config.js";
export { verify, formatVerify, type VerifyResult, type VerifyOptions } from "./verify.js";
export { RULES, rule, type Rule } from "./rules.js";
export { renderReport } from "./report/html.js";
export { scoreAgainstAnswers, formatScore, type EvalScore } from "./eval.js";
export { compareRuns, toSarif, ciMarkdown, type Comparison } from "./ci.js";
export type * from "./types.js";
