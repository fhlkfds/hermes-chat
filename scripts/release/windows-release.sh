#!/usr/bin/env bash
# Attaches the Windows NSIS installer to the GitHub release for a v<version> tag (ADR 0080).
#
#   scripts/release/windows-release.sh <folder holding the one built .exe> <tag>
#
# The installer's file name comes from tauri.conf.json's version, so a tag that doesn't match it is refused:
# the release must hold the build of the version it names. The installer is renamed without spaces and gets a
# .sha256 beside it. The release is created if the tag has none, otherwise its two assets are replaced.
# Needs `gh` with GH_TOKEN and GH_REPO set.
set -euo pipefail

dir=${1:?folder with the installer}
tag=${2:?tag, like v0.2.0}

if [[ ! $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  echo "error: $tag isn't a v<semver> tag" >&2
  exit 1
fi
version=${BASH_REMATCH[1]}

shopt -s nullglob
exes=("$dir"/*.exe)
if (( ${#exes[@]} != 1 )); then
  echo "error: expected one .exe in $dir, found ${#exes[@]}" >&2
  exit 1
fi
built=${exes[0]}
case "$(basename "$built")" in
  *"_${version}_x64-setup.exe") ;;
  *)
    echo "error: $(basename "$built") wasn't built as $version. Bump version in src-tauri/tauri.conf.json before tagging $tag." >&2
    exit 1
    ;;
esac

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
name="hermes-chat_${version}_x64-setup.exe"
cp "$built" "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")

prerelease=()
[[ $version == *-* ]] && prerelease=(--prerelease)

if gh release view "$tag" > /dev/null 2>&1; then
  gh release upload "$tag" "$out/$name" "$out/$name.sha256" --clobber
else
  notes="Windows installer for Hermes Chat $version, built by the windows-installer workflow from $tag.

Download $name and run it. It installs for your Windows user only. The installer isn't code-signed, so Windows SmartScreen warns on first run: choose More info, then Run anyway. To update, run a newer installer over the old one."
  gh release create "$tag" "$out/$name" "$out/$name.sha256" --verify-tag \
    --title "Hermes Chat $version" --notes "$notes" "${prerelease[@]}"
fi
echo "Attached $name to $tag"
