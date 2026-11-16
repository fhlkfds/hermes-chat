#!/usr/bin/env bash
# Checks attach-release.sh against a stand-in `gh` that records its calls: a matching tag creates the release with
# the renamed installer and .deb and checksums that verify, an existing release gets its assets replaced, a
# prerelease tag is marked so, and a mismatched tag, a non-semver tag, and zero or two of either file are refused
# before anything is published.
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
for a in "$@"; do [[ $a == *.sha256 ]] && (cd "$(dirname "$a")" && sha256sum -c --quiet "$(basename "$a")") >> "$GH_LOG" 2>&1 && echo "checksum ok $(basename "$a")" >> "$GH_LOG"; done
exit 0
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

installer() { mkdir -p "$1"; head -c 4096 /dev/urandom > "$1/Highwing_$2_x64-setup.exe"; }
package() { mkdir -p "$1"; head -c 4096 /dev/urandom > "$1/Highwing_$2_amd64.deb"; }

run() { # name, expect (0 or 1), log pattern or "", tag, installer folder, .deb folder, [has release]
  local name=$1 expect=$2 pattern=$3
  export GH_LOG="$work/$name.log" GH_HAS_RELEASE=${7:-}
  : > "$GH_LOG"
  scripts/release/attach-release.sh "$4" "$5" "$6" > "$work/$name.out" 2>&1
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

exe='hermes-chat_0\.2\.0_x64-setup\.exe'
deb='hermes-chat_0\.2\.0_amd64\.deb'
installer "$work/nsis" 0.2.0
package "$work/deb" 0.2.0
run creates 0 "^release create v0\\.2\\.0 \\S*/$exe \\S*/$exe\\.sha256 \\S*/$deb \\S*/$deb\\.sha256 --verify-tag" \
  v0.2.0 "$work/nsis" "$work/deb"
grep -q 'prerelease' "$work/creates.log" && { echo "FAIL creates: marked as a prerelease"; fail=1; }
for f in "$exe" "$deb"; do
  grep -qE "^checksum ok $f\\.sha256$" "$work/creates.log" || { echo "FAIL creates: $f's .sha256 didn't verify"; fail=1; }
done
grep -qF 'sudo apt install ./hermes-chat_0.2.0_amd64.deb' "$work/creates.log" \
  || { echo "FAIL creates: the notes don't say how to install the .deb"; fail=1; }
run replaces 0 "^release upload v0\\.2\\.0 \\S*/$exe \\S*/$exe\\.sha256 \\S*/$deb \\S*/$deb\\.sha256 --clobber$" \
  v0.2.0 "$work/nsis" "$work/deb" yes
installer "$work/beta-nsis" 0.3.0-beta.1
package "$work/beta-deb" 0.3.0-beta.1
run prerelease 0 '^release create v0\.3\.0-beta\.1 .*--prerelease' v0.3.0-beta.1 "$work/beta-nsis" "$work/beta-deb"
run wrong-version 1 '' v0.2.1 "$work/nsis" "$work/deb"
package "$work/old-deb" 0.1.9
run deb-wrong-version 1 '' v0.2.0 "$work/nsis" "$work/old-deb"
run not-semver 1 '' release-1 "$work/nsis" "$work/deb"
mkdir "$work/empty"
run no-installer 1 '' v0.2.0 "$work/empty" "$work/deb"
run no-deb 1 '' v0.2.0 "$work/nsis" "$work/empty"
installer "$work/two-nsis" 0.2.0; head -c 10 /dev/zero > "$work/two-nsis/other.exe"
run two-installers 1 '' v0.2.0 "$work/two-nsis" "$work/deb"
package "$work/two-deb" 0.2.0; head -c 10 /dev/zero > "$work/two-deb/other.deb"
run two-debs 1 '' v0.2.0 "$work/nsis" "$work/two-deb"

exit $fail
