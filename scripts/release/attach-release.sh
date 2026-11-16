#!/usr/bin/env bash
# Attaches every installer and package built for a v<version> tag to that tag's GitHub release (ADR 0080, ADR 0182).
#
#   scripts/release/attach-release.sh <tag> <folder holding the one built .exe> <folder holding the one built .deb>
#
# Each file's name comes from tauri.conf.json's version, so a tag that doesn't match it is refused: the release must
# hold the build of the version it names. Every file is checked before anything is published. Each is renamed
# without spaces and gets a .sha256 beside it. The release is created if the tag has none, otherwise its assets are
# replaced. Needs `gh` with GH_TOKEN and GH_REPO set.
set -euo pipefail

tag=${1:?tag, like v0.2.0}
nsis=${2:?folder with the Windows installer}
deb=${3:?folder with the .deb}

if [[ ! $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  echo "error: $tag isn't a v<semver> tag" >&2
  exit 1
fi
version=${BASH_REMATCH[1]}

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
assets=()
shopt -s nullglob

stage() { # folder, the end of the name tauri build gives it, the published name
  local dir=$1 suffix=$2 name=$3 ext=.${2##*.}
  local found=("$dir"/*"$ext")
  if (( ${#found[@]} != 1 )); then
    echo "error: expected one $ext in $dir, found ${#found[@]}" >&2
    exit 1
  fi
  if [[ $(basename "${found[0]}") != *"$suffix" ]]; then
    echo "error: $(basename "${found[0]}") wasn't built as $version. Bump the version (npm run bump) before tagging $tag." >&2
    exit 1
  fi
  cp "${found[0]}" "$out/$name"
  (cd "$out" && sha256sum "$name" > "$name.sha256")
  assets+=("$out/$name" "$out/$name.sha256")
}

exe=hermes-chat_${version}_x64-setup.exe
package=hermes-chat_${version}_amd64.deb
stage "$nsis" "_${version}_x64-setup.exe" "$exe"
stage "$deb" "_${version}_amd64.deb" "$package"

prerelease=()
[[ $version == *-* ]] && prerelease=(--prerelease)

if gh release view "$tag" > /dev/null 2>&1; then
  gh release upload "$tag" "${assets[@]}" --clobber
else
  notes="Highwing $version, built by the installers workflow from $tag.

**Windows:** download $exe and run it. It installs for your Windows user only. The installer isn't code-signed, so Windows SmartScreen warns on first run: choose More info, then Run anyway. To update, run a newer installer over the old one.

**Debian and Ubuntu (x86_64):** download $package and install it with \`sudo apt install ./$package\`. It is built on Ubuntu 24.04, so it needs Ubuntu 24.04, Debian 13 or newer. The app doesn't update a .deb install: to update, install a newer .deb the same way."
  gh release create "$tag" "${assets[@]}" --verify-tag \
    --title "Highwing $version" --notes "$notes" "${prerelease[@]}"
fi
echo "Attached $exe and $package to $tag"
