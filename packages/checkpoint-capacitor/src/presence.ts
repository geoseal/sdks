// Framework-agnostic device hot-path core, extracted from the app's
// `useMobilePresence` hook (plan §2c). NO React here — the app (or the optional
// `@geoseal/capacitor/react` hook) supplies the state plumbing and calls these.
//
// Every function takes the injected transport (baseUrl/anonKey/publishableKey)
// instead of the module-level PLATFORM_* constants the hook used to bake in
// (plan §1c.2). The build-7 transient-empty-pull guard (R1/R6) and the /v1/ingest
// body shape (R6) are preserved verbatim — do not reshape on the move.

import { peekTransport, transportFetch, type CheckpointTransport } from "./transport.js";
import type { TrackingMode } from "./definitions.js";

export type PresenceZone = "AT PLACE" | "IN PERIMETER" | "OUTSIDE";

export interface LastFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
}

export interface SdkFence {
  place_id: string;
  name: string | null;
  geofence_ref: string | null;
  center: { latitude: number; longitude: number };
  /** Perimeter (outer) radius — the native CLCircularRegion the device registers. */
  radius_m: number;
  /** Interior (inner) radius — the "AT PLACE" zone, confirmed server-side by M-of-N
   *  (NOT a native region). Carried for the on-device display ring; may be null if
   *  the place has no distinct interior. */
  interior_radius_m: number | null;
  /** Additive: custom interior shape (GeoJSON Polygon, lng/lat ring) for
   *  polygon-fence places. Null/absent = circular interior. Display-only on
   *  device — the native region stays the covering circle (radius_m). */
  boundary?: { type: "Polygon"; coordinates: number[][][] } | null;
}

// The server tracking directive (tracking-modes §3) rides in the v1-sdk-fences
// response, so the device gets fences + the mode/stream gate in one round-trip.
export interface SdkTrackingDirective {
  effective_mode: TrackingMode;
  stream_now: boolean;
  active_window: { starts_at: string | null; ends_at: string | null } | null;
  min_interval_s: number;
}

export const DEFAULT_DIRECTIVE: SdkTrackingDirective = {
  effective_mode: "geofence",
  stream_now: false,
  active_window: null,
  min_interval_s: 15,
};

// Result of an armed-fence pull. `disarm` distinguishes an AUTHORITATIVE 200-with-[]
// (honor it) from a transient failure (keep the registered set) — the build-7 guard.
export interface FencePullResult {
  /** false when the pull failed transiently (non-OK) — caller keeps its armed set. */
  ok: boolean;
  regions: SdkFence[];
  directive: SdkTrackingDirective;
}

export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Stable signature of an armed set: id + rounded center + radius. Re-registering
// the native regions is only worth doing when this changes (re-registering resets
// the OS "already inside" state, so we avoid churning it on every resync).
export function fenceSignature(regions: SdkFence[]): string {
  return regions
    .map((r) => `${r.geofence_ref ?? r.place_id}@${r.center.latitude.toFixed(5)},${r.center.longitude.toFixed(5)}~${r.radius_m ?? 150}`)
    .join("|");
}

// Compute the live zone banner against the nearest armed fence (mirror of the
// hook's inline calc). Returns OUTSIDE when there is no fence.
export function zoneFor(fix: LastFix, fence: SdkFence | null): PresenceZone {
  if (!fence) return "OUTSIDE";
  const d = metersBetween(fix.lat, fix.lng, fence.center.latitude, fence.center.longitude);
  return d <= 50 ? "AT PLACE" : d <= (fence.radius_m ?? 150) ? "IN PERIMETER" : "OUTSIDE";
}

// Pull the armed fence set + tracking directive from the platform.
//
// THE BUILD-7 GUARD (plan R1/R6 — preserve exactly): a non-OK status (pre-auth
// 401, 5xx, …) returns an error body whose empty regions look identical to a
// genuine disarm — clearing on it would silently unarm the device. We return
// { ok: false } so the caller keeps its registered set and retries next sync.
// Only a 200 with [] is an AUTHORITATIVE disarm the caller honors.
export async function pullArmedFences(
  subjectPublicId: string,
  transport?: CheckpointTransport,
): Promise<FencePullResult> {
  const t = transport ?? peekTransport();
  if (!t) return { ok: false, regions: [], directive: DEFAULT_DIRECTIVE };
  const f = transportFetch(t);
  try {
    const res = await f(
      `${t.baseUrl}/functions/v1/v1-sdk-fences/sdk/fences?subject_id=${encodeURIComponent(subjectPublicId)}`,
      { headers: { apikey: t.anonKey, Authorization: `Bearer ${t.publishableKey}` } },
    );
    if (!res.ok) {
      console.warn(`[checkpoint/presence] sdk-fences pull failed (${res.status}) — keeping armed set`);
      return { ok: false, regions: [], directive: DEFAULT_DIRECTIVE };
    }
    const json = await res.json();
    const regions: SdkFence[] = (json?.regions ?? []) as SdkFence[];
    const directive: SdkTrackingDirective = {
      ...DEFAULT_DIRECTIVE,
      ...((json?.tracking ?? {}) as Partial<SdkTrackingDirective>),
    };
    return { ok: true, regions, directive };
  } catch {
    // network/parse error — treat as transient; keep the previously armed set.
    return { ok: false, regions: [], directive: DEFAULT_DIRECTIVE };
  }
}

