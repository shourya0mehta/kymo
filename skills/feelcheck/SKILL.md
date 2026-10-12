---
name: feelcheck
description: Polish how a web app feels, with proof. Drives the running app in a real browser, measures feedback latency, dead clicks, teleports and pops, motion, reduced motion, and pending and error states, then fixes findings one at a time and keeps only the fixes that measurably help. Use when asked to smooth over, polish, add motion or transitions, or improve quality of life in a web app the user is building.
---

# feelcheck

You fix what the engine measures. You do not judge feel by reading code or eyeballing screenshots. The engine (`feelcheck`) drives the app in headless Chromium, measures each interaction, and decides whether each of your changes is kept or reverted. Your job is the part it cannot do: find the right source file and write a small, correct fix.

## 0. Before you start

1. The app must be running locally. Ask for the dev server URL if you do not know it (for example `http://localhost:5173`).
2. feelcheck must be runnable. Try `npx feelcheck --help`. If that fails, the user has a local clone: use `node <clone>/dist/cli.js` everywhere below. Chromium for Playwright: `npx playwright install chromium`.
3. You need a way to undo. Run `git status`. If the tree is dirty, ask the user whether to commit or stash first. Work on a branch: `git switch -c feelcheck/polish`.

## 1. Configure

Write `feelcheck.config.json` at the project root:

```json
{
  "baseUrl": "http://localhost:5173",
  "routes": ["/", "/settings"],
  "windowMs": 1200
}
```

Pick routes from the router (for example `src/routes`, `app/` or `pages/`). Keep it to the 3 to 6 screens people use most. If the app has natural component boundaries, adding `data-feelcheck-group="<name>"` to them makes findings group by component and makes replays easy to target, but only with the user's OK.

## 2. Baseline

```bash
npx feelcheck audit --save-as before
cp .feelcheck/runs/before.json .feelcheck/runs/before-original.json
```

This writes `.feelcheck/latest.json`, `.feelcheck/runs/before.json`, `.feelcheck/trace.json` (the exact interactions, for replay) and `.feelcheck/report.html`. The terminal summary lists every finding with a short id (like `MOT-09-3fa2c`), a ready-made `--only` value to replay it, and a `--target` value to verify it. The full record is in `latest.json`: `rule`, `severity`, `evidence`, `message`, `element` (CSS path and text) and `fix` (guidance from the rule).

Tell the user the headline in two or three sentences and point them at the report.

## 3. Motion vocabulary (only if needed)

Look at `inventory` in `latest.json`.

- If the app has almost no motion (fewer than 3 distinct durations) or there is a `VIS-08` sprawl finding, it needs a motion profile before you add or change transitions.
- Run `npx feelcheck profile`. It prints a proposed profile (Productive, Expressive, Calm or Physical), the scores, and the signals behind them. Show the user the proposal and the signals, and ask them to approve it or pick another (`--as expressive`).
- Only after approval: `npx feelcheck profile --as <name> --write src/styles/motion.css` (pick a path that fits the project). This also writes `motion.json`, a record of the choice. Import the CSS where global styles live.
- From then on every duration and easing you write uses these tokens: `var(--motion-duration-sm|md|lg)` and `var(--motion-ease-enter|exit|move)`. Write translate distances as `calc(12px * var(--motion-distance))` so they collapse to zero under reduced motion.
- Check whether the app already has a global `@media (prefers-reduced-motion: reduce)` rule. If it does, new motion may already be covered; do not add a second, conflicting one.

## 4. Plan

Group findings by the control they come from: one fix often resolves several (a Save button can have slow feedback, no pending state and a silent error at once). Order groups by the worst severity in them, errors first, and start with the most-used screens. Suggestions (`severity: suggestion`) are taste: say so, and let the user drop them. Show the user a short numbered plan (control, finding ids, one-line fix idea).

## 5. Fix one group at a time

