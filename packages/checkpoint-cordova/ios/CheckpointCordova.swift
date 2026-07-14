import Foundation
import UIKit
import CheckpointCore
// cordova-ios ≥7 exposes CordovaLib as the `Cordova` module; older templates
// surface CDVPlugin through the app target's bridging header instead. The
// conditional import supports both without editing the host app.
#if canImport(Cordova)
import Cordova
#endif

/// Cordova bridge over the Checkpoint iOS engine (`GeofenceManager.shared`,
/// from the CheckpointCore pod). Mirror of the Capacitor plugin
/// `NativeGeofence.swift` — the same 10 methods, the same wire values, the same
/// engine singleton — plus `registerRegionEventChannel`, Cordova's analog of
/// `addListener("regionEvent", …)`: one long-lived callback (keepCallback) that
/// pushes every RegionEvent dictionary to JS while the webview is alive. The
/// background POST path (region wake / continuous stream) is native and does
/// not depend on this channel.
///
/// Registered under the exec service name "CheckpointGeofence" (plugin.xml
/// <feature>). All region-monitoring + POST work lives in the shared manager so
/// the host AppDelegate cold-relaunch path (see README "iOS cold-relaunch
/// revive") can revive it without a live plugin instance.
@objc(CheckpointCordova)
public class CheckpointCordova: CDVPlugin {

    private var manager: GeofenceManager { GeofenceManager.shared }

    /// The live regionEvent channel callback id (nil until JS registers).
    private var regionEventCallbackId: String?

    // MARK: - regionEvent channel

    /// JS calls this once (first `addListener`); we hold the callback open and
    /// forward `GeofenceManager.onRegionEvent` payloads through it verbatim
    /// (`type / regionId / latitude / longitude / accuracy / timestamp`).
    @objc(registerRegionEventChannel:)
    func registerRegionEventChannel(_ command: CDVInvokedUrlCommand) {
        regionEventCallbackId = command.callbackId
        manager.onRegionEvent = { [weak self] payload in
            guard let self = self, let callbackId = self.regionEventCallbackId else { return }
            let result = CDVPluginResult(status: .ok, messageAs: payload)
            result.setKeepCallbackAs(true)
            self.commandDelegate.send(result, callbackId: callbackId)
        }
        // No initial payload — just keep the callback alive for future events.
        let pending = CDVPluginResult(status: .noResult)
        pending.setKeepCallbackAs(true)
        commandDelegate.send(pending, callbackId: command.callbackId)
    }

    // MARK: - Config

    @objc(configure:)
    func configure(_ command: CDVInvokedUrlCommand) {
        guard let opts = command.argument(at: 0) as? [String: Any],
              let baseUrl = opts["baseUrl"] as? String,
              let anonKey = opts["anonKey"] as? String,
              let publishableKey = opts["publishableKey"] as? String,
              let subjectExternalId = opts["subjectExternalId"] as? String else {
            sendError(command, "configure requires baseUrl, anonKey, publishableKey, subjectExternalId")
            return
        }
        let deviceId = opts["deviceId"] as? String ?? "ios-native"
        // Tracking-modes §4: optional directive fields. Absent ⇒ leave persisted
        // values untouched (older JS callers unaffected).
        let trackingMode = opts["trackingMode"] as? String
        let streamNow = opts["streamNow"] as? Bool
        let minIntervalS = (opts["minIntervalS"] as? NSNumber)?.doubleValue
        // Stray-stream bound: optional cap (seconds) on a reactive stream's
        // lifetime without an in-fence fix. Absent ⇒ keep the persisted/default.
        let maxStrayStreamS = (opts["maxStrayStreamS"] as? NSNumber)?.doubleValue
        manager.configure(baseUrl: baseUrl,
                          anonKey: anonKey,
                          publishableKey: publishableKey,
                          subjectExternalId: subjectExternalId,
                          deviceId: deviceId,
                          trackingMode: trackingMode,
                          streamNow: streamNow,
                          minIntervalS: minIntervalS,
                          maxStrayStreamS: maxStrayStreamS)
        sendOk(command)
    }

