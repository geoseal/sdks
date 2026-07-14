// TypeScript types for the Geoseal Views embed payload.
//
// These mirror the JSON returned by the PUBLIC read route
//   GET {baseUrl}/v1-embed/embed/visits/{token}
// (backend: supabase/functions/v1-embed/index.ts -> getEmbedView). PII is
// stripped server-side; the token in the path is the entire authorization.

/** The visit itself. `duration_minutes`/`exited_at` are null while a visit is open. */
export interface EmbedVisit {
  /** Engine status, e.g. "open" | "closed". */
  status: string;
  /** ISO-8601 timestamp of the verified entry. */
  entered_at: string;
  /** ISO-8601 timestamp of the exit, or null while the visit is open. */
  exited_at: string | null;
  /** Whole-minute dwell duration, or null while open. */
  duration_minutes: number | null;
  /** Which ring the subject entered, e.g. "interior" | "perimeter" | null. */
  entered_ring: string | null;
  /** True when the engine confirmed an interior (fine-grained) crossing. */
  verified: boolean;
}

/** The facility being watched. `null` when the visit has no resolvable place. */
export interface EmbedPlace {
  name: string;
  lat: number;
  lng: number;
  /** Inner (facility) geofence radius, metres. */
  facility_radius_m: number;
  /** Outer (perimeter) geofence radius, metres. */
  perimeter_radius_m: number;
}

/** The worker, de-identified by default to a stable "Worker <last4>" handle. */
export interface EmbedSubject {
  handle: string;
  /** Subject lifecycle status, e.g. "active", or null. */
  status: string | null;
}

/** One sampled location fix. `accuracy` is the reported radius in metres. */
export interface EmbedTrackPoint {
  ts: string;
  lat: number;
  lng: number;
  accuracy: number | null;
}

/** One public timeline event, e.g. { type: "subject.arrived", at: "..." }. */
export interface EmbedTimelineEvent {
  /** Public event name, e.g. "subject.arrived" | "subject.dwell" | "subject.departed". */
  type: string;
  /** ISO-8601 timestamp the event occurred. */
  at: string;
}

/** A tracking outage overlapping the visit window. `resolved_at` null == ongoing. */
export interface EmbedOutage {
  reason: string;
  severity: string;
  started_at: string;
  resolved_at: string | null;
}

/**
 * The AI closeout summary.
 *
 * When the tenant has NOT opted into showing names (the de-identified default),
 * the free-text `summary` is withheld and `redacted` is true — only the
 * structured `confidence` is surfaced.
 */
export interface EmbedCloseout {
  /** The AI narrative, or null when redacted. */
  summary: string | null;
  /** Present and true when the narrative was withheld for privacy. */
  redacted?: boolean;
  /** Structured signal confidence, e.g. { m: 3, n: 3 }. */
  confidence: Record<string, unknown>;
}

/** The full embed view payload (`object: "embed_view"`). */
export interface EmbedView {
  object: "embed_view";
  visit: EmbedVisit;
  place: EmbedPlace | null;
  subject: EmbedSubject;
  track: EmbedTrackPoint[];
  timeline: EmbedTimelineEvent[];
  outages: EmbedOutage[];
  closeout: EmbedCloseout | null;
  /** True while the underlying visit is open. */
  live: boolean;
  /** A publishable (pk.) Mapbox token for the tiles, or null if unavailable. */
  mapbox_token: string | null;
}
