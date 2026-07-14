// @geoseal/cordova — public facade. Mirror of @geoseal/capacitor's
// index.ts, with Layer 1 bridged over cordova.exec instead of registerPlugin.
//
// Two layers (plan §2b):
//   Layer 1 — the raw native plugin + frozen contract (power users reach native
//             directly): ./native.ts over cordova.exec.
//   Layer 2 — the ergonomic `Checkpoint` facade + the framework-agnostic device
//             REST/presence primitives, imported (NOT hand-mirrored) from
//             '@geoseal/capacitor/core' — the Capacitor-free JS subpath — and
//             inlined into www/checkpoint.js by the esbuild `bundle` script so
//             the shipped Cordova module is single-sourced and self-contained.
//
// The facade is TRANSPORT-INJECTED: `init()` supplies baseUrl/anonKey/
// publishableKey once, and every device call (mint / directive / ingest /
// fences / self-*) reads that transport — the SDK never depends on the app's
// Supabase session client.

// ── Layer 1: raw native plugin ───────────────────────────────────────────────
export { NativeGeofence } from "./native";
export type {
  NativeGeofencePlugin,
  TrackingMode,
  RegionEvent,
  NativeDiagnostics,
  NativeFenceDiag,
  PluginListenerHandle,
} from "@geoseal/capacitor/core";

// ── Device REST hot-path (transport-injected; plan §2b / §1c.1) ──────────────
export {
  mintDeviceToken,
  getTrackingDirective,
  setDeviceTrackingMode,
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

// ── Framework-agnostic presence core ─────────────────────────────────────────
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

// ── Transport ────────────────────────────────────────────────────────────────
export { getTransport, peekTransport } from "@geoseal/capacitor/core";
export type { CheckpointTransport } from "@geoseal/capacitor/core";

import {
  configureTransport,
  peekTransport,
  getTrackingDirective as apiGetTrackingDirective,
  setDeviceTrackingMode as apiSetDeviceTrackingMode,
} from "@geoseal/capacitor/core";
import type { TrackingMode } from "@geoseal/capacitor/core";
import { NativeGeofence } from "./native";

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
