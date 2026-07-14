// @geoseal/expo — public entry point.
//
// Expo support is INTENTIONALLY thin. It is two things and nothing more:
//
//   1. A CONFIG PLUGIN (see ./app.plugin.js → ./plugin/src/index.ts) that mods the
//      generated iOS Info.plist (NSLocation* usage strings + UIBackgroundModes:
//      location) and the Android manifest (background-location permission, the
//      foreground-service declarations the streaming core needs). Expo's
//      managed/prebuild flow otherwise hides these, so background geofencing
//      silently never wakes. The plugin runs at `expo prebuild` time.
//
//   2. This RE-EXPORT of @geoseal/react-native — so the JS API surface under
//      `@geoseal/expo` is BYTE-IDENTICAL to the React Native wrapper, which is
//      itself a thin bridge over the two split native cores (the CheckpointCore
//      iOS pod + the dev.checkpoint:checkpoint-core Android AAR; engine classes
//      keep the com.checkpoint.capacitor package). There is NO Expo-specific JS
//      logic and NO duplicated geofencing brain — uniformity across every wrapper
//      is the whole point.
//
// Why a re-export and not a fork: the RN wrapper already exposes the frozen
// contract (Checkpoint facade + NativeGeofence raw plugin + TrackingMode /
// RegionEvent / NativeDiagnostics types). Expo apps run that same JS; they only
// need the native CONFIG wired, which the config plugin handles at build time.
//
// NOTE: @geoseal/react-native is a PEER DEPENDENCY (apps install it directly —
// autolinking only scans an app's direct deps, so the native bridge must sit in
// the app's own package.json). It is not yet a published npm artifact; pre-publish
// it resolves from the in-repo path (see README). Types resolve against the REAL
// package (its dist d.ts) — the old ambient shim is gone.

export * from "@geoseal/react-native";
export { Checkpoint as default } from "@geoseal/react-native";

// The Expo config-plugin entry (app.plugin.js) is consumed by `expo prebuild`,
// NOT imported as JS at runtime — so it is deliberately NOT re-exported here.
