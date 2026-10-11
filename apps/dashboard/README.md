# @code-trust/dashboard

The product's face: a static site on GitHub Pages that polls the public read API (`apps/api`) and shows, per repository, how long AI-written lines survive next to human-written ones. It says what the metric says and no more (Metric definitions in `docs/architecture.md`).

- **Repositories** (`#/`): each repo's owner/name, its last activity (`headCommittedAt`), and S(30), S(90), S(180) for `ai` and `human`. A repo with no analyzed head reads "not analyzed yet", and a cohort with no lines reads "no human lines" (or "no AI lines").
- **Repository** (`#/repos/<id>`): the headline numbers, then both curves on one chart as step functions, with the last activity, the analyzed head and the observation time in the chart's caption.

## Rules the page keeps

- **Null is not 0.** A null horizon reads "not observed yet": no line has been observed that long. 0 reads "0%": every line was removed. A share below 0.5% reads "<1%", never "0%". Nothing past a curve's last point is drawn, unless the curve reached 0, which holds. The chart is hand-written SVG, because a chart library's default draws a missing value as 0.
- **Thin tails stay visible.** A run of a curve with fewer than 10 lines at risk (`THIN_AT_RISK` in `src/curve.ts`) is drawn thin. Below 10, one removal moves the estimate by more than a tenth of its value. The tooltip and the table view give the count.
- **Last activity beside every curve.** Survival means unchanged, not correct: an abandoned repo's code survives by default.
- **Nothing from the API is trusted.** Every body is parsed with its schema from `@code-trust/shared`. A body that fails is an error state, never a partial render. Text goes into the page through text nodes only. The build adds a Content-Security-Policy whose `connect-src` is the API's origin, so the browser itself refuses any other request.

## Polling

The open view refreshes every 10 minutes while its tab is visible and never while it is hidden. When the tab becomes visible again, it refetches if the last request is more than a minute old. Neon's free plan has 100 CU-hours a month and suspends after 5 idle minutes, so a faster poll from one open tab would keep it awake around the clock, while metrics only change when a push is analyzed.

A failed refresh keeps the last good data on screen and says it is stale; the next poll tries again. A 404 is different: the repo was made private, deleted or uninstalled, so its old data goes and the view says it was not found. In the list, a repo whose summary answers 404 loses only its row; any other failed summary fails the whole list, because a list that silently drops rows would misreport.

`/repos` carries no metrics, so the list requests each analyzed repo's summary, at most 4 at a time: one extra request per repo per poll, a stopgap recorded in Decisions.

## Why no framework

Two views, one chart and a poller don't need a component model, and zod (which the shared schemas are written in) is already most of the bundle. The site is plain TypeScript: `src/dom.ts` builds elements, `src/views.ts` renders a view state, `src/app.ts` routes and polls.

| File | What it does |
| --- | --- |
| `src/api.ts` | The client: base URL, schema parsing, timeouts, typed errors |
| `src/load.ts` | What each view fetches, all or nothing |
| `src/poller.ts` | The 10 minute, visibility-aware poll |
| `src/curve.ts` | Step-function geometry: runs, scales, ticks, the value on a day |
| `src/chart.ts` | The SVG chart, its tooltip, notes and table view |
| `src/views.ts` | The repo list and the repo view |
| `src/app.ts` | Hash routes and each view's lifecycle |

Routes are hashes because Pages serves files and cannot send `/code-trust/repos/1` to `index.html`. Vite is pinned to the version Vitest already uses, so the tree holds one Vite.

## Run it locally

From the repo root, with the workspace database (`.env.workspace`):

```sh
pnpm --filter @code-trust/db migrate
pnpm --filter @code-trust/api seed
pnpm --filter @code-trust/api dev
pnpm --filter @code-trust/dashboard dev
```

The API listens on `$CONDUCTOR_PORT` and the dashboard on `$CONDUCTOR_PORT + 1`, both on 127.0.0.1. Open `http://127.0.0.1:$((CONDUCTOR_PORT+1))/code-trust/#/repos/1296269` for the seeded repo. In dev the page calls `/api/...`, which Vite proxies to the local API, so no CORS is involved:

```sh
curl -s localhost:$((CONDUCTOR_PORT+1))/api/repos/1296269
```

Tests run under happy-dom and need no server: `pnpm --filter @code-trust/dashboard test`.

To build: `VITE_API_URL=https://example.invalid pnpm --filter @code-trust/dashboard build` writes `dist/`, with asset URLs under `/code-trust/`. The build fails without an https `VITE_API_URL`. `vite preview` (on `$CONDUCTOR_PORT + 2`) serves a build, but it can't reach the deployed API: its CORS allows only `https://wahidbabar.github.io`.

## Deploy

`.github/workflows/pages.yml` builds on every pull request that touches the dashboard, `packages/shared`, the lockfile or the workflow, against `https://example.invalid`. On a push to `main` that touches the same paths, or when run by hand, it tests, builds with `VITE_API_URL` from the `API_URL` repository variable, and deploys to Pages. While `API_URL` is unset, the build and deploy jobs are skipped, so `main` stays green.

One-time steps for the human, after `CodeTrustApi` is deployed:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Read the API's URL, as in the Deploy section of `apps/api/README.md`. It ends in `/`, which is fine: the client strips it.

   ```bash
   aws cloudformation describe-stacks --region ap-south-1 --stack-name CodeTrustApi \
     --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text
   ```

3. Settings → Secrets and variables → Actions → Variables → New repository variable: name `API_URL`, value that URL. It is not a secret: the built site contains it.
4. Setting a variable triggers nothing, so run the workflow once: Actions → Pages → Run workflow, on `main`.
5. Open `https://wahidbabar.github.io/code-trust/`. A repo observed for less than 30 days shows "not observed yet" for each horizon of each cohort it has lines in.
