// @geoseal/react-native/geofence — the geofence-only entry point.
//
// MIRRORS '@geoseal/capacitor/geofence' (packages/checkpoint-capacitor/
// src/geofence.ts): a STRICT SUBSET of the main barrel — exactly the surface a
// privacy-first, geofence-only integration needs. Device-token minting
// (dtok_only tenants), the armed-fence pull + pure geometry helpers,
// single-shot outage telemetry, the subject-id codec, and the raw native
// plugin.
//
// It DELIBERATELY omits the streaming ingest path (`ingestFix`), the
// self-serve discovery/drop/join calls (`fetchNearbyPlaces` / `postSelfFence`
// / `postJoinPlace`), the tracking-directive RPCs (`getTrackingDirective` /
// `setDeviceTrackingMode`), and local mode storage — those belong to the full
// SDK surface, not a geofence-only embed.
//
// `initGeofence` and `Checkpoint.init` (index.ts) both call the core's shared
// `configureTransport`, so the two entry points validate + wire the transport
// identically.

import {
  configureTransport,
  type CheckpointTransportConfig,
} from "@geoseal/capacitor/core";

/**
 * Configure the geofence transport. Same validation + inert-on-missing-cred
 * behavior as `Checkpoint.init` (both call the shared `configureTransport`).
 * Returns `true` once the transport is live, `false` if a cred was missing.
 */
export function initGeofence(cfg: CheckpointTransportConfig): boolean {
  return configureTransport(cfg);
}

// ── Raw native plugin ────────────────────────────────────────────────────────
// SAME module proxy as the main barrel: `plugin.ts` resolves the one native
// module ("CheckpointGeofence"), so importing it here shares that instance.
export { NativeGeofence } from "./plugin";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  RegionEventSubscription,
  NativeDiagnostics,
  NativeFenceDiag,
} from "./definitions";

// ── Armed-fence pull + pure geometry helpers (framework-agnostic) ────────────
export {
  pullArmedFences,
  fenceSignature,
  metersBetween,
  zoneFor,
  DEFAULT_DIRECTIVE,
} from "@geoseal/capacitor/core";
export type {
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
} from "@geoseal/capacitor/core";

// ── Device-token minting (dtok_only tenants) + single-shot outage telemetry ──
export { mintDeviceToken, reportTrackingOutages } from "@geoseal/capacitor/core";
export type {
  DeviceToken,
  OutageReport,
  OutageReason,
  CheckpointApiError,
} from "@geoseal/capacitor/core";

// ── Subject public-id codec ──────────────────────────────────────────────────
export { encodeSubjectPublicId, decodeSubjectPublicId } from "@geoseal/capacitor/core";
export type { LocationPermission } from "@geoseal/capacitor/core";

// ── Transport types (for advanced callers passing an explicit transport) ─────
export type { CheckpointTransport, CheckpointTransportConfig } from "@geoseal/capacitor/core";
