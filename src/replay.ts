import type { AuditResult, Finding } from "./types.js";

/**
 * What to pass to --only to replay the interaction behind a finding (shell-safe). A group or id
 * replays every interaction that shares it (all viewports, a dialog's buttons), which is what a
 * fix to that control needs re-measured anyway.
 */
export function replayHint(result: AuditResult, f: Finding): string {
  if (!f.interaction) return "@app";
  const n = result.trace.findIndex((t) => t.key === f.interaction);
  if (n < 0) return JSON.stringify(f.interaction);
  const i = result.trace[n];
  if (i.target.group && /^[\w-]+$/.test(i.target.group)) return i.target.group;
  if (i.target.id && /^[\w-]+$/.test(i.target.id)) return `#${i.target.id}`;
  return String(n + 1); // its position in trace.json: shell-safe when the name is not
}
