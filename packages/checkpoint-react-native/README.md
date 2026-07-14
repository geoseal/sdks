# @geoseal/react-native

A **thin** React Native bridge over the two device-verified Geoseal native
cores (`@geoseal/capacitor`'s iOS `GeofenceManager` + Android Play Services /
foreground-service layer). It re-implements **no** geofencing logic — that's
server-side. The wrapper's only jobs are (a) expose the native API in JS/TS and
(b) wire the platform permissions / background modes / manifest entries the cores
require. This mirrors how HyperTrack ships its RN SDK over its native cores.

```
JS  →  Checkpoint.init({ publishableKey })
       NativeGeofence.configure({ … }); NativeGeofence.addFence({ … })
        │
        ▼  (native module — same name "CheckpointGeofence" on both platforms)
iOS  GeofenceManager.shared   ── or ──  Android GeofenceStore + Play Services
        │                                          │
        ▼                                          ▼
   region wake → POST /v1/ingest from URLSession / OkHttp  (NEVER a JS fetch)
```

> **Status — live on npm + CocoaPods trunk; Android Maven pending.** This package
> is published as `@geoseal/react-native`, and its native core faces come
> from `@geoseal/capacitor`: the **CheckpointCore** pod (resolves from the
> CocoaPods trunk), the **`dev.checkpoint:checkpoint-core`** Android AAR
> (`android-core/`; **not yet on a public Maven registry** — resolve it via
> mavenLocal), plus the Capacitor-free JS entry `@geoseal/capacitor/core`.
> See [Dependency on the native core](#dependency-on-the-native-core).

## Architecture: classic bridge, hosted on New Arch

Both native modules are **classic** bridge modules (iOS `RCTEventEmitter`, Android
`ReactContextBaseJavaModule`) rather than Swift/Kotlin TurboModules.

- A TurboModule codegen spec (`src/NativeCheckpointGeofence.ts`) IS shipped, so the
  JS resolves the module through `TurboModuleRegistry` on the New Architecture and
  through `NativeModules` on the classic one — same registry name
  (`"CheckpointGeofence"`), one resolution path.
- The **native implementations** are classic-bridge because RN's interop layer
  hosts a legacy module unchanged under bridgeless mode, so one Swift file + one
  Java file serve both architectures. Every method is a trivial forward to the
  engine; there is no synchronous per-frame hot path that would justify the extra
  Objective-C++ / JNI codegen shim a fully-native TurboModule needs.

## Install

```sh
yarn add @geoseal/react-native
cd ios && pod install
```

Autolinking (`react-native.config.js` + the RN gradle/CocoaPods plugins) wires the
iOS pod and the Android package — no `MainApplication` or `Podfile` edits.
`CheckpointCore` resolves from the CocoaPods trunk; on a machine with an older
CDN cache run `pod install --repo-update` once. Android needs the mavenLocal
step until the core AAR reaches a public Maven registry — see
[Dependency on the native core](#dependency-on-the-native-core).

## Usage (mirrors the universal SDK contract)

```ts
import { Checkpoint, NativeGeofence } from "@geoseal/react-native";

// 1. Bootstrap the transport. baseUrl + anonKey are REQUIRED (no baked defaults —
//    a published SDK must not ship a platform ref). publishableKey is safe in a binary.
Checkpoint.init({
  publishableKey: "pk_live_…",
  baseUrl: "https://<project>.supabase.co",
  anonKey: "<anon>",
});

// 2. Persist creds + subject natively so a BACKGROUND relaunch can POST without JS.
await NativeGeofence.configure({
  baseUrl: "https://<project>.supabase.co",
  anonKey: "<anon>",
  publishableKey: "pk_live_…",
  subjectExternalId: "nurse-123",   // YOUR id for the subject
  trackingMode: "geofence",          // geofence (default) | always | off
});

// 3. Permissions (see the platform ladder below).
await NativeGeofence.requestAlwaysAuthorization();
await NativeGeofence.requestNotificationAuthorization();
await NativeGeofence.requestBatteryExemption(); // Android only; no-op on iOS
// Escape hatch once the one-time OS prompt is consumed — deep-link to Settings:
await NativeGeofence.openAppSettings();

// 4. Register the perimeter ring → native OS geofence (wakes a force-quit app).
await NativeGeofence.addFence({
  id: "facility-1", latitude: 40.0, longitude: -111.0, radius: 200,
});

// 5. React to crossings while JS is alive (the native layer already POSTed the wake
//    ping regardless). Detection — arrivals/exits/dwell — is server-side.
const sub = await NativeGeofence.addListener("regionEvent", (e) => {
  console.log(e.type, e.regionId, e.latitude, e.longitude, e.timestamp);
});
// later: sub.remove();

// Tracking mode via the ergonomic facade (identical to @geoseal/capacitor):
Checkpoint.isConfigured();                 // true once init() had all three creds
await Checkpoint.setTrackingMode("always");
const { mode, streaming } = await Checkpoint.getTrackingMode();
```

### Geofence-only entry point

Privacy-first integrations that only arm fences (no streaming ingest, no
directive RPCs, no self-serve place calls) can import the strict-subset entry —
the RN analogue of `@geoseal/capacitor/geofence`:

```ts
import { initGeofence, NativeGeofence, pullArmedFences } from "@geoseal/react-native/geofence";
```

> **Metro note:** this package reaches the core via the subpath
> `@geoseal/capacitor/core`. Metro resolves package `exports` by default
> from RN 0.79 (Metro 0.82); as of core 0.1.1 the package also ships root proxy
> stubs (`core.js` / `geofence.js`), so older hosts (RN < 0.79, Expo SDK 51–52)
> resolve the subpath **with zero config**. Setting
> `resolver.unstable_enablePackageExports = true` in `metro.config.js` still
> works but is no longer required.

The public surface (`Checkpoint`, `NativeGeofence`, `TrackingMode`, `RegionEvent`,
`NativeDiagnostics`) is **byte-identical** to `@geoseal/capacitor` — that
cross-wrapper uniformity is the whole point.

### Cross-wrapper listener idiom

The **types and wire values** are uniform across all four wrappers; the **call
syntax** for subscribing to region events is idiomatic per platform (this is the
one place the "uniform API" claim is scoped to types, not literal call syntax):

| Wrapper | Subscribe | Unsubscribe |
|---|---|---|
| Capacitor | `addListener('regionEvent', cb)` → `Promise<handle>` | `handle.remove()` |
| **React Native** | `addListener('regionEvent', cb)` → `Promise<{ remove }>` | `sub.remove()` |
| Expo | `addListener('regionEvent', cb)` (re-exports RN) | `sub.remove()` |
| Flutter | `addRegionEventListener(cb)` → `CheckpointListenerHandle` | `await handle.remove()` |
| .NET MAUI | `RegionEvent += handler;` (C# `event`) | `RegionEvent -= handler;` |

The event name (`"regionEvent"`), payload (`RegionEvent`), and `TrackingMode` wire
values are identical everywhere. The shared conformance fixture
(`test/conformance.spec.ts`, mirrored in each wrapper) asserts that.

## Platform configuration

### iOS — `Info.plist`

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>We use your location to confirm arrival at your shift facility.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Background location lets us record arrival/departure even when the app is closed.</string>
<key>UIBackgroundModes</key>
<array><string>location</string></array>
```

### Android — permission ladder

The library manifest declares the permissions + the core's receivers/services
(folded in by manifest-merge from the core AAR). The **runtime** grant is staged
— Android 10+ forbids bundling background with foreground —
`NativeGeofence.requestAlwaysAuthorization()` drives the two-step escalation
natively through the host's `PermissionAwareActivity` (no `PermissionsAndroid`
choreography required):

1. `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` (foreground) prompt.
2. **Then** `ACCESS_BACKGROUND_LOCATION` ("Allow all the time") — a SEPARATE
   prompt once foreground is granted. On grant the module re-registers fences
   for the killed-app path (a geofence armed foreground-only never wakes a
   killed app).
3. `POST_NOTIFICATIONS` (API 33+) — request from JS via `PermissionsAndroid`
   (`requestNotificationAuthorization()` is a contract no-op on Android).
4. `NativeGeofence.requestBatteryExemption()` on aggressive OEMs (Samsung One UI
   especially) — an optimized app is force-stopped and its receivers disabled.

See the Geoseal docs: `docs/guides/whitelisting.md`,
`docs/guides/store-submission.md`, `docs/guides/mock-locations.md`.

## Dependency on the native core

This wrapper binds to the **same** engine as `@geoseal/capacitor`, through its
Capacitor-free build faces:

- **iOS** — `ios/CheckpointGeofence.swift` does `import CheckpointCore` and
  drives `GeofenceManager.shared`. The podspec declares
  `s.dependency 'CheckpointCore', '~> 0.1'` (the engine-only pod defined by
  `CheckpointCore.podspec` in `@geoseal/capacitor`; no Capacitor dependency).
- **Android** — `CheckpointGeofenceModule.java` calls
  `com.checkpoint.capacitor.GeofenceStore` / `ContinuousLocationService` /
  `GeofencingClient`. `android/build.gradle` declares
  `implementation 'dev.checkpoint:checkpoint-core:0.1.0'` (the engine AAR built
  by `@geoseal/capacitor`'s `android-core/` Gradle module).
- **JS** — the framework-agnostic REST/presence layer is consumed via the
  `@geoseal/capacitor/core` subpath (never reaches `@capacitor/core`, which
  the core package declares as an *optional* peer).

**iOS** resolves from the CocoaPods trunk — `pod install` satisfies the
`CheckpointCore` dependency with no Podfile edits (`--repo-update` once on a
stale CDN cache). Optionally pin the vendored copy for a hermetic build:
`pod 'CheckpointCore', :path => '../node_modules/@geoseal/capacitor'`.

**Android: until the core AAR is on Maven Central**, the HOST app resolves it
locally:

```sh
# Android — publish the core AAR to mavenLocal once:
cd node_modules/@geoseal/capacitor/android-core && ./gradlew publishToMavenLocal
```

then expose mavenLocal to the app build (Gradle resolves a library's deps
against the HOST app's repositories, so this line must live in the host's
`android/build.gradle`):

```gradle
allprojects {
  repositories { mavenLocal { content { includeGroup "dev.checkpoint" } } }
}
```

or, instead of mavenLocal, substitute the source build in the host's
`settings.gradle`:

```gradle
includeBuild('node_modules/@geoseal/capacitor/android-core') {
  dependencySubstitution {
    substitute module('dev.checkpoint:checkpoint-core') using project(':')
  }
}
```

### Keeping `@geoseal/capacitor` out of RN autolinking

With a registry install, `@geoseal/capacitor` is a **transitive**
dependency of this package, and bare-RN CLI autolinking never scans it — nothing
to do. If your app also declares the core as a **direct** dependency (e.g. a
monorepo or path install), the core's shipped `react-native.config.cjs` opt-out
guard tells the RN CLI to skip its Capacitor plugin face, so bare-RN hosts are
covered either way.

**Expo hosts are the exception:** Expo's own autolinking ignores
`react-native.config.cjs` and still requires an
`expo.autolinking.exclude` entry for `@geoseal/capacitor` — see the
[`@geoseal/expo` README](../checkpoint-expo/README.md) (the config plugin
docs cover it).

### Core access control — resolved

The former prerequisite gap is **closed on main**: the core exposes everything this
bridge binds to as `public`.

- **iOS**: `GeofenceManager`'s engine methods (`configure`, `addFence`,
  `clearFences`, `requestAlwaysAuthorization`, `requestNotificationAuthorization`,
  `applyTrackingMode`, `currentMode`, `isStreaming`, `monitoredCount`,
  `diagnostics`, `authorizationStatusString`, the `onRegionEvent` callback) and the
  `TrackingMode` enum are `public`.
- **Android**: `GeofenceStore`'s methods (including `setRegionEventListener`) and
  the services' `start`/`stop`/`RUNNING` are `public`; this module calls them
  across the package boundary directly.

## Known gaps / uncertainties

- **Android `regionEvent` is live.** The core's `GeofenceBroadcastReceiver` hands
  each crossing to the in-process listener this module installs via
  `GeofenceStore.setRegionEventListener(...)` (registered in `initialize()`,
  cleared in `invalidate()`), which re-emits it to JS as `"regionEvent"` — the
  Android analogue of iOS's `onRegionEvent` closure. This is additive: the
  receiver's native POST/notification wake path is unchanged whether or not a
  listener is installed.
- **The framework-agnostic core is re-exported, not duplicated.** The device REST
  hot-path (`mintDeviceToken`, `getTrackingDirective`, `setDeviceTrackingMode`,
  `reportTrackingOutages`), the presence helpers (`pullArmedFences`, `ingestFix`,
  `zoneFor`, …), the subject-id codec, and the tracking-mode storage helpers are
  framework-agnostic pure TypeScript in `@geoseal/capacitor`. This wrapper
  **re-exports the real implementations** (`export { … } from
  "@geoseal/capacitor"`) rather than forking them, so the wire contract (3-key
  directive RPC body, anon-key bearer on the RPCs, publishable-key bearer on mint,
  the build-7 fence-pull guard) is byte-identical to the core. `Checkpoint.init`
  delegates to the core's shared `configureTransport` so those re-exports read
  the same creds. `@geoseal/capacitor` is a real `dependencies` entry
  (consumed through its Capacitor-free `/core` subpath); the old ambient
  stand-in shim is gone. Registry installs resolve it automatically; when
  developing from a checkout, resolve it locally, e.g.
  `npm i --no-save ../checkpoint-capacitor` in this package.
- **Compile-verified, not device-verified.** Both native bridges compile inside
  a bare RN host (xcodebuild simulator build + `gradlew assembleDebug`, RN
  0.86 / New Architecture, engine consumed via the CheckpointCore pod and the
  `dev.checkpoint:checkpoint-core` AAR). The underlying native cores are
  device-verified; this thin bridge has not yet run on hardware — see the
  device checklist.
- **Expo:** use a development build (config plugin TBD — the Expo wrapper is a
  separate package). This will not run in Expo Go.
