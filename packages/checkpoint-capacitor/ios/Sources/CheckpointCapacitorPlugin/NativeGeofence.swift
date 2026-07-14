import Foundation
import Capacitor
import CoreLocation
import UIKit

/// Native wake-on-geofence plugin.
///
/// The OUTER perimeter geofence is registered as a `CLCircularRegion` and monitored
/// by `CLLocationManager` region monitoring. Region monitoring relaunches the app
/// (even from a killed/suspended state) on enter/exit. When a region event fires we
/// request a one-shot current location and POST it to Supabase `location_history`
/// from native Swift (URLSession) so a crossing is recorded even when the JS/webview
/// is dead. The existing server-side trigger + inner-ring evaluation do the rest.
///
/// Registration: as an npm-distributed Capacitor plugin, this class is AUTO-
/// registered via the `cap sync`-generated `capacitor.config`/`packageClassList`
/// — do NOT also register it manually (`bridge?.registerPluginInstance(...)`) in
/// the host app, or you double-register and two instances race on `onRegionEvent`
/// (extraction-plan §7 / R1). The host app's `AppDelegate` still calls
/// `GeofenceManager.shared.reviveForBackgroundLaunch()` on a cold location
/// relaunch (R2) — that is an app-delegate concern that references this pod's
/// shared engine, not the plugin instance.
@objc(NativeGeofence)
public class NativeGeofence: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeGeofence"
    public let jsName = "NativeGeofence"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addFence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearFences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlwaysAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestBatteryExemption", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTrackingMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTrackingMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiagnostics", returnType: CAPPluginReturnPromise)
    ]

    /// All region-monitoring + POST work lives in the shared manager so the
    /// AppDelegate relaunch path can revive it without a live plugin instance.
    private let manager = GeofenceManager.shared

    @objc override public func load() {
        // Forward native region events to JS when the webview is alive.
        manager.onRegionEvent = { [weak self] payload in
            self?.notifyListeners("regionEvent", data: payload)
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard let baseUrl = call.getString("baseUrl"),
              let anonKey = call.getString("anonKey"),
              let publishableKey = call.getString("publishableKey"),
              let subjectExternalId = call.getString("subjectExternalId") else {
            call.reject("configure requires baseUrl, anonKey, publishableKey, subjectExternalId")
            return
        }
        let deviceId = call.getString("deviceId") ?? "ios-native"
        // Tracking-modes §4: optional directive fields. Absent ⇒ leave persisted
        // values untouched (older JS callers unaffected).
        let trackingMode = call.getString("trackingMode")
        let streamNow = call.getBool("streamNow")
        let minIntervalS = call.getDouble("minIntervalS")
        // Stray-stream bound: optional cap (seconds) on a reactive stream's
        // lifetime without an in-fence fix. Absent ⇒ keep the persisted/default.
        let maxStrayStreamS = call.getDouble("maxStrayStreamS")
        manager.configure(baseUrl: baseUrl,
                          anonKey: anonKey,
                          publishableKey: publishableKey,
                          subjectExternalId: subjectExternalId,
                          deviceId: deviceId,
                          trackingMode: trackingMode,
                          streamNow: streamNow,
                          minIntervalS: minIntervalS,
                          maxStrayStreamS: maxStrayStreamS)
        call.resolve()
    }

    @objc func requestAlwaysAuthorization(_ call: CAPPluginCall) {
        manager.requestAlwaysAuthorization()
        call.resolve(["status": manager.authorizationStatusString()])
    }

    @objc func requestNotificationAuthorization(_ call: CAPPluginCall) {
        manager.requestNotificationAuthorization()
        call.resolve()
    }

    /// Android-only concept (Doze / OEM battery optimization). iOS has no equivalent
    /// user-facing exemption — region monitoring is delivered regardless — so this
    /// is a no-op that keeps the shared JS interface identical across platforms.
    @objc func requestBatteryExemption(_ call: CAPPluginCall) {
        call.resolve(["ignoringBatteryOptimizations": true])
    }

    /// Open the OS Settings page for this app. The only reliable way to change
    /// location authorization once iOS has shown the one-time "Always" upgrade
    /// prompt — after the user declines it, `requestAlwaysAuthorization` is a
    /// permanent silent no-op, so the gate's escape hatch must be Settings.
    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        }
        call.resolve()
    }

    @objc func addFence(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let lat = call.getDouble("latitude"),
              let lng = call.getDouble("longitude") else {
            call.reject("addFence requires id, latitude, longitude")
            return
        }
        // radius is optional; default to a sane perimeter value.
        let radius = call.getDouble("radius") ?? 200.0
        let name = call.getString("name")
        manager.addFence(id: id, latitude: lat, longitude: lng, radius: radius, name: name)
        call.resolve(["monitoredCount": manager.monitoredCount()])
    }

    @objc func clearFences(_ call: CAPPluginCall) {
        manager.clearFences()
        call.resolve()
    }

    /// Persist + apply the effective tracking mode (tracking-modes §4). Idempotent.
    /// Returns the applied mode and whether a continuous stream is live as a result.
    @objc func setTrackingMode(_ call: CAPPluginCall) {
        guard let raw = call.getString("mode"),
              let mode = GeofenceManager.TrackingMode(rawValue: raw) else {
            call.reject("setTrackingMode requires mode ∈ {geofence, always, off}")
            return
        }
        let streaming = manager.applyTrackingMode(mode)
        call.resolve(["mode": mode.rawValue, "streaming": streaming])
    }

    /// Current mode + whether a continuous stream is live right now (§4).
    @objc func getTrackingMode(_ call: CAPPluginCall) {
        call.resolve([
            "mode": manager.currentMode().rawValue,
            "streaming": manager.isStreaming()
        ])
    }

    @objc func getDiagnostics(_ call: CAPPluginCall) {
        call.resolve(manager.diagnostics())
    }
}
