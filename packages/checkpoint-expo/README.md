# @geoseal/expo

Geoseal location / geofence / ingest SDK for **Expo (SDK 51+)**.

This package is intentionally **thin**. It is exactly two things:

1. An **Expo config plugin** that wires the native background-location config Expo's
   managed/prebuild flow otherwise hides (iOS `Info.plist` usage strings +
   `UIBackgroundModes`, Android background-location permission + foreground-service
   declarations).
2. A **re-export of [`@geoseal/react-native`](../checkpoint-react-native)** — so
   the JS API under `@geoseal/expo` is **byte-identical** to the React Native
   wrapper. The RN wrapper is itself a thin bridge over the two native cores. There
   is no Expo-specific JS and no duplicated geofencing logic.

> **The device is a sensor.** All detection — M-of-N arrival confirmation, dwell,
> exit hysteresis, stale reaping — runs **server-side**. The SDK registers the
> perimeter ring as a native OS geofence (so the OS can wake a force-quit app) and
> POSTs location fixes from the **native** networking layer. Nothing more.

## Requirements

- Expo **SDK 51+**, using **prebuild + a development build** (config-plugin +
  autolinking era).
- **Not Expo Go.** Expo Go cannot host custom native background code (region
  monitoring, the foreground streaming service, native ingest). You need a
  development build: `npx expo run:ios` / `npx expo run:android` or an EAS build.

## How it composes the RN wrapper

```
@geoseal/expo
├── app.plugin.js ──► config plugin: mods Info.plist + AndroidManifest (+ Android
│                     build.gradle mavenLocal vendoring) at prebuild
└── src/index.ts  ──► export * from "@geoseal/react-native"   (identical JS API)
                          │
                          ▼  native engine, per platform (via the RN wrapper's build files)
                CheckpointCore iOS pod  ── or ──  dev.checkpoint:checkpoint-core AAR
                (engine classes keep the frozen com.checkpoint.capacitor.* FQCNs)
                          │
                          ▼
        POST /v1/device/token → GET /v1/sdk/fences → register regions → POST /v1/ingest
```

## Install

> **Status — live on npm.** `@geoseal/expo`, its peer
> [`@geoseal/react-native`](../checkpoint-react-native), and the core
> [`@geoseal/capacitor`](../checkpoint-capacitor) are published npm
> packages; the iOS `CheckpointCore` pod resolves from the CocoaPods trunk. Only
> the Android `dev.checkpoint:checkpoint-core` AAR is still pending a public
> Maven registry (the plugin's mavenLocal vendoring covers it, below).
> `@geoseal/react-native` should be a **direct** dependency of the app.
> Verified on an Expo SDK 57 host (`@expo/config-plugins` 57.x resolving this
> package's plugin, which itself uses its own nested `@expo/config-plugins@9`):
> `expo prebuild` applies every mod below — **with the autolinking exclude below
> in place**.

```sh
npx expo install @geoseal/expo @geoseal/react-native
```

> **Metro note:** the wrappers reach the core via the `@geoseal/capacitor/core`
> subpath. Expo SDK 53+ resolves package `exports` out of the box; on SDK 51/52
> (Metro exports-off default) the core's root proxy stubs (shipped since core
> 0.1.1) make the subpath resolve **with zero config** — no `metro.config.js`
> change needed anywhere.

### REQUIRED: exclude `@geoseal/capacitor` from Expo autolinking (iOS)

Add to the **app's `package.json`**:

```json
{
  "expo": {
    "autolinking": {
      "exclude": ["@geoseal/capacitor"]
    }
  }
}
```

Why: Expo's autolinking scans dependencies **recursively** (unlike the RN CLI,
which only scans direct deps), so it finds `@geoseal/capacitor` even when it is
only a transitive dependency of `@geoseal/react-native`. The package opts out of
RN-CLI autolinking via `react-native.config.cjs`, but Expo's autolinking only reads
`react-native.config.{js,ts}` — it cannot see the `.cjs` opt-out, falls back to
podspec scanning, and mis-links `CheckpointIrlCapacitor.podspec` (the Capacitor bridge
pod). `pod install` then pulls the obsolete CocoaPods-trunk `Capacitor` 2.x pod and
fails with `The Swift pod 'Capacitor' depends upon 'CapacitorCordova'...`. Only the
**CheckpointCore** pod (resolved from the CocoaPods trunk) should be linked, via
the RN podspec's dependency — never the Capacitor bridge pod. Android needs no
exclude (Expo's Android resolver skips the package — it
has no `ReactPackage` class), but the top-level exclude is harmless there. The
config plugin **warns at prebuild** if this entry is missing; a config plugin
cannot edit `package.json` for you.

