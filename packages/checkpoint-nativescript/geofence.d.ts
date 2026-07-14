// '@geoseal/nativescript/geofence' — public typings for the geofence-only
// entry point (strict subset of the main barrel; mirrors
// '@geoseal/capacitor/geofence'). Runtime is geofence.ios.js /
// geofence.android.js, resolved per platform by the NativeScript webpack build.

/**
 * Configure the geofence transport. Same validation + inert-on-missing-cred
 * behavior as `Checkpoint.init` (both call the shared `configureTransport`).
 * Returns `true` once the transport is live, `false` if a cred was missing.
 */
export declare function initGeofence(
  cfg: import("@geoseal/capacitor/core").CheckpointTransportConfig
): boolean;

/** The raw native plugin — same instance as the main barrel's export. */
export declare const NativeGeofence: import("@geoseal/capacitor/core").NativeGeofencePlugin;

export {
  pullArmedFences,
  fenceSignature,
  metersBetween,
  zoneFor,
  DEFAULT_DIRECTIVE,
  mintDeviceToken,
  reportTrackingOutages,
  encodeSubjectPublicId,
  decodeSubjectPublicId,
} from "@geoseal/capacitor/core";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  NativeDiagnostics,
  NativeFenceDiag,
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
  DeviceToken,
  OutageReport,
  OutageReason,
  CheckpointApiError,
  LocationPermission,
  CheckpointTransport,
  CheckpointTransportConfig,
} from "@geoseal/capacitor/core";
