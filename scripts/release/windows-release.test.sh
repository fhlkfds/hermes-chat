#!/usr/bin/env bash
# Checks windows-release.sh against a stand-in `gh` that records its calls: a matching tag creates the release
# with the renamed installer and a checksum that verifies, an existing release gets its assets replaced, a
# prerelease tag is marked so, and a mismatched tag, a non-semver tag, and zero or two installers are refused.
set -uo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

mkdir "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
args=("${@//$'\n'/ }"); echo "${args[*]}" >> "$GH_LOG"
if [[ $1 == release && $2 == view ]]; then [[ -n ${GH_HAS_RELEASE:-} ]]; exit; fi
for a in "$@"; do [[ $a == *.sha256 ]] && (cd "$(dirname "$a")" && sha256sum -c --quiet "$(basename "$a")") >> "$GH_LOG" 2>&1 && echo "checksum ok" >> "$GH_LOG"; done
exit 0
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

installer() { mkdir -p "$1"; head -c 4096 /dev/urandom > "$1/Hermes Chat_$2_x64-setup.exe"; }

run() { # name, expect (0 or 1), log pattern or "", folder, tag, [has release]
  local name=$1 expect=$2 pattern=$3 dir=$4 tag=$5
  export GH_LOG="$work/$name.log" GH_HAS_RELEASE=${6:-}
  : > "$GH_LOG"
  scripts/release/windows-release.sh "$dir" "$tag" > "$work/$name.out" 2>&1
  local code=$?
  if (( (code != 0) != expect )); then
    echo "FAIL $name: exit $code"; cat "$work/$name.out"; fail=1; return
  fi
  if [[ -n $pattern ]] && ! grep -qE "$pattern" "$GH_LOG"; then
    echo "FAIL $name: gh calls didn't match /$pattern/"; cat "$GH_LOG"; fail=1; return
  fi
  if (( expect == 1 )) && grep -qE 'release (create|upload)' "$GH_LOG"; then
    echo "FAIL $name: refused but still called gh to publish"; fail=1; return
  fi
  echo "ok   $name"
}

installer "$work/good" 0.2.0
run creates 0 '^release create v0\.2\.0 .*/hermes-chat_0\.2\.0_x64-setup\.exe .*hermes-chat_0\.2\.0_x64-setup\.exe\.sha256 --verify-tag' "$work/good" v0.2.0
grep -q 'prerelease' "$work/creates.log" && { echo "FAIL creates: marked as a prerelease"; fail=1; }
grep -q '^checksum ok' "$work/creates.log" || { echo "FAIL creates: the .sha256 didn't verify"; fail=1; }
run replaces 0 '^release upload v0\.2\.0 .* --clobber$' "$work/good" v0.2.0 yes
installer "$work/beta" 0.3.0-beta.1
run prerelease 0 '^release create v0\.3\.0-beta\.1 .*--prerelease' "$work/beta" v0.3.0-beta.1
run wrong-version 1 '' "$work/good" v0.2.1
run not-semver 1 '' "$work/good" release-1
mkdir "$work/empty"
run no-installer 1 '' "$work/empty" v0.2.0
installer "$work/two" 0.2.0; head -c 10 /dev/zero > "$work/two/other.exe"
run two-installers 1 '' "$work/two" v0.2.0

exit $fail