### Android native-core resolution (`vendorNativeCore`, default **true**)

The RN wrapper's build files already declare the real core deps
(`s.dependency 'CheckpointCore', '~> 0.1'`; `implementation 'dev.checkpoint:checkpoint-core:0.1.0'`).
**iOS needs nothing from this plugin** — the pod resolves from the CocoaPods
trunk at `pod install` (the plugin's former ios/Podfile `:path` injection was
removed in 0.1.1). The Android AAR is not on a public Maven registry yet, so
the plugin injects the host-side resolution at prebuild:

- **android/build.gradle** — `allprojects { repositories { mavenLocal { content { includeGroup "dev.checkpoint" } } } }`

The Android side needs a one-time publish of the core AAR into `~/.m2`:

```sh
cd node_modules/@geoseal/capacitor/android-core && ./gradlew publishToMavenLocal
```

Set `"vendorNativeCore": false` in the plugin props once
`dev.checkpoint:checkpoint-core` is on Maven Central.

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": [
      [
        "@geoseal/expo",
        {
          "locationWhenInUsePermission": "Acme records arrivals and departures at your assigned facilities.",
          "locationAlwaysAndWhenInUsePermission": "Acme records an arrival or departure even when the app is closed.",
          "isAndroidBackgroundLocationEnabled": true,
          "isAndroidBatteryExemptionEnabled": true,
          "vendorNativeCore": true
        }
      ]
    ]
  }
}
```

All props are optional — sensible store-review-safe defaults are applied. Then
generate native projects and build a dev client:

```sh
npx expo prebuild
npx expo run:ios      # or run:android
```

### What the plugin injects

**iOS `Info.plist`**

- `NSLocationWhenInUseUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription` — **required** for background
  region wakes
- `NSLocationAlwaysUsageDescription` (legacy)
- `UIBackgroundModes` += `location`

**Android `AndroidManifest.xml`** (host-app permissions)

- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION` (API 29+)
- `POST_NOTIFICATIONS` (API 33+)
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`
- `RECEIVE_BOOT_COMPLETED`
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`

**Android vendoring** (`vendorNativeCore`, default true — see Install above)

- `android/build.gradle` — the content-filtered `mavenLocal()` repository
  (iOS gets no injection; the CheckpointCore pod resolves from the trunk)

**Guard rail** — at iOS prebuild the plugin checks the app's `package.json` for the
required `expo.autolinking.exclude: ["@geoseal/capacitor"]` entry (see Install)
and prints a warning naming the exact fix when it is missing.

The receivers/services themselves (`GeofenceBroadcastReceiver`,
`GeofencePostService`, `ContinuousLocationService`, `BootReceiver`) ship in the
library manifest inside the `dev.checkpoint:checkpoint-core` AAR (frozen FQCNs
`com.checkpoint.capacitor.*`) and are folded in by the manifest-merger when
autolinking links `@geoseal/react-native`'s android library (whose
`build.gradle` depends on that AAR) — the plugin does **not** redeclare them.

## Usage

The API is the universal Geoseal contract — identical to every other wrapper:

