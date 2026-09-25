#!/bin/sh
set -eu
fixture_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture_out="${1:?Pass a temporary output directory}"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
build_tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-35/android.jar"
mkdir -p "$fixture_out/classes" "$fixture_out/dex"
"$JAVA_HOME/bin/javac" -source 8 -target 8 -classpath "$platform" -d "$fixture_out/classes" "$fixture_source/DiscoveryFixture.java"
"$build_tools/d8" --min-api 26 --lib "$platform" --output "$fixture_out/dex" "$fixture_out"/classes/test/ct45/discovery/*.class
"$build_tools/aapt2" link -I "$platform" --manifest "$fixture_source/AndroidManifest.xml" -o "$fixture_out/fixture.apk"
(cd "$fixture_out/dex" && zip -q -j "$fixture_out/fixture.apk" classes.dex)
"$build_tools/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android "$fixture_out/fixture.apk"
