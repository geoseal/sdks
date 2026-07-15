<p align="center"><img src="https://raw.githubusercontent.com/geoseal/.github/main/brand/geoseal-mark.svg" width="140" alt="Geoseal — verified presence"></p>

# @geoseal/capacitor

The Geoseal location / geofence / ingest SDK for Capacitor (iOS + Android).

The SDK is deliberately thin: it bootstraps with your **publishable key**,
identifies a subject, pulls the armed fence set, registers native region
monitors, and posts location fixes — including from a force-quit app woken by the
OS. All detection logic (M-of-N confirmation, dwell, exit hysteresis) runs
**server-side**; the SDK is a sensor, not a decision-maker.

## Install

```bash
npm install @geoseal/capacitor && npx cap sync
```

The package ships prebuilt `dist/` — consumers **need no TypeScript toolchain**
of their own. (Developing from a checkout instead? `npm pack` in this package
dir bakes `dist/` into a tarball you can `npm i ./geoseal-capacitor-<version>.tgz`.)

iOS ships both a `CheckpointIrlCapacitor.podspec` and a `Package.swift`, so `cap sync`
works with CocoaPods-based and SwiftPM-based host projects alike. The **SwiftPM
face requires Capacitor 8 / iOS 15**; use **CocoaPods for Capacitor 7** (see the
[support matrix](#supported-toolchains)). The Swift module is named
`CheckpointCapacitor` under both.

> First `pod install` on a machine with an older CocoaPods CDN cache may fail
> with "Unable to find a specification for CheckpointCore" — run
> `pod install --repo-update` once.

> This repo's app consumes the package **from source** via a path alias
> (`@geoseal/capacitor` → `packages/checkpoint-capacitor/src`) and a `file:`
> dependency — see the root `vite.config.ts`, `tsconfig.app.json`, and
> `package.json`. No npm publish (or tarball) is required for the in-repo app.

## Supported toolchains

| Distribution     | iOS  | Capacitor | Android                       |
|------------------|------|-----------|-------------------------------|
| CocoaPods        | ≥ 14 | ≥ 7       | —                             |
| SwiftPM          | ≥ 15 | ≥ 8       | —                             |
| Android (Gradle) | —    | ≥ 7       | minSdk 23 · target/compile 35 |

The CocoaPods podspec targets **iOS 14 / Capacitor 7** — the version this repo's
dogfood app compiles against. `Package.swift` is **SwiftPM-only** and requires
**iOS 15 / Capacitor 8** (its `capacitor-swift-pm` dependency floors there). Pick
the distribution your host app already uses; you do not need both.

## Geofence-only entry point

Privacy-first integrations that only need wake-on-geofence + the armed-fence pull
can import the narrower `@geoseal/capacitor/geofence` subpath instead of the
full barrel. It exposes `initGeofence`, `NativeGeofence`, `pullArmedFences` (+ the
pure geometry helpers), `mintDeviceToken` (for `dtok_only` tenants),
`reportTrackingOutages`, and the subject-id codec — and deliberately **excludes**
the streaming ingest path, self-serve fence discovery/drop/join, the
tracking-directive RPCs, and local mode storage.

```ts
import { initGeofence, pullArmedFences } from "@geoseal/capacitor/geofence";
initGeofence({ publishableKey: "pk_live_…", baseUrl: "https://<ref>.supabase.co", anonKey: "…" });
```

## Host app requirements

### iOS `Info.plist`

Background location and force-quit wake-on-geofence are the whole point, so all
three are mandatory in the **host app's** `Info.plist`:

- `NSLocationWhenInUseUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription`
- `UIBackgroundModes: location`

### iOS cold-relaunch revive (host `AppDelegate`)

The package's `GeofenceManager` engine owns the cold-relaunch revive
(`reviveForBackgroundLaunch()`), but it must be **called from the host app's
`AppDelegate.didFinishLaunchingWithOptions`** when `launchOptions[.location]` is
set, so an `always + streamNow` device woken from a killed state resumes
streaming. This is an app-delegate concern and stays in the app:

```swift
import CheckpointCapacitor  // same module name under CocoaPods and SwiftPM
// ...
if launchOptions?[.location] != nil {
    GeofenceManager.shared.reviveForBackgroundLaunch()
}
```

### Plugin registration

Once installed as an npm package, the native plugin auto-registers via
Capacitor's `cap sync`-generated `packageClassList` — do **not** also register it
manually (`registerPluginInstance` / `registerPlugin(...)`) or you double-register
and two instances race on `onRegionEvent`. See the repo's
`docs/sdk-extraction-plan.md` §7 (risk R1) for the device-verification checklist
around this flip.

## Permissions & background components this SDK adds to your app

The library ships an Android manifest and native services/receivers that the
Android **manifest-merger folds into your host app's merged manifest** at build
time. Store reviewers see these — know what you are shipping.

### Android permissions merged into your app

| Permission | Why | Notes |
|---|---|---|
| `INTERNET` | POST location fixes to your platform. | — |
| `ACCESS_COARSE_LOCATION` | Coarse fix + the first-tier location prompt. | — |
| `ACCESS_FINE_LOCATION` | Precise geofence geometry + the fine continuous stream. | — |
| `ACCESS_BACKGROUND_LOCATION` | Geofence triggering while the app isn't running (API 29+). | Requires a **separate** "Allow all the time" grant; Play requires a background-location declaration + review. |
| `POST_NOTIFICATIONS` | Crossing alerts + the foreground-service notification (API 33+). | Runtime-prompted on Android 13+. |
| `FOREGROUND_SERVICE` | Short-lived FGS that completes the POST after a cold geofence wake. | — |
| `FOREGROUND_SERVICE_LOCATION` | The `location` FGS type — **mandatory + enforced** for a background-location FGS on API 34+. | — |
| `RECEIVE_BOOT_COMPLETED` | Re-arm geofences after reboot (Play Services drops all registered geofences on boot). | — |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Ask to be exempted from Doze / OEM app-standby, which otherwise force-stops the app and drops geofence broadcasts (Samsung One UI especially). | **Play-restricted** — many listings can't justify it. Opt out by re-declaring it with `tools:node="remove"` in your app manifest (add `xmlns:tools="http://schemas.android.com/tools"` to your `<manifest>`): `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" tools:node="remove" />` |

### Android components merged into your app

| Component | Kind | Notes |
|---|---|---|
| `GeofenceBroadcastReceiver` | receiver, **not exported** | Receives Play Services geofence transitions even when the process is killed. |
| `GeofencePostService` | foreground service, **type `location`**, not exported | Completes the network POST after a geofence broadcast (a cold-started process can die the moment `onReceive` returns). |
| `ContinuousLocationService` | foreground service, **type `location`**, not exported | Streams fine fixes while it matters (in-perimeter for `geofence`, in-shift for `always`). |
| `BootReceiver` | receiver, **exported**, `directBootAware` | Re-registers geofences on `BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`. |

### iOS

The SDK adds no Info.plist keys of its own — the host app supplies the required
location trio (`NSLocationWhenInUseUsageDescription`,
`NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location`) and
wires the cold-relaunch revive; see [Host app requirements](#host-app-requirements)
above.

## Usage

```ts
import { Checkpoint } from "@geoseal/capacitor";

// 1. Configure transport once. baseUrl, anonKey, and publishableKey are all
//    required — point them at YOUR platform project (anon key is public-safe).
Checkpoint.init({
  publishableKey: "pk_live_…",
  baseUrl: "https://<your-project-ref>.supabase.co",
  anonKey: "<your-platform-anon-key>",
});

// 2. Read the server-resolved directive / apply a mode.
const directive = await Checkpoint.getTrackingDirective("sub_…", { appId });
await Checkpoint.setTrackingMode("always");   // applies to the native layer
```

### Public API surface

- **Layer 1 (raw native plugin):** `NativeGeofence` + the frozen
  `NativeGeofencePlugin` contract types (`TrackingMode`, `RegionEvent`,
  `NativeDiagnostics`, `NativeFenceDiag`). Wrapper SDKs (RN / Flutter) bind to
  this same native ABI.
- **Layer 2 (facade):** `Checkpoint.{init, isConfigured, setTrackingMode,
  getTrackingMode, getTrackingDirective, setDeviceTrackingMode}` +
  `CheckpointConfig`, `CheckpointTransport`, `CHECKPOINT_API_VERSION`. `init`
  stays **inert** on missing creds (logs + no-op rather than throwing); guard with
  `isConfigured()`.
- **Geofence-only subpath:** `@geoseal/capacitor/geofence` — the narrower
  surface (`initGeofence`, `NativeGeofence`, `pullArmedFences`, `mintDeviceToken`,
  `reportTrackingOutages`, geometry helpers, id codec). See
  [Geofence-only entry point](#geofence-only-entry-point).
- **Device REST hot-path:** `mintDeviceToken`, `getTrackingDirective`,
  `setDeviceTrackingMode` (all transport-injected; never the app's Supabase
  session client).
- **Presence primitives (framework-agnostic):** `pullArmedFences` (with the
  build-7 transient-empty-pull guard), `ingestFix`, `postSelfFence`,
  `postJoinPlace`, `fetchNearbyPlaces`, `metersBetween`, `fenceSignature`,
  `zoneFor`, `DEFAULT_DIRECTIVE`.
- **Subject id codec:** `encodeSubjectPublicId`, `decodeSubjectPublicId`.
- **Tracking-mode local persistence:** `readStoredMode`, `writeStoredMode`,
  `readPendingMode`, `writePendingMode`, `clearPendingMode`, `modeKey`.

## Tests

```bash
npm run build && node --test test/pure.test.mjs test/fences.test.mjs
```

Covers the pure functions (`metersBetween`, `fenceSignature`, `zoneFor`, the
subject-id codec) and the build-7 transient-empty-pull guard in `pullArmedFences`.
