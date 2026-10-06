#!/usr/bin/env bash
# pnpm build:git-layer: builds dist/git-layer.zip, a Lambda layer with git at /opt/bin/git, from
# the Amazon Linux 2023 packages pinned in packages.txt. Needs Docker. README.md has the details.
#
# Three containers share one Docker volume, so no package or extracted file lands on the host:
#   1. Amazon Linux 2023: download the pinned packages, check their signatures, unpack, stage git.
#   2. The Lambda nodejs:24 image: copy in only the libraries that image lacks.
#   3. Amazon Linux 2023: zip the staged layer the same way every time.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dist="$here/dist"
platform=linux/arm64
build_image=public.ecr.aws/amazonlinux/amazonlinux:2023
runtime_image=public.ecr.aws/lambda/nodejs:24

docker info >/dev/null 2>&1 || {
  echo 'build-git-layer: Docker is not running.' >&2
  exit 1
}

# A failed build leaves no zip, so GitLayer refuses to synthesize rather than ship an old one.
mkdir -p "$dist"
rm -f "$dist/git-layer.zip" "$dist/git-layer.zip.tmp"

# The library check must run against the runtime Lambda runs today, not a stale local copy.
docker pull -q --platform "$platform" "$build_image" >/dev/null
docker pull -q --platform "$platform" "$runtime_image" >/dev/null

work=$(docker volume create)
trap 'docker volume rm -f "$work" >/dev/null' EXIT

in_container() {
  docker run --rm --platform "$platform" -v "$work:/work" "$@"
}

stage_script() {
  cat <<'EOF'
set -euo pipefail
dnf -q -y install dnf-plugins-core cpio >/dev/null
pins=$(grep -Ev '^[[:space:]]*(#|$)' /src/packages.txt)
mkdir -p /work/rpms /work/root
cd /work/rpms
# shellcheck disable=SC2086 # one argument per pin
dnf -q download $pins
for pin in $pins; do
  [ -f "$pin.rpm" ] || { echo "build-git-layer: $pin did not download" >&2; exit 1; }
done
rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-amazon-linux-2023
rpm -K ./*.rpm
for rpm in ./*.rpm; do rpm2cpio "$rpm" | (cd /work/root && cpio -idm --quiet); done

layer=/work/layer
install -d "$layer/bin" "$layer/libexec/git-core" "$layer/share/git-core" "$layer/lib"
install -m 0755 /src/git-wrapper.sh "$layer/bin/git"
install -m 0755 /work/root/usr/bin/git "$layer/libexec/git-core/git"
install -m 0755 /work/root/usr/libexec/git-core/git-remote-http "$layer/libexec/git-core/git-remote-http"
# A symlink in the package. Copied, so the zip holds no links at all.
install -m 0755 /work/root/usr/libexec/git-core/git-remote-http "$layer/libexec/git-core/git-remote-https"
cp -R /work/root/usr/share/git-core/templates "$layer/share/git-core/templates"
EOF
}

# Runs in the Lambda image, which may have no ldd, sed or find: plain sh, cp and the loader.
find_libs_script() {
  cat <<'EOF'
set -eu
loader=/lib/ld-linux-aarch64.so.1
layer=/work/layer
binaries="$layer/libexec/git-core/git $layer/libexec/git-core/git-remote-http"

# Exactly what git gets at runtime: the wrapper's LD_LIBRARY_PATH and nothing of the image's own,
# which lists /var/lang/lib and /var/runtime/lib that git never sees.
list() {
  for binary in $binaries; do
    out=$(env -i LD_LIBRARY_PATH="$layer/lib" "$loader" --list "$binary" 2>&1) || true
    case "$out" in
      *"libc.so.6 => /"*) ;;
      *) echo "build-git-layer: the loader could not list $binary:" >&2; echo "$out" >&2; exit 1 ;;
    esac
    echo "$out"
  done
}

round=0
while :; do
  round=$((round + 1))
  [ "$round" -le 8 ] || { echo 'build-git-layer: libraries still missing after 8 rounds' >&2; exit 1; }
  listing=$(list)
  added=0
  while IFS= read -r line; do
    case "$line" in
      *"version \`"*"not found"*) echo "build-git-layer: symbol version mismatch: $line" >&2; exit 1 ;;
    esac
    # shellcheck disable=SC2086 # split the line into fields
    set -- $line
    [ "${2-}" = '=>' ] && [ "${3-}" = 'not' ] || continue
    soname=$1
    case "$soname" in
      libc.so.* | libm.so.* | libdl.so.* | librt.so.* | libpthread.so.* | libresolv.so.* | libutil.so.* | ld-linux*)
        echo "build-git-layer: $soname is part of glibc and missing from the runtime image" >&2
        exit 1
        ;;
    esac
    [ -e "$layer/lib/$soname" ] && continue
    source=''
    for dir in /work/root/usr/lib64 /work/root/lib64; do
      if [ -e "$dir/$soname" ]; then source="$dir/$soname"; break; fi
    done
    if [ -z "$source" ]; then
      echo "build-git-layer: no pinned package provides $soname. Find one with" >&2
      echo "  dnf provides '$soname()(64bit)'" >&2
      echo "in an Amazon Linux 2023 container and add it to packages.txt." >&2
      exit 1
    fi
    cp -L "$source" "$layer/lib/$soname"
    added=$((added + 1))
  done <<LISTING
$listing
LISTING
  [ "$added" -gt 0 ] || break
done

ca=/etc/pki/tls/certs/ca-bundle.crt
[ -s "$ca" ] || { echo "build-git-layer: the runtime image has no CA bundle at $ca" >&2; exit 1; }

echo "runtime: $(. /etc/os-release && echo "$PRETTY_NAME"), CA bundle $ca"
echo 'libraries git loads (/work/layer/lib means the layer ships it):'
list | while read -r soname arrow target rest; do
  [ "$arrow" = '=>' ] && echo "  $soname => $target"
done | sort -u
EOF
}

pack_script() {
  cat <<'EOF'
set -euo pipefail
dnf -q -y install zip findutils >/dev/null
cd /work/layer

# Pins that put nothing in the layer: the runtime image has gained that library.
for rpm in /work/rpms/*.rpm; do
  name=$(basename "$rpm" .rpm)
  case "$name" in git-core-*) continue ;; esac
  used=no
  while read -r file; do
    if [ -e "lib/${file##*/}" ]; then used=yes; break; fi
  done < <(rpm -qlp "$rpm")
  [ "$used" = yes ] || echo "build-git-layer: warning: $name adds nothing; remove it from packages.txt" >&2
