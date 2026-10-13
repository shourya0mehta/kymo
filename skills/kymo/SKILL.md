---
name: kymo
description: Polish how a web app feels, with proof. Drives the running app in a real browser (presses, typing, Tab, hover, dialogs, scrolling, desktop and mobile), measures feedback latency, dead clicks, long frames, layout shift, teleports, pops and blink-outs, motion and easing, reduced motion, focus, target size, pending and error states and the template look, points each finding at its source line, then fixes findings one at a time and keeps only the fixes that measurably help. Also checks that a feature, redesign or motion pass did not make the app feel worse. Use when asked to smooth over, polish, add motion or transitions, or improve quality of life in a web app the user is building, or to check that a UI change broke nothing.
---

# kymo

You fix what the engine measures. You do not judge feel by reading code or eyeballing screenshots. The engine (`kymo`) drives the app in headless Chromium, measures each interaction, and decides whether each of your changes is kept or reverted. Your job is the part it cannot do: write a small, correct fix in the right place.

What kymo does on each route and viewport: presses every control it can see (and the ones that appear after, like a menu's items or a dialog's buttons), types one character into each text field, opens dialogs and presses Escape, hovers controls that show tooltips, Tabs through the page, scrolls to the bottom, and replays requests slow and failing. It finds the CSS rule, event handler or script behind each finding through the DevTools protocol.

## 0. Before you start

1. The app must be running locally. Ask for the dev server URL if you do not know it (for example `http://localhost:5173`).
2. kymo must be runnable. Try `npx kymo --help`. If that fails, the user has a local clone: use `node <clone>/dist/cli.js` everywhere below. Chromium for Playwright: `npx playwright install chromium`.
3. You need a way to undo. Run `git status`. If the tree is dirty, ask the user whether to commit or stash first. Work on a branch: `git switch -c kymo/polish`.

## 1. Configure

Write `kymo.config.json` at the project root:

```json
{
  "baseUrl": "http://localhost:5173",
  "routes": ["/", "/settings"],
  "viewports": ["desktop", "mobile"]
}
```

Pick routes from the router (for example `src/routes`, `app/` or `pages/`). Keep it to the 3 to 6 screens people use most. Add `"mobile"` when the app is used on phones; it doubles the run time. If the app has natural component boundaries, adding `data-kymo-group="<name>"` to them makes findings group by component and makes replays easy to target, but only with the user's OK.

