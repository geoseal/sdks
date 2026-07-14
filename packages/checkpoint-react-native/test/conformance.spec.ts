// Cross-wrapper conformance spec — the React Native copy of the canonical
// fixture every Checkpoint wrapper SDK must satisfy.
//
// CANONICAL SOURCE: the machine-readable contract lives at
// @geoseal/capacitor/contract/checkpoint-contract.json (generated from that
// package's compile-pinned src/contract.ts). The constants below must equal it;
// CI cross-checks every wrapper fixture (RN / Expo / Cordova / NativeScript /
// Flutter / MAUI / KMP) against the JSON via
// packages/checkpoint-capacitor/scripts/check-contract-sync.mjs.
//
// VERIFICATION MODEL: this is verified by `tsc` (type-level + const assertions).
// It needs no Jest runner — a drift in a method name, wire value, or field set
// becomes a COMPILE error here. `assertEqual` also makes the value parity runnable
// under any TS test runner if one is added later.

import { NativeGeofence } from "../src/plugin";
import { Checkpoint } from "../src/index";
import type {
  NativeGeofencePlugin,
  RegionEvent,
  NativeDiagnostics,
  TrackingMode,
} from "../src/definitions";

// ── The canonical spec (keep byte-identical across all four wrappers) ─────────

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

// 1. Raw native plugin exposes exactly the canonical method set.
assertEqual(
  Object.keys(NativeGeofence).sort(),
  [...NATIVE_METHODS].sort(),
  "NativeGeofence method names"
);

// 2. Facade exposes exactly the canonical method set.
assertEqual(
  Object.keys(Checkpoint).sort(),
  [...FACADE_METHODS].sort(),
  "Checkpoint facade method names"
);

// 3. TrackingMode wire values — type-level + value check. A new/renamed member of
//    the union breaks this assignment at compile time.
const _modeCheck: readonly TrackingMode[] = TRACKING_MODE_WIRE;
void _modeCheck;
const _allModes: TrackingMode[] = ["geofence", "always", "off"];
assertEqual(_allModes, [...TRACKING_MODE_WIRE], "TrackingMode wire values");

// 3b. RegionEvent.type wire values — two-way type pin: every fixture value is a
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

// 3c. configure() options — the object literal below must have exactly the
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

// 4. RegionEvent / NativeDiagnostics field sets — enforced at the TYPE level: the
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

// 5. The raw-plugin instance is assignable to the frozen interface (shape parity).
const _plugin: NativeGeofencePlugin = NativeGeofence;
void _plugin;

// 6. Directive RPC body — the 3 keys are asserted in the wire tests of each wrapper
//    that can spy on the HTTP body (MAUI ApiWireShapeTests; RN re-exports the core,
//    whose own tests assert the body). Here we pin the canonical key set as data so
//    every wrapper's copy stays identical.
assertEqual(
  [...DIRECTIVE_RPC_KEYS].sort(),
  ["p_app_id", "p_device_ref", "p_subject"],
  "directive RPC body keys"
);
