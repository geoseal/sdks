import Foundation
import UIKit
// Two supported layouts (build-xcframework.sh): the RECOMMENDED single-module
// co-compile (GeofenceManager.swift + this file → one CheckpointCore module, no
// import needed) and a Pod-module link (the engine stays in the CheckpointCapacitor
// module, public). The conditional import supports both.
#if canImport(CheckpointCapacitor)
import CheckpointCapacitor
#endif

/// Capacitor-free, runtime-agnostic ObjC shim over the Checkpoint iOS engine
/// (`GeofenceManager`).
///
/// WHY THIS EXISTS
/// ---------------
/// The reference core ships the engine inside the `CheckpointCapacitor` Pod, but
/// its only *public entry point* is the Capacitor plugin shell `NativeGeofence`
/// (`CAPPlugin`), whose methods take `CAPPluginCall` objects the Capacitor bridge
/// constructs — NOT callable from a .NET MAUI host. The load-bearing logic lives in
/// `GeofenceManager` (region monitoring, the offline-safe `URLSession` ingest, the
/// continuous stream, tracking-mode persistence). The core on `main`
/// (`packages/checkpoint-capacitor`) ships `GeofenceManager` + its members as
/// `public`, so this shim can reach the engine across the Pod module boundary
/// WITHOUT depending on Capacitor at all.
///
/// This class re-exposes the engine with a plain `@objc` surface a standard
/// .NET-for-iOS *binding project* (objcsharpgen / ApiDefinition) can project into
/// C# as `CheckpointGeofence`. It reimplements NONE of the engine — every method is
/// a thin forward to `GeofenceManager.shared`.
///
/// API CONTRACT
/// ------------
/// 1:1 with `definitions.ts` `NativeGeofencePlugin` and with the signatures the MAUI
/// wrapper documents inline in `Platforms/iOS/IosNativeGeofence.cs`. Dictionaries are
/// returned as `NSDictionary` (the binding projects them and the wrapper's
/// `NativeInterop` maps them). The `onRegionEvent` callback bridges
/// `GeofenceManager.onRegionEvent` to a block the binding projects as an `Action`.
///
/// INTENDED HOME
/// -------------
/// This source SHOULD live in `packages/checkpoint-capacitor` (the core, now on
/// `main`), since it wraps the core engine and must version-lock with it —
/// co-located in the Pod as a second framework target (or a second `source_files`
/// glob). It is authored here under `packages/checkpoint-maui/native/` only so it is
/// reviewable alongside the wrapper that consumes it; relocate into the core package
/// when the artifact chain (native/BUILD-CHECKLIST.md) is first executed. See README
/// "Native dependency".
@objc(CheckpointGeofence)
public final class CheckpointGeofence: NSObject {

    /// Mirrors the engine's own singleton — the AppDelegate cold-relaunch path and
    /// every wrapper share ONE `GeofenceManager`, so there is exactly one
    /// `CLLocationManager` + one `onRegionEvent` sink (extraction-plan R1/R2).
    @objc public static let shared = CheckpointGeofence()

    private let manager = GeofenceManager.shared

    private override init() { super.init() }

    // MARK: - Region-event bridge  (← GeofenceManager.onRegionEvent)

    /// Set by the binding; receives the EXACT dictionary `GeofenceManager.postPing(...)`
    /// emits: `type / regionId / latitude / longitude / accuracy / timestamp`. Forwarded
    /// to C# as the `RegionEvent` event. Best-effort: fires only while the host process
    /// is alive (a crossing during process death is still POSTed natively).
    @objc public var onRegionEvent: ((NSDictionary) -> Void)? {
        didSet {
            guard let cb = onRegionEvent else {
                manager.onRegionEvent = nil
                return
            }
            // GeofenceManager emits [String: Any]; project to NSDictionary for ObjC.
            manager.onRegionEvent = { payload in
                cb(payload as NSDictionary)
            }
        }
    }

    // MARK: - Config  (→ GeofenceManager.configure)

