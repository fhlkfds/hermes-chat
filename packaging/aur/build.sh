#!/bin/sh
# Builds the hermes-chat-git package from a copy of this directory's PKGBUILD.
#
# makepkg writes the version its pkgver() works out back into the PKGBUILD it
# builds. Run in place, that leaves the tracked packaging/aur/PKGBUILD modified,
# and the next `git pull` refuses to merge. Building a copy in build/, which git
# ignores, keeps the checkout clean. build/ also keeps makepkg's clone of the
# repo and the cargo build, so later builds are faster.
#
# Arguments go to makepkg, for example: packaging/aur/build.sh -si
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/build"
cp "$here/PKGBUILD" "$here/hermes-chat.desktop" "$here/build/"
cd "$here/build"
exec makepkg "$@"
