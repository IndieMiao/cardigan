#!/bin/sh
# Human-only, in the server account. The pending identity is not an opt-in.
set -eu
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C
config=${CARDIGAN_CONFIG_DIR:-$HOME/.config/cardigan}
project=${2:?project} machine=${3:?machine}
case "$machine:$project" in *[!a-zA-Z0-9._:-]*|*:*:*|local:*) exit 1;; esac
key="upgrade-${#machine}-$machine-$project.key"
# The suffix records which zero-argument SSH/sudo principal to use. Existing
# active (legacy) identities remain byte-for-byte unchanged.
other=$key.bound
case $# in
 3) ;;
 4) [ "$4" = --project-config ] || exit 1; other=$key; key=$key.bound;;
 *) exit 1;;
esac
# The controller is Linux. Check the entire namespace before cd, key generation,
# reuse, printing either public key, or activating a pending identity.
/usr/bin/python3 -IB - "$config" "$key" <<'PY'
import os, stat, sys
from pathlib import Path
path, name = Path(sys.argv[1]), sys.argv[2]
uid = os.geteuid()
def safe_acl(p):
    return not any(k.startswith('system.posix_acl_') for k in os.listxattr(p, follow_symlinks=False))
if not path.is_absolute() or '..' in path.parts: sys.exit('unsafe private directory')
for p in (*reversed(path.parents), path):
    s = p.lstat()
    if (not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0, uid)
            or s.st_mode & 0o022 or not safe_acl(p)): sys.exit('unsafe private directory')
if s.st_uid != uid or stat.S_IMODE(s.st_mode) != 0o700: sys.exit('unsafe private directory')
for suffix in ('', '.pending', '.pending.pub', '.signer.pem'):
    p = path / (name + suffix)
    try: s = p.lstat()
    except FileNotFoundError: continue
    modes = (0o600, 0o644) if suffix.endswith('.pub') else (0o600,)
    if (not stat.S_ISREG(s.st_mode) or s.st_uid != uid or s.st_nlink != 1
            or stat.S_IMODE(s.st_mode) not in modes or not safe_acl(p)): sys.exit('unsafe existing key')
PY
cd "$config"
test ! -e "$other" && test ! -L "$other" || exit 1
case $1 in
 prepare)
  # Run sequentially for multiple workers. Never replace existing credentials.
  test ! -e "$key" || exit 1
  if [ ! -f "$key.pending" ]; then test ! -e "$key.pending.pub" || exit 1; fi
  if [ ! -f "$key.signer.pem" ]; then
    tmp=$(mktemp .signer.XXXXXXXX)
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$tmp"
    ln "$tmp" "$key.signer.pem" && rm "$tmp"
  fi
  test ! -e "$key" && test ! -L "$key" || exit 1
  if [ ! -f "$key.pending" ]; then ssh-keygen -q -t ed25519 -N '' -C helper-upgrade -f "$key.pending"; fi
  # Only public keys are printed. Verify the displayed fingerprints with the worker admin.
  test "$(ssh-keygen -y -f "$key.pending" | cut -d " " -f 1,2)" = "$(cut -d " " -f 1,2 "$key.pending.pub")" || exit 1
  ssh-keygen -lf "$key.pending.pub" >&2
  openssl pkey -in "$key.signer.pem" -pubout | openssl dgst -sha256 >&2
  cat "$key.pending.pub"
  openssl pkey -in "$key.signer.pem" -pubout
  ;;
 activate)
  test -f "$key.signer.pem" && test -f "$key.pending.pub" && test -f "$key.pending" && test ! -e "$key" && test ! -L "$key" || exit 1
  ln "$key.pending" "$key" && rm "$key.pending"
  ;;
 *) exit 1;;
esac
