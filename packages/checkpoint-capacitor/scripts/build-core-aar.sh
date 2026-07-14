#!/usr/bin/env bash
#
# Build checkpoint-core.aar — the Capacitor-free Android engine artifact
# (com.checkpoint.capacitor engine classes + com.checkpoint.core shim, minus
# NativeGeofencePlugin) — from the android-core build face, and drop it where the
# MAUI binding's <AndroidLibrary> points (packages/checkpoint-maui/native/).
#
# Requires: Android SDK (ANDROID_HOME or android-core/local.properties) + JDK 17.
# JAVA_HOME fallback: the Android Studio JBR, the same JDK the app build uses.

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$PKG_ROOT/../checkpoint-maui/native"

if [[ -z "${JAVA_HOME:-}" && -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/Library/Android/sdk" ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

cd "$PKG_ROOT/android-core"
./gradlew assembleRelease

cp build/outputs/aar/checkpoint-core-release.aar "$OUT_DIR/checkpoint-core.aar"
echo "==> $OUT_DIR/checkpoint-core.aar"
