// Hand-authored ambient declarations for the two Checkpoint native shims, as the
// NativeScript runtimes marshal them. @nativescript/types covers the OS SDKs; the
// shims ship in CheckpointCore.podspec / dev.checkpoint:checkpoint-core, so no
// generated typings exist for them.
//
// SOURCE OF TRUTH (keep 1:1):
//   iOS     packages/checkpoint-capacitor/ios/Sources/CheckpointCore/CheckpointGeofence.swift
//   Android packages/checkpoint-capacitor/android/src/main/java/com/checkpoint/core/
//           {CheckpointGeofence,RegionEventListener}.java
//
// iOS JS names follow the NativeScript selector marshalling rule (colons removed,
// letter after each colon uppercased) applied to the Swift-generated ObjC
// selectors — the same selectors the MAUI binding pins in ApiDefinition.cs.

// ── iOS: @objc(CheckpointGeofence), CheckpointCore pod ───────────────────────
declare class CheckpointGeofence extends NSObject {
  /** Singleton — same instance the host AppDelegate revive path uses. */
  static readonly shared: CheckpointGeofence;

  /**
   * Region-event sink (`GeofenceManager.onRegionEvent`). Receives the exact
   * RegionEvent dictionary: type / regionId / latitude / longitude / accuracy /
   * timestamp. Set to null to detach.
   */
  onRegionEvent: ((event: NSDictionary<string, any>) => void) | null;

  /** Selector: configureWithBaseUrl:anonKey:publishableKey:subjectExternalId:deviceId:trackingMode:streamNow:minIntervalS:maxStrayStreamS: */
  configureWithBaseUrlAnonKeyPublishableKeySubjectExternalIdDeviceIdTrackingModeStreamNowMinIntervalSMaxStrayStreamS(
    baseUrl: string,
    anonKey: string,
    publishableKey: string,
    subjectExternalId: string,
    deviceId: string,
    trackingMode: string | null,
    streamNow: number | null,
    minIntervalS: number | null,
    maxStrayStreamS: number | null
  ): void;

  /** Returns the auth status string at call time (the prompt itself is async). */
  requestAlwaysAuthorization(): string;

  requestNotificationAuthorization(): void;

  /** iOS no-op; always true (Android-only concept, kept for surface parity). */
  requestBatteryExemption(): boolean;

  openAppSettings(): void;

  /** Selector: addFenceWithId:latitude:longitude:radius:name: — returns monitoredCount. */
  addFenceWithIdLatitudeLongitudeRadiusName(
    id: string,
    latitude: number,
    longitude: number,
    radius: number,
    name: string | null
  ): number;

  clearFences(): void;

  /** Returns { mode, streaming } as NSDictionary. */
  setTrackingMode(mode: string): NSDictionary<string, any>;

  /** Returns { mode, streaming } as NSDictionary. */
  getTrackingMode(): NSDictionary<string, any>;

  /** NativeDiagnostics shape as NSDictionary. */
  diagnostics(): NSDictionary<string, any>;

  /** Host AppDelegate cold location-relaunch revive (extraction-plan R2). */
  reviveForBackgroundLaunch(): void;
}

// ── Android: com.checkpoint.core.*, dev.checkpoint:checkpoint-core AAR ───────
declare namespace com {
  namespace checkpoint {
    namespace core {
      class RegionEventListener extends java.lang.Object {
        constructor(implementation: {
          onRegionEvent(
            type: string,
            regionId: string,
            latitude: number,
            longitude: number,
            accuracy: number,
            timestamp: string
          ): void;
        });
        onRegionEvent(
          type: string,
          regionId: string,
          latitude: number,
          longitude: number,
          accuracy: number,
          timestamp: string
        ): void;
      }

      class CheckpointGeofence extends java.lang.Object {
        constructor(ctx: android.content.Context);

        /** Install (or clear, with null) the live region-event sink. */
        setRegionEventListener(l: com.checkpoint.core.RegionEventListener | null): void;

        /** Boxed Boolean/Integer so null = "leave persisted value intact". */
        configure(
          baseUrl: string,
          anonKey: string,
          pk: string,
          subject: string,
          deviceId: string,
          mode: string | null,
          streamNow: java.lang.Boolean | null,
          minIntervalS: java.lang.Integer | null,
          maxStrayStreamS: java.lang.Integer | null
        ): void;

        /** FG→BG two-step escalation; returns current status (prompt is async). */
        requestAlwaysAuthorization(activity: android.app.Activity | null): string;

        /**
         * Host permission-result hook (the shim owns no Activity, so it never sees
         * the grant): re-registers persisted fences + re-applies the persisted
         * mode/directive. Idempotent; safe to call any time.
         */
        notifyPermissionsChanged(): void;

        requestNotificationAuthorization(activity: android.app.Activity | null): void;

        /** Returns whether the app is ALREADY exempt at call time. */
        requestBatteryExemption(activity: android.app.Activity | null): boolean;

        openAppSettings(): void;

        /** Returns the stored fence count. */
        addFence(id: string, lat: number, lng: number, radius: number, name: string | null): number;

        clearFences(): void;

        /** Returns { mode: String, streaming: Boolean }. */
        setTrackingMode(mode: string): java.util.Map<string, any>;

        /** Returns { mode: String, streaming: Boolean }. */
        getTrackingMode(): java.util.Map<string, any>;

        /** NativeDiagnostics shape. */
        diagnostics(): org.json.JSONObject;
      }
    }
  }
}
