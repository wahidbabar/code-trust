# git layer

A Lambda layer that puts git at `/opt/bin/git` for the worker, which runs on `nodejs24.x` (Amazon Linux 2023, arm64). That runtime has no git, and the analyzer needs 2.41 or newer. `GitLayer` in `infra/lib/git-layer.ts` turns the zip built here into a `LayerVersion`. The zip is gitignored, and the human builds it before deploying `CodeTrustWorker`.

## What is in it

Amazon Linux 2023's own `git-core` package, pinned in `packages.txt` (today `git-core-2.50.1-1.amzn2023.0.1.aarch64`). Nothing is built from source. The Perl, Tcl and Python parts are left out.

| Path | What |
| --- | --- |
| `/opt/bin/git` | `git-wrapper.sh`, the only git on `PATH` |
| `/opt/libexec/git-core/git` | the real binary, the package's `/usr/bin/git` |
| `/opt/libexec/git-core/git-remote-http` | the helper behind `http://` and `https://` remotes |
| `/opt/libexec/git-core/git-remote-https` | a copy of it (a symlink in the package; the zip holds no links) |
| `/opt/share/git-core/templates/` | the package's templates, so `git clone` does not warn |
| `/opt/lib/` | libraries the runtime image lacks: none today |

About 6.4 MB unzipped and 3.2 MB zipped, against Lambda's 250 MB for a function and its layers together.

### Why a wrapper

The analyzer runs git with only `PATH` and `HOME` (`gitEnv` in `packages/analyzer/src/history/git.ts`), and the worker's own git calls follow the same rule. So Lambda's `LD_LIBRARY_PATH` never reaches git. Amazon Linux builds git with its helpers and templates at fixed paths under `/usr`, so without `GIT_EXEC_PATH` git cannot find `git-remote-https`, and without `GIT_TEMPLATE_DIR` every clone warns. `/opt/bin/git` sets `LD_LIBRARY_PATH=/opt/lib`, `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR`, then `exec`s the real binary.

An RPATH would only cover the libraries, and only after patching every binary and library. The exec path would still need the environment. Git puts `GIT_EXEC_PATH` first on `PATH` for its child processes, so commands it starts itself, such as `index-pack` during a clone, run the real binary with the wrapper's environment already set.

### Libraries

`git` loads `libpcre2-8`, `libz` and `libc`. `git-remote-http` also loads libcurl, OpenSSL, nghttp2, idn2, psl, krb5 and their dependencies. The `public.ecr.aws/lambda/nodejs:24` arm64 image has all of them, so the layer ships none, and git uses the runtime's libcurl and the runtime's CA bundle (`/etc/pki/tls/certs/ca-bundle.crt`). The wrapper still points `LD_LIBRARY_PATH` at `/opt/lib`, so a library the image drops later only needs a pin and a rebuild.

Every build checks this again in the current runtime image. It runs the image's own loader (`/lib/ld-linux-aarch64.so.1 --list`, which is what `ldd` runs) on both binaries, with only `LD_LIBRARY_PATH=/opt/lib`, which is all git gets at runtime. Each library reported missing is copied into `/opt/lib` from the pinned packages. The build fails when no pinned package provides it, when a library is part of glibc, or when a symbol version is missing.

## Build

```sh
pnpm build:git-layer
```

Needs Docker. It runs `linux/arm64` containers and takes about a minute:

1. In `public.ecr.aws/amazonlinux/amazonlinux:2023`, it downloads exactly the pinned packages, checks their signatures with `rpm -K`, unpacks them with `rpm2cpio | cpio` and stages the layout above.
2. In `public.ecr.aws/lambda/nodejs:24`, it finds the libraries that image lacks, as described above, and checks the CA bundle is there.
3. It zips the layer to `infra/layers/git/dist/git-layer.zip` with fixed file times and order, so the same pins give the same bytes, and CDK publishes no new layer version for an unchanged layer.

Nothing but the zip lands on the host: the steps share a Docker volume that is removed at the end. A failed build leaves no zip.

## Prove it

```sh
infra/layers/git/smoke.sh
```

It mounts the unzipped layer read-only at `/opt` in the arm64 `nodejs:24` image and runs every command under `env -i PATH=/usr/local/bin:/usr/bin:/bin:/opt/bin HOME=/tmp`:

1. `git --version`, which must be 2.41 or newer.
2. An HTTPS clone of `octocat/Hello-World`, then the same remote with an empty CA file, which must fail on the certificate check.
3. The analyzer CLI on the clone.
4. `walk --check` on the clone, which runs blame and `cat-file` at the head.

It needs network access and `pnpm install` done in the worktree, because it runs the analyzer from the mounted repo.

## Re-pin

Amazon Linux 2023 security updates replace packages. To move to the newest `git-core`:

1. Find the current version-release:

   ```sh
   docker pull --platform linux/arm64 public.ecr.aws/amazonlinux/amazonlinux:2023
   docker run --rm --platform linux/arm64 public.ecr.aws/amazonlinux/amazonlinux:2023 \
     dnf -q repoquery --latest-limit=1 --arch=aarch64 --qf '%{name}-%{version}-%{release}.%{arch}' git-core
   ```

2. Put it in `packages.txt`, then run `pnpm build:git-layer` and `infra/layers/git/smoke.sh`.
3. If the build says no pinned package provides a library, find the package with `dnf provides '<soname>()(64bit)'` in the same container, and pin its exact version the same way. If it warns that a pin adds nothing, remove that pin.
4. Commit `packages.txt`, then rebuild and redeploy the worker.

## Deploying

`GitLayer` decides what to synthesize from `Stack.of(this).bundlingRequired`:

- When the CLI bundles the layer's stack, the zip must exist, or synth stops with an error naming `pnpm build:git-layer`.
- When the CLI is not bundling that stack, `GitLayer` uses the one-file `placeholder/` directory instead. Nothing of that stack is deployed then.
- `pnpm synth` sets `GIT_LAYER_PLACEHOLDER=1`, so it works with no zip, for CI and the cost-guard agent. Nothing else may set it.

The CDK CLI bundles every stack in the app for `deploy`, `diff` and `synth`, unless `--exclusively` (`-e`) is given. Once a stack uses `GitLayer`, deploying any stack needs the zip. Build it first, or deploy the other stack by name with `--exclusively`.

Never deploy a cloud assembly that `pnpm synth` produced (`--app cdk.out`): it may hold the placeholder, a layer without git.
