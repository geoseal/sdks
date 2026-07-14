// @geoseal/capacitor — public facade.
//
// Two layers (plan §2b):
//   Layer 1 — the raw native plugin + frozen contract (power users / wrapper SDKs
//             reach native directly).
//   Layer 2 — the ergonomic `Checkpoint` facade + the framework-agnostic device
//             hot-path primitives the app composes its React hook from.
//
// The facade is TRANSPORT-INJECTED: `init()` supplies baseUrl/anonKey/publishableKey
// once, and every device call (mint / directive / ingest / fences / self-*) reads
// that transport — the SDK never depends on the app's Supabase session client.

// ── Layer 1: raw native plugin ───────────────────────────────────────────────
export { NativeGeofence } from "./plugin.js";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  NativeDiagnostics,
  NativeFenceDiag,
} from "./definitions.js";

// ── Device REST hot-path (transport-injected; plan §2b / §1c.1) ──────────────
export {
  mintDeviceToken,
  getTrackingDirective,
  setDeviceTrackingMode,
  reportTrackingOutages,
} from "./api.js";
export type {
  DeviceToken,
  TrackingDirective,
  TrackingModeSource,
  CheckpointApiError,
  OutageReport,
  OutageReason,
} from "./api.js";

// ── Subject public-id codec (mirror of platform _shared/ids.ts) ──────────────
export { encodeSubjectPublicId, decodeSubjectPublicId } from "./ids.js";
export type { LocationPermission } from "./ids.js";

// ── Tracking-mode local persistence ──────────────────────────────────────────
export {
  modeKey,
  readStoredMode,
  writeStoredMode,
  readPendingMode,
  writePendingMode,
  clearPendingMode,
} from "./modeStorage.js";

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
} from "./presence.js";
export type {
  PresenceZone,
  LastFix,
  SdkFence,
  SdkTrackingDirective,
  FencePullResult,
  NearbyPlace,
} from "./presence.js";

// ── Transport ────────────────────────────────────────────────────────────────
export { getTransport, peekTransport } from "./transport.js";
export type { CheckpointTransport } from "./transport.js";

import { configureTransport, peekTransport } from "./transport.js";
import { NativeGeofence } from "./plugin.js";
import {
  getTrackingDirective as apiGetTrackingDirective,
  setDeviceTrackingMode as apiSetDeviceTrackingMode,
} from "./api.js";
import type { TrackingMode } from "./definitions.js";

// The platform `/v1` API version this SDK targets. Surfaced for support triage
// (plan §4). The platform tolerates older callers; this is informational.
export const CHECKPOINT_API_VERSION = "v1" as const;

export interface CheckpointConfig {
  /** pk_… — the publishable key the SDK ships in the binary. */
  publishableKey: string;
  /** Your platform base URL, e.g. https://<project-ref>.supabase.co (no trailing slash). Required. */
  baseUrl: string;
  /** Your platform gateway anon key (public-safe). Required. */
  anonKey: string;
  /** Override fetch (tests / non-DOM wrappers). */
  fetchImpl?: typeof fetch;
}

/**
 * Initialize the SDK transport. Idempotent — last call wins. Must run before any
 * device call (mint / directive / ingest / fences). Does NOT touch the native
 * layer; the app drives `NativeGeofence.configure(...)` with these same creds on
 * the hot path (the native side keeps its own UserDefaults/SharedPreferences copy
 * so a background relaunch can POST without JS).
 *
 * `baseUrl`, `anonKey`, and `publishableKey` are all required: a redistributable
 * SDK must point at the CONSUMER's own platform, not a baked-in project. When a
 * cred is missing this logs and stays INERT (does not throw / does not set a
 * transport) so a misconfigured host doesn't crash at boot; every device call
 * then soft-fails. Check `isConfigured()` to confirm the transport is live.
 */
export const Checkpoint = {
  init(cfg: CheckpointConfig): void {
    configureTransport(cfg);
  },

  /** True once `init()` has configured a transport (creds were all present). */
  isConfigured(): boolean {
    return peekTransport() !== null;
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
  getTrackingDirective: apiGetTrackingDirective,

  /** Persist a device's tracking-mode preference server-side. */
  setDeviceTrackingMode: apiSetDeviceTrackingMode,
};
