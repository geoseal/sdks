// Cross-wrapper conformance spec (Expo) — the ONE canonical fixture every
// Checkpoint wrapper SDK must satisfy. Expo re-exports @geoseal/react-native
// verbatim, so its API surface MUST be byte-identical to the RN wrapper, which is
// itself mirrored from @geoseal/capacitor's definitions.ts + api.ts. This file
// carries the same canonical constants as the RN copy
// (packages/checkpoint-react-native/test/conformance.spec.ts).
//
// CANONICAL SOURCE: the machine-readable contract lives at
// @geoseal/capacitor/contract/checkpoint-contract.json (generated from that
// package's compile-pinned src/contract.ts). The constants below must equal it;
// CI cross-checks every wrapper fixture against the JSON via
// packages/checkpoint-capacitor/scripts/check-contract-sync.mjs.
//
// VERIFICATION MODEL: `tsc`. A drift in a wire value, field set, or the re-exported
// symbol shapes becomes a COMPILE error here — the types now resolve against the
// REAL @geoseal/react-native dist (the old ambient shim is deleted), so this
// fixture cannot silently pin a stale copy of the contract again. The runtime
// method-name `Object.keys` checks live in the RN copy (the native module is not
// resolvable standalone here); Expo's contribution is proving the re-export
// surface + types stay aligned.

import {
  Checkpoint,
  NativeGeofence,
  getTrackingDirective,
  setDeviceTrackingMode,
  mintDeviceToken,
} from "../src/index";
import type {
  NativeGeofencePlugin,
  RegionEvent,
  NativeDiagnostics,
  TrackingMode,
  TrackingDirective,
  DeviceToken,
  TrackingModeSource,
} from "@geoseal/react-native";

// ── The canonical spec (keep byte-identical across all wrappers) ──────────────

/** Layer-1 raw native plugin method names. */
export const NATIVE_METHODS = [
  "configure",
  "requestAlwaysAuthorization",
  "requestNotificationAuthorization",
  "requestBatteryExemption",
  "openAppSettings",
  "addFence",
  "clearFences",
  "setTrackingMode",
  "getTrackingMode",
  "getDiagnostics",
  "addListener",
] as const;

/** Layer-2 ergonomic facade method names. */
export const FACADE_METHODS = [
  "init",
  "isConfigured",
  "setTrackingMode",
  "getTrackingMode",
  "getTrackingDirective",
  "setDeviceTrackingMode",
] as const;

/** TrackingMode wire values (the exact strings the native cores + /v1 use). */
export const TRACKING_MODE_WIRE = ["geofence", "always", "off"] as const;

/** RegionEvent.type wire values (stray_stream_stopped: regionId "" + last-fix semantics). */
export const REGION_EVENT_TYPES = [
  "enter",
  "exit",
  "update",
  "stray_stream_stopped",
] as const;

/** RegionEvent field set. */
export const REGION_EVENT_FIELDS = [
  "type",
  "regionId",
  "latitude",
  "longitude",
  "accuracy",
  "timestamp",
] as const;

/** NativeDiagnostics field set (required + optional). */
export const NATIVE_DIAGNOSTICS_FIELDS = [
  "authStatus",
  "monitoredCount",
  "monitoredIds",
  "configured",
  "subjectExternalId",
  "baseUrl",
  "fences",
  "armedFenceCount",
  "locationServicesEnabled",
  "ignoringBatteryOptimizations",
  "mode",
  "streaming",
  "lastStreamFixAt",
  "streamNow",
  "slcMonitoring",
  "maxStrayStreamS",
  "lastStrayStreamStopAt",
] as const;

/** configure() option keys (the native bridge accepts all of these). */
export const CONFIGURE_OPTION_KEYS = [
  "baseUrl",
  "anonKey",
  "publishableKey",
  "subjectExternalId",
  "deviceId",
  "trackingMode",
  "streamNow",
  "minIntervalS",
  "maxStrayStreamS",
] as const;

/** The directive RPC body keys — all THREE always sent (R8: never drop one). */
export const DIRECTIVE_RPC_KEYS = ["p_subject", "p_app_id", "p_device_ref"] as const;

// ── Assertions ────────────────────────────────────────────────────────────────

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`conformance: ${label} — expected ${e}, got ${a}`);
}

// 1. The re-exported facade + raw plugin + device REST symbols exist with the
//    canonical shapes (type-level — a missing/renamed export fails tsc here).
const _facade: {
  init: (cfg: { publishableKey: string; baseUrl: string; anonKey: string }) => void;
  isConfigured: () => boolean;
  setTrackingMode: (m: TrackingMode) => Promise<{ mode: TrackingMode; streaming: boolean }>;
  getTrackingMode: () => Promise<{ mode: TrackingMode; streaming: boolean }>;
  getTrackingDirective: typeof getTrackingDirective;
  setDeviceTrackingMode: typeof setDeviceTrackingMode;
} = Checkpoint;
void _facade;

