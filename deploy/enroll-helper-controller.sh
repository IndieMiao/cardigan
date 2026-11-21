#!/bin/sh
# Human-only, in the server account. The pending identity is not an opt-in.
set -eu
umask 077
config=${CARDIGAN_CONFIG_DIR:-$HOME/.config/cardigan}
project=${2:?project} machine=${3:?machine}
case "$machine:$project" in *[!a-zA-Z0-9._:-]*|*:*:*|local:*) exit 1;; esac
cd "$config"
key="upgrade-${#machine}-$machine-$project.key"
case $1 in
 prepare)
  # Run sequentially for multiple workers. Never replace existing credentials.
  if [ ! -f "$key.signer.pem" ]; then
    tmp=$(mktemp .signer.XXXXXXXX)
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$tmp"
    ln "$tmp" "$key.signer.pem" && rm "$tmp"
  fi
  test ! -e "$key" && test ! -L "$key" || exit 1
  if [ ! -f "$key.pending" ]; then ssh-keygen -q -t ed25519 -N '' -C helper-upgrade -f "$key.pending"; fi
  # Only public keys are printed. Verify the displayed fingerprints with the worker admin.
  ssh-keygen -lf "$key.pending.pub" >&2
  openssl pkey -in "$key.signer.pem" -pubout | openssl dgst -sha256 >&2
  cat "$key.pending.pub"
  openssl pkey -in "$key.signer.pem" -pubout
  ;;
 activate)
  test -f "$key.pending" && test ! -e "$key" && test ! -L "$key" || exit 1
  ln "$key.pending" "$key" && rm "$key.pending"
  ;;
 *) exit 1;;
esac
