// @geoseal/nativescript — public API surface (hand-authored: the runtime is
// platform-split into index.ios.js / index.android.js, which the NativeScript
// webpack resolver picks per build; both are type-checked against this exact
// surface by test/conformance.spec.ts).

// ── Layer-2 REST surface (single-sourced from the reference core) ────────────
export {
  mintDeviceToken,
  getTrackingDirective,
  setDeviceTrackingMode,
  reportTrackingOutages,
  encodeSubjectPublicId,
  decodeSubjectPublicId,
  modeKey,
  readStoredMode,
  writeStoredMode,
  readPendingMode,
  writePendingMode,
  clearPendingMode,
  metersBetween,
  fenceSignature,
  zoneFor,
  pullArmedFences,
  fetchNearbyPlaces,
  postSelfFence,
  postJoinPlace,
  ingestFix,
  DEFAULT_DIRECTIVE,
  getTransport,
  peekTransport,
} from "@geoseal/capacitor/core";
export type {
  DeviceToken,
  TrackingDirective,
  TrackingModeSource,
  CheckpointApiError,
  OutageReport,
  OutageReason,
  LocationPermission,
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
  NearbyPlace,
  CheckpointTransport,
  CheckpointTransportConfig,
  TrackingMode,
  RegionEvent,
  NativeDiagnostics,
  NativeFenceDiag,
  NativeGeofencePlugin,
  PluginListenerHandle,
} from "@geoseal/capacitor/core";

/** The platform `/v1` API version this SDK targets (informational). */
export declare const CHECKPOINT_API_VERSION: "v1";

/** Same cred shape as the reference `Checkpoint.init` (structurally identical). */
export type CheckpointConfig = import("@geoseal/capacitor/core").CheckpointTransportConfig;

/**
 * Layer 1 — the raw native plugin, frozen contract (definitions.ts
 * `NativeGeofencePlugin`). Backed by the CheckpointCore pod's
 * @objc(CheckpointGeofence) shim on iOS and the checkpoint-core AAR's
 * com.checkpoint.core.CheckpointGeofence shim on Android, both driven directly
 * through NativeScript runtime marshalling.
 */
export declare const NativeGeofence: import("@geoseal/capacitor/core").NativeGeofencePlugin;

export interface CheckpointFacade {
  /**
   * Initialize the SDK transport. Idempotent — last call wins. INERT on a
   * missing cred (logs, does not throw); check `isConfigured()`. Does NOT touch
   * the native layer — drive `NativeGeofence.configure(...)` separately.
   */
  init(cfg: CheckpointConfig): void;
  /** True once `init()` has configured a transport (creds were all present). */
  isConfigured(): boolean;
  /** Apply a tracking mode to the native layer + return the live state. */
  setTrackingMode(
    mode: import("@geoseal/capacitor/core").TrackingMode
  ): Promise<{ mode: import("@geoseal/capacitor/core").TrackingMode; streaming: boolean }>;
  /** Current native mode + whether a stream is live right now. */
  getTrackingMode(): Promise<{
    mode: import("@geoseal/capacitor/core").TrackingMode;
    streaming: boolean;
  }>;
  /** Server-resolved directive for a subject (org policy + device pref). */
  getTrackingDirective: typeof import("@geoseal/capacitor/core").getTrackingDirective;
  /** Persist a device's tracking-mode preference server-side. */
  setDeviceTrackingMode: typeof import("@geoseal/capacitor/core").setDeviceTrackingMode;
}

/** Layer 2 — the ergonomic facade (transport-injected; never the app's Supabase client). */
export declare const Checkpoint: CheckpointFacade;

/**
 * iOS: forward the host app delegate's location cold-relaunch revive
 * (extraction-plan R2) — call when `UIApplicationLaunchOptionsLocationKey` is in
 * the launch options so an always+streamNow device resumes streaming after a
 * force-quit. No-op on Android (BootReceiver / services handle relaunch natively).
 */
export declare function reviveForBackgroundLaunch(): void;

/**
 * Android: notify the SDK that the app's permission flow completed — call from
 * your Activity's `onRequestPermissionsResult` (or after your own permission
 * UX). The native shim launches the system prompt but cannot observe the grant,
 * so fences added before the "Allow all the time" grant would otherwise never
 * arm for the killed-app wake path; this re-registers persisted fences and
 * re-applies the persisted tracking directive. Idempotent — safe to call any
 * time. No-op on iOS (CLLocationManager keeps pre-grant region registrations
 * and activates them once authorization lands).
 */
export declare function notifyPermissionsChanged(): void;
