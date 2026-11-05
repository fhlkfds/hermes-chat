#!/usr/bin/env bash
# Builds the standalone AppImage with the updater turned on, signs it, stages it with its signature and latest.json
# under release/, verifies the staged files with minisign, and checks that no key material was staged. Nothing is
# published (docs/releases.md, "Rehearse a release").
#
#   scripts/release/dry-run.sh                                  # a throwaway key, made here and deleted at the end
#   HERMES_CHAT_UPDATER_KEY=<key file> scripts/release/dry-run.sh   # the owner's key
#
# With the owner's key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD must hold its password and
# src-tauri/tauri.release.conf.json its public key. Needs node_modules (npm ci) and minisign.
set -euo pipefail
cd "$(dirname "$0")/../.."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${HERMES_CHAT_UPDATER_KEY:-}" ]; then
  key=$HERMES_CHAT_UPDATER_KEY
  pubkey=$(node -p 'require("./src-tauri/tauri.release.conf.json").plugins.updater.pubkey')
  if [ -z "$pubkey" ]; then
    echo "src-tauri/tauri.release.conf.json holds no public key, so the app couldn't verify what $key signs" >&2
    exit 1
  fi
  : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD?set TAURI_SIGNING_PRIVATE_KEY_PASSWORD, empty for a key without one}"
else
  key=$work/throwaway.key
  # Prints the paths it wrote and advice, never the key; stdout is dropped all the same.
  node_modules/.bin/tauri signer generate -w "$key" -p "" --ci > /dev/null
  pubkey=$(cat "$key.pub")
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi
chmod 600 "$key"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  # Any later print of the key shows as *** in the job's log.
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] && echo "::add-mask::$line"
  done < "$key"
fi

node -e '
  const config = require("./src-tauri/tauri.release.conf.json");
  config.plugins.updater.pubkey = process.argv[1];
  require("fs").writeFileSync(process.argv[2], JSON.stringify(config));
' "$pubkey" "$work/release.conf.json"
# The CLI takes the key as a path, so its contents never enter an environment a tool could print.
TAURI_SIGNING_PRIVATE_KEY=$key node_modules/.bin/tauri build --bundles appimage --config "$work/release.conf.json"

version=$(node -p 'require("./src-tauri/tauri.conf.json").version')
printf 'A dry run from commit %s. Not a release.\n' "$(git rev-parse HEAD)" > "$work/notes.txt"
rm -rf release
node scripts/release/manifest.mjs "${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/appimage" release \
  "https://github.com/l0cky12/hermes-chat/releases/download/v$version" "$work/notes.txt"
printf '%s' "$pubkey" > release/updater.key.pub

scripts/release/verify.sh release "$pubkey"
if grep -rqF -f "$key" release; then
  echo "the private key is in release/" >&2
  exit 1
fi
echo "release/ holds the signed AppImage, its signature, latest.json and the public key, and nothing of the private key"
