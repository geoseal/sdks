// @geoseal/capacitor/geofence — the geofence-only entry point.
//
// A STRICT SUBSET of the main barrel: exactly the surface a privacy-first,
// geofence-only integration needs — device-token minting (dtok_only tenants),
// the armed-fence pull + pure geometry helpers, single-shot outage telemetry,
// the subject-id codec, and the raw native plugin.
//
// It DELIBERATELY omits the streaming ingest path (`ingestFix`), the self-serve
// discovery/drop/join calls (`fetchNearbyPlaces` / `postSelfFence` /
// `postJoinPlace`), the tracking-directive RPCs (`getTrackingDirective` /
// `setDeviceTrackingMode`), and local mode storage — those belong to the full
// SDK surface, not a geofence-only embed.
//
// `initGeofence` and `Checkpoint.init` (index.ts) both call the shared
// `configureTransport`, so the two entry points validate + wire the transport
// identically.

import { configureTransport, type CheckpointTransportConfig } from "./transport.js";

/**
 * Configure the geofence transport. Same validation + inert-on-missing-cred
 * behavior as `Checkpoint.init` (both call the shared `configureTransport`).
 * Returns `true` once the transport is live, `false` if a cred was missing.
 */
export function initGeofence(cfg: CheckpointTransportConfig): boolean {
  return configureTransport(cfg);
}

// ── Raw native plugin ────────────────────────────────────────────────────────
// SAME registered proxy as the main barrel: `plugin.ts` is an ESM singleton, so
// importing it here does NOT `registerPlugin` a second time.
export { NativeGeofence } from "./plugin.js";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  NativeDiagnostics,
  NativeFenceDiag,
} from "./definitions.js";

// ── Armed-fence pull + pure geometry helpers (framework-agnostic) ────────────
export {
  pullArmedFences,
  fenceSignature,
  metersBetween,
  zoneFor,
  DEFAULT_DIRECTIVE,
} from "./presence.js";
export type {
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
} from "./presence.js";

// ── Device-token minting (dtok_only tenants) + single-shot outage telemetry ──
export { mintDeviceToken, reportTrackingOutages } from "./api.js";
export type {
  DeviceToken,
  OutageReport,
  OutageReason,
  CheckpointApiError,
} from "./api.js";

// ── Subject public-id codec ──────────────────────────────────────────────────
export { encodeSubjectPublicId, decodeSubjectPublicId } from "./ids.js";
export type { LocationPermission } from "./ids.js";

// ── Transport types (for advanced callers passing an explicit transport) ─────
export type { CheckpointTransport, CheckpointTransportConfig } from "./transport.js";
