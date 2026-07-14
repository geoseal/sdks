import Foundation
import CoreLocation
import UIKit
import React                 // RCTEventEmitter / RCTPromise*Block (React-Core, via install_modules_dependencies)
import CheckpointCore        // the device-verified engine, split out of the Capacitor pod (CheckpointCore.podspec in @geoseal/capacitor)

// React Native iOS binding for Checkpoint.
//
// THIS FILE IS A THIN BRIDGE. It does no geofencing. It forwards each frozen
// contract method to `GeofenceManager.shared` — the SAME singleton CLLocationManager
// engine the Capacitor SDK's `NativeGeofence.swift` drives — and re-emits the
// engine's `regionEvent` callback to JS via RCTEventEmitter. This mirrors how
// HyperTrack's RN SDK wraps its native iOS core.
//
// Architecture choice: a classic RCTEventEmitter bridge module (not a Swift
// TurboModule). Rationale: (1) it works UNCHANGED on both the Old and New
// Architectures (RN's interop layer hosts a legacy module under bridgeless), so we
// ship one implementation; (2) a Swift TurboModule still requires an Objective-C++
// codegen shim, which buys nothing here because every method is a trivial forward
// to the engine — there is no hot per-frame call to justify the synchronous JSI
// path. The JS side prefers the TurboModule registry name and transparently falls
// back to this legacy module of the same name. State which + why: classic bridge,
// for cross-arch uniformity over a no-op-fast surface.
//
// DEPENDENCY ON THE CORE — see README. `GeofenceManager`'s engine methods
// (configure/addFence/clearFences/requestAlwaysAuthorization/applyTrackingMode/
// currentMode/isStreaming/monitoredCount/diagnostics/authorizationStatusString/
// onRegionEvent) and the `TrackingMode` enum are `public` in the CheckpointCore
// module (split out of the Capacitor pod), so this bridge binds directly. The
// podspec depends on the CheckpointCore pod; until it's on trunk, hosts vendor
// it via :path (see README).
//
// OBJC NAMING: the CheckpointCore pod itself ships an @objc(CheckpointGeofence)
// shim class (the runtime-agnostic binding surface for MAUI/NativeScript). Two
// ObjC classes may not share a runtime name, so this module is exposed as
// `CheckpointGeofenceModule` and re-mapped to the JS name "CheckpointGeofence"
// via RCT_EXTERN_REMAP_MODULE in CheckpointGeofence.m — the JS contract name is
// unchanged.

@objc(CheckpointGeofenceModule)
final class CheckpointGeofenceModule: RCTEventEmitter {

  private let manager = GeofenceManager.shared
  private var hasListeners = false

  // RCTEventEmitter requires a stable module name + thread declaration.
  @objc override static func moduleName() -> String! { "CheckpointGeofence" }
  @objc override static func requiresMainQueueSetup() -> Bool { true }
  @objc override func supportedEvents() -> [String]! { ["regionEvent"] }

  override init() {
    super.init()
    // Forward native region events to JS when the runtime is alive. The engine
    // already POSTed the wake ping from native URLSession regardless of JS.
    manager.onRegionEvent = { [weak self] payload in
      guard let self = self, self.hasListeners else { return }
      self.sendEvent(withName: "regionEvent", body: payload)
    }
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  // MARK: - Frozen contract (mirrors NativeGeofence.swift method-for-method)

  @objc(configure:anonKey:publishableKey:subjectExternalId:deviceId:trackingMode:streamNow:minIntervalS:maxStrayStreamS:resolver:rejecter:)
  func configure(_ baseUrl: String,
                 anonKey: String,
                 publishableKey: String,
                 subjectExternalId: String,
                 deviceId: String?,
                 trackingMode: String?,
                 streamNow: NSNumber?,
                 minIntervalS: NSNumber?,
                 maxStrayStreamS: NSNumber?,
                 resolver resolve: RCTPromiseResolveBlock,
                 rejecter reject: RCTPromiseRejectBlock) {
    manager.configure(baseUrl: baseUrl,
                       anonKey: anonKey,
                       publishableKey: publishableKey,
                       subjectExternalId: subjectExternalId,
                       deviceId: deviceId ?? "ios-native",
                       trackingMode: trackingMode,
                       streamNow: streamNow?.boolValue,
                       minIntervalS: minIntervalS?.doubleValue,
                       maxStrayStreamS: maxStrayStreamS?.doubleValue)
    resolve(nil)
  }

  @objc(requestAlwaysAuthorization:rejecter:)
  func requestAlwaysAuthorization(_ resolve: RCTPromiseResolveBlock,
                                  rejecter reject: RCTPromiseRejectBlock) {
    manager.requestAlwaysAuthorization()
    resolve(["status": manager.authorizationStatusString()])
  }

  @objc(requestNotificationAuthorization:rejecter:)
  func requestNotificationAuthorization(_ resolve: RCTPromiseResolveBlock,
                                        rejecter reject: RCTPromiseRejectBlock) {
    manager.requestNotificationAuthorization()
    resolve(nil)
  }

  // iOS has no battery-optimization concept; region monitoring is delivered
  // regardless. No-op that keeps the shared JS interface identical across platforms.
  @objc(requestBatteryExemption:rejecter:)
  func requestBatteryExemption(_ resolve: RCTPromiseResolveBlock,
                               rejecter reject: RCTPromiseRejectBlock) {
    resolve(["ignoringBatteryOptimizations": true])
  }

  // Open the OS Settings page for this app. The only reliable way to change
  // location authorization once iOS has shown the one-time "Always" upgrade
  // prompt — after the user declines it, `requestAlwaysAuthorization` is a
  // permanent silent no-op, so the gate's escape hatch must be Settings.
  // Mirrors the Capacitor core's NativeGeofence.openAppSettings.
  @objc(openAppSettings:rejecter:)
  func openAppSettings(_ resolve: RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
      }
    }
    resolve(nil)
  }

  @objc(addFence:latitude:longitude:radius:name:resolver:rejecter:)
  func addFence(_ id: String,
                latitude: NSNumber,
                longitude: NSNumber,
                radius: NSNumber?,
                name: String?,
                resolver resolve: RCTPromiseResolveBlock,
                rejecter reject: RCTPromiseRejectBlock) {
    manager.addFence(id: id,
                     latitude: latitude.doubleValue,
                     longitude: longitude.doubleValue,
                     radius: radius?.doubleValue ?? 200.0,
                     name: name)
    resolve(["monitoredCount": manager.monitoredCount()])
  }

  @objc(clearFences:rejecter:)
  func clearFences(_ resolve: RCTPromiseResolveBlock,
                   rejecter reject: RCTPromiseRejectBlock) {
    manager.clearFences()
    resolve(nil)
  }

  @objc(setTrackingMode:resolver:rejecter:)
  func setTrackingMode(_ mode: String,
                       resolver resolve: RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
    guard let parsed = GeofenceManager.TrackingMode(rawValue: mode) else {
      reject("E_MODE", "setTrackingMode requires mode ∈ {geofence, always, off}", nil)
      return
    }
    let streaming = manager.applyTrackingMode(parsed)
    resolve(["mode": parsed.rawValue, "streaming": streaming])
  }

  @objc(getTrackingMode:rejecter:)
  func getTrackingMode(_ resolve: RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
    resolve(["mode": manager.currentMode().rawValue, "streaming": manager.isStreaming()])
  }

  @objc(getDiagnostics:rejecter:)
  func getDiagnostics(_ resolve: RCTPromiseResolveBlock,
                      rejecter reject: RCTPromiseRejectBlock) {
    resolve(manager.diagnostics())
  }
}
