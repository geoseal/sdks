// Transport configuration for the SDK device path.
//
// WHY THIS EXISTS (plan §1c.1 + §2b): the SDK must NOT depend on the app's
// Supabase SESSION client. Two of the device RPCs (getTrackingDirective /
// setDeviceTrackingMode) used to route through `@/integrations/supabase/client`,
// which (a) coupled the SDK to the app's auth and (b) was a latent bug — those
// RPCs were being POSTed with the app's session JWT instead of the device's
// publishable/anon credentials, so on the /m device (which has no console
// session) they could resolve against the wrong identity or fail outright.
//
// The fix: every device call is built from an injected `CheckpointTransport`
// (baseUrl + anonKey + publishableKey), and the RPCs POST to the platform's
// PostgREST `/rest/v1/rpc/<fn>` endpoint directly with the anon key — exactly the
// HTTP shape `supabase.rpc()` produces, minus the session-client dependency.

export interface CheckpointTransport {
  /** Platform base URL, e.g. https://<project-ref>.supabase.co (no trailing slash). */
  baseUrl: string;
  /**
   * The platform anon key. REQUIRED as the `apikey` header on PostgREST
   * `/rest/v1/*` calls (getTrackingDirective / setDeviceTrackingMode go there).
   * On the `/functions/v1/*` edge functions (verify_jwt=false) it is NOT
   * required — those verify their own bearer — but we send it anyway (harmless).
   */
  anonKey: string;
  /** The publishable key (pk_…). The one credential the SDK ships in the binary. */
  publishableKey: string;
  /** Override fetch (tests / non-DOM wrappers). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

let active: CheckpointTransport | null = null;

/** Set the transport. Called by `configureTransport()`. Idempotent (last wins). */
export function setTransport(t: CheckpointTransport): void {
  active = { ...t, baseUrl: t.baseUrl.endsWith("/") ? t.baseUrl.slice(0, -1) : t.baseUrl };
}

/** The cred shape both entry points accept. Structurally identical to `CheckpointConfig`. */
export interface CheckpointTransportConfig {
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
 * Validate the creds and configure the transport. Shared by BOTH entry points —
 * `Checkpoint.init` (index.ts) and `initGeofence` (geofence.ts) — so the two stay
 * in lockstep. On a missing cred it logs and returns `false` WITHOUT configuring:
 * a redistributable SDK stays INERT on a misconfigured host rather than throwing
 * at module load. Returns `true` once the transport is set.
 */
export function configureTransport(cfg: CheckpointTransportConfig): boolean {
  if (!cfg.baseUrl || !cfg.anonKey || !cfg.publishableKey) {
    console.error(
      "Checkpoint: baseUrl, anonKey, and publishableKey are all required — SDK left unconfigured.",
    );
    return false;
  }
  setTransport({
    publishableKey: cfg.publishableKey,
    baseUrl: cfg.baseUrl,
    anonKey: cfg.anonKey,
    fetchImpl: cfg.fetchImpl,
  });
  return true;
}

/** The active transport, or throw if `init()` hasn't run. */
export function getTransport(): CheckpointTransport {
  if (!active) {
    throw new Error("Checkpoint transport not configured — call Checkpoint.init() first.");
  }
  return active;
}

/** Best-effort read of the active transport without throwing (for facade guards). */
export function peekTransport(): CheckpointTransport | null {
  return active;
}

export function transportFetch(t: CheckpointTransport): typeof fetch {
  return t.fetchImpl ?? fetch;
}