Optional, for React with Babel (Vite's React plugin): `kymo/babel` stamps each element with its `file:line:col` in development, so findings point at the JSX that renders the element. Suggest it, and add it only if the user agrees:

```ts
// vite.config.ts
react({ babel: { plugins: ["kymo/babel"] } })
```

## 2. Baseline

```bash
npx kymo audit --save-as before
cp .kymo/runs/before.json .kymo/runs/before-original.json
```

This writes `.kymo/latest.json`, `.kymo/runs/before.json`, `.kymo/trace.json` (the exact interactions, for replay) and `.kymo/report.html`. The terminal summary lists every finding with a short id (like `MOT-09-3fa2c`), an `at` line saying where to look, a ready-made `--only` value to replay it, and a `--target` value to verify it. The full record is in `latest.json`: `rule`, `severity`, `evidence`, `message`, `element` (CSS path and text), `viewports`, `source` and `fix` (guidance from the rule).

`source` can hold `markup` (the JSX line, with the Babel plugin), `rules` (the CSS rules that match the element, newest first, with `motion: true` on rules that set a transition or animation), `handler` (the element's own event handler) and `script` (where a long frame spent its time). Paths come from source maps when the dev server serves them; otherwise they are the served files.

Tell the user the headline in two or three sentences and point them at the report.

## 3. Motion vocabulary (only if needed)

Look at `inventory` in `latest.json`.

- If the app has almost no motion (fewer than 3 distinct durations) or there is a `VIS-08` sprawl finding, it needs a motion profile before you add or change transitions.
- Run `npx kymo profile`. It prints a proposed profile (Productive, Expressive, Calm or Physical), the scores, and the signals behind them. Show the user the proposal and the signals, and ask them to approve it or pick another (`--as expressive`).
- Only after approval: `npx kymo profile --as <name> --write src/styles/motion.css` (pick a path that fits the project). This also writes `motion.json`, a record of the choice. Import the CSS where global styles live.
- From then on every duration and easing you write uses these tokens: `var(--motion-duration-sm|md|lg)` and `var(--motion-ease-enter|exit|move)`. Write translate distances as `calc(12px * var(--motion-distance))` so they collapse to zero under reduced motion.
- Check whether the app already has a global `@media (prefers-reduced-motion: reduce)` rule. If it does, new motion may already be covered; do not add a second, conflicting one.

## 4. Plan

Group findings by the control they come from: one fix often resolves several (a Save button can have slow feedback, no pending state and a silent error at once). Order groups by the worst severity in them, errors first, and start with the most-used screens. Suggestions (`severity: suggestion`) are taste: say so, and let the user drop them. Show the user a short numbered plan (control, finding ids, one-line fix idea).

## 5. Fix one group at a time

1. **Find the source.** Start from `source`: open the file and line it names and confirm it is the element in the finding. If `source` is missing or points at built or vendor files, search for the element's id, classes and text from `element.css` and `element.text` (for example `rg "rail-fill"`). For motion rules, use the rule with `motion: true`.
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
   - Long frames (FEEL-04) and typing lag (FEEL-05): `source.script` is where the time went. Move that work out of the input handler: render first, then debounce, `requestAnimationFrame` then `setTimeout`, or a worker. Never just delete the work.
   - Blink-outs (MOT-10): fade or slide out on the exit curve, then remove the element after the animation finishes, and remove it at once when there is no animation (reduced motion).
   - Focus (CRAFT-02): replace a removed outline with a `:focus-visible` ring; never remove focus styles. Dialogs (CRAFT-03): prefer a native `<dialog>` with `showModal()`, and return focus to the trigger on close. Hover content (CRAFT-05): keep it open while the pointer is over the trigger or the content, and close it on Escape.
   - Targets (CRAFT-04, CRAFT-09): grow the hit area with padding or a pseudo-element; the visible control can stay small.
   - Layout shift (STAB-01, STAB-02): reserve space (width and height, aspect-ratio, min-height) and keep hover styles off layout properties.
   - Early validation (CRAFT-08): show new errors on blur or submit, clear them as soon as the value becomes valid.
   - The template look (AI-01) is a suggestion about taste. Show the user the tells and ask which ones are deliberate before changing anything.
3. **Measure it.** Replay only what you touched, then compare. Use the `--only` and `--target` values from the audit summary:

   ```bash
   npx kymo audit --trace .kymo/trace.json --only <group, #id or @app> --save-as after-<n> --no-screens
   npx kymo verify --before .kymo/runs/before.json --after .kymo/runs/after-<n>.json --target <id>,<id>
   ```

   App-wide findings such as `VIS-08` have no interaction: replay them with `--only @app`. Route-level findings (layout shift, focus, targets, scroll reveals, the template look) come from the page sweep; the summary's `--only` value replays it. Targeted runs save to `.kymo/runs/` and leave the main report alone. `verify` exits 0 for keep and 3 for revert. It reverts if a target is still there, if anything new appeared (suggestions included), or if any replayed interaction got slower to respond.
4. **Keep or revert.**
   - Keep: `git commit -am "kymo: <rule> on <element>"`.
   - Revert because a target is still there or something new appeared: `git restore <files>`, read the reason, and try one different approach. If that is also reverted, leave the finding for a human and note why.
   - Revert only because feedback got slower on a control your change did not touch: replay that control once more. If it is fast again, it was timing noise; keep the change and note it. If it is slow again, revert.
5. After every three kept commits, refresh the baseline with a full replay: `npx kymo audit --trace .kymo/trace.json --save-as before`.

## 6. Finish

Run a full replay and compare it with the very first baseline, so effects across components are caught:

```bash
npx kymo audit --trace .kymo/trace.json --save-as final
npx kymo verify --before .kymo/runs/before-original.json --after .kymo/runs/final.json
```

If it reports something introduced or slower, run it once more. If it repeats, find the commit that caused it by replaying just that control after each kept commit:

```bash
base=$(git rev-parse <commit before your first fix>)
for c in $(git rev-list --reverse $base..HEAD); do
  git checkout -q $c
  npx kymo audit --trace .kymo/trace.json --only <control> --save-as bisect-$c --no-screens
done
git switch -
```

Revert the first commit where it appears (`git revert <sha>`). If no commit reproduces it, report it as noise.

Tell the user: how many findings were fixed and kept, how many were reverted and why, what is left for a human, and the measured changes that matter (for example feedback on Save went from 317 ms to 12 ms). Point them at `.kymo/report.html` from the final run.

## 7. Changes that are not fixes

When the user asks for something new rather than a fix (a feature, a redesign, a motion pass, a new component), `verify --target` is the wrong test: it only keeps changes that resolve findings. Use change mode instead. It keeps the change if nothing new appeared and no interaction got slower, across the interactions both runs share.

```bash
npx kymo audit --save-as before-change            # before you touch anything
# ... make the change ...
npx kymo audit --save-as after-change             # a full audit, so new controls are found and measured
npx kymo verify --before .kymo/runs/before-change.json --after .kymo/runs/after-change.json --change
```

- Run a full audit after the change, not `--only`: the change can add controls, and their findings count as introduced.
- Exit 0 prints `KEEP (no regressions)` with the number of interactions compared. Tell the user that number, and anything listed as faster or resolved.
- Exit 3 lists what was introduced or got slower. Fix those with the loop in section 5 (they are ordinary findings now), then run the change check again. The timing-noise rule from section 5 applies to slower feedback here too.
- `Gone from the after-run` lists controls the change removed or renamed. That is not a failure, but mention it so the user can confirm it was intended.
- Never pass `--target` and `--change` together; kymo refuses.

New motion the user asked for still follows section 3 and the constraints in section 5: tokens, transform and opacity, a reduced-motion path, short decelerating entrances, and not an entrance on every section.

## In CI

If the user wants this checked on every pull request, `kymo ci` audits, compares with `.kymo/baseline.json`, writes SARIF and a Markdown summary, and fails only on new findings. See `docs/ci.md` in the kymo repo; record the baseline with `kymo ci <url> --update-baseline` after the polish is merged.

## Never

- Never edit thresholds, rules, the config or the trace to make a finding disappear.
- Never add `data-kymo-ignore` or exclude selectors to silence a finding unless the user asks.
- Never remove focus outlines, shrink hit areas or drop reduced-motion handling to make another finding go away.
- Never "fix" a dead click by disabling or hiding the control, or by faking progress, without asking.
- Never keep a change that `verify` says to revert, except the timing-noise case above, and say when you used it.
