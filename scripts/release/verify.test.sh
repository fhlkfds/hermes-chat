#!/usr/bin/env bash
# Stages a release signed with a throwaway key, then checks that verify.sh passes it and refuses each broken copy.
# Needs node_modules (npm ci) and minisign.
set -uo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tauri=node_modules/.bin/tauri

$tauri signer generate -w "$work/a.key" -p "" --ci > /dev/null
$tauri signer generate -w "$work/b.key" -p "" --ci > /dev/null
# An ELF header for the machine given (62 x86-64, 183 AArch64), then noise.
appimage() {
  { printf '\177ELF\2\1\1'; head -c 9 /dev/zero; printf '\2\0'; printf "\\$(printf %03o "$1")\\0"; head -c 4076 /dev/urandom; } > "$2"
  TAURI_SIGNING_PRIVATE_KEY_PATH=$work/a.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    $tauri signer sign --app-version 0.2.0 "$2" > /dev/null
}
mkdir "$work/bundle" "$work/arm"
appimage 62 "$work/bundle/Hermes Chat_0.2.0_amd64.AppImage"
node scripts/release/manifest.mjs "$work/bundle" "$work/good" https://example.invalid/v0.2.0 > /dev/null
appimage 183 "$work/arm/Hermes Chat_0.2.0_amd64.AppImage"
node scripts/release/manifest.mjs "$work/arm" "$work/other-arch" https://example.invalid/v0.2.0 > /dev/null
key_a=$(cat "$work/a.key.pub")
key_b=$(cat "$work/b.key.pub")

failures=0
check() {
  local want=$1 name=$2 dir=$3 key=$4 out rc
  out=$(scripts/release/verify.sh "$dir" "$key" 2>&1)
  rc=$?
  if { [ "$want" = passes ] && [ $rc -eq 0 ]; } || { [ "$want" = refused ] && [ $rc -ne 0 ]; }; then
    echo "ok: $name $want ($(tail -n 1 <<< "$out"))"
  else
    echo "FAILED: $name should be $want, but verify.sh exited $rc: $out"
    failures=$((failures + 1))
  fi
}
broken() {
  cp -r "$work/good" "$work/$1"
  echo "$work/$1"
}

check passes "a genuine release" "$work/good" "$key_a"
check refused "a release checked with another key" "$work/good" "$key_b"
check refused "an AArch64 AppImage listed for x86-64" "$work/other-arch" "$key_a"
dir=$(broken tampered); printf 'x' >> "$dir/hermes-chat_0.2.0_amd64.AppImage"
check refused "a tampered AppImage" "$dir" "$key_a"
dir=$(broken truncated); truncate -s 2048 "$dir/hermes-chat_0.2.0_amd64.AppImage"
check refused "a truncated AppImage" "$dir" "$key_a"
dir=$(broken prefix); sed -i 's/"version": "0.2.0"/"version": "0.2"/' "$dir/latest.json"
check refused "a manifest announcing a prefix of the signed version" "$dir" "$key_a"
dir=$(broken longer); sed -i 's/"version": "0.2.0"/"version": "0.2.0.1"/' "$dir/latest.json"
check refused "a manifest announcing a longer version" "$dir" "$key_a"
dir=$(broken leaked); cp "$work/a.key" "$dir/updater.key"
check refused "a folder holding the private key" "$dir" "$key_a"
dir=$(broken missing); rm "$dir/hermes-chat_0.2.0_amd64.AppImage"
check refused "a manifest naming a missing AppImage" "$dir" "$key_a"
exit $((failures > 0))