done

total=0
while read -r size; do total=$((total + size)); done < <(find . -type f -printf '%s\n')
if [ "$total" -ge "$MAX_UNZIPPED_BYTES" ]; then
  echo "build-git-layer: $total bytes unzipped, over Lambda's $MAX_UNZIPPED_BYTES" >&2
  exit 1
fi

# Fixed times, a fixed order and no extra attributes: the same pins give the same bytes, so CDK
# sees the same asset and publishes no new layer version.
find . -exec touch -h -t 202601010000 {} +
find bin libexec share lib | LC_ALL=C sort | zip -X -q /out/git-layer.zip.tmp -@
chown "$HOST_UID:$HOST_GID" /out/git-layer.zip.tmp
mv /out/git-layer.zip.tmp /out/git-layer.zip

echo "layer: $(find . -type f | wc -l) files, $total bytes unzipped"
find . -type f -printf '  %8s  %p\n' | LC_ALL=C sort -k2
EOF
}

echo "== 1/3 download and unpack the pinned packages"
in_container -v "$here:/src:ro" "$build_image" bash -c "$(stage_script)"

echo "== 2/3 find the libraries $runtime_image lacks"
in_container --entrypoint /bin/sh "$runtime_image" -c "$(find_libs_script)"

echo "== 3/3 zip"
# Lambda's limit is for a function and all its layers together, unzipped.
in_container -v "$dist:/out" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e MAX_UNZIPPED_BYTES=262144000 \
  "$build_image" bash -c "$(pack_script)"

for image in "$build_image" "$runtime_image"; do
  echo "image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
done
ls -l "$dist/git-layer.zip"