```ts
import { Checkpoint, NativeGeofence } from "@geoseal/expo";
import type { RegionEvent, TrackingMode } from "@geoseal/expo";

// 1. Bootstrap the transport. baseUrl + anonKey are REQUIRED (no baked defaults —
//    a published SDK must not ship a platform ref). publishableKey is safe in a binary.
//    init() is inert (logs, does not throw) when a cred is missing — check isConfigured().
Checkpoint.init({
  publishableKey: "pk_live_…",
  baseUrl: "https://<project>.supabase.co",
  anonKey: "<anon>",
});
Checkpoint.isConfigured(); // true once init() had all creds

// 2. Configure the native layer (persists creds + subject so a background
//    relaunch can POST without JS). deviceId is optional.
await NativeGeofence.configure({
  baseUrl: "https://<project>.supabase.co",
  anonKey: "<anon>",
  publishableKey: "pk_live_…",
  subjectExternalId: "your-subject-id",
});

// 3. Ask for Always authorization (required for background region wakes) and,
//    on Android, the battery-optimization exemption + notification permission.
await NativeGeofence.requestAlwaysAuthorization();
await NativeGeofence.requestNotificationAuthorization();
await NativeGeofence.requestBatteryExemption(); // no-op on iOS

// 4. Register the armed perimeter rings (your app pulls them from /v1/sdk/fences).
await NativeGeofence.addFence({
  id: "facility-123",
  latitude: 37.422,
  longitude: -122.084,
  radius: 200,
  name: "HQ",
});

// 5. Pick a tracking mode (server policy + user choice resolve the directive).
await Checkpoint.setTrackingMode("geofence"); // "geofence" | "always" | "off"

// 6. Listen for crossings while the app is alive (the native layer POSTs the
//    crossing even when JS is dead — this is best-effort UI sugar).
//    e.type: "enter" | "exit" | "update" | "stray_stream_stopped"
//    (stray_stream_stopped: the native stray-stream lifetime cap — configure()'s
//    maxStrayStreamS, default 600 s — self-stopped a reactive stream; regionId is ""
//    and lat/lng carry the last off-site fix).
const sub = await NativeGeofence.addListener("regionEvent", (e: RegionEvent) => {
  console.log(e.type, e.regionId, e.latitude, e.longitude, e.accuracy, e.timestamp);
});
// later: await sub.remove();
```

### Geofence-only entry point

Mirroring `@geoseal/react-native/geofence` (and `@geoseal/capacitor/geofence`),
`@geoseal/expo/geofence` exposes the strict geofence-only subset — `initGeofence`,
the raw `NativeGeofence` plugin, the armed-fence pull + geometry helpers,
device-token minting, outage telemetry, and the subject-id codec. It deliberately
omits the streaming ingest path, the self-serve place calls, the directive RPCs,
and local mode storage:

```ts
import { initGeofence, NativeGeofence, pullArmedFences } from "@geoseal/expo/geofence";
```

## Cross-wrapper listener idiom

The **types and wire values** are uniform across all four wrappers; the **call
syntax** for subscribing to region events is idiomatic per platform (this is the
one place the "uniform API" claim is scoped to types, not literal call syntax):

| Wrapper | Subscribe | Unsubscribe |
|---|---|---|
| Capacitor | `addListener('regionEvent', cb)` → `Promise<handle>` | `handle.remove()` |
| React Native | `addListener('regionEvent', cb)` → `Promise<{ remove }>` | `sub.remove()` |
| **Expo** | `addListener('regionEvent', cb)` (re-exports RN) | `sub.remove()` |
| Flutter | `addRegionEventListener(cb)` → `CheckpointListenerHandle` | `await handle.remove()` |
| .NET MAUI | `RegionEvent += handler;` (C# `event`) | `RegionEvent -= handler;` |

The event name (`"regionEvent"`), payload (`RegionEvent`), and `TrackingMode` wire
values are identical everywhere. The shared conformance fixture
(`test/conformance.spec.ts`, mirrored in each wrapper) asserts that.

## Before you ship

Background location is mostly an OS-power-management and store-review problem, not a
code problem. Read these first:

- **Battery optimization & whitelisting** — Android Doze / OEM killers silently kill
  background geofencing (`docs/guides/whitelisting.md`).
- **Store submission** — App Store / Play **reject** background-location apps without
  the right strings, background modes, and prominent disclosure
  (`docs/guides/store-submission.md`).
- **Test with mock locations** — simulate enter/exit/dwell against the server engine
  (`docs/guides/mock-locations.md`).

## License

Apache-2.0 (see `LICENSE`; matches `package.json`).
