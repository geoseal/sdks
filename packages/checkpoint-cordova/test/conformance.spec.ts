// Cross-wrapper conformance spec — the ONE canonical fixture every Checkpoint
// wrapper SDK (Capacitor / React Native / Expo / Flutter / MAUI / Cordova) must
// satisfy. This copy is synced to the CURRENT reference contract in
// @geoseal/capacitor's definitions.ts + index.ts (post #65/#68: isConfigured,
// the 4-value RegionEvent union, and the stray-stream / armed-fence diagnostics
// fields).
//
// VERIFICATION MODEL: verified two ways.
//   1. `tsc` (type-level + const assertions) via `npm run typecheck:test` — a
//      drift in a method name, wire value, or field set becomes a COMPILE error
//      here. Unlike the hand-mirroring wrappers, this package imports its types
//      straight from '@geoseal/capacitor/core', so the type-level checks pin
//      this fixture against the reference itself.
//   2. `npm test` (test/run-conformance.mjs) executes this file under Node with
//      cordova/exec stubbed, which also asserts the constants below against the
//      CANONICAL machine-readable contract:
//      @geoseal/capacitor/contract/checkpoint-contract.json (single source of
//      truth for every wrapper fixture; see also scripts/check-contract-sync.mjs
//      in that package, which CI runs across all wrappers).

import { NativeGeofence } from "../src/native";
import { Checkpoint } from "../src/index";
import contract from "@geoseal/capacitor/contract/checkpoint-contract.json";
import type {
  NativeGeofencePlugin,
  RegionEvent,
  NativeDiagnostics,
  TrackingMode,
} from "@geoseal/capacitor/core";

// ── The canonical spec (keep byte-identical across all wrappers) ─────────────

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

/** RegionEvent `type` wire values (stray_stream_stopped: regionId "" + last off-site fix). */
export const REGION_EVENT_TYPES = ["enter", "exit", "update", "stray_stream_stopped"] as const;

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

// 3b. RegionEvent type union — 4 wire values, pinned both directions.
const _eventTypeCheck: readonly RegionEvent["type"][] = REGION_EVENT_TYPES;
void _eventTypeCheck;
const _allEventTypes: RegionEvent["type"][] = ["enter", "exit", "update", "stray_stream_stopped"];
assertEqual(_allEventTypes, [...REGION_EVENT_TYPES], "RegionEvent type wire values");

// 4. RegionEvent / NativeDiagnostics field sets — enforced at the TYPE level: the
//    object literals below must have exactly the canonical fields, or tsc errors.
const _regionEvent: RegionEvent = {
  type: "stray_stream_stopped",
  regionId: "",
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

// 5b. configure() accepts the full option set incl. maxStrayStreamS (compile-time).
const _configureOptions: Parameters<NativeGeofencePlugin["configure"]>[0] = {
  baseUrl: "https://example.test",
  anonKey: "anon",
  publishableKey: "pk_test",
  subjectExternalId: "nurse-1",
  deviceId: "cordova-nurse-1",
  trackingMode: "geofence",
  streamNow: false,
  minIntervalS: 15,
  maxStrayStreamS: 600,
};
void _configureOptions;

// 6. Directive RPC body — the 3 keys are asserted in the wire tests of each wrapper
//    that can spy on the HTTP body. This package BUNDLES @geoseal/capacitor/core
//    (api.ts), whose own tests assert the body; here we pin the canonical key set as
//    data so every wrapper's copy stays identical.
assertEqual(
  [...DIRECTIVE_RPC_KEYS].sort(),
  ["p_app_id", "p_device_ref", "p_subject"],
  "directive RPC body keys"
);

// 7. Canonical-JSON parity — this fixture's constants must equal the canonical
//    machine-readable contract shipped by @geoseal/capacitor. Runs when the
//    spec is EXECUTED (npm test); tsc alone cannot see JSON content.
assertEqual<string[]>([...NATIVE_METHODS], contract.nativeMethods, "canonical JSON: nativeMethods");
assertEqual<string[]>([...FACADE_METHODS], contract.facadeMethods, "canonical JSON: facadeMethods");
assertEqual<string[]>([...TRACKING_MODE_WIRE], contract.trackingModeWire, "canonical JSON: trackingModeWire");
assertEqual<string[]>([...REGION_EVENT_TYPES], contract.regionEventTypes, "canonical JSON: regionEventTypes");
assertEqual<string[]>([...REGION_EVENT_FIELDS], contract.regionEventFields, "canonical JSON: regionEventFields");
assertEqual<string[]>(
  [...NATIVE_DIAGNOSTICS_FIELDS],
  contract.nativeDiagnosticsFields,
  "canonical JSON: nativeDiagnosticsFields"
);
assertEqual<string[]>([...DIRECTIVE_RPC_KEYS], contract.directiveRpcKeys, "canonical JSON: directiveRpcKeys");
