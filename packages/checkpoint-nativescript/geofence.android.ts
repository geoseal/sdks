// '@geoseal/nativescript/geofence' — geofence-only entry point (Android).
//
// STRICT SUBSET mirroring '@geoseal/capacitor/geofence': device-token minting,
// the armed-fence pull + pure geometry helpers, single-shot outage telemetry, the
// subject-id codec, and the raw native plugin. Deliberately OMITS the streaming
// ingest, self-serve calls, directive RPCs, and mode storage.

export { initGeofence } from "./common.js";
export { NativeGeofence } from "./index.android.js";
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
