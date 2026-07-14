#!/usr/bin/env bash
#
# Build CheckpointCore.xcframework — the Capacitor-free iOS engine artifact
# (GeofenceManager + the CheckpointGeofence ObjC shim, no NativeGeofence /
# Capacitor) — and drop it where the MAUI binding's <NativeReference> points
# (packages/checkpoint-maui/native/).
#
# Vehicle: the committed ios/CheckpointCoreFramework.xcodeproj (framework target
# over ios/Sources/CheckpointCore via a synchronized folder reference).
# BUILD_LIBRARY_FOR_DISTRIBUTION=YES is REQUIRED: it emits the .swiftinterface the
# .NET binding's ObjC header generation + a stable ABI rely on.
#
# Requires: macOS + Xcode with the iOS SDK.

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$PKG_ROOT/ios/CheckpointCoreFramework.xcodeproj"
SCHEME="CheckpointCore"
OUT_DIR="$PKG_ROOT/../checkpoint-maui/native"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

xcodebuild archive \
  -project "$PROJ" \
  -scheme "$SCHEME" \
  -destination "generic/platform=iOS" \
  -archivePath "$WORK/ios.xcarchive" \
  SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES CODE_SIGNING_ALLOWED=NO

xcodebuild archive \
  -project "$PROJ" \
  -scheme "$SCHEME" \
  -destination "generic/platform=iOS Simulator" \
  -archivePath "$WORK/sim.xcarchive" \
  SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES CODE_SIGNING_ALLOWED=NO

rm -rf "$OUT_DIR/CheckpointCore.xcframework"
xcodebuild -create-xcframework \
  -framework "$WORK/ios.xcarchive/Products/Library/Frameworks/CheckpointCore.framework" \
  -framework "$WORK/sim.xcarchive/Products/Library/Frameworks/CheckpointCore.framework" \
  -output "$OUT_DIR/CheckpointCore.xcframework"

echo "==> $OUT_DIR/CheckpointCore.xcframework"
