// Cross-wrapper conformance spec — the canonical fixture every Checkpoint
// wrapper SDK must satisfy, synced from the CURRENT reference
// (packages/checkpoint-capacitor/src/definitions.ts + index.ts, post-#65/#68:
// maxStrayStreamS, stray_stream_stopped, isConfigured, 4 new diagnostics fields).
//
// CANONICAL SOURCE: the machine-readable contract lives at
// @geoseal/capacitor/contract/checkpoint-contract.json (generated from that
// package's compile-pinned src/contract.ts). The constants below must equal it;
// CI cross-checks every wrapper fixture against the JSON via
// packages/checkpoint-capacitor/scripts/check-contract-sync.mjs.
//
// VERIFICATION MODEL: two layers.
//   1. tsc — type-level: both platform implementations must satisfy the public
//      index.d.ts surface and the frozen NativeGeofencePlugin interface (which
//      this package imports from @geoseal/capacitor/core rather than
//      hand-mirroring, so definitions drift is a COMPILE error).
//   2. `node test/conformance.spec.js` — value-level: runs the assertions below
//      against the iOS implementation + facade (their module load touches no
//      native API). The Android implementation imports @nativescript/core at
//      module load, so off-device it is asserted at the TYPE level only (and
//      for real by `ns build android`).

import type { NativeDiagnostics, RegionEvent, TrackingMode } from "@geoseal/capacitor/core";
import { NativeGeofence, Checkpoint, CHECKPOINT_API_VERSION } from "../index.ios.js";
import { normalizeDiagnostics, normalizeRegionEvent } from "../common.js";
import * as geofenceEntry from "../geofence.ios.js";

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

/** RegionEvent type wire values (4-value union; stray_stream_stopped has regionId "" + last-fix coords). */
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

// ── Type-level assertions (enforced by tsc, no runtime needed) ────────────────

// Both platform implementations satisfy the public surface declared in index.d.ts
// (extra runtime-only exports are allowed; missing/mistyped ones are not) — the
// hand-authored d.ts cannot drift from either implementation. Pure type-level
// (conditional types), so nothing here emits runtime references.
type Satisfies<Impl extends Surface, Surface> = Impl extends Surface ? true : never;
const _iosSatisfiesPublicApi: Satisfies<
  typeof import("../index.ios"),
  typeof import("../index")
> = true;
const _androidSatisfiesPublicApi: Satisfies<
  typeof import("../index.android"),
  typeof import("../index")
> = true;
const _geofenceIosSatisfies: Satisfies<
  typeof import("../geofence.ios"),
  typeof import("../geofence")
> = true;
const _geofenceAndroidSatisfies: Satisfies<
  typeof import("../geofence.android"),
  typeof import("../geofence")
> = true;
void _iosSatisfiesPublicApi;
void _androidSatisfiesPublicApi;
void _geofenceIosSatisfies;
void _geofenceAndroidSatisfies;

// TrackingMode / RegionEvent.type wire unions — a new/renamed member breaks these
// assignments in BOTH directions at compile time.
const _modeCheck: readonly TrackingMode[] = TRACKING_MODE_WIRE;
void _modeCheck;
const _allModesCovered: TrackingMode extends (typeof TRACKING_MODE_WIRE)[number] ? true : never = true;
void _allModesCovered;
const _eventTypeCheck: readonly RegionEvent["type"][] = REGION_EVENT_TYPES;
void _eventTypeCheck;
const _allEventTypesCovered: RegionEvent["type"] extends (typeof REGION_EVENT_TYPES)[number]
  ? true
  : never = true;
void _allEventTypesCovered;

// Field sets — the literals below must have exactly the canonical fields.
const _regionEvent: RegionEvent = {
  type: "stray_stream_stopped",
  regionId: "",
  latitude: 0,
  longitude: 0,
  accuracy: -1,
  timestamp: "1970-01-01T00:00:00Z",
};

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

// ── Value-level assertions (node test/conformance.spec.js) ───────────────────

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

// 2. Facade exposes exactly the canonical method set (incl. isConfigured).
assertEqual(Object.keys(Checkpoint).sort(), [...FACADE_METHODS].sort(), "Checkpoint facade method names");

// 3. Wire values as data.
assertEqual([...TRACKING_MODE_WIRE], ["geofence", "always", "off"], "TrackingMode wire values");
assertEqual(
  [...REGION_EVENT_TYPES],
  ["enter", "exit", "update", "stray_stream_stopped"],
  "RegionEvent type wire values"
);
assertEqual(
  [...DIRECTIVE_RPC_KEYS].sort(),
  ["p_app_id", "p_device_ref", "p_subject"],
  "directive RPC body keys"
);
assertEqual(Object.keys(_regionEvent).sort(), [...REGION_EVENT_FIELDS].sort(), "RegionEvent fields");
assertEqual(
  Object.keys(_diag).sort(),
  [...NATIVE_DIAGNOSTICS_FIELDS].sort(),
  "NativeDiagnostics fields"
);

// 4. Inert-init parity: missing cred ⇒ logs + stays unconfigured; full creds ⇒ live.
assertEqual(Checkpoint.isConfigured(), false, "isConfigured before init");
Checkpoint.init({ publishableKey: "", baseUrl: "", anonKey: "" });
assertEqual(Checkpoint.isConfigured(), false, "isConfigured after inert init (missing creds)");
Checkpoint.init({
  publishableKey: "pk_test",
  baseUrl: "https://example.supabase.co",
  anonKey: "anon",
});
assertEqual(Checkpoint.isConfigured(), true, "isConfigured after full-cred init");
assertEqual(CHECKPOINT_API_VERSION, "v1", "CHECKPOINT_API_VERSION");

// 5. Geofence-only entry point is the strict subset (mirrors '@geoseal/capacitor/geofence').
assertEqual(
  Object.keys(geofenceEntry).sort(),
  [
    "DEFAULT_DIRECTIVE",
    "NativeGeofence",
    "decodeSubjectPublicId",
    "encodeSubjectPublicId",
    "fenceSignature",
    "initGeofence",
    "metersBetween",
    "mintDeviceToken",
    "pullArmedFences",
    "reportTrackingOutages",
    "zoneFor",
  ],
  "geofence entry export set"
);
assertEqual(geofenceEntry.NativeGeofence === NativeGeofence, true, "geofence entry shares the plugin instance");

// 6. Marshalling normalizers coerce boxed booleans/numbers at the native seam.
const normalized = normalizeDiagnostics({
  configured: 1,
  streaming: { booleanValue: () => true },
  monitoredCount: 2,
});
assertEqual(normalized.configured, true, "normalizeDiagnostics coerces 0/1 booleans");
assertEqual(normalized.streaming, true, "normalizeDiagnostics coerces boxed java.lang.Boolean");
assertEqual(normalized.monitoredCount, 2, "normalizeDiagnostics passes numbers through");
const evt = normalizeRegionEvent({
  type: "exit",
  regionId: "fence-1",
  latitude: "40.1",
  longitude: "-111.6",
  accuracy: "12",
  timestamp: "2026-01-01T00:00:00Z",
});
assertEqual(evt.latitude, 40.1, "normalizeRegionEvent coerces coordinates to numbers");
assertEqual(evt.type, "exit", "normalizeRegionEvent keeps wire type");

console.log("conformance: all assertions passed");
