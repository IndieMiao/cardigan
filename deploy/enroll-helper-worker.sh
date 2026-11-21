#!/bin/sh
# One-time operator bootstrap from the root-owned, reviewed release. No SSH here.
set -eu
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C
src=$(cd "$(dirname "$0")" && pwd -P)
b=/opt/cardigan-helper-upgrade
u=cardigan_updater
case $(uname -s) in
 Linux) entry=upgrade-linux-worker; group=root; home=/var/lib/$u; config=/etc/cardigan/worker.json; policy=/etc/sudoers.d/cardigan-helper-upgrade;;
 Darwin) entry=upgrade-macos-worker; group=wheel; home=/Users/$u; config=/Library/Cardigan/worker.json; policy=/private/etc/sudoers.d/cardigan-helper-upgrade;;
 *) exit 1;;
esac
[ "$(id -u)" = 0 ] && [ -f "$config" ] && [ -d "$(dirname "$policy")" ] || exit 1
# Refuse existing accounts/paths and unsafe ancestors. Never adopt or repair them.
! id "$u" >/dev/null 2>&1 || exit 1
for p in "$home" "$b" "$policy"; do [ ! -e "$p" ] && [ ! -L "$p" ] || exit 1; done
/usr/bin/python3 -IB - "$src" "$b" "$home" "$policy" <<'PY'
import os, pathlib, stat, sys
for entry in (sys.argv[1], *(pathlib.Path(p).parent for p in sys.argv[2:])):
    path = pathlib.Path(entry)
    for parent in (path, *path.parents):
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid or s.st_mode & 0o022: sys.exit('unsafe directory')
PY
install -d -o root -g "$group" -m 0700 "$b" "$b/state"
# The public enrollment consists of one OpenSSH line followed by a PEM public key.
IFS=' ' read -r algorithm blob comment
[ "$algorithm" = ssh-ed25519 ] || exit 1
case "$blob" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac
openssl pkey -pubin -pubout -out "$b/signer.pub"
printf '%s %s\n' "$algorithm" "$blob" > "$b/transport.pub"
ssh-keygen -lf "$b/transport.pub"
openssl dgst -sha256 "$b/signer.pub"
for f in upgrade-worker-helpers.py install-macos-worker.py worker-primitives.py; do install -o root -g "$group" -m 0400 "$src/$f" "$b/$f"; done
install -o root -g "$group" -m 0500 "$src/$entry" "$b/upgrade"
if [ "$group" = root ]; then
 useradd --system --user-group --no-create-home --home-dir "$home" --shell /bin/sh --password '*' "$u"
else
 # Use an unoccupied system UID/GID; hidden, no password credential or GUI login.
 n=390
 while id "$n" >/dev/null 2>&1 || dscacheutil -q group -a gid "$n" | grep -q '^name:'; do n=$((n+1)); [ "$n" -lt 500 ] || exit 1; done
 ! dscl . -read "/Groups/$u" >/dev/null 2>&1 || exit 1
 dscl . -create "/Groups/$u" PrimaryGroupID "$n"
 dscl . -create "/Users/$u" UniqueID "$n"
 dscl . -create "/Users/$u" PrimaryGroupID "$n"
 dscl . -create "/Users/$u" UserShell /bin/sh
 dscl . -create "/Users/$u" NFSHomeDirectory "$home"
 dscl . -create "/Users/$u" Password '*'
 dscl . -create "/Users/$u" IsHidden 1
fi
# A newly created identity must have no inherited sudo grant.
sudo -n -l -U "$u" > "$b/sudo-before" 2>&1 || test "$?" = 1
grep -Eq 'not allowed to run sudo|may not run sudo|not in the sudoers' "$b/sudo-before" || exit 1
install -d -o root -g "$group" -m 0755 "$home" "$home/.ssh"
printf 'restrict,command="/usr/bin/sudo -n -- %s/upgrade" %s %s\n' "$b" "$algorithm" "$blob" > "$home/.ssh/authorized_keys"
chmod 0644 "$home/.ssh/authorized_keys"
printf '%s ALL=(root) NOPASSWD: NOSETENV: %s/upgrade ""\n' "$u" "$b" > "$b/policy"
visudo -cf "$b/policy"
install -o root -g "$group" -m 0440 "$b/policy" "$policy"
visudo -c
sudo -n -l -U "$u" "$b/upgrade"
if sudo -n -l -U "$u" /bin/sh || sudo -n -l -U "$u" "$b/upgrade" unexpected; then exit 1; fi
