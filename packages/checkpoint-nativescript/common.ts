// @geoseal/nativescript — platform-free layer.
//
// The REST device path (mint / directive / ingest / fences / self-*) is NOT
// ported: it is imported from '@geoseal/capacitor/core' (the Capacitor-free
// subpath), so the wire shapes (R6 ingest body, R8 directive RPC keys, mint
// `device_id`) stay single-sourced with the reference SDK. Only the native
// bridge is NativeScript-specific (index.ios.ts / index.android.ts drive the
// relocated @objc / com.checkpoint.core shims via runtime marshalling).

import {
  configureTransport,
  peekTransport,
  getTrackingDirective as apiGetTrackingDirective,
  setDeviceTrackingMode as apiSetDeviceTrackingMode,
} from "@geoseal/capacitor/core";
import type {
  CheckpointTransportConfig,
  NativeDiagnostics,
  NativeGeofencePlugin,
  RegionEvent,
  TrackingMode,
} from "@geoseal/capacitor/core";

// ── Layer-2 REST surface, re-exported verbatim from the reference core ───────
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

// The platform `/v1` API version this SDK targets (informational, support triage).
export const CHECKPOINT_API_VERSION = "v1" as const;

/** Same cred shape as the reference `Checkpoint.init` (structurally identical). */
export type CheckpointConfig = CheckpointTransportConfig;

/**
 * Geofence-only transport bootstrap — the '@geoseal/nativescript/geofence'
 * analog of '@geoseal/capacitor/geofence'. Shares `configureTransport` with
 * `Checkpoint.init`, so validation + inert-on-missing-cred behavior are identical.
 */
export function initGeofence(cfg: CheckpointTransportConfig): boolean {
  return configureTransport(cfg);
}

export interface CheckpointFacade {
  /**
   * Initialize the SDK transport. Idempotent — last call wins. INERT on a
   * missing cred (logs, does not throw, no transport set); check
   * `isConfigured()`. Does NOT touch the native layer — drive
   * `NativeGeofence.configure(...)` with the same creds separately.
   */
  init(cfg: CheckpointConfig): void;
  /** True once `init()` has configured a transport (creds were all present). */
  isConfigured(): boolean;
  /** Apply a tracking mode to the native layer + return the live state. */
  setTrackingMode(mode: TrackingMode): Promise<{ mode: TrackingMode; streaming: boolean }>;
  /** Current native mode + whether a stream is live right now. */
  getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }>;
  /** Server-resolved directive for a subject (org policy + device pref). */
  getTrackingDirective: typeof apiGetTrackingDirective;
  /** Persist a device's tracking-mode preference server-side. */
  setDeviceTrackingMode: typeof apiSetDeviceTrackingMode;
}

/**
 * Build the `Checkpoint` facade over a platform NativeGeofence implementation.
 * A factory (rather than a singleton here) so common.ts stays free of the
 * platform-split native object — each of index.ios.ts / index.android.ts
 * exports `Checkpoint = makeCheckpoint(NativeGeofence)`.
 */
export function makeCheckpoint(
  native: Pick<NativeGeofencePlugin, "setTrackingMode" | "getTrackingMode">
): CheckpointFacade {
  return {
    init(cfg: CheckpointConfig): void {
      configureTransport(cfg);
    },
    isConfigured(): boolean {
      return peekTransport() !== null;
    },
    async setTrackingMode(mode: TrackingMode): Promise<{ mode: TrackingMode; streaming: boolean }> {
      return native.setTrackingMode({ mode });
    },
    async getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }> {
      return native.getTrackingMode();
    },
    getTrackingDirective: apiGetTrackingDirective,
    setDeviceTrackingMode: apiSetDeviceTrackingMode,
  };
}

// ── Marshalling normalizers (shared by both platform bridges) ────────────────

// NSDictionary values reach JS by class-based marshalling, where booleans can
// surface as 0/1 NSNumbers; Android java.util.Map#get is Object-typed, so
// java.lang.Boolean may arrive as a proxy. Coerce at the seam so the TS types
// hold at runtime.
function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const boxed = v as { booleanValue?: () => boolean } | null | undefined;
  if (boxed && typeof boxed.booleanValue === "function") return boxed.booleanValue();
  return !!v && v !== 0;
}

export function normalizeModeState(raw: {
  mode?: unknown;
  streaming?: unknown;
}): { mode: TrackingMode; streaming: boolean } {
  return { mode: String(raw.mode) as TrackingMode, streaming: bool(raw.streaming) };
}

const DIAGNOSTIC_BOOL_FIELDS = [
  "configured",
  "locationServicesEnabled",
  "ignoringBatteryOptimizations",
  "streaming",
  "streamNow",
  "slcMonitoring",
] as const;

export function normalizeDiagnostics(raw: Record<string, unknown>): NativeDiagnostics {
  const out: Record<string, unknown> = { ...raw };
  for (const f of DIAGNOSTIC_BOOL_FIELDS) {
    if (out[f] !== undefined && out[f] !== null) out[f] = bool(out[f]);
  }
  return out as unknown as NativeDiagnostics;
}

export function normalizeRegionEvent(raw: {
  type: unknown;
  regionId: unknown;
  latitude: unknown;
  longitude: unknown;
  accuracy: unknown;
  timestamp: unknown;
}): RegionEvent {
  return {
    type: String(raw.type) as RegionEvent["type"],
    regionId: String(raw.regionId),
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    accuracy: Number(raw.accuracy),
    timestamp: String(raw.timestamp),
  };
}

/** The 4 required configure() strings — reject like the reference natives do. */
export function assertConfigureCreds(options: {
  baseUrl: string;
  anonKey: string;
  publishableKey: string;
  subjectExternalId: string;
}): void {
  if (!options.baseUrl || !options.anonKey || !options.publishableKey || !options.subjectExternalId) {
    throw new Error(
      "NativeGeofence.configure: baseUrl, anonKey, publishableKey, and subjectExternalId are required"
    );
  }
}
