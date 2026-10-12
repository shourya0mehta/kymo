import type { Finding, InteractionRun } from "../types.js";
import { label, makeFinding, targetInfo } from "./finding.js";

export const PENDING_MS = 1000;

/** WAIT-01 no pending state under a slow request; CRAFT-07 silent or blank failure. */
export function failureProbe(runs: InteractionRun[]): Finding[] {
  const out: Finding[] = [];
  for (const run of runs) {
    if (!run.capture) continue;
    const target = targetInfo(run.interaction);
    if (run.mode === "slow-network" && run.pending && !run.pending.changed) {
      out.push(
        makeFinding("WAIT-01", {
          keyParts: [run.interaction.key],
          interaction: run.interaction,
          element: target,
          message: `With the request held for 3 s, the screen looked exactly as it did before the click ${PENDING_MS} ms after pressing ${label(target)}. Nothing said it was working.`,
          metrics: { checkedAtMs: PENDING_MS, requests: run.requests.length },
        }),
      );
    }
    if (run.mode === "server-error") {
      const ui = run.capture.errorUi;
      if (ui && (!ui.found || ui.blank)) {
        out.push(
          makeFinding("CRAFT-07", {
            keyParts: [run.interaction.key],
            interaction: run.interaction,
            element: target,
            message: ui.blank
              ? `When the request behind ${label(target)} failed, most of the visible content disappeared and no error was shown.`
              : `When the request behind ${label(target)} failed with a 500, no error message, alert or retry appeared.`,
            metrics: { blank: ui.blank, newText: ui.newText.join(" / ") || null },
          }),
        );
      }
    }
  }
  return out;
}
