<p align="center"><img src="https://raw.githubusercontent.com/geoseal/.github/main/brand/geoseal-mark.svg" width="140" alt="Geoseal — verified presence"></p>

# @geoseal/nativescript

A **thin** NativeScript plugin over the two device-verified Geoseal native
cores (`@geoseal/capacitor`'s iOS `GeofenceManager` + Android Play Services /
foreground-service layer). It re-implements **no** geofencing logic — that's
server-side — and, unlike the RN/Flutter/MAUI wrappers, it ships **no native
bridge code of its own**: the NativeScript runtime marshals the TS layer straight
onto the Capacitor-free shims that ship inside the cores.

```
TS  →  Checkpoint.init({ publishableKey, baseUrl, anonKey })
       NativeGeofence.configure({ … }); NativeGeofence.addFence({ … })
        │  (NativeScript runtime marshalling — no bridge layer)
        ▼
iOS  CheckpointGeofence.shared (@objc shim, CheckpointCore pod)
Android  com.checkpoint.core.CheckpointGeofence (checkpoint-core AAR)
        │
        ▼
   region wake → POST /v1/ingest from URLSession / HttpURLConnection  (NEVER a JS fetch)
```

The REST device path (mint / directive / ingest / fences / self-serve) is
**imported from `@geoseal/capacitor/core`** (the Capacitor-free JS subpath),
not hand-mirrored — the frozen wire shapes (ingest body, directive RPC keys,
mint `device_id`) are single-sourced with the reference SDK.

> **Status — live on npm + CocoaPods trunk; Android Maven pending.** This
> package and its JS core dependency install from npm; the iOS `CheckpointCore`
> pod resolves from the CocoaPods trunk. Only the Android
> `dev.checkpoint:checkpoint-core` AAR still needs the mavenLocal step (see
> [Native core dependency](#native-core-dependency)).

## Install

```sh
npm install @geoseal/nativescript
```

The plugin's `platforms/` glue wires the native cores automatically:

- **iOS** — `platforms/ios/Podfile`: `pod 'CheckpointCore', '~> 0.1'` — resolves
  from the CocoaPods trunk (CDN); on a machine with a stale CDN cache run
  `pod install --repo-update` once in the generated `platforms/ios`.
- **Android** — `platforms/android/include.gradle`:
  `implementation 'dev.checkpoint:checkpoint-core:0.1.0'`

### Native core dependency

- **Android (until Maven Central)**:
  `cd node_modules/@geoseal/capacitor/android-core && ./gradlew publishToMavenLocal`
  → `dev.checkpoint:checkpoint-core:0.1.0` lands in `~/.m2`; the plugin's
  `include.gradle` already lists `mavenLocal()`.
- **iOS**: nothing to do — the pod resolves from the trunk. (Developing against
  a checkout? Swap the versioned pod line in `platforms/ios/Podfile` for the
  commented `:path =>` line.)
- **JS**: `@geoseal/capacitor` is a real dependency of this package and
  installs from npm automatically.

## App configuration you own

**iOS `Info.plist`** (NativeScript: `App_Resources/iOS/Info.plist`):

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Uses your location to confirm arrival and departure at facilities.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Tracks location in the background to log time at facilities even when the app is closed.</string>
<key>UIBackgroundModes</key>
<array>
  <string>location</string>
</array>
```

**Android** — permissions and the engine's receivers/services are merged in from
the core AAR's manifest (fine/coarse/background location, POST_NOTIFICATIONS,
foreground-service-location, boot receiver, battery-exemption request). Nothing
to add by hand.

**iOS cold-relaunch revive (R2)** — when iOS relaunches the app in the
background for a location event, resume streaming without waiting for the UI:

```ts
// app.ts / bootstrap, iOS only
import { reviveForBackgroundLaunch } from "@geoseal/nativescript";
reviveForBackgroundLaunch(); // no-op on Android
```

**Android permission-result hook** — `requestAlwaysAuthorization()` launches the
system prompt but returns the pre-grant status synchronously (the native shim owns
no Activity, so it never observes the grant). After your permission flow completes
you MUST call `notifyPermissionsChanged()` so fences added before the "Allow all
the time" grant re-register (background-armed) and the persisted tracking
directive re-applies. Idempotent — safe to call any time; no-op on iOS.

```ts
// app.ts / bootstrap, Android only
import { AndroidApplication, Application } from "@nativescript/core";
import { notifyPermissionsChanged } from "@geoseal/nativescript";

if (Application.android) {
  Application.android.on(AndroidApplication.activityRequestPermissionsEvent, () =>
    notifyPermissionsChanged()
  );
}
```

## Usage (mirrors the universal SDK contract)

```ts
import { Checkpoint, NativeGeofence } from "@geoseal/nativescript";

// 1. Bootstrap the transport. All three creds are REQUIRED (no baked defaults).
//    Missing creds ⇒ logs + stays INERT (no throw); check isConfigured().
Checkpoint.init({
  publishableKey: "pk_live_…",
  baseUrl: "https://<project-ref>.supabase.co",
  anonKey: "<platform anon key>",
});

// 2. Persist the same creds natively (background relaunches POST without JS).
await NativeGeofence.configure({
  baseUrl: "https://<project-ref>.supabase.co",
  anonKey: "<platform anon key>",
  publishableKey: "pk_live_…",
  subjectExternalId: "nurse-123",
  trackingMode: "geofence",     // 'geofence' | 'always' | 'off'
  minIntervalS: 15,
  maxStrayStreamS: 600,         // stray-stream self-stop cap (reactive streams)
});

// 3. Permissions (two-step Always escalation on Android) + fences.
await NativeGeofence.requestAlwaysAuthorization();
await NativeGeofence.requestNotificationAuthorization();
await NativeGeofence.requestBatteryExemption(); // Android OEM doze exemption; iOS no-op
await NativeGeofence.addFence({ id: "fence-1", latitude: 40.1, longitude: -111.6, radius: 200 });

// 4. Live crossings while the app is alive (background POSTs happen natively regardless).
const handle = await NativeGeofence.addListener("regionEvent", (e) => {
  // e.type: 'enter' | 'exit' | 'update' | 'stray_stream_stopped'
  console.log(e.type, e.regionId, e.latitude, e.longitude);
});
// later: await handle.remove();

// 5. Tracking mode + diagnostics.
await Checkpoint.setTrackingMode("always");
const diag = await NativeGeofence.getDiagnostics(); // NativeDiagnostics incl. maxStrayStreamS, lastStrayStreamStopAt
```

## Geofence-only entry point

Privacy-first embeds (dtok_only tenants) can import the strict subset — no
streaming ingest, self-serve calls, directive RPCs, or mode storage:

```ts
import { initGeofence, NativeGeofence, pullArmedFences, mintDeviceToken } from "@geoseal/nativescript/geofence";
```

## Layout / verification

- `index.ios.ts` / `index.android.ts` — platform implementations (NativeScript
  webpack resolves the `.ios`/`.android` suffix). `index.d.ts` is the public
  surface; `common.ts` holds the shared facade + normalizers. No `exports` map
  on purpose — it would bypass the platform-suffix resolution.
- `test/conformance.spec.ts` — the cross-wrapper conformance fixture (canonical
  method sets, wire values, diagnostics fields), asserted at the type level by
  `tsc` for both platforms and at the value level by `npm test` (Node) for the
  iOS implementation + facade.
- `npm run build` compiles in place (`prepare` runs it on install/pack).

## License

Apache-2.0
