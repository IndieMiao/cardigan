#!/bin/sh
# Run from the repository root in the Linux x64 check executor. Do not update approvals.
set -eu
browser=$(mktemp -d)
trap 'rm -rf "$browser"' EXIT
curl --fail --silent --show-error --location --retry 2 --max-time 120 \
  https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.15/linux64/chrome-headless-shell-linux64.zip \
  -o "$browser/chrome.zip"
(cd "$browser" && printf '%s\n' '563526b19c119adaad4fbc603395a905d6dd637541dd8ed70635b18ac1bb8a53  chrome.zip' | sha256sum --check && unzip -q chrome.zip)
CHROMIUM_PATH="$browser/chrome-headless-shell-linux64/chrome-headless-shell" pnpm --filter @cardigan/web test:ui-snapshots
