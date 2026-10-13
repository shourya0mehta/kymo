# Two real sites, audited as shipped

Both sites are Shourya's, audited from their public URLs on October 12, 2026, on desktop (1280 by 800) and mobile (390 by 844, touch), with `maxInteractions: 25` per route. Each finding was checked against the site's source. "Confirmed" means the source does what the finding says. Timing findings were measured on a 2-core cloud machine, which is slower than a laptop, so a press a few milliseconds over budget is marked "timing" rather than confirmed.

The runs are also how v0.2 was tuned, so treat these as the cases kymo was fixed against, not a blind test. The first v0.2 run on Fuel Gauge raised 23 findings and the first on Fallow 24, with 53 replays that could not find their target. The problems behind that are listed at the end.

## Fuel Gauge landing page

`https://shourya0mehta.github.io/fuel-gauge/`, 52 interactions, about 7.5 minutes, 4 findings.

| Finding | Verdict |
|---|---|
| MOT-08: the step numbers in the progress rail use `transition: all` | Confirmed: `landing.css:126`, `.rail a span { transition: all .25s }` |
| MOT-08: the progress rail fill `#rail-fill` animates `height` | Confirmed: `landing.css:123`, `.rail-bar i { transition: height .2s linear }` |
| VIS-08: 13 distinct durations, 5 easing curves | Confirmed: counted from the stylesheets |
| CRAFT-09: 27 controls under 44 by 44 px on mobile (the camera chips are 85 by 18) | Measured; a suggestion |

Seen in some runs but not the last one:

- **MOT-01: the accuracy bars grow over 1 s when scrolled into view.** Confirmed in the source (`landing.css:192`, `.errs i::after { transition: transform 1s }`), and reported on mobile in two of the three runs before this one. Catching a reveal depends on the observer firing while kymo is still scrolling, so this check can miss.
- **FEEL-01 and FEEL-04 on mobile**, 102 to 127 ms. Timing on a busy machine; not confirmed.

**A correction to v0.1.** v0.1 reported a 900 ms crosshair transition after choosing a camera, and called it confirmed. The CSS is real (`landing.css:51`, `.xhair { transition: transform .9s }`), but the click doesn't cause it: an auto tour moves the crosshair every 2.6 s (`landing.js:236`), and when a person points at the image the script switches the transition to a 0.2 s opacity fade (`landing.js:229`). The early runs pinned a tour step on whichever press it overlapped. v0.2 watches each page idle for 3 s first, long enough to see the tour, and no longer reports it.

## Fallow

`https://fallow-omega.vercel.app/?intro=0`, 108 interactions, about 12 minutes, 15 findings. 6 replays could not find their target again, mostly controls whose names carry live state ("Brain health 76 of 100").

| Finding | Verdict |
|---|---|
| CRAFT-03: the plant cards (11 of them, one component) take focus and close on Escape, but focus does not return to the plant | Confirmed: `PlantCard.tsx:24` focuses the card on open; Escape calls `select(null)`; nothing restores focus |
| CRAFT-03: the brain-health popover is `role="dialog"` but takes no focus and ignores Escape | Confirmed: `Garden.tsx:170`; Escape is only handled by the plant card and the account menu |
| CRAFT-03: the "Keep your garden on every device" card is `role="dialog"` but takes no focus and ignores Escape | Confirmed: `Account.tsx:123` |
| CRAFT-05: the plant name tag shown on hover (on 10 plants) disappears when the pointer moves onto it | Confirmed: `.g-tag` has `pointer-events: none`. It is `aria-hidden` decoration, so this is a strict reading of WCAG 1.4.13 |
| STAB-01: cumulative layout shift 0.222 while loading | Confirmed: the garden canvas is sized by script (`engine.ts:377`) and `.garden` reserves no space |
| MOT-01 and MOT-08: the Today meter animates `width` over 900 ms | Confirmed: `.track > i` |
| CRAFT-07: a failed sign-in shows no error next to the header button | Likely: the error renders in the sign-in card, not near the header button that was pressed |
| MOT-10: "Maybe later" removes the sign-in card in one frame | Confirmed: `onClose` unmounts it with no exit |
| MOT-10: starting a session removes the ask bar and its examples in one frame | Plausible: the session view replaces them elsewhere in the page, so this is a view change with no transition rather than a dismissal |
| MOT-10: "Start my own" removes a quest row in one frame on mobile | Plausible, same reason |
| VIS-08: 21 distinct durations, 7 easing curves | Confirmed |
| CRAFT-09: 29 controls under 44 by 44 px on mobile | Measured; a suggestion |
| FEEL-01: "Pet Shumbo" answered in 130 ms on mobile | Timing |

## What the first v0.2 runs got wrong, and the fixes

- **State leaked between runs.** Pressing "Start my own" or planting a seed changed what later runs saw, so 37 replays could not find their target. Every run now starts with the origin's cookies and storage cleared (`isolate`, on by default; off when a `storageState` is given for signed-in pages).
- **Clicking hit areas the way Playwright does, not the way people do.** Fallow's plant buttons have `pointer-events: none` over a canvas, so `elementHandle.click()` timed out. Setup steps and dialog checks now press the centre of the element with the real pointer, like the main press always did.
- **Keyboard-only buttons looked covered.** `elementFromPoint` skips `pointer-events: none`, so focus on those buttons looked hidden by the canvas (CRAFT-02). The check now hit-tests them as if they took pointer events.
- **Hover findings from things that change on their own.** A typed headline made links and buttons look like they shifted their neighbours on hover (STAB-02), and a rotating caption looked like hover content. kymo now moves the pointer away and checks again: a hover effect undoes itself, an ambient change does not. The idle watch also runs longer (3 s), to catch slower cycles.
- **Charts counted as blink-outs.** SVG groups redrawn on a camera change were reported as MOT-10, because a removed node no longer knows it was inside an SVG. That is now recorded before the press, as is the node's parent for spotting swaps. Removals more than 600 ms after the input are treated as async updates, not dismissals.
- **A hidden native control counted as a 2 by 2 px target.** Visually hidden controls (a native `select` behind a custom one, `sr-only` patterns) are skipped by the target check.
- **One component, many findings.** Ten plant cards produced ten CRAFT-03 findings and ten tooltips ten CRAFT-05 findings. Both are now grouped by the dialog or tooltip component, with a count.
- **Third-party sign-in.** Discovery pressed "Sign in with Google". Controls named like signing in with another service, signing out, paying or deleting an account are now skipped by default (`skipNames`).
- **Frames the machine made long.** On a busy 2-core runner a frame can run long with no script and no layout in it, just waiting for the CPU. Long frames now count only when the page caused them: a blocking task, 30 ms of script, or 50 ms of style and layout. One stray long frame in a whole page of scrolling no longer counts as stutter either.
- **Time-based effects pinned on presses.** Anything on a timer (an auto tour, a carousel) can land inside a press's watch window. The idle watch now runs for 3 s, and an animation on an element seen moving on its own is judged only when it starts within 250 ms of the press.