    /// Persist creds + the subject external id (and the optional server tracking
    /// directive) to UserDefaults so a background relaunch can POST without the host.
    /// `deviceId` is non-optional here (the wrapper always supplies one; pass
    /// "ios-native" as the documented default) — `trackingMode` is the lowercase wire
    /// value ("geofence" | "always" | "off") or nil to leave the persisted mode intact.
    /// `streamNow` / `minIntervalS` / `maxStrayStreamS` are boxed (`NSNumber?`) so
    /// "absent" is distinct from false / 0, matching the engine's optional-directive
    /// semantics (nil leaves the persisted value intact; non-positive cap is ignored).
    @objc public func configure(baseUrl: String,
                                anonKey: String,
                                publishableKey: String,
                                subjectExternalId: String,
                                deviceId: String,
                                trackingMode: String?,
                                streamNow: NSNumber?,
                                minIntervalS: NSNumber?,
                                maxStrayStreamS: NSNumber?) {
        manager.configure(baseUrl: baseUrl,
                          anonKey: anonKey,
                          publishableKey: publishableKey,
                          subjectExternalId: subjectExternalId,
                          deviceId: deviceId,
                          trackingMode: trackingMode,
                          streamNow: streamNow?.boolValue,
                          minIntervalS: minIntervalS?.doubleValue,
                          maxStrayStreamS: maxStrayStreamS?.doubleValue)
    }

    // MARK: - Authorization

    /// Prompt for "Always" location auth (required for background region wakes) and
    /// return the resulting authorization status string (engine's
    /// `authorizationStatusString()`: notDetermined/restricted/denied/authorizedAlways/
    /// authorizedWhenInUse/unknown). The prompt is async at the OS level; the returned
    /// value is the status at call time (matches the Capacitor plugin's resolve).
    @objc public func requestAlwaysAuthorization() -> String {
        manager.requestAlwaysAuthorization()
        return manager.authorizationStatusString()
    }

    /// Prompt for local-notification permission (for "arrived/left" crossing banners).
    @objc public func requestNotificationAuthorization() {
        manager.requestNotificationAuthorization()
    }

    /// Android-only concept. iOS region monitoring is delivered regardless of battery
    /// optimization, so this is a no-op that returns `true` — byte-identical to the
    /// Capacitor plugin's `requestBatteryExemption`. Present for cross-platform surface
    /// parity; the MAUI wrapper short-circuits this on iOS without calling the shim.
    @objc public func requestBatteryExemption() -> Bool {
        return true
    }

    /// Open the OS Settings page for this app. The only reliable way to change
    /// location authorization once iOS has shown the one-time "Always" upgrade
    /// prompt — after the user declines it, `requestAlwaysAuthorization` is a
    /// permanent silent no-op, so the gate's escape hatch must be Settings.
    /// Byte-identical behavior to the Capacitor plugin's `openAppSettings`
    /// (NativeGeofence.swift).
    @objc public func openAppSettings() {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        }
    }

    // MARK: - Fences

    /// Start monitoring a circular region (radius meters; pass 200 for the native
    /// default). Returns the number of regions now monitored.
    @objc public func addFence(id: String,
                               latitude: Double,
                               longitude: Double,
                               radius: Double,
                               name: String?) -> Int {
        manager.addFence(id: id, latitude: latitude, longitude: longitude, radius: radius, name: name)
        return manager.monitoredCount()
    }

    /// Stop monitoring all regions.
    @objc public func clearFences() {
        manager.clearFences()
    }

    // MARK: - Tracking mode (tracking-modes §4)

    /// Persist + apply the effective tracking mode (idempotent). `mode` is the wire
    /// value; an unknown value is coerced to `geofence` by the engine's enum init.
    /// Returns `{ mode, streaming }`.
    @objc public func setTrackingMode(_ mode: String) -> NSDictionary {
        let parsed = GeofenceManager.TrackingMode(rawValue: mode) ?? .geofence
        let streaming = manager.applyTrackingMode(parsed)
        return ["mode": parsed.rawValue, "streaming": streaming] as NSDictionary
    }

    /// Current mode + whether a continuous stream is live right now.
    @objc public func getTrackingMode() -> NSDictionary {
        return ["mode": manager.currentMode().rawValue,
                "streaming": manager.isStreaming()] as NSDictionary
    }

    // MARK: - Diagnostics

    /// Snapshot of native region-monitoring state for the in-app debug screen
    /// (`NativeDiagnostics` shape). Forwards `GeofenceManager.diagnostics()` verbatim —
    /// including the iOS-only `slcMonitoring` flag (the always-mode SLC transit
    /// keep-alive liveness the engine reports).
    @objc public func diagnostics() -> NSDictionary {
        return manager.diagnostics() as NSDictionary
    }

    // MARK: - Cold-relaunch revive (host AppDelegate)

    /// Called from the host app's `AppDelegate` on a location relaunch so an
    /// `always + streamNow` device resumes streaming after a force-quit (README
    /// "iOS cold-relaunch revive"). Forwards `GeofenceManager.reviveForBackgroundLaunch()`.
    @objc public func reviveForBackgroundLaunch() {
        manager.reviveForBackgroundLaunch()
    }
}
