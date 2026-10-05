# T15: Dashboard (static site on GitHub Pages)

Status: planned
Wave: 2
Depends on: T06 (merged). It reads the deployed API only after T10 is deployed, but no code of T10's.
Owner paths (edit only these):
- `apps/dashboard/**`
- `.github/workflows/pages.yml` (new)
- docs/architecture.md (your rows in Decisions)
- `pnpm-workspace.yaml` (only a `false` ruling under `allowBuilds` for a dependency whose build script just prints a message)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Metric definitions: Survival and Limits, and the Decisions row on the dashboard on GitHub Pages)
- `packages/shared/src/api.ts`, `packages/shared/src/domain.ts` (`SurvivalCurvePointsSchema` and its step-function rules) and the response fixtures in `packages/shared/src/fixtures.ts`
- `apps/api/README.md` (the routes)

## Task

Build the dashboard: a static site on GitHub Pages that polls the public read API and shows, per repo, how long AI-written lines survive next to human ones. It is the product's face, so it must say exactly what the metric says and no more: survival at 30, 90 and 180 days per cohort, the two curves as step functions with their thinning tails visible, the repo's last activity next to every curve (survival means unchanged, not correct), and an unknown never drawn as a number. The API is cross-origin, so every response is parsed with the shared schemas before it is shown.

## Where

- `apps/dashboard/`: a Vite build of a TypeScript site. A framework is your call (none is fine for two views); say why in the README. Charts are hand-written SVG or one small library; if the `dataviz` skill is available in your session, follow it for color, marks and accessibility.
- Two views. The repo list: owner/name, last activity (`headCommittedAt`), and S(30), S(90), S(180) for `ai` and `human`, or "not analyzed yet". The repo view: both curves on one chart as step functions, `atRisk` shown (for example a thinner or lighter line where few lines are at risk, and in the tooltip), the headline numbers, the analyzed head and when it was observed.
- Polling: refresh the open view every 10 minutes while the tab is visible, and refetch when the tab becomes visible again if the data is more than a minute old. Never poll a hidden tab. A failed poll keeps the last good data and shows that it is stale. Why so slow: Neon's free plan has 100 CU-hours a month and suspends the compute after 5 idle minutes, so a 1 minute poll from one open tab would keep it awake around the clock, while metrics only change when a push is analyzed.
- `src/api.ts`: the client. Base URL from `import.meta.env.VITE_API_URL` at build time, with a trailing slash stripped before paths are joined: the Function URL that `CodeTrustApi` outputs ends in `/`. Every response goes through its schema from `@code-trust/shared`; a body that fails is an error state, not a partial render.
- Local dev: Vite's dev server on `$CONDUCTOR_PORT+1`, proxying `/api` to the local API on `$CONDUCTOR_PORT`, so no CORS is needed locally.
- `.github/workflows/pages.yml`: on push to `main` touching `apps/dashboard/**` (and `workflow_dispatch`), build with `VITE_API_URL` from the repository variable `API_URL` and deploy with `actions/upload-pages-artifact` and `actions/deploy-pages`. Skip the job when `vars.API_URL` is empty, so `main` stays green until the human configures Pages. Vite's `base` is `/code-trust/`.
- `apps/dashboard/README.md`: run locally; and the human's one-time steps: enable Pages with source "GitHub Actions", set the `API_URL` repository variable to the deployed `CodeTrustApi` URL.

## Done when

- [ ] `pnpm --filter @code-trust/dashboard test` passes with named tests, rendering from the shared fixtures (DOM tests under happy-dom or jsdom):
  - the repo list shows `apiRepoFixture`'s name, its last activity and its S(30), S(90), S(180) per cohort; a never-analyzed repo shows "not analyzed yet" and no numbers.
  - a horizon whose value is `null` renders as "not observed yet" (never 0, never a dash that could be read as 0), and a horizon of exactly 0 renders as 0%.
  - the curve for `survivalCurveFixture` is a step path: each point's value holds until the next point's day, with no diagonal segments, and it ends at the last point (no line drawn past it when survival is above 0).
  - `revertedSurvivalCurveFixture` drops to 0 and the chart says all lines were removed.
  - the last activity appears in the repo view next to the chart.
  - the client rejects a body that fails its schema (for example a curve whose points are out of order) and the view shows an error state; a failed poll after a good one keeps the data and marks it stale.
  - polling, with fake timers and a stubbed `document.visibilityState`: a visible tab fetches again after 10 minutes and not before; a hidden tab never fetches; becoming visible refetches when the data is more than a minute old and does not when it is newer.
  - no request goes anywhere but `VITE_API_URL` (or `/api` in dev).
  - with a base URL that ends in `/` (`https://example.invalid/`), the client requests `https://example.invalid/repos`, with no double slash.
- [ ] `pnpm --filter @code-trust/dashboard build` exits 0 with `VITE_API_URL=https://example.invalid` and writes `apps/dashboard/dist/index.html` whose asset URLs start with `/code-trust/`.
- [ ] With the workspace database migrated and seeded (`pnpm --filter @code-trust/api seed`) and `pnpm --filter @code-trust/api dev` running, the dashboard's dev server serves the repo view for `1296269` and `curl -s localhost:$((CONDUCTOR_PORT+1))/api/repos/1296269` through its proxy prints the fixture summary. If a browser tool is available, also save a screenshot of the repo view to `.context/` and show it. Stop both servers.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- `apps/api` and `infra`: CORS is on the API's Function URL (T10), and nothing here deploys AWS resources.
- Auth, accounts, settings, editing anything. The dashboard is read-only.
- Confidence intervals, comparisons across repos, org-level aggregates.
- Enabling Pages or setting repository variables: the human does it (`gh` commands that change repo settings are blocked anyway).

## Notes

- Null versus 0 is the metric's sharpest rule (Metric definitions: Survival). 0 means every line was removed; null means no line has been observed that long yet. The tests above are there because a chart library's default would happily draw null as 0.
- A curve's tail where `atRisk` is small is noisy. Show it as thin rather than hiding it.
- `headCommittedAt` is the repo's last activity: an abandoned repo's code survives by default, so it must sit next to every curve.
- Keep the bundle small and dependency-free where you can; the site is static and public.
- If `pnpm install` stops on a dependency build script that only prints a message, add a `false` ruling under `allowBuilds` with a comment. Anything that compiles or downloads (some bundlers ship a native binary through a postinstall): stop and ask.
- Other lanes may merge first. If your PR conflicts with main in docs/STATUS.md or the Decisions table, rebase and keep both sides' rows. If `pnpm-lock.yaml` conflicts, take main's and run `pnpm install` again.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/dashboard test passes with a named test for every rendering, null-versus-zero, step-curve, schema and polling case in the task's Done when list (10 minute polling, none while hidden, refetch on becoming visible after a minute), pnpm --filter @code-trust/dashboard build writes dist/index.html with /code-trust/ asset URLs, the dev server's proxy serves the seeded fixture summary from the local API, .github/workflows/pages.yml builds and deploys only when vars.API_URL is set, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