    // MARK: - Authorization

    @objc(requestAlwaysAuthorization:)
    func requestAlwaysAuthorization(_ command: CDVInvokedUrlCommand) {
        manager.requestAlwaysAuthorization()
        sendOk(command, ["status": manager.authorizationStatusString()])
    }

    @objc(requestNotificationAuthorization:)
    func requestNotificationAuthorization(_ command: CDVInvokedUrlCommand) {
        manager.requestNotificationAuthorization()
        sendOk(command)
    }

    /// Android-only concept (Doze / OEM battery optimization). iOS has no equivalent
    /// user-facing exemption — region monitoring is delivered regardless — so this
    /// is a no-op that keeps the shared JS interface identical across platforms.
    @objc(requestBatteryExemption:)
    func requestBatteryExemption(_ command: CDVInvokedUrlCommand) {
        sendOk(command, ["ignoringBatteryOptimizations": true])
    }

    /// Open the OS Settings page for this app. The only reliable way to change
    /// location authorization once iOS has shown the one-time "Always" upgrade
    /// prompt — after the user declines it, `requestAlwaysAuthorization` is a
    /// permanent silent no-op, so the gate's escape hatch must be Settings.
    @objc(openAppSettings:)
    func openAppSettings(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        }
        sendOk(command)
    }

    // MARK: - Fences

    @objc(addFence:)
    func addFence(_ command: CDVInvokedUrlCommand) {
        guard let opts = command.argument(at: 0) as? [String: Any],
              let id = opts["id"] as? String,
              let lat = (opts["latitude"] as? NSNumber)?.doubleValue,
              let lng = (opts["longitude"] as? NSNumber)?.doubleValue else {
            sendError(command, "addFence requires id, latitude, longitude")
            return
        }
        // radius is optional; default to a sane perimeter value.
        let radius = (opts["radius"] as? NSNumber)?.doubleValue ?? 200.0
        let name = opts["name"] as? String
        manager.addFence(id: id, latitude: lat, longitude: lng, radius: radius, name: name)
        sendOk(command, ["monitoredCount": manager.monitoredCount()])
    }

    @objc(clearFences:)
    func clearFences(_ command: CDVInvokedUrlCommand) {
        manager.clearFences()
        sendOk(command)
    }

    // MARK: - Tracking mode (tracking-modes §4)

    /// Persist + apply the effective tracking mode. Idempotent. Returns the
    /// applied mode and whether a continuous stream is live as a result.
    @objc(setTrackingMode:)
    func setTrackingMode(_ command: CDVInvokedUrlCommand) {
        guard let opts = command.argument(at: 0) as? [String: Any],
              let raw = opts["mode"] as? String,
              let mode = GeofenceManager.TrackingMode(rawValue: raw) else {
            sendError(command, "setTrackingMode requires mode ∈ {geofence, always, off}")
            return
        }
        let streaming = manager.applyTrackingMode(mode)
        sendOk(command, ["mode": mode.rawValue, "streaming": streaming])
    }

    /// Current mode + whether a continuous stream is live right now (§4).
    @objc(getTrackingMode:)
    func getTrackingMode(_ command: CDVInvokedUrlCommand) {
        sendOk(command, [
            "mode": manager.currentMode().rawValue,
            "streaming": manager.isStreaming()
        ])
    }

    // MARK: - Diagnostics

    @objc(getDiagnostics:)
    func getDiagnostics(_ command: CDVInvokedUrlCommand) {
        sendOk(command, manager.diagnostics())
    }

    // MARK: - helpers

    private func sendOk(_ command: CDVInvokedUrlCommand, _ message: [String: Any]? = nil) {
        let result: CDVPluginResult
        if let message = message {
            result = CDVPluginResult(status: .ok, messageAs: message)
        } else {
            result = CDVPluginResult(status: .ok)
        }
        commandDelegate.send(result, callbackId: command.callbackId)
    }

    private func sendError(_ command: CDVInvokedUrlCommand, _ message: String) {
        commandDelegate.send(
            CDVPluginResult(status: .error, messageAs: message),
            callbackId: command.callbackId
        )
    }
}
