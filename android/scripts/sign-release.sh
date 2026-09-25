#!/bin/sh
set -eu

# Private files are deliberately outside the repository. Override for your own release key.
signing_dir="${CT45_SIGNING_DIR:-$HOME/.local/share/ct45-computer-link/signing}"
sdk_dir="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
tools_dir="$sdk_dir/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
android_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
input="$android_dir/app/build/outputs/apk/release/app-release-unsigned.apk"
output="${1:-$android_dir/app/build/outputs/apk/release/CT45-Computer-Link-2.0.0.apk}"

"$tools_dir/apksigner" sign --debuggable-apk-permitted false \
  --rotation-min-sdk-version 28 --lineage "$signing_dir/signing-lineage.bin" \
  --ks "$signing_dir/legacy-debug.keystore" --ks-key-alias androiddebugkey \
  --ks-pass "file:$signing_dir/legacy-password.txt" \
  --next-signer --ks "$signing_dir/release.keystore" --ks-key-alias ct45release \
  --ks-pass "file:$signing_dir/release-password.txt" \
  --out "$output" "$input"
"$tools_dir/apksigner" verify --verbose --print-certs "$output"
"$tools_dir/zipalign" -c 4 "$output"
