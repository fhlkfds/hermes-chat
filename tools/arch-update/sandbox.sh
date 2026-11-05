#!/bin/sh
# A real pacman install and upgrade of hermes-chat-git without root and without touching the system (issue #102).
#
# `start` makes a user and mount namespace in which this user is root, and mounts writable copies over exactly what
# the package and pacman write: /usr/bin, /usr/share/applications, the hicolor icon folders, /var/lib/pacman (a copy
# of the real database), /var/cache/pacman/pkg and /var/log/pacman.log. In each copied folder every other file is a
# symlink to the real one, so /usr/bin/pacman, /usr/bin/sh and the rest still run; the package's own files are real
# copies. Inside, the real pacman reads and writes that database and replaces /usr/bin/hermes-chat as it would on the
# system, and the app sees /usr/bin/hermes-chat owned by the package.
#
# `run` runs a command in it as root (pacman); `user` as uid 1000 in a nested namespace sharing its mounts (the app,
# as an ordinary user). `stop` ends it. Nothing on the real system changes. pacman hooks that write elsewhere
# (gtk-update-icon-cache, update-desktop-database) fail with a warning.
#
#   tools/arch-update/sandbox.sh start /tmp/sbx
#   tools/arch-update/sandbox.sh run /tmp/sbx pacman -U --noconfirm hermes-chat-git-r564.6017fa6-1-x86_64.pkg.tar.zst
#   tools/arch-update/sandbox.sh run /tmp/sbx pacman -Qo /usr/bin/hermes-chat
#   tools/arch-update/sandbox.sh stop /tmp/sbx
set -eu

cmd=${1:?start, run, user or stop}
dir=${2:?the sandbox folder}

case $cmd in
start)
  mkdir -p "$dir"
  dir=$(cd "$dir" && pwd)
  [ ! -e "$dir/pid" ] || { echo "already started: $dir/pid" >&2; exit 1; }
  mkdir -p "$dir/real" "$dir/over" "$dir/db" "$dir/cache"
  : > "$dir/pacman.log"
  # The real database: local (what is installed) and sync (what the repos have).
  cp -a /var/lib/pacman/local /var/lib/pacman/sync "$dir/db/"
  # The real configuration, less DownloadUser: pacman would hand its downloads folder to the alpm user, who doesn't
  # exist in the namespace. -U of a package file downloads nothing.
  sed 's/^DownloadUser/#&/' /etc/pacman.conf > "$dir/pacman.conf"
  dirs="/usr/bin /usr/share/applications"
  for d in /usr/share/icons/hicolor/*/apps; do dirs="$dirs $d"; done
  # shellcheck disable=SC2016,SC2086
  unshare -Urm --propagation private sh -c '
    set -e
    dir=$1; shift
    key() { printf %s "$1" | tr / _; }
    for d in "$@"; do
      k=$(key "$d")
      mkdir -p "$dir/real/$k" "$dir/over/$k"
      # The real folder stays reachable once the copy is mounted over it.
      mount --bind "$d" "$dir/real/$k"
      for f in "$d"/* "$d"/.[!.]*; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        n=${f##*/}
        if grep -qx "${f#/}" "$dir"/db/local/hermes-chat-git-*/files 2>/dev/null; then
          cp --preserve=mode,timestamps "$f" "$dir/over/$k/$n"
        else
          ln -s "$dir/real/$k/$n" "$dir/over/$k/$n"
        fi
      done
    done
    for d in "$@"; do mount --bind "$dir/over/$(key "$d")" "$d"; done
    mount --bind "$dir/db" /var/lib/pacman
    mount --bind "$dir/pacman.log" /var/log/pacman.log
    mount --bind "$dir/cache" /var/cache/pacman/pkg
    mount --bind "$dir/pacman.conf" /etc/pacman.conf
    echo ready > "$dir/ready"
    exec sleep infinity
  ' sh "$dir" $dirs &
  echo $! > "$dir/pid"
  i=0
  while [ ! -e "$dir/ready" ]; do
    i=$((i + 1))
    [ $i -lt 200 ] || { echo "the namespace didn't start" >&2; exit 1; }
    sleep 0.1
  done
  echo "sandbox $dir, namespace holder pid $(cat "$dir/pid")"
  ;;
run)
  shift 2
  exec nsenter -t "$(cat "$dir/pid")" -U -m --preserve-credentials -- "$@"
  ;;
user)
  shift 2
  exec nsenter -t "$(cat "$dir/pid")" -U -m --preserve-credentials -- unshare -U --map-user=1000 --map-group=1000 -- "$@"
  ;;
stop)
  kill "$(cat "$dir/pid")" 2>/dev/null || true
  mv "$dir/pid" "$dir/pid.stopped"
  ;;
*)
  echo "unknown command $cmd" >&2
  exit 2
  ;;
esac
