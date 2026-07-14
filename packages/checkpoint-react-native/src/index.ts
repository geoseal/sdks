// @geoseal/react-native — public facade.
//
// MIRRORS @geoseal/capacitor (packages/checkpoint-capacitor/src/index.ts). The
// wrapper's job is (a) expose the native API in RN's language and (b) wire
// platform config. It re-implements NO geofence logic — the native cores
// (iOS GeofenceManager, Android Play Services geofencing + foreground services)
// do everything, and the detection engine is server-side.
//
// Two layers, same as Capacitor:
//   Layer 1 — the raw native plugin + frozen contract (NativeGeofence).
//   Layer 2 — the ergonomic `Checkpoint` facade (init/isConfigured +
//             setTrackingMode/getTrackingMode/getTrackingDirective/
//             setDeviceTrackingMode) + the framework-agnostic device REST ops.
//
// The facade is TRANSPORT-INJECTED: `init()` supplies baseUrl/anonKey/
// publishableKey once and every device REST call reads that transport.

// ── Layer 1: raw native plugin ───────────────────────────────────────────────
export { NativeGeofence } from "./plugin";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  RegionEventSubscription,
  NativeDiagnostics,
  NativeFenceDiag,
} from "./definitions";

// ── Device REST hot-path — REAL re-exports of the framework-agnostic core ─────
//
// The device REST hot-path (mintDeviceToken / getTrackingDirective /
// setDeviceTrackingMode / reportTrackingOutages) is FRAMEWORK-AGNOSTIC pure
// TypeScript that lives in @geoseal/capacitor's src/api.ts (the source of
// truth). This wrapper RE-EXPORTS the real implementation rather than forking
// it — keeping the wire contract (3-key directive RPC body, anon-key bearer on
// RPCs, publishable-key bearer on mint) byte-identical to the core.
//
// `@geoseal/capacitor` is a REAL dependency, consumed through its
// '@geoseal/capacitor/core' subpath — the Capacitor-FREE entry (everything
// except plugin.ts/index.ts), so requiring this wrapper never reaches
// @capacitor/core at runtime (that pkg declares it an optional peer). The
// native engine arrives separately via the CheckpointCore pod /
// dev.checkpoint:checkpoint-core AAR (see the podspec + android/build.gradle).
export {
  getTrackingDirective,
  setDeviceTrackingMode,
  mintDeviceToken,
  reportTrackingOutages,
} from "@geoseal/capacitor/core";
export type {
  DeviceToken,
  TrackingDirective,
  TrackingModeSource,
  CheckpointApiError,
  OutageReport,
  OutageReason,
} from "@geoseal/capacitor/core";

// ── Subject public-id codec (mirror of platform _shared/ids.ts) ──────────────
export { encodeSubjectPublicId, decodeSubjectPublicId } from "@geoseal/capacitor/core";
export type { LocationPermission } from "@geoseal/capacitor/core";

// ── Tracking-mode local persistence ──────────────────────────────────────────
export {
  modeKey,
  readStoredMode,
  writeStoredMode,
  readPendingMode,
  writePendingMode,
  clearPendingMode,
} from "@geoseal/capacitor/core";

// ── Framework-agnostic presence core (extracted from useMobilePresence) ──────
export {
  metersBetween,
  fenceSignature,
  zoneFor,
  pullArmedFences,
  fetchNearbyPlaces,
  postSelfFence,
  postJoinPlace,
  ingestFix,
  DEFAULT_DIRECTIVE,
} from "@geoseal/capacitor/core";
export type {
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
  NearbyPlace,
} from "@geoseal/capacitor/core";

// ── Transport (read-only accessors; `Checkpoint.init` below populates it) ────
export { getTransport, peekTransport } from "@geoseal/capacitor/core";
export type { CheckpointTransport } from "@geoseal/capacitor/core";

import { NativeGeofence } from "./plugin";
import type { TrackingMode } from "./definitions";
import {
  configureTransport,
  peekTransport as corePeekTransport,
  getTrackingDirective as coreGetTrackingDirective,
  setDeviceTrackingMode as coreSetDeviceTrackingMode,
} from "@geoseal/capacitor/core";

// The platform `/v1` API version this SDK targets. Surfaced for support triage.
export const CHECKPOINT_API_VERSION = "v1" as const;

export interface CheckpointConfig {
  /** pk_… — the publishable key the SDK ships in the binary. */
  publishableKey: string;
  /**
   * Platform base URL, e.g. https://<project>.supabase.co (no trailing slash).
   * REQUIRED — a published SDK must not bake a platform ref (security scrub).
   */
  baseUrl: string;
  /** Gateway anon key. REQUIRED — no baked default (security scrub). */
  anonKey: string;
  /** Override fetch (tests / non-DOM environments). RN ships a global fetch. */
  fetchImpl?: typeof fetch;
}

// SECURITY: no baked DEFAULT_BASE_URL / DEFAULT_ANON_KEY here. baseUrl + anonKey
// are REQUIRED init params. The core's own index.ts flags baked creds as a footgun
// a published SDK must not ship; this wrapper does not ship them.

/**
 * Initialize the SDK transport. Idempotent — last call wins. Must run before any
 * device REST call. Delegates to @geoseal/capacitor's shared
 * `configureTransport` (the SAME entry `Checkpoint.init` uses in the Capacitor
 * SDK) so the re-exported device REST functions (getTrackingDirective /
 * setDeviceTrackingMode / mintDeviceToken) read the same creds. When a cred is
 * missing it logs and stays INERT (does not throw / does not set a transport) so
 * a misconfigured host doesn't crash at boot; check `isConfigured()`. Does NOT
 * touch the native layer; the app drives `NativeGeofence.configure(...)` with
 * these same creds on the hot path (native keeps its own UserDefaults/
 * SharedPreferences copy so a background relaunch can POST without JS).
 */
export const Checkpoint = {
  init(cfg: CheckpointConfig): void {
    configureTransport({
      publishableKey: cfg.publishableKey,
      baseUrl: cfg.baseUrl,
      anonKey: cfg.anonKey,
      fetchImpl: cfg.fetchImpl,
    });
  },

  /** True once `init()` has configured a transport (creds were all present). */
  isConfigured(): boolean {
    return corePeekTransport() !== null;
  },

  /** Apply a tracking mode to the native layer + return the live state (load-bearing). */
  async setTrackingMode(mode: TrackingMode): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return NativeGeofence.setTrackingMode({ mode });
  },

  /** Current native mode + whether a stream is live right now. */
  async getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return NativeGeofence.getTrackingMode();
  },

  /** Server-resolved directive for a subject (org policy + device pref). */
  getTrackingDirective: coreGetTrackingDirective,

  /** Persist a device's tracking-mode preference server-side. */
  setDeviceTrackingMode: coreSetDeviceTrackingMode,
};
