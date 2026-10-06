#!/usr/bin/env bash
# Proves dist/git-layer.zip in the Lambda runtime: the layer mounted read-only at /opt in the
# arm64 nodejs:24 image, every command run with only PATH and HOME, as the analyzer runs git.
# Needs Docker, network access, the built zip, and `pnpm install` done in this worktree.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
zip="$here/dist/git-layer.zip"
runtime_image=public.ecr.aws/lambda/nodejs:24

[ -f "$zip" ] || {
  echo "smoke: $zip is missing. Run pnpm build:git-layer first." >&2
  exit 1
}
[ -d "$repo/node_modules/.pnpm" ] || {
  echo 'smoke: no node_modules. Run pnpm install first.' >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo 'smoke: Docker is not running.' >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unzip -q "$zip" -d "$tmp/opt"

docker pull -q --platform linux/arm64 "$runtime_image" >/dev/null
echo "image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$runtime_image")"
# The image's own environment already puts /opt/lib on LD_LIBRARY_PATH. That is why every command
# below starts from env -i: inheriting it would hide a wrapper that fails to set its own.
echo "image env: $(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$runtime_image" | grep '^LD_LIBRARY_PATH=')"

# Runs as /bin/sh inside the image. Node lives in /var/lang/bin, which this PATH leaves out, so it
# is called by its full path.
inner_script() {
  cat <<'EOF'
set -eu
only() { env -i PATH=/usr/local/bin:/usr/bin:/bin:/opt/bin HOME=/tmp "$@"; }
repo_url=https://github.com/octocat/Hello-World

echo "== arch: $(uname -m)"
[ "$(uname -m)" = aarch64 ]
if [ -e /usr/bin/git ] || [ -e /usr/local/bin/git ] || [ -e /bin/git ]; then
  echo 'the image has a git of its own, so this would not test the layer' >&2
  exit 1
fi

echo '== the whole environment git gets'
environment=$(only /usr/bin/env)
echo "$environment"
[ "$environment" = 'PATH=/usr/local/bin:/usr/bin:/bin:/opt/bin
HOME=/tmp' ]

echo "== git on PATH: $(only /bin/sh -c 'command -v git')"
[ "$(only /bin/sh -c 'command -v git')" = /opt/bin/git ]

echo '== 1. git --version'
version=$(only git --version)
echo "$version"
numbers=${version#git version }
major=${numbers%%.*}
rest=${numbers#*.}
minor=${rest%%.*}
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 41 ]; }; then
  echo 'git 2.41 or newer is required' >&2
  exit 1
fi

echo "== CA bundle: $(ls -lL /etc/pki/tls/certs/ca-bundle.crt)"

echo "== 2. git clone $repo_url"
if ! only git clone --single-branch --no-tags "$repo_url" /tmp/hello 2>/tmp/clone-log; then
  cat /tmp/clone-log >&2
  exit 1
fi
clone_log=$(cat /tmp/clone-log)
echo "$clone_log"
# Without the layer's templates, clone still works but warns.
case "$clone_log" in
  *warning:*)
    echo 'clone printed a warning' >&2
    exit 1
    ;;
esac
only git -C /tmp/hello log --oneline

echo '== 2b. with an empty CA file the same remote must fail, so certificates are checked'
# From /tmp: /repo is a worktree whose .git file points at a host path, and git would stop on
# that before it reached the network.
if only git -C /tmp -c http.sslCAInfo=/dev/null ls-remote "$repo_url" HEAD 2>/tmp/tls-error; then
  echo 'ls-remote succeeded without a CA file: certificate checks are off' >&2
  exit 1
fi
tls_error=$(cat /tmp/tls-error)
echo "$tls_error"
case "$tls_error" in
  *certificate* | *CAfile* | *'trust anchors'*) ;;
  *)
    echo 'ls-remote failed, but not on the certificate check' >&2
    exit 1
    ;;
esac
# The same call with verification off must work, so the failure above was the check itself.
only git -C /tmp -c http.sslVerify=false -c http.sslCAInfo=/dev/null ls-remote "$repo_url" HEAD

echo '== 3. analyzer CLI on the clone'
only /var/lang/bin/node packages/analyzer/src/cli.ts /tmp/hello

echo '== 4. walk --check on the clone (blame and cat-file at the head)'
only /var/lang/bin/node packages/analyzer/src/history/cli.ts /tmp/hello --check

echo 'smoke: ok'
EOF
}

docker run --rm --platform linux/arm64 --entrypoint /bin/sh \
  -v "$tmp/opt:/opt:ro" -v "$repo:/repo:ro" -w /repo \
  "$runtime_image" -c "$(inner_script)"
