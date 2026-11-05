#!/usr/bin/env bash
# Checks a staged release folder (what scripts/release/manifest.mjs writes, or a downloaded dry-run artifact) the way
# the app will: the AppImage that latest.json names verifies with minisign against the public key, the signature was
# made for the version latest.json announces, and nothing in the folder is a private key.
#
#   scripts/release/verify.sh <release folder> <public key, as src-tauri/tauri.release.conf.json holds it>
#
# Needs node and minisign.
set -euo pipefail
dir=$1
pubkey=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf '%s' "$pubkey" | base64 -d > "$work/key.pub"
{ read -r version; read -r url; read -r signature; } < <(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const [platform] = Object.values(m.platforms);
  console.log(m.version, platform.url, platform.signature);
' "$dir/latest.json" | tr " " "\n")
file=$dir/${url##*/}
if [ ! -f "$file" ]; then
  echo "latest.json names $url, but ${url##*/} isn't in $dir" >&2
  exit 1
fi
printf '%s' "$signature" | base64 -d > "$work/file.minisig"
if ! cmp -s <(base64 -d "$file.sig") "$work/file.minisig"; then
  echo "the signature in latest.json isn't the one in ${file##*/}.sig" >&2
  exit 1
fi
minisign -Vm "$file" -x "$work/file.minisig" -p "$work/key.pub"
# The trusted comment is tab-separated fields, minisign verified it above, and the version must be one field exactly.
if ! awk -F'\t' -v want="version:$version" '/^trusted comment: / { sub(/^trusted comment: /, ""); for (i = 1; i <= NF; i++) if ($i == want) found = 1 } END { exit !found }' "$work/file.minisig"; then
  echo "the signature wasn't made for version $version, which latest.json announces" >&2
  exit 1
fi
# Tauri's secret keys are base64 of "untrusted comment: rsign encrypted secret key" and the key: either spelling is a
# leak, whether a file was staged decoded or as the CLI wrote it.
if grep -rqF -e "rsign encrypted secret key" -e "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu" "$dir"; then
  echo "a private key is in $dir" >&2
  exit 1
fi
echo "${file##*/} verifies against the public key for version $version, and no private key is staged"