const _plugin: NativeGeofencePlugin = NativeGeofence;
void _plugin;

// Facade method-name parity (runtime shape when executed under a test runner;
// tsc-only today — the RN copy runs the same assertion).
assertEqual(
  Object.keys(Checkpoint).sort(),
  [...FACADE_METHODS].sort(),
  "Checkpoint facade method names"
);

// Device REST re-exports resolve to the api.ts shapes.
const _gd: (subject: string, opts?: { appId?: string; deviceRef?: string }) => Promise<TrackingDirective> =
  getTrackingDirective;
const _sd: (deviceRef: string, mode: TrackingMode, opts?: { source?: TrackingModeSource; appId?: string }) => Promise<void> =
  setDeviceTrackingMode;
const _mint: (input: { deviceRef: string }) => Promise<DeviceToken> = mintDeviceToken;
void _gd;
void _sd;
void _mint;

// 2. TrackingMode wire values.
const _modeCheck: readonly TrackingMode[] = TRACKING_MODE_WIRE;
void _modeCheck;
const _allModes: TrackingMode[] = ["geofence", "always", "off"];
assertEqual(_allModes, [...TRACKING_MODE_WIRE], "TrackingMode wire values");

// 2b. RegionEvent.type wire values — two-way type pin: every fixture value is a
//     member of the union, and every union member appears in the fixture (a
//     union member missing from REGION_EVENT_TYPES breaks the second line).
const _eventTypeCheck: readonly RegionEvent["type"][] = REGION_EVENT_TYPES;
void _eventTypeCheck;
const _allEventTypes: readonly (typeof REGION_EVENT_TYPES)[number][] =
  [] as RegionEvent["type"][];
void _allEventTypes;
assertEqual(
  [...REGION_EVENT_TYPES],
  ["enter", "exit", "update", "stray_stream_stopped"],
  "RegionEvent.type wire values"
);

// 2c. configure() options — the object literal below must have exactly the
//     canonical keys and typecheck against the frozen contract, or tsc errors.
type ConfigureOptions = Parameters<NativeGeofencePlugin["configure"]>[0];
const _configure: Required<ConfigureOptions> = {
  baseUrl: "https://example.test",
  anonKey: "anon",
  publishableKey: "pk_test",
  subjectExternalId: "nurse-1",
  deviceId: "device-1",
  trackingMode: "geofence",
  streamNow: false,
  minIntervalS: 60,
  maxStrayStreamS: 600,
};
assertEqual(
  Object.keys(_configure).sort(),
  [...CONFIGURE_OPTION_KEYS].sort(),
  "configure() option keys"
);

// 3. RegionEvent / NativeDiagnostics field sets — enforced at the TYPE level: the
//    object literals below must have exactly the canonical fields, or tsc errors.
const _regionEvent: RegionEvent = {
  type: "enter",
  regionId: "fence-1",
  latitude: 0,
  longitude: 0,
  accuracy: -1,
  timestamp: "1970-01-01T00:00:00Z",
};
assertEqual(Object.keys(_regionEvent).sort(), [...REGION_EVENT_FIELDS].sort(), "RegionEvent fields");

const _diag: Required<NativeDiagnostics> = {
  authStatus: "authorizedAlways",
  monitoredCount: 0,
  monitoredIds: [],
  configured: true,
  subjectExternalId: "nurse-1",
  baseUrl: "https://example.test",
  fences: [],
  armedFenceCount: 0,
  locationServicesEnabled: true,
  ignoringBatteryOptimizations: true,
  mode: "geofence",
  streaming: false,
  lastStreamFixAt: null,
  streamNow: false,
  slcMonitoring: false,
  maxStrayStreamS: 600,
  lastStrayStreamStopAt: null,
};
assertEqual(
  Object.keys(_diag).sort(),
  [...NATIVE_DIAGNOSTICS_FIELDS].sort(),
  "NativeDiagnostics fields"
);

// TrackingDirective is the api.ts snake_case shape (NOT a drifted camelCase one).
const _directive: TrackingDirective = {
  effective_mode: "geofence",
  stream_now: false,
  active_window: null,
  min_interval_s: 15,
};
assertEqual(
  Object.keys(_directive).sort(),
  ["active_window", "effective_mode", "min_interval_s", "stream_now"],
  "TrackingDirective fields (api.ts snake_case)"
);

// 4. Directive RPC body keys.
assertEqual(
  [...DIRECTIVE_RPC_KEYS].sort(),
  ["p_app_id", "p_device_ref", "p_subject"],
  "directive RPC body keys"
);
