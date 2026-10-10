# T11: Git for the Lambda runtime (a layer built from Amazon Linux 2023 packages)

Status: done
Wave: 2
Depends on: T01
Owner paths (edit only these):
- `infra/layers/git/**` (new)
- `infra/lib/git-layer.ts`, `infra/lib/git-layer.test.ts` (new)
- `package.json` (root: only the `synth` script's environment and a new `build:git-layer` script)
- `.gitignore` (the layer's build output only)
- docs/architecture.md (your rows in Decisions)
Read first:
- docs/architecture.md (Cost rules, and the Decisions rows on the worker on Lambda, on `ALERT_EMAIL` and its synth placeholder, on esbuild bundles, and on the walker's git requirements)
- `packages/analyzer/src/history/git.ts` (`MIN_GIT_VERSION`, `gitEnv`: git gets only `PATH` and `HOME`) and `packages/analyzer/src/history/check.ts`
- `infra/lib/config.ts` (`resolveAlertEmail`, the placeholder pattern to copy)

## Task

The worker runs on Lambda's `nodejs24.x` runtime (Amazon Linux 2023, arm64), which has no git, and the analyzer needs git 2.41 or newer. This lane builds a Lambda layer that puts a working git at `/opt/bin/git`, and a `GitLayer` construct that T13 attaches to the worker. It is the riskiest piece of the worker, so it runs on its own and proves itself in the real runtime image before any stack depends on it. Building it needs Docker; `pnpm synth` and CI must not.

What is known: AL2023's arm64 repository has `git-core` 2.50.1, which depends on `bash`, `expat`, `glibc`, `less`, `libcurl`, `openssh-clients`, `openssl-libs`, `pcre2` and `zlib`. Which of those the Lambda runtime image already has is for you to find out.

## Where

- `infra/layers/git/build.sh` (or `.mjs`), run as `pnpm build:git-layer`: in an arm64 `public.ecr.aws/amazonlinux/amazonlinux:2023` container, downloads `git-core` at a pinned version, plus the shared libraries it needs that the `public.ecr.aws/lambda/nodejs:24` arm64 image lacks (find them with `ldd` inside that image), and writes `infra/layers/git/dist/git-layer.zip` (gitignored). Pin each package's exact version-release in one file, so a rebuild is the same layer.
- The layer's layout is yours, with one hard rule: `git` must work when its environment holds only `PATH` (including `/opt/bin`) and `HOME`, because that is all the analyzer's `gitEnv` passes. `LD_LIBRARY_PATH` and `GIT_EXEC_PATH` will not reach it. A wrapper script at `/opt/bin/git` that sets them and `exec`s the real binary is one way; say which you chose. HTTPS clone (`git-remote-https`) must work, with the runtime's CA bundle.
- `infra/layers/git/smoke.sh`, run as part of the proof: unzips the layer into a temp dir, mounts it at `/opt` in the arm64 `public.ecr.aws/lambda/nodejs:24` image (entrypoint overridden), and inside it, under `env -i PATH=/usr/local/bin:/usr/bin:/bin:/opt/bin HOME=/tmp`:
  1. `git --version` prints 2.41 or newer;
  2. `git clone --single-branch --no-tags https://github.com/octocat/Hello-World /tmp/hello` succeeds;
  3. the analyzer runs on that clone with this git: mount the repo root read-only and run `node packages/analyzer/src/cli.ts /tmp/hello` (Node 24 strips types by default), which exits 0.
- `infra/layers/git/README.md`: what is in the layer, how to rebuild and re-pin it, and that the human builds it before deploying `CodeTrustWorker`.
- `infra/lib/git-layer.ts`: `GitLayer`, a construct that makes an arm64 `LayerVersion` for `nodejs24.x` from the zip. It uses a tiny placeholder asset instead when `Stack.of(this).bundlingRequired` is false, which is the case when another stack is being deployed (the CLI bundles only the selected stacks) and in the assertion tests, so deploying `CodeTrustApi` never needs the zip. When bundling is required and the zip is missing, it throws an error that says to run `pnpm build:git-layer`, unless `GIT_LAYER_PLACEHOLDER=1`. The root `synth` script, which bundles every stack, sets that flag next to `ALERT_EMAIL_PLACEHOLDER=1`; a deploy never does, so a worker cannot ship without git.
- `infra/lib/git-layer.test.ts`: the construct in a throwaway test stack.

## Done when

- [ ] `pnpm build:git-layer` exits 0 and writes `infra/layers/git/dist/git-layer.zip`; show its size and `unzip -l` summary. The unzipped layer is under Lambda's 250 MB limit.
- [ ] `infra/layers/git/smoke.sh` exits 0 and its output shows the git version (2.41 or newer), the clone, and the analyzer CLI's report on Hello-World, all inside the Lambda runtime image under the two-variable environment.
- [ ] `pnpm --filter @code-trust/infra test` passes with named tests: the layer is compatible with `arm64` and `nodejs24.x` only; with bundling skipped for its stack (`aws:cdk:bundling-stacks` set to an empty list) it synthesizes with no zip and no flag; with bundling required, no zip and no flag it throws an error naming `pnpm build:git-layer`; with the flag it synthesizes.
- [ ] `pnpm synth` exits 0 with no AWS credentials, no zip present and no Docker use: `pnpm synth 2>&1 | grep -ci docker` prints 0. (No stack uses `GitLayer` yet; this proves the root script still works.)
- [ ] `git status --porcelain` shows no zip, RPM or extracted binary staged or untracked.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- `WorkerStack`, the worker function and `infra/bin/app.ts`: T13 attaches the layer.
- Building git from source. AL2023's package is new enough; if it turns out not to work in the Lambda image, stop and ask.
- A container-image Lambda. Images need Docker at synth and an ECR repository that bills for storage.
- Public layers from other accounts: their ARNs carry an account ID, and their contents are not pinned here.
- Committing any binary.

## Notes

- Docker (OrbStack) runs on an Apple Silicon Mac, so arm64 images run natively. Pass `--platform linux/arm64` anyway, so the script means the same on any machine.
- `dnf download` in the AL2023 container, then `rpm2cpio | cpio -idm` (install `cpio` in the build container if needed), gives files without installing them. `dnf install --installroot` is the other route. Either way, copy only what git needs: `git`, `git-remote-https` (and `git-remote-http`) from `libexec/git-core`, the templates directory if clone warns without it, and the libraries `ldd` reports missing in the Lambda image. No Perl, Tcl or Python parts.
- Size matters twice: the layer counts toward the 250 MB unzipped limit with the function, and every cold start loads it. A few tens of MB is expected.
- Lambda's `PATH` includes `/opt/bin`; libraries in `/opt/lib` are on Lambda's default `LD_LIBRARY_PATH`, but the analyzer's git calls do not inherit it.
- The smoke test's third step reaches `node_modules` through pnpm's symlinks inside the mounted repo root, so mount the whole worktree, not just `packages/analyzer`.
- The placeholder flag follows the `ALERT_EMAIL` pattern: only the root `synth` script may set it. Record the flag and the `bundlingRequired` rule as a Decisions row, together with the layer's source and the wrapper choice.
- Pin with exact version-release strings such as `git-core-2.50.1-1.amzn2023.0.1`. AL2023 security updates will replace them; the README says how to re-pin.
- Changing the root `package.json` makes `verify:changed` run the full `pnpm verify`. That is expected.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm build:git-layer writes infra/layers/git/dist/git-layer.zip under 250 MB unzipped, infra/layers/git/smoke.sh exits 0 showing git 2.41 or newer, an HTTPS clone of octocat/Hello-World and the analyzer CLI's report on it inside the arm64 Lambda nodejs:24 image with only PATH and HOME set, pnpm --filter @code-trust/infra test passes with the GitLayer tests in Done when, pnpm synth exits 0 without the zip, credentials or Docker, no binary is tracked or untracked in git status, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
