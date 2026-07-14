// SDK device hot-path REST calls — transport-injected, Supabase-session-free.
//
// These are the three device ops from the app's old `checkpointApi.ts`:
//   - mintDeviceToken       (the one op a pk_ can do that sk_/dtok_ cannot)
//   - getTrackingDirective  (RPC: get_device_tracking_directive)
//   - setDeviceTrackingMode (RPC: set_device_tracking_mode)
//
// The console control-plane functions (keys / webhooks / provision) STAY in the
// app — they are sk_/session-gated and not part of the device SDK.

import { peekTransport, transportFetch, type CheckpointTransport } from "./transport.js";

export type TrackingMode = "geofence" | "always" | "off";
export type TrackingModeSource = "user" | "onboarding" | "admin";

export interface TrackingDirective {
  effective_mode: TrackingMode;
  stream_now: boolean;
  active_window: { starts_at: string | null; ends_at: string | null } | null;
  min_interval_s: number;
}

export interface CheckpointApiError extends Error {
  status: number;
  code?: string;
  type?: string;
}

function apiError(message: string, status: number, code?: string): CheckpointApiError {
  const err = new Error(message) as CheckpointApiError;
  err.status = status;
  err.code = code;
  return err;
}

// PostgREST RPC call. This is the exact HTTP shape `supabase.rpc(fn, args)`
// produces — POST /rest/v1/rpc/<fn> with the args as the JSON body and the
// apikey + bearer headers — WITHOUT depending on the app's Supabase session
// client (plan §1c.1). On the device path the bearer IS the anon key (there is
// no session JWT); the RPCs are SECURITY DEFINER and resolve tenant scope from
// their explicit args, so anon is the correct gateway credential here.
async function rpc<T>(t: CheckpointTransport, fn: string, args: Record<string, unknown>): Promise<T> {
  const f = transportFetch(t);
  const res = await f(`${t.baseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: t.anonKey,
      Authorization: `Bearer ${t.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let message = `RPC ${fn} failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body?.message ?? body?.error?.message ?? message;
      code = body?.code ?? body?.error?.code;
    } catch {
      /* non-JSON */
    }
    throw apiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// (a) Fetch the server-resolved tracking directive for a subject. `subject` is
// the subject's public id (sub_<hex>) or raw uuid; the RPC accepts both. Pass
// appId explicitly when the request GUC is not set for the session.
//
// R8 (plan §3): the RPC is 3-arg but works 2-arg because trailing params default
// NULL — we preserve that by always sending all three keys (deviceRef defaults to
// null), matching the old `supabase.rpc(...)` body exactly. Do not drop a key.
export async function getTrackingDirective(
  subject: string,
  opts: { appId?: string; deviceRef?: string } = {},
): Promise<TrackingDirective> {
  const t = peekTransport();
  if (!t) throw apiError("Checkpoint transport not configured — call Checkpoint.init() first.", 0, "not_configured");
  return rpc<TrackingDirective>(t, "get_device_tracking_directive", {
    p_subject: subject,
    p_app_id: opts.appId ?? null,
    p_device_ref: opts.deviceRef ?? null,
  });
}

// (b) Persist a device's tracking-mode preference. device_ref is scoped to the
// tenant (app_id) server-side; source defaults to 'user' (the on-device settings
// path) — pass 'onboarding' or 'admin' for those flows.
export async function setDeviceTrackingMode(
  deviceRef: string,
  mode: TrackingMode,
  opts: { source?: TrackingModeSource; appId?: string } = {},
): Promise<void> {
  const t = peekTransport();
  if (!t) throw apiError("Checkpoint transport not configured — call Checkpoint.init() first.", 0, "not_configured");
  await rpc<unknown>(t, "set_device_tracking_mode", {
    p_device_ref: deviceRef,
    p_mode: mode,
    p_source: opts.source ?? "user",
    p_app_id: opts.appId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Device-token minting (SDK hot path) — guarantees a public.devices row exists.
//
// AUTH: this is the ONE op a pk_ can do that sk_/dtok_ cannot, so it POSTs the
// publishable key directly to the platform v1-device-token function (it never
// rode the session client even before extraction). device_ref RECONCILIATION:
// v1-device-token sets the row's `device_ref = body.device_id ?? "default"`, and
// the tracking-mode pref-write keys on `${platform}-${externalId}`, so pass that
// exact value as `deviceRef` to make the minted row line up with the pref-write.
// ---------------------------------------------------------------------------

export interface DeviceToken {
  object: "device_token";
  token: string; // dtok_… (optional to use for subsequent calls)
  expires_at: string;
  subject_id: string; // sub_<hex>
}

export async function mintDeviceToken(input: {
  /** sub_<hex> public id OR the subject's external_id — pass at least one. */
  subjectId?: string;
  externalId?: string;
  /** Becomes devices.device_ref. Pass the canonical `${platform}-${externalId}`. */
  deviceRef: string;
  platform?: "ios" | "android" | "other";
}): Promise<DeviceToken> {
  const t = peekTransport();
  if (!t) throw apiError("Checkpoint transport not configured — call Checkpoint.init() first.", 0, "not_configured");
  const f = transportFetch(t);
  const res = await f(`${t.baseUrl}/functions/v1/v1-device-token`, {
    method: "POST",
    headers: {
      apikey: t.anonKey,
      Authorization: `Bearer ${t.publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject_id: input.subjectId,
      external_id: input.externalId,
      device_id: input.deviceRef,
      platform: input.platform,
    }),
  });
  if (!res.ok) {
    let message = `device-token mint failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body?.error?.message ?? body?.error ?? message;
      code = body?.error?.code;
    } catch {
      /* non-JSON */
    }
    throw apiError(message, res.status, code);
  }
  return (await res.json()) as DeviceToken;
}

// ---------------------------------------------------------------------------
// Tracking outages (design: docs/tracking-outages-design.md §4.1). The DEVICE
// report path — POST /v1/outages with the publishable key (the "ingest"
// capability), mirroring ingestFix (transport pk_ + anon, not the session
// client). Idempotency is STRUCTURAL server-side (the partial unique index), so
// a retried open/resolve is always safe; best-effort + non-blocking at the call
// sites. A dtok_ may also report (scoped to its own subject) — pass it as `auth`.
// ---------------------------------------------------------------------------
export type OutageReason =
  | "permission_revoked"
  | "permission_while_in_use_only"
  | "location_services_off"
  | "background_permission_denied"
  | "battery_saver_or_doze"
  | "force_quit_recovery"
  | "airplane_mode"
  | "connectivity_lost"
  | "gps_signal_lost"
  | "mock_location_detected"
  | "tracking_disabled_by_user"
  | "presence_inferred_stale";

export interface OutageReport {
  reason: OutageReason;
  state?: "open" | "resolved"; // default 'open'
  platform?: "ios" | "android" | "other";
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

// Report a batch of device-detected outages. The credential is the transport's
// publishable key by default; pass `auth` to override with a hard-bound dtok_
// (subject resolved server-side — omit subjectId then). `subjectId` (sub_<hex>)
// or `externalId` names the subject for the pk_ path. Returns true on a 2xx ack;
// never throws (telemetry).
export async function reportTrackingOutages(input: {
  /** pk_… or dtok_…; defaults to the transport's publishable key. */
  auth?: string;
  subjectId?: string;
  externalId?: string;
  deviceId?: string;
  outages: OutageReport[];
}): Promise<boolean> {
  try {
    const t = peekTransport();
    if (!t) throw apiError("Checkpoint transport not configured — call Checkpoint.init() first.", 0, "not_configured");
    const f = transportFetch(t);
    const res = await f(`${t.baseUrl}/functions/v1/v1-outages`, {
      method: "POST",
      headers: {
        apikey: t.anonKey,
        Authorization: `Bearer ${input.auth ?? t.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject_id: input.subjectId,
        external_id: input.externalId,
        device_id: input.deviceId,
        outages: input.outages,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