1. **Find the source.** Search for the element's id, classes and text from `element.css` and `element.text` (for example `rg "rail-fill"`). For motion rules, find the CSS rule that sets `transition` or `animation` on that element.
2. **Make the smallest change that follows the rule's `fix`.** Hard constraints:
   - Animate only `transform` and `opacity`. Never add `transition: all`. Never animate width, height, top, left, margin or padding; use transform (FLIP) or the View Transitions API instead.
   - Use the motion tokens. No new one-off durations or curves.
   - For a class toggle, put the entrance on the open state and the exit on the base rule, so each direction gets its own curve:
     ```css
     .panel { transform: translateX(-100%); transition: transform var(--motion-duration-md) var(--motion-ease-exit); }
     .panel.open { transform: none; transition: transform var(--motion-duration-lg) var(--motion-ease-enter); }
     ```
   - Every new movement needs a reduced-motion path that removes the movement (a short crossfade is fine).
   - Keyboard-triggered and very frequent actions stay instant.
   - Do not add motion that does not fix a finding. No decorative entrances, no bounce.
   - Slow feedback: acknowledge the click in the next frame (pressed state, optimistic update, or an immediate pending state). Do not just remove the slow work.
   - Silent errors: show a specific message next to the control with `role="alert"` and a way to retry. Keep existing content on screen.
   - Dead clicks: wire up the real behaviour if it is clear. If it is not, ask the user. Never fake progress ("Preparing..." with nothing behind it); if you must ship something now, say honestly that it is not available yet.
3. **Measure it.** Replay only what you touched, then compare. Use the `--only` and `--target` values from the audit summary:

   ```bash
   npx feelcheck audit --trace .feelcheck/trace.json --only <group, #id or @app> --save-as after-<n> --no-screens
   npx feelcheck verify --before .feelcheck/runs/before.json --after .feelcheck/runs/after-<n>.json --target <id>,<id>
   ```

   App-wide findings such as `VIS-08` have no interaction: replay them with `--only @app`. Targeted runs save to `.feelcheck/runs/` and leave the main report alone. `verify` exits 0 for keep and 3 for revert. It reverts if a target is still there, if anything new appeared (suggestions included), or if any replayed interaction got slower to respond.
4. **Keep or revert.**
   - Keep: `git commit -am "feelcheck: <rule> on <element>"`.
   - Revert because a target is still there or something new appeared: `git restore <files>`, read the reason, and try one different approach. If that is also reverted, leave the finding for a human and note why.
   - Revert only because feedback got slower on a control your change did not touch: replay that control once more. If it is fast again, it was timing noise; keep the change and note it. If it is slow again, revert.
5. After every three kept commits, refresh the baseline with a full replay: `npx feelcheck audit --trace .feelcheck/trace.json --save-as before`.

## 6. Finish

Run a full replay and compare it with the very first baseline, so effects across components are caught:

```bash
npx feelcheck audit --trace .feelcheck/trace.json --save-as final
npx feelcheck verify --before .feelcheck/runs/before-original.json --after .feelcheck/runs/final.json
```

If it reports something introduced or slower, run it once more. If it repeats, find the commit that caused it by replaying just that control after each kept commit:

```bash
base=$(git rev-parse <commit before your first fix>)
for c in $(git rev-list --reverse $base..HEAD); do
  git checkout -q $c
  npx feelcheck audit --trace .feelcheck/trace.json --only <control> --save-as bisect-$c --no-screens
done
git switch -
```

Revert the first commit where it appears (`git revert <sha>`). If no commit reproduces it, report it as noise.

Tell the user: how many findings were fixed and kept, how many were reverted and why, what is left for a human, and the measured changes that matter (for example feedback on Save went from 317 ms to 12 ms). Point them at `.feelcheck/report.html` from the final run.

## Never

- Never edit thresholds, rules, the config or the trace to make a finding disappear.
- Never add `data-feelcheck-ignore` or exclude selectors to silence a finding unless the user asks.
- Never "fix" a dead click by disabling or hiding the control, or by faking progress, without asking.
- Never keep a change that `verify` says to revert, except the timing-noise case above, and say when you used it.