// A known tenant place the device is NOT yet armed to (GET /v1/self/nearby).
export interface NearbyPlace {
  placeId: string; // place_<hex>
  name: string;
  lat: number;
  lng: number;
  interiorM: number | null;
  perimeterM: number | null;
  distanceM: number;
  withinOuter: boolean;
}

// Self-serve discovery: known active places near the fix that are NOT already
// armed for this subject. AUTH: uses the hard-bound device token (dtok_) so the
// "not already armed for ME" filter is keyed on the server-resolved subject.
export async function fetchNearbyPlaces(
  deviceToken: string,
  fix: LastFix,
  transport?: CheckpointTransport,
): Promise<NearbyPlace[]> {
  const t = transport ?? peekTransport();
  if (!t) return [];
  const f = transportFetch(t);
  try {
    const res = await f(
      `${t.baseUrl}/functions/v1/v1-self-join/self/nearby?lat=${encodeURIComponent(fix.lat)}&lng=${encodeURIComponent(fix.lng)}`,
      { headers: { apikey: t.anonKey, Authorization: `Bearer ${deviceToken}` } },
    );
    if (!res.ok) return [];
    const json = await res.json();
    const rows = (json?.places ?? []) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      placeId: String(r.place_id),
      name: (r.name as string) ?? "this location",
      lat: (r.center as { latitude: number })?.latitude,
      lng: (r.center as { longitude: number })?.longitude,
      interiorM: (r.interior_radius_m as number) ?? null,
      perimeterM: (r.perimeter_radius_m as number) ?? null,
      distanceM: (r.distance_m as number) ?? 0,
      withinOuter: r.within_outer === true,
    }));
  } catch {
    return [];
  }
}

// Self-serve "drop a fence here" → POST /v1/self/fence.
//
// AUTH: this MUST use the hard-bound device token (dtok_), not the shared
// publishable key — the dtok_ is bound to THIS device's subject server-side
// (unspoofable), so the dropped fence arms for the calling subject deterministically.
export async function postSelfFence(
  deviceToken: string,
  externalId: string,
  fix: LastFix,
  name: string,
  interiorM: number,
  perimeterM: number,
  transport?: CheckpointTransport,
): Promise<{ ok: boolean; error?: string }> {
  const t = transport ?? peekTransport();
  if (!t) return { ok: false, error: "not_configured" };
  const f = transportFetch(t);
  try {
    const res = await f(`${t.baseUrl}/functions/v1/v1-self-fence`, {
      method: "POST",
      headers: {
        apikey: t.anonKey,
        Authorization: `Bearer ${deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: externalId,
        name,
        location: { latitude: fix.lat, longitude: fix.lng },
        interior_radius_m: interiorM,
        perimeter_radius_m: perimeterM,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j?.error?.message ?? j?.error ?? `failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// Self-serve JOIN of an EXISTING place → POST /v1/self/join. Like postSelfFence,
// authenticates with the hard-bound dtok_; the place_id is the only body field.
export async function postJoinPlace(
  deviceToken: string,
  placeId: string,
  transport?: CheckpointTransport,
): Promise<{ ok: boolean; error?: string }> {
  const t = transport ?? peekTransport();
  if (!t) return { ok: false, error: "not_configured" };
  const f = transportFetch(t);
  try {
    const res = await f(`${t.baseUrl}/functions/v1/v1-self-join/self/join`, {
      method: "POST",
      headers: {
        apikey: t.anonKey,
        Authorization: `Bearer ${deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ place_id: placeId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j?.error?.message ?? j?.error ?? `failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// Foreground GPS stream → POST /v1/ingest (the live path).
//
// R6 (plan): the /v1/ingest body shape is the SERVER CONTRACT — `location` is a
// {lat,lng} object only (flat lat/lng are GENERATED ALWAYS server-side),
// `client_ping_id` is the idempotency key, `source` is one of the fixed values.
// Do NOT reshape. The foreground stream uses source:"foreground_stream"; the
// native layer uses "native_region_wake" / "continuous_stream".
export async function ingestFix(
  externalId: string,
  fix: LastFix,
  deviceId: string,
  transport?: CheckpointTransport,
): Promise<boolean> {
  const t = transport ?? peekTransport();
  if (!t) return false;
  const f = transportFetch(t);
  const res = await f(`${t.baseUrl}/functions/v1/v1-ingest`, {
    method: "POST",
    headers: {
      apikey: t.anonKey,
      Authorization: `Bearer ${t.publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      external_id: externalId,
      device_id: deviceId,
      pings: [
        {
          client_ping_id: crypto.randomUUID(),
          location: { latitude: fix.lat, longitude: fix.lng },
          accuracy_m: fix.accuracy ?? undefined,
          captured_at: new Date(fix.at).toISOString(),
          source: "foreground_stream",
        },
      ],
    }),
  });
  return res.ok;
}
