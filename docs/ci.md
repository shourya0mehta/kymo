# kymo in CI

`kymo ci` runs a full audit, compares it with a baseline, and fails only on findings the baseline does not already have. It writes:

- `.kymo/report.html` and `.kymo/latest.json`, as `kymo audit` does
- a Markdown summary (also appended to `$GITHUB_STEP_SUMMARY` on GitHub Actions)
- SARIF 2.1.0, so findings with a source line show up as code scanning annotations on the pull request

## GitHub Actions

Start your app in the background, then point the action at it.

```yaml
name: feel
on: pull_request

permissions:
  contents: read
  security-events: write   # only for the SARIF upload

jobs:
  kymo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: npx vite preview --port 4173 &   # or however your app serves itself
      - run: npx wait-on http://localhost:4173

      - uses: shourya0mehta/kymo@main
        with:
          url: http://localhost:4173
          routes: /,/settings
          viewports: desktop,mobile
          fail-on: warning

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: kymo.sarif, category: kymo }
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: kymo-report, path: .kymo }
```

## Baselines

Without a baseline every finding counts as new, which is rarely what you want on an app that already exists. Record one on `main` and commit it:

```bash
kymo ci http://localhost:4173 --update-baseline
git add .kymo/baseline.json
```

From then on a pull request fails only when it adds a finding at `--fail-on` or above. A finding counts as the same one when its key matches: rule, interaction and element, ignoring the viewport. Fixed findings are listed in the summary so the baseline can be refreshed.

Timing findings (FEEL-01, FEEL-04, FEEL-05) depend on the machine. CI runners are slower than laptops, so a press that answers in 90 ms locally can take 120 ms on a shared runner. If that is noisy for you, raise the budgets for CI in a config file:

```json
{ "thresholds": { "feedbackMs": 150, "longFrameMs": 150, "typingMs": 150 } }
```

## Other CI systems

Anything that runs Node 20 and Chromium works. kymo is not on npm yet, so install it from GitHub:

```bash
npm i -D github:shourya0mehta/kymo
npx playwright install --with-deps chromium
npx kymo ci http://localhost:4173 --baseline .kymo/baseline.json --sarif kymo.sarif --markdown kymo.md
```

Exit codes: `0` no new findings at `--fail-on` or above, `1` new findings (or an error).
