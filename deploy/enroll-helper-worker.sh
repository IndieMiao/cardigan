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
# Embedded in the independently authenticated bootstrap; never load an unchecked sibling.
# Reject granting/unknown ACLs (including Linux defaults) and links. Darwin system ancestors can have deny-only ACLs.
guard() {
/usr/bin/python3 -IB - "$@" <<'PY'
import os, platform, re, stat, subprocess, sys
from pathlib import Path

def safe_acl(path):
    if platform.system() == 'Linux':
        return not any(k.startswith('system.posix_acl_') for k in os.listxattr(path, follow_symlinks=False))
    if platform.system() != 'Darwin': return False
    lines = subprocess.check_output(['/bin/ls', '-lden', str(path)], env={'LC_ALL':'C'}).splitlines()
    if not lines: return False
    if len(lines) == 1: return b'+' not in lines[0].split(None, 1)[0]
    return all(re.fullmatch(rb'\s*\d+: \S+ deny [a-z_,]+', line) for line in lines[1:])

for arg in sys.argv[1:]:
    kind, value = arg.split(':', 1)
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts: sys.exit('unsafe bootstrap path')
    for p in (*reversed(path.parents), path):
        s = p.lstat()
        good_type = stat.S_ISREG(s.st_mode) and s.st_nlink == 1 if p == path and kind == 'f' else stat.S_ISDIR(s.st_mode)
        if not good_type or s.st_uid or s.st_mode & 0o022 or not safe_acl(p): sys.exit('unsafe bootstrap permissions')
PY
}
guard "d:$(dirname "$b")" "d:$(dirname "$home")" "d:$(dirname "$policy")" "f:$config" \
  "f:$src/enroll-helper-worker.sh" "f:$src/$entry" "f:$src/upgrade-worker-helpers.py" "f:$src/install-macos-worker.py" "f:$src/worker-primitives.py"
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
guard "d:$b/state" "f:$b/upgrade" "f:$b/upgrade-worker-helpers.py" "f:$b/install-macos-worker.py" "f:$b/worker-primitives.py" \
  "f:$b/signer.pub" "f:$b/transport.pub" "f:$home/.ssh/authorized_keys" "f:$b/policy"
# Check the staged rule on its destination filesystem before the grant exists.
staged=$(mktemp "$policy.XXXXXXXX")
install -o root -g "$group" -m 0440 "$b/policy" "$staged"
guard "f:$staged"
visudo -cf "$staged"
ln "$staged" "$policy" && rm "$staged" || exit 1
visudo -c
sudo -n -l -U "$u" "$b/upgrade"
if sudo -n -l -U "$u" /bin/sh || sudo -n -l -U "$u" "$b/upgrade" unexpected; then exit 1; fi
