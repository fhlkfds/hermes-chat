LC_ALL=C; export LC_ALL
pkgs="xfce4-terminal mousepad xclip"
if command -v apt-get >/dev/null 2>&1; then run="DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $pkgs || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $pkgs; }"
elif command -v dnf >/dev/null 2>&1; then run="dnf install -y $pkgs"
elif command -v pacman >/dev/null 2>&1; then run="pacman -S --needed --noconfirm $pkgs"
else echo "no apt-get, dnf or pacman on the server" >&2; exit 3; fi
if [ "$(id -u)" = 0 ]; then exec sh -c "$run"; fi
command -v sudo >/dev/null 2>&1 || { echo "the server has no sudo" >&2; exit 4; }
if sudo -n true 2>/dev/null; then exec sudo -n sh -c "$run"; fi
[ "$1" = password ] || exit 10
exec sudo -S -p "" sh -c "$run"
